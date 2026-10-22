"""Real nonlinear inverse artwork projection; no image generation or live data."""
import copy
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import numpy as np
from PIL import Image, ImageDraw

import facade_projection as facade
import product_render as products
import render_server as app
import letter_objects
import two_stage_letters


def descriptor(k=.9):
    return {"type": "facade_projection_v1", "direction": "forward",
            "matrix": [2, .2, 100, .07, 1.2, 80, .001, .0005, 1],
            "lens": {"k": k, "cx": 200, "cy": 150, "scale": 400, "width": 400, "height": 300}}


def rgba_artwork(size=(100, 40)):
    y, x = np.mgrid[:size[1], :size[0]]
    pixels = np.stack((x*2, y*5, np.full_like(x, 40), np.full_like(x, 255)), axis=-1).astype("uint8")
    pixels[8:15, 22:35, 3] = 0
    return Image.fromarray(pixels, "RGBA")


def facade_payload(*, objects=False):
    from test_product_render import product_payload
    from test_letter_objects import independent_payload, logo
    body = independent_payload([logo(width_cm=60, x_cm=70, y_cm=30)]) if objects else product_payload(mode="original")
    project = body["project"]
    mapping = {"type": "facade_projection_v1", "direction": "forward",
               "matrix": [1, .1, 80, .05, 1, 80, .0003, .0002, 1],
               "lens": {"k": .9, "cx": 200, "cy": 150, "scale": 400, "width": 400, "height": 300}}
    photo_points = lambda points: facade.project_points(mapping, points)
    project["image"] = {"name": "synthetic-facade.png", "width_px": 400, "height_px": 300}
    project["calibration"] = {"mode": "rectangle", "width_cm": 80, "height_cm": 40,
                               "image_points": photo_points([[0, 0], [80, 0], [80, 40], [0, 40]])}
    project["target_polygon_px"] = photo_points([[0, 0], [220, 0], [220, 110], [0, 110]])
    project["facade"] = {"version": 1, "enabled": True, "lens_enabled": True,
                         "edge_points": photo_points([[110, 0], [220, 55], [110, 110], [0, 55]])}
    project["generation"].update(lighting="original", engine="composite", edit_polygon_px=None)
    if not objects:
        project["products"][0]["placement"].update(center_px=photo_points([[110, 55]])[0], width_cm=80, height_cm=30)
    y, x = np.mgrid[:300, :400]
    source = Image.fromarray(np.stack((x % 256, y % 256, (x+y) % 256), axis=-1).astype("uint8"))
    body["photo"] = app.data_url(source)
    return body


