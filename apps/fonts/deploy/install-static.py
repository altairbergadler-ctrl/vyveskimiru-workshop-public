#!/usr/bin/env python3
"""Deploy the isolated /fonts/ static beta; never manage application containers.

Linux-only installer. A content comparison before each Caddy replace protects
against stale baselines. The shared advisory lock also protects cooperating
route installers; tools that ignore that lock can still race a filesystem CAS.
Rollback edits only this route in the freshest configuration.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import urllib.error
import urllib.parse
import urllib.request

BASE = Path('/srv/signage-font-catalog')
CADDY = Path('/etc/caddy/Caddyfile')
MAX_FILES = 600
MAX_BYTES = 180 * 1024 * 1024
BEGIN = '    # BEGIN SIGNAGE FONT CATALOG\n'
END = '    # END SIGNAGE FONT CATALOG\n'
LEGACY_BLOCK = BEGIN + '''    redir /fonts /fonts/ 308
    handle_path /fonts/* {
        root * /srv/signage-font-catalog/current
        header {
            Cache-Control "no-store"
            X-Robots-Tag "noindex, nofollow"
            Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'"
        }
        file_server
    }
''' + END
BLOCK = LEGACY_BLOCK.replace("style-src 'self';", "style-src 'self' 'unsafe-inline';").replace("connect-src 'self';", "connect-src 'self' blob:;").replace("script-src 'self';", "script-src 'self' 'wasm-unsafe-eval';")
CRITICAL = ('index.html', 'assets/gallery.css', 'assets/gallery.js',
            'assets/stroke.js', 'assets/font-catalog.json', 'tryon.html',
            'assets/tryon.css', 'assets/tryon.js', 'assets/photo-warp.mjs', 'assets/ar.bundle.js')
PUBLIC_EXTENSIONS = {'.html', '.css', '.js', '.mjs', '.json', '.ttf', '.otf',
                     '.woff', '.woff2', '.txt', '.svg', '.png', '.jpg', '.webp'}


class ConcurrentReloadError(RuntimeError):
    """A failed reload coincided with an external config change; do not reload it."""


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_directory(path: Path, mode: int) -> None:
    if path.is_symlink() or (path.exists() and not path.is_dir()):
        raise RuntimeError('Unexpected deployment directory: ' + str(path))
    path.mkdir(mode=mode, exist_ok=True)


def safe_path(name: str) -> str:
    if not isinstance(name, str) or not name or len(name) > 240:
        raise ValueError('Invalid manifest path')
    path = PurePosixPath(name)
    if (path.is_absolute() or name != path.as_posix() or '\\' in name or
            any(part in {'.', '..'} or part.startswith('.') for part in path.parts) or
            not re.fullmatch(r'[A-Za-z0-9_./-]+', name)):
        raise ValueError('Unsafe manifest path: ' + name)
    if path.suffix.lower() not in PUBLIC_EXTENSIONS:
        raise ValueError('Unexpected public file type: ' + name)
    return name


def release_name(name: str) -> str:
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{3,79}', name):
        raise ValueError('Release must be 4-80 lowercase letters, digits or hyphens')
    return name


def load_manifest(path: Path) -> dict:
    if path.stat().st_size > 4 * 1024 * 1024:
        raise ValueError('Manifest is too large')
    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('Duplicate JSON key: ' + key)
            result[key] = value
        return result
    manifest = json.loads(path.read_text(encoding='utf-8-sig'), object_pairs_hook=unique_pairs)
    if set(manifest) != {'version', 'files'} or manifest['version'] != 1:
        raise ValueError('Unsupported manifest schema')
    files = manifest['files']
    if not isinstance(files, dict) or not 1 <= len(files) <= MAX_FILES:
        raise ValueError('Invalid number of manifest files')
    folded = set()
    for name, item in files.items():
        safe_path(name)
        if name.casefold() in folded:
            raise ValueError('Case-insensitive filename collision')
        folded.add(name.casefold())
        if (not isinstance(item, dict) or set(item) != {'sha256', 'size'} or
                not isinstance(item['sha256'], str) or
                not re.fullmatch(r'[a-f0-9]{64}', item['sha256']) or
                type(item['size']) is not int or item['size'] < 0):
            raise ValueError('Invalid manifest record: ' + name)
    if sum(item['size'] for item in files.values()) >= MAX_BYTES:
        raise ValueError('Payload must be smaller than 180 MiB')
    if any(name not in files for name in CRITICAL):
        raise ValueError('Missing required gallery entry points')
    for name in files:
        if any(parent.as_posix() in files for parent in PurePosixPath(name).parents):
            raise ValueError('File/directory collision: ' + name)
    return files


def archive_payload(archive_path: Path, files: dict) -> dict[str, bytes]:
    if archive_path.stat().st_size > MAX_BYTES + 1024 * 1024:
        raise ValueError('Archive exceeds size limit')
    allowed_dirs = {parent.as_posix() for name in files
                    for parent in PurePosixPath(name).parents if parent.as_posix() != '.'}
    payload, dirs = {}, set()
    with tarfile.open(archive_path, 'r:gz') as archive:
        for count, member in enumerate(archive, start=1):
            if count > MAX_FILES * 4:
                raise ValueError('Too many archive entries')
            name = member.name
            if member.isdir():
                canonical = name.rstrip('/')
                if canonical not in allowed_dirs or canonical in dirs:
                    raise ValueError('Unexpected archive directory: ' + name)
                dirs.add(canonical)
                continue
            safe_path(name)
            if not member.isreg() or name not in files or name in payload:
                raise ValueError('Unexpected archive entry: ' + name)
            expected = files[name]
            if member.size != expected['size']:
                raise ValueError('Archive size mismatch: ' + name)
            stream = archive.extractfile(member)
            if stream is None:
                raise ValueError('Unreadable archive entry')
            data = stream.read(expected['size'] + 1)
            if len(data) != expected['size'] or digest(data) != expected['sha256']:
                raise ValueError('Archive hash mismatch: ' + name)
            payload[name] = data
    if set(payload) != set(files):
        raise ValueError('Archive file set differs from manifest')
    catalog = json.loads(payload['assets/font-catalog.json'])
    fonts = catalog.get('fonts', [])
    if not fonts or catalog.get('fontCount') != len(fonts):
        raise ValueError('Font catalogue count mismatch or empty catalogue')
    for font in fonts:
        font_path = safe_path(font['file'])
        license_path = safe_path(font['license']['file'])
        if (font_path not in files or license_path not in files or
                files[font_path]['sha256'] != font['sha256'] or
                files[license_path]['sha256'] != font['license']['sha256']):
            raise ValueError('Font catalogue reference/hash mismatch')
    return payload


def checked_caddy(operation: str, path: Path) -> None:
    result = subprocess.run(['/usr/bin/caddy', operation, '--config', str(path),
                             '--adapter', 'caddyfile'], capture_output=True, text=True)
    if result.returncode:
        # Do not print configuration/diagnostics that can contain other sites' secrets.
        raise RuntimeError('Caddy ' + operation + ' failed (exit ' + str(result.returncode) + ')')


def write_private(path: Path, value) -> None:
    temporary = path.with_name(path.name + '.next-' + str(os.getpid()))
    with temporary.open('x', encoding='utf-8') as out:
        os.chmod(temporary, 0o600)
        json.dump(value, out, ensure_ascii=False, indent=2)
        out.write('\n')
    temporary.replace(path)


def owned_route_block(source: str) -> str | None:
    if source.count(BEGIN) or source.count(END):
        matches = [block for block in (BLOCK, LEGACY_BLOCK) if source.count(block) == 1]
        if len(matches) != 1 or source.count(BEGIN) != 1 or source.count(END) != 1:
            raise RuntimeError('Existing font route differs; configuration left untouched')
        block = matches[0]
        remainder = source.replace(block, '', 1)
        if re.search(r'(?<![A-Za-z])/fonts(?:/|\s)', remainder):
            raise RuntimeError('Additional /fonts route exists')
        return block
    if re.search(r'(?<![A-Za-z])/fonts(?:/|\s)', source):
        raise RuntimeError('Existing /fonts route without owned markers')
    return None


def route_status(source: str) -> bool:
    return owned_route_block(source) is not None


def validate_candidate(original: bytes, candidate: bytes, suffix: str) -> Path:
    if CADDY.is_symlink() or not CADDY.is_file():
        raise RuntimeError('Caddyfile is not a regular configuration file')
    path = CADDY.with_name('Caddyfile.fonts-' + suffix + '-' + str(os.getpid()))
    with path.open('xb') as out:
        out.write(candidate)
    shutil.copymode(CADDY, path)
    try:
        checked_caddy('validate', path)
        if CADDY.read_bytes() != original:
            raise RuntimeError('Caddy changed during validation; nothing switched')
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return path


def replace_and_reload(original: bytes, candidate: bytes, path: Path, backup_name: str) -> None:
    # Caller already holds both route and shared Caddy locks. Compare again at replace.
    if CADDY.read_bytes() != original:
        path.unlink(missing_ok=True)
        raise RuntimeError('Caddy changed before replacement; nothing switched')
    backup = BASE / 'backups' / backup_name
    with backup.open('xb') as out:
        os.chmod(backup, 0o600)
        out.write(original)
    path.replace(CADDY)
    try:
        checked_caddy('reload', CADDY)
    except Exception as error:
        if CADDY.read_bytes() != candidate:
            raise ConcurrentReloadError('Reload failed and Caddy was changed externally; no baseline restoration attempted') from error
        restore = CADDY.with_name('Caddyfile.fonts-recovery-' + str(os.getpid()))
        restore.write_bytes(original)
        shutil.copymode(CADDY, restore)
        # Never replace a newer configuration with the old full baseline.
        if CADDY.read_bytes() != candidate:
            restore.unlink(missing_ok=True)
            raise ConcurrentReloadError('Caddy changed before reload recovery; no baseline restoration attempted') from error
        restore.replace(CADDY)
        checked_caddy('reload', CADDY)
        raise RuntimeError('Reload failed; unchanged own candidate was restored to its baseline') from error


def current_target() -> str | None:
    current = BASE / 'current'
    if not current.is_symlink():
        if current.exists():
            raise RuntimeError('Current path is not a symlink')
        return None
    target = current.resolve(strict=True)
    if not target.is_relative_to(BASE / 'releases') or not target.is_dir():
        raise RuntimeError('Current symlink points outside catalog releases')
    return str(target)


def switch_current(target: str | None, expected: str | None) -> None:
    if current_target() != expected:
        raise RuntimeError('Current release changed externally; symlink left untouched')
    current = BASE / 'current'
    if target is None:
        current.unlink(missing_ok=True)
        return
    resolved = Path(target).resolve(strict=True)
    if not resolved.is_relative_to(BASE / 'releases') or not resolved.is_dir():
        raise RuntimeError('Release target outside catalog release directory')
    temporary = BASE / ('current.next-' + str(os.getpid()))
    temporary.symlink_to(resolved, target_is_directory=True)
    temporary.replace(current)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def request(url: str, limit: int) -> tuple[int, dict, bytes]:
    try:
        response = OPENER.open(url, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        data = response.read(limit + 1)
        if len(data) > limit:
            raise RuntimeError('Response exceeds expected size: ' + url)
        return response.status, dict(response.headers), data


def service_snapshot() -> dict:
    snapshot = {'checked_at': now()}
    try:
        status, _, data = request('http://127.0.0.1:18100/api/health', 65536)
        health = json.loads(data)
        snapshot['finance'] = {'http': status, **{key: health.get(key) for key in ('status', 'version')}}
        status, _, data = request('https://vm-app.ru/signs/healthz', 65536)
        snapshot['signs'] = {'http': status, 'body': json.loads(data)}
        snapshot['containers'] = sorted(subprocess.check_output(
            ['docker', 'ps', '--format', '{{.Names}} {{.ID}} {{.Image}}'], text=True).splitlines())
        for name, url in [('main_http', 'https://vm-app.ru/'),
                          ('signs_http', 'https://vm-app.ru/signs/'),
                          ('signs_config_http', 'https://vm-app.ru/signs/api/config')]:
            snapshot[name] = request(url, 2 * 1024 * 1024)[0]
    except Exception as error:
        snapshot['snapshot_error'] = type(error).__name__ + ': ' + str(error)
    return snapshot


def disk_verify(release: Path, files: dict) -> None:
    discovered = set()
    for path in release.rglob('*'):
        if path.is_symlink():
            raise RuntimeError('Symlink found in release')
        if path.is_dir():
            continue
        if not path.is_file():
            raise RuntimeError('Non-regular release entry')
        name = path.relative_to(release).as_posix()
        discovered.add(name)
        item = files.get(name)
        if item is None or path.stat().st_size != item['size'] or digest(path.read_bytes()) != item['sha256']:
            raise RuntimeError('Disk hash mismatch: ' + name)
    if discovered != set(files):
        raise RuntimeError('Disk file set mismatch')


def published_verify(release: Path, files: dict) -> dict:
    evidence = {'checked_at': now(), 'http_files': {}}
    status, headers, _ = request('https://vm-app.ru/fonts', 65536)
    if status != 308 or headers.get('Location') != '/fonts/':
        raise RuntimeError('/fonts canonical redirect mismatch')
    evidence['canonical_redirect'] = {'status': status, 'location': headers.get('Location')}
    fonts = sorted(name for name in files if PurePosixPath(name).suffix.lower() in {'.ttf', '.otf', '.woff', '.woff2'})
    sample = [fonts[index] for index in sorted({0, len(fonts) // 4, len(fonts) // 2, 3 * len(fonts) // 4, len(fonts) - 1})] if fonts else []
    for name in list(CRITICAL) + sample:
        url = 'https://vm-app.ru/fonts/' + ('' if name == 'index.html' else urllib.parse.quote(name, safe='/'))
        status, headers, data = request(url, files[name]['size'])
        if status != 200 or digest(data) != files[name]['sha256'] or headers.get('Cache-Control') != 'no-store':
            raise RuntimeError('Published HTTP hash/status/cache mismatch: ' + name)
        evidence['http_files'][name] = {'http': status, 'sha256': digest(data), 'bytes': len(data),
                                       'content_type': headers.get('Content-Type')}
    disk_verify(release, files)
    evidence['all_disk_files_verified'] = len(files)
    evidence['https_font_sample'] = sample
    return evidence


def remove_owned_route() -> bool:
    # Rebase only the owned route removal onto the newest Caddy contents.
    original = CADDY.read_bytes()
    source = original.decode('utf-8')
    block = owned_route_block(source)
    if not block:
        return False
    candidate = source.replace(block, '', 1).encode('utf-8')
    path = validate_candidate(original, candidate, 'rollback')
    replace_and_reload(original, candidate, path, 'Caddyfile.before-route-removal-' + str(os.getpid()))
    return True


def restore_owned_route(previous_block: str) -> None:
    if previous_block not in (BLOCK, LEGACY_BLOCK):
        raise RuntimeError('Unknown previous font route')
    original = CADDY.read_bytes()
    source = original.decode('utf-8')
    active = owned_route_block(source)
    if active == previous_block:
        return
    if active != BLOCK:
        raise RuntimeError('Font route changed externally; cannot restore')
    candidate = source.replace(BLOCK, previous_block, 1).encode('utf-8')
    path = validate_candidate(original, candidate, 'restore-route')
    replace_and_reload(original, candidate, path, 'Caddyfile.before-route-restore-' + str(os.getpid()))


def perform_rollback(state: dict) -> dict:
    target = state['release']
    if not Path(target).resolve().is_relative_to(BASE / 'releases'):
        raise RuntimeError('Invalid deployment state release')
    if current_target() != target:
        raise RuntimeError('Newer catalog release is active; refusing stale rollback')
    removed = remove_owned_route() if state['route_added'] else False
    if state.get('route_updated'):
        restore_owned_route(state['previous_route_block'])
    switch_current(state['previous_current'], target)
    result = {'rolled_back': True, 'checked_at': now(), 'route_removed': removed,
              'restored_current': state['previous_current'], 'services_after': service_snapshot(),
              'caddy_sha256': digest(CADDY.read_bytes())}
    return result


def install(args) -> dict:
    name = release_name(args.release)
    original = CADDY.read_bytes()
    if digest(original) != args.expected_caddy:
        raise RuntimeError('Caddy baseline changed; inspect current configuration before retrying')
    source = original.decode('utf-8')
    if len(re.findall(r'^vm-app\.ru \{\n', source, re.MULTILINE)) != 1:
        raise RuntimeError('Unexpected vm-app.ru host block')
    previous_block = owned_route_block(source)
    route_exists = previous_block is not None
    files = load_manifest(Path(args.manifest))
    payload = archive_payload(Path(args.archive), files)
    previous = current_target()
    release = BASE / 'releases' / name
    if release.exists() or release.is_symlink():
        raise RuntimeError('Release already exists; preserved for inspection')
    release.mkdir(mode=0o755)
    for file_name, data in payload.items():
        path = release / file_name
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        with path.open('xb') as out:
            out.write(data)
        path.chmod(0o644)
    disk_verify(release, files)
    services_before = service_snapshot()
    state = {'schema': 1, 'created_at': now(), 'release': str(release), 'previous_current': previous,
             'route_added': not route_exists, 'route_block_sha256': digest(BLOCK.encode()),
             'route_updated': route_exists and previous_block != BLOCK,
             'previous_route_block': previous_block,
             'caddy_before_sha256': digest(original), 'files': files,
             'services_before': services_before, 'url': 'https://vm-app.ru/fonts/', 'status': 'prepared'}
    state_path = BASE / 'deployments' / (name + '.json')
    write_private(state_path, state)
    candidate = (source.replace(previous_block, BLOCK, 1) if route_exists else
                 source.replace('vm-app.ru {\n', 'vm-app.ru {\n' + BLOCK, 1)).encode()
    candidate_path = validate_candidate(original, candidate, 'candidate') if candidate != original else None
    switched = False
    try:
        if CADDY.read_bytes() != original:
            raise RuntimeError('Caddy changed before release switch')
        switch_current(str(release), previous)
        switched = True
        if candidate_path:
            replace_and_reload(original, candidate, candidate_path, 'Caddyfile.before-' + name)
        state['verification'] = published_verify(release, files)
    except Exception as error:
        state['status'] = 'failed'
        state['error'] = type(error).__name__ + ': ' + str(error)
        if candidate_path:
            candidate_path.unlink(missing_ok=True)
        if switched:
            try:
                if isinstance(error, ConcurrentReloadError):
                    switch_current(previous, str(release))
                    state['automatic_rollback'] = {'restored_current': previous,
                        'caddy_left_untouched': True,
                        'note': 'External config changed during failed reload; route requires inspection.'}
                else:
                    state['automatic_rollback'] = perform_rollback(state)
            except Exception as rollback_error:
                state['rollback_error'] = type(rollback_error).__name__ + ': ' + str(rollback_error)
        write_private(state_path, state)
        raise RuntimeError('Publication failed; evidence: ' + str(state_path) + '; ' + state['error']) from error
    services_after = service_snapshot()
    def identities(snapshot):
        return {key: value for key, value in snapshot.items() if key != 'checked_at'}
    state['services_after'] = services_after
    state['external_service_snapshot_changed'] = identities(services_before) != identities(services_after)
    state['status'] = 'published'
    state['caddy_after_sha256'] = digest(CADDY.read_bytes())
    write_private(state_path, state)
    return {'published': True, 'url': state['url'], 'state': str(state_path),
            'disk_files_verified': len(files), 'https_files_verified': len(state['verification']['http_files']),
            'external_service_snapshot_changed': state['external_service_snapshot_changed'],
            'note': 'External service changes are reported; no other service is restarted or rolled back.'}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive')
    parser.add_argument('--manifest')
    parser.add_argument('--expected-caddy')
    parser.add_argument('--release')
    parser.add_argument('--rollback', help='Private deployment state path produced by this installer')
    args = parser.parse_args()
    if os.name != 'posix':
        parser.error('Installer runs only on the Linux VPS')
    import fcntl
    if os.geteuid() != 0:
        parser.error('Run as root')
    if not args.rollback and not all((args.archive, args.manifest, args.expected_caddy, args.release)):
        parser.error('archive, manifest, expected-caddy and release are required')
    if args.expected_caddy and not re.fullmatch(r'[a-f0-9]{64}', args.expected_caddy):
        parser.error('expected-caddy must be a SHA-256 digest')
    ensure_directory(BASE, 0o755)
    for directory, mode in [('releases', 0o755), ('backups', 0o700), ('deployments', 0o700), ('deploy', 0o700)]:
        ensure_directory(BASE / directory, mode)
    with ExitStack() as stack:
        for lock_path in (BASE / 'deploy.lock', CADDY.parent / 'codex-route.deploy.lock'):
            lock = stack.enter_context(lock_path.open('a'))
            fcntl.flock(lock, fcntl.LOCK_EX)
        if args.rollback:
            state_path = Path(args.rollback).resolve(strict=True)
            if not state_path.is_relative_to(BASE / 'deployments'):
                raise RuntimeError('Rollback state must be in catalog deployments directory')
            state = json.loads(state_path.read_text())
            if state.get('status') == 'rolled_back':
                raise RuntimeError('This deployment was already rolled back')
            if state.get('route_block_sha256') != digest(BLOCK.encode()):
                raise RuntimeError('Route block differs from this installer')
            result = perform_rollback(state)
            state['rollback'] = result
            state['status'] = 'rolled_back'
            write_private(state_path, state)
        else:
            result = install(args)
            script = BASE / 'deploy' / 'install-static.py'
            if Path(__file__).resolve() != script.resolve():
                shutil.copy2(__file__, script)
                script.chmod(0o700)
        print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
