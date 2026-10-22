"""Real draft persistence, conflict and authenticated HTTP tests; no AI calls."""
import copy
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import hashlib
from http.cookies import SimpleCookie
import http.client
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

from PIL import Image

import editor_auth
import project_store
import render_server as app

PROJECT_ID = "project-test-workspace-0001"


def draft(name="Первый проект", revision=0, with_photo=True):
    return {"base_revision": revision, "name": name,
            "snapshot": {"project": {"version": 1, "image": {"name": "фасад.png", "width_px": 32, "height_px": 24},
                                      "calibration": {"mode": "frontoparallel", "image_points": []},
                                      "placement": {"center_px": None, "width_cm": None, "height_cm": 40},
                                      "sign": {"text": "Неоконченное\nТЗ"}, "generation": {"lighting": "original"}},
                         "photo": app.data_url(Image.new("RGB", (32, 24), "red")) if with_photo else "",
                         "photoKey": "original-photo", "ui": {"signWidth": {"value": "", "checked": False}},
                         "interaction": {"action": "reference", "pending": [[4, 5]]}, "view": {"scale": 2}},
            "generation": None}


def saved_fixture(service, identity, text="Один фасад", status="complete"):
    folder = service.output / identity
    folder.mkdir(parents=True)
    project = draft()["snapshot"]["project"]
    project["sign"]["text"] = text
    project["calibration"] = {"mode": "frontoparallel", "frontoparallel_assumed": True,
                              "image_points": [[2, 2], [22, 2]], "length_cm": 200}
    project["placement"] = {"center_px": [16, 10], "width_cm": 100, "height_cm": 40}
    project["generation"]["edit_polygon_px"] = [[4, 4], [28, 4], [28, 20], [4, 20]]
    (folder / "project.json").write_text(json.dumps(project, ensure_ascii=False), encoding="utf-8")
    Image.new("RGB", (32, 24), "blue").save(folder / "source.png")
    if status == "complete":
        Image.new("RGB", (32, 24), "green").save(folder / "render.png")
        (folder / "audit.json").write_text(json.dumps({"lighting": "original"}), encoding="utf-8")
    else:
        (folder / "job.json").write_text(json.dumps({"status": "failed", "message": "Fixture failure"}), encoding="utf-8")
    return folder


