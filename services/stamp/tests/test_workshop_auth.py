"""Workshop SSO access boundaries with an isolated, synthetic authority."""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

from app.main import create_app


class FakeAuthority:
    def __init__(self):
        self.accepted = {'owner-session'}
        self.requests = []
        self.status = 200
        self.payload = None
        self.delay = 0
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                owner.requests.append({'path': self.path, 'headers': dict(self.headers)})
                if owner.delay:
                    threading.Event().wait(owner.delay)
                self.send_response(owner.status)
                if 300 <= owner.status < 400:
                    self.send_header('Location', owner.url.replace('/api/session', '/redirect-target'))
                self.send_header('Content-Type', 'application/json')
                payload = owner.payload
                if payload is None:
                    payload = json.dumps({'authenticated': self.headers.get('Cookie') in {
                        'finance_session=' + token for token in owner.accepted
                    }}).encode()
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                try:
                    self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = 'http://127.0.0.1:%d/api/session' % self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)


class WorkshopAccess(unittest.TestCase):
    prefix = '/tools/stamp'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        Image.new('RGBA', (128, 128), (20, 40, 180, 160)).save(self.root / 'stamp.png')
        self.authority = FakeAuthority()
        self.env = patch.dict(os.environ, {
            'AUTH_MODE': 'workshop', 'WORKSHOP_AUTH_URL': self.authority.url,
            'APP_PASSWORD': '', 'APP_BASE_PATH': self.prefix,
        })
        self.env.start()
        self.client = self.open_client()

    def open_client(self):
        client = TestClient(create_app(self.root), base_url='https://vm-app.ru')
        client.__enter__()
        return client

    def owner(self, token='owner-session'):
        self.client.cookies.set('finance_session', token)
        response = self.client.get(self.prefix + '/api/me')
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.env.stop()
        self.authority.close()
        self.temp.cleanup()

    def test_inherited_owner_access_forwards_only_owner_cookie(self):
        self.client.cookies.set('tracking', 'unrelated')
        self.client.cookies.set('workshop_master_session', 'production-session')
        self.client.cookies.set('stamp_session', 'obsolete-stamp-session')
        me = self.owner()
        self.assertEqual(me['username'], 'Мастерская')
        self.assertEqual(me['auth_mode'], 'workshop')
        self.assertEqual(len(me['csrf']), 64)
        forwarded = self.authority.requests[-1]['headers']
        self.assertEqual(forwarded['Cookie'], 'finance_session=owner-session')
        self.assertNotIn('Authorization', forwarded)
        self.assertNotIn('X-CSRF-Token', forwarded)
        config = self.client.get(self.prefix + '/api/config')
        self.assertEqual(config.status_code, 200, config.text)
        self.assertEqual(config.json()['auth_mode'], 'workshop')
        # Proxy-stripped forwarding still performs the same authority check.
        self.assertEqual(self.client.get('/api/config').status_code, 200)
        index = self.client.get(self.prefix + '/')
        self.assertIn('<base href="/tools/stamp/">', index.text)
        self.assertIn('<body data-auth-mode="workshop" data-main-app-url="/">', index.text)

    def test_missing_expired_and_revoked_sessions_never_expose_api(self):
        for path in ('/api/config', self.prefix + '/api/documents', self.prefix + '/%61pi/source'):
            self.assertEqual(self.client.get(path).status_code, 401)
        self.assertEqual(self.authority.requests, [])
        self.client.cookies.set('workshop_master_session', 'production-session')
        self.assertEqual(self.client.get(self.prefix + '/api/config').status_code, 401)
        self.client.cookies.set('finance_session', 'expired-owner-session')
        self.assertEqual(self.client.get(self.prefix + '/api/me').status_code, 401)
        self.owner()
        self.authority.accepted.clear()
        for path in ('/api/config', '/api/documents', '/api/stamps', '/api/documentation', '/api/source'):
            self.assertEqual(self.client.get(self.prefix + path).status_code, 401)

    def test_csrf_same_origin_and_common_login_logout_boundaries(self):
        me = self.owner()
        url = self.prefix + '/api/settings'
        self.assertEqual(self.client.post(url, json={}).status_code, 403)
        self.assertEqual(self.client.post(url, json={}, headers={'X-CSRF-Token': 'wrong'}).status_code, 403)
        self.client.headers['X-CSRF-Token'] = me['csrf']
        for headers in ({'Origin': 'https://evil.invalid'}, {'Referer': 'https://evil.invalid/document'},
                        {'Origin': 'null'}, {'Origin': 'https://vm-app.ru:444'}):
            self.assertEqual(self.client.post(url, json={}, headers=headers).status_code, 403)
        allowed = self.client.post(url, json={}, headers={
            'Origin': 'https://vm-app.ru', 'Referer': 'https://vm-app.ru/orders',
        })
        self.assertEqual(allowed.status_code, 200, allowed.text)
        self.assertEqual(self.client.get(self.prefix + '/api/source', headers={'Origin': 'https://evil.invalid'}).status_code, 403)
        for path in ('/api/login', '/api/logout'):
            response = self.client.post(self.prefix + path, json={})
            self.assertEqual(response.status_code, 409, response.text)
            self.assertNotIn('set-cookie', response.headers)
        self.assertEqual(self.client.get(self.prefix + '/api/me').status_code, 200)

    def test_authority_failures_and_redirects_fail_closed(self):
        self.owner()
        url = self.prefix + '/api/config'
        for status in (401, 403):
            self.authority.status = status
            self.assertEqual(self.client.get(url).status_code, 401)
        for status in (500, 503, 302):
            self.authority.status = status
            count = len(self.authority.requests)
            response = self.client.get(url)
            self.assertEqual(response.status_code, 503, response.text)
            self.assertEqual(len(self.authority.requests), count + 1)
            self.assertEqual(self.authority.requests[-1]['path'], '/api/session')
        self.authority.status = 200
        for payload in (b'{invalid json', b'x' * 16385):
            self.authority.payload = payload
            self.assertEqual(self.client.get(url).status_code, 503)
        self.authority.payload = None
        self.authority.delay = 2.2
        self.assertEqual(self.client.get(url).status_code, 503)
        self.authority.delay = 0

    def test_http_200_requires_exact_authenticated_boolean_true(self):
        self.owner()
        for payload in ({'authenticated': False}, {'authenticated': 'true'}, {'authenticated': 1},
                        {'authenticated': None}, {}, [], {'masterAuthenticated': True}):
            self.authority.payload = json.dumps(payload).encode()
            self.assertEqual(self.client.get(self.prefix + '/api/config').status_code, 401)
        self.authority.payload = b'{"authenticated":true}'
        self.assertEqual(self.client.get(self.prefix + '/api/config').status_code, 200)

    def test_csrf_survives_restart_and_is_bound_to_owner_session(self):
        first = self.owner()['csrf']
        secret = (self.root / 'csrf-secret').read_bytes()
        self.assertEqual(len(secret), 32)
        self.client.__exit__(None, None, None)
        self.client = self.open_client()
        self.assertEqual(self.owner()['csrf'], first)
        self.assertEqual((self.root / 'csrf-secret').read_bytes(), secret)
        self.authority.accepted.add('another-owner-session')
        second = self.owner('another-owner-session')['csrf']
        self.assertNotEqual(first, second)
        self.assertEqual(self.client.post(self.prefix + '/api/settings', json={}, headers={'X-CSRF-Token': first}).status_code, 403)

    def test_default_password_mode_remains_enforced_and_unknown_mode_rejected(self):
        with patch.dict(os.environ, {'APP_PASSWORD': 'synthetic-password-16-characters'}):
            os.environ.pop('AUTH_MODE', None)
            with TestClient(create_app(self.root), base_url='https://vm-app.ru') as password_client:
                self.assertEqual(password_client.get(self.prefix + '/api/config').status_code, 401)
                login = password_client.post(self.prefix + '/api/login', json={
                    'username': os.environ.get('APP_USERNAME', 'admin'), 'password': 'synthetic-password-16-characters',
                })
                self.assertEqual(login.status_code, 200, login.text)
                self.assertEqual(password_client.get(self.prefix + '/api/me').json()['auth_mode'], 'password')
        with patch.dict(os.environ, {'AUTH_MODE': 'disabled'}):
            with self.assertRaises(ValueError):
                create_app(self.root)
        with patch.dict(os.environ, {'WORKSHOP_AUTH_URL': ''}):
            with self.assertRaises(ValueError):
                create_app(self.root)


if __name__ == '__main__':
    unittest.main()
