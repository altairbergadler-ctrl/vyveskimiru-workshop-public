"""Stamp-from-scan API integration using synthetic private source documents."""
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


def scan_bytes(fmt='PNG'):
    image = Image.new('RGB', (1200, 900), 'white')
    draw = ImageDraw.Draw(image)
    draw.text((40, 70), 'SYNTHETIC DOCUMENT 1234567890', fill='black')
    draw.line((40, 150, 1100, 150), fill='black', width=3)
    draw.ellipse((450, 250, 750, 550), outline=(30, 60, 165), width=10)
    draw.ellipse((475, 275, 725, 525), outline=(35, 65, 170), width=4)
    draw.line((520, 370, 680, 370), fill=(30, 60, 165), width=7)
    draw.line((545, 425, 655, 425), fill=(30, 60, 165), width=7)
    buffer = io.BytesIO()
    image.save(buffer, format=fmt)
    return buffer.getvalue()


def scanned_pdf():
    with fitz.open() as document:
        first = document.new_page(width=400, height=300)
        first.insert_text((30, 50), 'FIRST PAGE WITHOUT A STAMP')
        second = document.new_page(width=400, height=300)
        second.insert_image(second.rect, stream=scan_bytes())
        return document.tobytes()


def blank_document():
    with fitz.open() as document:
        page = document.new_page()
        page.insert_text((35, 100), 'SYNTHETIC DOCUMENT')
        return document.tobytes()


def ready_stamp():
    buffer = io.BytesIO()
    image = Image.new('RGBA', (128, 128), (0, 0, 0, 0))
    ImageDraw.Draw(image).ellipse((8, 8, 120, 120), outline=(160, 25, 25, 230), width=7)
    image.save(buffer, format='PNG')
    return buffer.getvalue()


