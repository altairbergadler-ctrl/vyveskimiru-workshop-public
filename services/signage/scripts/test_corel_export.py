"""Package and validation checks; never start CorelDRAW or execute VBScript."""
import io
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock
import xml.etree.ElementTree as ET
import zipfile

import corel_export as app
import editor_auth
import render_server


def payload(**changes):
    result = {'text': 'ЦВЕТЫ\n24 ЧАСА', 'width_cm': 220, 'height_cm': 50,
              'line_gap_cm': 5, 'text_align': 'center', 'font_family': 'Arial',
              'font_bold': True, 'front_color': '#12abEf'}
    result.update(changes)
    return result


class CorelExport(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.helper = Path(self.directory.name) / 'Create-CDR.vbs'
        self.script = 'Option Explicit\n\' Постоянный скрипт без пользовательских подстановок\n'
        self.helper.write_text(self.script, encoding='utf-8-sig')
        patch = mock.patch.object(app, '_SCRIPT_PATH', self.helper)
        patch.start()
        self.addCleanup(patch.stop)

    def unpack(self, data):
        package = app.build_corel_package(data)
        self.assertIsInstance(package, bytes)
        with zipfile.ZipFile(io.BytesIO(package)) as archive:
            self.assertIsNone(archive.testzip())
            self.assertEqual(set(archive.namelist()), {'layout.xml', 'Create-CDR.vbs', 'README.txt'})
            return {name: archive.read(name) for name in archive.namelist()}

    def test_package_dimensions_and_cyrillic(self):
        files = self.unpack(payload())
        root = ET.fromstring(files['layout.xml'])
        self.assertEqual((root.tag, root.attrib), ('signage', {'version': '1'}))
        self.assertEqual(root.findtext('width_cm'), '220')
        self.assertEqual(root.findtext('height_cm'), '50')
        self.assertEqual(root.findtext('line_gap_cm'), '5')
        self.assertEqual(root.findtext('text_align'), 'center')
        self.assertEqual(root.findtext('font_family'), 'Arial')
        self.assertEqual(root.findtext('font_bold'), 'true')
        self.assertEqual(root.findtext('front_color'), '#12ABEF')
        self.assertEqual([line.text for line in root.findall('./lines/line')], ['ЦВЕТЫ', '24 ЧАСА'])
        self.assertEqual(files['Create-CDR.vbs'].decode('utf-16'), self.script)
        self.assertTrue(files['Create-CDR.vbs'].startswith((b'\xff\xfe', b'\xfe\xff')))
        self.assertIn('CorelDRAW 2024', files['README.txt'].decode('utf-8-sig'))
        self.assertIn('локально', files['README.txt'].decode('utf-8-sig'))

    def test_xml_escaping_and_injection_remain_data(self):
        text = 'ЦВЕТЫ & <магазин> "А"\n</line><evil/>\n: CreateObject("WScript.Shell").Run "calc"'
        family = 'Font <&> "Example"'
        files = self.unpack(payload(text=text, font_family=family))
        root = ET.fromstring(files['layout.xml'])
        self.assertEqual([node.text for node in root.findall('./lines/line')], text.split('\n'))
        self.assertEqual(root.findtext('font_family'), family)
        self.assertIsNone(root.find('.//evil'))
        self.assertIn(b'&lt;/line&gt;&lt;evil/&gt;', files['layout.xml'])
        self.assertIn(b'&amp;', files['layout.xml'])
        self.assertNotIn(b'CreateObject', files['Create-CDR.vbs'])
        self.assertEqual(files['Create-CDR.vbs'].decode('utf-16'), self.script)

    def test_preserve_internal_blank_lines_and_explicit_bold(self):
        files = self.unpack(payload(text='\r\n  \r\nЦВЕТЫ\r\n\r\n \t \r\n  ДОМ  \r\n\t', font_bold=False))
        root = ET.fromstring(files['layout.xml'])
        self.assertEqual([node.text or '' for node in root.findall('./lines/line')], ['ЦВЕТЫ', '', '', '  ДОМ  '])
        self.assertEqual(root.findtext('font_bold'), 'false')

    def test_text_boundaries(self):
        self.unpack(payload(text='Я' * 300))
        self.unpack(payload(text='🌷' * 150))
        self.unpack(payload(text='\n'.join(['Я'] * 20), height_cm=100, line_gap_cm=0))
        for text in [None, 1, '', ' \n\t', 'Я' * 301, '🌷' * 151, '\n'.join(['Я'] * 21), 'a\x00b', 'a\x0bb', '\ud800', '\ufffe']:
            with self.subTest(text=repr(text)), self.assertRaises(ValueError):
                app.build_corel_package(payload(text=text))

    def test_dimensions_and_gap_validation(self):
        for field in ['width_cm', 'height_cm']:
            for value in [0, -1, 10000.1, float('nan'), float('inf'), -float('inf'), True, '50', None, [], 10 ** 1000]:
                with self.subTest(field=field, value=repr(value)), self.assertRaises(ValueError):
                    app.build_corel_package(payload(**{field: value}))
        for gap in [-1, float('nan'), float('inf'), True, '5', None, 50, 51]:
            with self.subTest(gap=repr(gap)), self.assertRaises(ValueError):
                app.build_corel_package(payload(line_gap_cm=gap))
        with self.assertRaises(ValueError):
            app.build_corel_package(payload(text='A\n\nB', height_cm=50, line_gap_cm=25))
        files = self.unpack(payload(width_cm=10000, height_cm=0.25, line_gap_cm=0))
        self.assertEqual(float(ET.fromstring(files['layout.xml']).findtext('height_cm')), .25)
        self.unpack(payload(text='Одна строка', line_gap_cm=500))
        with self.assertRaisesRegex(ValueError, '10000'):
            app.build_corel_package(payload(text='Одна строка', line_gap_cm=10001))
        fixed = ET.fromstring(self.unpack(payload(width_cm=1e-8, text='A', line_gap_cm=-0.0))['layout.xml'])
        self.assertEqual(fixed.findtext('width_cm'), '0.00000001')
        self.assertEqual(fixed.findtext('line_gap_cm'), '0')

    def test_font_alignment_color_and_bold_validation(self):
        invalid = {'font_family': ['', ' ', 'a' * 121, 'Arial\n', 'Arial\t', 'Arial\x7f', 'Ar\u200bial', '\udfff', None, 123],
                   'font_bold': [None, 0, 1, 'true', 'false', []],
                   'front_color': ['ffffff', '#fff', '#12345678', '#GG1234', '#ffffff\n', None, 123],
                   'text_align': ['justify', 'CENTER', '', None, []]}
        for field, values in invalid.items():
            for value in values:
                with self.subTest(field=field, value=repr(value)), self.assertRaises(ValueError):
                    app.build_corel_package(payload(**{field: value}))
        for align in ['left', 'center', 'right']:
            self.unpack(payload(text_align=align, font_family='Шрифт ' + 'Я' * 114))

    def test_payload_shape_excludes_photo_project_and_secrets(self):
        for data in [None, [], 'text', {key: value for key, value in payload().items() if key != 'font_bold'},
                     payload(photo='data:image/png;base64,secret'), payload(project={'password': 'secret'}),
                     payload(api_key='secret')]:
            with self.subTest(data=repr(data)), self.assertRaises(ValueError):
                app.build_corel_package(data)

    def test_missing_helper_is_user_readable_error(self):
        with mock.patch.object(app, '_SCRIPT_PATH', Path(self.directory.name) / 'missing.vbs'):
            with self.assertRaisesRegex(ValueError, 'CorelDRAW.*недоступен'):
                app.build_corel_package(payload())

    def test_package_does_not_save_or_mutate_user_input(self):
        data = payload()
        expected = dict(data)
        before = {path.name for path in Path(self.directory.name).iterdir()}
        self.unpack(data)
        self.assertEqual(data, expected)
        self.assertEqual({path.name for path in Path(self.directory.name).iterdir()}, before)


class CorelExportHTTP(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        auth_file = self.root / 'auth.json'
        auth_file.write_text(json.dumps(editor_auth.make_config('corel-http-test', cookie_path='/signs/')), encoding='utf-8')
        self.renderer = mock.Mock(side_effect=AssertionError('Corel export must never request AI generation'))
        self.status_reader = mock.Mock(return_value={'configured': False})
        self.server = render_server.create_server(0, self.root / 'jobs', renderer=self.renderer,
            status_reader=self.status_reader, public_origin='https://corel.example.test', auth_file=auth_file)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def request(self, path, data=None, headers=None, method='POST'):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        request_headers = {'Host': 'corel.example.test', 'Origin': 'https://corel.example.test',
                           'Content-Type': 'application/json', **(headers or {})}
        try:
            connection.request(method, path, None if data is None else json.dumps(data), request_headers)
            response = connection.getresponse()
            return response.status, {key.lower(): value for key, value in response.getheaders()}, response.read()
        finally:
            connection.close()

    def test_authenticated_download_needs_session_and_token_without_ai(self):
        endpoint = '/api/corel-package'
        token_header = {'X-Editor-Token': self.server.service.token}
        status, _, raw = self.request(endpoint, payload(), token_header)
        self.assertEqual(status, 401)
        self.assertTrue(json.loads(raw)['auth_required'])
        status, headers, raw = self.request('/auth/login', {'password': 'corel-http-test'})
        self.assertEqual(status, 200, raw)
        cookie = headers['set-cookie'].split(';', 1)[0]
        authenticated = {'Cookie': cookie, **token_header}
        self.assertEqual(self.request(endpoint, payload(), {'Cookie': cookie})[0], 403)
        self.assertEqual(self.request(endpoint, payload(), {**authenticated, 'X-Editor-Token': 'incorrect'})[0], 403)
        self.assertEqual(self.request(endpoint, payload(), {**authenticated, 'Origin': 'https://wrong.example.test'})[0], 403)
        status, headers, raw = self.request(endpoint, payload(), authenticated)
        self.assertEqual(status, 200, raw)
        self.assertEqual(headers['content-type'], 'application/zip')
        self.assertEqual(headers['content-disposition'], 'attachment; filename="letters-coreldraw-2024.zip"')
        self.assertEqual(headers['cache-control'], 'no-store')
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            self.assertEqual(set(archive.namelist()), {'layout.xml', 'Create-CDR.vbs', 'README.txt'})
            self.assertEqual(ET.fromstring(archive.read('layout.xml')).findtext('./lines/line'), 'ЦВЕТЫ')
        status, _, raw = self.request(endpoint, payload(width_cm=0), authenticated)
        self.assertEqual(status, 400)
        self.assertIn('Ширина', json.loads(raw)['error'])
        self.renderer.assert_not_called()
        self.status_reader.assert_not_called()
        self.assertEqual(self.server.service.jobs, {})
        self.assertFalse(self.server.service.workers)
        self.assertFalse((self.root / 'jobs').exists(), 'Package export must not persist generation artifacts')


if __name__ == '__main__':
    unittest.main()