class ProjectionMath(unittest.TestCase):
    def test_division_branch_and_matrix_roundtrip_positive_negative(self):
        points = [[0, 0], [100, 0], [100, 40], [0, 40], [50, 20], [14, 31]]
        for k in (-1.1, 0, .9, 1.5):
            with self.subTest(k=k):
                projection = descriptor(k)
                matrix = np.asarray(projection["matrix"]).reshape(3, 3)
                actual = facade.project_points(projection, points)
                for source, result in zip(points, actual):
                    p = matrix @ np.array([*source, 1])
                    ux, uy = p[:2]/p[2]
                    radius = ((ux-200)**2+(uy-150)**2)/400**2
                    factor = 2/(1+np.sqrt(1-4*k*radius))
                    self.assertTrue(np.allclose(result, [200+(ux-200)*factor, 150+(uy-150)*factor], atol=1e-9))
                self.assertTrue(np.allclose(facade.project_points(projection, actual, inverse=True), points, atol=1e-9))

    def test_matches_shared_javascript_descriptor(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("Node.js unavailable")
        geometry = Path(__file__).resolve().parents[1]/"assets"/"geometry.js"
        points = [[0, 0], [100, 40], [30, 8], [50, 20]]
        code = "const G=require(process.argv[1]);const p=JSON.parse(process.argv[2]);process.stdout.write(JSON.stringify(p.points.map(x=>G.apply(p.projection,x))));"
        run = subprocess.run([node, "-e", code, str(geometry), json.dumps({"projection": descriptor(), "points": points})], capture_output=True, text=True, timeout=15)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertTrue(np.allclose(json.loads(run.stdout), facade.project_points(descriptor(), points), atol=1e-7))

    def test_rejects_bad_models_and_unsafe_field(self):
        for mutation in (lambda p: p.update(matrix=[0]*9), lambda p: p["lens"].update(k=4),
                         lambda p: p["lens"].update(scale=0), lambda p: p["lens"].update(cx=float("nan")),
                         lambda p: p.update(direction="inverse")):
            p = descriptor()
            mutation(p)
            with self.subTest(projection=p), self.assertRaises(facade.ProjectionError):
                facade.project_points(p, [[0, 0]])


class RasterProjection(unittest.TestCase):
    def test_identity_preserves_source_rgba_and_transparent_holes(self):
        art = rgba_artwork()
        art.putpixel((50, 20), (143, 81, 27, 128))
        projection = descriptor(0)
        projection["matrix"] = [1, 0, 40, 0, 1, 50, 0, 0, 1]
        output = facade.warp_rgba(art, (200, 150), projection, (100, 40))
        expected = np.asarray(art).copy()
        expected[expected[:, :, 3] == 0, :3] = 0
        self.assertTrue(np.array_equal(np.asarray(output)[50:90, 40:140], expected))
        self.assertEqual(output.getpixel((65, 60))[3], 0)
        allowed = np.zeros((150, 200), dtype=bool)
        allowed[50:90, 40:140] = True
        self.assertFalse(np.any(np.asarray(output)[:, :, 3][~allowed]))

    def test_nonlinear_mapping_is_not_corner_homography_and_crop_is_identical(self):
        art, projection, size = rgba_artwork(), descriptor(1.5), (400, 300)
        original = copy.deepcopy(projection)
        corners = facade.project_points(projection, [[0, 0], [100, 0], [100, 40], [0, 40]])
        boundary = facade.boundary_points(projection, (100, 40))
        output = facade.warp_rgba(art, size, projection, (100, 40), boundary=boundary)
        homography = products.warp(art, size, corners)
        differences = np.any(np.asarray(output) != np.asarray(homography), axis=2)
        self.assertGreater(np.count_nonzero(differences), 500)
        self.assertEqual(projection, original)
        crop = facade.warp_rgba(art, (260, 160), projection, (100, 40), boundary=boundary, destination_offset=(60, 40))
        self.assertTrue(np.array_equal(np.asarray(crop), np.asarray(output.crop((60, 40, 320, 200)))))
        # Compare raster RGB against the inverse-mapped source gradient at real
        # destination pixel centres, away from the deliberate transparent hole.
        for local in ([10, 6], [55, 20], [80, 30]):
            projected = facade.project_points(projection, [local])[0]
            x, y = (int(value) for value in projected)
            sx, sy = facade.project_points(projection, [[x+.5, y+.5]], inverse=True)[0]
            actual = np.asarray(output)[y, x]
            self.assertEqual(actual[3], 255)
            self.assertLessEqual(abs(float(actual[0])-(sx-.5)*2), 1)
            self.assertLessEqual(abs(float(actual[1])-(sy-.5)*5), 1)

    def test_product_warp_uses_descriptor_not_four_corners(self):
        art, projection = rgba_artwork(), descriptor()
        corners = facade.project_points(projection, [[0, 0], [100, 0], [100, 40], [0, 40]])
        expected = facade.warp_rgba(art, (400, 300), projection, (100, 40))
        actual = products.warp(art, (400, 300), corners, projection=projection, local_size=(100, 40))
        self.assertTrue(np.array_equal(np.asarray(actual), np.asarray(expected)))


class CurvedMasks(unittest.TestCase):
    def test_nonconvex_boundary_includes_edges_and_rejects_chord_only_fit(self):
        boundary = [[20, 20], [80, 20], [70, 50], [80, 80], [20, 80], [30, 50]]
        self.assertTrue(app.contains(boundary, [[30, 50], [40, 40], [60, 60]]))
        self.assertFalse(app.contains(boundary, [[22, 50]]))
        self.assertTrue(app.contains([[20, 20], [80, 20], [80, 80], [20, 80]], [[22, 50]]))
        checked = app.validate_boundary(boundary, (100, 100))
        mask = app.zone_mask((100, 100), checked)
        self.assertEqual(mask.getpixel((22, 50)), 0)
        self.assertEqual(mask.getpixel((50, 50)), 255)
        base = Image.new("RGB", (100, 100), "#314159")
        generated = Image.new("RGB", (100, 100), "#ed1234")
        result, audit = app.compose(base, generated, mask, base.size, base.size)
        protected = np.asarray(mask) == 0
        self.assertTrue(np.array_equal(np.asarray(base)[protected], np.asarray(result)[protected]))
        self.assertEqual(audit["changed_pixels_outside_edit_zone"], 0)


class SharedGeometryIntegration(unittest.TestCase):
    def test_real_node_report_product_and_object_paths_preserve_protected_photo(self):
        for objects in (False, True):
            with self.subTest(objects=objects):
                body = facade_payload(objects=objects)
                original = copy.deepcopy(body)
                source, project, report, _, boundary, mask = app.prepare(body)
                self.assertEqual(body, original)
                self.assertEqual(len(boundary), 128)
                self.assertAlmostEqual(report["calibration"]["worldToImage"]["lens"]["k"], .9, places=6)
                self.assertEqual(project["facade"], body["project"]["facade"])
                if objects:
                    layout = report["sign_layout"]["objects"][0]
                    self.assertEqual(len(layout["boundary_px"]), 128)
                    result, audit = letter_objects.compose_objects(source, mask, project, report)
                    guide = two_stage_letters.layout_guide(source, project, report)
                    self.assertEqual(guide.size, source.size)
                    # With depth zero and original lighting, the installation
                    # guide uses exactly the same nonlinear artwork projection.
                    self.assertTrue(np.array_equal(np.asarray(guide.convert("RGB")), np.asarray(result)))
                else:
                    layout = report["placement"]
                    result, audit, _ = products.compose_product(source, mask, project, report)
                self.assertTrue(facade.is_facade(layout["local_to_image"]))
                self.assertEqual(len(layout["boundary_px"]), 128)
                self.assertEqual(audit["source_spatial_transform"], "identity")
                self.assertIn("facade_projection", audit["artwork_transform"])
                self.assertEqual(audit["changed_pixels_outside_edit_zone"], 0)
                protected = np.asarray(mask) == 0
                self.assertTrue(np.array_equal(np.asarray(source)[protected], np.asarray(result)[protected]))
                self.assertTrue(np.any(np.asarray(source) != np.asarray(result)))

    def test_independent_explicit_photo_edit_polygon_remains_straight(self):
        body = facade_payload()
        explicit = [[20, 20], [350, 20], [350, 240], [20, 240]]
        body["project"]["generation"]["edit_polygon_px"] = explicit
        self.assertTrue(np.array_equal(app.prepare(body)[4], explicit))

    def test_composite_job_persists_settings_and_original_photo_without_ai(self):
        body = facade_payload(objects=True)
        # Follow the real asynchronous pipeline through its saved render.png.
        # A wide asymmetric gradient exposes a four-corner-only fallback.
        project = body["project"]
        matrix = np.array([[1., .1, 80.], [.05, 1., 80.], [.0003, .0002, 1.]])
        inverse = np.linalg.inv(matrix)
        k, cx, cy, scale = 1.5, 200., 150., 400.

        def photo_point(world):
            homogeneous = matrix @ np.array([*world, 1.])
            ux, uy = homogeneous[:2]/homogeneous[2]
            radius = ((ux-cx)**2+(uy-cy)**2)/scale**2
            factor = 2/(1+np.sqrt(1-4*k*radius))
            return [cx+(ux-cx)*factor, cy+(uy-cy)*factor]

        project["calibration"]["image_points"] = list(map(photo_point, [[0, 0], [80, 0], [80, 40], [0, 40]]))
        project["target_polygon_px"] = list(map(photo_point, [[0, 0], [220, 0], [220, 110], [0, 110]]))
        project["facade"]["edge_points"] = list(map(photo_point, [[110, 0], [220, 55], [110, 110], [0, 55]]))
        art = rgba_artwork()
        obj = project["products"][0]["params"]["objects"][0]
        obj.update(x_cm=20, y_cm=20, width_cm=180, depth_cm=0,
                   artwork={"name": "asymmetric-gradient.png", "mime_type": "image/png", "source": "uploaded",
                            "data_url": app.data_url(art), "width_px": art.width, "height_px": art.height})
        original_body = copy.deepcopy(body)
        _, _, report, _, _, mask = app.prepare(body)
        layout = report["sign_layout"]["objects"][0]
        ai_calls = []
        with tempfile.TemporaryDirectory() as output:
            def forbidden(*args, **kwargs):
                ai_calls.append(True)
                self.fail("This deterministic fixture must never call an AI renderer")
            service = app.Service(output, renderer=forbidden, status_reader=forbidden)
            service.submit(body)
            service.wait_for_workers(timeout=10)
            job = service.public(body["request_id"])
            self.assertEqual(job["status"], "complete", job)
            folder = Path(output)/body["request_id"]
            saved = json.loads((folder/"project.json").read_text("utf-8"))
            self.assertEqual(saved["facade"], body["project"]["facade"])
            self.assertEqual(saved["calibration"], body["project"]["calibration"])
            with Image.open(folder/"source.png") as source:
                self.assertTrue(np.array_equal(np.asarray(source), np.asarray(app.decode_photo(body["photo"]))))
            with Image.open(folder/"render.png") as rendered:
                result = np.asarray(rendered.convert("RGB"))
            source = app.decode_photo(body["photo"])
            original = np.asarray(source)
            protected = np.asarray(mask) == 0
            self.assertTrue(np.array_equal(result[protected], original[protected]),
                            "Saved render must preserve every pixel outside the curved edit zone")
            self.assertGreater(np.count_nonzero(np.any(result != original, axis=2)), 2000)

            # Independent oracle: use the known synthetic lens and matrix,
            # not facade_projection.py or any report-derived transform.
            # Pixel centres inverse-map into the opaque linear RGB gradient.
            for local in ([15, 8], [90, 35], [155, 58]):
                px, py = photo_point([obj["x_cm"]+local[0], obj["y_cm"]+local[1]])
                x, y = int(px), int(py)
                dx, dy = x+.5-cx, y+.5-cy
                denominator = 1+k*(dx*dx+dy*dy)/scale**2
                world = inverse @ np.array([cx+dx/denominator, cy+dy/denominator, 1.])
                wx, wy = world[:2]/world[2]
                sx = (wx-obj["x_cm"])/180*art.width-.5
                sy = (wy-obj["y_cm"])/72*art.height-.5
                with self.subTest(local=local, destination=(x, y)):
                    self.assertTrue(np.allclose(result[y, x], [sx*2, sy*5, 40], atol=1.1),
                                    f"Saved nonlinear pixel {result[y, x]} differs from inverse-mapped gradient")

            # The transparent source hole must reveal the original photograph
            # even after processing and saving the completed job.
            px, py = photo_point([obj["x_cm"]+50, obj["y_cm"]+20])
            self.assertTrue(np.array_equal(result[int(py), int(px)], original[int(py), int(px)]))
            corner_layer = products.warp(art, source.size, layout["polygon_px"])
            corner_result = np.asarray(Image.alpha_composite(source.convert("RGBA"), corner_layer).convert("RGB"))
            self.assertGreater(np.count_nonzero(np.any(result != corner_result, axis=2)), 500,
                               "Saved render must not silently fall back to four-corner projection")
            audit = json.loads((folder/"audit.json").read_text("utf-8"))
            self.assertEqual(audit["changed_pixels_outside_edit_zone"], 0)
            self.assertIn("facade_projection", audit["artwork_transform"])
            self.assertEqual(ai_calls, [])
            self.assertEqual(body, original_body, "A complete render must not mutate source inputs")
            service.jobs.clear()
            self.assertEqual(service.public(body["request_id"])["status"], "complete")
            reloaded = app.Service(output, renderer=forbidden, status_reader=forbidden)
            self.assertEqual(reloaded.public(body["request_id"])["status"], "complete")
            with Image.open(reloaded.artifact(body["request_id"], "render.png")) as restored:
                self.assertTrue(np.array_equal(np.asarray(restored.convert("RGB")), result))
            self.assertEqual(ai_calls, [], "Reading completed history must not call AI")


if __name__ == "__main__":
    unittest.main()
