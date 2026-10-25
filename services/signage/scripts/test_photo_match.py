"""Photo-noise estimation and complete rendering paths; injected images, no AI."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
from PIL import Image, ImageDraw

import photo_match
import exact_letter_installation
import render_server as app
from test_letter_objects import independent_payload, logo
from test_product_render import product_payload
from test_render_server import payload


def noisy(size=(320, 240), sigma=6):
    rng = np.random.default_rng(729)
    shape = (size[1], size[0], 3)
    return Image.fromarray(np.clip(np.rint(125+rng.normal(0, sigma, shape)), 0, 255).astype('uint8'))


class GrainTests(unittest.TestCase):
    def test_projected_front_mask_excludes_unchanged_foreground(self):
        body = independent_payload([logo(width_cm=80, x_cm=70, y_cm=100)])
        source, project, report, _, _, permitted = app.prepare(body)
        unchanged = exact_letter_installation.projected_front_interiors(source, source, permitted, project, report)
        self.assertIsNone(unchanged.getbbox())
        rendered = Image.new('RGB', source.size, (80, 120, 160))
        before = exact_letter_installation.projected_front_interiors(source, rendered, permitted, project, report)
        self.assertIsNotNone(before.getbbox())
        x, y, right, bottom = before.getbbox()
        stripe = (x+2, y, min(x+5, right), bottom)
        rendered.paste(source.crop(stripe), stripe[:2])
        after = exact_letter_installation.projected_front_interiors(source, rendered, permitted, project, report)
        self.assertIsNone(after.crop(stripe).getbbox())
        self.assertFalse(np.any((np.asarray(after)>0) & (np.asarray(permitted)==0)))

    def test_estimator_and_exact_surface_protection(self):
        source = noisy()
        covariance, patches = photo_match.estimate(source)
        np.testing.assert_allclose(np.sqrt(np.diag(covariance)), [6]*3, atol=1)
        self.assertGreater(patches, 2)
        surface = Image.new('L', source.size)
        draw = ImageDraw.Draw(surface)
        draw.rectangle((50, 45, 210, 195), fill=255)
        draw.rectangle((95, 65, 125, 180), fill=0)
        draw.line((49, 45, 49, 195), fill=100)
        rendered = Image.new('RGB', source.size, (120, 145, 170))
        original = rendered.tobytes()
        result, audit = photo_match.apply(source, rendered, surface)
        repeated, audit2 = photo_match.apply(source, rendered, surface)
        self.assertEqual(rendered.tobytes(), original)
        self.assertEqual(result.tobytes(), repeated.tobytes())
        self.assertEqual(audit, audit2)
        protected = np.asarray(surface) == 0
        np.testing.assert_array_equal(np.asarray(result)[protected], np.asarray(rendered)[protected])
        self.assertTrue(audit['applied'])
        self.assertEqual(audit['changed_pixels_outside_surface'], 0)
        delta = np.asarray(result).astype(float)-np.asarray(rendered)
        np.testing.assert_allclose(delta[np.asarray(surface)==255].std(axis=0), [6]*3, atol=1.2)
        self.assertFalse(audit['geometry_changed'])

    def test_clean_gradient_adds_nothing_and_existing_noise_is_not_doubled(self):
        y, x = np.mgrid[:240, :320]
        gradient = Image.fromarray(np.stack([30+x//2, 50+y//2, np.full_like(x, 150)], axis=2).astype('uint8'))
        full = Image.new('L', gradient.size, 255)
        rendered = Image.new('RGB', gradient.size, (120, 130, 140))
        clean, audit = photo_match.apply(gradient, rendered, full)
        self.assertEqual(clean.tobytes(), rendered.tobytes())
        self.assertFalse(audit['applied'])
        grainy = noisy(sigma=9)
        result, audit = photo_match.apply(noisy(sigma=5), grainy, full)
        self.assertEqual(result.tobytes(), grainy.tobytes())
        self.assertFalse(audit['applied'])

    def test_correlated_rgb_noise_remains_correlated(self):
        rng = np.random.default_rng(55)
        luminance = rng.normal(0, 7, (240, 320, 1))
        source = Image.fromarray(np.clip(np.rint(120+np.repeat(luminance, 3, axis=2)), 0, 255).astype('uint8'))
        result, _ = photo_match.apply(source, Image.new('RGB', source.size, (128, 128, 128)), Image.new('L', source.size, 255))
        values = np.asarray(result).reshape(-1, 3)
        self.assertGreater(np.corrcoef(values, rowvar=False)[0, 1], .9)

    def test_invalid_modes_rejected_before_render(self):
        for body in [payload('original'), independent_payload()]:
            body['project']['generation']['photo_match'] = 'invented'
            with self.assertRaisesRegex(app.UserError, 'цветокоррекции'):
                app.prepare(body)
        body = payload('original')
        body['project']['generation']['photo_match'] = photo_match.VERSION
        with self.assertRaisesRegex(app.UserError, 'точных контуров'):
            app.prepare(body)

    def test_full_pipelines_keep_input_geometry_and_background(self):
        calls = []
        def renderer(folder, prompt, canvas, guide, *, transparent_background=False, **kwargs):
            calls.append(transparent_background)
            with Image.open(canvas) as image:
                return image.convert('RGBA') if transparent_background else Image.new('RGB', image.size, (105, 135, 150))
        # Include actual background replacement, solid panels and alpha cutouts.
        bodies = [independent_payload([logo(width_cm=80, x_cm=70, y_cm=100, depth_cm=3)], engine=engine)
                  for engine in ('composite', 'codex_composite', 'codex_two_stage')]
        bodies += [product_payload(kind) for kind in ('plaque', 'neon')]
        for index, body in enumerate(bodies):
            with self.subTest(index=index), tempfile.TemporaryDirectory() as temp:
                source = noisy()
                body['photo'] = app.data_url(source)
                service = app.Service(Path(temp), renderer=renderer, status_reader=lambda: {'configured': True})
                results = []
                saved_projects = []
                for enabled in (False, True):
                    item = copy.deepcopy(body)
                    item['request_id'] = 'noise-test-%02d-%s-0001' % (index, enabled)
                    if enabled:
                        item['project']['generation']['photo_match'] = photo_match.VERSION
                    saved_input = copy.deepcopy(item)
                    service.submit(item)
                    self.assertTrue(service.wait_for_workers(20))
                    job = service.public(item['request_id'])
                    self.assertEqual(job['status'], 'complete', job)
                    self.assertEqual(item, saved_input)
                    folder = Path(temp)/item['request_id']
                    saved_projects.append(json.loads((folder/'project.json').read_text(encoding='utf-8')))
                    with Image.open(folder/'render.png') as image:
                        results.append(np.asarray(image).copy())
                    if enabled:
                        self.assertTrue(job['audit']['photo_match']['applied'])
                        self.assertEqual(job['audit']['changed_pixels_outside_edit_zone'], 0)
                        with Image.open(folder/'sign-surface-mask.png') as mask:
                            protected = np.asarray(mask) == 0
                            np.testing.assert_array_equal(results[0][protected], results[1][protected])
                        raw = json.loads((folder/'project.json').read_text(encoding='utf-8'))
                        self.assertEqual(raw['generation']['photo_match'], photo_match.VERSION)
                        self.assertEqual(saved_projects[0]['products'], saved_projects[1]['products'])
                        self.assertEqual(saved_projects[0]['calibration'], saved_projects[1]['calibration'])
                self.assertTrue(np.any(results[0] != results[1]))
        self.assertTrue(calls)


if __name__ == '__main__':
    unittest.main()
