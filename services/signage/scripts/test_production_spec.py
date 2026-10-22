import base64
import copy
import hashlib
import io
import json
import unittest

from PIL import Image
import production_spec


class ProductionSpecTests(unittest.TestCase):
    def fixture(self):
        stream = io.BytesIO()
        image = Image.new("RGBA", (12, 5), (255, 255, 255, 0))
        image.putpixel((3, 2), (255, 255, 255, 255))
        image.save(stream, "PNG")
        data = stream.getvalue()
        obj = {"id": "source-logo", "type": "logo", "width_cm": 123.456789012345,
               "x_cm": 41.12345, "y_cm": 97.6789, "rotation_deg": 12.5, "depth_cm": 5,
               "side_color": "#001299", "brief": "Акрил, алюминиевые борта; толщину уточнить",
               "artwork": {"mime_type": "image/png", "name": "original.png", "source": "uploaded",
                           "width_px": 12, "height_px": 5,
                           "data_url": "data:image/png;base64," + base64.b64encode(data).decode()}}
        project = {"version": 2, "active_product_id": "letters",
                   "products": [{"id": "letters", "type": "channel_letters", "params": {"objects": [obj],
                                 "face_material": {"type": "custom"}, "brief": "Заказное изделие"}}],
                   "calibration": {"length_cm": 120}, "measurements": [], "checks": []}
        report = {"sign_layout": {"objects": [{"id": "source-logo", "width_cm": obj["width_cm"],
                                                "height_cm": 51.44032875514375}]},
                  "warnings": ["Нет независимого контрольного замера"]}
        return project, report, data

    def test_exact_inputs_and_artwork_provenance_are_immutable(self):
        project, report, data = self.fixture()
        original, original_report = copy.deepcopy(project), copy.deepcopy(report)
        raw = json.dumps(project, ensure_ascii=False, indent=2).encode("utf-8")
        result = production_spec.build(project, report, raw)
        self.assertEqual(project, original)
        self.assertEqual(report, original_report)
        self.assertEqual(result["source"]["project_sha256"], hashlib.sha256(raw).hexdigest())
        obj = result["objects"][0]
        self.assertEqual(obj["front_dimensions_cm"]["width"], 123.456789012345)
        self.assertEqual(obj["source_input"]["x_cm"], 41.12345)
        self.assertEqual(obj["source_input"]["artwork"]["sha256"], hashlib.sha256(data).hexdigest())
        self.assertIsNone(obj["material_input"]["object_materials"])
        self.assertIsNone(obj["vector_contours"])
        self.assertFalse(result["manufacturing_readiness"]["ready"])
        self.assertFalse(result["generated_images_are_manufacturing_sources"])
        result["objects"][0]["source_input"]["depth_cm"] = 999
        self.assertEqual(project, original)

    def test_snapshot_drift_and_bad_geometry_rejected_before_generation(self):
        project, report, _ = self.fixture()
        raw = json.dumps(project).encode()
        project["products"][0]["params"]["objects"][0]["depth_cm"] = 8
        with self.assertRaisesRegex(ValueError, "differ"):
            production_spec.build(project, report, raw)
        project, report, _ = self.fixture()
        raw = json.dumps(project).encode()
        report["sign_layout"]["objects"][0]["width_cm"] = float("nan")
        with self.assertRaisesRegex(ValueError, "dimension"):
            production_spec.build(project, report, raw)

    def test_metadata_must_refer_to_the_same_objects(self):
        project, report, _ = self.fixture()
        raw = json.dumps(project).encode()
        report["sign_layout"]["objects"][0]["id"] = "wrong-object"
        with self.assertRaisesRegex(ValueError, "match"):
            production_spec.build(project, report, raw)

    def test_owner_confirmed_materials_have_provenance_and_unknown_thickness(self):
        project, report, _ = self.fixture()
        original = copy.deepcopy(project)
        received = json.dumps(original).encode()
        prepared = production_spec.with_confirmed_construction(project)
        self.assertEqual(project, original)
        raw = json.dumps(prepared).encode()
        spec = production_spec.build(prepared, report, raw, received)
        construction = spec["objects"][0]["material_input"]["construction"]
        self.assertEqual(construction["face"]["material"], "acrylic")
        self.assertEqual(construction["returns"]["material"], "aluminium")
        self.assertEqual(construction["provenance"]["face_material"], "owner_confirmed")
        self.assertIsNone(construction["face"]["thickness_mm"])
        self.assertIsNone(construction["returns"]["finish"])
        self.assertEqual(spec["source"]["received_input_sha256"], hashlib.sha256(received).hexdigest())
        prepared["products"][0]["params"]["construction"]["returns"]["material"] = "steel"
        again = production_spec.with_confirmed_construction(prepared)
        self.assertEqual(again["products"][0]["params"]["construction"]["returns"]["material"], "steel")


if __name__ == "__main__":
    unittest.main()
