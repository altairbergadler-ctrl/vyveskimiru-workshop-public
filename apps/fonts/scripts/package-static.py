#!/usr/bin/env python3
"""Make an exact static-release archive and path/hash/size manifest from dist.

Example: python scripts/package-static.py --output qa/package
The output directory must be outside dist. No files in dist are modified.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile

MAX_FILES, MAX_BYTES = 600, 180 * 1024 * 1024
ROOT = Path(__file__).resolve().parents[1]
EXTENSIONS = {'.html', '.css', '.js', '.mjs', '.json', '.ttf', '.otf', '.woff', '.woff2',
              '.txt', '.svg', '.png', '.jpg', '.webp'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dist', type=Path, default=ROOT / 'dist')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    dist, output = args.dist.resolve(strict=True), args.output.resolve()
    if output == dist or output.is_relative_to(dist):
        parser.error('Output must be outside dist')
    entries, folded = {}, set()
    for path in sorted(dist.rglob('*')):
        info = path.lstat()
        if path.is_symlink() or getattr(info, 'st_file_attributes', 0) & 0x400:
            parser.error('Symlink/reparse point found: ' + str(path))
        if path.is_dir():
            continue
        if not stat.S_ISREG(info.st_mode):
            parser.error('Non-regular file: ' + str(path))
        name = path.relative_to(dist).as_posix()
        pure = PurePosixPath(name)
        if (not re.fullmatch(r'[A-Za-z0-9_./-]+', name) or
                any(part.startswith('.') for part in pure.parts) or
                pure.suffix.lower() not in EXTENSIONS or name.casefold() in folded):
            parser.error('Unsafe/colliding public file: ' + name)
        folded.add(name.casefold())
        data = path.read_bytes()
        entries[name] = {'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}
    if not 1 <= len(entries) <= MAX_FILES or sum(v['size'] for v in entries.values()) >= MAX_BYTES:
        parser.error('Payload must be <=600 files and <180 MiB')
    required = {'index.html', 'assets/gallery.css', 'assets/gallery.js', 'assets/stroke.js', 'assets/font-catalog.json'}
    if not required.issubset(entries):
        parser.error('Missing required entry points: ' + ', '.join(sorted(required - set(entries))))
    output.mkdir(parents=True, exist_ok=True)
    archive, manifest = output / 'font-gallery.tar.gz', output / 'manifest.json'
    if archive.exists() or manifest.exists():
        parser.error('Package output already exists; use a new directory')
    try:
        with tarfile.open(archive, 'w:gz', format=tarfile.PAX_FORMAT) as tar:
            for name, expected in entries.items():
                path = dist / name
                data = path.read_bytes()
                if len(data) != expected['size'] or hashlib.sha256(data).hexdigest() != expected['sha256']:
                    raise RuntimeError('dist changed while packaging: ' + name)
                import io
                member = tarfile.TarInfo(name)
                member.size, member.mode, member.mtime = len(data), 0o644, 0
                tar.addfile(member, io.BytesIO(data))
        manifest.write_text(json.dumps({'version': 1, 'files': entries}, indent=2) + '\n', encoding='utf-8')
    except Exception:
        archive.unlink(missing_ok=True)
        manifest.unlink(missing_ok=True)
        raise
    print(json.dumps({'archive': str(archive), 'manifest': str(manifest), 'files': len(entries),
                      'bytes': sum(v['size'] for v in entries.values())}))


if __name__ == '__main__':
    main()
