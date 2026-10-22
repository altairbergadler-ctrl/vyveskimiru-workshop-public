"""Per-user Windows URI helper. Only validated data comes from the fixed editor."""
from __future__ import annotations

import argparse
import ctypes
from datetime import datetime
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile

# -I excludes CWD, PYTHONPATH and user packages. Add only our installed code.
APP_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(APP_DIR))
import corel_export

EDITOR = 'https://vm-app.ru/signs/'
PROTOCOL = re.compile(r'signage-corel://open/([0-9a-f]{64})', re.ASCII)
MAX_RESPONSE = 65536


class HelperError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def ticket_from_url(url):
    match = PROTOCOL.fullmatch(url) if isinstance(url, str) else None
    if not match:
        raise HelperError('Некорректная ссылка. Нажмите кнопку открытия в редакторе.')
    return match.group(1)


def request(ticket, action, payload):
    if re.fullmatch(r'[0-9a-f]{64}', ticket) is None or action not in {'claim', 'complete'}:
        raise HelperError('Некорректное задание.')
    body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(EDITOR + f'api/corel-launch/{ticket}/{action}',
        data=body, headers={'Content-Type': 'application/json', 'Accept': 'application/json'}, method='POST')
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=20) as response:
            if response.headers.get_content_type() != 'application/json':
                raise HelperError('Сервер вернул неподдерживаемый ответ.')
            data = response.read(MAX_RESPONSE + 1)
            if len(data) > MAX_RESPONSE:
                raise HelperError('Ответ сервера слишком большой.')
            value = json.loads(data)
            if not isinstance(value, dict):
                raise HelperError('Сервер вернул некорректное задание.')
            return value
    except urllib.error.HTTPError as error:
        if error.code in {404, 409, 410}:
            raise HelperError('Ссылка уже использована или устарела. Проверьте результат в редакторе; для нового файла нажмите кнопку ещё раз.') from None
        raise HelperError(f'Редактор недоступен (HTTP {error.code}). Повторите открытие из редактора.') from None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        raise HelperError('Не удалось связаться с редактором. Проверьте интернет и повторите открытие из редактора.') from None


def documents_folder():
    if os.name != 'nt':
        raise HelperError('Помощник предназначен для Windows с CorelDRAW 2024.')
    # SHGetFolderPath honours redirected/OneDrive Documents (CSIDL_PERSONAL).
    buffer = ctypes.create_unicode_buffer(32768)
    if ctypes.windll.shell32.SHGetFolderPathW(None, 5, None, 0, buffer) != 0 or not buffer.value:
        raise HelperError('Не удалось определить папку «Документы».')
    return Path(buffer.value) / 'Signage Corel'


def local_state():
    return Path(os.environ['LOCALAPPDATA']) / 'SignageCorel'


class JobLock:
    def __init__(self, path, timeout=120):
        self.path, self.timeout, self.file = Path(path), timeout, None

    def __enter__(self):
        import msvcrt
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.file = self.path.open('a+b')
        self.file.seek(0, 2)
        if self.file.tell() == 0:
            self.file.write(b'0'); self.file.flush()
        deadline = time.monotonic() + self.timeout
        while True:
            self.file.seek(0)
            try:
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
                return self
            except OSError:
                if time.monotonic() >= deadline:
                    self.file.close(); self.file = None
                    raise HelperError('Помощник ещё занят предыдущим макетом. Дождитесь его и повторите открытие.')
                time.sleep(.25)

    def __exit__(self, *_):
        import msvcrt
        if self.file:
            try:
                self.file.seek(0); msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
            finally:
                self.file.close()


