"""Password/session and real HTTP access checks; never calls Codex or imagegen."""
import copy
from http.cookies import SimpleCookie
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

import editor_auth
import render_server


class SessionAuthentication(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = editor_auth.make_config("test-secret", cookie_path="/signs/")

    def setUp(self):
        self.auth = editor_auth.PasswordAuth(copy.deepcopy(self.config))

    def test_password_hash_and_rate_window(self):
        self.assertNotIn("test-secret", json.dumps(self.config))
        self.assertEqual(self.auth.authenticate("test-secret", now=100), (True, 0))
        for _ in range(5):
            self.assertEqual(self.auth.authenticate("incorrect", now=100), (False, 0))
        self.assertEqual(self.auth.authenticate("test-secret", now=100), (False, 61))
        self.assertEqual(self.auth.authenticate("test-secret", now=160), (True, 0))

    def test_session_security_flags_expiry_tampering_and_password_change(self):
        header = self.auth.session_cookie(now=100)
        cookie = SimpleCookie(header)[editor_auth.COOKIE_NAME]
        self.assertTrue(cookie["secure"])
        self.assertTrue(cookie["httponly"])
        self.assertEqual(cookie["samesite"], "Strict")
        self.assertEqual(cookie["path"], "/signs/")
        self.assertEqual(cookie["max-age"], "43200")
        self.assertFalse(cookie["domain"])
        value = editor_auth.COOKIE_NAME + "=" + cookie.value
        self.assertTrue(self.auth.authorized(value, now=101))
        self.assertFalse(self.auth.authorized(value, now=43300))
        modified = value[:-1] + ("0" if value[-1] != "0" else "1")
        self.assertFalse(self.auth.authorized(modified, now=101))
        self.assertFalse(self.auth.authorized(value.replace("43300.", "99999."), now=101))
        changed = copy.deepcopy(self.config)
        changed["password"]["hash_hex"] = "00" * 32
        self.assertFalse(editor_auth.PasswordAuth(changed).authorized(value, now=101))
        changed = copy.deepcopy(self.config)
        changed["cookie_path"] = "/other/"
        self.assertFalse(editor_auth.PasswordAuth(changed).authorized(value, now=101))
        self.assertFalse(self.auth.authorized(self.auth.clear_cookie(), now=101))

    def test_restart_retains_session_and_malformed_config_fails_closed(self):
        cookie = self.auth.session_cookie(now=100)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "auth.json"
            path.write_text(json.dumps(self.config), encoding="utf-8")
            restored = editor_auth.PasswordAuth.from_file(path)
            self.assertTrue(restored.authorized(cookie, now=101))
            path.write_text("not JSON", encoding="utf-8")
            with self.assertRaises(ValueError):
                editor_auth.PasswordAuth.from_file(path)
            with self.assertRaises(ValueError):
                editor_auth.PasswordAuth.from_file(Path(folder) / "missing")
        with self.assertRaises(ValueError):
            editor_auth.PasswordAuth.from_file("relative-auth.json")
        for key, value in (("cookie_path", "/signs/; Domain=example.com"),
                           ("cookie_path", "//"), ("session_ttl_seconds", 0),
                           ("session_secret_hex", "bad")):
            invalid = copy.deepcopy(self.config)
            invalid[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                editor_auth.PasswordAuth(invalid)

    def test_secret_file_create_is_exclusive_and_cli_rejects_password_mismatch(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "auth.json"
            editor_auth.save_config_exclusive(self.config, path)
            original = path.read_bytes()
            with self.assertRaises(FileExistsError):
                editor_auth.save_config_exclusive(self.config, path)
            self.assertEqual(path.read_bytes(), original)
            with self.assertRaises(ValueError):
                editor_auth.save_config_exclusive(self.config, "relative.json")
            other = Path(folder) / "new.json"
            with mock.patch("editor_auth.getpass.getpass", side_effect=["a", "b"]), self.assertRaises(SystemExit):
                editor_auth.main(["create", "--output", str(other), "--cookie-path", "/signs/"])
            self.assertFalse(other.exists())
            with mock.patch("editor_auth.getpass.getpass") as prompt, self.assertRaises(SystemExit):
                editor_auth.main(["create", "--output", str(path)])
            prompt.assert_not_called()


class AuthenticationHTTP(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = editor_auth.make_config("another-secret", cookie_path="/signs/")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name)
        self.auth_file = self.path / "auth.json"
        self.auth_file.write_text(json.dumps(self.config), encoding="utf-8")
        self.server = render_server.create_server(
            0, self.path / "jobs", public_origin="https://example.test", auth_file=self.auth_file,
            status_reader=lambda: {"configured": True, "provider": "test", "connection_message": "test"})
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, method, path, payload=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        all_headers = {"Host": "example.test", **(headers or {})}
        body = None if payload is None else json.dumps(payload)
        if body is not None:
            all_headers.setdefault("Content-Type", "application/json")
        connection.request(method, path, body, all_headers)
        response = connection.getresponse()
        status, response_headers, raw = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return status, response_headers, raw

    def sign_in(self):
        code, headers, body = self.request("POST", "/auth/login", {"password": "another-secret"},
                                           {"Origin": "https://example.test"})
        self.assertEqual(code, 200, body)
        cookie = SimpleCookie(headers["Set-Cookie"])[editor_auth.COOKIE_NAME]
        return editor_auth.COOKIE_NAME + "=" + cookie.value

    def test_unauthenticated_assets_api_artifacts_and_health(self):
        for path in ("/", "/calibrator.html", "/history.html", "/generation.js",
                     "/interface.js", "/interface-help.js", "/interface.css", "/catalog.js", "/product-catalog.json"):
            code, headers, body = self.request("GET", path)
            self.assertEqual(code, 303, path)
            expected = "history.html" if path == "/history.html" else "calibrator.html"
            self.assertEqual(headers["Location"], "/signs/login.html?next=" + expected)
            self.assertNotIn("token", json.loads(body))
        for path in ("/api/config", "/api/history", "/api/jobs/saved-image-123456/render.png"):
            code, _, body = self.request("GET", path, headers={"X-Editor-Token": self.server.service.token})
            self.assertEqual(code, 401, path)
            self.assertTrue(json.loads(body)["auth_required"])
        for path in ("/login.html", "/login.css", "/login.js", "/healthz"):
            self.assertEqual(self.request("GET", path)[0], 200, path)
        self.assertEqual(json.loads(self.request("GET", "/healthz")[2]), {"status": "ok"})
        code, _, _ = self.request("POST", "/api/jobs", {},
                                   {"Origin": "https://example.test", "X-Editor-Token": self.server.service.token})
        self.assertEqual(code, 401)

    def test_interface_assets_keep_auth_mime_and_existing_csp(self):
        headers = {"Cookie": self.sign_in()}
        for path, mime in (("/interface.js", "text/javascript; charset=utf-8"),
                           ("/interface-help.js", "text/javascript; charset=utf-8"),
                           ("/interface.css", "text/css; charset=utf-8")):
            code, response_headers, body = self.request("GET", path, headers=headers)
            self.assertEqual(code, 200, path)
            self.assertEqual(response_headers["Content-Type"], mime)
            self.assertEqual(body, (render_server.ASSETS / path[1:]).read_bytes())
            self.assertIn("script-src 'self'", response_headers["Content-Security-Policy"])
            self.assertNotIn("unsafe-eval", response_headers["Content-Security-Policy"])
            self.assertEqual(response_headers["X-Content-Type-Options"], "nosniff")

    def test_catalog_bootstrap_and_json_share_authenticated_source(self):
        headers = {"Cookie": self.sign_in()}
        code, response_headers, raw = self.request("GET", "/catalog.js", headers=headers)
        self.assertEqual(code, 200)
        self.assertEqual(response_headers["Content-Type"], "text/javascript; charset=utf-8")
        prefix = "window.SignageCatalog = "
        text = raw.decode("utf-8")
        self.assertTrue(text.startswith(prefix))
        self.assertEqual(json.loads(text[len(prefix):].strip().rstrip(";")), render_server.product_catalog.public_catalog())
        code, _, source = self.request("GET", "/product-catalog.json", headers=headers)
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(source), json.loads((render_server.ASSETS / "product-catalog.json").read_text(encoding="utf-8")))

    def test_login_redirect_keeps_only_allowlisted_deep_links(self):
        for path in ("/", "/calibrator.html"):
            code, headers, _ = self.request("GET", path + "?restoreJob=saved-project-123456")
            self.assertEqual(code, 303)
            self.assertEqual(headers["Location"],
                             "/signs/login.html?next=calibrator.html%3FrestoreJob%3Dsaved-project-123456")
        for query in ("restoreJob=//attacker.test/", "next=https://attacker.test/", "restoreJob=too-short",
                      "restoreJob=saved-project-123456&restoreJob=saved-project-123456"):
            _, headers, _ = self.request("GET", "/calibrator.html?" + query)
            self.assertEqual(headers["Location"], "/signs/login.html?next=calibrator.html")
        _, headers, _ = self.request("GET", "/history.html?next=https://attacker.test/")
        self.assertEqual(headers["Location"], "/signs/login.html?next=history.html")

    def test_handoff_downloads_require_login_then_stream_exact_private_files(self):
        for path in ("/downloads.html", "/downloads/signage-editor-handoff.zip",
                     "/downloads/history-handoff-20261008.zip", "/downloads/SHA256SUMS-handoff.txt"):
            code, headers, _ = self.request("GET", path)
            self.assertEqual(code, 303)
            self.assertEqual(headers["Location"], "/signs/login.html?next=downloads.html")
        headers = {"Cookie": self.sign_in()}
        code, _, body = self.request("GET", "/downloads.html", headers=headers)
        self.assertEqual(code, 200)
        self.assertIn(b'href="downloads/signage-editor-handoff.zip"', body)
        folder = self.path / "handoff"
        folder.mkdir()
        for name, mime in render_server.HANDOFF_FILES.items():
            raw = (b"zip-test-chunk\x00" * 170000) if name.endswith(".zip") else b"hash  sample.zip\n"
            (folder / name).write_bytes(raw)
            # Downloads must use bounded reads, not Path.read_bytes on the whole history archive.
            with mock.patch.object(Path, "read_bytes", side_effect=AssertionError("Unbounded read")):
                code, result_headers, body = self.request("GET", "/downloads/" + name, headers=headers)
            self.assertEqual(code, 200)
            self.assertEqual(body, raw)
            self.assertEqual(result_headers["Content-Length"], str(len(raw)))
            self.assertEqual(result_headers["Content-Type"], mime)
            self.assertEqual(result_headers["Content-Disposition"], f'attachment; filename="{name}"')
            self.assertEqual(result_headers["Cache-Control"], "no-store")
            self.assertEqual(result_headers["X-Content-Type-Options"], "nosniff")

    def test_handoff_downloads_reject_unknown_missing_and_non_regular_paths(self):
        headers = {"Cookie": self.sign_in()}
        folder = self.path / "handoff"
        folder.mkdir()
        for path in ("/downloads/", "/downloads/auth.json", "/downloads/../auth.json",
                     "/downloads/%2e%2e/auth.json", "/downloads/signage-editor-handoff.zip/extra",
                     "/downloads/signage-editor-handoff.zip%00", "/downloads/..\\auth.json",
                     "/downloads/signage-editor-handoff.zip"):
            self.assertEqual(self.request("GET", path, headers=headers)[0], 404, path)
        (folder / "signage-editor-handoff.zip").mkdir()
        self.assertEqual(self.request("GET", "/downloads/signage-editor-handoff.zip", headers=headers)[0], 404)

    def test_handoff_downloads_reject_directory_and_file_symlinks(self):
        headers = {"Cookie": self.sign_in()}
        folder = self.path / "handoff"
        folder.mkdir()
        archive = folder / "signage-editor-handoff.zip"
        archive.write_bytes(b"private test")
        for forbidden in (folder, archive):
            with mock.patch.object(Path, "is_symlink", autospec=True, side_effect=lambda path: path == forbidden):
                self.assertEqual(self.request("GET", "/downloads/signage-editor-handoff.zip", headers=headers)[0], 404)
        archive.unlink()
        try:
            archive.symlink_to(self.auth_file)
        except OSError:
            return  # Windows may forbid symlink creation; both refusal branches are checked above.
        self.assertEqual(self.request("GET", "/downloads/signage-editor-handoff.zip", headers=headers)[0], 404)

    def test_public_handoff_downloads_fail_closed_without_cookie_auth_configuration(self):
        self.server.auth = None
        self.assertTrue(self.server.public_mode)
        for path in ("/downloads.html", "/downloads/signage-editor-handoff.zip"):
            self.assertEqual(self.request("GET", path,
                                          headers={"X-Editor-Token": self.server.service.token})[0], 403)

    def test_cookie_access_preserves_csrf_requirements_and_logout(self):
        cookie = self.sign_in()
        headers = {"Cookie": cookie}
        code, _, raw = self.request("GET", "/api/config", headers=headers)
        self.assertEqual(code, 200)
        token = json.loads(raw)["token"]
        self.assertEqual(self.request("GET", "/history.html", headers=headers)[0], 200)
        self.assertEqual(self.request("GET", "/api/history", headers=headers)[0], 403)
        headers["X-Editor-Token"] = token
        self.assertEqual(self.request("GET", "/api/history", headers=headers)[0], 200)
        self.assertEqual(self.request("POST", "/api/jobs", {}, headers)[0], 403)
        headers["Origin"] = "https://example.test"
        # Valid auth reaches normal validation; it does not start generation.
        self.assertEqual(self.request("POST", "/api/jobs", {}, headers)[0], 400)
        code, result_headers, _ = self.request("POST", "/auth/logout", {}, headers)
        self.assertEqual(code, 200)
        self.assertEqual(SimpleCookie(result_headers["Set-Cookie"])[editor_auth.COOKIE_NAME]["max-age"], "0")

    def test_login_origin_wrong_password_and_body_limits(self):
        payload = {"password": "another-secret"}
        self.assertEqual(self.request("POST", "/auth/login", payload)[0], 403)
        self.assertEqual(self.request("POST", "/auth/login", payload, {"Origin": "https://attacker.test"})[0], 403)
        self.assertEqual(self.request("POST", "/auth/login", payload,
                                      {"Host": "attacker.test", "Origin": "https://example.test"})[0], 403)
        headers = {"Origin": "https://example.test"}
        self.assertEqual(self.request("POST", "/auth/login", {"password": "bad"}, headers)[0], 401)
        self.assertEqual(self.request("POST", "/auth/login", {"password": "x" * 5000}, headers)[0], 413)
        self.assertEqual(self.request("POST", "/auth/login", payload,
                                      {**headers, "Content-Type": "text/plain"})[0], 415)
        self.sign_in()

    def test_optional_auth_and_invalid_configuration(self):
        server = render_server.create_server(0, self.path / "other", status_reader=lambda: {})
        self.assertIsNone(server.auth)
        server.server_close()
        with self.assertRaises(ValueError):
            render_server.create_server(0, self.path / "other", auth_file=self.auth_file)
        with self.assertRaises(ValueError):
            render_server.create_server(0, self.path / "other", public_origin="https://example.test",
                                         auth_file=self.path / "missing")


if __name__ == "__main__":
    unittest.main()
