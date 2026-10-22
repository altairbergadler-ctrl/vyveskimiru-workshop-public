import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from history_transfer import export_history, import_history


class HistoryTransferTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.job = self.source / "abc12345678901234"
        self.job.mkdir(parents=True)
        (self.job / "project.json").write_text('{"sign":{"text":"ЦВЕТЫ"}}', encoding="utf-8")
        (self.job / "render.png").write_bytes(b"test picture")
        self.archive = self.root / "backup.zip"
        self.destination = self.root / "restored"

    def test_roundtrip_bytes_and_legacy_date_excluding_secrets(self):
        (self.job / "auth.json").write_text("do not export")
        before = (self.job / "project.json").stat().st_mtime_ns
        result = export_history(self.source, self.archive)
        self.assertEqual(result["jobs"], 1)
        import_history(self.archive, self.destination)
        restored = self.destination / self.job.name
        self.assertEqual((restored / "render.png").read_bytes(), b"test picture")
        self.assertEqual((restored / "project.json").stat().st_mtime_ns, before)
        self.assertFalse((restored / "auth.json").exists())

    def test_active_generation_rejected(self):
        (self.job / "job.json").write_text('{"status":"running"}')
        with self.assertRaisesRegex(ValueError, "active"):
            export_history(self.source, self.archive)
        self.assertFalse(self.archive.exists())

    def test_two_stage_and_manufacturing_inputs_survive_roundtrip(self):
        names = ("product-neutral.png", "product-guide.png", "layout-guide.png",
                 "production-spec.json", "product-stage.json", "input-project.json")
        for name in names:
            (self.job / name).write_bytes(("exact-original-" + name).encode())
        export_history(self.source, self.archive)
        import_history(self.archive, self.destination)
        for name in names:
            self.assertEqual((self.destination / self.job.name / name).read_bytes(),
                             ("exact-original-" + name).encode())

    def test_existing_backup_and_jobs_never_overwritten(self):
        export_history(self.source, self.archive)
        with self.assertRaisesRegex(ValueError, "already exists"):
            export_history(self.source, self.archive)
        import_history(self.archive, self.destination)
        with self.assertRaisesRegex(ValueError, "already exists"):
            import_history(self.archive, self.destination)

    def test_failed_publish_leaves_no_incomplete_backup(self):
        with patch("history_transfer.os.link", side_effect=OSError("no space")):
            with self.assertRaises(OSError):
                export_history(self.source, self.archive)
        self.assertFalse(self.archive.exists())

    def test_late_publish_error_rolls_back_earlier_jobs(self):
        other = self.source / "zzz12345678901234"
        other.mkdir()
        (other / "project.json").write_text('{}')
        export_history(self.source, self.archive)
        original = Path.rename
        def fail_second(path, target):
            if path.name == other.name:
                raise OSError("injected failure")
            return original(path, target)
        with patch.object(Path, "rename", fail_second):
            with self.assertRaises(OSError):
                import_history(self.archive, self.destination)
        self.assertFalse((self.destination / self.job.name).exists())
        self.assertFalse((self.destination / other.name).exists())

    def rewrite_archive(self, mutate):
        export_history(self.source, self.archive)
        with zipfile.ZipFile(self.archive) as zipped:
            contents = {n: zipped.read(n) for n in zipped.namelist()}
        mutate(contents)
        corrupt = self.root / "corrupt.zip"
        with zipfile.ZipFile(corrupt, "w") as zipped:
            for name, data in contents.items():
                zipped.writestr(name, data)
        return corrupt

    def test_tampered_image_rejected_before_any_job_published(self):
        path = f"jobs/{self.job.name}/render.png"
        corrupt = self.rewrite_archive(lambda data: data.update({path: b"bad! picture"}))
        with self.assertRaisesRegex(ValueError, "Checksum"):
            import_history(corrupt, self.destination)
        self.assertFalse((self.destination / self.job.name).exists())

    def test_traversal_entry_rejected(self):
        corrupt = self.rewrite_archive(lambda data: data.update({"../../escape.txt": b"x"}))
        with self.assertRaisesRegex(ValueError, "do not match"):
            import_history(corrupt, self.destination)
        self.assertFalse((self.root / "escape.txt").exists())

    def test_manifest_disallows_non_history_files(self):
        def alter(data):
            manifest = json.loads(data["manifest.json"])
            manifest["files"][0]["path"] = f"jobs/{self.job.name}/auth.json"
            data["manifest.json"] = json.dumps(manifest).encode()
        corrupt = self.rewrite_archive(alter)
        with self.assertRaisesRegex(ValueError, "Unexpected archive path"):
            import_history(corrupt, self.destination)

    def test_case_colliding_identifiers_rejected(self):
        def alter(data):
            manifest = json.loads(data["manifest.json"])
            manifest["jobs"].append(self.job.name.upper())
            data["manifest.json"] = json.dumps(manifest).encode()
        corrupt = self.rewrite_archive(alter)
        with self.assertRaisesRegex(ValueError, "case-insensitive"):
            import_history(corrupt, self.destination)


if __name__ == "__main__":
    unittest.main()
