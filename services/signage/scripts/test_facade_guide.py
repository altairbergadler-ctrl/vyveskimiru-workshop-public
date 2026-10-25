"""Captured generator references and calibrated curves; all renderers are local mocks."""
import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib import request

import numpy as np
from PIL import Image

import facade_guide as grid
import facade_projection as projection
import render_server as app
from test_facade_projection import facade_payload
from test_render_server import payload
from history_transfer import export_history, import_history


class FacadeGridReference(unittest.TestCase):
    def test_curved_samples_match_authoritative_projection_at_working_scale(self):
        body = facade_payload(objects=True)
        source, _, report, _, _, mask = app.prepare(body)
        scale = .5
        cues = grid.geometry_cues(report, scale)
        self.assertTrue(cues["lines"])
        self.assertLessEqual(len(cues["lines"]), 20)
        self.assertEqual(cues["pixel_space"], "working_generation_canvas")
        self.assertEqual(cues["original_to_working_scale"], .5)
        self.assertAlmostEqual(cues["model"]["lens"]["k"], .9, places=6)
        max_bow = 0
        for line in cues["lines"]:
            a, b = np.asarray(line["world_endpoints_cm"])
            world = [a+(b-a)*t/8 for t in range(9)]
            self.assertTrue(projection.points_inside(report["calibration"]["target_world_cm"], world))
            expected = np.asarray(projection.project_points(report["calibration"]["worldToImage"], world))*scale
            self.assertTrue(np.allclose(line["samples_px"], expected, atol=.00051))
            self.assertTrue(np.allclose(projection.project_points(cues["model"], world), expected, atol=1e-7))
            edge = expected[-1]-expected[0]
            if np.linalg.norm(edge) > 1e-6:
                midpoint = expected[4]-expected[0]
                max_bow = max(max_bow, abs(edge[0]*midpoint[1]-edge[1]*midpoint[0])/np.linalg.norm(edge))
        self.assertGreater(max_bow, .05, "Fixture must carry a genuinely curved lens cue, not only a projective quadrilateral")
        canvas, *_ = app.model_inputs(source, mask, report, report["calibration"]["target_boundary_px"])
        original = np.asarray(canvas).copy()
        reference, _ = grid.reference_image(canvas, report)
        self.assertTrue(np.array_equal(np.asarray(canvas), original))
        self.assertTrue(np.any(np.asarray(reference) != original))

    def test_editor_grid_preferences_cannot_change_generation_reference(self):
        body = facade_payload(objects=True)
        original = grid.geometry_cues(app.prepare(body)[2])
        changed = copy.deepcopy(body)
        changed["project"]["facade"].update(grid_visible=False, grid_step_cm=777, snap_elements=False, snap_grid=True)
        self.assertEqual(grid.geometry_cues(app.prepare(changed)[2]), original)

    def test_grid_clips_before_lens_projection_outside_irregular_plane(self):
        model = {"type": "facade_projection_v1", "direction": "forward", "matrix": [1, 0, 250, 0, 1, 400, 0, 0, 1],
                 "lens": {"k": 1.7, "cx": 600, "cy": 500, "scale": 1200, "width": 1200, "height": 1000}}
        world = [[0, 0], [700, 0], [400, 450], [300, 450]]
        boundary = []
        for a, b in zip(np.asarray(world), np.roll(np.asarray(world), -1, axis=0)):
            boundary.extend(projection.project_points(model, [a+(b-a)*t/32 for t in range(32)]))
        report = {"calibration": {"worldToImage": model, "target_world_cm": world, "target_boundary_px": boundary}}
        with self.assertRaises(projection.ProjectionError):
            projection.project_points(model, [[50, 450]])
        reference, cues = grid.reference_image(Image.new("RGB", (1200, 1000), "#ccddee"), report)
        self.assertEqual(reference.size, (1200, 1000))
        self.assertTrue(cues["lines"])
        for line in cues["lines"]:
            self.assertTrue(projection.points_inside(world, line["world_endpoints_cm"]))
            self.assertTrue(np.isfinite(line["samples_px"]).all())

    def test_legacy_without_facade_has_no_extra_reference(self):
        report = app.prepare(payload("original"))[2]
        canvas = Image.new("RGB", (320, 240), "#ccddee")
        self.assertIsNone(grid.geometry_cues(report))
        self.assertEqual(grid.reference_image(canvas, report), (None, None))


