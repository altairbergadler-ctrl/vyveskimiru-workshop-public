#!/usr/bin/env python3
"""Publish only the calculator directory; retain Caddy backup and static releases."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import urllib.request

BASE = Path('/srv/signage-cost-calculator')
CADDY = Path('/etc/caddy/Caddyfile')
BEGIN = '    # BEGIN SIGNAGE COST CALCULATOR\n'
END = '    # END SIGNAGE COST CALCULATOR\n'
BLOCK = BEGIN + '''    redir /calculator /calculator/ 308
    handle_path /calculator/* {
        root * /srv/signage-cost-calculator/current
        header {
            Cache-Control "no-store"
            X-Robots-Tag "noindex, nofollow"
            Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; worker-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'"
        }
        file_server
    }
''' + END


def digest(data):
    return hashlib.sha256(data).hexdigest()


def health():
    with urllib.request.urlopen('http://127.0.0.1:18100/api/health', timeout=20) as response:
        data = json.load(response)
    return {key: data[key] for key in ['status', 'version']}


def containers():
    return subprocess.check_output(['docker', 'ps', '--format', '{{.Names}} {{.ID}} {{.Image}}'], text=True).strip()


def checked_caddy(operation, path):
    result = subprocess.run(['caddy', operation, '--config', str(path), '--adapter', 'caddyfile'], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('Caddy ' + operation + ' failed; configuration contents are not printed.')


def switch_link(target):
    current = BASE / 'current'
    if current.exists() or current.is_symlink():
        if not current.is_symlink():
            raise RuntimeError('Current path is not a symlink; left untouched.')
    if target is None:
        if current.is_symlink():
            current.unlink()
        return
    target = Path(target).resolve()
    if not target.is_relative_to(BASE / 'releases') or not target.is_dir():
        raise RuntimeError('Release target outside calculator releases.')
    temporary = BASE / ('current.next-' + str(os.getpid()))
    temporary.symlink_to(target, target_is_directory=True)
    temporary.replace(current)


def rollback(state_path):
    state = json.loads(Path(state_path).read_text())
    current_source = CADDY.read_bytes()
    text = current_source.decode()
    if text.count(BLOCK) != 1:
        raise RuntimeError('Calculator route differs from this deployment; no configuration changed.')
    candidate = CADDY.with_name('Caddyfile.calculator-rollback-' + str(os.getpid()))
    candidate.write_text(text.replace(BLOCK, '', 1))
    shutil.copymode(CADDY, candidate)
    checked_caddy('validate', candidate)
    if CADDY.read_bytes() != current_source:
        raise RuntimeError('Caddy changed during rollback; stopped.')
    rollback_backup = BASE / 'backups' / ('Caddyfile.before-rollback-' + str(os.getpid()))
    shutil.copy2(CADDY, rollback_backup)
    candidate.replace(CADDY)
    try:
        checked_caddy('reload', CADDY)
    except Exception:
        shutil.copy2(rollback_backup, CADDY)
        checked_caddy('reload', CADDY)
        raise
    switch_link(state['previous_current'])
    print(json.dumps({'rolled_back': True, 'health': health()}))


def install(args):
    if not re.fullmatch(r'[a-zA-Z0-9-]+', args.release):
        raise RuntimeError('Invalid release name.')
    original = CADDY.read_bytes()
    if digest(original) != args.expected_caddy:
        raise RuntimeError('Caddy baseline changed; inspect current configuration before retrying.')
    source = original.decode()
    if len(re.findall(r'^vm-app\.ru \{\n', source, re.MULTILINE)) != 1 or BEGIN in source or '/calculator' in source:
        raise RuntimeError('Existing calculator route or unexpected vm-app host; stopped.')
    before_health, before_containers = health(), containers()
    current = BASE / 'current'
    previous = str(current.resolve()) if current.is_symlink() else None
    if current.exists() and not current.is_symlink():
        raise RuntimeError('Unexpected current directory; stopped.')
    release = BASE / 'releases' / args.release
    if release.exists():
        raise RuntimeError('Release already exists; preserved for inspection.')
    manifest = json.loads(Path(args.manifest).read_text(encoding='utf-8-sig'))
    expected_files = {'index.html', 'styles.css', 'app.mjs', 'calculator.mjs', 'sw.js'}
    if set(manifest) != expected_files:
        raise RuntimeError('Unexpected manifest entries.')
    payload = {}
    with tarfile.open(args.archive, 'r:gz') as archive:
        for member in archive.getmembers():
            name = member.name.removeprefix('./')
            if member.isdir() and name in {'', '.'}:
                continue
            if not member.isfile() or name not in expected_files or name in payload:
                raise RuntimeError('Unexpected archive entry; nothing extracted.')
            data = archive.extractfile(member).read()
            if digest(data) != manifest[name]:
                raise RuntimeError('Archive hash mismatch: ' + name)
            payload[name] = data
    if set(payload) != expected_files:
        raise RuntimeError('Archive file list mismatch.')
    release.mkdir(parents=True, mode=0o755)
    for name, data in payload.items():
        path = release / name
        path.write_bytes(data)
        path.chmod(0o644)
    backup_dir = BASE / 'backups'
    backup_dir.mkdir(mode=0o700, exist_ok=True)
    backup = backup_dir / ('Caddyfile.before-' + args.release)
    shutil.copy2(CADDY, backup)
    backup.chmod(0o600)
    candidate = CADDY.with_name('Caddyfile.calculator-candidate-' + str(os.getpid()))
    candidate.write_text(source.replace('vm-app.ru {\n', 'vm-app.ru {\n' + BLOCK, 1))
    shutil.copymode(CADDY, candidate)
    checked_caddy('validate', candidate)
    if CADDY.read_bytes() != original:
        raise RuntimeError('Caddy changed during validation; stopped before switch.')
    switch_link(release)
    candidate.replace(CADDY)
    try:
        checked_caddy('reload', CADDY)
        for name, expected in manifest.items():
            url = 'https://vm-app.ru/calculator/' + ('' if name == 'index.html' else name)
            with urllib.request.urlopen(url, timeout=20) as response:
                if response.status != 200 or digest(response.read()) != expected:
                    raise RuntimeError('Published file did not match: ' + name)
        if health() != before_health or containers() != before_containers:
            raise RuntimeError('Existing service identity changed; inspect before continuing.')
    except Exception:
        shutil.copy2(backup, CADDY)
        CADDY.chmod(0o644)
        checked_caddy('reload', CADDY)
        switch_link(previous)
        raise
    state = {'release': str(release), 'previous_current': previous, 'caddy_backup': str(backup),
             'caddy_before_sha256': digest(original), 'caddy_after_sha256': digest(CADDY.read_bytes()),
             'files': manifest, 'health': health(), 'url': 'https://vm-app.ru/calculator/'}
    state_path = BASE / ('deployment-' + args.release + '.json')
    state_path.write_text(json.dumps(state, indent=2) + '\n')
    deploy_dir = BASE / 'deploy'
    deploy_dir.mkdir(exist_ok=True)
    shutil.copy2(__file__, deploy_dir / 'install-static.py')
    print(json.dumps({'published': True, 'url': state['url'], 'state': str(state_path), 'files_verified': len(manifest),
                      'caddy_backup': str(backup), 'service_identities_unchanged': True, 'health': state['health']}))


parser = argparse.ArgumentParser()
parser.add_argument('--archive')
parser.add_argument('--manifest')
parser.add_argument('--expected-caddy')
parser.add_argument('--release')
parser.add_argument('--rollback')
args = parser.parse_args()
BASE.mkdir(parents=True, mode=0o755, exist_ok=True)
with (BASE / 'deploy.lock').open('a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    if args.rollback:
        rollback(args.rollback)
    else:
        if not all([args.archive, args.manifest, args.expected_caddy, args.release]):
            parser.error('archive, manifest, expected-caddy and release required')
        install(args)
