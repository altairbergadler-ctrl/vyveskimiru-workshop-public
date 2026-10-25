"""Independent objects: real geometry, exact sources and protected pixels, no AI."""
import base64
import copy
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import numpy as np
from PIL import Image, ImageDraw

import letter_objects as letters
import product_render as products
import render_server as app


def artwork(size=(20, 10), source="uploaded", color="#ef1020", *, opaque=False):
    image = Image.new("RGBA", size, color if opaque else (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rectangle((1, 1, size[0] - 2, size[1] - 2), fill=color)
    if size[0] >= 10:
        draw.rectangle((size[0] // 2, 2, size[0] - 3, size[1] // 2), fill="#1020ef")
    out = io.BytesIO()
    image.save(out, format="PNG")
    return {"name": "exact.png", "mime_type": "image/png", "source": source,
            "data_url": "data:image/png;base64," + base64.b64encode(out.getvalue()).decode(),
            "width_px": image.width, "height_px": image.height}


def logo(identity="logo-a", **changes):
    return {"id": identity, "type": "logo", "width_cm": 20, "x_cm": 60,
            "y_cm": 14, "rotation_deg": 0, "depth_cm": 0,
            "side_color": "#292f30", "brief": "", "artwork": artwork(), **changes}


def text():
    return {"id": "text-a", "type": "text", "text": "A\nB", "font_family": "Arial",
            "font_bold": True, "letter_height_cm": 10, "line_gap_cm": 2,
            "text_align": "left", "front_color": "#ef1020", "x_cm": 20,
            "y_cm": 8, "rotation_deg": 0, "depth_cm": 0, "side_color": "#292f30",
            "brief": "", "artwork": artwork((8, 22), "text"),
            "preview_line_metrics": {"font_size_px": 100, "font_family": "Arial",
                "font_weight": 700, "lines": [{"text": line, "font_family": "Arial", "font_weight": 700,
                    "width": 80, "actualBoundingBoxAscent": 100, "actualBoundingBoxDescent": 0,
                    "actualBoundingBoxLeft": 0, "actualBoundingBoxRight": 80} for line in ("A", "B")]}}


def body_text(value="ЙЦ", reference="Н", **changes):
    obj = text()
    obj.update({"text": value, "height_basis": "body", "height_reference": "auto", **changes})
    row = {"text": value, "font_family": "Arial", "font_weight": 700, "width": 140,
           "actualBoundingBoxAscent": 95, "actualBoundingBoxDescent": 10,
           "actualBoundingBoxLeft": 0, "actualBoundingBoxRight": 140}
    obj["preview_line_metrics"]["lines"] = [row]
    obj["preview_line_metrics"]["height_reference"] = {
        **row, "text": reference, "width": 70, "actualBoundingBoxAscent": 70,
        "actualBoundingBoxDescent": 0, "actualBoundingBoxRight": 70}
    return obj


def project(objects=None):
    placement = {"center_px": [160, 100], "width_cm": 100, "height_cm": 40, "rotation_deg": 0}
    params = {"text": "", "font_family": "Arial", "font_bold": True,
              "objects": [text(), logo()] if objects is None else objects,
              "composition_mode": "independent_objects_v1"}
    return {"version": 2, "image": {"name": "test.png", "width_px": 320, "height_px": 240},
            "calibration": {"mode": "frontoparallel", "frontoparallel_assumed": True,
                            "image_points": [[20, 20], [220, 20]], "length_cm": 200},
            "products": [{"id": "letters", "type": "channel_letters", "module_version": 1,
                          "template_id": "letters-standard", "template_version": 1,
                          "placement": placement, "params": params}],
            "active_product_id": "letters", "generation": {"lighting": "original", "engine": "codex"}}


def composition(raw, mask=None):
    normalized = products.normalize_project(raw, require_artwork=True)
    report = app.analyze(normalized)
    y, x = np.mgrid[:240, :320]
    base = Image.fromarray(np.stack((x % 256, y, (x + y) % 256), axis=-1).astype("uint8"))
    if mask is None:
        mask = Image.new("L", base.size)
        ImageDraw.Draw(mask).rectangle((110, 80, 210, 120), fill=255)
    result, audit = letters.compose_objects(base, mask, normalized, report)
    return normalized, report, base, result, audit


def independent_payload(objects=None, *, target=None, engine="composite"):
    raw = project([text(), logo("far-logo", x_cm=265, y_cm=150)] if objects is None else objects)
    raw["products"][0]["placement"] = None
    raw["products"][0]["params"]["composition_mode"] = letters.INDEPENDENT_SIGNS_MODE
    if objects is None:
        raw["products"][0]["params"]["objects"][0].update(x_cm=30, y_cm=60)
    raw["target_polygon_px"] = target or [[25, 50], [300, 50], [300, 190], [25, 190]]
    raw["generation"]["engine"] = engine
    y, x = np.mgrid[:240, :320]
    source = Image.fromarray(np.stack((x % 256, y, (x + y) % 256), axis=-1).astype("uint8"))
    return {"request_id": "independent-signs-test-0001", "project": raw, "photo": app.data_url(source)}


class IndependentWallSigns(unittest.TestCase):
    def test_null_or_stale_frame_is_ignored_without_mutating_sources(self):
        body = independent_payload()
        for placement in (None, {"width_cm": 0, "center_px": "obsolete"}):
            with self.subTest(placement=placement):
                raw = copy.deepcopy(body["project"])
                raw["products"][0]["placement"] = placement
                original = copy.deepcopy(raw)
                normalized = products.normalize_project(raw, require_artwork=True)
                self.assertIsNone(normalized["placement"])
                self.assertIsNone(normalized["products"][0]["placement"])
                self.assertEqual(raw, original)
                self.assertEqual(normalized["sign"]["objects"], original["products"][0]["params"]["objects"])
        old = project()
        old["products"][0]["placement"] = None
        with self.assertRaisesRegex(products.ProductError, "размещение"):
            products.normalize_project(old)
        broken = copy.deepcopy(body["project"])
        del broken["products"][0]["params"]["objects"]
        with self.assertRaises(products.ProductError):
            products.normalize_project(broken)

    def test_separate_signs_render_in_their_wall_positions_and_other_sign_stays_exact(self):
        body = independent_payload()
        original = copy.deepcopy(body)
        source, normalized, report, _, _, mask = app.prepare(body)
        result, audit = letters.compose_objects(source, mask, normalized, report)
        self.assertEqual(body, original)
        self.assertEqual(report["sign_layout"]["objects"][0]["polygon_px"][0], [30, 60])
        self.assertEqual(report["sign_layout"]["objects"][1]["polygon_px"][0], [265, 150])
        self.assertEqual(result.getpixel((32, 62)), (239, 16, 32))
        self.assertEqual(result.getpixel((267, 152)), (239, 16, 32))
        self.assertEqual(audit["composition_mode"], letters.INDEPENDENT_SIGNS_MODE)
        self.assertEqual(audit["changed_pixels_outside_edit_zone"], 0)
        protected = np.asarray(mask) == 0
        self.assertTrue(np.array_equal(np.asarray(source)[protected], np.asarray(result)[protected]))
        edited = copy.deepcopy(body)
        edited["project"]["products"][0]["params"]["objects"][0].update(x_cm=190, y_cm=70, letter_height_cm=15)
        moved_report = app.prepare(edited)[2]
        self.assertEqual(moved_report["sign_layout"]["objects"][1], report["sign_layout"]["objects"][1])

    def test_three_independent_text_signs_have_visible_separate_fronts(self):
        objects = []
        for index, (x, y) in enumerate(((35, 65), (145, 85), (265, 150))):
            obj = text()
            obj.update(id=f"text-{index}", x_cm=x, y_cm=y)
            objects.append(obj)
        body = independent_payload(objects)
        source, normalized, report, _, _, mask = app.prepare(body)
        result, audit = letters.compose_objects(source, mask, normalized, report)
        self.assertEqual(audit["object_count"], 3)
        for obj in objects:
            point = (obj["x_cm"] + 2, obj["y_cm"] + 2)
            self.assertEqual(result.getpixel(point), (239, 16, 32))
            self.assertNotEqual(result.getpixel(point), source.getpixel(point))
        self.assertEqual([row["id"] for row in report["sign_layout"]["objects"]], [row["id"] for row in objects])

    def test_each_rotated_sign_fits_quadrilateral_even_when_derived_union_does_not(self):
        diamond = [[160, 40], [220, 100], [160, 160], [100, 100]]
        objects = [logo("north", x_cm=138, y_cm=62, rotation_deg=45),
                   logo("south", x_cm=168, y_cm=122, rotation_deg=45)]
        body = independent_payload(objects, target=diamond)
        source, normalized, report, _, quad, mask = app.prepare(body)
        self.assertFalse(app.contains(quad, report["placement"]["polygon_px"]))
        for layout in report["sign_layout"]["objects"]:
            self.assertTrue(app.contains(quad, layout["polygon_px"]))
        _, audit = letters.compose_objects(source, mask, normalized, report)
        self.assertEqual(audit["object_count"], 2)
        self.assertEqual(audit["changed_pixels_outside_edit_zone"], 0)
        # A technical envelope flag must not become a new constraint on signs.
        report["placement"]["fits_target"] = False
        with mock.patch.object(app, "analyze", return_value=report):
            app.prepare(body)

    def test_actual_sign_outside_installation_or_edit_zone_is_rejected(self):
        body = independent_payload()
        body["project"]["products"][0]["params"]["objects"][1]["x_cm"] = 295
        with self.assertRaisesRegex(app.UserError, "область установки"):
            app.prepare(body)
        body = independent_payload()
        body["project"]["generation"]["edit_polygon_px"] = [[25, 50], [150, 50], [150, 190], [25, 190]]
        with self.assertRaisesRegex(app.UserError, "Зона замены"):
            app.prepare(body)
        del body["project"]["target_polygon_px"]
        with self.assertRaisesRegex(app.UserError, "область установки"):
            app.prepare(body)

    def test_guide_uses_separate_sign_boundaries_and_job_restores_original_pngs(self):
        body = independent_payload()
        source, normalized, report, _, quad, mask = app.prepare(body)
        _, _, guide, _, _ = app.model_inputs(source, mask, report, quad)
        # These lie on the actual own outlines. The union-only corner stays photographic.
        self.assertEqual(guide.getpixel((30, 60)), (255, 180, 84))
        self.assertEqual(guide.getpixel((265, 150)), (255, 180, 84))
        self.assertEqual(guide.getpixel((285, 60)), source.getpixel((285, 60)))
        def unexpected_call(*args, **kwargs):
            self.fail("Independent composite must not call Codex or inspect its authorization")
        with tempfile.TemporaryDirectory() as temp:
            service = app.Service(temp, renderer=unexpected_call, status_reader=unexpected_call)
            service.submit(body)
            service.wait_for_workers(timeout=10)
            job = service.public(body["request_id"])
            self.assertEqual(job["status"], "complete", job)
            saved = json.loads((Path(temp) / body["request_id"] / "project.json").read_text("utf-8"))
            self.assertIsNone(saved["products"][0]["placement"])
            self.assertEqual(saved["products"][0]["params"]["objects"], normalized["sign"]["objects"])
            service.jobs.clear()
            restored = service.public(body["request_id"])
            self.assertEqual(restored["status"], "complete")
            self.assertEqual(restored["audit"]["composition_mode"], letters.INDEPENDENT_SIGNS_MODE)
            self.assertEqual(restored["audit"]["changed_pixels_outside_edit_zone"], 0)

    def test_ai_selection_only_prepares_background_before_exact_sign_fronts(self):
        body = independent_payload(engine="codex_composite")
        calls = []
        def background_renderer(folder, prompt, source_path, guide_path, **kwargs):
            calls.append(prompt)
            with Image.open(source_path) as source:
                return Image.new("RGB", source.size, "#445566")
        with tempfile.TemporaryDirectory() as temp:
            service = app.Service(temp, renderer=background_renderer, status_reader=lambda: {"configured": True})
            service.submit(body)
            service.wait_for_workers(timeout=10)
            job = service.public(body["request_id"])
            self.assertEqual(job["status"], "complete", job)
            self.assertEqual(len(calls), 1)
            self.assertIn("background_cleanup_only", calls[0])
            self.assertNotIn(body["project"]["products"][0]["params"]["objects"][0]["text"], calls[0])
            self.assertEqual(job["audit"]["engine"], "codex_composite")
            self.assertTrue(job["audit"]["exact_artwork"])
            self.assertEqual(job["audit"]["changed_pixels_outside_edit_zone"], 0)
            with Image.open(Path(temp) / body["request_id"] / "render.png") as result:
                self.assertEqual(result.getpixel((32, 62)), (239, 16, 32))
                self.assertEqual(result.getpixel((267, 152)), (239, 16, 32))


class ObjectContract(unittest.TestCase):
    def test_all_observed_unicode_case_additions_match_js_and_backend(self):
        # Unicode 16/17 additions missing from deployed Python Unicode 15.
        uppercase = [0x1C89, 0xA7CB, 0xA7CC, 0xA7CE, 0xA7D2, 0xA7D4, 0xA7DA, 0xA7DC]
        uppercase += list(range(0x10D50, 0x10D66)) + list(range(0x16EA0, 0x16EB9))
        lowercase = [0x1C8A, 0xA7CD, 0xA7CF, 0xA7DB]
        lowercase += list(range(0x10D70, 0x10D86)) + list(range(0x16EBB, 0x16ED4))
        self.assertEqual(len(uppercase) + len(lowercase), 106)
        objects = []
        for points, default_reference in ((uppercase, "H"), (lowercase, "x")):
            for point in points:
                # The Latin lowercase prefix makes a newly added uppercase
                # character decisive; unknown uppercase alone also defaults H.
                value = "a" + chr(point)
                expected = {0x1C89: "Н", 0x1C8A: "н"}.get(point, default_reference)
                objects.append(body_text(value, expected))
        code = ("const G=require(process.argv[1]);let s='';"
                "process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>"
                "process.stdout.write(JSON.stringify(JSON.parse(s).map(o=>G.letterHeightReference(o)))));")
        run = subprocess.run(["node", "-e", code, str(app.ASSETS / "geometry.js")],
                             input=json.dumps(objects), capture_output=True, text=True,
                             encoding="utf-8", timeout=15, check=True,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        browser_references = json.loads(run.stdout)
        self.assertEqual(len(browser_references), len(objects))
        for obj, reference in zip(objects, browser_references):
            with self.subTest(codepoint=f"U+{ord(obj['text'][-1]):04X}"):
                self.assertEqual(reference["text"], obj["preview_line_metrics"]["height_reference"]["text"])
                obj["preview_line_metrics"]["height_reference"]["text"] = reference["text"]
                params = project([obj])["products"][0]["params"]
                self.assertIs(letters.validate_objects(params, require_artwork=True), params["objects"])

    def test_unicode_16_cyrillic_reference_matches_js_and_backend(self):
        cases = [("\u1c89", "auto", "Н"), ("\u1c8a", "auto", "н"),
                 ("a\u1c89", "auto", "Н"), ("a\u1c8a", "auto", "н"),
                 ("\u1c89", "lowercase", "н"), ("\u1c8a", "uppercase", "Н")]
        objects = [body_text(value, expected, height_reference=choice) for value, choice, expected in cases]
        code = ("const G=require(process.argv[1]);let s='';"
                "process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>"
                "process.stdout.write(JSON.stringify(JSON.parse(s).map(o=>G.letterHeightReference(o)))));")
        run = subprocess.run(["node", "-e", code, str(app.ASSETS / "geometry.js")],
                             input=json.dumps(objects), capture_output=True, text=True,
                             encoding="utf-8", timeout=15, check=True,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        browser_references = json.loads(run.stdout)
        for obj, (_, _, expected), reference in zip(objects, cases, browser_references):
            with self.subTest(text=obj["text"], choice=obj["height_reference"]):
                self.assertEqual(reference["text"], expected)
                obj["preview_line_metrics"]["height_reference"]["text"] = reference["text"]
                params = project([obj])["products"][0]["params"]
                self.assertIs(letters.validate_objects(params, require_artwork=True), params["objects"])

    def test_body_reference_resolves_case_script_and_explicit_choice(self):
        cases = [("ЙЦ", "auto", "Н"), ("йц", "auto", "н"),
                 ("йЦ", "auto", "Н"), ("Ёж", "lowercase", "н"),
                 ("йц", "uppercase", "Н"), ("ǅabc", "auto", "H"),
                 ("ÉTÉ", "auto", "H"), ("gypq", "auto", "x"),
                 ("gYpq", "auto", "H"), ("123 !", "auto", "H"),
                 ("123 !", "lowercase", "x"), ("aя", "auto", "н"),
                 ("aЯ", "auto", "Н"), ("ꙁ", "auto", "н")]
        for value, choice, expected in cases:
            with self.subTest(text=value, choice=choice):
                obj = body_text(value, expected, height_reference=choice)
                params = project([obj])["products"][0]["params"]
                before = copy.deepcopy(params)
                self.assertIs(letters.validate_objects(params, require_artwork=True), params["objects"])
                self.assertEqual(params, before)
                obj["preview_line_metrics"]["height_reference"]["text"] = "wrong"
                with self.assertRaisesRegex(products.ProductError, "опорной буквы"):
                    letters.validate_objects(params, require_artwork=True)

    def test_body_metrics_must_match_font_and_have_finite_positive_visible_bounds(self):
        alterations = [lambda m: m.pop("height_reference"),
                       lambda m: m.update(height_reference=None),
                       lambda m: m["height_reference"].update(font_family="Georgia"),
                       lambda m: m["height_reference"].update(font_weight=400),
                       lambda m: m["height_reference"].update(width=-1),
                       lambda m: m["height_reference"].update(actualBoundingBoxAscent=0),
                       lambda m: m["height_reference"].update(actualBoundingBoxRight=0),
                       lambda m: m["height_reference"].update(actualBoundingBoxLeft=-70),
                       lambda m: m["height_reference"].update(actualBoundingBoxDescent=-70),
                       lambda m: m["height_reference"].update(actualBoundingBoxRight=True),
                       lambda m: m["height_reference"].update(width="70"),
                       lambda m: m["height_reference"].update(actualBoundingBoxAscent=float("nan")),
                       lambda m: m["height_reference"].update(actualBoundingBoxDescent=float("inf"))]
        for alter in alterations:
            with self.subTest(alter=alter):
                params = project([body_text()])["products"][0]["params"]
                alter(params["objects"][0]["preview_line_metrics"])
                with self.assertRaises(products.ProductError):
                    letters.validate_objects(params, require_artwork=True)
        obj = body_text()
        obj["preview_line_metrics"]["height_reference"].update(actualBoundingBoxAscent=80, actualBoundingBoxDescent=-10)
        letters.validate_objects(project([obj])["products"][0]["params"], require_artwork=True)

    def test_body_editing_can_wait_for_measurement_but_invalid_modes_are_rejected(self):
        obj = body_text()
        obj.pop("artwork")
        obj.pop("preview_line_metrics")
        params = project([obj])["products"][0]["params"]
        letters.validate_objects(params)
        with self.assertRaises(products.ProductError):
            letters.validate_objects(params, require_artwork=True)
        for key, value in (("height_basis", "future"), ("height_basis", None),
                           ("height_basis", True), ("height_reference", "titlecase"),
                           ("height_reference", None), ("height_reference", [])):
            with self.subTest(key=key, value=value):
                invalid = copy.deepcopy(params)
                invalid["objects"][0][key] = value
                with self.assertRaises(products.ProductError):
                    letters.validate_objects(invalid)

    def test_missing_height_basis_keeps_legacy_bounds_without_reference(self):
        implicit = text()
        explicit = copy.deepcopy(implicit)
        explicit.update(height_basis="bounds", height_reference="lowercase")
        reports = []
        for obj in (implicit, explicit):
            raw = project([obj])
            before = copy.deepcopy(raw)
            normalized = products.normalize_project(raw, require_artwork=True)
            reports.append(app.analyze(normalized)["sign_layout"]["objects"][0])
            self.assertEqual(raw, before)
        self.assertEqual((reports[0]["width_cm"], reports[0]["height_cm"]), (8, 22))
        self.assertEqual(reports[0]["font_size_cm"], reports[1]["font_size_cm"])
        self.assertEqual(reports[0]["lines"], reports[1]["lines"])

    def test_body_sizing_round_trip_uses_js_geometry_and_preserves_full_artwork(self):
        obj = body_text(letter_height_cm=50, x_cm=30, y_cm=60)
        obj["artwork"] = artwork((100, 75), "text")
        body = independent_payload([obj])
        original = copy.deepcopy(body)
        source, normalized, report, _, _, mask = app.prepare(body)
        layout = report["sign_layout"]["objects"][0]
        self.assertEqual((layout["width_cm"], layout["height_cm"]), (100, 75))
        self.assertAlmostEqual(layout["font_size_cm"] * .7, 50)
        self.assertEqual(layout["polygon_px"], [[30, 60], [130, 60], [130, 135], [30, 135]])
        self.assertEqual(body, original)
        self.assertEqual(normalized["sign"]["objects"][0]["height_basis"], "body")
        result, audit = letters.compose_objects(source, mask, normalized, report)
        self.assertEqual(result.getpixel((32, 62)), (239, 16, 32))
        self.assertEqual(result.getpixel((32, 132)), (239, 16, 32))
        self.assertEqual(audit["objects"][0]["artwork_sha256"],
                         hashlib.sha256(base64.b64decode(obj["artwork"]["data_url"].split(",")[1])).hexdigest())
        self.assertEqual(audit["changed_pixels_outside_edit_zone"], 0)
        protected = np.asarray(mask) == 0
        self.assertTrue(np.array_equal(np.asarray(source)[protected], np.asarray(result)[protected]))

    def test_logo_only_multiple_sources_and_no_input_mutation(self):
        raw = project([logo(), logo("logo-b", x_cm=85, y_cm=4, width_cm=8)])
        before = copy.deepcopy(raw)
        normalized, report, base, result, audit = composition(raw)
        self.assertEqual(raw, before)
        self.assertEqual(normalized["sign"]["text"], "")
        self.assertEqual(len(report["sign_layout"]["objects"]), 2)
        self.assertEqual(audit["object_count"], 2)
        self.assertTrue(audit["exact_artwork"])
        self.assertEqual(audit["changed_pixels_outside_edit_zone"], 0)
        self.assertEqual(audit["protected_base_sha256"], audit["protected_result_sha256"])
        for obj, saved in zip(raw["products"][0]["params"]["objects"], audit["objects"]):
            source = base64.b64decode(obj["artwork"]["data_url"].split(",")[1])
            self.assertEqual(saved["artwork_sha256"], hashlib.sha256(source).hexdigest())
        self.assertEqual(result.getpixel((172, 96)), (239, 16, 32))
        self.assertNotEqual(base.getpixel((172, 96)), result.getpixel((172, 96)))

    def test_multiline_font_metrics_and_exact_front_pixels(self):
        normalized, report, _, result, audit = composition(project())
        text_layout = report["sign_layout"]["objects"][0]
        self.assertEqual([line["text"] for line in text_layout["lines"]], ["A", "B"])
        self.assertEqual((text_layout["width_cm"], text_layout["height_cm"]), (8, 22))
        self.assertEqual(result.getpixel((132, 90)), (239, 16, 32))
        self.assertEqual(audit["objects"][0]["artwork_source"], "text")
        self.assertEqual(products.engine(normalized), "codex_two_stage")
        normalized["generation"]["engine"] = "composite"
        self.assertEqual(products.engine(normalized), "composite")

    def test_object_order_controls_overlap(self):
        red = logo("red", artwork=artwork(color="#ef1020"))
        green = logo("green", artwork=artwork(color="#10ef20"))
        first = composition(project([red, green]))[3]
        second = composition(project([green, red]))[3]
        self.assertEqual(first.getpixel((172, 96)), (16, 239, 32))
        self.assertEqual(second.getpixel((172, 96)), (239, 16, 32))

    def test_editing_text_can_wait_for_artwork_and_empty_scene_can_be_restored(self):
        raw = project()
        obj = raw["products"][0]["params"]["objects"][0]
        obj.pop("artwork")
        products.normalize_project(raw)
        with self.assertRaises(products.ProductError):
            products.normalize_project(raw, require_artwork=True)
        products.normalize_project(project([]))
        with self.assertRaises(products.ProductError):
            products.normalize_project(project([]), require_artwork=True)

    def test_invalid_settings_artwork_and_stale_metrics_rejected(self):
        alterations = [lambda p: p.update(objects="bad"),
                       lambda p: p.update(objects=[logo()] * 21),
                       lambda p: p.update(objects=[logo(), logo()]),
                       lambda p: p["objects"][0].update(type="shape"),
                       lambda p: p["objects"][0].update(id=""),
                       lambda p: p["objects"][0].update(x_cm=True),
                       lambda p: p["objects"][0].update(y_cm=float("inf")),
                       lambda p: p["objects"][0].update(rotation_deg=[]),
                       lambda p: p["objects"][0].update(depth_cm=-1),
                       lambda p: p["objects"][0].update(side_color="red"),
                       lambda p: p["objects"][0].update(brief="x" * 4001),
                       lambda p: p["objects"][0].update(text="x" * 8001),
                       lambda p: p["objects"][0].update(font_family=""),
                       lambda p: p["objects"][0].update(font_bold=1),
                       lambda p: p["objects"][0].update(letter_height_cm=0),
                       lambda p: p["objects"][0].update(line_gap_cm=-1),
                       lambda p: p["objects"][0].update(text_align="justify"),
                       lambda p: p["objects"][0].update(front_color="#fff"),
                       lambda p: p["objects"][0].update(preview_line_metrics={}),
                       lambda p: p["objects"][0]["preview_line_metrics"]["lines"][0].update(text="WRONG"),
                       lambda p: p["objects"][1].pop("artwork"),
                       lambda p: p["objects"][1]["artwork"].update(source="text"),
                       lambda p: p["objects"][0]["artwork"].update(source="uploaded"),
                       lambda p: p["objects"][1].update(artwork=artwork(opaque=True)),
                       lambda p: p["objects"][1]["artwork"].update(data_url="data:image/png;base64,invalid"),
                       lambda p: p["objects"][1]["artwork"].update(width_px=19),
                       lambda p: p.update(composition_mode="future_objects_v2")]
        for alter in alterations:
            params = project()["products"][0]["params"]
            alter(params)
            with self.subTest(alter=alter), self.assertRaises(products.ProductError):
                letters.validate_objects(params, require_artwork=True)

    def test_project_and_generated_text_size_limits(self):
        params = project()["products"][0]["params"]
        params["extra"] = "x" * letters.MAX_OBJECTS_JSON_BYTES
        with self.assertRaisesRegex(products.ProductError, "30 МиБ"):
            letters.validate_objects(params)
        params = project([text()])["products"][0]["params"]
        params["objects"][0]["artwork"]["data_url"] = "data:image/png;base64," + base64.b64encode(b"x" * (letters.MAX_OBJECT_ARTWORK_BYTES + 1)).decode()
        with self.assertRaisesRegex(products.ProductError, "1 МиБ"):
            letters.validate_objects(params)

    def test_legacy_letters_remain_ai_engine_and_unchanged(self):
        raw = {"version": 1, "sign": {"text": "OLD"}, "generation": {}}
        self.assertEqual(products.normalize_project(raw), raw)
        self.assertEqual(products.engine(raw), "codex")
        raw = project()
        raw["products"][0]["params"].pop("objects")
        raw["products"][0]["params"]["text"] = "OLD"
        self.assertEqual(products.engine(products.normalize_project(raw)), "codex")


class ProtectedComposition(unittest.TestCase):
    def test_rotated_objects_in_perspective_and_original_photo_untouched(self):
        raw = project([logo(rotation_deg=18, x_cm=40, y_cm=12, depth_cm=5)])
        raw["calibration"] = {"mode": "rectangle", "image_points": [[20, 20], [290, 30], [280, 210], [30, 220]],
                              "width_cm": 270, "height_cm": 200}
        raw["products"][0]["placement"].update(rotation_deg=12)
        normalized, report, base, result, audit = composition(raw, Image.new("L", (320, 240), 255))
        self.assertNotEqual(report["sign_layout"]["objects"][0]["polygon_px"], [[170, 94], [190, 94], [190, 104], [170, 104]])
        self.assertTrue(np.any(np.asarray(base) != np.asarray(result)))
        self.assertEqual(audit["objects"][0]["id"], "logo-a")
        self.assertGreater(audit["objects"][0]["illustrative_depth_px"], 0)
        self.assertEqual(normalized["products"][0]["params"]["objects"][0]["artwork"], raw["products"][0]["params"]["objects"][0]["artwork"])

    def test_clipping_guards_irregular_mask_for_depth_and_night_glow(self):
        raw = project([logo(depth_cm=1000)])
        raw["generation"]["lighting"] = "night"
        mask = Image.new("L", (320, 240))
        ImageDraw.Draw(mask).ellipse((174, 94, 184, 105), fill=255)
        _, _, base, result, audit = composition(raw, mask)
        protected = np.asarray(mask) == 0
        self.assertTrue(np.array_equal(np.asarray(base)[protected], np.asarray(result)[protected]))
        self.assertGreater(audit["effects_clipped_pixels"], 0)
        self.assertTrue(audit["night_sign_lighting_forced_on"])
        self.assertEqual(audit["objects"][0]["illustrative_depth_px"], 12)
        self.assertTrue(np.any(np.asarray(base)[~protected] != np.asarray(result)[~protected]))

    def test_mismatched_report_is_rejected(self):
        normalized = products.normalize_project(project(), require_artwork=True)
        report = app.analyze(normalized)
        report["sign_layout"]["objects"].reverse()
        with self.assertRaises(products.ProductError):
            letters.compose_objects(Image.new("RGB", (320, 240)), Image.new("L", (320, 240)), normalized, report)


if __name__ == "__main__":
    unittest.main()
