import datetime, gzip, hashlib, importlib.util, io, json, os, pathlib, sqlite3, tempfile, time, unittest
from unittest.mock import patch
import vps_drive as v

class SafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = pathlib.Path(self.tmp.name)
        self.values = {k:getattr(v,k) for k in ['STATE','SNAPSHOTS','OUTBOX','QUARANTINE','RECOVERY','RC']}
        for k in self.values:
            setattr(v,k,self.base/k.lower())
        for k in ['STATE','SNAPSHOTS','OUTBOX','QUARANTINE']: getattr(v,k).mkdir()
        v.RECOVERY.write_text('[vps-vault]\ntype=crypt\npassword=fixture\n')
        pathlib.Path(v.RC).write_text(v.RECOVERY.read_text())
        self.path = self.base/'archive'; self.path.mkdir()
        (self.path/'sample').write_bytes(b'fixture data')
        self.config = {'keep_local_snapshots':2,'local_snapshot_age_hours':48,'offload_once':[str(self.path)]}
        self.inv=v.inventory(self.path)
        self.manifest=v.manifest(self.path,self.inv)
        self.receipt={'source':str(self.path),'state':'verified','fingerprint':v.digest(self.inv),'remote':'vps-vault:fixture','bytes':12,'manifest':self.manifest}
        v.write_json(v.STATE/'recovery-confirmed.json',{'sha256':v.sha(v.RECOVERY)})
        v.write_json(v.STATE/'restore-test.json',{'passed':True,'recovery_sha256':v.sha(v.RECOVERY)})
    def tearDown(self):
        for k,value in self.values.items(): setattr(v,k,value)
        self.tmp.cleanup()
    def test_symlink_denied(self):
        (self.path/'link').symlink_to(self.base)
        with self.assertRaises(RuntimeError): v.inventory(self.path)
    def test_same_device_bind_mount_denied(self):
        mountinfo=self.base/'mountinfo'
        mountinfo.write_text('1 0 0:1 / / rw - ext4 root rw\n2 1 0:1 /other '+str(self.path/'bound')+' rw - ext4 root rw\n')
        with self.assertRaises(RuntimeError): v.assert_no_mounts(self.path,str(mountinfo))
    def test_mount_with_escaped_space_denied(self):
        mountinfo=self.base/'mountinfo'
        mountinfo.write_text('2 1 0:1 /other '+str(self.path/'a b').replace(' ',r'\040')+' rw - ext4 root rw\n')
        with self.assertRaises(RuntimeError): v.assert_no_mounts(self.path,str(mountinfo))
    def test_changed_content_preserved(self):
        (self.path/'sample').write_bytes(b'changed data')
        with self.assertRaises(RuntimeError): v.offload(self.receipt,self.config)
        self.assertTrue(self.path.exists())
    def test_wrong_recovery_preserved(self):
        v.RECOVERY.write_text('different')
        with self.assertRaises(RuntimeError): v.offload(self.receipt,self.config)
        self.assertTrue(self.path.exists())
    def test_failed_restore_preserved(self):
        v.write_json(v.STATE/'restore-test.json',{'passed':False})
        with self.assertRaises(RuntimeError): v.offload(self.receipt,self.config)
        self.assertTrue(self.path.exists())
    def test_changed_active_encryption_preserved(self):
        pathlib.Path(v.RC).write_text('[vps-vault]\npassword=new-key\n')
        with self.assertRaises(RuntimeError): v.offload(self.receipt,self.config)
        self.assertTrue(self.path.exists())
    def test_restore_for_different_key_preserved(self):
        v.write_json(v.STATE/'restore-test.json',{'passed':True,'recovery_sha256':'incorrect'})
        with self.assertRaises(RuntimeError): v.offload(self.receipt,self.config)
        self.assertTrue(self.path.exists())
    def test_interrupted_quarantine_has_recovery_receipt(self):
        with patch.object(v,'rclone',return_value=json.dumps(self.manifest).encode()), patch.object(v.shutil,'rmtree',side_effect=RuntimeError('interruption')):
            with self.assertRaises(RuntimeError): v.offload(self.receipt,self.config)
        receipt=json.loads(next((v.STATE/'offloaded').glob('*.json')).read_text())
        self.assertEqual(receipt['state'],'quarantined')
        self.assertTrue(pathlib.Path(receipt['claimed_path']).is_dir())
    def test_partial_old_snapshot_preserved(self):
        candidates=[]
        for i in range(1,4):
            p=v.SNAPSHOTS/f'2026010{i}T000000Z'; p.mkdir(); (p/'COMPLETE').write_text('release=/fixture\n')
            os.utime(p,(time.time()-72*3600,)*2); candidates.append(p)
        path=candidates[0]; inv=v.inventory(path)
        receipt=dict(self.receipt,source=str(path),manifest=v.manifest(path,inv),fingerprint=v.digest(inv))
        with patch.object(v.subprocess,'run') as run:
            run.return_value.returncode=1
            with self.assertRaises(RuntimeError): v.offload(receipt,self.config)
        self.assertTrue(path.is_dir())
    def test_failed_cloud_check_preserved(self):
        with patch.object(v,'rclone',side_effect=RuntimeError('fixture remote failure')):
            with self.assertRaises(RuntimeError): v.offload(self.receipt,self.config)
        self.assertTrue(self.path.exists())
    def test_cloud_manifest_mismatch_preserved(self):
        with patch.object(v,'rclone',return_value=b'{}'):
            with self.assertRaises(RuntimeError): v.offload(self.receipt,self.config)
        self.assertTrue(self.path.exists())
    def test_out_of_scope_preserved(self):
        cfg=dict(self.config,offload_once=[])
        self.assertEqual(v.offload(self.receipt,cfg),0)
        self.assertTrue(self.path.exists())
    def test_keep_marker_preserved(self):
        (self.path/'.keep').touch()
        inv=v.inventory(self.path)
        receipt=dict(self.receipt,manifest=v.manifest(self.path,inv),fingerprint=v.digest(inv))
        self.assertEqual(v.offload(receipt,self.config),0)
        self.assertTrue(self.path.exists())
    def test_verified_sealed_unit_offloaded(self):
        with patch.object(v,'rclone',return_value=json.dumps(self.manifest).encode()):
            self.assertEqual(v.offload(self.receipt,self.config),12)
        self.assertFalse(self.path.exists())
        self.assertEqual(len(list((v.STATE/'offloaded').glob('*.json'))),1)
    def test_before_claim_veto_preserves_source_without_journal(self):
        def veto(path):
            self.assertEqual(path,self.path)
            raise RuntimeError('policy or pin changed')
        with patch.object(v,'rclone',return_value=json.dumps(self.manifest).encode()):
            with self.assertRaises(RuntimeError):v.offload(self.receipt,self.config,before_claim=veto)
        self.assertTrue(self.path.exists())
        self.assertEqual(list((v.STATE/'offloaded').glob('*.json')),[])
        self.assertEqual(list(v.QUARANTINE.iterdir()),[])
    def test_after_claim_veto_restores_source(self):
        def veto(original,claimed):
            self.assertFalse(original.exists())
            self.assertTrue(claimed.exists())
            raise RuntimeError('pin or use appeared')
        with patch.object(v,'rclone',return_value=json.dumps(self.manifest).encode()):
            with self.assertRaises(RuntimeError):v.offload(self.receipt,self.config,after_claim=veto)
        self.assertTrue(self.path.exists())
        self.assertEqual(list(v.QUARANTINE.iterdir()),[])
    def test_changed_during_claim_preserved(self):
        rename=os.rename
        def change(a,b):
            rename(a,b)
            (pathlib.Path(b)/'new-file').write_text('new')
        with patch.object(v,'rclone',return_value=json.dumps(self.manifest).encode()), patch.object(v.os,'rename',side_effect=change):
            with self.assertRaises(RuntimeError): v.offload(self.receipt,self.config)
        self.assertTrue(self.path.exists())
        self.assertTrue((self.path/'new-file').exists())
    def test_keep_two_and_48_hours(self):
        paths=[]
        for i in range(1,5):
            p=v.SNAPSHOTS/f'2026010{i}T000000Z'; p.mkdir(); (p/'COMPLETE').touch()
            os.utime(p,(time.time()-72*3600,)*2); paths.append(p)
        self.assertTrue(v.eligible(paths[0],self.config))
        self.assertFalse(v.eligible(paths[2],self.config))
        self.assertFalse(v.eligible(paths[3],self.config))
        os.utime(paths[1],None)
        self.assertFalse(v.eligible(paths[1],self.config))
    def test_incomplete_snapshot_not_uploaded(self):
        p=v.SNAPSHOTS/'20260101T000000Z'; p.mkdir(); (p/'payload').write_text('x')
        with patch.object(v,'rclone') as mock:
            self.assertEqual(v.upload(p,0)['state'],'incomplete')
            mock.assert_not_called()
    def test_corrupt_hot_snapshot_blocks(self):
        for i in range(1,3):
            p=v.SNAPSHOTS/f'2026010{i}T000000Z'; p.mkdir(); (p/'COMPLETE').write_text('release=/somewhere\n')
        with patch.object(v.subprocess,'run') as run:
            run.return_value.returncode=1
            with self.assertRaises(RuntimeError): v.validate_hot_copies(self.config)
    def test_manifest_deterministic_for_retry(self):
        self.assertEqual(self.manifest,v.manifest(self.path,self.inv))
    def test_directory_newline_names_supported(self):
        (self.path/'file\nname').write_text('x')
        self.assertTrue(any(r[0]=='file\nname' for r in v.inventory(self.path)))
    def test_future_new_registered_unit_discovered(self):
        root=self.base/'outputs'; root.mkdir()
        config={'sources':[{'path':str(root)}]}
        self.assertEqual(v.discover(config),[])
        (root/'new').mkdir()
        self.assertEqual(v.discover(config),[root/'new'])
    def test_real_backup_validation_does_not_modify_any_file(self):
        p=self.base/'real-snapshot'; p.mkdir()
        db=sqlite3.connect(p/'finance.sqlite3')
        db.execute('PRAGMA journal_mode=WAL'); db.execute('CREATE TABLE fixture (id INTEGER)'); db.commit(); db.close()
        (p/'finance.sqlite3-shm').write_bytes(b'fixture stale shared-memory cache')
        (p/'finance.sqlite3-wal').write_bytes(b'')
        with gzip.open(p/'google-full.json.gz','wt') as out: json.dump({'sheets':[{'fixture':True}]},out)
        (p/'files.tar.gz').write_bytes(gzip.compress(b'fixture archive'))
        files=['finance.sqlite3','google-full.json.gz','files.tar.gz']
        (p/'SHA256SUMS').write_text(''.join(v.sha(p/f)+'  '+f+'\n' for f in files))
        date=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=3)).isoformat()
        (p/'COMPLETE').write_text(f'started={date}\nfinished={date}\nrelease={self.base}\n')
        before=v.inventory(p); hashes={f.name:v.sha(f) for f in p.iterdir()}
        v.validate_snapshot(p)
        self.assertEqual(v.inventory(p),before)
        self.assertEqual({f.name:v.sha(f) for f in p.iterdir()},hashes)
    def test_nonempty_wal_blocks_validation(self):
        (self.path/'finance.sqlite3-wal').write_bytes(b'uncheckpointed data')
        with self.assertRaises(RuntimeError): v.validate_snapshot(self.path)
    def destination_fixture(self, scope='drive.file', remote='vps-backups-altair:VPS-Archives/3400213-ck17268'):
        pathlib.Path(v.RC).write_text('[vps-backups-altair]\ntype=drive\nscope='+scope+'\ntoken={"access_token":"synthetic-token"}\n[vps-vault]\ntype=crypt\nfilename_encryption=standard\ndirectory_name_encryption=true\nremote='+remote+'\n')
    def test_wrong_drive_owner_rejected(self):
        self.destination_fixture()
        with patch.object(v.urllib.request,'urlopen',return_value=io.BytesIO(b'{"user":{"emailAddress":"other@example.test"}}')):
            with self.assertRaises(RuntimeError): v.verify_destination('owner@example.test')
    def test_expected_drive_owner_accepted(self):
        self.destination_fixture()
        with patch.object(v.urllib.request,'urlopen',return_value=io.BytesIO(b'{"user":{"emailAddress":"owner@example.test"}}')):
            self.assertEqual(v.verify_destination('owner@example.test')['account'],'owner@example.test')
    def test_changed_drive_destination_rejected(self):
        self.destination_fixture(remote='elsewhere:folder')
        with self.assertRaises(RuntimeError): v.verify_destination('owner@example.test')
    def test_unencrypted_alias_rejected_before_upload(self):
        self.destination_fixture()
        p=pathlib.Path(v.RC); p.write_text(p.read_text().replace('type=crypt','type=alias'))
        with self.assertRaises(RuntimeError): v.verify_destination('owner@example.test')
    def test_expired_token_refresh_delegated_to_rclone(self):
        self.destination_fixture()
        denied=v.urllib.error.HTTPError('https://www.googleapis.com/drive/v3/about',401,'Unauthorized',{},None)
        with patch.object(v.urllib.request,'urlopen',side_effect=[denied,io.BytesIO(b'{"user":{"emailAddress":"owner@example.test"}}')]), patch.object(v,'rclone') as command:
            self.assertEqual(v.verify_destination('owner@example.test')['account'],'owner@example.test')
            command.assert_called_once_with('about','vps-backups-altair:','--json')

if __name__=='__main__': unittest.main()
