"""Private signature workflows using synthetic geometric artwork only."""
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import fitz
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

import app.main as main


def signature_png(color=(25, 45, 190, 230), size=(800, 160)):
    image = Image.new('RGBA', size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.line([(20, 125), (100, 35), (170, 100), (250, 40), (335, 115),
               (430, 40), (560, 110), (670, 55), (780, 90)], fill=color, width=8)
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    return buffer.getvalue()


def stamp_png():
    image = Image.new('RGBA', (160, 160), (0, 0, 0, 0))
    ImageDraw.Draw(image).ellipse((8, 8, 152, 152), outline=(160, 25, 25, 230), width=8)
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    return buffer.getvalue()


def source_pdf(pages=3):
    with fitz.open() as document:
        for index in range(pages):
            page = document.new_page(width=595, height=842)
            page.insert_text((35, 100), 'SYNTHETIC PAGE %d' % (index + 1))
        return document.tobytes()


def signature_scan():
    image = Image.new('RGB', (1200, 500), 'white')
    image.paste(Image.open(io.BytesIO(signature_png())), (300, 220), Image.open(io.BytesIO(signature_png())).getchannel('A'))
    ImageDraw.Draw(image).text((40, 50), 'SYNTHETIC DOCUMENT', fill='black')
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    return buffer.getvalue()


class SignatureAPI(unittest.TestCase):
    prefix = '/tools/stamp'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'data'
        self.app_root = Path(self.temp.name) / 'app-root'
        static = self.app_root / 'app' / 'static'
        static.mkdir(parents=True)
        (static / 'index.html').write_text('<base href="/"><body></body>', encoding='utf-8')
        self.root_patch = patch('app.main.ROOT', self.app_root)
        self.root_patch.start()
        self.env = patch.dict(os.environ, {
            'AUTH_MODE': 'password', 'APP_USERNAME': 'admin', 'APP_PASSWORD': 'synthetic-signature-password',
            'APP_BASE_PATH': self.prefix, 'COOKIE_SECURE': 'false',
            'MAX_UPLOAD_MB': '25', 'MAX_TOTAL_MB': '500', 'MAX_RESULT_MB': '100',
            'MAX_PAGES': '50', 'MAX_JOBS': '100',
        })
        self.env.start()
        self.client = self.open_client()

    def open_client(self):
        client = TestClient(main.create_app(self.root))
        client.__enter__()
        return client

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.env.stop()
        self.root_patch.stop()
        self.temp.cleanup()

    def login(self):
        response = self.client.post(self.prefix + '/api/login', json={
            'username': 'admin', 'password': 'synthetic-signature-password',
        })
        self.assertEqual(response.status_code, 200, response.text)
        self.client.headers['X-CSRF-Token'] = response.json()['csrf']

    def add_signature(self, name='Геометрическая подпись', content=None):
        response = self.client.post(self.prefix + '/api/signatures', files={
            'file': ('signature.png', content or signature_png(), 'image/png'),
        }, data={'name': name, 'signer': 'Тестовый подписант', 'width_mm': '70'})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def add_stamp(self):
        response = self.client.post(self.prefix + '/api/stamps', files={'file': ('stamp.png', stamp_png())})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def upload(self, raw=None):
        response = self.client.post(self.prefix + '/api/documents', files={'file': ('document.pdf', raw or source_pdf())})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def url(self, document):
        return self.prefix + '/api/documents/' + document['id']

    def signature_placement(self, document, page=0):
        width = document['signature_width_mm'] * 72 / 25.4
        return {'page': page, 'x': 200, 'y': 500, 'width': width, 'height': width * document['signature_aspect']}

    def stamp_placement(self, document, page=0):
        width = document['width_mm'] * 72 / 25.4
        return {'page': page, 'x': 300, 'y': 600, 'width': width, 'height': width * document['stamp_aspect']}

    def files(self):
        return {path.relative_to(self.root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in self.root.rglob('*') if path.is_file()}

    def assert_no_scratch(self):
        self.assertFalse(any(path.is_dir() and path.name.startswith('work-') for path in self.root.rglob('*')))
        self.assertEqual(list(self.root.glob('signature-upload-*')), [])

    def assert_pdf(self, response):
        self.assertEqual(response.status_code, 200, response.text[:200] if not response.content.startswith(b'%PDF') else '')

    def test_new_routes_are_private_csrf_protected_and_multipart_cap_is_correct(self):
        fake_id = '0' * 32
        for path in ('/api/signatures', '/api/signatures/' + fake_id + '/image',
                     '/api/signatures/' + fake_id + '/source', '/api/documents/' + fake_id + '/signature.png'):
            self.assertEqual(self.client.get(self.prefix + path).status_code, 401)
        self.assertEqual(self.client.post(self.prefix + '/api/signatures', files={'file': ('s.png', signature_png())}).status_code, 401)
        self.login()
        token = self.client.headers.pop('X-CSRF-Token')
        for path, body in (('/api/signatures/' + fake_id + '/activate', {}),
                           ('/api/documents/' + fake_id + '/signature', {'signature_id': None}),
                           ('/api/documents/' + fake_id + '/compose', {}),
                           ('/api/documents/' + fake_id + '/compose-scan', {}),
                           ('/api/stamp-sources/' + fake_id + '/save-signature', {})):
            self.assertEqual(self.client.post(self.prefix + path, json=body).status_code, 403)
        self.assertEqual(self.client.post(self.prefix + '/api/signatures', files={'file': ('s.png', signature_png())}).status_code, 403)
        self.client.headers['X-CSRF-Token'] = token
        self.add_signature(content=signature_png() + b' ' * 20000)
        self.assertEqual(self.client.post(self.prefix + '/api/signatures', content=b'x', headers={
            'Content-Length': str(26 * 1024 * 1024 + 1),
        }).status_code, 413)

    def test_signature_library_is_independent_and_job_snapshots_survive_binding_and_restart(self):
        self.login()
        stamp = self.add_stamp()
        first = self.add_signature()
        first_id = first['active_id']
        document = self.upload()
        url = self.url(document)
        self.assertEqual(document['signature_id'], first_id)
        self.assertTrue(document['signature_ready'])
        self.assertFalse(document['signature_enabled'])
        self.assertIsNone(document['signature_placement'])
        self.assertEqual(self.client.get(url + '/signature.png').content, signature_png())
        second_bytes = signature_png((30, 135, 50, 220))
        second = self.add_signature('Вторая подпись', second_bytes)
        second_id = second['active_id']
        config = self.client.get(self.prefix + '/api/config').json()
        self.assertEqual(config['active_stamp_id'], stamp['active_id'])
        self.assertEqual(config['active_signature_id'], second_id)
        self.assertEqual(self.client.get(url + '/signature.png').content, signature_png())
        self.assertEqual(self.client.get(url).json()['signature_id'], first_id)
        bound = self.client.post(url + '/signature', json={'signature_id': second_id})
        self.assertEqual(bound.status_code, 200, bound.text)
        self.assertEqual(self.client.get(url + '/signature.png').content, second_bytes)
        self.assertFalse(bound.json()['signature_enabled'])
        unbound = self.client.post(url + '/signature', json={'signature_id': None})
        self.assertEqual(unbound.status_code, 200, unbound.text)
        self.assertEqual(self.client.get(url + '/signature.png').status_code, 404)
        self.assertEqual(self.client.post(url + '/signature', json={'signature_id': first_id}).status_code, 200)
        self.assertEqual(len(self.client.get(url).json()['signature_snapshots']), 2)
        self.client.__exit__(None, None, None)
        self.client = self.open_client()
        self.login()
        self.assertEqual(self.client.get(self.prefix + '/api/signatures').json(), second)
        self.assertEqual(self.client.get(url).json()['signature_id'], first_id)
        self.assertEqual(self.client.get(url + '/signature.png').content, signature_png())
        self.assertEqual(self.client.get(self.prefix + '/api/stamps').json(), stamp)

    def test_two_graphics_on_different_pages_preserve_native_text_and_result_versions(self):
        self.login()
        self.add_stamp()
        signature = self.add_signature()
        source = source_pdf()
        document = self.upload(source)
        url = self.url(document)
        body = {'placement': self.stamp_placement(document, 0),
                'signature_placement': self.signature_placement(document, 1)}
        first = self.client.post(url + '/compose', json=body)
        self.assert_pdf(first)
        with fitz.open(stream=source, filetype='pdf') as before, fitz.open(stream=first.content, filetype='pdf') as after:
            self.assertEqual([page.get_text() for page in before], [page.get_text() for page in after])
            self.assertEqual([len(page.get_images()) for page in after], [1, 1, 0])
        manifest = self.client.get(url).json()
        result = manifest['results'][0]
        self.assertEqual(result['kind'], 'composed')
        self.assertTrue(result['stamp_enabled'])
        self.assertTrue(result['signature_enabled'])
        self.assertEqual(result['signature_id'], signature['active_id'])
        self.assertEqual(result['signature_sha256'], hashlib.sha256(signature_png()).hexdigest())
        self.assertEqual(result['stamp_sha256'], hashlib.sha256(stamp_png()).hexdigest())
        self.assertEqual(result['placement'], body['placement'])
        self.assertEqual(result['signature_placement'], body['signature_placement'])
        self.assertEqual([item['kind'] for item in result['overlays']], ['stamp', 'signature'])
        self.assertEqual(self.client.get(result['url']).content, first.content)
        second = self.client.post(url + '/compose', json={'placement': body['placement'], 'signature_placement': None})
        self.assert_pdf(second)
        updated = self.client.get(url).json()
        self.assertFalse(updated['signature_enabled'])
        self.assertEqual(updated['signature_placement'], body['signature_placement'])
        self.assertEqual(len(updated['results']), 2)
        self.assertEqual(self.client.get(result['url']).content, first.content)
        self.assertEqual(self.client.get(url + '/original').content, source)
        self.assert_no_scratch()

    def test_signature_only_document_and_scan_rasterize_all_pages_with_final_hash(self):
        self.login()
        self.add_signature()
        document = self.upload()
        url = self.url(document)
        self.assertFalse(document['stamp_ready'])
        self.assertEqual(self.client.get(url + '/stamp.png').status_code, 404)
        placement = self.signature_placement(document, 1)
        normal = self.client.post(url + '/compose', json={'signature_placement': placement})
        self.assert_pdf(normal)
        with fitz.open(stream=normal.content, filetype='pdf') as pdf:
            self.assertEqual([len(page.get_images()) for page in pdf], [0, 1, 0])
        scan = self.client.post(url + '/compose-scan', json={
            'signature_placement': placement, 'profile': 'light', 'dpi': 150,
        })
        self.assert_pdf(scan)
        with fitz.open(stream=scan.content, filetype='pdf') as pdf:
            self.assertEqual(len(pdf), 3)
            for page in pdf:
                self.assertEqual(len(page.get_images()), 1)
                self.assertFalse(page.get_text())
        saved = self.client.get(url).json()['results'][-1]
        self.assertEqual(saved['kind'], 'scan')
        self.assertFalse(saved['stamp_enabled'])
        self.assertTrue(saved['signature_enabled'])
        self.assertEqual(saved['sha256'], hashlib.sha256(scan.content).hexdigest())
        self.assertEqual(saved['scan']['output_sha256'], saved['sha256'])
        self.assertNotEqual(saved['composed_sha256'], saved['sha256'])
        self.assertEqual(self.client.get(saved['url']).content, scan.content)

    def test_source_signature_provenance_and_delete_guard_do_not_affect_stamps(self):
        self.login()
        original_stamp = self.add_stamp()
        raw = signature_scan()
        uploaded = self.client.post(self.prefix + '/api/stamp-sources', files={'file': ('scan.png', raw)})
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        source = uploaded.json()
        url = self.prefix + '/api/stamp-sources/' + source['id']
        params = {'page': 0, 'crop': {'x': .24, 'y': .4, 'width': .70, 'height': .4},
                  'color': 'blue', 'strength': 50, 'rotation': 0}
        preview = self.client.post(url + '/extract', json=params)
        self.assertEqual(preview.status_code, 200)
        saved = self.client.post(url + '/save-signature', json={**params, 'name': 'Из скана', 'signer': None, 'width_mm': 70})
        self.assertEqual(saved.status_code, 200, saved.text)
        item = saved.json()['items'][0]
        self.assertEqual(item['source_id'], source['id'])
        self.assertEqual(item['source_sha256'], hashlib.sha256(raw).hexdigest())
        self.assertEqual(item['output_sha256'], hashlib.sha256(preview.content).hexdigest())
        self.assertEqual(item['sha256'], item['output_sha256'])
        self.assertEqual(item['extraction'], params)
        self.assertEqual(self.client.get(item['source_url']).content, raw)
        self.assertEqual(self.client.delete(url).status_code, 409)
        self.assertEqual(self.client.get(self.prefix + '/api/stamps').json(), original_stamp)
        self.assert_no_scratch()

    def test_invalid_signature_profiles_composition_bounds_and_signed_pdf_keep_state(self):
        self.login()
        library = self.add_signature()
        before = self.files()
        for size in ((10, 16), (1000, 16), (100, 500)):
            image = Image.new('RGBA', size, (20, 40, 180, 200))
            buffer = io.BytesIO()
            image.save(buffer, format='PNG')
            self.assertEqual(self.client.post(self.prefix + '/api/signatures', files={'file': ('bad.png', buffer.getvalue())}).status_code, 422)
        animated = io.BytesIO()
        Image.new('RGBA', (100, 50), (20, 40, 180, 200)).save(animated, format='PNG', save_all=True,
            append_images=[Image.new('RGBA', (100, 50), (180, 40, 20, 200))], duration=100, loop=0)
        self.assertEqual(self.client.post(self.prefix + '/api/signatures', files={'file': ('animated.png', animated.getvalue())}).status_code, 422)
        self.assertEqual(before, self.files())
        self.assertEqual(self.client.get(self.prefix + '/api/signatures').json(), library)
        document = self.upload()
        url = self.url(document)
        placement = self.signature_placement(document)
        for body in ({}, {'signature_placement': dict(placement, x=580)},
                     {'signature_placement': dict(placement, width=1)},
                     {'signature_placement': dict(placement, height=placement['height'] * 2)},
                     {'signature_placement': dict(placement, page=99)}):
            self.assertEqual(self.client.post(url + '/compose', json=body).status_code, 422)
        self.assertEqual(self.client.post(url + '/compose-scan', json={'signature_placement': placement, 'dpi': 300}).status_code, 422)
        self.assertEqual(self.client.post(url + '/signature', json={'signature_id': '../../data'}).status_code, 422)
        self.assertEqual(self.client.get(url).json()['results'], [])
        self.assertEqual(self.client.post(url + '/signature', json={'signature_id': None}).status_code, 200)
        self.assertEqual(self.client.post(url + '/compose', json={'signature_placement': placement}).status_code, 409)
        with fitz.open() as signed:
            page = signed.new_page()
            widget = fitz.Widget()
            widget.field_name = 'synthetic unsigned signature form'
            widget.field_type = fitz.PDF_WIDGET_TYPE_SIGNATURE
            widget.rect = fitz.Rect(20, 20, 100, 60)
            page.add_widget(widget)
            signed_bytes = signed.tobytes()
        self.assertEqual(self.client.post(self.prefix + '/api/documents', files={'file': ('signed.pdf', signed_bytes)}).status_code, 422)
        self.assert_no_scratch()

    def test_shared_queue_quota_and_write_failures_preserve_libraries_and_history(self):
        self.login()
        png = signature_png()
        with patch('app.main.Image.open', side_effect=AssertionError('decode must remain isolated')):
            library = self.add_signature()
        slot = self.client.app.state.pdf_slot
        before = self.files()
        self.client.portal.call(slot.acquire)
        try:
            response = self.client.post(self.prefix + '/api/signatures', files={'file': ('queued.png', png)})
            self.assertEqual(response.status_code, 429)
            self.assertEqual(self.client.get(self.prefix + '/api/signatures').json(), library)
            self.assertEqual(before, self.files())
        finally:
            self.client.portal.call(slot.release)
        document = self.upload()
        url = self.url(document)
        body = {'signature_placement': self.signature_placement(document)}
        before = self.files()
        actual_atomic = main.atomic_json
        def fail_manifest(path, value):
            if path.name == 'manifest.json' and value.get('results'):
                raise OSError('synthetic history write failure')
            return actual_atomic(path, value)
        with patch('app.main.atomic_json', side_effect=fail_manifest):
            failure = self.client.post(url + '/compose', json=body)
        self.assertEqual(failure.status_code, 507, failure.text)
        self.assertEqual(before, self.files())
        self.assert_no_scratch()
        self.client.__exit__(None, None, None)
        os.environ.update(MAX_UPLOAD_MB='1', MAX_TOTAL_MB='1', MAX_RESULT_MB='1')
        self.client = self.open_client()
        self.login()
        before = self.files()
        self.assertEqual(self.client.post(self.prefix + '/api/signatures', files={'file': ('quota.png', png)}).status_code, 429)
        self.assertEqual(self.client.post(url + '/compose', json=body).status_code, 429)
        self.assertEqual(before, self.files())

    def test_old_manifest_read_defaults_do_not_bind_global_signature_or_rewrite_and_legacy_routes_work(self):
        self.login()
        self.add_stamp()
        self.add_signature()
        document = self.upload()
        path = self.root / 'jobs' / document['id'] / 'manifest.json'
        original = json.loads(path.read_text(encoding='utf-8'))
        for key in list(original):
            if key.startswith('signature_') or key in ('stamp_ready', 'stamp_enabled', 'stamp_sha256'):
                original.pop(key)
        path.write_text(json.dumps(original, ensure_ascii=False), encoding='utf-8')
        before = path.read_bytes()
        restored = self.client.get(self.url(document)).json()
        self.assertTrue(restored['stamp_ready'])
        self.assertFalse(restored['signature_ready'])
        self.assertFalse(restored['signature_enabled'])
        self.assertIsNone(restored['signature_id'])
        self.assertEqual(path.read_bytes(), before)
        stamped = self.client.post(self.url(document) + '/stamp', json=self.stamp_placement(restored))
        self.assert_pdf(stamped)
        self.assertEqual(self.client.get(self.url(document)).json()['results'][0]['kind'], 'stamped')
        scan = self.client.post(self.url(document) + '/scan', json={
            'placement': self.stamp_placement(restored), 'profile': 'light', 'dpi': 150,
        })
        self.assert_pdf(scan)
        history = self.client.get(self.url(document)).json()['results']
        self.assertFalse(history[0]['signature_enabled'])
        self.assertFalse(history[1]['signature_enabled'])
        self.assert_no_scratch()


if __name__ == '__main__':
    unittest.main()
