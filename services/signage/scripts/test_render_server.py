"""No Codex/AI calls: adversarial image fixtures + real local HTTP and geometry engine."""
import copy
import http.client
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest import mock
from urllib import error, request

import numpy as np
from PIL import Image

import render_server as app


def photo():
    y, x = np.mgrid[:240, :320]
    return Image.fromarray(np.stack((x % 256, y, (x + y) % 256), axis=-1).astype("uint8"))


def payload(mode="night"):
    return {"request_id": "test-signage-job-0001", "photo": app.data_url(photo()), "project": {
        "version": 1, "image": {"name": "test.png", "width_px": 320, "height_px": 240},
        "calibration": {"mode": "frontoparallel", "frontoparallel_assumed": True,
                        "image_points": [[20, 20], [220, 20]], "length_cm": 200},
        "placement": {"center_px": [160, 100], "width_cm": 100, "height_cm": 40, "rotation_deg": 0},
        "sign": {"text": "ЦВЕТЫ", "font_family": "Arial", "depth_cm": 5, "brief": "Тёплый контражур"},
        "target_polygon_px": [[80, 55], [240, 55], [240, 150], [80, 150]],
        "generation": {"lighting": mode, "edit_polygon_px": [[70, 45], [250, 45], [250, 160], [70, 160]]}}}


def film_profile(**changes):
    return {"type": "film_on_acrylic", "brand": "ORACAL", "series": "8500", "color_code": "031",
            "finish": "unspecified", "acrylic": "unspecified", "led_temperature_k": None,
            "day_lighting": "off", **changes}


