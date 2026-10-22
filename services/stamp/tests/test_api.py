"""Integration checks without private customer files or external services."""
import io
import os
from http.cookies import SimpleCookie
from pathlib import Path
import tempfile
import tarfile
import unittest
from unittest.mock import patch

import fitz
from PIL import Image
from fastapi.testclient import TestClient
from app.main import create_app


def pdf_bytes(inn='7700000000'):
    doc = fitz.open()
    page = doc.new_page(width=842, height=595)
    page.insert_text((35, 455), inn + '/771401001', fontsize=10)
    page.insert_text((57, 480), 'M.P.', fontsize=10)
    result = doc.tobytes()
    doc.close()
    return result


class APIFlow(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        Image.new('RGBA', (128, 128), (20, 40, 180, 160)).save(Path(self.temp.name) / 'stamp.png')
        self.env = patch.dict(os.environ, {'AUTH_MODE': 'password', 'APP_USERNAME': 'admin', 'APP_PASSWORD': 'test-password-not-for-deployment', 'COOKIE_SECURE': 'false', 'APP_BASE_PATH': ''})
        self.env.start()
        self.client = TestClient(create_app(Path(self.temp.name)))
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.env.stop()
        self.temp.cleanup()

    def login(self):
        response = self.client.post('/api/login', json={'username': 'admin', 'password': 'test-password-not-for-deployment'})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn('HttpOnly', response.headers.get('set-cookie', ''))
        self.assertIn('SameSite=strict', response.headers.get('set-cookie', ''))
        self.client.headers['X-CSRF-Token'] = response.json()['csrf']

    def upload(self, content=None):
        response = self.client.post('/api/documents', files={'file': ('../../invoice.pdf', content or pdf_bytes(), 'application/pdf')})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_authentication_and_csrf(self):
        self.assertEqual(self.client.get('/api/config').status_code, 401)
        self.assertEqual(self.client.post('/api/login', json={'username': 'admin', 'password': 'wrong'}).status_code, 401)
        self.login()
        self.client.headers.pop('X-CSRF-Token')
        self.assertEqual(self.client.post('/api/settings', json={}).status_code, 403)

    def test_full_pdf_flow_preserves_text_and_stamp_snapshot(self):
        self.login()
        source = pdf_bytes()
        info = self.upload(source)
        self.assertEqual(info['filename'], 'invoice.pdf')
        self.assertIsNotNone(info['auto_candidate_index'], info)
        job = info['id']
        stamp = self.client.get(f'/api/documents/{job}/stamp.png').content
        page = self.client.get(f'/api/documents/{job}/pages/0.png')
        self.assertEqual(page.status_code, 200, page.text[:100] if not page.content.startswith(b'\x89PNG') else '')
        self.assertTrue(page.content.startswith(b'\x89PNG'))
        replacement = io.BytesIO()
        Image.new('RGBA', (128, 128), (10, 30, 140, 200)).save(replacement, format='PNG')
        change = self.client.post('/api/stamp', files={'file': ('new.png', replacement.getvalue(), 'image/png')})
        self.assertEqual(change.status_code, 200, change.text)
        self.assertEqual(stamp, self.client.get(f'/api/documents/{job}/stamp.png').content)
        candidate = info['candidates'][info['auto_candidate_index']]
        placement = {k: candidate[k] for k in ('page', 'x', 'y', 'width', 'height')}
        result = self.client.post(f'/api/documents/{job}/stamp', json=placement)
        self.assertEqual(result.status_code, 200, result.text[:300] if not result.content.startswith(b'%PDF') else '')
        with fitz.open(stream=source, filetype='pdf') as before, fitz.open(stream=result.content, filetype='pdf') as after:
            self.assertEqual(before[0].get_text(), after[0].get_text())
            self.assertEqual(before[0].rect, after[0].rect)
            self.assertEqual(len(after[0].get_images()), 1)
        duplicate = self.client.post('/api/documents', files={'file': ('again.pdf', result.content, 'application/pdf')})
        self.assertEqual(duplicate.status_code, 422)
        self.assertEqual(self.client.delete(f'/api/documents/{job}').status_code, 200)
        self.assertEqual(self.client.get(f'/api/documents/{job}/stamp.png').status_code, 404)

    def test_ambiguity_bounds_and_invalid_upload(self):
        self.login()
        unknown = self.upload(pdf_bytes('1234567890'))
        self.assertIsNone(unknown['auto_candidate_index'])
        data = self.upload()
        job = data['id']
        candidate = data['candidates'][data['auto_candidate_index']]
        candidate = {k: candidate[k] for k in ('page', 'x', 'y', 'width', 'height')}
        bad = dict(candidate, x=840)
        self.assertEqual(self.client.post(f'/api/documents/{job}/stamp', json=bad).status_code, 422)
        bad = dict(candidate, height=30)
        self.assertEqual(self.client.post(f'/api/documents/{job}/stamp', json=bad).status_code, 422)
        response = self.client.post('/api/documents', files={'file': ('fake.pdf', b'not a pdf', 'application/pdf')})
        self.assertEqual(response.status_code, 422)
        response = self.client.post('/api/settings', json={'company_inn': 'abc'})
        self.assertEqual(response.status_code, 422)


class NestedPathAPI(unittest.TestCase):
    """Exercise both forwarding styles: retained and proxy-stripped URL prefix."""
    prefix = '/tools/stamp'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        # Entirely synthetic fixture, independent of supplied company artwork.
        Image.new('RGBA', (128, 128), (20, 40, 180, 160)).save(root / 'stamp.png')
        self.env = patch.dict(os.environ, {
            'AUTH_MODE': 'password',
            'APP_USERNAME': 'admin', 'APP_PASSWORD': 'test-password-not-for-deployment',
            'COOKIE_SECURE': 'false', 'APP_BASE_PATH': self.prefix,
        })
        self.env.start()
        self.client = TestClient(create_app(root))
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.env.stop()
        self.temp.cleanup()

    def test_authentication_covers_prefixed_stripped_and_encoded_paths(self):
        for path in (
            '/api/config', self.prefix + '/api/config',
            '/api/source', self.prefix + '/api/source',
            self.prefix + '/%61pi/config', '/%61pi/config',
            self.prefix + '/api/config/',
            self.prefix + '/api/documents/' + '0' * 32 + '/stamp.png',
        ):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 401, response.text)
        # Similar-looking prefixes and doubled prefixes must not resolve to API.
        for path in ('/tools/stamp-extra/api/config', self.prefix * 2 + '/api/config'):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 404)
        # Interactive API docs/schema are intentionally disabled everywhere.
        for prefix in ('', self.prefix):
            for suffix in ('/docs', '/redoc', '/openapi.json'):
                with self.subTest(path=prefix + suffix):
                    self.assertEqual(self.client.get(prefix + suffix).status_code, 404)

    def test_nested_upload_stamp_cookie_csrf_and_logout(self):
        index = self.client.get(self.prefix + '/')
        self.assertEqual(index.status_code, 200)
        self.assertIn('<base href="/tools/stamp/">', index.text)
        login = self.client.post(self.prefix + '/api/login', json={
            'username': 'admin', 'password': 'test-password-not-for-deployment',
        })
        self.assertEqual(login.status_code, 200, login.text)
        cookie = SimpleCookie()
        cookie.load(login.headers['set-cookie'])
        self.assertEqual(cookie['stamp_session']['path'], self.prefix + '/')
        self.assertTrue(cookie['stamp_session']['httponly'])
        token = login.json()['csrf']
        session_cookie = 'stamp_session=' + cookie['stamp_session'].value

        # Browser cookie is scoped to the public prefix. A stripping proxy still
        # forwards it to the internal /api route, simulated explicitly here.
        self.assertEqual(self.client.get('/api/config').status_code, 401)
        stripped = self.client.get('/api/config', headers={'Cookie': session_cookie})
        self.assertEqual(stripped.status_code, 200, stripped.text)
        for path, headers in ((self.prefix + '/api/settings', {}),
                              ('/api/settings', {'Cookie': session_cookie})):
            response = self.client.post(path, json={}, headers=headers)
            self.assertEqual(response.status_code, 403, response.text)

        self.client.headers['X-CSRF-Token'] = token
        self.assertEqual(self.client.get(self.prefix + '/api/me').status_code, 200)
        # Source download is authenticated; built-in Swagger remains unavailable.
        source_code = self.client.get(self.prefix + '/api/source')
        self.assertEqual(source_code.status_code, 200)
        self.assertTrue(source_code.content.startswith(b'\x1f\x8b'))
        with tarfile.open(fileobj=io.BytesIO(source_code.content), mode='r:gz') as archive:
            members = archive.getnames()
        self.assertIn('stamp-service/Открыть инструмент.cmd', members)
        self.assertIn('stamp-service/app/main.py', members)
        self.assertFalse(any('/data/' in name or name.endswith('/.env') or '/.venv/' in name for name in members))
        self.assertEqual(self.client.get(self.prefix + '/docs').status_code, 404)

        # >16 KiB checks that prefix normalization also selects the upload limit,
        # instead of incorrectly applying the small JSON request-body limit.
        source = pdf_bytes() + b'\n' + b' ' * 20000
        uploaded = self.client.post(self.prefix + '/api/documents', files={
            'file': ('synthetic.pdf', source, 'application/pdf'),
        })
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        manifest = uploaded.json()
        self.assertIsNotNone(manifest['auto_candidate_index'], manifest)
        job_url = self.prefix + '/api/documents/' + manifest['id']
        image = self.client.get(job_url + '/pages/0.png')
        self.assertEqual(image.status_code, 200)
        self.assertTrue(image.content.startswith(b'\x89PNG'))
        stamp = self.client.get(job_url + '/stamp.png')
        self.assertEqual(stamp.status_code, 200)
        self.assertTrue(stamp.content.startswith(b'\x89PNG'))
        candidate = manifest['candidates'][manifest['auto_candidate_index']]
        placement = {key: candidate[key] for key in ('page', 'x', 'y', 'width', 'height')}
        output = self.client.post(job_url + '/stamp', json=placement)
        self.assertEqual(output.status_code, 200, output.text[:200] if not output.content.startswith(b'%PDF') else '')
        with fitz.open(stream=source, filetype='pdf') as before, fitz.open(stream=output.content, filetype='pdf') as after:
            self.assertEqual(before[0].get_text(), after[0].get_text())
            self.assertEqual(len(after[0].get_images()), 1)

        library = self.client.get(self.prefix + '/api/stamps').json()
        old_stamp_id = library['active_id']
        artwork = io.BytesIO()
        Image.new('RGBA', (128, 128), (180, 40, 25, 170)).save(artwork, format='PNG')
        added = self.client.post(self.prefix + '/api/stamps', files={
            'file': ('new.png', artwork.getvalue(), 'image/png'),
        }, data={'name': 'Второй оттиск'})
        self.assertEqual(added.status_code, 200, added.text)
        self.assertEqual(len(added.json()['items']), 2)
        activated = self.client.post(self.prefix + '/api/stamps/' + old_stamp_id + '/activate', json={})
        self.assertEqual(activated.status_code, 200, activated.text)
        self.assertEqual(activated.json()['active_stamp_id'], old_stamp_id)
        scan = self.client.post(job_url + '/scan', json={'placement': placement, 'profile': 'light', 'dpi': 150})
        self.assertEqual(scan.status_code, 200, scan.text[:200] if not scan.content.startswith(b'%PDF') else '')
        history = self.client.get(self.prefix + '/api/documents').json()['items']
        self.assertEqual(len(history), 1)
        self.assertEqual(len(history[0]['results']), 2)
        for saved, expected in zip(history[0]['results'], (output.content, scan.content)):
            self.assertTrue(saved['url'].startswith(job_url + '/results/'))
            self.assertEqual(self.client.get(saved['url']).content, expected)
        self.assertEqual(self.client.get(job_url + '/original').content, source)

        logout = self.client.post(self.prefix + '/api/logout')
        self.assertEqual(logout.status_code, 200, logout.text)
        deleted = SimpleCookie()
        deleted.load(logout.headers['set-cookie'])
        self.assertEqual(deleted['stamp_session']['path'], self.prefix + '/')
        self.assertEqual(deleted['stamp_session']['max-age'], '0')
        self.assertEqual(self.client.get(self.prefix + '/api/config').status_code, 401)
        self.assertEqual(self.client.get('/api/config', headers={'Cookie': session_cookie}).status_code, 401)


if __name__ == '__main__':
    unittest.main()
