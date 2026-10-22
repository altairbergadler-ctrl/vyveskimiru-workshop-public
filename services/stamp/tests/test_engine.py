"""Engine regression tests. User invoice fixtures stay outside the distribution."""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import fitz
from PIL import Image, ImageDraw

from app.pdf_engine import inspect_pdf, render_page, stamp_pdf

FONT = os.environ.get("STAMP_TEST_FONT", next((str(path) for path in (
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts/arial.ttf",
) if path.is_file()), "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"))
PRIVATE_ROOT = Path(os.environ.get("STAMP_PRIVATE_FIXTURES", str(Path(__file__).resolve().parents[2])))


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.stamp = self.root / "stamp.png"
        image = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
        ImageDraw.Draw(image).ellipse((5, 5, 195, 195), outline=(0, 0, 200, 255), width=8)
        # Asymmetric corner mark detects accidentally rotated stamp artwork.
        ImageDraw.Draw(image).rectangle((30, 30, 45, 50), fill=(220, 0, 0, 255))
        image.save(self.stamp)

    def tearDown(self):
        self.temp.cleanup()

    def make_pdf(self, *, right=False, inn="7700000000", mp=True, rotation=0,
                 crop=False, pages=1, split=False):
        if not Path(FONT).exists():
            self.skipTest("Для синтетических кириллических PDF нужен DejaVuSans.ttf")
        path = self.root / "input.pdf"
        with fitz.open() as doc:
            for _ in range(pages):
                page = doc.new_page(width=800, height=600)
                page.insert_font(fontname="DejaVu", fontfile=FONT)
                x = 420 if right else 30
                other_x = 30 if right else 420
                page.insert_text((x, 405), f'ООО "Тестовая компания", ИНН {inn}/771401001', fontname="DejaVu", fontsize=8)
                page.insert_text((other_x, 405), 'ООО "Покупатель", ИНН 1234567890/771401001', fontname="DejaVu", fontsize=8)
                if mp:
                    if split:
                        page.insert_text((x + 25, 430), 'М.', fontname="DejaVu", fontsize=10)
                        page.insert_text((x + 42, 430), 'П.', fontname="DejaVu", fontsize=10)
                    else:
                        page.insert_text((x + 25, 430), 'М.П.', fontname="DejaVu", fontsize=10)
                    page.insert_text((other_x + 25, 430), 'М.П.', fontname="DejaVu", fontsize=10)
                page.insert_text((25, 380), '(может не заполняться при проставлении печати в М.П.)', fontname="DejaVu", fontsize=8)
                if crop:
                    page.set_cropbox(fitz.Rect(20, 15, 780, 590))
                page.set_rotation(rotation)
            doc.save(path)
        return path

    def test_target_can_be_on_right(self):
        path = self.make_pdf(right=True)
        report = inspect_pdf(path, stamp_aspect=1)
        self.assertIsNotNone(report["auto_candidate_index"])
        chosen = report["candidates"][report["auto_candidate_index"]]
        self.assertGreater(chosen["x"], 400)
        self.assertIn("7700000000", chosen["matched_identity"])

    def test_merged_text_columns_do_not_swap_companies(self):
        path = self.make_pdf(mp=False)
        merged = self.root / "merged.pdf"
        with fitz.open(path) as doc:
            page = doc[0]
            # Re-create a footer whose left and right organizations occupy a
            # single exporter text span with a broad column gap.
            page.add_redact_annot(fitz.Rect(0, 385, 800, 600), fill=(1, 1, 1))
            page.apply_redactions()
            line = 'ООО Другая, ИНН 1234567890/771401001' + ' ' * 70 + 'ООО Тестовая компания, ИНН 7700000000/771401001'
            page.insert_text((30, 405), line, fontname="DejaVu", fontsize=8)
            page.insert_text((55, 430), 'М.П.', fontname="DejaVu", fontsize=10)
            page.insert_text((420, 430), 'М.П.', fontname="DejaVu", fontsize=10)
            doc.save(merged)
        report = inspect_pdf(merged)
        self.assertIsNotNone(report["auto_candidate_index"])
        chosen = report["candidates"][report["auto_candidate_index"]]
        self.assertGreater(chosen["x"], 400)

    def test_height_over_width_aspect_contract(self):
        report = inspect_pdf(self.make_pdf(), stamp_aspect=1.2)
        chosen = report["candidates"][report["auto_candidate_index"]]
        self.assertAlmostEqual(chosen["height"] / chosen["width"], 1.2)

    def test_no_mp_footnote_is_not_anchor(self):
        report = inspect_pdf(self.make_pdf(mp=False))
        self.assertIsNone(report["auto_candidate_index"])
        self.assertEqual(report["candidates"], [])

    def test_wrong_inn_never_auto(self):
        report = inspect_pdf(self.make_pdf(inn="9999999999"))
        self.assertIsNone(report["auto_candidate_index"])
        self.assertEqual(report["candidates"], [])
        self.assertTrue(any("ИНН" in warning for warning in report["warnings"]))

    def test_multiple_matching_pages_require_review(self):
        report = inspect_pdf(self.make_pdf(pages=2))
        self.assertEqual(len(report["candidates"]), 2)
        self.assertIsNone(report["auto_candidate_index"])

    def test_split_mp_letters(self):
        report = inspect_pdf(self.make_pdf(split=True))
        self.assertIsNotNone(report["auto_candidate_index"])

    def test_rotated_crop_coordinates_and_lossless_artwork(self):
        for rotation in (0, 90, 180, 270):
            with self.subTest(rotation=rotation):
                path = self.make_pdf(rotation=rotation, crop=True)
                report = inspect_pdf(path, stamp_aspect=1)
                self.assertIsNotNone(report["auto_candidate_index"])
                placement = report["candidates"][report["auto_candidate_index"]]
                output = self.root / f"output-{rotation}.pdf"
                with fitz.open(path) as original:
                    before = original[0].get_pixmap(alpha=False)
                    original_text = original[0].get_text()
                    original_size = original[0].rect
                info = stamp_pdf(path, output, self.stamp, placement)
                self.assertEqual(info["page"], 0)
                with fitz.open(output) as stamped:
                    page = stamped[0]
                    self.assertEqual(page.rect, original_size)
                    self.assertEqual(page.rotation, rotation)
                    self.assertEqual(page.get_text(), original_text)
                    after = page.get_pixmap(alpha=False)
                    before_im = Image.frombytes("RGB", (before.width, before.height), before.samples)
                    after_im = Image.frombytes("RGB", (after.width, after.height), after.samples)
                    from PIL import ImageChops
                    # Transparency may change raster blending by a few levels
                    # outside the stamp, without changing source page content.
                    difference = ImageChops.difference(before_im, after_im)
                    changed = difference.point(lambda value: 255 if value > 10 else 0).getbbox()
                    self.assertIsNotNone(changed)
                    self.assertGreaterEqual(changed[0], int(placement["x"]) - 2)
                    self.assertGreaterEqual(changed[1], int(placement["y"]) - 2)
                    self.assertLessEqual(changed[2], placement["x"] + placement["width"] + 2)
                    self.assertLessEqual(changed[3], placement["y"] + placement["height"] + 2)
                    red_pixels = [(i % after.width, i // after.width)
                                  for i, color in enumerate(after_im.getdata())
                                  if color[0] > 150 and color[1] < 80 and color[2] < 80]
                    self.assertTrue(red_pixels)
                    self.assertLess(max(x for x, _ in red_pixels), placement["x"] + placement["width"] / 2)
                    self.assertLess(max(y for _, y in red_pixels), placement["y"] + placement["height"] / 2)
                    xref = page.get_images()[0][0]
                    pix = fitz.Pixmap(stamped, xref)
                    self.assertEqual((pix.width, pix.height), (200, 200))
                self.assertTrue(render_page(output, 0).startswith(b"\x89PNG"))

    def test_duplicate_and_stretch_are_rejected(self):
        source = self.make_pdf()
        report = inspect_pdf(source, stamp_aspect=1)
        placement = report["candidates"][0]
        output = self.root / "stamped.pdf"
        stamp_pdf(source, output, self.stamp, placement)
        with self.assertRaisesRegex(ValueError, "уже"):
            inspect_pdf(output)
        with self.assertRaisesRegex(ValueError, "уже"):
            stamp_pdf(output, self.root / "double.pdf", self.stamp, placement)
        with self.assertRaisesRegex(ValueError, "Пропорции"):
            stamp_pdf(source, self.root / "stretch.pdf", self.stamp, {**placement, "height": 50})

    def test_out_of_bounds_and_nonfinite_rejected(self):
        source = self.make_pdf()
        placement = {"page": 0, "x": 750, "y": 300, "width": 100, "height": 100}
        with self.assertRaisesRegex(ValueError, "границы"):
            stamp_pdf(source, self.root / "bad.pdf", self.stamp, placement)
        with self.assertRaisesRegex(ValueError, "координаты"):
            stamp_pdf(source, self.root / "bad.pdf", self.stamp, {**placement, "x": float("nan")})

    def test_password_pdf_rejected(self):
        source = self.make_pdf()
        protected = self.root / "protected.pdf"
        with fitz.open(source) as doc:
            doc.save(protected, encryption=fitz.PDF_ENCRYPT_AES_256,
                     owner_pw="owner-password", user_pw="reader-password")
        with self.assertRaisesRegex(ValueError, "паролем"):
            inspect_pdf(protected)

    def test_signed_pdf_rejected(self):
        source = self.make_pdf()
        signed = self.root / "signed.pdf"
        with fitz.open(source) as doc:
            xref = doc.get_new_xref()
            doc.update_object(xref, "<< /Type /Sig /ByteRange [0 10 20 30] /Contents <01> >>")
            doc.xref_set_key(doc.pdf_catalog(), "ExampleSignature", f"{xref} 0 R")
            doc.save(signed)
        with self.assertRaisesRegex(ValueError, "электронную подпись"):
            inspect_pdf(signed)

    def test_missing_ocr_does_not_crash_or_auto(self):
        source = self.make_pdf(mp=False)
        with patch.object(fitz.Page, "get_textpage_ocr", side_effect=RuntimeError("not installed")):
            report = inspect_pdf(source, ocr=True)
        self.assertIsNone(report["auto_candidate_index"])
        self.assertTrue(any("OCR" in warning for warning in report["warnings"]))

    def test_ocr_candidate_requires_manual_review(self):
        source = self.make_pdf()
        with fitz.open(source) as native:
            original_page = native[0]
            raster = self.root / "raster.pdf"
            with fitz.open() as scanned:
                page = scanned.new_page(width=800, height=600)
                page.insert_image(page.rect, stream=original_page.get_pixmap(matrix=fitz.Matrix(2, 2)).tobytes("png"))
                scanned.save(raster)
            textpage = original_page.get_textpage()
            with patch.object(fitz.Page, "get_textpage_ocr", return_value=textpage):
                # TextPage belongs to native page, so use its dictionary as a
                # deterministic local OCR fixture rather than a Tesseract install.
                import app.pdf_engine as engine
                real_lines = engine._lines
                native_lines = real_lines(original_page)
                with patch.object(engine, "_lines", side_effect=lambda p, tp=None: native_lines if tp else real_lines(p)):
                    report = inspect_pdf(raster, ocr=True)
        self.assertTrue(report["candidates"])
        self.assertEqual(report["candidates"][0]["source"], "ocr")
        self.assertIsNone(report["auto_candidate_index"])

    def test_original_invoice_fixtures(self):
        paths = [PRIVATE_ROOT / "upload" / name for name in
                 ("01-48-03.07.2026-1-.pdf", "01-50-08.10.2026.pdf", "01-51-08.10.2026.pdf")]
        paths += list((PRIVATE_ROOT / "upload49").glob("*.pdf"))
        available = [path for path in paths if path.exists()]
        if not available:
            self.skipTest("Приватные исходные счета не входят в дистрибутив")
        for path in available:
            with self.subTest(invoice=path.name):
                report = inspect_pdf(path)
                self.assertIsNotNone(report["auto_candidate_index"])
                chosen = report["candidates"][report["auto_candidate_index"]]
                self.assertEqual(chosen["page"], 0)
                self.assertIn("7700000000", chosen["matched_identity"])
                self.assertLess(chosen["x"], 150)
                box = fitz.Rect(chosen["x"], chosen["y"], chosen["x"] + chosen["width"], chosen["y"] + chosen["height"])
                with fitz.open(path) as doc:
                    page = doc[chosen["page"]]
                    for word in page.get_text("words"):
                        self.assertFalse(box.intersects(fitz.Rect(word[:4]) * page.rotation_matrix))


if __name__ == "__main__":
    unittest.main()