class StampSourceAPI(unittest.TestCase):
    prefix = '/tools/stamp'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'data'
        # An installation with no starter artwork must be able to create its
        # first stamp from a scan. Avoid copying supplied company artwork.
        self.app_root = Path(self.temp.name) / 'app-root'
        static = self.app_root / 'app' / 'static'
        static.mkdir(parents=True)
        (static / 'index.html').write_text('<base href="/"><body></body>', encoding='utf-8')
        self.root_patch = patch('app.main.ROOT', self.app_root)
        self.root_patch.start()
        self.env = patch.dict(os.environ, {
            'AUTH_MODE': 'password', 'APP_USERNAME': 'admin',
            'APP_PASSWORD': 'synthetic-password-for-integration',
            'APP_BASE_PATH': self.prefix, 'COOKIE_SECURE': 'false',
            'MAX_UPLOAD_MB': '25', 'MAX_TOTAL_MB': '500',
            'MAX_RESULT_MB': '100', 'MAX_JOBS': '100', 'MAX_PAGES': '50',
        })
        self.env.start()
        self.client = self.open_client()

    def open_client(self):
        client = TestClient(main.create_app(self.root))
        client.__enter__()
        return client

    def login(self):
        response = self.client.post(self.prefix + '/api/login', json={
            'username': 'admin', 'password': 'synthetic-password-for-integration',
        })
        self.assertEqual(response.status_code, 200, response.text)
        self.client.headers['X-CSRF-Token'] = response.json()['csrf']

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.env.stop()
        self.root_patch.stop()
        self.temp.cleanup()

    def upload(self, content=None, filename='scan.png'):
        response = self.client.post(self.prefix + '/api/stamp-sources', files={
            'file': (filename, content or scan_bytes(), 'application/octet-stream'),
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def params(self, page=0):
        return {'page': page, 'crop': {'x': .35, 'y': .25, 'width': .30, 'height': .40},
                'color': 'blue', 'strength': 50, 'rotation': 0}

    def save_params(self, page=0):
        return {**self.params(page), 'name': 'Из синтетического скана',
                'company_name': 'Тестовая организация', 'company_inn': '1234567890', 'width_mm': 40}

    def files(self):
        return {path.relative_to(self.root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in self.root.rglob('*') if path.is_file()}

    def assert_no_scratch(self):
        self.assertFalse(any(path.is_dir() and path.name.startswith('work-') for path in self.root.rglob('*')))

    def test_all_source_routes_require_auth_and_csrf_and_upload_uses_file_cap(self):
        fake_id = '0' * 32
        for path in ('/api/stamp-sources', f'/api/stamp-sources/{fake_id}',
                     f'/api/stamp-sources/{fake_id}/original', f'/api/stamp-sources/{fake_id}/pages/0.png',
                     f'/api/stamps/{fake_id}/source'):
            self.assertEqual(self.client.get(self.prefix + path).status_code, 401)
        self.assertEqual(self.client.post(self.prefix + '/api/stamp-sources', files={'file': ('x.png', scan_bytes())}).status_code, 401)
        self.login()
        token = self.client.headers.pop('X-CSRF-Token')
        for suffix, body in (('/extract', self.params()), ('/save', self.save_params())):
            self.assertEqual(self.client.post(self.prefix + '/api/stamp-sources/' + fake_id + suffix, json=body).status_code, 403)
        self.assertEqual(self.client.post(self.prefix + '/api/stamp-sources', files={'file': ('x.png', scan_bytes())}).status_code, 403)
        self.assertEqual(self.client.delete(self.prefix + '/api/stamp-sources/' + fake_id).status_code, 403)
        self.client.headers['X-CSRF-Token'] = token
        source = self.upload(scanned_pdf() + b'\n' + b' ' * 20000, 'padded.pdf')
        self.assertEqual(source['page_count'], 2)
        oversized = self.client.post(self.prefix + '/api/stamp-sources', content=b'x', headers={
            'Content-Length': str(26 * 1024 * 1024 + 1), 'Content-Type': 'application/octet-stream',
        })
        self.assertEqual(oversized.status_code, 413)
        self.assertEqual(len(self.client.get(self.prefix + '/api/stamp-sources').json()['items']), 1)

    def test_first_stamp_can_start_from_image_without_any_existing_stamp(self):
        self.login()
        self.assertFalse(self.client.get(self.prefix + '/api/config').json()['stamp_ready'])
        self.assertEqual(self.client.get(self.prefix + '/api/stamps').json()['items'], [])
        source = self.upload()
        url = self.prefix + '/api/stamp-sources/' + source['id']
        page = self.client.get(url + '/pages/0.png')
        self.assertEqual(page.status_code, 200)
        with Image.open(io.BytesIO(page.content)) as image:
            self.assertLessEqual(image.width, 1600)
        before = self.files()
        preview = self.client.post(url + '/extract', json=self.params())
        self.assertEqual(preview.status_code, 200, preview.text[:200] if not preview.content.startswith(b'\x89PNG') else '')
        with Image.open(io.BytesIO(preview.content)) as image:
            self.assertEqual(image.mode, 'RGBA')
            self.assertEqual(image.getchannel('A').getextrema()[0], 0)
            self.assertGreater(image.getchannel('A').getextrema()[1], 0)
        self.assertEqual(preview.headers['X-Source-SHA256'], source['source_sha256'])
        self.assertEqual(preview.headers['X-Output-SHA256'], hashlib.sha256(preview.content).hexdigest())
        self.assertIsInstance(json.loads(preview.headers['X-Extraction-Warnings']), list)
        self.assertEqual(before, self.files())
        self.assertEqual(self.client.get(self.prefix + '/api/stamps').json()['items'], [])
        self.assert_no_scratch()

    def test_pdf_jpg_png_keep_originals_and_correct_page_selection(self):
        self.login()
        for filename, raw, pages in (('scan.png', scan_bytes(), 1), ('photo.jpg', scan_bytes('JPEG'), 1),
                                     ('../../scan.pdf', scanned_pdf(), 2)):
            with self.subTest(filename=filename):
                source = self.upload(raw, filename)
                self.assertEqual(source['page_count'], pages)
                self.assertEqual(source['size'], len(raw))
                self.assertEqual(source['source_sha256'], hashlib.sha256(raw).hexdigest())
                self.assertNotIn('/', source['filename'])
                self.assertTrue(source['original_url'].startswith(self.prefix + '/api/'))
                self.assertEqual(self.client.get(source['original_url']).content, raw)
                url = self.prefix + '/api/stamp-sources/' + source['id']
                page = self.client.get(url + '/pages/' + str(pages - 1) + '.png')
                self.assertEqual(page.status_code, 200)
                extracted = self.client.post(url + '/extract', json=self.params(pages - 1))
                self.assertEqual(extracted.status_code, 200, extracted.text[:200] if not extracted.content.startswith(b'\x89PNG') else '')
                if pages == 2:
                    blank = self.client.post(url + '/extract', json=self.params(0))
                    self.assertEqual(blank.status_code, 422)
        self.assertEqual(len(self.client.get(self.prefix + '/api/stamp-sources').json()['items']), 3)
        self.assert_no_scratch()

    def test_invalid_sources_and_crops_do_not_create_library_or_leave_files(self):
        self.login()
        for filename, raw in (('broken.pdf', b'%PDF- broken'), ('broken.png', b'\x89PNG\r\n\x1a\n incomplete'),
                              ('fake.jpg', b'not an image'), ('file.docx', scanned_pdf())):
            self.assertEqual(self.client.post(self.prefix + '/api/stamp-sources', files={'file': (filename, raw)}).status_code, 422)
        self.assertEqual(self.client.get(self.prefix + '/api/stamp-sources').json()['items'], [])
        self.assertEqual(list((self.root / 'stamp-sources').iterdir()), [])
        source = self.upload()
        url = self.prefix + '/api/stamp-sources/' + source['id']
        before = self.files()
        invalid = [dict(self.params(), page=4), dict(self.params(), strength=101), dict(self.params(), strength=50.5),
                   dict(self.params(), rotation=16), dict(self.params(), color='green'),
                   dict(self.params(), crop={'x': .9, 'y': .2, 'width': .5, 'height': .4}),
                   dict(self.params(), crop={'x': .2, 'y': .2, 'width': 0, 'height': .4})]
        for params in invalid:
            self.assertEqual(self.client.post(url + '/extract', json=params).status_code, 422)
        self.assertEqual(self.client.get(url + '/pages/4.png').status_code, 404)
        self.assertEqual(self.client.get(url + '/pages/-1.png').status_code, 404)
        self.assertEqual(before, self.files())
        self.assertEqual(self.client.get(self.prefix + '/api/stamps').json()['items'], [])
        self.assert_no_scratch()

    def test_save_provenance_restart_and_immutable_existing_stamp_and_document(self):
        self.login()
        old_png = ready_stamp()
        old = self.client.post(self.prefix + '/api/stamps', files={'file': ('ready.png', old_png)}).json()
        old_id = old['active_id']
        document = self.client.post(self.prefix + '/api/documents', files={'file': ('document.pdf', blank_document())})
        self.assertEqual(document.status_code, 200, document.text)
        old_document_id = document.json()['id']
        raw = scanned_pdf()
        source = self.upload(raw, 'scan.pdf')
        url = self.prefix + '/api/stamp-sources/' + source['id']
        preview = self.client.post(url + '/extract', json=self.params(1))
        self.assertEqual(preview.status_code, 200)
        saved = self.client.post(url + '/save', json=self.save_params(1))
        self.assertEqual(saved.status_code, 200, saved.text)
        library = saved.json()
        new_id = library['active_id']
        item = next(item for item in library['items'] if item['id'] == new_id)
        self.assertEqual(len(library['items']), 2)
        self.assertNotEqual(new_id, old_id)
        self.assertEqual(item['source_id'], source['id'])
        self.assertEqual(item['source_sha256'], hashlib.sha256(raw).hexdigest())
        self.assertEqual(item['output_sha256'], hashlib.sha256(preview.content).hexdigest())
        self.assertEqual(item['extraction'], self.params(1))
        self.assertTrue(item['source_url'].startswith(self.prefix + '/api/stamps/'))
        self.assertEqual(self.client.get(item['source_url']).content, raw)
        self.assertEqual(self.client.get(self.prefix + '/api/stamps/' + old_id + '/image').content, old_png)
        self.assertEqual(self.client.get(self.prefix + '/api/documents/' + old_document_id + '/stamp.png').content, old_png)
        self.assertEqual(self.client.delete(url).status_code, 409)

        self.client.__exit__(None, None, None)
        self.client = self.open_client()
        self.login()
        self.assertEqual(self.client.get(self.prefix + '/api/stamps').json(), library)
        self.assertEqual(self.client.get(self.prefix + '/api/stamps/' + new_id + '/image').content, preview.content)
        self.assertEqual(self.client.get(item['source_url']).content, raw)
        self.assertEqual(self.client.get(self.prefix + '/api/stamp-sources').json()['items'][0]['id'], source['id'])
        fresh = self.client.post(self.prefix + '/api/documents', files={'file': ('new-document.pdf', blank_document())})
        self.assertEqual(fresh.status_code, 200, fresh.text)
        info = fresh.json()
        width = 40 * 72 / 25.4
        result = self.client.post(self.prefix + '/api/documents/' + info['id'] + '/stamp', json={
            'page': 0, 'x': 200, 'y': 500, 'width': width, 'height': width * info['stamp_aspect'],
        })
        self.assertEqual(result.status_code, 200, result.text[:200] if not result.content.startswith(b'%PDF') else '')
        with fitz.open(stream=result.content, filetype='pdf') as pdf:
            self.assertEqual(len(pdf[0].get_images()), 1)
        self.assert_no_scratch()

    def test_source_quota_delete_and_failed_library_publish_preserve_data(self):
        self.login()
        source = self.upload()
        url = self.prefix + '/api/stamp-sources/' + source['id']
        before = self.files()
        actual_atomic_json = main.atomic_json

        def fail_library_write(path, value):
            if path.name == 'stamps.json':
                raise OSError('Synthetic storage failure')
            return actual_atomic_json(path, value)

        with patch('app.main.atomic_json', side_effect=fail_library_write):
            failed = self.client.post(url + '/save', json=self.save_params())
        self.assertEqual(failed.status_code, 507, failed.text)
        self.assertEqual(before, self.files())
        self.assert_no_scratch()
        self.assertEqual(self.client.get(self.prefix + '/api/stamps').json()['items'], [])

        self.client.__exit__(None, None, None)
        os.environ.update(MAX_TOTAL_MB='1', MAX_UPLOAD_MB='1')
        self.client = self.open_client()
        self.login()
        before = self.files()
        self.assertEqual(self.client.post(self.prefix + '/api/stamp-sources', files={'file': ('another.png', scan_bytes())}).status_code, 429)
        self.assertEqual(self.client.post(url + '/extract', json=self.params()).status_code, 429)
        self.assertEqual(before, self.files())
        self.assertEqual(self.client.get(source['original_url']).content, scan_bytes())
        self.assertEqual(self.client.delete(url).status_code, 200)
        self.assertEqual(self.client.get(source['original_url']).status_code, 404)
        self.assertEqual(self.client.get(self.prefix + '/api/stamp-sources').json()['items'], [])

    def test_oversize_native_png_is_terminated_without_orphans_and_can_retry(self):
        self.client.__exit__(None, None, None)
        os.environ.update(MAX_UPLOAD_MB='14', MAX_TOTAL_MB='15', MAX_RESULT_MB='1')
        self.client = self.open_client()
        self.login()
        noisy_image = Image.frombytes('RGB', (2000, 2000), os.urandom(2000 * 2000 * 3))
        buffer = io.BytesIO()
        noisy_image.save(buffer, format='PNG')
        raw = buffer.getvalue()
        source = self.upload(raw, 'synthetic-noise.png')
        url = self.prefix + '/api/stamp-sources/' + source['id']
        before = self.files()
        whole_page = dict(self.params(), crop={'x': 0, 'y': 0, 'width': 1, 'height': 1})
        failed = self.client.post(url + '/extract', json=whole_page)
        self.assertEqual(failed.status_code, 413, failed.text[:200] if not failed.content.startswith(b'\x89PNG') else f'PNG {len(failed.content)} bytes')
        self.assertEqual(before, self.files())
        self.assert_no_scratch()
        self.assertEqual(self.client.get(source['original_url']).content, raw)
        self.assertEqual(self.client.get(self.prefix + '/api/stamps').json()['items'], [])
        # With only 15 MB available, a leaked 2 MB reservation would reject
        # this retry. A smaller crop produces a bounded successful PNG.
        smaller = dict(self.params(), crop={'x': .2, 'y': .2, 'width': .25, 'height': .25})
        retried = self.client.post(url + '/extract', json=smaller)
        self.assertEqual(retried.status_code, 200, retried.text[:200] if not retried.content.startswith(b'\x89PNG') else '')
        self.assertEqual(before, self.files())
        self.assert_no_scratch()

    def test_thin_line_preview_cannot_replace_active_stamp_and_valid_stamp_still_applies(self):
        self.login()
        original_png = ready_stamp()
        original_library = self.client.post(self.prefix + '/api/stamps', files={'file': ('ready.png', original_png)}).json()
        old_id = original_library['active_id']
        line = Image.new('RGB', (2000, 300), 'white')
        ImageDraw.Draw(line).line((50, 150, 1950, 150), fill=(25, 45, 190), width=6)
        buffer = io.BytesIO()
        line.save(buffer, format='PNG')
        source = self.upload(buffer.getvalue(), 'synthetic-line.png')
        url = self.prefix + '/api/stamp-sources/' + source['id']
        whole_page = {'page': 0, 'crop': {'x': 0, 'y': 0, 'width': 1, 'height': 1},
                      'color': 'blue', 'strength': 50, 'rotation': 0}
        preview = self.client.post(url + '/extract', json=whole_page)
        self.assertEqual(preview.status_code, 200)
        with Image.open(io.BytesIO(preview.content)) as image:
            self.assertLess(image.height / image.width, .1)
        before = self.files()
        rejected = self.client.post(url + '/save', json={**self.save_params(), **whole_page})
        self.assertEqual(rejected.status_code, 422, rejected.text)
        self.assertEqual(self.client.get(self.prefix + '/api/stamps').json(), original_library)
        self.assertEqual(self.client.get(self.prefix + '/api/stamps/' + old_id + '/image').content, original_png)
        self.assertEqual(self.client.get(source['original_url']).content, buffer.getvalue())
        self.assertEqual(before, self.files())
        self.assert_no_scratch()

        valid_source = self.upload()
        valid_url = self.prefix + '/api/stamp-sources/' + valid_source['id']
        saved = self.client.post(valid_url + '/save', json=self.save_params())
        self.assertEqual(saved.status_code, 200, saved.text)
        new_id = saved.json()['active_id']
        self.assertNotEqual(new_id, old_id)
        document = self.client.post(self.prefix + '/api/documents', files={'file': ('document.pdf', blank_document())})
        self.assertEqual(document.status_code, 200, document.text)
        info = document.json()
        width = 40 * 72 / 25.4
        stamped = self.client.post(self.prefix + '/api/documents/' + info['id'] + '/stamp', json={
            'page': 0, 'x': 200, 'y': 500, 'width': width, 'height': width * info['stamp_aspect'],
        })
        self.assertEqual(stamped.status_code, 200, stamped.text[:200] if not stamped.content.startswith(b'%PDF') else '')
        with fitz.open(stream=stamped.content, filetype='pdf') as pdf:
            self.assertEqual(len(pdf[0].get_images()), 1)
        self.assert_no_scratch()

    def test_ready_png_decode_is_isolated_and_processing_queue_preserves_active_stamp(self):
        self.login()
        png = ready_stamp()
        # Child processes start a fresh interpreter. A real successful upload
        # under this guard proves that no parent-side Pillow decode occurs.
        with patch('app.main.Image.Image.load', side_effect=AssertionError('PNG decoding must not run in the API process')):
            first = self.client.post(self.prefix + '/api/stamps', files={'file': ('first.png', png)})
        self.assertEqual(first.status_code, 200, first.text)
        original_library = first.json()
        before = self.files()
        slot = self.client.app.state.pdf_slot
        self.client.portal.call(slot.acquire)
        try:
            queued = self.client.post(self.prefix + '/api/stamps', files={'file': ('queued.png', png)})
            self.assertEqual(queued.status_code, 429, queued.text)
            self.assertEqual(self.client.get(self.prefix + '/api/stamps').json(), original_library)
            self.assertEqual(before, self.files())
        finally:
            self.client.portal.call(slot.release)
        retry = self.client.post(self.prefix + '/api/stamps', files={'file': ('retry.png', png)})
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertEqual(len(retry.json()['items']), 2)
        self.assertNotEqual(retry.json()['active_id'], original_library['active_id'])
        self.assert_no_scratch()


if __name__ == '__main__':
    unittest.main()
