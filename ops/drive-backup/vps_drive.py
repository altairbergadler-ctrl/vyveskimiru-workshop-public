#!/usr/bin/env python3
"""Immutable encrypted backup copies. No command deletes remote objects."""
import argparse, configparser, contextlib, datetime, fcntl, hashlib, json, os, pathlib, re, shutil, stat, subprocess, sys, tempfile, time
import urllib.error, urllib.request

CONFIG = pathlib.Path('/etc/vps-drive.json')
STATE = pathlib.Path('/var/lib/vps-drive')
RC = '/root/.config/rclone/vps-backups-altair.conf'
SNAPSHOTS = pathlib.Path('/opt/workshop-backups/snapshots')
OUTBOX = pathlib.Path('/var/lib/vps-drive-outbox/ready')
QUARANTINE = pathlib.Path('/var/lib/vps-drive-quarantine')
RECOVERY = pathlib.Path('/opt/workshop-drive-setup/recovery-crypt.conf')
CHECKER = pathlib.Path(__file__).with_name('check-backup-immutable.py')
RELEASES = pathlib.Path('/opt/workshop-backups/releases')
APP = pathlib.Path('/opt/finance-pwa/app')
VALIDATED_RELEASES = {}

def release_checkpoints(config):
    count = config.get('keep_local_release_checkpoints', 0)
    if count < 2: return [], set()
    copies = sorted([p for p in RELEASES.iterdir()
                     if re.fullmatch(r'\d{8}T\d{6}Z-[0-9a-f]{40}', p.name)
                     and not p.is_symlink() and p.is_dir()
                     and all((p/name).is_file() for name in
                             ['DEPLOYED','new-release','previous-release','backup/COMPLETE'])], reverse=True)
    current = str(APP.resolve())
    active = [p for p in copies if (p/'new-release').read_text().strip() == current]
    if not active: raise RuntimeError('No completed checkpoint for active release; cleanup blocked')
    protected = set(copies[:count]) | set(active)
    protected.update(p for p in copies if (p/'previous-release').read_text().strip() == current)
    return copies, protected

def validate_release_checkpoint(path):
    before = inventory(path)
    fingerprint = digest(before)
    # Process-local only: reusing validation requires the exact unchanged inode,
    # size, mtime and ctime inventory. The service holds the deployment lock.
    if VALIDATED_RELEASES.get(str(path)) == fingerprint: return
    expected = '/opt/finance-pwa/releases/' + path.name.split('-', 1)[1]
    if (path/'new-release').read_text().strip() != expected or (path/'DEPLOYED').read_text().strip() != expected.rsplit('/',1)[1]:
        raise RuntimeError('Release checkpoint identity mismatch')
    metadata = dict(line.split('=',1) for line in (path/'backup/COMPLETE').read_text().splitlines())
    if metadata['release'] != (path/'previous-release').read_text().strip():
        raise RuntimeError('Release checkpoint backup mismatch')
    validate_snapshot(path/'backup')
    if inventory(path) != before: raise RuntimeError('Checkpoint changed during validation')
    VALIDATED_RELEASES[str(path)] = fingerprint

def verify_destination(expected_account):
    config = configparser.ConfigParser(interpolation=None); config.read(RC)
    drive = config['vps-backups-altair']
    if drive['type'] != 'drive' or drive['scope'] != 'drive.file':
        raise RuntimeError('Unexpected Drive backend or permission scope')
    crypt = config['vps-vault']
    if crypt.get('type') != 'crypt' or crypt.get('filename_encryption') != 'standard' or crypt.get('directory_name_encryption') != 'true':
        raise RuntimeError('Encrypted storage configuration is required')
    if config['vps-vault']['remote'] != 'vps-backups-altair:VPS-Archives/3400213-ck17268':
        raise RuntimeError('Unexpected encrypted archive destination')
    token = json.loads(drive['token'])
    access = token.get('access_token', '')
    for attempt in range(2):
        request = urllib.request.Request('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', headers={'Authorization':'Bearer '+access})
        try:
            with urllib.request.urlopen(request, timeout=30) as response: about = json.load(response)
            if about['user']['emailAddress'].lower() != expected_account.lower():
                raise RuntimeError('Drive account differs from the configured owner')
            return {'account': expected_account, 'checked_at': time.time()}
        except urllib.error.HTTPError as error:
            if error.code != 401 or attempt: raise RuntimeError('Drive authorization preflight failed') from None
            # Let rclone own refresh and atomic credential persistence, including
            # any refresh-token rotation; never implement a second token writer.
            rclone('about', 'vps-backups-altair:', '--json')
            refreshed = configparser.ConfigParser(interpolation=None); refreshed.read(RC)
            access = json.loads(refreshed['vps-backups-altair']['token'])['access_token']
    raise RuntimeError('Drive account verification did not complete')

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.chmod(0o600)
    os.replace(temporary, path)

