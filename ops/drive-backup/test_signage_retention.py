import io,json,os,pathlib,sqlite3,tarfile,tempfile,time,unittest
from unittest.mock import patch
import signage_retention as s
import vps_drive as v

class RetentionPolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.base=pathlib.Path(self.tmp.name)
        self.root=self.base/'backups';self.root.mkdir();self.state=self.base/'state';(self.state/'receipts').mkdir(parents=True)
        self.patches=[patch.object(s,'ROOT',self.root),patch.object(v,'STATE',self.state)]
        for p in self.patches:p.start()
        self.cfg={'sources':[{'path':str(self.root)}],'signage_retention':{'enabled':True,'keep_latest':2,'keep_full':2,'minimum_age_hours':24}}
        self.items=[]
        for i in range(4):
            p=self.root/str(i);p.mkdir();(p/'data.tar.gz').write_bytes(b'fixture');(p/'backup-verification.json').write_text('{}')
            self.items.append(p);self.receipt(p)
        self.clock=time.time()+90000
    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        self.tmp.cleanup()
    def receipt(self,p):
        v.write_json(self.state/'receipts'/(v.digest(str(p))+'.json'),{'source':str(p),'state':'verified','fingerprint':v.digest(v.inventory(p))})
    def test_preserves_latest_two_full(self):
        p=s.plan(self.cfg,self.clock);self.assertEqual(len(p['candidates']),2);self.assertEqual(len(p['full']),2)
        self.assertTrue({r['path'] for r in p['candidates']}.isdisjoint({r['path'] for r in p['full']}))
    def test_recent_preserved(self):self.assertEqual(s.plan(self.cfg)['candidates'],[])
    def test_changed_source_skipped(self):
        p=self.items[0];(p/'changed').write_bytes(b'new');result=s.plan(self.cfg,self.clock)
        self.assertNotIn(str(p),[r['path'] for r in result['candidates']])
    def test_cloud_receipt_required(self):
        for p in (self.state/'receipts').iterdir():p.unlink()
        self.assertEqual(s.plan(self.cfg,self.clock)['candidates'],[])
    def test_pins_and_sidecar_preserved(self):
        for p in self.items:p.with_name(p.name+'.keep').touch()
        self.assertEqual(s.plan(self.cfg,self.clock)['candidates'],[])
    def test_root_pin_preserves_all(self):
        (self.root/'.keep').touch();self.assertEqual(s.plan(self.cfg,self.clock)['candidates'],[])
    def test_missing_second_full_blocks(self):
        for p in self.items[1:]:(p/'data.tar.gz').unlink()
        with self.assertRaises(AssertionError):s.plan(self.cfg,self.clock)
    def test_symlink_blocks(self):
        (self.root/'linked').symlink_to(self.items[0],target_is_directory=True)
        with self.assertRaises(RuntimeError):s.plan(self.cfg,self.clock)
    def test_registration_required(self):
        self.cfg['sources']=[]
        with self.assertRaises(AssertionError):s.plan(self.cfg,self.clock)
    def test_disabled_no_candidates(self):
        self.cfg['signage_retention']['enabled']=False;self.assertEqual(s.plan(self.cfg,self.clock)['candidates'],[])
    def test_open_file_blocks(self):
        import subprocess,sys
        p=self.items[0]/'data.tar.gz'
        child=subprocess.Popen([sys.executable,'-c','import sys,time; f=open(sys.argv[1]); print("ready",flush=True); time.sleep(20)',str(p)],stdout=subprocess.PIPE,text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(),'ready')
            with self.assertRaises(RuntimeError):s.assert_unused(self.items[0])
        finally:child.terminate();child.wait();child.stdout.close()
    def full_fixture(self,empty=False,missing=False):
        p=self.items[0];dbpath=self.base/'fixture.sqlite3'
        with sqlite3.connect(dbpath) as db:
            for name in ['projects','photos','jobs']:db.execute('CREATE TABLE '+name+' (id INTEGER)')
        members={'data/projects/projects.sqlite3':b'' if empty else dbpath.read_bytes(),'data/jobs/one/project.json':b'{}','data/handoff/index':b'index','data/history-fixture.zip':b'history'}
        if missing:members.pop('data/history-fixture.zip')
        with tarfile.open(p/'data.tar.gz','w:gz') as tar:
            for name,content in members.items():
                m=tarfile.TarInfo(name);m.size=len(content);tar.addfile(m,io.BytesIO(content))
        meta={'verified':True,'sha256':v.sha(p/'data.tar.gz'),'files':4,'job_projects':1,'database':{'tables':{n:{'rows':0} for n in ['projects','photos','jobs']}}}
        (p/'backup-verification.json').write_text(json.dumps(meta))
        inv=v.inventory(p);receipt={'source':str(p),'state':'verified','fingerprint':v.digest(inv),'manifest':v.manifest(p,inv),'remote':'fixture'}
        v.write_json(self.state/'receipts'/(v.digest(str(p))+'.json'),receipt)
        return {'path':str(p),'fingerprint':receipt['fingerprint']},receipt
    def test_empty_database_rejected(self):
        row,receipt=self.full_fixture(empty=True)
        with self.assertRaisesRegex(AssertionError,'Invalid or empty'):s.validate_full(row)
    def test_incomplete_archive_rejected(self):
        row,receipt=self.full_fixture(missing=True)
        with self.assertRaisesRegex(AssertionError,'Incomplete archive'):s.validate_full(row)
    def test_valid_data_archive_passes(self):
        row,receipt=self.full_fixture()
        with patch.object(v,'verify'),patch.object(v,'rclone',return_value=json.dumps(receipt['manifest']).encode()):s.validate_full(row)
    def test_pin_arriving_before_claim_preserves_archive(self):
        # Exercise real pin predicate after atomic claim and core rollback.
        from test_vps_drive import SafetyTests
        fixture=SafetyTests();fixture.setUp()
        try:
            def before(path):path.with_name(path.name+'.keep').touch()
            def after(original,claimed):
                if s.pinned(original) or s.pinned(claimed):raise RuntimeError('pinned')
            with patch.object(v,'rclone',return_value=json.dumps(fixture.manifest).encode()):
                with self.assertRaisesRegex(RuntimeError,'pinned'):v.offload(fixture.receipt,fixture.config,before_claim=before,after_claim=after)
            self.assertTrue(fixture.path.exists())
        finally:fixture.tearDown()

if __name__=='__main__':unittest.main()