class ProjectPersistence(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.output = Path(self.temp.name) / "jobs"
        self.service = app.Service(self.output, renderer=mock.Mock(side_effect=AssertionError("No AI")),
                                   status_reader=lambda: {"configured": True})

    def tearDown(self):
        self.service.wait_for_workers(5)
        self.temp.cleanup()

    def test_save_reload_original_photo_and_incomplete_ui_atomically(self):
        value = draft()
        original = copy.deepcopy(value)
        result = self.service.save_project(PROJECT_ID, value)
        self.assertEqual(result["revision"], 1)
        self.assertEqual(value, original)
        restarted = app.Service(self.output)
        loaded = restarted.project(PROJECT_ID)
        self.assertEqual(loaded["snapshot"], value["snapshot"])
        self.assertEqual(loaded["generation"], None)
        self.assertEqual(loaded["revision"], 1)
        self.assertEqual(restarted.project_listing()["items"][0]["variant_count"], 0)
        changed = draft("Новый текст", 1)
        changed["snapshot"]["ui"]["signWidth"]["value"] = "abc"
        self.service.save_project(PROJECT_ID, changed)
        loaded = restarted.project(PROJECT_ID)
        self.assertEqual(loaded["snapshot"]["ui"]["signWidth"]["value"], "abc")
        self.assertEqual(loaded["revision"], 2)
        with closing(sqlite3.connect(restarted.projects.path)) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM photos").fetchone()[0], 1)

    def test_missing_photo_is_saved_but_invalid_snapshot_and_photo_are_rejected(self):
        self.service.save_project(PROJECT_ID, draft(with_photo=False))
        self.assertEqual(self.service.project(PROJECT_ID)["snapshot"]["photo"], "")
        for alteration in ({"snapshot": {}}, {"generation": []}, {"base_revision": True}, {"name": "bad\nname"}):
            body = draft(revision=1)
            body.update(alteration)
            with self.subTest(alteration=alteration), self.assertRaises(project_store.ProjectError):
                self.service.save_project(PROJECT_ID, body)
        for photo in ("data:image/png;base64,notbase64", "https://example.test/private.png", "data:image/svg+xml,<svg/>"):
            body = draft(revision=1)
            body["snapshot"]["photo"] = photo
            with self.subTest(photo=photo), self.assertRaises(app.UserError):
                self.service.save_project(PROJECT_ID, body)
        mismatch = draft(revision=1)
        mismatch["snapshot"]["project"]["image"]["width_px"] = 40
        with self.assertRaises(project_store.ProjectError):
            self.service.save_project(PROJECT_ID, mismatch)
        self.assertEqual(self.service.project(PROJECT_ID)["revision"], 1)

    def test_stale_writes_and_concurrent_connections_never_overwrite(self):
        self.service.save_project(PROJECT_ID, draft())
        other = app.Service(self.output)
        barrier = threading.Barrier(2)
        def save(service, name):
            barrier.wait()
            try:
                return service.save_project(PROJECT_ID, draft(name, 1))["revision"]
            except project_store.Conflict as exc:
                return "conflict", exc.revision
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda pair: save(*pair), [(self.service, "ПК 1"), (other, "ПК 2")]))
        self.assertCountEqual(results, [2, ("conflict", 2)])
        with self.assertRaises(project_store.Conflict) as caught:
            self.service.save_project(PROJECT_ID, draft("Перезапись", 0))
        self.assertEqual(caught.exception.revision, 2)
        self.assertIn(self.service.project(PROJECT_ID)["name"], {"ПК 1", "ПК 2"})

    def test_separate_process_reads_and_writes_committed_state(self):
        self.service.save_project(PROJECT_ID, draft())
        script = "import sys,json;from project_store import Store;s=Store(sys.argv[1],lambda value:None);b=json.loads(sys.stdin.read());print(s.save(sys.argv[2],b)['revision'])"
        result = subprocess.run([sys.executable, "-c", script, str(self.service.projects.root), PROJECT_ID],
                                input=json.dumps(draft("Другой процесс", 1, with_photo=False)),
                                text=True, capture_output=True, cwd=Path(__file__).parent, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "2")
        self.assertEqual(self.service.project(PROJECT_ID)["name"], "Другой процесс")
        with self.assertRaises(project_store.Conflict):
            self.service.save_project(PROJECT_ID, draft(revision=1))

    def test_legacy_virtual_records_and_explicit_merge_preserve_every_job_byte(self):
        ids = ["legacy-test-job-0001", "legacy-test-job-0002", "legacy-test-job-0003"]
        for identity in ids:
            saved_fixture(self.service, identity)
        hashes = {str(path.relative_to(self.output)): hashlib.sha256(path.read_bytes()).hexdigest()
                  for path in self.output.rglob("*") if path.is_file()}
        self.assertEqual(self.service.project_listing()["total"], 3)  # same photo/text is never guessed into a group
        self.assertFalse(self.service.projects.path.exists())
        target_id = "legacy-" + ids[0]
        seeded = self.service.project(target_id)
        self.assertEqual(seeded["generation"]["jobId"], ids[0])
        self.assertEqual(seeded["snapshot"]["photoKey"], "job-" + ids[0])
        result = self.service.merge_projects({"project_ids": [target_id, "legacy-" + ids[1]], "target_id": target_id})
        self.assertEqual(result["revision"], 1)
        reloaded = app.Service(self.output)
        self.assertEqual(reloaded.project("legacy-" + ids[1])["id"], target_id)
        self.assertEqual(reloaded.project(target_id)["snapshot"], seeded["snapshot"])
        listing = reloaded.project_listing()
        self.assertEqual(listing["total"], 2)
        group = next(item for item in listing["items"] if item["id"] == target_id)
        self.assertEqual(group["variant_count"], 2)
        self.assertCountEqual([item["id"] for item in reloaded.history(project_id=target_id)["items"]], ids[:2])
        after = {str(path.relative_to(self.output)): hashlib.sha256(path.read_bytes()).hexdigest()
                 for path in self.output.rglob("*") if path.is_file()}
        self.assertEqual(hashes, after)
        with self.assertRaises(project_store.Conflict):
            reloaded.save_project("legacy-" + ids[1], draft())

    def test_saved_target_draft_wins_merge_and_old_revision_conflicts(self):
        self.service.save_project(PROJECT_ID, draft("Продолжать этот"))
        legacy_job = "legacy-test-job-0001"
        saved_fixture(self.service, legacy_job)
        before = self.service.project(PROJECT_ID)
        self.service.merge_projects({"project_ids": [PROJECT_ID, "legacy-" + legacy_job], "target_id": PROJECT_ID})
        after = self.service.project(PROJECT_ID)
        self.assertEqual(after["snapshot"], before["snapshot"])
        self.assertEqual(after["name"], before["name"])
        self.assertEqual(after["revision"], 2)
        with self.assertRaises(project_store.Conflict):
            self.service.save_project(PROJECT_ID, draft(revision=1))

    def test_id_paths_json_and_cross_project_references_are_rejected(self):
        for identity in ("../project-123456789", "x" * 97, "legacy-../../../bad", "valid-project-0001\n", "Проект-000000000000", None):
            with self.subTest(identity=identity), self.assertRaises(project_store.ProjectError):
                self.service.save_project(identity, draft())
        bad = draft()
        bad["snapshot"]["view"]["scale"] = float("nan")
        with self.assertRaises(project_store.ProjectError):
            self.service.save_project(PROJECT_ID, bad)
        self.service.save_project(PROJECT_ID, draft())
        identity = "legacy-test-job-0001"
        saved_fixture(self.service, identity)
        bad = draft(revision=1)
        bad["generation"] = {"jobId": identity}
        with self.assertRaises(project_store.ProjectError):
            self.service.save_project(PROJECT_ID, bad)
        self.assertEqual(self.service.project(PROJECT_ID)["revision"], 1)

    def test_submission_persists_group_linkage_and_rejects_unrelated_source(self):
        self.service.save_project(PROJECT_ID, draft())
        source = "legacy-test-job-0001"
        saved_fixture(self.service, source)
        self.service.merge_projects({"project_ids": [PROJECT_ID, "legacy-" + source], "target_id": PROJECT_ID})
        body = {"request_id": "linked-test-job-0001", "project_id": PROJECT_ID, "source_job_id": source}
        prepared = (None, self.service.read_saved(source, "project.json"), None, "original", None, None)
        def fake_run(identity, prepared):
            saved_fixture(self.service, identity)
        with mock.patch.object(app, "prepare", return_value=prepared), mock.patch.object(self.service, "run", side_effect=fake_run):
            result = self.service.submit(body)
            self.service.wait_for_workers(5)
        self.assertEqual(result["project_id"], PROJECT_ID)
        restarted = app.Service(self.output)
        self.assertEqual(restarted.public(body["request_id"])["project_id"], PROJECT_ID)
        self.assertEqual(restarted.history(project_id=PROJECT_ID)["total"], 2)
        foreign = "legacy-test-job-0002"
        saved_fixture(self.service, foreign)
        self.service.jobs.clear()
        with mock.patch.object(app, "prepare", return_value=prepared), self.assertRaises(app.UserError):
            self.service.submit({"request_id": "linked-test-job-0002", "project_id": PROJECT_ID, "source_job_id": foreign})
        self.assertFalse((self.output / "linked-test-job-0002").exists())

    def test_sqlite_backup_includes_current_drafts_and_membership(self):
        self.service.save_project(PROJECT_ID, draft())
        backup = Path(self.temp.name) / "backup.sqlite3"
        with closing(sqlite3.connect(self.service.projects.path)) as source, closing(sqlite3.connect(backup)) as target:
            source.backup(target)
        with closing(sqlite3.connect(backup)) as connection:
            self.assertEqual(connection.execute("SELECT revision FROM projects WHERE id=?", (PROJECT_ID,)).fetchone()[0], 1)
            self.assertEqual(connection.execute("SELECT count(*) FROM photos").fetchone()[0], 1)

    def test_two_stage_manufacturing_snapshot_survives_project_draft_edits_and_restore(self):
        from test_letter_objects import independent_payload

        body = independent_payload(engine="codex_two_stage")
        body.update(request_id="linked-two-stage-test-0001", project_id=PROJECT_ID)
        initial = draft()
        initial["snapshot"].update(project=copy.deepcopy(body["project"]), photo=body["photo"])
        self.service.save_project(PROJECT_ID, initial)

        def render(folder, prompt, canvas, guide, *, transparent_background=False, **kwargs):
            with Image.open(canvas) as image:
                return image.convert("RGBA" if transparent_background else "RGB")

        self.service.renderer = mock.Mock(side_effect=render)
        self.service.submit(body)
        self.assertTrue(self.service.wait_for_workers(10))
        identity = body["request_id"]
        completed = self.service.public(identity)
        self.assertEqual(completed["status"], "complete", completed)
        self.assertEqual(self.service.renderer.call_count, 2)
        folder = self.output / identity
        frozen = {name: (folder / name).read_bytes()
                  for name in ("input-project.json", "project.json", "production-spec.json",
                               "product-neutral.png", "layout-guide.png")}
        self.assertEqual(json.loads(frozen["input-project.json"]), body["project"])

        changed = copy.deepcopy(initial)
        changed["base_revision"] = 1
        changed["snapshot"]["project"]["products"][0]["params"]["objects"][0].update(
            letter_height_cm=35, depth_cm=8)
        changed["generation"] = {"version": 1, "jobId": identity, "view": "product"}
        self.service.save_project(PROJECT_ID, changed)
        restarted = app.Service(self.output)
        restored = restarted.public(identity)
        self.assertEqual(restored["project_id"], PROJECT_ID)
        self.assertEqual(restored["engine"], "codex_two_stage")
        self.assertEqual(restored["status"], "complete")
        for flag in ("has_product_neutral", "has_layout_guide", "has_production_spec"):
            self.assertTrue(restored[flag])
        current = restarted.project(PROJECT_ID)
        self.assertEqual(current["revision"], 2)
        self.assertEqual(current["snapshot"], changed["snapshot"])
        self.assertEqual(current["generation"]["jobId"], identity)
        saved = restarted.read_saved(identity, "project.json")
        self.assertEqual(saved["products"][0]["params"]["objects"],
                         body["project"]["products"][0]["params"]["objects"])
        spec = restarted.read_saved(identity, "production-spec.json")
        self.assertEqual(spec["source"]["job_id"], identity)
        self.assertEqual(spec["source"]["project_sha256"], hashlib.sha256(frozen["project.json"]).hexdigest())
        self.assertEqual(spec["source"]["received_input_sha256"], hashlib.sha256(frozen["input-project.json"]).hexdigest())
        self.assertEqual(restarted.history(project_id=PROJECT_ID)["items"][0]["id"], identity)
        for name, original in frozen.items():
            self.assertEqual((folder / name).read_bytes(), original, name)


