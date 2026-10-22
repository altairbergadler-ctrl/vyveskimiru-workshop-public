"""Native Corel capability tests: no Corel, subprocess, AI job or user file writes."""
import concurrent.futures
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

import corel_launch as app
import editor_auth
import render_server


def payload(**changes):
    result = {'text': '\r\nЦВЕТЫ\r\n\r\n  ДОМ  \r\n', 'width_cm': 220,
              'height_cm': 50, 'line_gap_cm': 5, 'text_align': 'center',
              'font_family': 'Arial', 'font_bold': True, 'front_color': '#00aaFF'}
    result.update(changes)
    return result


class CorelLaunches(unittest.TestCase):
    def setUp(self):
        self.now = 1000
        self.store = app.CorelLaunches(clock=lambda: self.now)

    def assertError(self, status, fn, *args):
        with self.assertRaises(app.LaunchError) as caught:
            fn(*args)
        self.assertEqual(caught.exception.status, status)

    def test_specification_is_only_normalized_data_and_claim_is_once(self):
        source = payload()
        before = dict(source)
        created = self.store.create(source)
        self.assertEqual(set(created), {'id', 'launch_url', 'status_token', 'expires_in'})
        self.assertRegex(created['id'], r'^[0-9a-f]{64}$')
        self.assertRegex(created['status_token'], r'^[0-9a-f]{64}$')
        self.assertNotEqual(created['id'], created['status_token'])
        self.assertEqual(created['launch_url'], 'signage-corel://open/' + created['id'])
        self.assertEqual(created['expires_in'], 300)
        pending = self.store.status(created['id'], created['status_token'])
        self.assertEqual(pending['status'], 'pending')
        self.assertEqual(set(pending), {'id', 'status', 'expires_in'})
        claimed = self.store.claim(created['id'], {})
        self.assertEqual(set(claimed), {'specification', 'completion_token'})
        self.assertEqual(claimed['specification'], payload(text='ЦВЕТЫ\n\n  ДОМ  ', front_color='#00AAFF'))
        self.assertEqual(source, before)
        self.assertNotIn('specification', self.store.entries[created['id']])
        self.assertEqual(self.store.status(created['id'], created['status_token'])['expires_in'], 900)
        self.assertError(409, self.store.claim, created['id'], {})

    def test_random_tokens_and_separate_status_completion_credentials(self):
        created = self.store.create(payload())
        for token in [None, 3, [], 'x' * 64, '0' * 64, created['id']]:
            self.assertError(403, self.store.status, created['id'], token)
        self.assertError(404, self.store.claim, '0' * 64, {})
        self.assertError(404, self.store.status, '0' * 64, created['status_token'])
        claimed = self.store.claim(created['id'], {})
        self.assertError(403, self.store.status, created['id'], claimed['completion_token'])
        for token in [None, 3, [], '0' * 64, created['id'], created['status_token']]:
            self.assertError(403, self.store.complete, created['id'], {'status': 'complete', 'completion_token': token})

    def test_parallel_claim_exactly_one_winner(self):
        created = self.store.create(payload())
        gate = threading.Barrier(12)
        def claim(_):
            gate.wait(timeout=10)
            try:
                return self.store.claim(created['id'], {})
            except app.LaunchError as error:
                return error.status
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(claim, range(12)))
        self.assertEqual(sum(isinstance(value, dict) for value in results), 1)
        self.assertEqual(results.count(409), 11)

    def test_expiry_releases_specification_and_completion_secret(self):
        first = self.store.create(payload())
        self.now += 300
        self.assertEqual(self.store.status(first['id'], first['status_token'])['status'], 'expired')
        self.assertError(410, self.store.claim, first['id'], {})
        self.assertNotIn('specification', self.store.entries[first['id']])
        self.now += 900
        self.assertError(404, self.store.status, first['id'], first['status_token'])
        second = self.store.create(payload())
        self.now += 290
        claimed = self.store.claim(second['id'], {})
        self.now += 899
        self.assertEqual(self.store.status(second['id'], second['status_token'])['status'], 'claimed')
        self.now += 1
        self.assertError(410, self.store.complete, second['id'],
                         {'status': 'complete', 'completion_token': claimed['completion_token']})
        self.assertNotIn('completion_token', self.store.entries[second['id']])

    def test_complete_and_failed_are_terminal_and_status_hides_all_tokens(self):
        for terminal in ['complete', 'failed']:
            created = self.store.create(payload())
            claimed = self.store.claim(created['id'], {})
            result = {'status': terminal, 'completion_token': claimed['completion_token'],
                      'message': 'Готово' if terminal == 'complete' else 'CorelDRAW не ответил.'}
            if terminal == 'complete':
                result['filename'] = 'face-letters-20261009-163012.cdr'
            final = self.store.complete(created['id'], result)
            self.assertEqual(final['status'], terminal)
            self.assertEqual(final['message'], result['message'])
            self.assertNotIn('completion_token', final)
            self.assertNotIn('status_token', final)
            self.assertNotIn('specification', final)
            self.assertEqual(self.store.status(created['id'], created['status_token']), final)
            self.assertEqual(self.store.complete(created['id'], result), final)
            self.assertError(409, self.store.complete, created['id'], {**result, 'message': 'Changed'})
            self.assertError(409, self.store.complete, created['id'], {**result, 'status': 'failed' if terminal == 'complete' else 'complete'})
            self.assertError(409, self.store.claim, created['id'], {})
            self.now += 899
            self.assertEqual(self.store.status(created['id'], created['status_token'])['status'], terminal)
            self.now += 1
            self.assertError(404, self.store.status, created['id'], created['status_token'])

    def test_capacity_does_not_evict_active_requests(self):
        store = app.CorelLaunches(clock=lambda: self.now, capacity=2)
        a = store.create(payload())
        b = store.create(payload())
        self.assertError(429, store.create, payload())
        claim = store.claim(a['id'], {})
        store.complete(a['id'], {'status': 'complete', 'completion_token': claim['completion_token']})
        c = store.create(payload())
        self.assertEqual(set(store.entries), {b['id'], c['id']})
        self.now += 300
        store.create(payload())
        self.assertLessEqual(len(store.entries), 2)

    def test_malicious_specification_is_rejected_or_remains_only_text(self):
        for invalid in [None, [], {}, payload(photo='secret'), payload(password='secret'),
                        payload(width_cm=0), payload(height_cm=float('nan')),
                        payload(font_bold='true'), payload(text='\ud800'), payload(front_color='red')]:
            with self.subTest(invalid=repr(invalid)), self.assertRaises(ValueError):
                self.store.create(invalid)
        self.assertEqual(self.store.entries, {})
        text = '</line><evil/> & CreateObject("WScript.Shell").Run "calc"'
        created = self.store.create(payload(text=text))
        claimed = self.store.claim(created['id'], {})
        self.assertEqual(claimed['specification']['text'], text)
        self.assertNotIn('script', claimed)

    def test_completion_and_claim_bodies_are_bounded_and_strict(self):
        created = self.store.create(payload())
        for body in [None, [], {'unexpected': 1}]:
            self.assertError(400, self.store.claim, created['id'], body)
        claimed = self.store.claim(created['id'], {})
        valid = {'status': 'complete', 'completion_token': claimed['completion_token']}
        for body in [None, [], {}, {**valid, 'status': 'pending'}, {**valid, 'status': []},
                     {**valid, 'output_path': 'C:/secret/file.cdr'}, {**valid, 'script': 'code'},
                     *[{**valid, 'message': value} for value in [None, 1, '', 'x' * 301, 'a\nb', '\ud800']],
                     *[{**valid, 'filename': value} for value in [None, '', 'a' * 161 + '.cdr', 'C:/file.cdr',
                                                                 '../x.cdr', '\\server\\x.cdr', 'x.exe', '.cdr', 'x\n.cdr']]]:
            with self.subTest(body=repr(body)):
                self.assertError(400, self.store.complete, created['id'], body)
        self.assertEqual(self.store.status(created['id'], created['status_token'])['status'], 'claimed')


