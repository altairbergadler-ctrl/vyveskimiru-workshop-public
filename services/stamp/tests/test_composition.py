"""Composition QA uses synthetic coloured geometry, never a real signature."""
from __future__ import annotations

import hashlib
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import zlib

import fitz
from PIL import Image, ImageChops, ImageDraw

from app import pdf_engine as engine


class CompositionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.stamp = self.artwork('stamp.png', (120, 120), (25, 45, 190, 255))
        self.signature = self.artwork('synthetic-line.png', (400, 80), (170, 25, 35, 170))

    def tearDown(self):
        self.temp.cleanup()

    def artwork(self, name, size, ink):
        path = self.root / name
        with Image.new('RGBA', size, (0, 0, 0, 0)) as image:
            draw = ImageDraw.Draw(image)
            draw.line((8, size[1] // 2, size[0] - 9, size[1] // 2), fill=ink, width=6)
            # An asymmetric upper-left mark proves orientation is preserved.
            draw.rectangle((8, 8, 18, 18), fill=ink)
            image.save(path)
        return path

    def document(self, rotations=(0,)):
        path = self.root / 'original.pdf'
        with fitz.open() as document:
            document.set_metadata({'title': 'SYNTHETIC COMPOSITION QA', 'keywords': 'teaching-fixture'})
            for index, rotation in enumerate(rotations):
                page = document.new_page(width=600, height=450)
                page.insert_text((40, 60), f'SYNTHETIC TEACHING PAGE {index}', fontsize=12)
                page.draw_rect(fitz.Rect(80, 130, 380, 320), color=(.4, .4, .4), width=1)
                page.set_cropbox(fitz.Rect(20, 15, 580, 430))
                page.set_rotation(rotation)
            document.save(path)
        return path

    def overlay(self, kind='signature', *, page=0, x=100, y=150, width=None, height=None):
        if width is None:
            width = 150 if kind == 'signature' else 70
        if height is None:
            height = width * (.2 if kind == 'signature' else 1)
        return {'kind': kind, 'image_path': str(self.signature if kind == 'signature' else self.stamp),
                'placement': {'page': page, 'x': x, 'y': y, 'width': width, 'height': height}}

    def test_single_stamp_or_signature_preserves_document_and_hashes(self):
        source = self.document((0, 90))
        original = source.read_bytes()
        for kind in ('stamp', 'signature'):
            with self.subTest(kind=kind):
                overlay = self.overlay(kind, page=1)
                artwork_bytes = Path(overlay['image_path']).read_bytes()
                output = self.root / f'{kind}.pdf'
                with patch('app.pdf_engine._open_document', wraps=engine._open_document) as opened:
                    report = engine.compose_pdf(source, output, [overlay])
                self.assertEqual(opened.call_count, 1)
                self.assertEqual(report['pages'], 2)
                self.assertEqual(report['source_sha256'], hashlib.sha256(original).hexdigest())
                self.assertEqual(report['output_sha256'], hashlib.sha256(output.read_bytes()).hexdigest())
                snapshot = report['overlays'][0]
                self.assertEqual(snapshot['kind'], kind)
                self.assertEqual(snapshot['placement'], overlay['placement'])
                self.assertEqual(snapshot['image_sha256'], hashlib.sha256(artwork_bytes).hexdigest())
                self.assertEqual(Path(overlay['image_path']).read_bytes(), artwork_bytes)
                with fitz.open(source) as before, fitz.open(output) as after:
                    self.assertEqual(after.metadata['title'], before.metadata['title'])
                    self.assertIn('teaching-fixture', after.metadata['keywords'])
                    self.assertEqual(after.metadata['keywords'].count(engine.MARKER), 1)
                    self.assertEqual(len(after[0].get_images()), 0)
                    self.assertEqual(len(after[1].get_images()), 1)
                    for old_page, new_page in zip(before, after):
                        self.assertEqual(old_page.get_text(), new_page.get_text())
                        self.assertEqual(old_page.rect, new_page.rect)
                        self.assertEqual(old_page.cropbox, new_page.cropbox)
                        self.assertEqual(old_page.rotation, new_page.rotation)
                self.assertEqual(source.read_bytes(), original)
                with self.assertRaisesRegex(ValueError, 'уже'):
                    engine.compose_pdf(output, self.root / 'duplicate.pdf', [overlay])

    def test_two_overlays_on_different_pages_use_one_original_open_and_scan_all_pages(self):
        source = self.document((0, 270))
        original = source.read_bytes()
        overlays = [self.overlay('stamp', page=0), self.overlay('signature', page=1)]
        output = self.root / 'both.pdf'
        with patch('app.pdf_engine._open_document', wraps=engine._open_document) as opened:
            report = engine.compose_pdf(source, output, overlays)
        self.assertEqual(opened.call_count, 1)
        self.assertEqual([item['kind'] for item in report['overlays']], ['stamp', 'signature'])
        with fitz.open(output) as doc:
            self.assertEqual([len(page.get_images()) for page in doc], [1, 1])
        scan = self.root / 'both-scan.pdf'
        engine.scan_pdf(output, scan, seed=9)
        with fitz.open(scan) as doc:
            self.assertEqual(len(doc), 2)
            self.assertTrue(all(not page.get_text().strip() for page in doc))
            self.assertTrue(all(len(page.get_images()) == 1 for page in doc))
        self.assertEqual(source.read_bytes(), original)

    def test_both_same_page_keep_native_crop_rotation_alpha_and_artwork_orientation(self):
        for rotation in (0, 90, 180, 270):
            with self.subTest(rotation=rotation):
                source = self.document((rotation,))
                overlays = [self.overlay('stamp', x=100, y=150),
                            self.overlay('signature', x=200, y=150)]
                output = self.root / f'rotated-{rotation}.pdf'
                engine.compose_pdf(source, output, overlays)
                with fitz.open(source) as before, fitz.open(output) as after:
                    page = after[0]
                    self.assertEqual(page.rotation, rotation)
                    self.assertEqual(page.cropbox, before[0].cropbox)
                    self.assertEqual(page.rect, before[0].rect)
                    old_pix, new_pix = before[0].get_pixmap(alpha=False), page.get_pixmap(alpha=False)
                    old_image = Image.frombytes('RGB', (old_pix.width, old_pix.height), old_pix.samples)
                    new_image = Image.frombytes('RGB', (new_pix.width, new_pix.height), new_pix.samples)
                    delta = ImageChops.difference(old_image, new_image).point(lambda value: 255 if value > 10 else 0)
                    box = delta.getbbox()
                    self.assertGreaterEqual(box[0], 100)
                    self.assertGreaterEqual(box[1], 150)
                    self.assertLessEqual(box[2], 350)
                    self.assertLessEqual(box[3], 220)
                    colours = list(new_image.get_flattened_data())
                    blue = [(n % new_pix.width, n // new_pix.width) for n, p in enumerate(colours)
                            if p[2] > 150 and p[0] < 100 and p[1] < 110]
                    red = [(n % new_pix.width, n // new_pix.width) for n, p in enumerate(colours)
                           if p[0] > p[1] + 70 and p[0] > p[2] + 60]
                    self.assertTrue(blue)
                    self.assertTrue(red)
                    # Locate the asymmetric mark in the displayed top-left.
                    self.assertTrue(any(x < 113 and y < 163 for x, y in blue))
                    self.assertTrue(any(x < 210 and y < 160 for x, y in red))
                    for entry in page.get_images():
                        xref, smask, width, height = entry[:4]
                        self.assertGreater(smask, 0)
                        self.assertIn((width, height), ((120, 120), (400, 80)))
                        mask = fitz.Pixmap(after, smask)
                        self.assertIn(0, mask.samples)
                        self.assertIn(170 if width == 400 else 255, mask.samples)
                    # A transparent signature pixel preserves the paper below.
                    self.assertEqual(new_image.getpixel((240, 157)), old_image.getpixel((240, 157)))

    def test_wide_signature_profile_is_allowed_without_stretch(self):
        source = self.document()
        for size in ((640, 16), (16, 64), (8192, 256)):
            with self.subTest(size=size):
                path = self.artwork(f'{size[0]}-{size[1]}.png', size, (20, 20, 20, 255))
                overlay = self.overlay(y=0, width=100, height=100 * size[1] / size[0])
                overlay['image_path'] = str(path)
                engine.compose_pdf(source, self.root / f'wide-{size[0]}-{size[1]}.pdf', [overlay])
        for size in ((641, 16), (16, 65), (8193, 256), (10, 100)):
            path = self.artwork(f'bad-{size[0]}-{size[1]}.png', size, (20, 20, 20, 255))
            overlay = self.overlay(width=100, height=100 * size[1] / size[0])
            overlay['image_path'] = str(path)
            with self.subTest(size=size), self.assertRaises(ValueError):
                engine.compose_pdf(source, self.root / 'bad-profile.pdf', [overlay])
        too_wide_stamp = self.overlay('stamp')
        too_wide_stamp['image_path'] = str(self.signature)
        with self.assertRaisesRegex(ValueError, 'пропорции'):
            engine.compose_pdf(source, self.root / 'bad-stamp.pdf', [too_wide_stamp])

    def test_native_image_budget_and_corrupt_png_are_rejected_before_publication(self):
        source = self.document()
        def chunk(kind, data):
            return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
        huge = self.root / 'huge-header.png'
        huge.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 6000, 3000, 8, 2, 0, 0, 0))
                         + chunk(b'IDAT', zlib.compress(b'')) + chunk(b'IEND', b''))
        overlay = self.overlay(width=100, height=50)
        overlay['image_path'] = str(huge)
        with patch('app.pdf_engine.Image.Image.load', side_effect=AssertionError('preflight must precede pixel decode')):
            with self.assertRaisesRegex(ValueError, '16 мегапикселей'):
                engine.compose_pdf(source, self.root / 'huge.pdf', [overlay])
        corrupt = self.root / 'corrupt.png'
        corrupt.write_bytes(b'\x89PNG\r\n\x1a\n incomplete synthetic fixture')
        overlay['image_path'] = str(corrupt)
        with self.assertRaisesRegex(ValueError, 'открыть PNG'):
            engine.compose_pdf(source, self.root / 'corrupt.pdf', [overlay])
        self.assertFalse((self.root / 'huge.pdf').exists())
        self.assertFalse((self.root / 'corrupt.pdf').exists())

    def test_existing_animated_stamp_keeps_legacy_first_frame_but_signature_is_static(self):
        source = self.document()
        artwork = self.root / 'teaching-apng.png'
        with Image.new('RGBA', (100, 100), (25, 45, 190, 255)) as first:
            with Image.new('RGBA', (100, 100), (170, 25, 35, 255)) as second:
                first.save(artwork, format='PNG', save_all=True, append_images=[second], duration=100, loop=0)
        overlay = self.overlay('stamp')
        overlay['image_path'] = str(artwork)
        legacy, composed = self.root / 'legacy-apng.pdf', self.root / 'composed-apng.pdf'
        engine.stamp_pdf(source, legacy, artwork, overlay['placement'])
        receipt = engine.compose_pdf(source, composed, [overlay])
        with fitz.open(legacy) as before, fitz.open(composed) as after:
            self.assertEqual(before[0].get_pixmap(alpha=False).samples,
                             after[0].get_pixmap(alpha=False).samples)
        self.assertEqual(receipt['overlays'][0]['image_sha256'], hashlib.sha256(artwork.read_bytes()).hexdigest())
        overlay['kind'] = 'signature'
        with self.assertRaisesRegex(ValueError, 'неподвижный'):
            engine.compose_pdf(source, self.root / 'animated-signature.pdf', [overlay])
        self.assertFalse((self.root / 'animated-signature.pdf').exists())

    def test_invalid_overlay_placement_and_bounds_do_not_publish(self):
        source = self.document()
        normal = self.overlay()
        bad_overlays = [[], [normal] * 3, [normal, normal], [dict(normal, kind='other')], [None]]
        for change in ({'page': -1}, {'page': 1}, {'page': True}, {'page': .5}, {'x': float('nan')},
                       {'y': float('inf')}, {'width': 0}, {'height': -1}, {'x': True}, {'width': '150'},
                       {'x': -1}, {'y': 420}, {'x': 500}, {'height': 50}):
            bad_overlays.append([dict(normal, placement={**normal['placement'], **change})])
        original = source.read_bytes()
        for overlays in bad_overlays:
            with self.subTest(overlays=overlays), self.assertRaises(ValueError):
                engine.compose_pdf(source, self.root / 'invalid.pdf', overlays)
            self.assertFalse((self.root / 'invalid.pdf').exists())
            self.assertEqual(list(self.root.glob('.stamp-composition-*')), [])
        # An invalid second overlay cannot leave a partially composed result.
        with self.assertRaisesRegex(ValueError, 'границы'):
            engine.compose_pdf(source, self.root / 'invalid.pdf',
                               [self.overlay('stamp'), self.overlay('signature', x=500)])
        self.assertFalse((self.root / 'invalid.pdf').exists())
        self.assertEqual(source.read_bytes(), original)

    def test_signed_password_and_already_modified_pdfs_are_rejected(self):
        source = self.document()
        with fitz.open(source) as doc:
            xref = doc.get_new_xref()
            doc.update_object(xref, '<< /Type /Sig /ByteRange [0 10 20 30] /Contents <01> >>')
            doc.xref_set_key(doc.pdf_catalog(), 'TeachingSignature', f'{xref} 0 R')
            signed = self.root / 'signed.pdf'
            doc.save(signed)
        with fitz.open(source) as doc:
            widget = fitz.Widget()
            widget.field_type = fitz.PDF_WIDGET_TYPE_SIGNATURE
            widget.field_name = 'UNSIGNED SYNTHETIC FIELD'
            widget.rect = fitz.Rect(30, 80, 130, 100)
            doc[0].add_widget(widget)
            unsigned_field = self.root / 'signature-field.pdf'
            doc.save(unsigned_field)
        protected = self.root / 'protected.pdf'
        with fitz.open(source) as doc:
            doc.save(protected, encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw='synthetic-owner', user_pw='synthetic-reader')
        for document in (signed, unsigned_field, protected):
            original = document.read_bytes()
            with self.subTest(document=document.name), self.assertRaisesRegex(ValueError, 'подпись|паролем'):
                engine.compose_pdf(document, self.root / 'refused.pdf', [self.overlay()])
            self.assertFalse((self.root / 'refused.pdf').exists())
            self.assertEqual(document.read_bytes(), original)

    def test_existing_output_source_alias_race_and_write_failure_preserve_data(self):
        source = self.document()
        original = source.read_bytes()
        with self.assertRaisesRegex(ValueError, 'отдельно'):
            engine.compose_pdf(source, source.parent / '.' / source.name, [self.overlay()])
        output = self.root / 'existing.pdf'
        output.write_bytes(b'prior result')
        with self.assertRaisesRegex(ValueError, 'существует'):
            engine.compose_pdf(source, output, [self.overlay()])
        self.assertEqual(output.read_bytes(), b'prior result')
        raced = self.root / 'raced.pdf'
        real_open = Path.open
        def race(path, mode='r', *args, **kwargs):
            if path == raced and mode == 'xb':
                with real_open(path, 'wb') as competing:
                    competing.write(b'competing result')
            return real_open(path, mode, *args, **kwargs)
        with patch.object(Path, 'open', race), self.assertRaisesRegex(ValueError, 'существует'):
            engine.compose_pdf(source, raced, [self.overlay()])
        self.assertEqual(raced.read_bytes(), b'competing result')
        failed = self.root / 'failed.pdf'
        with patch('app.pdf_engine.shutil.copyfileobj', side_effect=OSError('synthetic disk failure')):
            with self.assertRaisesRegex(OSError, 'disk failure'):
                engine.compose_pdf(source, failed, [self.overlay()])
        self.assertFalse(failed.exists())
        self.assertEqual(list(self.root.glob('.stamp-composition-*')), [])
        self.assertEqual(source.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