class FaceMaterials(unittest.TestCase):
    def prompt(self, mode="night", profile=None):
        body = payload(mode)
        sign = body["project"]["sign"]
        sign.update(front_color="#FF2030", side_color="#081020", material="OLD PAINTED METAL",
                    lighting="OLD 3000K HALO", brief="Bright red letters; old brief suggests halo")
        if profile is not None:
            sign["face_material"] = profile
        _, project, report, _, quad, _ = app.prepare(body)
        prompt = app.make_prompt(project, report, mode, quad, (320, 240), 1)
        return prompt, json.loads(prompt.rsplit("\n", 1)[-1])

    def test_film_night_uses_transmitted_front_and_overrides_legacy_material(self):
        prompt, spec = self.prompt(profile=film_profile())
        self.assertIn("Internal face illumination MUST BE ON", prompt)
        self.assertIn("light passes from LEDs inside the body through the acrylic", prompt)
        self.assertIn("non-emissive", prompt)
        self.assertIn("NOT a separate thick/extruded letter", prompt)
        self.assertIn("ARTISTIC ASSUMPTION", prompt)
        self.assertIn("structured face_material profile", prompt)
        self.assertNotIn("OLD PAINTED METAL", prompt)
        self.assertNotIn("OLD 3000K HALO", prompt)
        self.assertNotIn("3000K", prompt)
        self.assertNotIn("lighting_spec", spec)
        self.assertNotIn("material", spec)
        self.assertTrue(spec["sign_lighting_on"])
        self.assertEqual(spec["face_material"]["color_code"], "031")
        self.assertEqual(spec["front_color"], "#FF2030")
        self.assertEqual(spec["side_color"], "#081020")
        self.assertTrue(any("Neutral white" in item for item in spec["material_assumptions"]))

    def test_daytime_off_on_and_requested_temperature_are_independent(self):
        off, off_spec = self.prompt("sunny", film_profile())
        self.assertIn("Internal LEDs are OFF", off)
        self.assertFalse(off_spec["sign_lighting_on"])
        self.assertFalse(any("Neutral white" in item for item in off_spec["material_assumptions"]))
        on, on_spec = self.prompt("cloudy", film_profile(day_lighting="on", led_temperature_k=6500,
                                                        finish="satin", acrylic="opal"))
        self.assertIn("MUST BE ON", on)
        self.assertIn("6500 K", on)
        self.assertTrue(on_spec["sign_lighting_on"])
        self.assertEqual(on_spec["face_material"]["finish"], "satin")
        self.assertEqual(on_spec["face_material"]["acrylic"], "opal")
        self.assertFalse(any("unspecified" in item for item in on_spec["material_assumptions"]))

    def test_legacy_missing_profile_remains_custom_with_existing_lighting(self):
        prompt, spec = self.prompt()
        self.assertEqual(spec["face_material"], {"type": "custom"})
        self.assertEqual(spec["material"], "OLD PAINTED METAL")
        self.assertEqual(spec["lighting_spec"], "OLD 3000K HALO")
        self.assertIn("otherwise use warm 3000K halo", prompt)
        self.assertNotIn("thin ORACAL adhesive vinyl", prompt)
        _, explicit = self.prompt(profile={"type": "custom"})
        self.assertEqual(explicit["material"], spec["material"])

    def test_profile_and_hex_validation_preserves_codes_and_input(self):
        raw = {"face_material": film_profile(series="008500", color_code="0031"),
               "front_color": "#abcdef", "side_color": "#001122"}
        saved = copy.deepcopy(raw)
        profile = app.face_material(raw)
        self.assertEqual(profile["series"], "008500")
        self.assertEqual(profile["color_code"], "0031")
        self.assertEqual(app.sign_colors(raw), {"front_color": "#abcdef", "side_color": "#001122"})
        self.assertEqual(raw, saved)
        self.assertEqual(app.sign_colors({}), app.DEFAULT_COLORS)
        for bad in ("red", "#123", "#00ggff", None, 123, "#ff0000\n"):
            with self.subTest(color=bad), self.assertRaises(app.UserError):
                app.sign_colors({"front_color": bad})
        invalid = ["film", {"type": []}, film_profile(brand="Different"), film_profile(series=8500),
                   film_profile(color_code=31), film_profile(series="x" * 81), film_profile(color_code="03\n1"),
                   film_profile(finish="mirror"), film_profile(acrylic="steel"), film_profile(day_lighting="maybe"),
                   film_profile(led_temperature_k=True), film_profile(led_temperature_k="6500"),
                   film_profile(led_temperature_k=float("nan")), film_profile(led_temperature_k=999),
                   film_profile(led_temperature_k=20001)]
        for bad in invalid:
            with self.subTest(profile=bad), self.assertRaises(app.UserError):
                app.face_material({"face_material": bad})
        for temperature in (1000, 20000, None):
            self.assertEqual(app.face_material({"face_material": film_profile(led_temperature_k=temperature)})["led_temperature_k"], temperature)
        bad_body = payload()
        bad_body["project"]["sign"]["face_material"] = film_profile(color_code=31)
        with self.assertRaises(app.UserError):
            app.prepare(bad_body)

    def test_color_card_swatches_are_exact_and_separate(self):
        sign = {"face_material": film_profile(), "front_color": "#FF2030", "side_color": "#081020"}
        card = app.color_reference(sign)
        self.assertEqual(card.mode, "RGB")
        self.assertEqual(card.size, (720, 420))
        self.assertEqual(card.getpixel((0, 0)), (242, 242, 242))
        pixels = np.array(card)
        for field, color in (("front_color", [255, 32, 48]), ("side_color", [8, 16, 32])):
            left, top, right, bottom = app.COLOR_SWATCHES[field]
            np.testing.assert_array_equal(pixels[top:bottom+1, left:right+1], np.broadcast_to(color, (bottom-top+1, right-left+1, 3)))


