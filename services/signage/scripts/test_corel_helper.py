"""Native bridge checks without opening CorelDRAW or modifying registration."""
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch
from email.message import Message
import corel_helper as app
import corel_helper_install as installer

TICKET = 'a' * 64
TOKEN = 'b' * 64
SPEC = {'text': 'ЦВЕТЫ', 'width_cm': 120, 'height_cm': 50,
        'line_gap_cm': 0, 'text_align': 'center', 'font_family': 'Arial',
        'font_bold': True, 'front_color': '#000000'}


class Helper(unittest.TestCase):
    def test_strict_protocol(self):
        self.assertEqual(app.ticket_from_url('signage-corel://open/' + TICKET), TICKET)
        for url in ['', None, 'https://vm-app.ru/' + TICKET,
                    'signage-corel://open/' + TICKET + '/',
                    'signage-corel://open/' + TICKET + '?run=x',
                    'signage-corel://open/' + TICKET + '#x',
                    'signage-corel://open/' + TICKET.upper(),
                    'signage-corel://evil/' + TICKET,
                    'signage-corel://open/%61' + TICKET[1:],
                    'signage-corel://open/' + TICKET + '\n']:
            with self.subTest(url=url), self.assertRaises(app.HelperError):
                app.ticket_from_url(url)

    def test_redirect_disabled(self):
        self.assertIsNone(app.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://evil.invalid'))

    def test_request_fixed_destination_and_bounds(self):
        for data, media, success in [(b'{}', 'application/json', True),
                                     (b'{}', 'text/html', False),
                                     (b'x' * 65537, 'application/json', False),
                                     (b'[]', 'application/json', False)]:
            response = Mock()
            response.__enter__ = Mock(return_value=response)
            response.__exit__ = Mock(return_value=False)
            response.headers = Message(); response.headers['Content-Type'] = media
            response.read.return_value = data
            opener = Mock(); opener.open.return_value = response
            with patch.object(app.urllib.request, 'build_opener', return_value=opener):
                if success: self.assertEqual(app.request(TICKET, 'claim', {}), {})
                else:
                    with self.assertRaises(app.HelperError): app.request(TICKET, 'claim', {})
            req = opener.open.call_args.args[0]
            self.assertEqual(req.full_url, app.EDITOR + 'api/corel-launch/' + TICKET + '/claim')
            self.assertEqual(req.method, 'POST')
            self.assertNotIn('Origin', req.headers)

    def test_claim_never_retried(self):
        send = Mock(side_effect=app.HelperError('network'))
        create = Mock()
        with self.assertRaises(app.HelperError): app.execute(TICKET, send, create)
        send.assert_called_once_with(TICKET, 'claim', {})
        create.assert_not_called()

    def test_completion_retry_does_not_repeat_creation(self):
        send = Mock(side_effect=[{'completion_token': TOKEN, 'specification': SPEC},
                                app.HelperError('lost ack'), {'status': 'complete'}])
        create = Mock(return_value=Path('face-letters-test.cdr'))
        with patch.object(app.time, 'sleep'):
            self.assertEqual(app.execute(TICKET, send, create).name, 'face-letters-test.cdr')
        create.assert_called_once_with(SPEC, TICKET)
        self.assertEqual(send.call_args_list[1], send.call_args_list[2])

    def test_failed_creation_reported_once_no_retry(self):
        send = Mock(side_effect=[{'completion_token': TOKEN, 'specification': SPEC}, {}])
        create = Mock(side_effect=app.HelperError('Corel unavailable'))
        with self.assertRaisesRegex(app.HelperError, 'Corel unavailable'):
            app.execute(TICKET, send, create)
        create.assert_called_once()
        self.assertEqual(send.call_args.args[2]['status'], 'failed')

    def test_local_script_only_and_open_flags(self):
        def run(argv, **kwargs):
            self.assertEqual(argv[1:3], ['//nologo', '//U'])
            self.assertEqual(argv[-2:], ['/quiet', '/open'])
            self.assertNotIn('shell', kwargs)
            self.assertEqual(kwargs['timeout'], 180)
            folder = kwargs['cwd']
            self.assertEqual(Path(argv[3]), folder / 'Create-CDR.vbs')
            (folder / 'face-letters-test.cdr').write_bytes(b'CDR test fixture')
            return subprocess.CompletedProcess(argv, 0, b'', b'')
        with tempfile.TemporaryDirectory() as temp:
            result = app.create_document(SPEC, TICKET, temp, run)
            self.assertTrue(result.is_file())
            self.assertIn('<front_color>#000000</front_color>', (result.parent/'layout.xml').read_text())

    def test_invalid_ticket_before_any_files(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(app.HelperError): app.create_document(SPEC, '../escape', temp)
            self.assertEqual(list(Path(temp).iterdir()), [])

    def test_foreign_registration_never_replaced(self):
        key = Mock(); key.__enter__ = Mock(return_value=key); key.__exit__ = Mock(return_value=False)
        registry = Mock(); registry.OpenKey.return_value = key
        for value in ['someone else', None]:
            registry.QueryValueEx.side_effect = FileNotFoundError() if value is None else None
            registry.QueryValueEx.return_value = (value, 1)
            with self.assertRaises(RuntimeError): installer.check_protocol_owner(registry)
        registry.OpenKey.side_effect = FileNotFoundError()
        self.assertFalse(installer.check_protocol_owner(registry))


if __name__ == '__main__': unittest.main()
