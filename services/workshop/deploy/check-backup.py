"""Require a complete, current, matching backup and verify every archive checksum."""
import datetime
import gzip
import hashlib
import json
import pathlib
import sqlite3
import sys

dest = pathlib.Path(sys.argv[1]).resolve()
release = pathlib.Path(sys.argv[2]).resolve()
max_age = int(sys.argv[3]) if len(sys.argv) > 3 else 86400
meta = dict(line.split('=', 1) for line in (dest / 'COMPLETE').read_text().splitlines())
now = datetime.datetime.now(datetime.timezone.utc)
start = datetime.datetime.fromisoformat(meta['started'].replace('Z', '+00:00'))
finish = datetime.datetime.fromisoformat(meta['finished'].replace('Z', '+00:00'))
assert start <= finish <= now and (now - start).total_seconds() <= max_age, 'STALE_OR_INVALID_BACKUP'
assert pathlib.Path(meta['release']).resolve() == release, 'BACKUP_RELEASE_MISMATCH'
expected = {'finance.sqlite3', 'google-full.json.gz', 'files.tar.gz'}
if meta.get('analytics') == 'present':
    expected.add('analytics.sqlite3')
if meta.get('sales') == 'present':
    expected.add('sales.sqlite3')
seen = set()
for line in (dest / 'SHA256SUMS').read_text().splitlines():
    digest, name = line.split()
    assert name in expected and name not in seen, 'INVALID_BACKUP_MANIFEST'
    seen.add(name)
    with (dest / name).open('rb') as stream:
        actual = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            actual.update(chunk)
        assert actual.hexdigest() == digest, 'BACKUP_CHECKSUM_MISMATCH'
assert seen == expected, 'INCOMPLETE_BACKUP_MANIFEST'
with gzip.open(dest / 'google-full.json.gz', 'rt') as stream:
    assert json.load(stream).get('sheets'), 'EMPTY_GOOGLE_BACKUP'
db = sqlite3.connect((dest / 'finance.sqlite3').as_uri() + '?mode=ro', uri=True)
assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'INVALID_BACKUP_DATABASE'
db.close()
if 'analytics.sqlite3' in expected:
    analytics_db = sqlite3.connect((dest / 'analytics.sqlite3').as_uri() + '?mode=ro', uri=True)
    assert analytics_db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'INVALID_ANALYTICS_BACKUP'
    analytics_db.close()
if 'sales.sqlite3' in expected:
    sales_db = sqlite3.connect((dest / 'sales.sqlite3').as_uri() + '?mode=ro', uri=True)
    assert sales_db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'INVALID_SALES_BACKUP'
    sales_db.close()
print('Backup freshness, release, checksums, Google snapshot and SQLite: verified')