class GeometryProtection(unittest.TestCase):
    def test_all_lighting_modes_are_pointwise_and_leave_source_intact(self):
        source = photo()
        original = np.array(source)
        permutation = np.arange(original.shape[0] * original.shape[1])[::-1]
        shuffled = Image.fromarray(original.reshape(-1, 3)[permutation].reshape(original.shape))
        for mode in app.MODES:
            changed = app.relight(source, mode)
            shuffled_changed = app.relight(shuffled, mode)
            self.assertEqual(changed.size, source.size)
            np.testing.assert_array_equal(np.array(changed).reshape(-1, 3)[permutation], np.array(shuffled_changed).reshape(-1, 3))
        np.testing.assert_array_equal(original, np.array(source))
        self.assertLess(np.array(app.relight(source, "night")).mean(), original.mean() * .4)
        np.testing.assert_array_equal(np.array(app.relight(source, "original")), original)

    def test_adversarial_ai_cannot_redraw_protected_background(self):
        for mode in app.MODES:
            source, project, report, lighting, quad, mask = app.prepare(payload(mode))
            base = app.relight(source, lighting)
            canvas, api_mask, guide, work, scale = app.model_inputs(base, mask, report, quad)
            self.assertEqual(canvas.size, api_mask.size)
            self.assertEqual(canvas.width % 16, 0)
            self.assertGreaterEqual(canvas.width * canvas.height, 655_360)
            self.assertEqual(api_mask.getpixel((0, 0))[3], 255)
            self.assertEqual(api_mask.getpixel((160, 100))[3], 0)
            hostile = Image.new("RGB", canvas.size, (255, 0, 255))
            result, audit = app.compose(base, hostile, mask, work, canvas.size)
            self.assertEqual(result.size, source.size)
            self.assertEqual(audit["changed_pixels_outside_edit_zone"], 0)
            self.assertEqual(audit["protected_base_sha256"], audit["protected_result_sha256"])
            self.assertEqual(result.getpixel((160, 100)), (255, 0, 255))
            np.testing.assert_array_equal(np.array(base)[np.array(mask) == 0], np.array(result)[np.array(mask) == 0])
            prompt = app.make_prompt(project, report, lighting, quad, canvas.size, scale)
            self.assertIn("MANDATORY GEOMETRY LOCK", prompt)
            self.assertIn("ЦВЕТЫ", prompt)
            if lighting == "night":
                self.assertIn("MUST BE ON", prompt)

    def test_wrong_canvas_rejected(self):
        with self.assertRaises(app.UserError):
            app.compose(photo(), Image.new("RGB", (100, 100)), Image.new("L", (320, 240)), (320, 240), (320, 240))

    def test_multiline_prompt_and_guide_preserve_rows(self):
        body = payload()
        body["project"]["sign"].update(
            text="ЦВЕТЫ\nИ БУКЕТЫ", line_gap_cm=5, text_align="right",
            preview_line_metrics={"font_size_px": 100, "font_family": "Arial", "font_weight": 700,
                                  "lines": [{"text": text, "width": width, "actualBoundingBoxAscent": 72,
                                             "actualBoundingBoxDescent": 0, "actualBoundingBoxLeft": 0,
                                             "actualBoundingBoxRight": width}
                                            for text, width in (("ЦВЕТЫ", 350), ("И БУКЕТЫ", 490))]})
        source, project, report, mode, quad, mask = app.prepare(body)
        base = app.relight(source, mode)
        canvas, _, guide, _, scale = app.model_inputs(base, mask, report, quad)
        prompt = app.make_prompt(project, report, mode, quad, canvas.size, scale)
        spec = json.loads(prompt.rsplit("\n", 1)[-1])
        self.assertEqual(spec["exact_lines_top_to_bottom"], ["ЦВЕТЫ", "И БУКЕТЫ"])
        self.assertEqual(spec["line_gap_cm"], 5)
        self.assertEqual(spec["text_align"], "right")
        rows = spec["line_layout"]["lines"]
        self.assertEqual(len(rows), 2)
        self.assertLess(rows[0]["polygon_px"][2][1], rows[1]["polygon_px"][0][1])
        self.assertAlmostEqual(rows[0]["polygon_px"][1][0], rows[1]["polygon_px"][1][0], places=2)
        self.assertTrue(np.any(np.all(np.array(guide) == [71, 205, 213], axis=-1)))
        body["project"]["sign"]["line_gap_cm"] = 40
        with self.assertRaises(app.UserError):
            app.prepare(body)

    def test_generated_resolution_normalization_preserves_aspect(self):
        expected = (800, 600)
        exact = Image.new("RGB", expected, (11, 22, 33))
        unchanged, normalized = app.normalize_generated(exact, expected)
        self.assertIs(unchanged, exact)
        self.assertFalse(normalized)
        for size in ((1600, 1200), (400, 300)):
            generated = Image.new("RGB", size, (11, 22, 33))
            result, normalized = app.normalize_generated(generated, expected)
            self.assertTrue(normalized)
            self.assertEqual(result.size, expected)
            self.assertEqual(result.getpixel((400, 300)), (11, 22, 33))
            self.assertEqual(generated.size, size)
        with self.assertRaises(app.UserError):
            app.normalize_generated(Image.new("RGB", (800, 800)), expected)

    def test_project_photo_and_zone_validation(self):
        for edit in (lambda p: p["project"]["image"].update(width_px=319),
                     lambda p: p["project"]["generation"].update(lighting="unknown"),
                     lambda p: p["project"]["generation"].update(edit_polygon_px=[[0,0],[319,239],[319,0],[0,239]]),
                     lambda p: p["project"]["generation"].update(edit_polygon_px=[[0,0],[10,0],[10,10],[0,10]]),
                     lambda p: p["project"]["placement"].update(width_cm=250)):
            body = payload()
            edit(body)
            with self.assertRaises(app.UserError):
                app.prepare(body)


