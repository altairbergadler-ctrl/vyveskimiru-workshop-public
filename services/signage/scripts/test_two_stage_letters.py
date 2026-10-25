"""Two-stage contracts and caching using injected image edits, never paid AI."""
import copy
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import numpy as np
from PIL import Image, ImageChops

import product_render
import render_server as app
import two_stage_letters as pipeline
from test_letter_objects import artwork, body_text, independent_payload, logo, text


def screenshot_pair():
    """100px Arial Bold ink metrics independently verified in Microsoft Edge."""
    result = []
    for index, (value, width, ascent, descent) in enumerate((
            ("ДЕТЕЙЛИНГ", 609.85546875, 92, 16), ("КОФЕ", 279.169921875, 73, 1))):
        obj = body_text(value, letter_height_cm=50, x_cm=30 + index * 470, y_cm=60, line_gap_cm=0)
        obj["id"] = f"screenshot-word-{index}"
        obj["preview_line_metrics"]["lines"][0].update(width=width, actualBoundingBoxRight=width,
            actualBoundingBoxAscent=ascent, actualBoundingBoxDescent=descent)
        obj["preview_line_metrics"]["height_reference"].update(actualBoundingBoxAscent=72)
        obj["artwork"] = artwork((round(width), ascent + descent), "text")
        result.append(obj)
    return result


