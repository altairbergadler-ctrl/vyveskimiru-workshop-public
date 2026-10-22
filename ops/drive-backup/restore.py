#!/usr/bin/env python3
"""Restore a verified cloud unit into a new directory; never overwrite live data."""
import json, os, pathlib, sys
sys.path.insert(0,'/usr/local/lib/vps-drive')
import vps_drive as v
os.umask(0o077)
if len(sys.argv)!=3: raise SystemExit('Usage: vps-drive-restore RECEIPT.json /absolute/new-directory')
r=json.loads(pathlib.Path(sys.argv[1]).read_text())
remote=r['remote']
if not remote.startswith('vps-vault:archives/'): raise SystemExit('Unsupported archive namespace')
target=pathlib.Path(sys.argv[2])
if not target.is_absolute() or target.resolve()!=target or target.exists(): raise SystemExit('Destination must be a new absolute directory without symlinks')
m=json.loads(v.rclone('cat',remote+'/manifest.json'))
if m!=r['manifest']: raise SystemExit('Remote manifest differs from the verified receipt')
def safe_relative(value):
    p=pathlib.PurePosixPath(value)
    if p.is_absolute() or '..' in p.parts: raise RuntimeError('Unsafe manifest path')
    return p
for f in m['files']: safe_relative(f['path'])
for d in m['directories']: safe_relative(d)
target.mkdir(mode=0o700,parents=True)
v.rclone('copy',remote+'/data',target,'--immutable')
for f in m['files']:
    p=target/f['path']
    if p.is_symlink() or p.stat().st_size!=f['size'] or v.sha(p)!=f['sha256']: raise RuntimeError('Restore checksum mismatch')
    p.chmod(f['mode'] & 0o777)
for d in m['directories']: (target/d).mkdir(parents=True,exist_ok=True)
print(json.dumps({'restored_to':str(target),'files':len(m['files']),'bytes':sum(f['size'] for f in m['files']),'verified':True}))