class LocalApi(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.calls = []
        self.connection = {"configured": True, "connection_message": "Codex fixture is connected."}
        def fake_render(folder, prompt, canvas_path, guide_path, on_progress=None, *, color_reference_path=None):
            self.calls.append({"folder": folder, "prompt": prompt, "color_reference_path": color_reference_path})
            self.assertEqual(canvas_path.parent, folder)
            self.assertEqual(guide_path.parent, folder)
            self.assertTrue(guide_path.is_file())
            self.assertEqual(color_reference_path, folder / "color-reference.png")
            self.assertTrue(color_reference_path.is_file())
            self.assertIn("Image 3 is ONLY the separate color-reference card", prompt)
            self.assertIn("MANDATORY GEOMETRY LOCK", prompt)
            self.assertIn("ЦВЕТЫ", prompt)
            if on_progress:
                on_progress("Rendering fixture without Codex.")
            with Image.open(canvas_path) as canvas:
                return Image.new("RGB", canvas.size, (120, 200, 40))
        self.server = app.create_server(0, self.temp.name, renderer=fake_render,
                                        status_reader=lambda: dict(self.connection))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.token = self.get("/api/config")[1]["token"]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def get(self, path, body=None, extra=None):
        headers = {"X-Editor-Token": getattr(self, "token", ""), **(extra or {})}
        if body is not None:
            headers["Content-Type"] = "application/json"
        req = request.Request(self.base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        try:
            with request.urlopen(req, timeout=10) as response:
                data = response.read()
                return response.status, json.loads(data) if response.headers["Content-Type"].startswith("application/json") else data
        except error.HTTPError as exc:
            return exc.code, json.load(exc)

    def test_origin_host_and_token_are_checked(self):
        self.assertEqual(self.get("/api/jobs", payload(), {"Origin":"https://example.org"})[0], 403)
        self.assertEqual(self.get("/api/config", extra={"Host":"example.org"})[0], 403)
        self.assertEqual(self.get("/api/jobs", payload(), {"X-Editor-Token":"bad"})[0], 403)
        self.assertEqual(self.get("/scripts/render_server.py")[0], 404)
        self.assertEqual(self.get("/api/jobs/test-signage-job-0001", extra={"X-Editor-Token":"bad"})[0], 403)
        self.assertEqual(len(self.calls), 0)

    def test_configuration_has_no_provider_credentials_and_key_routes_are_removed(self):
        status, config = self.get("/api/config")
        self.assertEqual(status, 200)
        self.assertEqual(set(config), {"provider", "configured", "connection_message", "token", "model", "composite_configured", "product_types", "scene_retouch_configured", "independent_objects_configured", "two_stage_letters_configured"})
        self.assertIs(config["two_stage_letters_configured"], True)
        self.assertIs(config["scene_retouch_configured"], True)
        self.assertIs(config["independent_objects_configured"], True)
        self.assertTrue(config["composite_configured"])
        self.assertEqual(config["product_types"], list(app.product_render.product_types()))
        self.assertEqual(config["provider"], "codex")
        self.assertEqual(config["model"], "Codex imagegen")
        self.assertTrue(config["configured"])
        self.assertEqual(config["connection_message"], self.connection["connection_message"])
        self.assertEqual(config["token"], self.server.service.token)  # Local CSRF token, never an OpenAI credential.
        for path in ("/api/key", "/api/disconnect"):
            self.assertEqual(self.get(path, {})[0], 404)
            self.assertEqual(self.get(path)[0], 404)
        self.assertEqual(len(self.calls), 0)

    def test_disconnected_codex_blocks_generation(self):
        self.connection.update(configured=False, connection_message="Sign in through installed Codex.")
        self.assertFalse(self.get("/api/config")[1]["configured"])
        status, error_body = self.get("/api/jobs", payload())
        self.assertEqual(status, 400)
        self.assertEqual(error_body["error"], self.connection["connection_message"])
        self.assertEqual(len(self.calls), 0)
        self.assertEqual(self.server.service.jobs, {})
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])

    def test_two_stage_artifacts_are_authenticated_and_private_checkpoint_is_hidden(self):
        from test_letter_objects import independent_payload
        def render(folder, prompt, canvas, guide, **kwargs):
            with Image.open(canvas) as source:
                return source.convert("RGBA") if kwargs["transparent_background"] else Image.new("RGB", source.size, "#334455")
        self.server.service.renderer = render
        body = independent_payload(engine="codex_two_stage")
        self.assertEqual(self.get("/api/jobs", body)[0], 202)
        self.assertTrue(self.server.service.wait_for_workers(10))
        base = "/api/jobs/" + body["request_id"]
        status, job = self.get(base)
        self.assertEqual(status, 200)
        self.assertEqual(job["status"], "complete", job)
        for name in ("product-neutral.png", "product-guide.png", "layout-guide.png", "production-spec.json"):
            self.assertEqual(self.get(base + "/" + name, extra={"X-Editor-Token": "wrong"})[0], 403)
            self.assertEqual(self.get(base + "/" + name)[0], 200)
        self.assertEqual(self.get(base + "/product-stage.json")[0], 404)
        self.assertEqual(self.get(base + "/input-project.json")[0], 404)
        self.assertEqual(self.get(base + "/stage-1/prompt.txt")[0], 404)
        self.assertNotIn("source_input", json.dumps(job))

    def test_generation_single_call_and_artifacts(self):
        body = payload()
        body["project"]["sign"].update(face_material=film_profile(), front_color="#FF2030", side_color="#081020")
        first = self.get("/api/jobs", body)
        self.assertEqual(first[0], 202)
        self.assertEqual(self.get("/api/jobs", body)[0], 202)
        for _ in range(100):
            status, job = self.get("/api/jobs/" + body["request_id"])
            if job["status"] != "running":
                break
            time.sleep(.02)
        self.assertEqual(job["status"], "complete", job)
        self.assertEqual(len(self.calls), 1)
        self.assertNotIn(self.token, json.dumps(job))
        self.assertEqual(job["audit"]["changed_pixels_outside_edit_zone"], 0)
        self.assertEqual(job["audit"]["provider"], "codex_subscription")
        self.assertFalse(job["audit"]["generated_uniform_resolution_normalization"])
        self.assertEqual(job["audit"]["face_material"], film_profile())
        self.assertEqual(job["audit"]["requested_colors"], {"front_color": "#FF2030", "side_color": "#081020"})
        self.assertEqual(job["audit"]["color_accuracy"], "approximate_not_colorimetrically_verified")
        self.assertTrue(any("artistic assumption" in value for value in job["audit"]["material_assumptions"]))
        with Image.open(self.calls[0]["color_reference_path"]) as card:
            self.assertEqual(card.getpixel((100, 150)), (255, 32, 48))
            self.assertEqual(card.getpixel((450, 150)), (8, 16, 32))
        status, raw = self.get("/api/jobs/" + body["request_id"] + "/render.png")
        self.assertEqual(status, 200)
        self.assertEqual(Image.open(io.BytesIO(raw)).size, (320, 240))
        _, source_raw = self.get("/api/jobs/" + body["request_id"] + "/source.png")
        with Image.open(io.BytesIO(source_raw)) as source:
            np.testing.assert_array_equal(np.array(source), np.array(photo()))
        changed = copy.deepcopy(body)
        changed["project"]["sign"]["text"] = "ДРУГОЕ"
        self.assertEqual(self.get("/api/jobs", changed)[0], 400)
        self.assertEqual(len(self.calls), 1)
        for file in Path(self.temp.name).rglob("*"):
            if file.is_file():
                self.assertNotIn(self.token.encode(), file.read_bytes())

    def test_error_is_not_retried(self):
        calls = []
        def fail(*_, **_kwargs):
            calls.append(True)
            raise app.UserError("Controlled failure")
        self.server.service.renderer = fail
        body = payload()
        self.assertEqual(self.get("/api/jobs", body)[0], 202)
        for _ in range(100):
            _, job = self.get("/api/jobs/" + body["request_id"])
            if job["status"] != "running":
                break
            time.sleep(.02)
        self.assertEqual(job["status"], "failed")
        self.assertEqual(self.get("/api/jobs", body)[1]["status"], "failed")
        self.assertEqual(len(calls), 1)
        self.server.service.jobs.clear()
        _, recovered = self.get("/api/jobs/" + body["request_id"])
        self.assertEqual(recovered["status"], "failed")
        self.assertEqual(recovered["message"], "Controlled failure")
        self.assertEqual(self.get("/api/jobs", body)[0], 400)
        self.assertEqual(len(calls), 1)

    def test_history_recovers_legacy_results_and_pages_after_restart(self):
        for index, title in enumerate(("ЦВЕТЫ", "ОФИС ПРОДАЖ", "ЦВЕТЫ\nБУКЕТЫ")):
            folder = Path(self.temp.name) / f"saved-history-job-{index:04d}"
            folder.mkdir()
            project = payload()["project"]
            project["sign"]["text"] = title
            (folder / "project.json").write_text(json.dumps(project), encoding="utf-8")
            (folder / "audit.json").write_text(json.dumps({"lighting": "night", "changed_pixels_outside_edit_zone": 0}), encoding="utf-8")
            photo().save(folder / "source.png")
            photo().save(folder / "render.png")
        broken = Path(self.temp.name) / "saved-history-corrupt"
        broken.mkdir()
        (broken / "project.json").write_text("broken", encoding="utf-8")
        self.assertEqual(self.server.service.jobs, {})
        code, listing = self.get("/api/history?limit=1&offset=1&q=" + request.quote("ЦВЕТЫ"))
        self.assertEqual(code, 200)
        self.assertEqual(listing["total"], 2)
        self.assertEqual(len(listing["items"]), 1)
        item = listing["items"][0]
        self.assertEqual(item["status"], "complete")
        self.assertEqual(item["lighting"], "night")
        code, detail = self.get("/api/jobs/" + item["id"])
        self.assertEqual(code, 200)
        self.assertEqual(detail["audit"]["changed_pixels_outside_edit_zone"], 0)
        _, original = self.get("/api/jobs/" + item["id"] + "/render.png")
        code, thumb = self.get("/api/jobs/" + item["id"] + "/thumbnail.jpg")
        self.assertEqual(code, 200)
        with Image.open(io.BytesIO(thumb)) as image:
            self.assertEqual(image.format, "JPEG")
            self.assertLessEqual(image.width, 480)
            self.assertLessEqual(image.height, 360)
        self.assertEqual(self.get("/api/jobs/" + item["id"] + "/render.png")[1], original)
        self.assertEqual(self.get("/api/history?offset=wrong")[0], 400)
        self.assertEqual(self.get("/api/history", extra={"X-Editor-Token": "bad"})[0], 403)
        self.assertEqual(self.get("/api/jobs/" + item["id"] + "/prompt.txt")[0], 404)
        self.assertEqual(self.get("/api/jobs/../project.json")[0], 404)
        self.assertEqual(len(self.calls), 0)

    def test_unfinished_saved_job_is_interrupted_and_not_resubmitted(self):
        body = payload()
        folder = Path(self.temp.name) / body["request_id"]
        folder.mkdir()
        (folder / "project.json").write_text(json.dumps(body["project"]), encoding="utf-8")
        (folder / "job.json").write_text(json.dumps({"status": "running", "created": 42}), encoding="utf-8")
        code, job = self.get("/api/jobs/" + body["request_id"])
        self.assertEqual(code, 200)
        self.assertEqual(job["status"], "interrupted")
        self.assertEqual(job["created"], 42)
        self.assertEqual(self.get("/api/jobs", body)[0], 400)
        self.assertEqual(self.get("/api/jobs/" + body["request_id"] + "/render.png")[0], 404)
        self.assertEqual(len(self.calls), 0)

    def test_completed_job_remains_available_without_memory(self):
        body = payload()
        self.assertEqual(self.get("/api/jobs", body)[0], 202)
        for _ in range(100):
            _, job = self.get("/api/jobs/" + body["request_id"])
            if job["status"] != "running":
                break
            time.sleep(.02)
        self.assertEqual(job["status"], "complete")
        self.server.service.jobs.clear()
        _, recovered = self.get("/api/jobs/" + body["request_id"])
        self.assertEqual(recovered["created"], job["created"])
        self.assertEqual(recovered["audit"], job["audit"])
        self.assertEqual(recovered["status"], "complete")
        self.assertEqual(self.get("/api/history")[1]["total"], 1)
        self.assertEqual(len(self.calls), 1)


