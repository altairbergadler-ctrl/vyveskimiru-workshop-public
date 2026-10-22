"""Real project geometry and local composition tests; no AI or paid calls."""
import base64
import copy
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
from PIL import Image, ImageDraw

import product_render as products
import render_server as app
from history_transfer import export_history, import_history
from test_render_server import payload


def artwork(size=(100, 40), *, square=False):
    image = Image.new("RGBA", size)
    draw = ImageDraw.Draw(image)
    if square:
        draw.rectangle((1, 1, size[0]-2, size[1]-2), fill="#ef1020")
    else:
        # Deliberately asymmetric exact source: colored bars, a gap and a dot.
        draw.rectangle((5, 5, 20, 34), fill="#ef1020")
        draw.rectangle((21, 5, 45, 11), fill="#ef1020")
        draw.rectangle((21, 18, 38, 24), fill="#ef1020")
        draw.ellipse((72, 14, 86, 28), fill="#1020ef")
    raw = app.png_bytes(image)
    return {"name": "exact-source.png", "mime_type": "image/png", "data_url": "data:image/png;base64," + base64.b64encode(raw).decode(),
            "width_px": image.width, "height_px": image.height, "source": "uploaded"}


def product_payload(kind="plaque", mode="original", selected_engine="composite"):
    body = payload(mode)
    old = body["project"]
    params = {"text": "", "font_family": "Arial", "font_bold": True, "line_gap_cm": 0,
              "text_align": "center", "front_color": "#ef1020", "brief": ""}
    params.update({"material": "pvc", "background_color": "#ffffff", "thickness_mm": 3,
                   "corner_radius_mm": 0, "mounting": "tape", "margin_mm": 0} if kind == "plaque" else {
                   "tubing_mm": 8, "backing": "none", "backing_margin_mm": 0, "illumination": "on"})
    product = {"id": "test-product", "type": kind, "module_version": 1,
               "template_id": "custom-template", "template_version": 1,
               "placement": copy.deepcopy(old["placement"]), "params": params, "artwork": artwork()}
    old.update(version=2, products=[product], active_product_id=product["id"])
    old["generation"]["engine"] = selected_engine
    return body


def await_job(service, identity):
    service.wait_for_workers(timeout=10)
    return service.public(identity)


