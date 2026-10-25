"""Regression: arbitrary AI size/position cannot become final sign geometry."""
import copy
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw

import exact_letter_installation as installation
import product_render
import render_server as app
import two_stage_letters as pipeline
from test_letter_objects import independent_payload, logo
from test_facade_projection import facade_payload


class ExactInstallation(unittest.TestCase):
    def install(self, body, *, drift=False):
        base, project, report, mode, quad, mask = app.prepare(body)
        sheet, metadata, _ = pipeline.product_guide(project, report)
        neutral = sheet.copy()
        if drift:
            # Deliberately broken model geometry: a small arbitrary blob far
            # from the requested place, with an unrelated hole and RGB colour.
            neutral = Image.new("RGBA", sheet.size)
            ImageDraw.Draw(neutral).ellipse((20, 30, 90, 100), fill=(38, 105, 212, 255))
            ImageDraw.Draw(neutral).rectangle((40, 40, 50, 50), fill=(0, 0, 0, 0))
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            result, audit = installation.install(base, mask, project, report, neutral, sheet, metadata, folder)
            front = Image.open(folder / "front-mask.png").copy()
        return base, project, report, mask, result, audit, front

    def test_generated_shrink_shift_and_holes_cannot_change_final_source_geometry(self):
        body = independent_payload([logo(x_cm=40, y_cm=60, width_cm=40)], engine="codex")
        normal = self.install(body)
        drifted = self.install(body, drift=True)
        self.assertEqual(normal[-1].tobytes(), drifted[-1].tobytes())
        # The opaque source interior, including its source spacing, is 2 px
        # inside each edge after scaling 20x10 artwork to 40x20 photo pixels.
        front = np.asarray(drifted[-1])
        self.assertEqual(Image.fromarray(np.where(front >= 128, 255, 0).astype("uint8")).getbbox(), (42, 62, 78, 78))
        self.assertFalse(np.array_equal(np.asarray(normal[-3]), np.asarray(drifted[-3])))
        obj = drifted[-2]["objects"][0]
        self.assertEqual(obj["source_alpha_sha256"], obj["front_alpha_sha256"])
        self.assertFalse(obj["geometry_from_generated_pixels"])

    def test_size_position_and_rotation_change_final_mask_without_model_geometry(self):
        source = independent_payload([logo(x_cm=40, y_cm=60)], engine="codex")
        first = self.install(source, drift=True)[-1]
        moved = copy.deepcopy(source)
        moved["project"]["products"][0]["params"]["objects"][0].update(x_cm=90, y_cm=100)
        second = self.install(moved, drift=True)[-1]
        self.assertEqual(tuple(b-a for a, b in zip(first.getbbox(), second.getbbox())), (50, 40, 50, 40))
        resized = copy.deepcopy(source)
        resized["project"]["products"][0]["params"]["objects"][0].update(width_cm=40)
        third = self.install(resized, drift=True)[-1]
        self.assertGreater(third.getbbox()[2]-third.getbbox()[0], first.getbbox()[2]-first.getbbox()[0])
        resized["project"]["products"][0]["params"]["objects"][0].update(rotation_deg=90)
        fourth = self.install(resized, drift=True)[-1]
        box3, box4 = third.getbbox(), fourth.getbbox()
        self.assertEqual(box3[2]-box3[0], box4[3]-box4[1])

    def test_curved_facade_final_mask_matches_original_alpha_projected_independently(self):
        body = facade_payload(objects=True)
        base, project, report, mask, result, audit, front = self.install(body)
        expected = Image.new("L", base.size)
        for obj, layout in zip(project["sign"]["objects"], report["sign_layout"]["objects"]):
            art, _ = pipeline.letter_objects._decode_object_artwork(obj)
            full = product_render.warp(art, base.size, layout["polygon_px"],
                projection=layout["local_to_image"], local_size=(layout["width_cm"], layout["height_cm"]),
                boundary=layout["boundary_px"])
            expected = ImageChops.lighter(expected, full.getchannel("A"))
        expected = ImageChops.multiply(expected, mask)
        self.assertEqual(front.tobytes(), expected.tobytes())
        protected = np.asarray(mask) == 0
        self.assertTrue(np.array_equal(np.asarray(base)[protected], np.asarray(result)[protected]))
        self.assertTrue(audit["exact_front_geometry"])

    def test_two_rows_keep_independent_appearance_and_overlap_order(self):
        objects = [logo("a", x_cm=60, y_cm=70), logo("b", x_cm=65, y_cm=72)]
        body = independent_payload(objects, engine="codex")
        base, project, report, _, _, mask = app.prepare(body)
        sheet, metadata, _ = pipeline.product_guide(project, report)
        neutral = sheet.copy()
        for row, colour in zip(metadata["rows"], ("#ff0000", "#00ff00")):
            region = neutral.crop(tuple(row["box_px"]))
            tint = Image.new("RGBA", region.size, colour)
            tint.putalpha(region.getchannel("A"))
            neutral.paste(tint, tuple(row["box_px"][:2]))
        with tempfile.TemporaryDirectory() as temporary:
            result, _ = installation.install(base, mask, project, report, neutral, sheet, metadata, Path(temporary))
        self.assertEqual(result.getpixel((68, 75)), (0, 255, 0))
        self.assertEqual(result.getpixel((62, 74)), (255, 0, 0))

    def test_front_never_silently_clipped_and_effects_stay_in_zone(self):
        body = independent_payload([logo(x_cm=40, y_cm=60, depth_cm=20)], engine="codex")
        base, project, report, _, _, mask = app.prepare(body)
        sheet, metadata, _ = pipeline.product_guide(project, report)
        with tempfile.TemporaryDirectory() as temporary:
            clipped = mask.copy()
            ImageDraw.Draw(clipped).rectangle((40, 60, 50, 70), fill=0)
            with self.assertRaisesRegex(product_render.ProductError, "обрезает лицевую"):
                installation.install(base, clipped, project, report, sheet, sheet, metadata, Path(temporary))
        normal = self.install(body)
        protected = np.asarray(normal[3]) == 0
        self.assertTrue(np.array_equal(np.asarray(normal[0])[protected], np.asarray(normal[4])[protected]))

    def test_illumination_overrides_do_not_change_source_alpha(self):
        body = independent_payload([logo(x_cm=40, y_cm=60, depth_cm=8)], engine="codex")
        day = self.install(body)
        body["project"]["generation"]["lighting"] = "night"
        night = self.install(body)
        self.assertEqual(day[-1].tobytes(), night[-1].tobytes())
        self.assertTrue(night[-2]["objects"][0]["illumination_on"])
        body["project"]["products"][0]["params"]["objects"][0]["lighting"] = "off"
        self.assertFalse(self.install(body)[-2]["objects"][0]["illumination_on"])


if __name__ == "__main__":
    unittest.main()