class CorelLaunchHTTP(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        auth = self.root / 'auth.json'
        auth.write_text(json.dumps(editor_auth.make_config('corel-launch-test', cookie_path='/signs/')), encoding='utf-8')
        self.renderer = mock.Mock(side_effect=AssertionError('Must not generate AI'))
        self.status_reader = mock.Mock(return_value={'configured': False})
        self.server = render_server.create_server(0, self.root / 'jobs', renderer=self.renderer,
            status_reader=self.status_reader, public_origin='https://corel.example.test', auth_file=auth)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)
        status, headers, _ = self.request('/auth/login', {'password': 'corel-launch-test'})
        self.assertEqual(status, 200)
        self.authenticated = {'Cookie': headers['set-cookie'].split(';', 1)[0],
                              'X-Editor-Token': self.server.service.token}

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def request(self, path, body=None, headers=None, method='POST', native=False, raw=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        request_headers = {'Host': 'corel.example.test', 'Content-Type': 'application/json'}
        if not native:
            request_headers['Origin'] = 'https://corel.example.test'
        request_headers.update(headers or {})
        try:
            data = raw if raw is not None else None if body is None else json.dumps(body)
            connection.request(method, path, data, request_headers)
            response = connection.getresponse()
            raw = response.read()
            return response.status, {key.lower(): value for key, value in response.getheaders()}, json.loads(raw)
        finally:
            connection.close()

    def create(self):
        status, headers, value = self.request('/api/corel-launch', payload(), self.authenticated)
        self.assertEqual(status, 201, value)
        self.assertEqual(headers['cache-control'], 'no-store')
        return value

    def test_flow_without_cookie_on_native_routes_and_without_ai(self):
        created = self.create()
        endpoint = '/api/corel-launch/' + created['id']
        headers = {**self.authenticated, 'X-Corel-Status-Token': created['status_token']}
        self.assertEqual(self.request(endpoint, headers=headers, method='GET')[2]['status'], 'pending')
        status, response_headers, claimed = self.request(endpoint + '/claim', {}, native=True)
        self.assertEqual(status, 200, claimed)
        self.assertNotIn('access-control-allow-origin', response_headers)
        self.assertEqual(self.request(endpoint, headers=headers, method='GET')[2]['status'], 'claimed')
        status, _, done = self.request(endpoint + '/complete', {'status': 'complete',
            'completion_token': claimed['completion_token'], 'filename': 'Буквы.cdr'}, native=True)
        self.assertEqual(status, 200, done)
        self.assertEqual(done['status'], 'complete')
        self.assertEqual(self.request(endpoint, headers=headers, method='GET')[2]['filename'], 'Буквы.cdr')
        self.renderer.assert_not_called()
        self.status_reader.assert_not_called()
        self.assertFalse(self.server.service.jobs)
        self.assertFalse(self.server.service.workers)
        self.assertFalse((self.root / 'jobs').exists())

    def test_browser_create_requires_cookie_token_origin_and_host(self):
        endpoint = '/api/corel-launch'
        self.assertEqual(self.request(endpoint, payload())[0], 401)
        cookie = {'Cookie': self.authenticated['Cookie']}
        self.assertEqual(self.request(endpoint, payload(), cookie)[0], 403)
        for change in [{'X-Editor-Token': 'wrong'}, {'Origin': 'https://evil.example'}, {'Host': 'evil.example'}]:
            self.assertEqual(self.request(endpoint, payload(), {**self.authenticated, **change})[0], 403)
        self.assertEqual(self.request(endpoint, payload(), self.authenticated, native=True)[0], 403)
        self.assertFalse(self.server.corel_launches.entries)

    def test_browser_status_needs_all_credentials_and_is_read_only(self):
        created = self.create()
        endpoint = '/api/corel-launch/' + created['id']
        good = {**self.authenticated, 'X-Corel-Status-Token': created['status_token']}
        self.assertEqual(self.request(endpoint, method='GET')[0], 401)
        self.assertEqual(self.request(endpoint, headers={'Cookie': good['Cookie']}, method='GET')[0], 403)
        self.assertEqual(self.request(endpoint, headers=self.authenticated, method='GET')[0], 403)
        for change in [{'X-Corel-Status-Token': '0' * 64}, {'Origin': 'https://evil.example'}, {'Host': 'evil.example'}]:
            self.assertEqual(self.request(endpoint, headers={**good, **change}, method='GET')[0], 403)
        self.assertEqual(self.request(endpoint + '?token=' + created['status_token'], headers=good, method='GET')[0], 404)
        self.assertEqual(self.request(endpoint + '/claim', headers=good, method='GET')[0], 404)
        self.assertEqual(self.server.corel_launches.entries[created['id']]['status'], 'pending')

    def test_only_exact_native_routes_bypass_cookie_and_never_accept_origin(self):
        created = self.create()
        base = '/api/corel-launch/' + created['id']
        for path in [base + '/claim?x=1', base + '/claim/', base + '/claim/../complete',
                     base.replace('corel-launch/', 'corel-launch/%2f') + '/claim',
                     base.upper() + '/claim', '/api/corel-launch/short/claim', '/api/jobs',
                     '/api/corel-package', '/api/corel-launch', '//api/corel-launch/' + created['id'] + '/claim']:
            with self.subTest(path=path):
                self.assertEqual(self.request(path, {}, native=True)[0], 403)
                self.assertIn(self.request(path, {})[0], (401, 303))
        for origin in ['https://corel.example.test', 'https://evil.example', 'null', '']:
            self.assertEqual(self.request(base + '/claim', {}, {'Origin': origin}, native=True)[0], 403)
        self.assertEqual(self.request(base + '/claim', {}, {'Host': 'evil.example'}, native=True)[0], 403)
        self.assertEqual(self.server.corel_launches.entries[created['id']]['status'], 'pending')

    def test_native_replay_unknown_and_expired(self):
        created = self.create()
        base = '/api/corel-launch/' + created['id']
        status, _, claimed = self.request(base + '/claim', {}, native=True)
        self.assertEqual(status, 200)
        self.assertEqual(self.request(base + '/claim', {}, native=True)[0], 409)
        wrong = {'status': 'failed', 'completion_token': '0' * 64}
        self.assertEqual(self.request(base + '/complete', wrong, native=True)[0], 403)
        valid = {'status': 'failed', 'completion_token': claimed['completion_token'], 'message': 'Ошибка CorelDRAW.'}
        self.assertEqual(self.request(base + '/complete', valid, native=True)[0], 200)
        self.assertEqual(self.request(base + '/complete', valid, native=True)[0], 200)
        self.assertEqual(self.request(base + '/complete', {**valid, 'message': 'Changed'}, native=True)[0], 409)
        self.assertEqual(self.request('/api/corel-launch/' + '0' * 64 + '/claim', {}, native=True)[0], 404)
        other = self.create()
        self.server.corel_launches.entries[other['id']]['deadline'] = self.server.corel_launches.clock() - 1
        self.assertEqual(self.request('/api/corel-launch/' + other['id'] + '/claim', {}, native=True)[0], 410)

    def test_strict_bounded_json_malicious_payload_and_no_state_change(self):
        for body in [payload(width_cm=0), payload(photo='data:secret'), payload(text='\ud800')]:
            self.assertEqual(self.request('/api/corel-launch', body, self.authenticated)[0], 400)
        for raw in ['[]', '{"text":1,"text":2}', 'not-json']:
            self.assertEqual(self.request('/api/corel-launch', headers=self.authenticated, raw=raw)[0], 400)
        self.assertEqual(self.request('/api/corel-launch', headers=self.authenticated, raw='x' * 8193)[0], 413)
        self.assertEqual(self.request('/api/corel-launch', payload(), {**self.authenticated, 'Content-Type': 'text/plain'})[0], 415)
        self.assertFalse(self.server.corel_launches.entries)
        created = self.create()
        claim = '/api/corel-launch/' + created['id'] + '/claim'
        self.assertEqual(self.request(claim, {'url': 'https://evil.example'}, native=True)[0], 400)
        self.assertEqual(self.request(claim, {}, {'Content-Type': 'text/plain'}, native=True)[0], 415)
        self.assertEqual(self.request(claim, native=True, raw='x' * 8193)[0], 413)
        self.assertEqual(self.server.corel_launches.entries[created['id']]['status'], 'pending')


if __name__ == '__main__':
    unittest.main()