class CapturedGenerationInputs(unittest.TestCase):
    def run_mock_job(self, body):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        captures = []
        def render(folder, prompt, canvas, guide, *, reference_image_paths=None, transparent_background=False, **kwargs):
            references = list(reference_image_paths or [])
            captures.append({"prompt": prompt, "references": references, "transparent": transparent_background,
                             "preserve_placed_artwork": kwargs.get("preserve_placed_artwork", False)})
            self.assertTrue(all(path.parent == folder and path.is_file() for path in references))
            # Deliberately omit the new fronts from the fake model output. The
            # final compositor must never put them or the diagnostic grid back.
            with Image.open(references[1] if kwargs.get("preserve_placed_artwork") else canvas) as image:
                return image.convert("RGBA" if transparent_background else "RGB")
        service = app.Service(temporary.name, renderer=render, status_reader=lambda: {"configured": True})
        service.submit(body)
        self.assertTrue(service.wait_for_workers(10))
        job = service.public(body["request_id"])
        self.assertEqual(job["status"], "complete", job)
        return captures, job, service

    def test_scene_installation_receives_calibrated_grid_without_a_final_overlay(self):
        body = facade_payload(objects=True)
        body["project"]["generation"]["engine"] = "codex_two_stage"
        original = copy.deepcopy(body)
        captures, job, service = self.run_mock_job(body)
        self.assertEqual(body, original)
        self.assertEqual(len(captures), 2)
        self.assertEqual([path.name for path in captures[1]["references"]],
                         ["render-input.png", "scene-reference.png", "product-neutral.png", "product-guide.png", "facade-grid.png"])
        self.assertTrue(captures[1]["preserve_placed_artwork"])
        self.assertIn("Reference 5", captures[1]["prompt"])
        self.assertIn("Discard stage 1 studio lighting", captures[1]["prompt"])
        spec = json.loads(captures[1]["prompt"].rsplit("\n", 1)[-1])
        expected = grid.geometry_cues(app.prepare(body)[2])
        self.assertEqual(spec["facade_geometry"], expected)
        self.assertTrue(job["audit"]["facade_grid_reference"]["reference_only"])
        self.assertTrue(job["audit"]["no_artwork_overlay_after_generation"])
        self.assertFalse(job["audit"]["exact_front_geometry"])
        self.assertTrue(job["audit"]["geometry_requires_visual_review"])
        self.assertFalse(job["audit"]["exact_artwork"])
        self.assertTrue(service.artifact(job["id"], "facade-grid.png").is_file())
        with tempfile.TemporaryDirectory() as transfer:
            archive, restored = Path(transfer)/"facade-history.zip", Path(transfer)/"restored"
            export_history(service.output, archive)
            import_history(archive, restored)
            self.assertEqual((restored/job["id"]/"facade-grid.png").read_bytes(), service.artifact(job["id"], "facade-grid.png").read_bytes())
        server = app.create_server(0, service.output)
        server.service = service
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = f"http://127.0.0.1:{server.server_port}/api/jobs/{job['id']}/facade-grid.png"
            with request.urlopen(request.Request(url, headers={"X-Editor-Token": service.token}), timeout=5) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.read(), service.artifact(job["id"], "facade-grid.png").read_bytes())
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
        # The target contains the new fronts, while the fifth image alone
        # contains diagnostic grid graphics. Neither is overlaid after the AI.
        with Image.open(captures[1]["references"][0]) as target, Image.open(captures[1]["references"][4]) as guide:
            self.assertTrue(np.any(np.asarray(target) != np.asarray(guide)))
        with Image.open(service.artifact(job["id"], "render.png")) as result, Image.open(service.artifact(job["id"], "source.png")) as source:
            self.assertTrue(np.array_equal(np.asarray(result), np.asarray(source)),
                            "The injected model omitted the fronts; neither fronts nor grid may be pasted back")

    def test_legacy_codex_receives_fourth_grid_reference_and_working_model(self):
        body, scene = payload("original"), facade_payload()
        for key in ("image", "calibration", "target_polygon_px", "facade"):
            body["project"][key] = copy.deepcopy(scene["project"][key])
        body["project"]["placement"] = copy.deepcopy(scene["project"]["products"][0]["placement"])
        body["project"]["generation"].update(engine="codex", edit_polygon_px=None)
        body["photo"] = scene["photo"]
        captures, job, _ = self.run_mock_job(body)
        self.assertEqual(len(captures), 1)
        self.assertEqual([path.name for path in captures[0]["references"]],
                         ["render-input.png", "placement-guide.png", "color-reference.png", "facade-grid.png"])
        self.assertIn("Reference 4 is ONLY", captures[0]["prompt"])
        spec = json.loads(captures[0]["prompt"].rsplit("\n", 1)[-1])
        self.assertEqual(spec["facade_geometry"]["pixel_space"], "working_generation_canvas")
        self.assertTrue(spec["facade_geometry"]["lines"])
        self.assertTrue(job["audit"]["facade_grid_reference"]["reference_only"])
        self.assertFalse(job["audit"]["exact_artwork"])


if __name__ == "__main__":
    unittest.main()
