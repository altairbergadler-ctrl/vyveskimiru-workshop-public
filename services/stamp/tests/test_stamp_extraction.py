"""Synthetic teaching fixtures: geometric ink shapes, never business seals."""
from __future__ import annotations

import hashlib
import io
import random
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import zlib

import fitz
from PIL import Image, ImageDraw

from app.stamp_extraction import extract_stamp, render_source_page, source_info

FULL = {'x': 0, 'y': 0, 'width': 1, 'height': 1}


class StampExtractionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def picture(self, name='source.png', ink=(25, 45, 190), *, paper='white', black=False, alpha=False):
        image = Image.new('RGBA' if alpha else 'RGB', (400, 300), (0, 0, 0, 0) if alpha else paper)
        draw = ImageDraw.Draw(image)
        draw.ellipse((130, 80, 280, 230), outline=ink, width=8)
        draw.rectangle((190, 116, 210, 142), fill=ink)
        if black:
            # A black form line actually overwrites some blue ink. Extraction
            # must remove that black line without reconstructing hidden ink.
            draw.line((90, 155, 315, 155), fill=(15, 15, 15), width=4)
            draw.text((165, 180), 'SYNTHETIC', fill=(10, 10, 10))
        path = self.root / name
        image.save(path)
        image.close()
        return path

    def extract(self, source, name='output.png', **kwargs):
        output = self.root / name
        report = extract_stamp(source, output, source_type=kwargs.pop('source_type', 'png'), crop=kwargs.pop('crop', FULL), **kwargs)
        return output, report

    @staticmethod
    def visible(image):
        return [pixel for pixel in image.get_flattened_data() if pixel[3] >= 64]

    def test_blue_preserves_source_pixels_and_does_not_restore_black_overlap(self):
        source = self.picture(black=True)
        original = source.read_bytes()
        output, report = self.extract(source)
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(report['source_sha256'], hashlib.sha256(original).hexdigest())
        self.assertEqual(report['output_sha256'], hashlib.sha256(output.read_bytes()).hexdigest())
        self.assertGreater(report['coverage'], .01)
        self.assertLess(report['coverage'], .15)
        with Image.open(output) as result:
            self.assertEqual(result.mode, 'RGBA')
            self.assertLess(result.width, 180)
            self.assertLess(result.height, 180)
            self.assertEqual(result.getpixel((0, 0))[3], 0)
            self.assertTrue(all(pixel[:3] == (25, 45, 190) for pixel in self.visible(result)))
            padding = report['padding']
            self.assertEqual(result.getpixel((padding + 75, padding))[0:3], (25, 45, 190))
            # Removed black pixels stay transparent even where they covered
            # the circle; there is no extrapolation of its missing contour.
            self.assertEqual(result.getpixel((padding + 1, padding + 76))[3], 0)
            self.assertEqual(result.getpixel((padding + 75, padding + 75))[3], 0)

    def test_removed_document_rgb_is_unrecoverable_without_changing_visible_pixels(self):
        source = self.picture(black=True)
        # Faint blue marks provide partial alpha as well as opaque contours.
        # They must retain their original RGB, even at alpha values below 64.
        with Image.open(source) as image:
            amended = image.copy()
        ImageDraw.Draw(amended).rectangle((180, 100, 187, 125), fill=(205, 210, 245))
        amended.save(source)
        amended.close()
        original = source.read_bytes()
        for rotation in (0, -12, 12):
            with self.subTest(rotation=rotation):
                # Reproduce the former extraction path as a visual reference:
                # only its fully transparent RGB sanitation is disabled.
                with patch('app.stamp_extraction._clear_transparent_rgb'):
                    old_path, _ = self.extract(source, f'legacy-{rotation}.png', strength=0, rotation=rotation)
                new_path, report = self.extract(source, f'private-{rotation}.png', strength=0, rotation=rotation)
                with Image.open(old_path) as before, Image.open(new_path) as after:
                    self.assertEqual(before.size, after.size)
                    old_pixels = list(before.get_flattened_data())
                    new_pixels = list(after.get_flattened_data())
                    self.assertTrue(any(0 < pixel[3] < 64 for pixel in new_pixels))
                    self.assertEqual(before.getchannel('A').tobytes(), after.getchannel('A').tobytes())
                    self.assertEqual([pixel for pixel in old_pixels if pixel[3]],
                                     [pixel for pixel in new_pixels if pixel[3]])
                    self.assertTrue(all(pixel[:3] == (0, 0, 0) for pixel in new_pixels if pixel[3] == 0))
                    # Dropping alpha no longer exposes the removed form line
                    # or synthetic label in an RGB-only PNG consumer.
                    rgb_only = after.convert('RGB')
                    self.assertFalse(any(pixel in ((10, 10, 10), (15, 15, 15))
                                         for pixel in rgb_only.get_flattened_data()))
                    if rotation == 0:
                        self.assertGreater(sum(pixel[3] == 0 and pixel[:3] in ((10, 10, 10), (15, 15, 15))
                                               for pixel in old_pixels), 500)
                    paper = Image.new('RGBA', before.size, 'white')
                    self.assertEqual(Image.alpha_composite(paper, before).tobytes(),
                                     Image.alpha_composite(paper, after).tobytes())
                self.assertEqual(source.read_bytes(), original)
                self.assertEqual(report['source_sha256'], hashlib.sha256(original).hexdigest())

    def test_red_and_violet_selection_excludes_other_ink(self):
        for color, ink in (('red', (210, 25, 35)), ('blue', (145, 35, 180))):
            with self.subTest(color=color):
                source = self.picture(color + '.png', ink=ink)
                output, report = self.extract(source, color + '-out.png', color=color)
                with Image.open(output) as image:
                    self.assertGreater(len(self.visible(image)), 1000)
                    self.assertTrue(all(pixel[:3] == ink for pixel in self.visible(image)))
                self.assertEqual(report['color'], color)
        red = self.root / 'red.png'
        with self.assertRaisesRegex(ValueError, 'не найден|бледный'):
            self.extract(red, 'red-as-blue.png', color='blue')
        self.assertFalse((self.root / 'red-as-blue.png').exists())

    def test_uneven_paper_is_removed_in_colour_and_grayscale(self):
        rng = random.Random(11)
        for color, ink in (('blue', (35, 55, 170)), ('dark', (65, 65, 65))):
            image = Image.new('RGB', (400, 300))
            image.putdata([(max(0, min(255, 210 + y // 12 + rng.randint(-3, 3))),
                            max(0, min(255, 211 + y // 12 + rng.randint(-3, 3))),
                            max(0, min(255, 216 + y // 12 + rng.randint(-3, 3))))
                           for y in range(300) for _ in range(400)])
            ImageDraw.Draw(image).ellipse((130, 80, 280, 230), outline=ink, width=8)
            source = self.root / ('uneven-' + color + '.png')
            image.save(source)
            output, report = self.extract(source, color + '-uneven-out.png', color=color)
            with Image.open(output) as extracted:
                self.assertLess(extracted.width, 180)
                self.assertEqual(extracted.getpixel((extracted.width // 2, extracted.height // 2))[3], 0)
                self.assertGreater(len(self.visible(extracted)), 2500)
                self.assertTrue(all(pixel[:3] == ink for pixel in self.visible(extracted)))
            self.assertEqual(bool(report['warnings']), color == 'dark')

    def test_alpha_input_uses_white_matte_without_black_background(self):
        source = self.picture('transparent.png', ink=(25, 45, 190, 170), alpha=True)
        output, _ = self.extract(source)
        with Image.open(output) as extracted:
            visible = self.visible(extracted)
            self.assertTrue(visible)
            self.assertTrue(all(90 <= pixel[0] <= 110 and pixel[2] > 200 for pixel in visible))
            self.assertEqual(extracted.getpixel((extracted.width // 2, extracted.height // 2))[3], 0)
            self.assertEqual(extracted.getpixel((0, 0))[3], 0)

    def test_strength_retains_faint_ink_at_low_setting_without_inventing_detail(self):
        source = self.picture('faint.png', ink=(220, 223, 239))
        low, report = self.extract(source, 'faint-low.png', strength=0)
        with Image.open(low) as result:
            self.assertGreater(len(self.visible(result)), 500)
            self.assertTrue(all(pixel[:3] == (220, 223, 239) for pixel in self.visible(result)))
        self.assertEqual(report['strength'], 0)
        with self.assertRaisesRegex(ValueError, 'бледный|не найден'):
            self.extract(source, 'faint-strong.png', strength=100)

    def test_rotation_has_transparent_margin_and_does_not_clip_ink(self):
        source = self.picture()
        straight, _ = self.extract(source, 'straight.png')
        with Image.open(straight) as image:
            before = len(self.visible(image))
        for rotation in (-15, 15):
            output, report = self.extract(source, f'rotated-{rotation}.png', rotation=rotation)
            with Image.open(output) as image:
                self.assertGreater(len(self.visible(image)), before * .95)
                alpha_bbox = image.getchannel('A').getbbox()
                self.assertGreaterEqual(alpha_bbox[0], report['padding'])
                self.assertGreaterEqual(alpha_bbox[1], report['padding'])
                self.assertLessEqual(alpha_bbox[2], image.width - report['padding'])
                self.assertLessEqual(alpha_bbox[3], image.height - report['padding'])

    def test_empty_wrong_crop_and_invalid_options_do_not_create_outputs(self):
        blank = self.root / 'blank.png'
        Image.new('RGB', (400, 300), 'white').save(blank)
        for color in ('blue', 'red', 'dark'):
            with self.assertRaisesRegex(ValueError, 'не найден|бледный'):
                self.extract(blank, color + '-empty.png', color=color)
        source = self.picture()
        for crop in ({}, {'x': -1, 'y': 0, 'width': 1, 'height': 1}, dict(FULL, x=.5),
                     dict(FULL, width=0), dict(FULL, x=float('nan')), dict(FULL, height=float('inf')),
                     dict(FULL, x=True), dict(FULL, width=.001)):
            with self.subTest(crop=crop), self.assertRaises(ValueError):
                self.extract(source, 'bad.png', crop=crop)
            self.assertFalse((self.root / 'bad.png').exists())
        for kwargs in ({'color': 'green'}, {'strength': -1}, {'strength': 101}, {'strength': True},
                       {'strength': 50.0}, {'rotation': 16}, {'rotation': float('nan')}, {'page': True},
                       {'page': 1}, {'source_type': 'svg'}, {'max_pages': 0}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.extract(source, 'bad.png', **kwargs)
        with self.assertRaisesRegex(ValueError, 'не найден|бледный'):
            self.extract(source, 'wrong-area.png', crop={'x': 0, 'y': 0, 'width': .2, 'height': .2})

    def test_jpeg_exif_orientation_previews_and_crops_displayed_pixels(self):
        image = Image.new('RGB', (600, 800), 'white')
        ImageDraw.Draw(image).ellipse((40, 80, 190, 230), outline=(25, 45, 190), width=10)
        exif = Image.Exif()
        exif[274] = 6
        source = self.root / 'camera.jpg'
        image.save(source, format='JPEG', quality=98, exif=exif)
        before = source.read_bytes()
        info = source_info(source, 'jpg')
        self.assertEqual((info['pages'][0]['width'], info['pages'][0]['height']), (800, 600))
        preview = self.root / 'camera-preview.png'
        render_source_page(source, 'jpg', 0, preview)
        with Image.open(preview) as displayed:
            self.assertEqual(displayed.size, (800, 600))
            self.assertGreater(displayed.getpixel((800 - 80, 100))[2], 100)
        output, _ = self.extract(source, source_type='jpg', crop={'x': .7, 'y': 0, 'width': .3, 'height': .4})
        with Image.open(output) as extracted:
            self.assertGreater(len(self.visible(extracted)), 1000)
            self.assertLess(extracted.width, 210)
        self.assertEqual(source.read_bytes(), before)

    def test_pdf_pages_rotation_crop_and_300_dpi_selected_region(self):
        source = self.root / 'teaching-pages.pdf'
        with fitz.open() as doc:
            for rotation in (0, 90, 180, 270):
                page = doc.new_page(width=360, height=300)
                page.insert_text((25, 35), 'SYNTHETIC TEACHING PAGE', fontsize=12)
                page.draw_oval(fitz.Rect(100, 80, 240, 220), color=(.1, .2, .8), width=5)
                page.set_cropbox(fitz.Rect(20, 10, 340, 280))
                page.set_rotation(rotation)
            doc.save(source)
        before = source.read_bytes()
        info = source_info(source, 'PDF')
        self.assertEqual(info['page_count'], 4)
        with self.assertRaisesRegex(ValueError, 'лимит'):
            source_info(source, 'pdf', max_pages=3)
        with fitz.open(source) as doc:
            for index, page in enumerate(doc):
                with self.subTest(rotation=page.rotation):
                    pix = page.get_pixmap(colorspace=fitz.csRGB, alpha=False)
                    displayed = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
                    blue = [(n % pix.width, n // pix.width) for n, p in enumerate(displayed.get_flattened_data())
                            if p[2] > p[0] + 40 and p[2] > p[1] + 40]
                    box = (min(x for x, _ in blue) - 8, min(y for _, y in blue) - 8,
                           max(x for x, _ in blue) + 9, max(y for _, y in blue) + 9)
                    crop = {'x': box[0] / pix.width, 'y': box[1] / pix.height,
                            'width': (box[2] - box[0]) / pix.width, 'height': (box[3] - box[1]) / pix.height}
                    output, report = self.extract(source, f'page-{index}.png', source_type='pdf', page=index, crop=crop)
                    self.assertEqual(report['dpi'], 300)
                    self.assertGreater(report['width'], 590)
                    self.assertLess(report['width'], 660)
                    with Image.open(output) as image:
                        self.assertGreater(len(self.visible(image)), 20_000)
                        self.assertEqual(image.getpixel((image.width // 2, image.height // 2))[3], 0)
                    preview = self.root / f'page-{index}-preview.png'
                    metadata = render_source_page(source, 'pdf', index, preview)
                    self.assertEqual(metadata['source_width'], page.rect.width)
                    self.assertLessEqual(metadata['width'], 1600)
                    self.assertLessEqual(metadata['height'], 2400)
        self.assertEqual(source.read_bytes(), before)
        with self.assertRaisesRegex(ValueError, 'Страница'):
            render_source_page(source, 'pdf', 4, self.root / 'absent.png')

    def test_resource_budget_preflights_before_large_raster_allocations(self):
        source = self.root / 'large-page.pdf'
        with fitz.open() as doc:
            page = doc.new_page(width=5000, height=5000)
            page.draw_oval(fitz.Rect(20, 20, 70, 70), color=(.1, .2, .8), width=2)
            doc.save(source)
        with patch.object(fitz.Page, 'get_pixmap', side_effect=AssertionError('must reject before rendering')):
            with self.assertRaisesRegex(ValueError, 'слишком большая'):
                self.extract(source, 'large-full.png', source_type='pdf')
        small, _ = self.extract(source, 'large-small-region.png', source_type='pdf',
                                crop={'x': .003, 'y': .003, 'width': .012, 'height': .012})
        self.assertTrue(small.is_file())
        def chunk(kind, content):
            return struct.pack('>I', len(content)) + kind + content + struct.pack('>I', zlib.crc32(kind + content) & 0xffffffff)
        oversized = self.root / 'huge-image-header.png'
        oversized.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 6000, 5000, 8, 2, 0, 0, 0))
                              + chunk(b'IDAT', zlib.compress(b'')) + chunk(b'IEND', b''))
        with self.assertRaisesRegex(ValueError, '24 мегапикселей'):
            source_info(oversized, 'png')

    def test_original_existing_output_and_output_race_are_preserved(self):
        source = self.picture()
        original = source.read_bytes()
        with self.assertRaisesRegex(ValueError, 'отдельным'):
            extract_stamp(source, source, source_type='png', crop=FULL)
        existing = self.root / 'existing.png'
        existing.write_bytes(b'keep prior result')
        with self.assertRaisesRegex(ValueError, 'существует'):
            extract_stamp(source, existing, source_type='png', crop=FULL)
        self.assertEqual(existing.read_bytes(), b'keep prior result')
        raced = self.root / 'raced.png'
        real_open = Path.open
        def race(path, mode='r', *args, **kwargs):
            if path == raced and mode == 'xb':
                with real_open(path, 'wb') as competing:
                    competing.write(b'another operation result')
            return real_open(path, mode, *args, **kwargs)
        with patch.object(Path, 'open', race):
            with self.assertRaisesRegex(ValueError, 'существует'):
                extract_stamp(source, raced, source_type='png', crop=FULL)
        self.assertEqual(raced.read_bytes(), b'another operation result')
        self.assertEqual(source.read_bytes(), original)

    def test_partial_png_is_removed_after_write_failure(self):
        source = self.picture()
        output = self.root / 'failed.png'
        with patch('app.stamp_extraction.shutil.copyfileobj', side_effect=OSError('synthetic disk failure')):
            with self.assertRaisesRegex(OSError, 'disk failure'):
                extract_stamp(source, output, source_type='png', crop=FULL)
        self.assertFalse(output.exists())
        self.assertEqual(list(self.root.glob('.stamp-extraction-*')), [])
        self.assertTrue(source.is_file())


if __name__ == '__main__':
    unittest.main()