class TwoStageLetters(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.output = Path(self.temp.name)
        self.calls = []
        self.messages = []
        self.service = app.Service(self.output, renderer=self.render, status_reader=lambda: {"configured": True})

    def tearDown(self):
        self.service.wait_for_workers(10)
        self.temp.cleanup()

    def render(self, folder, prompt, canvas, guide, on_progress=None, *, reference_image_paths=None, transparent_background=False, **kwargs):
        self.calls.append({"folder": folder, "prompt": prompt, "references": list(reference_image_paths or []),
                           "transparent": transparent_background, "options": kwargs})
        for file in reference_image_paths or []:
            self.assertEqual(file.parent, folder)
            self.assertTrue(file.is_file())
        # Manufacturing inputs must already exist before either image edit.
        self.assertTrue((folder.parent / "production-spec.json").is_file())
        self.assertTrue((folder.parent / "project.json").is_file())
        self.assertTrue((folder.parent / "input-project.json").is_file())
        if on_progress:
            on_progress("fixture")
        with Image.open(canvas) as source:
            if transparent_background:
                return source.convert("RGBA")
            return Image.new("RGB", source.size, (44, 90, 120))

    def body(self, identity="two-stage-example-0001"):
        body = independent_payload(engine="codex")
        body["request_id"] = identity
        return body

    def submit(self, body):
        self.service.submit(body)
        self.assertTrue(self.service.wait_for_workers(10))
        return self.service.public(body["request_id"])

    def test_scene_edit_is_final_without_flat_compositing_and_inputs_stay_immutable(self):
        body = self.body()
        original = copy.deepcopy(body)
        with mock.patch("letter_objects.compose_objects", side_effect=AssertionError("Do not restore the old flat compositor")), \
                mock.patch("exact_letter_installation.install", side_effect=AssertionError("Do not paste neutral faces after the scene edit")):
            job = self.submit(body)
        self.assertEqual(job["status"], "complete", job)
        self.assertEqual(body, original)
        self.assertEqual([call["transparent"] for call in self.calls], [True, False])
        self.assertEqual([path.name for path in self.calls[0]["references"]], ["product-guide.png", "object-001.png", "object-002.png"])
        self.assertEqual([path.name for path in self.calls[1]["references"]],
                         ["render-input.png", "scene-reference.png", "product-neutral.png", "product-guide.png"])
        self.assertIn("ONE common physical scale", self.calls[0]["prompt"])
        self.assertIn("manufactured channel letters", self.calls[0]["prompt"])
        self.assertNotIn("FRONT SURFACE ATLAS", self.calls[0]["prompt"])
        self.assertIn("Discard stage 1 studio lighting", self.calls[1]["prompt"])
        self.assertIn("foreground tree branches, leaves, cables", self.calls[1]["prompt"])
        self.assertTrue(self.calls[1]["options"]["preserve_placed_artwork"])
        self.assertFalse(self.calls[1]["options"].get("background_only", False))
        audit = job["audit"]
        self.assertEqual(audit["engine"], "codex_two_stage")
        self.assertEqual(audit["ai_calls_this_job"], 2)
        self.assertTrue(audit["no_artwork_overlay_after_generation"])
        self.assertFalse(audit["exact_front_geometry"])
        self.assertTrue(audit["geometry_requires_visual_review"])
        self.assertTrue(audit["installation_input"]["scene_aware_installation"])
        self.assertTrue(audit["manufacturing_input_unchanged"])
        self.assertFalse(audit["exact_artwork"])
        self.assertEqual(audit["changed_pixels_outside_edit_zone"], 0)
        folder = self.output / body["request_id"]
        with Image.open(folder / "render.png") as image:
            self.assertEqual(image.getpixel((32, 62)), (44, 90, 120), "New faces must not overwrite the scene renderer's pixels")
        self.assertFalse((folder / "front-mask.png").exists())
        self.assertFalse((folder / "installation-base.png").exists())
        saved = json.loads((folder / "project.json").read_text(encoding="utf-8"))
        raw_input = json.loads((folder / "input-project.json").read_text(encoding="utf-8"))
        self.assertEqual(raw_input, original["project"])
        self.assertEqual(self.service.inputs, {})
        self.assertNotIn("data_url", json.dumps(job))
        self.assertEqual(saved["products"][0]["params"]["objects"], body["project"]["products"][0]["params"]["objects"])
        spec = json.loads((folder / "production-spec.json").read_text(encoding="utf-8"))
        self.assertFalse(spec["manufacturing_readiness"]["ready"])
        self.assertEqual(spec["source"]["project_sha256"], hashlib.sha256((folder / "project.json").read_bytes()).hexdigest())
        self.assertEqual(spec["source"]["job_id"], body["request_id"])
        construction = saved["products"][0]["params"]["construction"]
        self.assertIn("owner_confirmed", json.dumps(construction))
        self.assertIn("acrylic", json.dumps(construction))
        self.assertIn("aluminium", json.dumps(construction))
        self.assertTrue(job["has_product_neutral"] and job["has_layout_guide"] and job["has_production_spec"])
        self.service.jobs.clear()
        restored = self.service.public(body["request_id"])
        self.assertEqual(restored["engine"], "codex_two_stage")
        self.assertTrue(restored["has_product_neutral"])
        # Optional artifact absence never invalidates a saved final result.
        (folder / "product-neutral.png").unlink()
        self.assertEqual(self.service.public(body["request_id"])["status"], "complete")
        self.assertFalse(self.service.public(body["request_id"])["has_product_neutral"])

    def test_movement_rotation_photo_and_lighting_reuse_neutral(self):
        first = self.submit(self.body())
        self.assertEqual(first["status"], "complete", first)
        body = self.body("two-stage-example-0002")
        body["project"]["products"][0]["params"]["objects"][0].update(x_cm=40, rotation_deg=8)
        body["photo"] = app.data_url(Image.new("RGB", (320, 240), "#ccddee"))
        body["project"]["generation"]["lighting"] = "cloudy"
        body["project"]["calibration"]["length_cm"] = 210
        second = self.submit(body)
        self.assertEqual(second["status"], "complete", second)
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(second["audit"]["ai_calls_this_job"], 1)
        self.assertEqual(second["audit"]["product_stage"]["reused_from_job"], first["id"])

    def test_size_color_material_and_artwork_changes_invalidate_cache(self):
        self.assertEqual(self.submit(self.body())["status"], "complete")
        for index, change in enumerate((lambda obj: obj.update(letter_height_cm=11),
                lambda obj: obj.update(side_color="#001299"), lambda obj: obj.update(materials={"surface_finish": "matte"}),
                lambda obj: obj.update(construction={"version": 1, "face_material": "clear_acrylic"}),
                lambda obj: obj.update(artwork={**obj["artwork"], "data_url": logo()["artwork"]["data_url"],
                                              "width_px": 20, "height_px": 10}))):
            body = self.body(f"two-stage-invalidate-{index:04}")
            obj = body["project"]["products"][0]["params"]["objects"][0]
            change(obj)
            before = len(self.calls)
            job = self.submit(body)
            self.assertEqual(job["status"], "complete", job)
            self.assertEqual(len(self.calls) - before, 2)

    def test_primary_edit_follows_current_placement_when_neutral_product_is_reused(self):
        first = self.submit(self.body())
        moved = self.body("two-stage-placement-moved-0002")
        moved["project"]["products"][0]["params"]["objects"][0].update(x_cm=40, y_cm=70, rotation_deg=8)
        second = self.submit(moved)
        self.assertEqual(second["status"], "complete", second)
        self.assertEqual(second["audit"]["product_stage"]["reused_from_job"], first["id"])
        self.assertEqual(len(self.calls), 3)
        targets = []
        for job in (first, second):
            folder = self.output / job["id"]
            target = (folder / "stage-2/render-input.png").read_bytes()
            self.assertEqual(target, (folder / "stage-2/layout-guide.png").read_bytes())
            self.assertNotEqual(target, (folder / "stage-2/scene-reference.png").read_bytes())
            self.assertEqual(job["audit"]["installation_input"]["edit_target_sha256"], hashlib.sha256(target).hexdigest())
            targets.append(target)
        self.assertNotEqual(*targets, "Movement/rotation must be present in the photograph being edited, including on a cache hit")
        self.assertEqual((self.output / first["id"] / "stage-2/scene-reference.png").read_bytes(),
                         (self.output / second["id"] / "stage-2/scene-reference.png").read_bytes())
        self.assertIn("positions and perspective", self.calls[-1]["prompt"])
        self.assertIn('"placement":', self.calls[-1]["prompt"])
        self.assertNotIn("background_cleanup_only", self.calls[-1]["prompt"])

    def test_previous_flat_atlas_cache_is_not_reused(self):
        first = self.submit(self.body())
        checkpoint = self.output / first["id"] / pipeline.CHECKPOINT
        meta = json.loads(checkpoint.read_text(encoding="utf-8"))
        # Version 2 rendered a front-only colour atlas. Its hashes can be intact
        # while its appearance contract is unsuitable for scene-aware installation.
        meta["version"] = 2
        meta["physical_input"]["version"] = 2
        meta["cache_key"] = hashlib.sha256(pipeline._json(meta["physical_input"]).encode("utf-8")).hexdigest()
        checkpoint.write_text(json.dumps(meta), encoding="utf-8")
        second = self.submit(self.body("two-stage-after-flat-atlas-0002"))
        self.assertEqual(second["status"], "complete", second)
        self.assertEqual(pipeline.VERSION, 3)
        self.assertEqual(len(self.calls), 4)
        self.assertIsNone(second["audit"]["product_stage"]["reused_from_job"])

    def test_body_height_metadata_and_both_prompts_preserve_screenshot_word_scale(self):
        body = independent_payload(screenshot_pair(), target=[[25, 50], [950, 50], [950, 250], [25, 250]],
                                   engine="codex_two_stage")
        body["project"]["image"].update(width_px=1000, height_px=300)
        body["photo"] = app.data_url(Image.new("RGB", (1000, 300), "#ccddee"))
        body["request_id"] = "body-height-screenshot-pair-0001"
        before = copy.deepcopy(body)
        _, project, report, *_ = app.prepare(body)
        rows = pipeline.physical_inputs(project, report)["objects"]
        layouts = report["sign_layout"]["objects"]
        self.assertAlmostEqual(layouts[0]["font_size_cm"], layouts[1]["font_size_cm"])
        self.assertAlmostEqual(layouts[0]["font_size_cm"] * .72, 50)
        self.assertAlmostEqual(rows[0]["height_cm"], 75)
        self.assertAlmostEqual(rows[1]["height_cm"], 74 / 72 * 50)
        for row in rows:
            self.assertEqual(row["height_basis"], "body")
            self.assertEqual(row["height_reference"], "auto")
            self.assertEqual(row["height_reference_case"], "uppercase")
            self.assertEqual(row["height_reference_text"], "Н")
            self.assertEqual(row["nominal_letter_height_cm"], 50)
            self.assertEqual(row["body_height_cm"], 50)
        self.assertEqual(body, before)
        job = self.submit(body)
        self.assertEqual(job["status"], "complete", job)
        self.assertEqual(len(self.calls), 2)
        for call in self.calls:
            self.assertIn("not the whole word's outer bounds", call["prompt"])
            self.assertIn("Never shrink a word", call["prompt"])
            self.assertIn("COMPLETE front artwork bounds", call["prompt"])
            self.assertIn('"height_basis":"body"', call["prompt"])
            self.assertIn('"height_reference_text":"Н"', call["prompt"])
        folder = self.output / job["id"]
        checkpoint = json.loads((folder / pipeline.CHECKPOINT).read_text(encoding="utf-8"))
        self.assertEqual(checkpoint["physical_input"]["objects"], rows)
        self.assertEqual(body, before)
        # Movement does not change the physical height contract or invalidate a
        # prepared product, even though its facade layout uses different pixels.
        moved = copy.deepcopy(body)
        moved["request_id"] = "body-height-screenshot-pair-0002"
        moved["project"]["products"][0]["params"]["objects"][0]["x_cm"] += 8
        second = self.submit(moved)
        self.assertEqual(second["status"], "complete", second)
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(second["audit"]["product_stage"]["reused_from_job"], job["id"])

    def test_legacy_bounds_height_metadata_does_not_invent_a_body_reference(self):
        _, project, report, *_ = app.prepare(self.body())
        original = copy.deepcopy(project)
        row = pipeline.physical_inputs(project, report)["objects"][0]
        self.assertEqual(row["letter_height_cm"], 10)
        for key in ("height_basis", "height_reference", "nominal_letter_height_cm",
                    "height_reference_case", "height_reference_text", "body_height_cm"):
            self.assertNotIn(key, row, "An unchanged historical cache row must retain its original shape")
        self.assertEqual((row["width_cm"], row["height_cm"]), (8, 22))
        self.assertEqual(project, original)
        explicit = copy.deepcopy(project)
        product_render.active_product(explicit)["params"]["objects"][0]["height_basis"] = "bounds"
        declared = pipeline.physical_inputs(explicit, report)["objects"][0]
        self.assertEqual(declared["height_basis"], "bounds")
        self.assertEqual(declared["nominal_letter_height_cm"], 10)
        self.assertIsNone(declared["body_height_cm"])
        self.assertIsNone(declared["height_reference_text"])

    def test_explicit_lowercase_reference_is_recorded_with_complete_ink_bounds(self):
        obj = body_text("Йно", "н", height_reference="lowercase", x_cm=30, y_cm=60)
        _, project, report, *_ = app.prepare(independent_payload([obj], engine="codex_two_stage"))
        row = pipeline.physical_inputs(project, report)["objects"][0]
        self.assertEqual(row["height_reference"], "lowercase")
        self.assertEqual(row["height_reference_case"], "lowercase")
        self.assertEqual(row["height_reference_text"], "н")
        self.assertEqual(row["body_height_cm"], obj["letter_height_cm"])
        self.assertGreater(row["height_cm"], row["body_height_cm"])

    def test_body_sizing_metadata_change_invalidates_neutral_cache(self):
        obj = body_text(x_cm=30, y_cm=60)
        body = independent_payload([obj], engine="codex_two_stage")
        body["request_id"] = "body-reference-cache-auto-0001"
        first = self.submit(body)
        self.assertEqual(first["status"], "complete", first)
        changed = copy.deepcopy(body)
        changed["request_id"] = "body-reference-cache-explicit-0002"
        changed["project"]["products"][0]["params"]["objects"][0]["height_reference"] = "uppercase"
        second = self.submit(changed)
        self.assertEqual(second["status"], "complete", second)
        self.assertEqual(len(self.calls), 4)
        self.assertEqual(second["audit"]["ai_calls_this_job"], 2)

    def test_explicit_shared_construction_is_preserved_and_invalidates_cache(self):
        self.assertEqual(self.submit(self.body())["status"], "complete")
        body = self.body("two-stage-explicit-construction-0002")
        construction = {"version": 1, "face": {"material": "polycarbonate", "thickness_mm": 4},
                        "returns": {"material": "aluminium", "finish": "matte"}, "provenance": "user_project_input"}
        body["project"]["products"][0]["params"]["construction"] = construction
        job = self.submit(body)
        self.assertEqual(job["status"], "complete", job)
        self.assertEqual(len(self.calls), 4)
        saved = json.loads((self.output / job["id"] / "project.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["products"][0]["params"]["construction"], construction)

    def test_raw_client_input_is_restored_if_an_image_worker_changes_it(self):
        def malicious(*args, **kwargs):
            result = self.render(*args, **kwargs)
            (args[0].parent / "input-project.json").write_text("{}", encoding="utf-8")
            return result
        self.service.renderer = malicious
        body = self.body()
        job = self.submit(body)
        self.assertEqual(job["status"], "failed")
        restored = json.loads((self.output / job["id"] / "input-project.json").read_text(encoding="utf-8"))
        self.assertEqual(restored, body["project"])
        self.assertEqual(self.service.inputs, {})
        self.assertEqual(len(self.calls), 1)

    def test_stage2_failure_keeps_checkpoint_without_automatic_retry(self):
        def fail_stage2(*args, **kwargs):
            if not kwargs["transparent_background"]:
                self.calls.append({"failure": True})
                raise RuntimeError("Controlled stage2 failure")
            return self.render(*args, **kwargs)
        self.service.renderer = fail_stage2
        failed = self.submit(self.body())
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(len(self.calls), 2)
        checkpoint = self.output / failed["id"] / pipeline.CHECKPOINT
        self.assertEqual(json.loads(checkpoint.read_text(encoding="utf-8"))["status"], "complete")
        self.assertTrue(failed["has_product_neutral"])
        self.assertNotIn("audit", failed)
        # Resubmitting the same ID remains the failed job and issues no paid call.
        self.service.submit(self.body())
        self.assertEqual(len(self.calls), 2)
        self.service.renderer = self.render
        completed = self.submit(self.body("two-stage-after-failure-0002"))
        self.assertEqual(completed["status"], "complete", completed)
        self.assertEqual(len(self.calls), 3)

    def test_corrupted_cache_source_or_png_is_not_reused(self):
        first = self.submit(self.body())
        folder = self.output / first["id"]
        (folder / "product-neutral.png").write_bytes(b"corrupt")
        second = self.submit(self.body("two-stage-corrupt-png-0002"))
        self.assertEqual(second["status"], "complete", second)
        self.assertEqual(len(self.calls), 4)
        (self.output / second["id"] / "project.json").write_text("{}", encoding="utf-8")
        third = self.submit(self.body("two-stage-corrupt-source-0003"))
        self.assertEqual(third["status"], "complete", third)
        self.assertEqual(len(self.calls), 6)

    def test_symlinked_cache_artifacts_are_not_reused(self):
        first = self.submit(self.body())
        folder = self.output / first["id"]
        original = folder / "product-neutral.png"
        copy_file = folder / "neutral-other.png"
        copy_file.write_bytes(original.read_bytes())
        original.unlink()
        try:
            original.symlink_to(copy_file)
        except OSError:
            self.skipTest("This account cannot create Windows symlinks")
        second = self.submit(self.body("two-stage-symlink-0002"))
        self.assertEqual(second["status"], "complete", second)
        self.assertEqual(len(self.calls), 4)

    def test_manufacturing_snapshot_mutation_rejects_generated_result(self):
        def malicious(*args, **kwargs):
            result = self.render(*args, **kwargs)
            if not kwargs["transparent_background"]:
                (args[0].parent / "production-spec.json").write_text("{}", encoding="utf-8")
            return result
        self.service.renderer = malicious
        job = self.submit(self.body())
        self.assertEqual(job["status"], "failed")
        self.assertIn("неизменности", job["message"])
        self.assertFalse((self.output / job["id"] / "render.png").exists())
        restored_spec = json.loads((self.output / job["id"] / "production-spec.json").read_text(encoding="utf-8"))
        self.assertEqual(restored_spec["format"], "signage-production-input")

    def test_neutral_requires_transparent_background_and_never_retries(self):
        def opaque(*args, **kwargs):
            return self.render(*args, **kwargs).convert("RGB")
        self.service.renderer = opaque
        job = self.submit(self.body())
        self.assertEqual(job["status"], "failed")
        self.assertIn("прозрачный фон", job["message"])
        self.assertEqual(len(self.calls), 1)

    def test_empty_neutral_product_is_rejected_without_second_stage(self):
        def empty(*args, **kwargs):
            image = self.render(*args, **kwargs)
            return Image.new("RGBA", image.size)
        self.service.renderer = empty
        job = self.submit(self.body())
        self.assertEqual(job["status"], "failed")
        self.assertIn("пустой прозрачный", job["message"])
        self.assertEqual(len(self.calls), 1)

    def test_old_failed_job_preserves_recorded_engine_and_missing_optional_artifacts(self):
        body = self.body()
        source, project, *_ = app.prepare(body)
        folder = self.output / body["request_id"]
        folder.mkdir()
        (folder / "project.json").write_text(app.saved_project_json(project), encoding="utf-8")
        (folder / "job.json").write_text(json.dumps({"status": "failed", "engine": "codex_composite", "message": "Old failure"}), encoding="utf-8")
        saved = self.service.saved_job(body["request_id"])
        self.assertEqual(saved["status"], "failed")
        self.assertEqual(saved["engine"], "codex_composite")
        self.assertFalse(saved["has_product_neutral"] or saved["has_layout_guide"] or saved["has_production_spec"])

    def test_common_scale_for_all_objects_and_no_lossy_source_rewriting(self):
        body = self.body()
        _, project, report, *_ = app.prepare(body)
        sheet, details, raw = pipeline.product_guide(project, report)
        self.assertLessEqual(max(sheet.size), 4096)
        self.assertLessEqual(sheet.width * sheet.height, 20_000_000)
        for row in details["rows"]:
            width = row["box_px"][2] - row["box_px"][0]
            self.assertAlmostEqual(width / row["width_cm"], details["pixels_per_cm"], delta=1 / row["width_cm"])
        self.assertEqual([hashlib.sha256(data).hexdigest() for data in raw], [row["artwork_sha256"] for row in details["rows"]])

    def test_twenty_objects_have_complete_common_sheet_and_bounded_reference_count(self):
        objects = [logo(f"logo-{index}", x_cm=30 + index % 5 * 45, y_cm=65 + index // 5 * 25) for index in range(20)]
        body = independent_payload(objects, engine="codex_two_stage")
        job = self.submit(body)
        self.assertEqual(job["status"], "complete", job)
        self.assertEqual(len(job["audit"]["product_guide"]["rows"]), 20)
        self.assertEqual(len(self.calls[0]["references"]), 1)

    def test_roi_layout_matches_full_canvas_projection(self):
        body = self.body()
        body["project"]["products"][0]["params"]["objects"][0]["rotation_deg"] = 8
        base, project, report, *_ = app.prepare(body)
        expected = base.convert("RGBA")
        objects = product_render.active_product(project)["params"]["objects"]
        for obj, layout in zip(objects, report["sign_layout"]["objects"]):
            art, _ = pipeline.letter_objects._decode_object_artwork(obj)
            expected = Image.alpha_composite(expected, product_render.warp(art, base.size, layout["polygon_px"]))
        actual = pipeline.layout_guide(base, project, report)
        delta = np.abs(np.asarray(actual).astype(int) - np.asarray(expected.convert("RGB")).astype(int))
        # Translating the homography changes float rounding at antialiased edges,
        # but does not move the projected footprint.
        self.assertLessEqual(int(delta.max()), 2)
        self.assertEqual(ImageChops.difference(actual, base).getbbox(),
                         ImageChops.difference(expected.convert("RGB"), base).getbbox())

    def test_large_photo_guide_warps_only_object_regions(self):
        body = self.body()
        _, project, report, *_ = app.prepare(body)
        base = Image.new("RGB", (5000, 4000), "#aaaabb")
        with mock.patch("product_render.warp", wraps=product_render.warp) as warp:
            guide = pipeline.layout_guide(base, project, report)
        self.assertEqual(guide.size, (5000, 4000))
        self.assertEqual(warp.call_count, 2)
        for call in warp.call_args_list:
            width, height = call.args[1]
            self.assertLess(width * height, 1000)

    def test_explicit_retouch_is_third_call_and_reported(self):
        original_render = self.service.renderer
        def render_with_retouch(folder, prompt, canvas, guide, **kwargs):
            if folder.name == "scene-retouch":
                self.calls.append({"folder": folder, "retouch": True})
                with Image.open(canvas) as source:
                    return source.convert("RGB")
            return original_render(folder, prompt, canvas, guide, **kwargs)
        self.service.renderer = render_with_retouch
        body = self.body()
        body["project"]["generation"]["scene_retouch"] = {"mode": "ideal_environment", "removals": ["litter"]}
        job = self.submit(body)
        self.assertEqual(job["status"], "complete", job)
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(job["audit"]["ai_calls_this_job"], 3)


if __name__ == "__main__":
    unittest.main()
