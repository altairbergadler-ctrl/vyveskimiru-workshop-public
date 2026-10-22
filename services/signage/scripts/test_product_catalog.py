"""Shared catalog/family extension contracts and real deterministic composition, no AI."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import numpy as np
from PIL import Image

import product_catalog as catalog
import product_render as products
import render_server as app
from test_product_render import artwork, product_payload


def family_payload(family, **params):
    body = product_payload()
    product = body["project"]["products"][0]
    product.update(type=family, renderer_family=family, renderer_version=1,
                   module_snapshot={"label": family, "renderer_family": family, "renderer_version": 1},
                   catalog_snapshot={"id": "saved-fixture", "version": 1, "label": "Saved fixture", "category": "Fixture"})
    product["params"] = {"text": "", "font_family": "Arial", "font_bold": True,
                         "text_align": "center", "line_gap_cm": 0, "front_color": "#ef1020", "brief": "", **params}
    return body


class CatalogContracts(unittest.TestCase):
    def test_family_v1_artwork_contract_cannot_be_redeclared(self):
        source = catalog.public_catalog()
        try:
            with tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / "catalog.json"
                for family_id, change in (("cutout", {"artwork_mode": "text_or_upload"}),
                                          ("neon", {"requires_transparency": False}),
                                          ("flat_print", {"requires_transparency": True}),
                                          ("channel_letters", {"artwork_mode": "text_or_upload"})):
                    raw = copy.deepcopy(source)
                    next(item for item in raw["families"] if item["id"] == family_id).update(change)
                    path.write_text(json.dumps(raw), encoding="utf-8")
                    catalog.load_catalog.cache_clear()
                    with mock.patch.object(catalog, "CATALOG_PATH", path):
                        with self.subTest(family=family_id), self.assertRaises(catalog.CatalogError):
                            catalog.load_catalog()
        finally:
            catalog.load_catalog.cache_clear()

    def test_catalog_is_one_shared_file_with_only_trusted_family_versions(self):
        data = catalog.load_catalog()
        self.assertEqual(catalog.public_catalog(), json.loads(catalog.CATALOG_PATH.read_text(encoding="utf-8")))
        self.assertEqual(set(data["families"]), set(catalog.RENDERER_FAMILIES))
        for module in data["modules"].values():
            with self.subTest(module=module["type"]):
                self.assertEqual(module["renderer_version"], 1)
                self.assertIn(module["renderer_family"], catalog.RENDERER_FAMILIES)
        # Every published preset can be instantiated and server-validated. The
        # exact artwork is supplied only on rendering, as in the real editor.
        for template in data["templates"].values():
            module = data["modules"][template["type"]]
            family = data["families"][module["renderer_family"]]
            body = family_payload(module["renderer_family"])
            product = body["project"]["products"][0]
            product.update(type=module["type"], template_id=template["id"], template_version=template["version"],
                           renderer_family=family["id"], renderer_version=family["version"],
                           module_snapshot={"label": module["label"], "renderer_family": family["id"], "renderer_version": 1, "module_version": 1,
                                            "field_schema": copy.deepcopy(module.get("field_schema", []))},
                           catalog_snapshot={"id": template["id"], "version": template["version"], "label": template["label"],
                                             "artwork_policy": template.get("artwork_policy", "text_or_upload"),
                                             "requires_uploaded_artwork": template.get("requires_uploaded_artwork", False)},
                           params={**family["defaults"], **{field["key"]: field["default"] for field in module.get("field_schema", []) if "default" in field},
                                   **module.get("defaults", {}), **template.get("params", {})},
                           placement={"center_px": [160, 100], **template["default_placement"]})
            product.pop("artwork", None)
            if family["id"] == "channel_letters" and not product["params"].get("text", "").strip():
                # Empty text is a valid catalog starting point; rendering later
                # requires the user's text. Supply fixture content for that gate.
                product["params"]["text"] = "CATALOG VALIDATION"
            with self.subTest(template=template["id"]):
                products.normalize_project(body["project"])

    def test_new_data_module_and_extra_field_need_no_renderer_change(self):
        data = copy.deepcopy(catalog.load_catalog())
        data["modules"]["custom_information"] = {
            "type": "custom_information", "label": "Custom panel", "module_version": 1,
            "renderer_family": "flat_print", "renderer_version": 1,
            "field_schema": [{"key": "owner_reference", "label": "Reference", "kind": "string", "max_length": 40}],
            "defaults": {"margin_mm": 999}}
        body = family_payload("flat_print", owner_reference="ORDER-123", margin_mm=2)
        body["project"]["products"][0]["type"] = "custom_information"
        with mock.patch.object(catalog, "load_catalog", return_value=data):
            normalized = products.normalize_project(body["project"])
            self.assertEqual(products.renderer_family(normalized["products"][0]), "flat_print")
            self.assertEqual(normalized["products"][0]["params"]["margin_mm"], 2)
            self.assertEqual(normalized["products"][0]["params"]["owner_reference"], "ORDER-123")
            body["project"]["products"][0]["params"]["owner_reference"] = "x" * 41
            with self.assertRaises(products.ProductError):
                products.normalize_project(body["project"])

    def test_retired_catalog_type_uses_snapshot_and_pinned_family_defaults(self):
        body = family_payload("flat_print", margin_mm=3)
        product = body["project"]["products"][0]
        product["type"] = "retired_campaign_print"
        before = copy.deepcopy(body["project"])
        normalized = products.normalize_project(body["project"])
        self.assertEqual(body["project"], before)
        self.assertEqual(products.metadata(normalized)["label"], "Saved fixture")
        self.assertEqual(normalized["products"][0]["params"]["margin_mm"], 3)
        self.assertEqual(normalized["products"][0]["params"]["opacity"], 1)
        _, prepared, report, *_ = app.prepare(body)
        self.assertEqual(products.compose_product(app.decode_photo(body["photo"]), app.zone_mask((320, 240), body["project"]["generation"]["edit_polygon_px"]), prepared, report)[1]["product"]["type"], "retired_campaign_print")
        for key, value in (("renderer_family", "uninstalled_geometry"), ("renderer_version", 2), ("module_version", 2)):
            changed = copy.deepcopy(before)
            changed["products"][0][key] = value
            with self.subTest(key=key), self.assertRaises(products.UnsupportedProductError):
                products.normalize_project(changed)
        changed = copy.deepcopy(before)
        changed["products"][0].pop("renderer_family")
        with self.assertRaises(products.UnsupportedProductError):
            products.normalize_project(changed)

    def test_registered_type_cannot_switch_family_or_escalate_saved_capabilities(self):
        body = family_payload("flat_print")
        body["project"]["products"][0].update(renderer_family="neon", capabilities={"ai": True, "corel": True})
        with self.assertRaises(products.ProductError):
            products.normalize_project(body["project"])
        for family in ("plaque", "neon", "flat_print", "lightbox", "cutout"):
            body = family_payload(family)
            body["project"]["products"][0]["capabilities"] = {"ai": True, "corel": True}
            body["project"]["generation"]["engine"] = "codex"
            with self.subTest(family=family), self.assertRaises(products.ProductError):
                products.engine(body["project"])

    def test_extra_schema_snapshot_survives_changed_limits_and_retired_module(self):
        old_field = {"key": "custom_depth", "label": "Owner dimension", "kind": "number", "min": 0, "max": 10, "default": 3}
        data = copy.deepcopy(catalog.load_catalog())
        data["modules"]["saved_custom_panel"] = {"type": "saved_custom_panel", "label": "Panel", "module_version": 1,
            "renderer_family": "flat_print", "renderer_version": 1, "defaults": {},
            "field_schema": [{**old_field, "max": 5}]}
        body = family_payload("flat_print", custom_depth=8)
        product = body["project"]["products"][0]
        product["type"] = "saved_custom_panel"
        product["module_snapshot"]["field_schema"] = [old_field]
        with mock.patch.object(catalog, "load_catalog", return_value=data):
            self.assertEqual(products.normalize_project(body["project"])["products"][0]["params"]["custom_depth"], 8)
            data["modules"].pop("saved_custom_panel")
            self.assertEqual(products.normalize_project(body["project"])["products"][0]["params"]["custom_depth"], 8)
            for key in ("front_color", "margin_mm", "constructor"):
                product["module_snapshot"]["field_schema"] = [{**old_field, "key": key}]
                with self.subTest(key=key), self.assertRaises(products.ProductError):
                    products.normalize_project(body["project"])

    def test_custom_module_remap_keeps_explicit_snapshot_family(self):
        data = copy.deepcopy(catalog.load_catalog())
        data["modules"]["remapped_custom"] = {"type": "remapped_custom", "label": "Now neon", "module_version": 1,
            "renderer_family": "neon", "renderer_version": 1, "defaults": {}, "field_schema": []}
        body = family_payload("flat_print")
        product = body["project"]["products"][0]
        product["type"] = "remapped_custom"
        product["module_snapshot"]["module_version"] = 1
        with mock.patch.object(catalog, "load_catalog", return_value=data):
            normalized = products.normalize_project(body["project"])
            self.assertEqual(products.renderer_family(normalized["products"][0]), "flat_print")
            self.assertEqual(products.engine(normalized), "composite")
            product["module_snapshot"].pop("module_version")
            with self.assertRaises(products.ProductError):
                products.normalize_project(body["project"])

    def test_snapshot_requirement_values_are_typed_metadata(self):
        for key, value in (("label", []), ("artwork_policy", None), ("artwork_policy", "script"), ("requires_uploaded_artwork", "true")):
            body = family_payload("flat_print")
            body["project"]["products"][0]["catalog_snapshot"][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(products.ProductError):
                products.normalize_project(body["project"])
        body = family_payload("flat_print")
        body["project"]["products"][0]["catalog_snapshot"]["artwork_policy"] = "text_or_uploaded"
        normalized = products.normalize_project(body["project"])
        self.assertEqual(normalized["products"][0]["catalog_snapshot"]["artwork_policy"], "text_or_upload")
        self.assertEqual(body["project"]["products"][0]["catalog_snapshot"]["artwork_policy"], "text_or_uploaded")

    def test_schema_rejects_executable_shape_invalid_bounds_and_defaults(self):
        good = {"key": "safe_field", "label": "Value", "kind": "number", "min": 0, "max": 1, "default": 0.5}
        for change in ({"key": "constructor"}, {"key": "nested.value"}, {"label": ""}, {"kind": "script"},
                       {"min": float("nan")}, {"min": None}, {"max": -1}, {"default": "0.5"}):
            with self.subTest(change=change), self.assertRaises(catalog.CatalogError):
                catalog.field_schema([{**good, **change}])
        with self.assertRaises(catalog.CatalogError):
            catalog.field_schema([{"key": "choice", "label": "Choice", "kind": "select", "options": [{"value": "same", "label": "A"}, {"value": "same", "label": "B"}]}])


class FamilyComposition(unittest.TestCase):
    def compose(self, family, **params):
        body = family_payload(family, **params)
        source, project, report, mode, _, mask = app.prepare(body)
        base = app.relight(source, mode)
        result, audit, raw = products.compose_product(base, mask, project, report)
        return result, audit, raw, base, mask

    def test_new_families_preserve_original_bytes_and_protected_pixels(self):
        for family in ("flat_print", "lightbox", "cutout"):
            result, audit, raw, base, mask = self.compose(family)
            with self.subTest(family=family):
                self.assertEqual(raw, products.decode_artwork(artwork())[1])
                self.assertTrue(audit["exact_artwork"])
                self.assertEqual(audit["product"]["renderer_family"], family)
                self.assertEqual(audit["changed_pixels_outside_edit_zone"], 0)
                np.testing.assert_array_equal(np.asarray(result)[np.asarray(mask) == 0], np.asarray(base)[np.asarray(mask) == 0])
                self.assertTrue(np.any(np.asarray(result) != np.asarray(base)))
        self.assertEqual(self.compose("cutout")[1]["geometry_source"], "supplied_object_cutout")

    def test_flat_print_and_cutout_do_not_add_panel_shadow_or_neon(self):
        for family in ("flat_print", "cutout"):
            result, audit, _, base, _ = self.compose(family)
            self.assertFalse(audit["neon_illumination_on"])
            self.assertFalse(audit["lightbox_illumination_on"])
            # The asymmetric PNG has a large transparent corner; a fabricated
            # panel would replace these source pixels.
            np.testing.assert_array_equal(np.asarray(result)[84:88, 199:204], np.asarray(base)[84:88, 199:204])
            invisible, _, _, invisible_base, _ = self.compose(family, opacity=0)
            np.testing.assert_array_equal(np.asarray(invisible), np.asarray(invisible_base))

    def test_lightbox_on_off_and_effect_padding_share_physical_scale(self):
        on, on_audit, *_ = self.compose("lightbox", illumination="on")
        off, off_audit, *_ = self.compose("lightbox", illumination="off")
        self.assertTrue(on_audit["lightbox_illumination_on"])
        self.assertFalse(off_audit["lightbox_illumination_on"])
        self.assertTrue(np.any(np.asarray(on) != np.asarray(off)))
        product = products.normalize_project(family_payload("lightbox")["project"])["products"][0]
        polygon = [[0, 0], [200, 0], [150, 40], [50, 40]]
        self.assertEqual(products.pixel_scale(product, polygon), 1.5)
        self.assertEqual(products.padding_px(product, polygon), 17)
        product["params"]["illumination"] = "off"
        self.assertEqual(products.padding_px(product, polygon), 17)

    def test_cutout_requires_uploaded_transparent_png(self):
        for change in (lambda item: item["artwork"].update(source="text"),
                       lambda item: item["artwork"].update(data_url=app.data_url(Image.new("RGB", (100, 40), "white")))):
            body = family_payload("cutout")
            change(body["project"]["products"][0])
            with self.assertRaises(app.UserError):
                app.prepare(body)

    def test_uploaded_required_snapshot_keeps_qr_artwork_out_of_text_generation(self):
        body = family_payload("plaque")
        product = body["project"]["products"][0]
        product["catalog_snapshot"].update(artwork_policy="uploaded_required", requires_uploaded_artwork=True)
        product["artwork"]["source"] = "text"
        with self.assertRaises(app.UserError):
            app.prepare(body)
        product["artwork"]["source"] = "uploaded"
        self.assertEqual(app.prepare(body)[1]["products"][0]["artwork"]["source"], "uploaded")
        # Old text-capable plaque snapshots keep their original contract even
        # if a current catalog record now requires an uploaded exact original.
        product["catalog_snapshot"].pop("artwork_policy")
        product["catalog_snapshot"].pop("requires_uploaded_artwork")
        product["artwork"]["source"] = "text"
        self.assertEqual(app.prepare(body)[1]["products"][0]["artwork"]["source"], "text")


class UnsupportedHistory(unittest.TestCase):
    def test_unsupported_version_keeps_history_and_raw_artifacts_readable(self):
        with tempfile.TemporaryDirectory() as temporary:
            service = app.Service(temporary, status_reader=lambda: {"configured": False})
            identity = "future-saved-job-0001"
            folder = Path(temporary) / identity
            folder.mkdir()
            project = family_payload("flat_print")["project"]
            project["products"][0]["renderer_version"] = 2
            raw = json.dumps(project, ensure_ascii=False).encode("utf-8")
            (folder / "project.json").write_bytes(raw)
            (folder / "source.png").write_bytes(app.png_bytes(Image.new("RGB", (320, 240), "white")))
            (folder / "render.png").write_bytes(app.png_bytes(Image.new("RGB", (320, 240), "red")))
            (folder / "audit.json").write_text(json.dumps({"canvas_size_px": [320, 240], "lighting": "original"}), encoding="utf-8")
            job = service.saved_job(identity)
            self.assertEqual(job["status"], "complete")
            self.assertFalse(job["editable"])
            self.assertEqual(job["product"]["label"], "Saved fixture")
            self.assertEqual(service.history()["total"], 1)
            self.assertFalse(service.history()["items"][0]["editable"])
            self.assertEqual(service.artifact(identity, "project.json").read_bytes(), raw)
            self.assertTrue(service.artifact(identity, "render.png").is_file())


if __name__ == "__main__":
    unittest.main()
