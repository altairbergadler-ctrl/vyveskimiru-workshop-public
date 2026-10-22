"""Scene cleanup pipeline and originals/audit persistence; injected renderer only."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
import numpy as np
from PIL import Image
import render_server as app
import scene_retouch
from test_product_render import product_payload, await_job
from test_letter_objects import logo


class Retouch(unittest.TestCase):
    def test_settings_and_prompt_preserve_unselected_categories(self):
        self.assertEqual(scene_retouch.validate({}), {'mode': 'off', 'removals': []})
        for raw in ([], {'mode': 'bad'}, {'mode': 'ideal_environment', 'removals': []},
                    {'mode': 'ideal_environment', 'removals': ['people', 'people']},
                    {'mode': 'off', 'removals': ['unknown']}):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                scene_retouch.validate({'generation': {'scene_retouch': raw}})
        settings = {'mode': 'ideal_environment', 'removals': ['people']}
        prompt = scene_retouch.prompt(settings, [[0, 0], [20, 0], [20, 20], [0, 20]], 1, [320, 240])
        self.assertIn('Retain every category that is not selected', prompt)
        self.assertIn('people and their personal belongings', prompt)
        self.assertNotIn('unrelated commercial signs', prompt)
        self.assertIn('permanent building equipment', prompt)
        self.assertIn('"new_product_in_ai": false', prompt)

    def test_full_scene_cleanup_once_then_exact_montage_and_originals(self):
        for objects in (False, True):
            body = product_payload(selected_engine='codex_composite')
            if objects:
                product = body['project']['products'][0]
                product.update(type='channel_letters', template_id='letters-standard')
                product.pop('artwork')
                product['params'].update(objects=[logo()], composition_mode='independent_objects_v1')
                body['project']['generation']['engine'] = 'codex_composite'
            body['project']['generation']['scene_retouch'] = {'mode': 'ideal_environment', 'removals': ['people', 'litter']}
            original = copy.deepcopy(body)
            calls = []
            def renderer(folder, prompt, source_path, guide_path, **kwargs):
                calls.append((folder, prompt))
                with Image.open(source_path) as source:
                    return Image.new('RGB', source.size, (80, 100, 120))
            with tempfile.TemporaryDirectory() as temp:
                service = app.Service(Path(temp), renderer, lambda: {'configured': True})
                service.submit(body)
                job = await_job(service, body['request_id'])
                self.assertEqual(job['status'], 'complete', job)
                self.assertEqual(len(calls), 1, 'Retouch also clears local signage; no redundant second AI call')
                self.assertEqual(body, original)
                folder = Path(temp) / body['request_id']
                source = app.decode_photo(body['photo'])
                self.assertEqual(app.png_bytes(source), (folder/'source.png').read_bytes())
                self.assertEqual(app.png_bytes(source), (folder/'lighting-base.png').read_bytes())
                with Image.open(folder/'scene-base.png') as scene, Image.open(folder/'render.png') as result:
                    mask = np.asarray(app.zone_mask(source.size, body['project']['generation']['edit_polygon_px'])) == 0
                    self.assertTrue(np.array_equal(np.asarray(scene)[mask], np.asarray(result)[mask]))
                    self.assertFalse(np.array_equal(np.asarray(source)[mask], np.asarray(result)[mask]))
                audit = job['audit']
                self.assertEqual(audit['changed_pixels_outside_edit_zone'], 0)
                self.assertEqual(audit['protected_base_kind'], 'scene-base.png')
                self.assertTrue(audit['scene_retouch']['enabled'])
                self.assertTrue(audit['exact_artwork'])
                self.assertEqual(service.artifact(body['request_id'], 'scene-base.png'), folder/'scene-base.png')
                self.assertEqual(service.saved_job(body['request_id'])['status'], 'complete')

    def test_composite_retouch_needs_connection_before_job_or_renderer(self):
        body = product_payload()
        body['project']['generation']['scene_retouch'] = {'mode': 'ideal_environment', 'removals': ['people']}
        with tempfile.TemporaryDirectory() as temp:
            service = app.Service(Path(temp), lambda *a, **kw: self.fail('Renderer called'), lambda: {'configured': False})
            with self.assertRaises(app.UserError):
                service.submit(body)
            self.assertFalse(list(Path(temp).iterdir()))
            self.assertFalse(service.jobs)

    def test_retouch_failure_is_saved_without_placing_product_or_retrying(self):
        body = product_payload()
        body['project']['generation']['scene_retouch'] = {'mode': 'ideal_environment', 'removals': ['people']}
        calls = []
        def renderer(*args, **kwargs):
            calls.append(1)
            raise RuntimeError('Ретушь не завершена; автоматического повтора нет.')
        with tempfile.TemporaryDirectory() as temp:
            service = app.Service(Path(temp), renderer, lambda: {'configured': True})
            service.submit(body)
            job = await_job(service, body['request_id'])
            self.assertEqual(job['status'], 'failed')
            self.assertEqual(len(calls), 1)
            folder = Path(temp) / body['request_id']
            self.assertTrue((folder/'source.png').exists())
            self.assertFalse((folder/'render.png').exists())


if __name__ == '__main__':
    unittest.main()
