"""Simulated-scan export tests use only synthetic, non-business documents."""
from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import fitz
from PIL import Image, ImageDraw, ImageStat

from app.pdf_engine import MARKER, SCAN_MARKER, scan_pdf, stamp_pdf


class ScanTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.stamp = self.root / "stamp.png"
        image = Image.new("RGBA", (160, 160), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        draw.ellipse((8, 8, 152, 152), outline=(15, 30, 200, 255), width=12)
        draw.rectangle((40, 40, 70, 70), fill=(210, 15, 25, 255))
        image.save(self.stamp)

    def tearDown(self):
        self.temp.cleanup()

    def make_pdf(self, name="input.pdf", *, rotations=(0, 90, 180, 270), crop=True):
        path = self.root / name
        with fitz.open() as doc:
            for index, rotation in enumerate(rotations):
                page = doc.new_page(width=360, height=260)
                page.insert_text((40, 55), f"SYNTHETIC PAGE {index + 1}", fontsize=14)
                page.draw_rect(fitz.Rect(30, 75, 325, 105), color=(0, 0, 0), width=1)
                page.draw_rect(fitz.Rect(45, 130, 85, 175), fill=(0.05, 0.65, 0.12), color=None)
                if crop:
                    page.set_cropbox(fitz.Rect(20, 10, 340, 245))
                page.set_rotation(rotation)
            doc.save(path)
        return path

    @staticmethod
    def rendered(page, scale=1):
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csRGB, alpha=False)
        return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)

    @staticmethod
    def coloured_pixels(image, colour):
        tests = {
            "blue": lambda p: p[2] > 100 and p[2] > p[0] * 1.6 and p[2] > p[1] * 1.5,
            "red": lambda p: p[0] > 100 and p[0] > p[1] * 1.6 and p[0] > p[2] * 1.6,
            "green": lambda p: p[1] > 80 and p[1] > p[0] * 1.5 and p[1] > p[2] * 1.5,
        }
        width = image.width
        return [(i % width, i // width) for i, pixel in enumerate(image.get_flattened_data()) if tests[colour](pixel)]

    def test_every_page_is_rasterized_with_stamp_colours_and_original_preserved(self):
        original = self.make_pdf()
        stamped = self.root / "stamped.pdf"
        scan = self.root / "scan.pdf"
        original_bytes = original.read_bytes()
        stamp_pdf(original, stamped, self.stamp, {"page": 1, "x": 100, "y": 120, "width": 55, "height": 55})
        stamped_bytes = stamped.read_bytes()
        report = scan_pdf(stamped, scan, seed=123)
        self.assertEqual(report["pages"], 4)
        self.assertTrue(report["simulated_scan"])
        self.assertEqual(report["source_sha256"], hashlib.sha256(stamped_bytes).hexdigest())
        self.assertEqual(report["output_sha256"], hashlib.sha256(scan.read_bytes()).hexdigest())
        self.assertEqual(original.read_bytes(), original_bytes)
        self.assertEqual(stamped.read_bytes(), stamped_bytes)
        with fitz.open(stamped) as before, fitz.open(scan) as after:
            self.assertEqual(len(before), len(after))
            self.assertIn(MARKER, after.metadata["keywords"])
            self.assertIn(SCAN_MARKER, after.metadata["keywords"])
            self.assertIn("Simulated scan", after.metadata["subject"])
            for index, page in enumerate(after):
                with self.subTest(page=index):
                    self.assertEqual(page.rect, before[index].rect)
                    self.assertEqual(page.rotation, 0)
                    self.assertEqual(page.get_text().strip(), "")
                    self.assertEqual(len(page.get_images()), 1)
                    image = self.rendered(page)
                    self.assertGreater(len(self.coloured_pixels(image, "green")), 100)
                    # Original content including black form lines remains visible.
                    gray = image.convert("L")
                    self.assertGreater(sum(gray.histogram()[:90]), 100)
            stamped_scan = self.rendered(after[1])
            for colour in ("blue", "red"):
                pixels = self.coloured_pixels(stamped_scan, colour)
                self.assertGreater(len(pixels), 40)
                self.assertTrue(all(95 <= x <= 160 and 115 <= y <= 180 for x, y in pixels))
        with self.assertRaisesRegex(ValueError, "уже"):
            stamp_pdf(scan, self.root / "duplicate.pdf", self.stamp,
                      {"page": 0, "x": 100, "y": 120, "width": 55, "height": 55})

    def test_profiles_are_visible_and_seed_is_reproducible(self):
        source = self.make_pdf(rotations=(0,), crop=False)
        mean_paper = []
        for profile in ("light", "standard", "strong"):
            path = self.root / f"{profile}.pdf"
            scan_pdf(source, path, profile=profile, dpi=200, seed=42)
            with fitz.open(path) as doc:
                pix = fitz.Pixmap(doc, doc[0].get_images()[0][0])
                self.assertEqual((pix.width, pix.height), (1000, 723))
                image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                paper = image.crop((500, 500, 800, 650))
                mean_paper.append(sum(ImageStat.Stat(paper).mean) / 3)
                # Noise is present on otherwise blank paper at native resolution.
                self.assertGreater(sum(ImageStat.Stat(paper).stddev), 0.3)
        self.assertGreater(mean_paper[0], mean_paper[1])
        self.assertGreater(mean_paper[1], mean_paper[2])
        again = self.root / "standard-again.pdf"
        scan_pdf(source, again, seed=42, dpi=200)
        with fitz.open(self.root / "standard.pdf") as first, fitz.open(again) as second:
            first_pix = fitz.Pixmap(first, first[0].get_images()[0][0])
            second_pix = fitz.Pixmap(second, second[0].get_images()[0][0])
            self.assertEqual(first_pix.samples, second_pix.samples)

    def test_edge_content_survives_skew_without_clipping(self):
        source = self.root / "edge.pdf"
        with fitz.open() as doc:
            page = doc.new_page(width=300, height=240)
            # Coloured marks touch all four page corners. Expand-then-fit must
            # preserve them rather than using an in-place cropped rotation.
            for rect, colour in ((fitz.Rect(0, 0, 15, 15), (1, 0, 0)),
                                 (fitz.Rect(285, 0, 300, 15), (0, 0, 1)),
                                 (fitz.Rect(0, 225, 15, 240), (0, 0.7, 0)),
                                 (fitz.Rect(285, 225, 300, 240), (0, 0, 0))):
                page.draw_rect(rect, fill=colour, color=None)
            doc.save(source)
        result = self.root / "edges-scanned.pdf"
        scan_pdf(source, result, profile="strong", seed=45)
        with fitz.open(source) as before, fitz.open(result) as after:
            original = self.rendered(before[0], 2)
            scanned = self.rendered(after[0], 2)
            for colour in ("red", "blue", "green"):
                # More than 90% survives even with resampling at the page edges.
                self.assertGreater(len(self.coloured_pixels(scanned, colour)),
                                   0.9 * len(self.coloured_pixels(original, colour)))
            black_corner = scanned.crop((555, 440, 600, 480)).convert("L")
            self.assertGreater(sum(black_corner.histogram()[:70]), 750)

    def test_invalid_options_and_existing_files_never_overwrite(self):
        source = self.make_pdf(rotations=(0,))
        for kwargs in ({"profile": "unknown"}, {"profile": None}, {"dpi": 72}, {"dpi": 150.0},
                       {"dpi": True}, {"seed": "42"}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                scan_pdf(source, self.root / "invalid.pdf", **kwargs)
            self.assertFalse((self.root / "invalid.pdf").exists())
        original_bytes = source.read_bytes()
        with self.assertRaisesRegex(ValueError, "отдельным"):
            scan_pdf(source, source)
        existing = self.root / "existing.pdf"
        existing.write_bytes(b"keep existing file")
        with self.assertRaisesRegex(ValueError, "существует"):
            scan_pdf(source, existing)
        self.assertEqual(existing.read_bytes(), b"keep existing file")
        self.assertEqual(source.read_bytes(), original_bytes)

    def test_pixel_budget_is_rejected_before_rasterization(self):
        source = self.root / "huge.pdf"
        with fitz.open() as doc:
            doc.new_page(width=5000, height=5000)
            doc.save(source)
        result = self.root / "huge-scan.pdf"
        with patch.object(fitz.Page, "get_pixmap", side_effect=AssertionError("must preflight first")):
            with self.assertRaisesRegex(ValueError, "слишком большой"):
                scan_pdf(source, result)
        self.assertFalse(result.exists())
        small = self.make_pdf(rotations=(0, 90))
        with patch("app.pdf_engine.SCAN_MAX_TOTAL_PIXELS", 600_000):
            with self.assertRaisesRegex(ValueError, "слишком большой"):
                scan_pdf(small, result)
        self.assertFalse(result.exists())

    def test_signed_or_encrypted_source_cannot_be_scanned(self):
        source = self.make_pdf(rotations=(0,))
        signed = self.root / "signed.pdf"
        with fitz.open(source) as doc:
            doc.set_metadata({"keywords": MARKER})
            xref = doc.get_new_xref()
            doc.update_object(xref, "<< /Type /Sig /ByteRange [0 10 20 30] /Contents <01> >>")
            doc.xref_set_key(doc.pdf_catalog(), "ExampleSignature", f"{xref} 0 R")
            doc.save(signed)
        with self.assertRaisesRegex(ValueError, "электронную подпись"):
            scan_pdf(signed, self.root / "signed-scan.pdf")
        signature_field = self.root / "signature-field.pdf"
        with fitz.open(source) as doc:
            field = fitz.Widget()
            field.field_name = "Signature"
            field.field_type = fitz.PDF_WIDGET_TYPE_SIGNATURE
            field.rect = fitz.Rect(10, 10, 90, 30)
            doc[0].add_widget(field)
            doc.save(signature_field)
        with self.assertRaisesRegex(ValueError, "поле подписи"):
            scan_pdf(signature_field, self.root / "field-scan.pdf")
        protected = self.root / "protected.pdf"
        with fitz.open(source) as doc:
            doc.save(protected, encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw="reader")
        with self.assertRaisesRegex(ValueError, "паролем"):
            scan_pdf(protected, self.root / "protected-scan.pdf")

    def test_failure_removes_partial_output_and_temp_file(self):
        source = self.make_pdf(rotations=(0,))
        result = self.root / "scan.pdf"
        with patch("app.pdf_engine.shutil.copyfileobj", side_effect=OSError("test disk write failure")):
            with self.assertRaisesRegex(OSError, "disk write"):
                scan_pdf(source, result, seed=1)
        self.assertFalse(result.exists())
        self.assertEqual(list(self.root.glob(".simulated-scan-*")), [])
        self.assertTrue(source.exists())


if __name__ == "__main__":
    unittest.main()