class ProjectsHTTP(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.auth_config = editor_auth.make_config("project-test-password", cookie_path="/signs/")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        auth_file = Path(self.temp.name) / "auth.json"
        auth_file.write_text(json.dumps(self.auth_config), encoding="utf-8")
        self.server = app.create_server(0, Path(self.temp.name) / "jobs", public_origin="https://example.test",
                                        auth_file=auth_file, status_reader=lambda: {"configured": False},
                                        renderer=mock.Mock(side_effect=AssertionError("No AI")))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        cookie = SimpleCookie(self.server.auth.session_cookie())[editor_auth.COOKIE_NAME]
        self.headers = {"Cookie": editor_auth.COOKIE_NAME + "=" + cookie.value, "X-Editor-Token": self.server.service.token}

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, path, body=None, headers=None, authorized=True):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        all_headers = {"Host": "example.test", **(self.headers if authorized else {}), **(headers or {})}
        if body is not None:
            all_headers.setdefault("Origin", "https://example.test")
            all_headers.setdefault("Content-Type", "application/json")
        connection.request("POST" if body is not None else "GET", path, json.dumps(body) if body is not None else None, all_headers)
        response = connection.getresponse()
        status, response_headers, raw = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return status, response_headers, json.loads(raw)

    def test_http_drafts_revisions_pagination_and_no_generation(self):
        path = "/api/projects/" + PROJECT_ID
        self.assertEqual(self.request(path, draft())[0], 201)
        self.assertEqual(self.request(path)[2]["snapshot"], draft()["snapshot"])
        self.assertEqual(self.request(path, draft("С другого ПК", 1))[0], 200)
        status, _, error = self.request(path, draft("Старая правка", 1))
        self.assertEqual(status, 409)
        self.assertEqual(error["revision"], 2)
        listing = self.request("/api/projects?limit=1&offset=0&q=" + app.quote("Другого"))[2]
        self.assertEqual(listing["total"], 1)
        self.assertEqual(listing["items"][0]["variant_count"], 0)
        self.assertEqual(self.request(path + "/jobs")[2]["total"], 0)
        self.assertEqual(self.request("/api/projects?offset=bad")[0], 400)
        self.assertEqual(self.request("/api/projects/missing-project-0000")[0], 404)
        self.server.service.renderer.assert_not_called()

    def test_auth_cookie_origin_host_and_editor_token_protect_all_routes(self):
        for path, body in (("/api/projects", None), ("/api/projects/" + PROJECT_ID, None),
                           ("/api/projects/" + PROJECT_ID, draft()), ("/api/projects/merge", {})):
            with self.subTest(path=path, body=body):
                self.assertEqual(self.request(path, body, authorized=False)[0], 401)
                self.assertEqual(self.request(path, body, {"X-Editor-Token": "wrong"})[0], 403)
                self.assertEqual(self.request(path, body, {"Host": "evil.test"})[0], 403)
        self.assertEqual(self.request("/api/projects/" + PROJECT_ID, draft(), {"Origin": "https://evil.test"})[0], 403)
        self.assertFalse(self.server.service.projects.path.exists())

    def test_http_legacy_merge_and_login_deep_links(self):
        ids = ["legacy-test-job-0001", "legacy-test-job-0002"]
        for identity in ids:
            saved_fixture(self.server.service, identity)
        projects = ["legacy-" + identity for identity in ids]
        self.assertEqual(self.request("/api/projects")[2]["total"], 2)
        self.assertEqual(self.request("/api/projects/merge", {"project_ids": projects, "target_id": projects[0]})[0], 200)
        self.assertEqual(self.request("/api/projects")[2]["total"], 1)
        self.assertEqual(self.request("/api/projects/" + projects[0] + "/jobs")[2]["total"], 2)
        for query in ("restoreProject=" + projects[0], "restoreJob=" + ids[0], "newProject=1"):
            status, headers, _ = self.request("/calibrator.html?" + query, authorized=False)
            self.assertEqual(status, 303)
            self.assertEqual(headers["Location"], "/signs/login.html?next=" + app.quote("calibrator.html?" + query, safe=""))


if __name__ == "__main__":
    unittest.main()
