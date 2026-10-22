"""Local retention for the one registered signage backup root; no cloud deletes."""
import argparse, contextlib, fcntl, json, os, pathlib, shutil, sqlite3, tarfile, tempfile, time
import vps_drive as v

ROOT = pathlib.Path('/opt/signage-editor/backups')
STATUS = v.STATE/'signage-retention.json'

def pinned(p):
    return (ROOT/'.keep').exists() or p.name.endswith('.keep') or p.with_name(p.name+'.keep').exists() or (p.is_dir() and any(p.rglob('.keep')))

def plan(config, now=None):
    policy=config.get('signage_retention',{})
    if not policy.get('enabled'): return {'candidates':[], 'retained':[], 'full':[], 'skipped':[]}
    assert {'path':str(ROOT)} in config['sources'], 'Backup root is not registered'
    assert policy.get('keep_latest')==2 and policy.get('keep_full')==2 and policy.get('minimum_age_hours')==24, 'Unsupported policy'
    assert ROOT.is_dir() and ROOT.resolve()==ROOT and not ROOT.is_symlink()
    now=time.time() if now is None else now
    rows=[]
    for p in sorted(ROOT.iterdir()):
        if p.name=='.keep' or p.name.endswith('.keep'):continue
        inv=v.inventory(p)
        if not any(x[1]=='f' for x in inv): continue
        changed=max(max(x[3],x[4]) for x in inv)/1e9
        rows.append({'path':str(p),'changed':changed,'bytes':sum(x[2] for x in inv if x[1]=='f'),'fingerprint':v.digest(inv),'full':p.is_dir() and (p/'data.tar.gz').is_file() and (p/'backup-verification.json').is_file()})
    rows.sort(key=lambda r:(r['changed'],r['path']),reverse=True)
    full=[r for r in rows if r['full']][:2]
    assert len(full)==2, 'Two full recovery copies required'
    protected={r['path'] for r in rows[:2]+full}
    result={'candidates':[], 'retained':[], 'full':full, 'skipped':[]}
    for row in rows:
        p=pathlib.Path(row['path'])
        if row['path'] in protected or now-row['changed']<86400 or pinned(p):
            result['retained'].append(row);continue
        rp=v.STATE/'receipts'/(v.digest(str(p))+'.json')
        if not rp.exists(): result['skipped'].append(dict(row,reason='no receipt'));continue
        r=json.loads(rp.read_text())
        if r.get('source')!=str(p) or r.get('state')!='verified' or r.get('fingerprint')!=row['fingerprint']:
            result['skipped'].append(dict(row,reason='changed or unverified'));continue
        result['candidates'].append(row)
    return result

def assert_unused(p):
    """Reject open descriptors, working directories and command references."""
    prefix=str(p)
    for proc in pathlib.Path('/proc').iterdir():
        if not proc.name.isdigit() or int(proc.name)==os.getpid():continue
        try:
            if prefix.encode() in (proc/'cmdline').read_bytes():raise RuntimeError('Backup referenced by process')
        except (FileNotFoundError,ProcessLookupError):continue
        for kind in ['cwd','root','exe','fd']:
            try: items=list((proc/kind).iterdir()) if kind=='fd' else [proc/kind]
            except (FileNotFoundError,ProcessLookupError):continue
            for item in items:
                try: dest=os.readlink(item)
                except (FileNotFoundError,ProcessLookupError):continue
                if dest==prefix or dest.startswith(prefix+'/'):raise RuntimeError('Backup is open in a process')