def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(4 * 1024 * 1024), b''): h.update(block)
    return h.hexdigest()

def assert_no_mounts(path, mountinfo='/proc/self/mountinfo'):
    for line in pathlib.Path(mountinfo).read_text().splitlines():
        value = line.split()[4]
        value = re.sub(r'\\([0-7]{3})', lambda m: chr(int(m.group(1), 8)), value)
        mounted = pathlib.Path(value)
        if mounted != pathlib.Path('/') and (mounted == path or mounted in path.parents or path in mounted.parents):
            raise RuntimeError('mount boundary in source')

def inventory(path):
    path = pathlib.Path(path)
    if not path.is_absolute() or path.resolve() != path or path.is_symlink():
        raise RuntimeError('unsafe source path')
    assert_no_mounts(path)
    parent = path if path.is_dir() else path.parent
    rootdev = path.lstat().st_dev
    entries = [path]
    if path.is_dir():
        for base, dirs, files in os.walk(path, followlinks=False):
            entries.extend(pathlib.Path(base) / name for name in dirs + files)
    result = []
    for p in sorted(entries):
        s = p.lstat()
        if s.st_dev != rootdev or p.is_symlink() or os.path.ismount(p):
            raise RuntimeError('symlink or mount in source')
        if not (stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode)):
            raise RuntimeError('special file in source')
        rel = str(p.relative_to(parent))
        if not path.is_dir() and ('\n' in rel or '\r' in rel): raise RuntimeError('unsupported standalone filename')
        result.append([rel, 'd' if p.is_dir() else 'f', s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_ino, s.st_dev, stat.S_IMODE(s.st_mode)])
    return result