class ServerConfiguration(unittest.TestCase):
    def test_non_loopback_requires_valid_https_origin_before_binding(self):
        for value in (None, "", "http://signs.example.com", "https://signs.example.com/",
                      "https://signs.example.com/path", "https://signs.example.com?x=1",
                      "https://signs.example.com#part", "https://user:password@signs.example.com",
                      "https://*.example.com", "https://EXAMPLE.com", "https://example.com:443",
                      "https://example.com:0", "https://example.com:", "https://example.com:08443",
                      "https://example.com:99999", "https://example.com\\other", "https://%65xample.com"):
            with self.subTest(origin=value), mock.patch.object(app, "ThreadingHTTPServer") as constructor:
                with self.assertRaises(ValueError):
                    app.create_server(0, ".", host="0.0.0.0", public_origin=value)
                constructor.assert_not_called()
        for value in ("https://signs.example.com", "https://signs.example.com:8443", "https://[::1]:8443"):
            self.assertEqual(app.validate_public_origin(value), value)

    def test_environment_and_explicit_cli_configuration(self):
        values = {"EDITOR_HOST": "0.0.0.0", "EDITOR_PORT": "8080", "EDITOR_OUTPUT": "/data/jobs",
                  "EDITOR_PUBLIC_ORIGIN": "https://signs.example.com"}
        with mock.patch.dict(os.environ, values, clear=True):
            args = app.parse_arguments([])
            self.assertEqual((args.host, args.port, args.output, args.public_origin),
                             ("0.0.0.0", 8080, Path("/data/jobs"), "https://signs.example.com"))
            overridden = app.parse_arguments(["--host", "127.0.0.1", "--port", "9000", "--output", "test-output",
                                              "--public-origin", "https://other.example.com"])
            self.assertEqual((overridden.host, overridden.port, overridden.output, overridden.public_origin),
                             ("127.0.0.1", 9000, Path("test-output"), "https://other.example.com"))
        with mock.patch.dict(os.environ, {}, clear=True):
            args = app.parse_arguments([])
            self.assertEqual((args.host, args.port, args.public_origin), ("127.0.0.1", 54735, None))

    def test_shutdown_finishes_inflight_work_and_rejects_new_generation(self):
        entered, release = threading.Event(), threading.Event()
        calls = []

        def render(_folder, _prompt, canvas_path, _guide, **_kwargs):
            calls.append(True)
            entered.set()
            if not release.wait(5):
                raise RuntimeError("Test renderer did not receive shutdown release")
            with Image.open(canvas_path) as canvas:
                return Image.new("RGB", canvas.size, (120, 200, 40))

        with tempfile.TemporaryDirectory() as output:
            service = app.Service(output, renderer=render, status_reader=lambda: {"configured": True})
            service.submit(payload())
            try:
                self.assertTrue(entered.wait(5))
                service.begin_shutdown()
                self.assertFalse(service.wait_for_workers(.01))
                body = payload()
                body["request_id"] = "another-test-signage-0002"
                with self.assertRaisesRegex(app.UserError, "завершает работу"):
                    service.submit(body)
            finally:
                release.set()
                self.assertTrue(service.wait_for_workers(5))
            self.assertEqual(calls, [True])
            self.assertEqual(service.saved_job(payload()["request_id"])["status"], "complete")
            self.assertFalse(service.workers)


