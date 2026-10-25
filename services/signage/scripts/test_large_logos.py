"""Large uploaded originals survive drafts, saved results and neutral-stage reuse."""
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
from PIL import Image

import commercial_proposal
import codex_render
import letter_objects
import product_render
import render_server as app
from test_letter_objects import independent_payload, logo


def large_logo(size=(1280, 1280)):
    pixels = np.random.default_rng(42).integers(0, 256, (1280, 1280, 4), dtype=np.uint8)
    pixels[:4, :, 3] = 0
    output = io.BytesIO()
    image = Image.new("RGBA", size)
    image.paste(Image.fromarray(pixels), (0, 0))
    image.save(output, format="PNG")
    raw = output.getvalue()
    return {"name": "large-original.png", "mime_type": "image/png", "source": "uploaded",
            "width_px": size[0], "height_px": size[1],
            "data_url": "data:image/png;base64," + base64.b64encode(raw).decode()}, raw


class LargeLogos(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.artwork, cls.raw = large_logo((10000, 2000))

    def test_logo_resolution_and_invalid_dimensions(self):
        image, raw = product_render.decode_logo_artwork(self.artwork)
        self.assertEqual(image.size, (10000, 2000))
        self.assertGreater(image.width * image.height, 16_000_000)
        self.assertEqual(raw, self.raw)
        # Product originals retain their own policy; the exemption is logo-only.
        with self.assertRaises(product_render.ProductError):
            product_render.decode_artwork(self.artwork, max_bytes=None)
        for change in ({"width_px": 0}, {"width_px": True}, {"height_px": -1}, {"width_px": 9999}):
            with self.subTest(change=change), self.assertRaises(product_render.ProductError):
                product_render.decode_logo_artwork({**self.artwork, **change})

    def test_logo_decode_does_not_change_shared_photo_threshold(self):
        # Exercise the same process-wide Pillow gate that rejected the actual
        # 30000x3064 logo, without weakening photo checks in another request.
        with mock.patch.object(Image, "MAX_IMAGE_PIXELS", 10):
            original = logo()["artwork"]
            image, _ = product_render.decode_logo_artwork(original)
            self.assertEqual(image.size, (20, 10))
            self.assertEqual(Image.MAX_IMAGE_PIXELS, 10)
            with self.assertRaises(Image.DecompressionBombError):
                Image.open(io.BytesIO(base64.b64decode(original["data_url"].split(",", 1)[1])))

    def test_draft_round_trip_keeps_original_bytes(self):
        self.assertGreater(len(self.raw), 6 * 1024 * 1024)
        obj = logo(artwork=self.artwork, x_cm=60, y_cm=80)
        _, decoded = letter_objects._decode_object_artwork(obj)
        self.assertEqual(decoded, self.raw)
        body = independent_payload([obj])
        draft = {"base_revision": 0, "name": "Large logo", "generation": None,
                 "snapshot": {"project": body["project"], "photo": body["photo"], "photoKey": "fixture"}}
        with tempfile.TemporaryDirectory() as temp:
            service = app.Service(Path(temp) / "jobs")
            service.save_project("large-logo-project-0001", draft)
            restarted = app.Service(Path(temp) / "jobs")
            restored = restarted.project("large-logo-project-0001")
            self.assertEqual(restored["snapshot"], draft["snapshot"])

    def test_two_stage_history_proposal_and_cache_keep_original(self):
        calls = []

        def renderer(folder, prompt, canvas, guide, **kwargs):
            calls.append(folder)
            # Keep the REAL bridge's input validation and result handling.
            # Only the external CLI invocation is replaced in this test.
            def completed(*args, **options):
                with Image.open(canvas) as source:
                    source.convert("RGBA" if kwargs.get("transparent_background") else "RGB").save(folder / "generated.png")
                (folder / "codex-result.json").write_text(json.dumps({
                    "status": "complete", "image_path": "generated.png", "error": None}), encoding="utf-8")
                return subprocess.CompletedProcess(args[0], 0)
            with mock.patch.object(codex_render, "connection_status", return_value={"configured": True}), \
                    mock.patch.object(codex_render, "_cli_path", return_value="codex"), \
                    mock.patch.object(codex_render.subprocess, "run", side_effect=completed):
                return codex_render.generate(folder, prompt, canvas, guide, **kwargs)

        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "jobs"
            service = app.Service(output, renderer=renderer, status_reader=lambda: {"configured": True})
            body = independent_payload([logo(artwork=self.artwork, x_cm=60, y_cm=80)], engine="codex_two_stage")
            body["request_id"] = "large-logo-two-stage-0001"
            try:
                # An original larger than the shared photo threshold must get
                # through the real bridge as a bounded viewing reference.
                with mock.patch.object(Image, "MAX_IMAGE_PIXELS", 5_000_000):
                    service.submit(body)
                    self.assertTrue(service.wait_for_workers(30))
                job = service.public(body["request_id"])
                self.assertEqual(job["status"], "complete", job)
                self.assertEqual(len(calls), 2)
                with Image.open(output / job["id"] / "stage-1" / "object-001.png") as reference:
                    self.assertEqual(reference.size, (4096, 819))
                    self.assertEqual(reference.mode, "RGBA")
                    self.assertLess(reference.getchannel("A").getextrema()[0], 255)
                row = job["audit"]["product_guide"]["rows"][0]
                self.assertEqual(row["artwork_size_px"], [10000, 2000])
                self.assertEqual(row["generation_reference_size_px"], [4096, 819])
                self.assertTrue(row["generation_reference_resampled"])
                # The canonical legacy mirror makes this exceed the old 8 MiB snapshot cap.
                self.assertGreater((output / job["id"] / "project.json").stat().st_size, 8 * 1024 * 1024)
                restarted = app.Service(output, renderer=renderer, status_reader=lambda: {"configured": True})
                saved = restarted.read_saved(job["id"], "project.json")
                self.assertEqual(saved["products"][0]["params"]["objects"][0]["artwork"], self.artwork)
                proposal = commercial_proposal.source(restarted, job["id"])
                self.assertEqual(proposal["objects"][0]["artwork_sha256"], hashlib.sha256(self.raw).hexdigest())
                moved = copy.deepcopy(body)
                moved["request_id"] = "large-logo-two-stage-0002"
                moved["project"]["products"][0]["params"]["objects"][0]["x_cm"] += 10
                restarted.submit(moved)
                self.assertTrue(restarted.wait_for_workers(30))
                second = restarted.public(moved["request_id"])
                self.assertEqual(second["status"], "complete", second)
                self.assertEqual(len(calls), 3)
                self.assertEqual(second["audit"]["product_stage"]["reused_from_job"], job["id"])
            finally:
                service.wait_for_workers(30)


if __name__ == "__main__":
    unittest.main()