class ProductContract(unittest.TestCase):
    def test_legacy_behavior_and_input_preserved(self):
        old = payload()["project"]
        original = copy.deepcopy(old)
        normalized = products.normalize_project(old)
        self.assertEqual(normalized, original)
        self.assertEqual(old, original)
        self.assertEqual(products.active_product(normalized)["type"], "channel_letters")
        self.assertEqual(products.engine(normalized), "codex")
        self.assertNotIn("face_material", normalized["sign"])

    def test_v2_canonical_product_overrides_stale_root_mirrors(self):
        body = product_payload()
        body["project"]["sign"] = {"text": "WRONG LETTERS", "front_color": "invalid"}
        body["project"]["placement"]["width_cm"] = 900000
        original = copy.deepcopy(body)
        _, project, report, *_ = app.prepare(body)
        self.assertEqual(project["sign"]["text"], "")
        self.assertEqual(project["placement"]["width_cm"], 100)
        self.assertEqual(report["placement"]["polygon_px"], [[110, 80], [210, 80], [210, 120], [110, 120]])
        self.assertEqual(body, original)

    def test_modules_template_versions_and_engines_checked(self):
        for change in (
            lambda p: p.update(type="banner"), lambda p: p.update(module_version=2),
            lambda p: p.update(template_version=0), lambda p: p.update(template_version=True),
            lambda p: p.update(template_version=1.5), lambda p: p.update(template_id="../other"),
            lambda p: p.update(id=[]), lambda p: p["params"].update(material=[]),
            lambda p: p["params"].update(thickness_mm=float("nan")),
            lambda p: p["params"].update(margin_mm=200),
            lambda p: p["params"].update(font_bold="yes")):
            body = product_payload()
            change(body["project"]["products"][0])
            with self.subTest(project=body["project"]), self.assertRaises(app.UserError):
                app.prepare(body)
        body = product_payload()
        body["project"]["products"][0]["template_version"] = 200
        self.assertEqual(app.prepare(body)[1]["products"][0]["template_version"], 200)
        for selected_engine in ("codex", "codex_two_stage", "unknown", []):
            body = product_payload(selected_engine=selected_engine)
            with self.assertRaises(app.UserError):
                app.prepare(body)
        for active in ("absent", None):
            body = product_payload()
            body["project"]["active_product_id"] = active
            with self.assertRaises(app.UserError):
                app.prepare(body)
        body = product_payload()
        body["project"]["products"].append(copy.deepcopy(body["project"]["products"][0]))
        with self.assertRaises(app.UserError):
            app.prepare(body)

    def test_exact_png_asset_validation(self):
        for change in (
            lambda a: a.update(mime_type="image/svg+xml"),
            lambda a: a.update(data_url="data:image/png;base64,broken"),
            lambda a: a.update(width_px=99), lambda a: a.update(width_px=True),
            lambda a: a.update(height_px=4097), lambda a: a.update(source="guessed"),
            lambda a: a.update(source=[]), lambda a: a.update(name="x"*241),
            lambda a: a.update(data_url="data:image/png;base64," + "A"*2_796_208)):
            body = product_payload()
            change(body["project"]["products"][0]["artwork"])
            with self.subTest(asset=body["project"]["products"][0]["artwork"].get("name")), self.assertRaises(app.UserError):
                app.prepare(body)
        body = product_payload()
        del body["project"]["products"][0]["artwork"]
        with self.assertRaises(app.UserError):
            app.prepare(body)
        body = product_payload("neon")
        opaque = Image.new("RGB", (100, 40), "white")
        body["project"]["products"][0]["artwork"]["data_url"] = app.data_url(opaque)
        with self.assertRaisesRegex(app.UserError, "прозрачным"):
            app.prepare(body)

    def test_effect_margin_rejected_before_generation(self):
        body = product_payload("neon")
        body["project"]["generation"]["edit_polygon_px"] = [[110,80],[210,80],[210,120],[110,120]]
        with self.assertRaisesRegex(app.UserError, "Расширьте"):
            app.prepare(body)

    def test_saved_size_limit_includes_canonical_mirrors_and_formatting(self):
        body = product_payload()
        body["project"]["products"][0]["params"]["future_field"] = "x" * (products.MAX_PROJECT_BYTES // 2 + 1024)
        self.assertLess(len(json.dumps(body["project"]).encode()), products.MAX_PROJECT_BYTES)
        with self.assertRaisesRegex(app.UserError, "Сохранённый проект слишком большой"):
            app.prepare(body)

    def test_malformed_scene_image_is_a_validation_error(self):
        for invalid in (None, [], True, "wrong"):
            body = product_payload()
            body["project"]["image"] = invalid
            with self.subTest(image=invalid), self.assertRaises(app.UserError):
                app.prepare(body)


class ExactComposition(unittest.TestCase):
    def compose(self, body):
        source, project, report, mode, _, mask = app.prepare(body)
        base = app.relight(source, mode)
        result, audit, raw = products.compose_product(base, mask, project, report)
        return result, audit, raw, base, mask

    def test_exact_artwork_shape_colors_hash_and_protected_pixels(self):
        body = product_payload()
        result, audit, raw, base, mask = self.compose(body)
        self.assertEqual(audit["changed_pixels_outside_edit_zone"], 0)
        self.assertEqual(audit["effects_clipped_pixels"], 0)
        self.assertEqual(result.getpixel((120, 100)), (239, 16, 32))
        self.assertEqual(result.getpixel((150, 110)), (255, 255, 255))
        self.assertEqual(result.getpixel((190, 101)), (16, 32, 239))
        self.assertEqual(audit["artwork_sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(raw, base64.b64decode(body["project"]["products"][0]["artwork"]["data_url"].split(",")[1]))
        outside = np.asarray(mask) == 0
        np.testing.assert_array_equal(np.asarray(result)[outside], np.asarray(base)[outside])

    def test_uploaded_square_aspect_is_contained_without_stretching(self):
        body = product_payload()
        body["project"]["products"][0]["artwork"] = artwork((40,40), square=True)
        result, *_ = self.compose(body)
        self.assertEqual(result.getpixel((130, 100)), (255, 255, 255))
        self.assertEqual(result.getpixel((150, 100)), (239, 16, 32))
        self.assertEqual(result.getpixel((190, 100)), (255, 255, 255))

    def test_night_plaque_has_no_forced_or_generated_glow(self):
        body = product_payload(mode="night")
        result, audit, _, base, _ = self.compose(body)
        self.assertFalse(audit["night_sign_lighting_forced_on"])
        self.assertFalse(audit["neon_illumination_on"])
        self.assertEqual(result.getpixel((105, 75)), base.getpixel((105, 75)))

    def test_neon_glow_comes_from_artwork_alpha_and_can_be_off(self):
        body = product_payload("neon", "night")
        on, audit, _, _, _ = self.compose(body)
        self.assertTrue(audit["neon_illumination_on"])
        body["project"]["products"][0]["params"]["illumination"] = "off"
        off, off_audit, _, base, _ = self.compose(body)
        self.assertFalse(off_audit["neon_illumination_on"])
        self.assertNotEqual(on.getpixel((120, 82)), off.getpixel((120, 82)))
        self.assertEqual(off.getpixel((120, 82)), base.getpixel((120, 82)))
        self.assertEqual(off.getpixel((120, 100)), on.getpixel((120, 100)))
        self.assertEqual(off.getpixel((140, 112)), base.getpixel((140, 112)))

    def test_final_pixel_mask_guard_includes_all_effects(self):
        body = product_payload("neon")
        source, project, report, _, _, _ = app.prepare(body)
        mask = Image.new("L", source.size)
        ImageDraw.Draw(mask).rectangle((110,80,160,120), fill=255)
        result, audit, _ = products.compose_product(source, mask, project, report)
        self.assertGreater(audit["effects_clipped_pixels"], 0)
        self.assertEqual(audit["changed_pixels_outside_edit_zone"], 0)
        outside = np.asarray(mask) == 0
        np.testing.assert_array_equal(np.asarray(result)[outside], np.asarray(source)[outside])

    def test_perspective_warp_preserves_canvas_and_maps_features(self):
        src = Image.new("RGBA", (20,20), "#ef1020")
        q = [[30,20],[80,30],[70,80],[20,60]]
        result = products.warp(src, (100,100), q)
        self.assertEqual(result.size, (100,100))
        self.assertEqual(result.getpixel((45,45)), (239,16,32,255))
        self.assertEqual(result.getpixel((5,5))[3], 0)


class ProductJobs(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.calls = []
        def render(folder, prompt, canvas, guide, on_progress=None, **kwargs):
            self.calls.append(prompt)
            with Image.open(canvas) as image:
                return Image.new("RGB", image.size, "#445566")
        self.service = app.Service(self.temp.name, renderer=render, status_reader=lambda: {"configured":False,"connection_message":"Disconnected"})

    def test_composite_job_does_not_check_or_call_codex_and_restores_canonical_history(self):
        body = product_payload()
        self.service.status_reader = lambda: self.fail("Composite must not inspect Codex authorization")
        first = self.service.submit(body)
        self.assertEqual(first["engine"], "composite")
        job = await_job(self.service, body["request_id"])
        self.assertEqual(job["status"], "complete", job)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.service.submit(body)["status"], "complete")
        folder = Path(self.temp.name) / body["request_id"]
        original_art = base64.b64decode(body["project"]["products"][0]["artwork"]["data_url"].split(",")[1])
        self.assertEqual(self.service.artifact(body["request_id"], "artwork.png").read_bytes(), original_art)
        saved = json.loads((folder / "project.json").read_text("utf-8"))
        del saved["sign"]
        del saved["placement"]
        (folder / "project.json").write_text(json.dumps(saved), "utf-8")
        self.service.jobs.clear()
        restored = self.service.public(body["request_id"])
        self.assertEqual(restored["status"], "complete")
        self.assertEqual(restored["product"]["type"], "plaque")
        self.assertEqual(self.service.history()["items"][0]["engine"], "composite")
        with tempfile.TemporaryDirectory() as transfer_temp:
            archive = Path(transfer_temp) / "archive.zip"
            export_history(self.temp.name, archive)
            destination = Path(transfer_temp) / "restore"
            import_history(archive, destination)
            self.assertEqual((destination / body["request_id"] / "artwork.png").read_bytes(), original_art)

    def test_nonobject_job_is_a_validation_error(self):
        for invalid in (None, [], "wrong"):
            with self.subTest(body=invalid), self.assertRaises(app.UserError):
                self.service.submit(invalid)

    def test_ai_background_has_one_call_then_exact_product_overlay(self):
        body = product_payload(selected_engine="codex_composite")
        body["project"]["products"][0]["params"]["text"] = "ТОЧНЫЙ ТЕКСТ"
        with self.assertRaisesRegex(app.UserError, "Disconnected"):
            self.service.submit(body)
        self.service.status_reader = lambda: {"configured": True}
        self.service.submit(body)
        job = await_job(self.service, body["request_id"])
        self.assertEqual(job["status"], "complete", job)
        self.assertEqual(len(self.calls), 1)
        self.assertIn("background_cleanup_only", self.calls[0])
        self.assertNotIn("ТОЧНЫЙ ТЕКСТ", self.calls[0])
        self.assertTrue(job["audit"]["exact_artwork"])
        self.assertEqual(job["audit"]["engine"], "codex_composite")
        self.assertEqual(job["audit"]["background_audit"]["changed_pixels_outside_edit_zone"], 0)
        with Image.open(self.service.artifact(body["request_id"], "render.png")) as result:
            self.assertEqual(result.getpixel((120,100)), (239,16,32))
        self.service.submit(body)
        self.assertEqual(len(self.calls), 1)

    def test_ai_failure_never_falls_back_or_retries(self):
        self.service.status_reader = lambda: {"configured":True}
        def fail(*args, **kwargs):
            self.calls.append("failed")
            raise RuntimeError("Controlled AI background failure")
        self.service.renderer = fail
        body = product_payload(selected_engine="codex_composite")
        self.service.submit(body)
        job = await_job(self.service, body["request_id"])
        self.assertEqual(job["status"], "failed")
        self.assertEqual(self.service.submit(body)["status"], "failed")
        self.assertEqual(self.calls, ["failed"])
        self.assertFalse((Path(self.temp.name) / body["request_id"] / "render.png").exists())

    def test_accepted_near_limit_project_remains_restorable(self):
        body = product_payload()
        body["project"]["future_field"] = "x" * (products.MAX_PROJECT_BYTES - 8192)
        self.service.submit(body)
        job = await_job(self.service, body["request_id"])
        self.assertEqual(job["status"], "complete", job)
        folder = Path(self.temp.name) / body["request_id"]
        self.assertLessEqual((folder / "project.json").stat().st_size, products.MAX_PROJECT_BYTES)
        self.assertGreater((folder / "project.json").stat().st_size, products.MAX_PROJECT_BYTES - 8192)
        self.service.jobs.clear()
        restored = self.service.public(body["request_id"])
        self.assertEqual(restored["status"], "complete")
        self.assertEqual(self.service.history()["total"], 1)


if __name__ == "__main__":
    unittest.main()