def rclone(*args, timeout=14400):
    # Capture detailed output privately: never send file contents/credentials to journal.
    p = subprocess.run(['rclone', '--config', RC, '--retries', '3', '--low-level-retries', '5', '--contimeout', '30s', '--timeout', '5m', *map(str, args)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if p.returncode:
        (STATE / 'last-rclone-error.log').write_bytes(p.stderr[-16000:])
        raise RuntimeError('rclone ' + str(args[0]) + ' failed: ' + str(p.returncode))
    return p.stdout

def discover(config):
    result = []
    for spec in config['sources']:
        root = pathlib.Path(spec['path'])
        if not root.exists(): continue
        if spec.get('whole'):
            result.append(root)
            continue
        for entry in sorted(root.iterdir()):
            if entry.name in spec.get('containers', []):
                if entry.is_symlink(): raise RuntimeError('symlink container')
                result.extend(sorted(entry.iterdir()))
            else: result.append(entry)
    return result

def manifest(path, inv):
    base = path if path.is_dir() else path.parent
    return {'schema': 1, 'source': str(path), 'kind': 'directory' if path.is_dir() else 'file',
            'created_utc': datetime.datetime.fromtimestamp(max(r[3] for r in inv)/1e9, datetime.timezone.utc).isoformat(), 'inventory': inv,
            'files': [{'path': row[0], 'size': row[2], 'mode': row[7], 'sha256': sha(base / row[0])} for row in inv if row[1] == 'f'],
            'directories': [row[0] for row in inv if row[1] == 'd']}

def verify(path, remote, inv, filelist):
    base = path if path.is_dir() else path.parent
    filters = [] if path.is_dir() else ['--files-from-raw', filelist]
    rclone('cryptcheck', base, remote + '/data', *filters, '--checkers', '4')
    if inventory(path) != inv: raise RuntimeError('source changed during verification')

def upload(path, minimum_quiet=300):
    inv = inventory(path)
    if not any(r[1] == 'f' for r in inv): return {'source': str(path), 'state': 'empty'}
    if time.time_ns() - max(max(r[3], r[4]) for r in inv) < minimum_quiet * 10**9:
        return {'source': str(path), 'state': 'busy'}
    # New automatic Workshop snapshots are only eligible when their writer commits COMPLETE.
    if path.parent == SNAPSHOTS and re.fullmatch(r'\d{8}T\d{6}Z', path.name) and not (path/'COMPLETE').is_file():
        return {'source': str(path), 'state': 'incomplete'}
    fingerprint = digest(inv)
    receipt_path = STATE / 'receipts' / (digest(str(path)) + '.json')
    if receipt_path.exists():
        old = json.loads(receipt_path.read_text())
        if old['fingerprint'] == fingerprint and old['state'] == 'verified': return old
    remote = 'vps-vault:archives/' + str(path).lstrip('/') + '/' + fingerprint
    print(json.dumps({'event': 'upload', 'source': str(path), 'bytes': sum(r[2] for r in inv if r[1]=='f')}), flush=True)
    m = manifest(path, inv)
    if inventory(path) != inv: raise RuntimeError('source changed during hashing')
    with tempfile.TemporaryDirectory(prefix='capture-', dir=STATE) as td:
        td = pathlib.Path(td)
        listing = td / 'files.txt'
        listing.write_text(''.join(f['path'] + '\n' for f in m['files']))
        base = path if path.is_dir() else path.parent
        filters = [] if path.is_dir() else ['--files-from-raw', listing]
        rclone('copy', base, remote+'/data', *filters, '--immutable', '--transfers', '4')
        verify(path, remote, inv, listing)
        mf = td / 'manifest.json'
        write_json(mf, m)
        rclone('copyto', mf, remote+'/manifest.json', '--immutable')
        downloaded = rclone('cat', remote+'/manifest.json')
        if hashlib.sha256(downloaded).hexdigest() != sha(mf): raise RuntimeError('manifest readback mismatch')
    receipt = {'source': str(path), 'fingerprint': fingerprint, 'remote': remote, 'state': 'verified',
               'verified_at': time.time(), 'bytes': sum(f['size'] for f in m['files']), 'manifest': m}
    write_json(receipt_path, receipt)
    print(json.dumps({'event': 'verified', 'source': str(path), 'bytes': receipt['bytes']}), flush=True)
    return receipt

def eligible(path, config, now=None):
    now = time.time() if now is None else now
    snapshots = SNAPSHOTS
    if path.parent == RELEASES and config.get('keep_local_release_checkpoints', 0) >= 2:
        copies, protected = release_checkpoints(config)
        return path in copies and path not in protected
    if path.parent == snapshots and re.fullmatch(r'\d{8}T\d{6}Z', path.name):
        complete = sorted([p for p in snapshots.iterdir() if re.fullmatch(r'\d{8}T\d{6}Z', p.name) and (p/'COMPLETE').is_file()], reverse=True)
        old_enough = now-path.stat().st_mtime > config['local_snapshot_age_hours']*3600
        bounded_auto = config.get('offload_old_auto_release_snapshots', False) and (path/'AUTO_RELEASE').is_file()
        return (path/'COMPLETE').is_file() and path not in complete[:config['keep_local_snapshots']] and (old_enough or bounded_auto)
    if str(path) in config.get('offload_once', []): return True
    ready = OUTBOX
    return path.parent == ready and (path/'READY').is_file()

def offload(receipt, config, before_claim=None, after_claim=None):
    path = pathlib.Path(receipt['source'])
    if receipt['state'] != 'verified' or not eligible(path, config): return 0
    if path.parent == SNAPSHOTS:
        validate_snapshot(path)
    if path.parent == RELEASES:
        _, protected = release_checkpoints(config)
        for retained in protected:
            validate_release_checkpoint(retained)
        validate_release_checkpoint(path)
    if not (STATE/'recovery-confirmed.json').is_file() or not (STATE/'restore-test.json').is_file():
        raise RuntimeError('off-server key recovery and restore test required')
    recovery = json.loads((STATE/'recovery-confirmed.json').read_text())
    if recovery.get('sha256') != sha(RECOVERY):
        raise RuntimeError('recovery key confirmation mismatch')
    current = configparser.ConfigParser(interpolation=None); current.read(RC)
    recovered = configparser.ConfigParser(interpolation=None); recovered.read(RECOVERY)
    if dict(current['vps-vault']) != dict(recovered['vps-vault']):
        raise RuntimeError('active encryption configuration differs from recovery copy')
    test = json.loads((STATE/'restore-test.json').read_text())
    if test.get('passed') is not True or test.get('recovery_sha256') != sha(RECOVERY):
        raise RuntimeError('restore test did not pass')
    inv = inventory(path)
    if inv != receipt['manifest']['inventory'] or digest(inv) != receipt['fingerprint']:
        raise RuntimeError('source changed before offload')
    if any(path.rglob('.keep')) if path.is_dir() else path.name == '.keep': return 0
    # Full fresh source hashing and fresh cloud checksum check, not a cached success.
    base = path if path.is_dir() else path.parent
    for f in receipt['manifest']['files']:
        if sha(base/f['path']) != f['sha256']: raise RuntimeError('source content changed')
    with tempfile.TemporaryDirectory(dir=STATE) as td:
        listing = pathlib.Path(td)/'files.txt'
        listing.write_text(''.join(f['path']+'\n' for f in receipt['manifest']['files']))
        verify(path, receipt['remote'], inv, listing)
        cloud_manifest = json.loads(rclone('cat', receipt['remote']+'/manifest.json'))
        if cloud_manifest != receipt['manifest']: raise RuntimeError('cloud manifest mismatch')
    if inventory(path) != inv: raise RuntimeError('source changed immediately before offload')
    if before_claim is not None: before_claim(path)
    journal = STATE/'offloaded'/(digest(str(path))+'.json')
    write_json(journal, dict(receipt, state='deletion-started', offload_at=time.time()))
    # Claim a sealed unit atomically: a new producer using the original name cannot
    # accidentally have its newly created files removed by this cleanup.
    QUARANTINE.mkdir(mode=0o700, parents=True, exist_ok=True)
    claimed = QUARANTINE/(digest(str(path))+'-'+receipt['fingerprint'])
    if claimed.exists(): raise RuntimeError('earlier quarantined unit needs recovery')
    os.rename(path, claimed)
    claimed_inv = inventory(claimed)
    expected = json.loads(json.dumps(inv))
    # rename changes only the ctime of the claimed root inode.
    rootname = '.' if claimed.is_dir() else path.name
    if not claimed.is_dir():
        claimed_inv[0][0] = path.name
    for old, new in zip(expected, claimed_inv):
        if old[0] == rootname: old[4] = new[4]
    if claimed_inv != expected:
        if not path.exists(): os.rename(claimed, path)
        raise RuntimeError('source changed while claiming for offload; retained')
    write_json(journal, dict(receipt, state='quarantined', claimed_path=str(claimed), offload_at=time.time()))
    if after_claim is not None:
        try: after_claim(path, claimed)
        except Exception:
            if not path.exists(): os.rename(claimed, path)
            write_json(journal, dict(receipt, state='retained-after-veto', claimed_path=str(claimed), offload_at=time.time()))
            raise
    if claimed.is_dir(): shutil.rmtree(claimed)
    else: claimed.unlink()
    write_json(journal, dict(receipt, state='offloaded', offload_at=time.time()))
    print(json.dumps({'event': 'offloaded', 'source': str(path), 'bytes': receipt['bytes']}), flush=True)
    return receipt['bytes']

def validate_snapshot(copy, current=False):
    inventory(copy)
    if any(p.stat().st_size for p in copy.glob('*.sqlite3-wal')):
        raise RuntimeError('Snapshot contains uncheckpointed SQLite WAL')
    metadata = dict(line.split('=', 1) for line in (copy/'COMPLETE').read_text().splitlines())
    release = str(pathlib.Path('/opt/finance-pwa/app').resolve()) if current else metadata['release']
    age = '93600' if current else '315360000'
    check = subprocess.run(['python3', str(CHECKER), str(copy), release, age], capture_output=True)
    if check.returncode: raise RuntimeError('Workshop snapshot validation failed')

def validate_hot_copies(config):
    root = SNAPSHOTS
    copies = sorted([p for p in root.iterdir() if re.fullmatch(r'\d{8}T\d{6}Z', p.name) and (p/'COMPLETE').is_file()], reverse=True)
    if len(copies) < config['keep_local_snapshots']: raise RuntimeError('insufficient local snapshots')
    for i, copy in enumerate(copies[:config['keep_local_snapshots']]):
        validate_snapshot(copy,current=i==0)

@contextlib.contextmanager
def locks():
    with open(STATE/'run.lock', 'a') as own, open('/opt/finance-pwa/release.lock', 'a') as workshop:
        fcntl.flock(own, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(workshop, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield

def main():
    os.umask(0o077)
    p = argparse.ArgumentParser()
    p.add_argument('--inventory', action='store_true')
    p.add_argument('--upload-only', action='store_true')
    p.add_argument('--source')
    args = p.parse_args()
    config = json.loads(CONFIG.read_text())
    STATE.mkdir(parents=True, exist_ok=True)
    with locks():
        paths = discover(config)
        if args.source:
            paths = [p for p in paths if str(p) == args.source]
            if len(paths) != 1: raise RuntimeError('source is not registered')
        if args.inventory:
            rows = []
            for path in paths:
                try:
                    inv = inventory(path)
                    rows.append({'source': str(path), 'bytes': sum(r[2] for r in inv if r[1]=='f'), 'files': sum(r[1]=='f' for r in inv), 'offload': eligible(path, config)})
                except Exception as e: rows.append({'source': str(path), 'error': str(e)})
            print(json.dumps(rows, indent=2)); return
        result = {'started_at': time.time(), 'results': [], 'errors': [], 'freed_bytes': 0}
        freshness_path=STATE/'freshness.json'
        if freshness_path.exists():
            freshness=json.loads(freshness_path.read_text())
            result['recovery_preparation']=freshness
            if freshness.get('error'):
                result['errors'].append({'source':'recovery-point preparation','error':freshness['error']})
        try:
            result['destination'] = verify_destination(config['expected_account'])
        except Exception:
            result['errors'] = [{'source':'destination','error':'Drive account or authorization preflight failed; no files changed'}]
            result['finished_at'] = time.time()
            write_json(STATE/'status.json', result)
            print('Drive account or authorization preflight failed; local data retained.', flush=True)
            return 1
        cleanup_ready = config.get('offload_enabled') and not args.upload_only
        if cleanup_ready:
            try: validate_hot_copies(config)
            except Exception as e:
                cleanup_ready = False
                result['errors'].append({'source':'local recovery snapshots','error':str(e)})
        for path in paths:
            try:
                receipt = upload(path, config['minimum_quiet_seconds'])
                result['results'].append({k:v for k,v in receipt.items() if k != 'manifest'})
                # A sealed outbox item has its own complete verified cloud copy.
                # Its retention must not depend on an unrelated Workshop backup.
                independent_outbox = (config.get('offload_enabled') and not args.upload_only
                                      and path.parent == OUTBOX and (path/'READY').is_file())
                if cleanup_ready or independent_outbox:
                    result['freed_bytes'] += offload(receipt, config)
            except Exception as e:
                result['errors'].append({'source': str(path), 'error': str(e)})
                print(json.dumps({'event':'error', 'source':str(path), 'error':str(e)}), flush=True)
            write_json(STATE/'status.json', result)
        result['finished_at'] = time.time()
        write_json(STATE/'status.json', result)
        print(json.dumps({'event':'finished', 'sources':len(paths), 'errors':len(result['errors']), 'freed_bytes':result['freed_bytes']}), flush=True)
        return 1 if result['errors'] else 0

if __name__ == '__main__':
    try: sys.exit(main())
    except BlockingIOError:
        print('Backup or deployment is busy; the next timer run will retry.'); sys.exit(0)
