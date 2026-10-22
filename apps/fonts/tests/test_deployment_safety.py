"""Offline regression checks for archive rejection and Caddy concurrent edits."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('font_deploy', ROOT / 'deploy/install-static.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class SafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.base = self.root / 'catalog'
        (self.base / 'backups').mkdir(parents=True)
        (self.base / 'releases').mkdir()
        self.caddy = self.root / 'Caddyfile'
        self.caddy.write_text('vm-app.ru {\n    handle { reverse_proxy localhost:18100 }\n}\n')
        self.original = self.caddy.read_bytes()
        self.patches = [patch.object(deploy, 'BASE', self.base), patch.object(deploy, 'CADDY', self.caddy)]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def make_payload(self):
        data = {name: b'entry' for name in deploy.CRITICAL}
        data['assets/fonts/demo.ttf'] = b'font'
        data['assets/licenses/demo.txt'] = b'license'
        data['assets/font-catalog.json'] = json.dumps({'fontCount': 1, 'fonts': [{
            'file': 'assets/fonts/demo.ttf', 'sha256': deploy.digest(b'font'),
            'license': {'file': 'assets/licenses/demo.txt', 'sha256': deploy.digest(b'license')}}]}).encode()
        manifest = {name: {'sha256': deploy.digest(body), 'size': len(body)} for name, body in data.items()}
        return data, manifest

    def make_archive(self, data, extra=None):
        target = self.root / 'package.tar.gz'
        with tarfile.open(target, 'w:gz') as archive:
            for name, body in data.items():
                member = tarfile.TarInfo(name)
                member.size = len(body)
                archive.addfile(member, io.BytesIO(body))
            if extra:
                archive.addfile(extra)
        return target

    def test_safe_paths_reject_escape_and_private_files(self):
        for value in ('../index.html', '/index.html', 'a/../index.html', 'a\\index.html',
                      '.env', 'a/.ssh/auth.json', 'a//index.html'):
            with self.subTest(path=value), self.assertRaises(ValueError):
                deploy.safe_path(value)

    def test_manifest_duplicate_keys_rejected(self):
        manifest = self.root / 'manifest.json'
        manifest.write_text('{"version":1,"version":1,"files":{}}')
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            deploy.load_manifest(manifest)

    def test_valid_manifest_and_archive(self):
        data, files = self.make_payload()
        manifest = self.root / 'manifest.json'
        manifest.write_text(json.dumps({'version': 1, 'files': files}))
        self.assertEqual(deploy.load_manifest(manifest), files)
        self.assertEqual(deploy.archive_payload(self.make_archive(data), files), data)

    def test_archive_symlink_rejected_even_when_name_is_allowed(self):
        data, files = self.make_payload()
        removed = data.pop('assets/fonts/demo.ttf')
        member = tarfile.TarInfo('assets/fonts/demo.ttf')
        member.type, member.linkname = tarfile.SYMTYPE, '/etc/passwd'
        with self.assertRaisesRegex(ValueError, 'Unexpected archive'):
            deploy.archive_payload(self.make_archive(data, member), files)

    def test_archive_undeclared_and_traversal_rejected(self):
        for name in ('../../other.txt', 'undeclared.txt'):
            data, files = self.make_payload()
            data[name] = b'x'
            with self.subTest(path=name), self.assertRaises(ValueError):
                deploy.archive_payload(self.make_archive(data), files)

    def test_archive_hash_corruption_rejected(self):
        data, files = self.make_payload()
        data['index.html'] = b'wrong'
        with self.assertRaisesRegex(ValueError, 'hash mismatch'):
            deploy.archive_payload(self.make_archive(data), files)

    def test_validation_concurrent_change_stops_switch(self):
        external = self.original + b'# newly added external site\n'
        def validate(operation, candidate):
            self.caddy.write_bytes(external)
        with patch.object(deploy, 'checked_caddy', side_effect=validate):
            with self.assertRaisesRegex(RuntimeError, 'changed during validation'):
                deploy.validate_candidate(self.original, self.original + deploy.BLOCK.encode(), 'test')
        self.assertEqual(self.caddy.read_bytes(), external)

    def test_reload_failure_recovers_only_unchanged_candidate(self):
        candidate = self.original + deploy.BLOCK.encode()
        candidate_path = self.root / 'candidate'
        candidate_path.write_bytes(candidate)
        calls = []
        def reload(operation, path):
            calls.append(path.read_bytes())
            if len(calls) == 1:
                raise RuntimeError('Simulated reload failure')
        with patch.object(deploy, 'checked_caddy', side_effect=reload):
            with self.assertRaisesRegex(RuntimeError, 'restored to its baseline'):
                deploy.replace_and_reload(self.original, candidate, candidate_path, 'before')
        self.assertEqual(self.caddy.read_bytes(), self.original)
        self.assertEqual(len(calls), 2)

    def test_reload_failure_preserves_external_config(self):
        candidate = self.original + deploy.BLOCK.encode()
        candidate_path = self.root / 'candidate'
        candidate_path.write_bytes(candidate)
        external = candidate + b'# concurrent route\n'
        def reload(operation, path):
            self.caddy.write_bytes(external)
            raise RuntimeError('Simulated reload failure')
        with patch.object(deploy, 'checked_caddy', side_effect=reload):
            with self.assertRaises(deploy.ConcurrentReloadError):
                deploy.replace_and_reload(self.original, candidate, candidate_path, 'before')
        self.assertEqual(self.caddy.read_bytes(), external)

    def test_rollback_removes_only_owned_route_from_fresh_config(self):
        external = self.original + b'# preserve calculator and concurrent sites\n'
        self.caddy.write_bytes(external + deploy.BLOCK.encode())
        with patch.object(deploy, 'checked_caddy'):
            self.assertTrue(deploy.remove_owned_route())
        self.assertEqual(self.caddy.read_bytes(), external)

    def test_legacy_route_is_recognized_and_unknown_edit_rejected(self):
        self.assertEqual(deploy.owned_route_block(self.original.decode() + deploy.LEGACY_BLOCK), deploy.LEGACY_BLOCK)
        with self.assertRaisesRegex(RuntimeError, 'differs'):
            deploy.owned_route_block(self.original.decode() + deploy.LEGACY_BLOCK.replace('no-store', 'public'))

    def test_route_upgrade_rollback_preserves_other_sites(self):
        external = self.original + b'# preserve current unrelated routes\n'
        self.caddy.write_bytes(external + deploy.BLOCK.encode())
        with patch.object(deploy, 'checked_caddy'):
            deploy.restore_owned_route(deploy.LEGACY_BLOCK)
        self.assertEqual(self.caddy.read_bytes(), external + deploy.LEGACY_BLOCK.encode())

    def test_stale_symlink_switch_does_not_change_newer_release(self):
        first, second = self.base / 'releases/first', self.base / 'releases/second'
        first.mkdir()
        second.mkdir()
        current = self.base / 'current'
        try:
            current.symlink_to(second, target_is_directory=True)
        except OSError:
            self.skipTest('Windows symlink privilege is unavailable')
        with self.assertRaisesRegex(RuntimeError, 'changed externally'):
            deploy.switch_current(str(first), str(first))
        self.assertEqual(current.resolve(), second)


if __name__ == '__main__':
    unittest.main()