def validate_full(row):
    p=pathlib.Path(row['path']);inv=v.inventory(p)
    assert v.digest(inv)==row['fingerprint']
    receipt=json.loads((v.STATE/'receipts'/(v.digest(str(p))+'.json')).read_text())
    assert receipt['state']=='verified' and receipt['fingerprint']==row['fingerprint']
    metadata=json.loads((p/'backup-verification.json').read_text())
    assert metadata.get('verified') is True and v.sha(p/'data.tar.gz')==metadata['sha256'], 'Full backup hash/verification failed'
    # Read the complete compressed stream; extract only the database into a private
    # temporary directory, never tar paths or live files. Replay its saved WAL.
    with tempfile.TemporaryDirectory(prefix='signage-retained-',dir=v.STATE) as td:
        td=pathlib.Path(td);found=False;files=set();job_projects=0
        wanted={'data/projects/projects.sqlite3':'projects.sqlite3','data/projects/projects.sqlite3-wal':'projects.sqlite3-wal'}
        with tarfile.open(p/'data.tar.gz','r|gz') as stream:
            for member in stream:
                rel=pathlib.PurePosixPath(member.name)
                assert not rel.is_absolute() and '..' not in rel.parts and (member.isfile() or member.isdir()), 'Unsafe backup member'
                if member.isfile():
                    assert member.name not in files, 'Duplicate archive file'
                    files.add(member.name)
                    if member.name.startswith('data/jobs/') and member.name.endswith('/project.json'):job_projects+=1
                if member.name in wanted:
                    assert member.isfile() and member.size<512*1024*1024
                    target=td/wanted[member.name]
                    assert not target.exists(), 'Duplicate database member'
                    with stream.extractfile(member) as src, target.open('wb') as dst: shutil.copyfileobj(src,dst)
                    if member.name.endswith('projects.sqlite3'):found=True
        assert found, 'Full backup has no project database'
        assert len(files)==metadata['files'] and job_projects==metadata['job_projects'] and job_projects>0, 'Incomplete archive contents'
        assert any(n.startswith('data/handoff/') for n in files) and any(n.startswith('data/history-') for n in files), 'Missing recovery history'
        with (td/'projects.sqlite3').open('rb') as dbfile:
            assert dbfile.read(16)==b'SQLite format 3\x00', 'Invalid or empty database'
        with sqlite3.connect(td/'projects.sqlite3') as db:
            assert db.execute('PRAGMA integrity_check').fetchall()==[('ok',)]
            expected=metadata['database']['tables']
            tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
            assert {'projects','photos','jobs'}<=tables and tables==set(expected), 'Incomplete database schema'
            for table in tables:
                quoted='"'+table.replace('"','""')+'"'
                assert db.execute('SELECT COUNT(*) FROM '+quoted).fetchone()[0]==expected[table]['rows'], 'Database row count mismatch'
        listing=td/'files.txt';listing.write_text(''.join(f['path']+'\n' for f in receipt['manifest']['files']))
        v.verify(p,receipt['remote'],inv,listing)
        assert json.loads(v.rclone('cat',receipt['remote']+'/manifest.json'))==receipt['manifest']
    assert v.inventory(p)==inv, 'Retained recovery copy changed'

def run(apply=False):
    os.umask(0o077)
    # Only this root is touched. The upload lock serializes receipts/quarantine;
    # unrelated Workshop release locks are deliberately not required.
    with open(v.STATE/'run.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        config=json.loads(v.CONFIG.read_text())
        result=plan(config)
        result.update(started_at=time.time(),freed_bytes=0,offloaded=[],errors=[])
        if not apply:
            print(json.dumps(result));return
        if not config.get('offload_enabled') or not config.get('signage_retention',{}).get('enabled'):return
        v.verify_destination(config['expected_account'])
        if result['candidates']:
            for row in result['full']:validate_full(row)
        retained={r['path']:r['fingerprint'] for r in result['full']}
        for row in result['candidates']:
            p=pathlib.Path(row['path'])
            try:
                def guard(path):
                    assert path.parent==ROOT and path.resolve()==path and not path.is_symlink()
                    live=json.loads(v.CONFIG.read_text())
                    assert live.get('offload_enabled') and live.get('signage_retention')==config['signage_retention'], 'Policy changed'
                    current=plan(live)
                    assert any(r['path']==str(path) and r['fingerprint']==row['fingerprint'] for r in current['candidates']), 'Candidate changed or protected'
                    assert {r['path']:r['fingerprint'] for r in current['full']}==retained, 'Recovery copies changed'
                    assert not pinned(path)
                    assert_unused(path)
                guard(p)
                def claimed_guard(original,claimed):
                    live=json.loads(v.CONFIG.read_text())
                    assert live.get('offload_enabled') and live.get('signage_retention')==config['signage_retention']
                    assert not pinned(original) and not pinned(claimed)
                    assert_unused(original);assert_unused(claimed)
                    for kept,fingerprint in retained.items():
                        assert v.digest(v.inventory(pathlib.Path(kept)))==fingerprint, 'Recovery copy changed'
                receipt=json.loads((v.STATE/'receipts'/(v.digest(str(p))+'.json')).read_text())
                # Authorize only this revalidated path in a transient config.
                one=dict(config,offload_once=[str(p)])
                freed=v.offload(receipt,one,before_claim=guard,after_claim=claimed_guard)
                result['freed_bytes']+=freed
                if freed:result['offloaded'].append(str(p))
            except Exception as exc:
                result['errors'].append({'source':str(p),'error_type':type(exc).__name__})
            v.write_json(STATUS,result)
        result['finished_at']=time.time();v.write_json(STATUS,result)
        print(json.dumps({'offloaded':len(result['offloaded']),'freed_bytes':result['freed_bytes'],'errors':result['errors']}))
        if result['errors']:raise SystemExit(1)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--apply',action='store_true');args=parser.parse_args()
    try:run(args.apply)
    except BlockingIOError:print('Archive uploader busy; defer signage retention')
    except Exception as exc:
        v.write_json(STATUS,{'failed_at':time.time(),'error_type':type(exc).__name__,'freed_bytes':0})
        print('Signage retention blocked: '+type(exc).__name__);raise SystemExit(1)
