"""Durable library workflows using only synthetic documents and artwork."""
import hashlib
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import fitz
from fastapi.testclient import TestClient
from PIL import Image

from app.main import create_app


def picture_bytes(fmt='PNG', color=(25, 75, 180, 160), size=(128, 128)):
    buffer = io.BytesIO()
    Image.new('RGBA' if fmt == 'PNG' else 'RGB', size, color).save(buffer, format=fmt)
    return buffer.getvalue()


def document_bytes(pages=1):
    with fitz.open() as document:
        for index in range(pages):
            page = document.new_page(width=595, height=842)
            page.insert_text((35, 100), 'Synthetic page %d' % (index + 1))
            page.insert_text((35, 700), '7700000000/771401001')
            page.insert_text((57, 735), 'M.P.')
        return document.tobytes()


class DurableLibraryAPI(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'stamp.png').write_bytes(picture_bytes())
        self.env = patch.dict(os.environ, {
            'AUTH_MODE': 'password',
            'APP_USERNAME': 'admin', 'APP_PASSWORD': 'test-password-not-for-deployment',
            'APP_BASE_PATH': '', 'COOKIE_SECURE': 'false', 'JOB_TTL_SECONDS': '1',
            'MAX_UPLOAD_MB': '25', 'MAX_TOTAL_MB': '500', 'MAX_RESULT_MB': '100',
        })
        self.env.start()
        self.client = self.open_client()

    def open_client(self):
        client = TestClient(create_app(self.root))
        client.__enter__()
        response = client.post('/api/login', json={
            'username': 'admin', 'password': 'test-password-not-for-deployment',
        })
        self.assertEqual(response.status_code, 200, response.text)
        client.headers['X-CSRF-Token'] = response.json()['csrf']
        return client

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.env.stop()
        self.temp.cleanup()

    def upload(self, content=None, filename='document.pdf'):
        response = self.client.post('/api/documents', files={
            'file': (filename, content or document_bytes(), 'application/octet-stream'),
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def placement(self, document, page=0):
        candidate = document['candidates'][document['auto_candidate_index']] if document['auto_candidate_index'] is not None else {
            'page': page, 'x': 200, 'y': 500, 'width': document['width_mm'] * 72 / 25.4,
            'height': document['width_mm'] * 72 / 25.4 * document['stamp_aspect'],
        }
        return {key: candidate[key] for key in ('page', 'x', 'y', 'width', 'height')}

    def test_library_keeps_all_artwork_and_document_snapshot(self):
        library = self.client.get('/api/stamps').json()
        old_id = library['active_id']
        initial = next(item for item in library['items'] if item['id'] == old_id)
        self.assertEqual(initial['company_name'], 'Тестовая компания')
        self.assertEqual(initial['name'], 'Тестовая компания')
        self.assertEqual(self.client.get('/api/config').json()['company_name'], 'Тестовая компания')
        old_image = self.client.get('/api/stamps/' + old_id + '/image').content
        document = self.upload()
        changed = self.client.post('/api/stamps', files={'file': ('new.png', picture_bytes(color=(180, 25, 60, 180)), 'image/png')}, data={
            'name': 'Вторая печать', 'company_name': 'Другая компания', 'company_inn': '1234567890', 'width_mm': '40',
        })
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual(len(changed.json()['items']), 2)
        new_id = changed.json()['active_id']
        self.assertNotEqual(new_id, old_id)
        self.assertEqual(self.client.get('/api/config').json()['company_name'], 'Другая компания')
        self.assertEqual(self.client.get('/api/stamps/' + old_id + '/image').content, old_image)
        self.assertEqual(self.client.get('/api/documents/' + document['id'] + '/stamp.png').content, old_image)
        activated = self.client.post('/api/stamps/' + old_id + '/activate', json={})
        self.assertEqual(activated.status_code, 200, activated.text)
        self.assertEqual(activated.json()['active_stamp_id'], old_id)
        legacy = self.client.post('/api/stamp', files={'file': ('legacy.png', picture_bytes(color=(10, 160, 30, 190)), 'image/png')})
        self.assertEqual(legacy.status_code, 200, legacy.text)
        self.assertEqual(len(self.client.get('/api/stamps').json()['items']), 3)

    def test_results_are_immutable_and_survive_restart_and_old_ttl(self):
        source = document_bytes()
        document = self.upload(source)
        job_url = '/api/documents/' + document['id']
        placement = self.placement(document)
        first = self.client.post(job_url + '/stamp', json=placement)
        second = self.client.post(job_url + '/stamp', json=dict(placement, x=placement['x'] + 10))
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        manifest = self.client.get(job_url).json()
        self.assertEqual(manifest['status'], 'completed')
        self.assertEqual(len(manifest['results']), 2)
        self.assertNotEqual(manifest['results'][0]['id'], manifest['results'][1]['id'])
        self.assertEqual(self.client.get(manifest['results'][0]['url']).content, first.content)
        self.assertEqual(manifest['results'][0]['sha256'], hashlib.sha256(first.content).hexdigest())
        self.assertEqual(self.client.get(job_url + '/original').content, source)
        self.client.__exit__(None, None, None)
        os.utime(self.root / 'jobs' / document['id'], (1, 1))
        self.client = self.open_client()
        config = self.client.get('/api/config').json()
        self.assertTrue(config['persistent_history'])
        self.assertEqual(config['retention_minutes'], 0)
        self.assertEqual(len(self.client.get('/api/documents').json()['items']), 1)
        restored = self.client.get(job_url).json()
        self.assertEqual(restored['placement']['x'], placement['x'] + 10)
        self.assertEqual(self.client.get(restored['results'][0]['url']).content, first.content)

    def test_jpg_and_png_keep_original_and_convert_into_pdf(self):
        for fmt, extension, color in (('JPEG', 'jpg', (235, 235, 235)), ('PNG', 'png', (230, 230, 230, 160))):
            with self.subTest(fmt=fmt):
                source = picture_bytes(fmt, color, size=(600, 800))
                document = self.upload(source, 'photo.' + extension)
                self.assertEqual(document['source_type'], extension)
                self.assertEqual(document['page_count'], 1)
                self.assertEqual(document['size'], len(source))
                job_url = '/api/documents/' + document['id']
                self.assertEqual(self.client.get(job_url + '/original').content, source)
                result = self.client.post(job_url + '/stamp', json=self.placement(document))
                self.assertEqual(result.status_code, 200, result.text[:200] if not result.content.startswith(b'%PDF') else '')
                with fitz.open(stream=result.content, filetype='pdf') as pdf:
                    self.assertEqual(len(pdf), 1)
                    self.assertEqual(len(pdf[0].get_images()), 2)
        bad = self.client.post('/api/documents', files={'file': ('bad.png', b'\x89PNG\r\n\x1a\n corrupt', 'image/png')})
        self.assertEqual(bad.status_code, 422)
        self.assertEqual(len(self.client.get('/api/documents').json()['items']), 2)

    def test_scan_rasterizes_every_page_and_saves_separate_result(self):
        document = self.upload(document_bytes(pages=3))
        job_url = '/api/documents/' + document['id']
        placement = self.placement(document)
        result = self.client.post(job_url + '/scan', json={'placement': placement, 'profile': 'standard', 'dpi': 150})
        self.assertEqual(result.status_code, 200, result.text[:200] if not result.content.startswith(b'%PDF') else '')
        with fitz.open(stream=result.content, filetype='pdf') as pdf:
            self.assertEqual(len(pdf), 3)
            for page in pdf:
                self.assertFalse(page.get_text())
                self.assertEqual(len(page.get_images()), 1)
        manifest = self.client.get(job_url).json()
        self.assertEqual(len(manifest['results']), 1)
        saved = manifest['results'][0]
        self.assertEqual(saved['kind'], 'scan')
        self.assertTrue(saved['simulated_scan'])
        self.assertEqual(saved['profile'], 'standard')
        self.assertEqual(saved['dpi'], 150)
        self.assertEqual(self.client.get(saved['url']).content, result.content)
        for invalid in ({'profile': 'invalid', 'dpi': 150}, {'profile': 'light', 'dpi': 300}):
            self.assertEqual(self.client.post(job_url + '/scan', json={'placement': placement, **invalid}).status_code, 422)
        self.assertEqual(len(self.client.get(job_url).json()['results']), 1)
        self.assertEqual(self.client.get('/api/documents/../original').status_code, 404)

    def test_jpeg_exif_orientation_changes_preview_but_preserves_original(self):
        picture = Image.new('RGB', (600, 800), 'white')
        picture.paste((230, 20, 20), (0, 0, 150, 200))
        exif = Image.Exif()
        exif[274] = 6  # Camera stored portrait pixels that display rotated clockwise.
        buffer = io.BytesIO()
        picture.save(buffer, format='JPEG', quality=95, exif=exif)
        source = buffer.getvalue()
        document = self.upload(source, 'camera.jpg')
        page = document['pages'][0]
        self.assertGreater(page['width'], page['height'])
        self.assertAlmostEqual(page['width'] / page['height'], 4 / 3, places=4)
        job_url = '/api/documents/' + document['id']
        self.assertEqual(self.client.get(job_url + '/original').content, source)
        response = self.client.get(job_url + '/pages/0.png')
        self.assertEqual(response.status_code, 200)
        with Image.open(io.BytesIO(response.content)) as preview:
            red = preview.convert('RGB').getpixel((int(preview.width * .90), int(preview.height * .10)))
            white = preview.convert('RGB').getpixel((int(preview.width * .10), int(preview.height * .10)))
            self.assertGreater(red[0], red[1] + 100)
            self.assertGreater(min(white), 230)

    def test_quota_rejections_preserve_saved_results_and_remove_partial_outputs(self):
        document = self.upload()
        job_url = '/api/documents/' + document['id']
        first = self.client.post(job_url + '/stamp', json=self.placement(document))
        self.assertEqual(first.status_code, 200)
        saved = self.client.get(job_url).json()['results'][0]

        # Random pixels force a nontrivial output size without private fixtures.
        noise = Image.frombytes('RGB', (1200, 1600), os.urandom(1200 * 1600 * 3))
        buffer = io.BytesIO()
        noise.save(buffer, format='PNG')
        noisy_document = self.upload(buffer.getvalue(), 'noise.png')
        noisy_url = '/api/documents/' + noisy_document['id']
        self.client.__exit__(None, None, None)
        os.environ.update(MAX_UPLOAD_MB='1', MAX_TOTAL_MB='12', MAX_RESULT_MB='4')
        self.client = self.open_client()
        filler = self.root / 'quota-test.bin'
        filler.write_bytes(b'0' * (7 * 1024 * 1024))
        before = {path.relative_to(self.root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                  for path in self.root.rglob('*') if path.is_file()}
        denied = self.client.post(job_url + '/stamp', json=self.placement(document))
        self.assertEqual(denied.status_code, 429, denied.text)
        denied_upload = self.client.post('/api/documents', files={'file': ('new.pdf', document_bytes(), 'application/pdf')})
        self.assertEqual(denied_upload.status_code, 429, denied_upload.text)
        after = {path.relative_to(self.root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                 for path in self.root.rglob('*') if path.is_file()}
        self.assertEqual(before, after)
        self.assertEqual(self.client.get(saved['url']).content, first.content)
        self.assertEqual(len(self.client.get('/api/documents').json()['items']), 2)
        filler.unlink()

        self.client.__exit__(None, None, None)
        os.environ.update(MAX_TOTAL_MB='500', MAX_RESULT_MB='1')
        self.client = self.open_client()
        before_paths = {path.relative_to(self.root).as_posix() for path in self.root.rglob('*') if path.is_file()}
        placement = self.placement(noisy_document)
        for suffix, body in (('/stamp', placement), ('/scan', {'placement': placement, 'profile': 'standard', 'dpi': 150})):
            with self.subTest(operation=suffix):
                denied = self.client.post(noisy_url + suffix, json=body)
                self.assertEqual(denied.status_code, 413, denied.text)
                self.assertEqual(self.client.get(noisy_url).json()['results'], [])
                after_paths = {path.relative_to(self.root).as_posix() for path in self.root.rglob('*') if path.is_file()}
                self.assertEqual(before_paths, after_paths)
                self.assertFalse(any(path.is_dir() and path.name.startswith('work-') for path in self.root.rglob('*')))
                self.assertEqual(self.client.get(saved['url']).content, first.content)

    def test_storage_folder_failure_allows_retry_without_restart(self):
        document = self.upload()
        job_url = '/api/documents/' + document['id']
        original_mkdir = Path.mkdir
        fail_once = True

        def temporarily_unavailable(path, *args, **kwargs):
            nonlocal fail_once
            if path.name == 'results' and fail_once:
                fail_once = False
                raise PermissionError('Synthetic temporary filesystem failure')
            return original_mkdir(path, *args, **kwargs)

        with patch('app.main.Path.mkdir', autospec=True, side_effect=temporarily_unavailable):
            failed = self.client.post(job_url + '/stamp', json=self.placement(document))
            self.assertEqual(failed.status_code, 507, failed.text)
            self.assertEqual(self.client.get(job_url).json()['results'], [])
            retried = self.client.post(job_url + '/stamp', json=self.placement(document))
            self.assertEqual(retried.status_code, 200, retried.text[:200] if not retried.content.startswith(b'%PDF') else '')
        self.assertEqual(len(self.client.get(job_url).json()['results']), 1)


if __name__ == '__main__':
    unittest.main()