class RemoteApi(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.status_reader = mock.Mock(return_value={"configured": False, "connection_message": "Test fixture"})
        self.server = app.create_server(0, self.temp.name, status_reader=self.status_reader,
                                        host="0.0.0.0", public_origin="https://signs.example.com")
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def get(self, path, method="GET", origin=None, host="signs.example.com", token=None, extra=()):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.putrequest(method, path, skip_host=True)
            connection.putheader("Host", host)
            if origin is not None:
                connection.putheader("Origin", origin)
            if token is not None:
                connection.putheader("X-Editor-Token", token)
            for name, value in extra:
                connection.putheader(name, value)
            if method == "POST":
                connection.putheader("Content-Type", "application/json")
                connection.putheader("Content-Length", "2")
            connection.endheaders(b"{}" if method == "POST" else None)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_health_has_no_auth_or_codex_side_effects_and_stopping_is_unhealthy(self):
        self.assertEqual(self.get("/healthz"), (200, {"status": "ok"}))
        self.status_reader.assert_not_called()
        self.assertEqual(self.get("/healthz", host="127.0.0.1")[0], 403)
        self.server.service.begin_shutdown()
        self.assertEqual(self.get("/healthz"), (503, {"status": "stopping"}))
        self.status_reader.assert_not_called()

    def test_public_host_origin_and_token_are_all_required_for_mutations(self):
        code, config = self.get("/api/config")
        self.assertEqual(code, 200)
        token = config["token"]
        # A valid origin+token reaches payload validation; missing either is rejected earlier.
        self.assertEqual(self.get("/api/jobs", "POST", "https://signs.example.com", token=token)[0], 400)
        self.assertEqual(self.get("/api/jobs", "POST", token=token)[0], 403)
        self.assertEqual(self.get("/api/jobs", "POST", "https://signs.example.com")[0], 403)
        for origin in ("http://signs.example.com", "null", "https://evil.example.com", "https://signs.example.com.evil"):
            self.assertEqual(self.get("/api/jobs", "POST", origin, token=token)[0], 403)
        self.assertEqual(self.get("/api/jobs", "POST", "https://signs.example.com", host="evil.example.com", token=token)[0], 403)
        self.assertEqual(self.get("/api/jobs", "POST", "https://signs.example.com", token=token,
                                  extra=(("Origin", "https://evil.example.com"),))[0], 403)
        self.assertEqual(self.get("/healthz", extra=(("Host", "signs.example.com"),))[0], 403)
        self.assertEqual(self.server.service.jobs, {})

    def test_forwarded_headers_cannot_override_bad_host_or_origin(self):
        headers = (("X-Forwarded-Host", "signs.example.com"), ("X-Forwarded-Proto", "https"),
                   ("Forwarded", "host=signs.example.com;proto=https"))
        self.assertEqual(self.get("/api/config", host="evil.example.com", extra=headers)[0], 403)
        self.assertEqual(self.get("/api/config", origin="https://evil.example.com", extra=headers)[0], 403)
        self.assertEqual(self.get("/api/config", extra=headers)[0], 200)


if __name__ == "__main__":
    unittest.main(verbosity=2)
