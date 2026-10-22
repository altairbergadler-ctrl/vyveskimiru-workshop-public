#!/usr/bin/env python3
"""Create a current recovery point after a release, under the deployment lock."""
import datetime, json, os, pathlib, shutil, subprocess, sys, signal, time, uuid
import vps_drive as v

BACKUP = pathlib.Path(__file__).with_name('backup-live.sh')

class UnsafeWriter(RuntimeError): pass

def finish_container(name, attempt):
    def inspect():
        result=subprocess.run(['docker','inspect','--format',
            '{{json .State.Running}} {{index .Config.Labels "vps-drive.attempt"}}',name],capture_output=True,text=True,timeout=30)
        if result.returncode:
            if 'no such object' in result.stderr.lower() or 'no such container' in result.stderr.lower(): return None
            raise UnsafeWriter('Cannot verify backup container state')
        running, label=result.stdout.strip().split()
        if label != attempt: raise UnsafeWriter('Backup container identity mismatch')
        return running == 'true'
    try:
        if inspect() is None: return
        subprocess.run(['docker','rm','--force',name],check=True,capture_output=True,timeout=30)
        if inspect() is not None: raise UnsafeWriter('Backup container still exists')
    except Exception as error:
        raise UnsafeWriter('Backup writer cleanup not confirmed; partial files retained') from error

def seal_failed(dest):
    """Preserve an unsuccessful owned attempt as an archive, never as a restore point."""
    if not dest.exists(): return
    if dest.parent != v.SNAPSHOTS or not v.re.fullmatch(r'\d{8}T\d{6}Z',dest.name):
        raise RuntimeError('Unexpected failed-attempt path')
    v.inventory(dest)
    target = v.OUTBOX / ('failed-auto-backup-' + dest.name)
    if target.exists(): raise RuntimeError('Failed-attempt archive already exists')
    v.write_json(dest/'FAILED_BACKUP.json', {'source':str(dest),'sealed_at':time.time(),
        'usable_recovery_point':False})
    (dest/'READY').write_text('Closed unsuccessful backup; preserve for diagnosis\n')
    os.rename(dest,target)

def create_backup(dest, env):
    attempt=uuid.uuid4().hex
    name='vps-drive-backup-'+attempt
    env=dict(env,VPS_BACKUP_ATTEMPT=attempt,VPS_BACKUP_CONTAINER=name)
    process = subprocess.Popen(['bash',str(BACKUP),str(dest)],env=env,start_new_session=True)
    try:
        try:
            code = process.wait(timeout=600)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid,signal.SIGKILL)
            process.wait()
            raise
    finally:
        finish_container(name,attempt)
    if code: raise subprocess.CalledProcessError(code,process.args)

def needs_backup():
    copies = sorted([p for p in v.SNAPSHOTS.iterdir()
                     if v.re.fullmatch(r'\d{8}T\d{6}Z',p.name) and (p/'COMPLETE').is_file()], reverse=True)
    if not copies: return True
    meta = dict(line.split('=',1) for line in (copies[0]/'COMPLETE').read_text().splitlines())
    started = datetime.datetime.fromisoformat(meta['started'].replace('Z','+00:00'))
    return (meta['release'] != str(v.APP.resolve()) or
            (datetime.datetime.now(datetime.timezone.utc)-started).total_seconds() > 24*3600)

def main():
    try:
        with v.locks():
            if not needs_backup(): return
            state_path=v.STATE/'freshness.json'
            prior=json.loads(state_path.read_text()) if state_path.exists() else {}
            if prior.get('error') and time.time()-prior.get('checked_at',0) < 1800:
                raise RuntimeError('Backup retry cooldown; uploads continue')
            if len(list(v.OUTBOX.glob('failed-auto-backup-*/FAILED_BACKUP.json'))) >= 2:
                raise RuntimeError('Two failed attempts awaiting verified offload; uploads continue')
            if any(v.re.fullmatch(r'\d{8}T\d{6}Z',p.name) and not (p/'COMPLETE').is_file()
                   for p in v.SNAPSHOTS.iterdir()):
                raise RuntimeError('An incomplete backup needs attention; refusing repeated disk growth')
            if shutil.disk_usage('/').free < 4_000_000_000:
                raise RuntimeError('Insufficient headroom for a fresh backup; local files retained')
            print('Creating a fresh recovery point for the active release',flush=True)
            env=dict(os.environ,WORKSHOP_LOCK_HELD='/opt/finance-pwa')
            dest=v.SNAPSHOTS/datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
            if dest.exists():raise RuntimeError('Backup name already exists')
            try:
                create_backup(dest,env)
            except UnsafeWriter:
                raise
            except Exception:
                seal_failed(dest)
                raise
            (dest/'AUTO_RELEASE').write_text('Automatically created current-release recovery point\n')
            v.validate_hot_copies(json.loads(v.CONFIG.read_text()))
    except BlockingIOError:
        print('Deployment or backup busy; retry next cycle',flush=True)

def run(strict=False):
    try:
        main()
    except Exception as error:
        previous=v.STATE/'freshness.json'
        prior=json.loads(previous.read_text()) if previous.exists() else {}
        # Do not slide the retry deadline forward on every cooldown run.
        stamp=prior.get('checked_at',time.time()) if 'cooldown' in str(error) else time.time()
        v.write_json(previous,{'checked_at':stamp,'error':str(error)})
        print('Recovery-point preparation failed; continuing archive uploads: '+str(error),flush=True)
        return 1 if strict else None
    v.write_json(v.STATE/'freshness.json',{'checked_at':time.time(),'error':None})

if __name__ == '__main__': sys.exit(run(strict='--strict' in sys.argv))