def create_document(specification, ticket, output_root=None, run=subprocess.run):
    # Validation precedes filesystem changes; only bundled code is executable.
    if not isinstance(ticket, str) or re.fullmatch(r'[0-9a-f]{64}', ticket) is None:
        raise HelperError('Некорректное задание.')
    package = corel_export.build_corel_package(specification)
    output_root = Path(output_root) if output_root is not None else documents_folder()
    output_root.mkdir(parents=True, exist_ok=True)
    folder = output_root / (datetime.now().strftime('%Y-%m-%d_%H-%M-%S') + '-' + ticket[:12])
    folder.mkdir(exist_ok=False)
    with zipfile.ZipFile(io.BytesIO(package)) as archive:
        if set(archive.namelist()) != {'layout.xml', 'Create-CDR.vbs', 'README.txt'}:
            raise HelperError('Повреждены файлы установленного помощника.')
        for name in archive.namelist():
            (folder / name).write_bytes(archive.read(name))
    cscript = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32' / 'cscript.exe'
    try:
        result = run([str(cscript), '//nologo', '//U', str(folder/'Create-CDR.vbs'), '/quiet', '/open'],
            cwd=folder, capture_output=True, timeout=180,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), check=False)
    except subprocess.TimeoutExpired:
        raise HelperError('CorelDRAW не завершил открытие за 3 минуты. Проверьте его окно и папку «Документы → Signage Corel»: файл мог уже сохраниться. Автоматического повтора нет.') from None
    files = list(folder.glob('face-letters-*.cdr'))
    if result.returncode or len(files) != 1 or files[0].stat().st_size == 0:
        detail = (result.stdout or result.stderr or b'').decode('utf-16-le', errors='replace').replace('\ufeff', '').strip()
        detail = ' '.join(detail.split())[:200]
        raise HelperError(detail or 'CorelDRAW не создал файл. Проверьте установку CorelDRAW 2024 и выбранный шрифт.')
    return files[0]


def report_completion(ticket, payload, send=request):
    # A lost acknowledgement must never cause a second claim or CDR creation.
    for attempt in range(3):
        try:
            return send(ticket, 'complete', payload)
        except HelperError:
            if attempt == 2:
                raise
            time.sleep(.5)


def execute(ticket, send=request, create=create_document):
    claim = send(ticket, 'claim', {})
    token = claim.get('completion_token')
    if not isinstance(token, str) or re.fullmatch(r'[0-9a-f]{64}', token) is None:
        raise HelperError('Сервер вернул некорректное подтверждение задания.')
    try:
        output = create(claim.get('specification'), ticket)
    except Exception as error:
        message = str(error) if isinstance(error, (HelperError, ValueError)) else 'Не удалось создать CDR. Проверьте CorelDRAW и доступ к папке «Документы».'
        message = ' '.join(message.split())[:300]
        try:
            report_completion(ticket, {'completion_token': token, 'status': 'failed', 'message': message}, send)
        except HelperError:
            pass
        raise HelperError(message) from None
    try:
        report_completion(ticket, {'completion_token': token, 'status': 'complete',
            'filename': output.name, 'message': 'CDR сохранён в «Документы → Signage Corel» и открыт в CorelDRAW.'}, send)
    except HelperError:
        raise HelperError('CDR создан и открыт, но редактор не получил подтверждение. Файл находится в «Документы → Signage Corel». Повторно создавать его не нужно.') from None
    return output


def log_result(state, message):
    root = local_state(); root.mkdir(parents=True, exist_ok=True)
    path = root/'helper.log'
    if path.exists() and path.stat().st_size > 256*1024:
        os.replace(path, root/'helper.previous.log')
    with path.open('a', encoding='utf-8') as stream:
        stream.write(json.dumps({'at': datetime.now().isoformat(), 'status': state,
            'message': message}, ensure_ascii=False) + '\n')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args(argv)
    if args.self_test and not args.url:
        import ssl, msvcrt
        assert (APP_DIR/'corel/Create-CDR.vbs').is_file()
        documents_folder()
        return 0
    try:
        if args.self_test or not args.url:
            raise HelperError('Откройте помощник кнопкой в редакторе вывесок.')
        ticket = ticket_from_url(args.url)
        # Lock first: another browser activation must not consume a queued ticket.
        with JobLock(local_state()/'job.lock'):
            output = execute(ticket)
        log_result('complete', str(output))
        return 0
    except Exception as error:
        message = str(error) if isinstance(error, HelperError) else 'Ошибка помощника CorelDRAW. Откройте редактор и повторите действие.'
        log_result('failed', message)
        if os.name == 'nt':
            ctypes.windll.user32.MessageBoxW(None, message, 'Редактор вывесок · CorelDRAW', 0x10)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
