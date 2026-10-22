"""Authenticated, local-only PDF processing service. Run one ASGI worker."""
from __future__ import annotations

import asyncio
from collections import defaultdict, deque
from contextlib import asynccontextmanager
import hashlib
import hmac
from html import escape
import io
import json
import logging
import math
import multiprocessing as mp
import os
from pathlib import Path
import re
import secrets
import shutil
import tarfile
import time
from typing import Literal
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, Field

from .workshop_documents import register_workshop_documents
from .workshop_auth import (AuthenticationUnavailable, OWNER_COOKIE, csrf_for_owner,
                            load_csrf_secret, matching_origin, valid_cookie,
                            validate_authority_url, verify_owner_session)

ROOT = Path(__file__).resolve().parent.parent
COOKIE = 'stamp_session'
DEFAULT_NOTICE = ('Установлен восстановленный оттиск из предыдущих документов. '
                  'Он отличается от оригинала в мелких деталях. Для точного результата замените его чистым PNG.')
LOG = logging.getLogger('stamp-service')


def _worker(connection, operation: str, args: dict):
    """Isolate the native PDF parser and allow the parent to terminate timeouts."""
    try:
        try:
            import resource
            resource.setrlimit(resource.RLIMIT_CPU, (55, 60))
        except (ImportError, ValueError):
            pass
        from . import pdf_engine as engine
        import fitz
        if operation == 'validate_stamp_png':
            with Image.open(args['stamp_path']) as image:
                if image.format != 'PNG' or not 16 <= image.width <= 4096 or not 16 <= image.height <= 4096 or image.width * image.height > 16_000_000:
                    raise ValueError('Нужен PNG размером от 16 до 4096 пикселей, до 16 мегапикселей.')
                aspect = image.height / image.width
                if not .5 <= aspect <= 2:
                    raise ValueError('Оттиск слишком узкий или вытянутый. Выделите весь оттиск без широких пустых полей.')
                image.load()
                result = {'aspect': aspect, 'width': image.width, 'height': image.height}
            connection.send((True, result))
            return
        if operation == 'validate_signature_png':
            with Image.open(args['image_path']) as image:
                if image.format != 'PNG' or not 16 <= image.width <= 8192 or not 16 <= image.height <= 8192 or image.width * image.height > 16_000_000:
                    raise ValueError('Нужен PNG подписи размером от 16 до 8192 пикселей, до 16 мегапикселей.')
                if getattr(image, 'n_frames', 1) != 1:
                    raise ValueError('Нужна неподвижная PNG-подпись, без анимации.')
                aspect = image.height / image.width
                if not .025 <= aspect <= 4:
                    raise ValueError('Недопустимые пропорции подписи. Загрузите изображение без широких пустых полей.')
                image.load()
                result = {'aspect': aspect, 'width': image.width, 'height': image.height}
            connection.send((True, result))
            return
        if operation.startswith('stamp_source_'):
            from . import stamp_extraction as extraction
            if operation == 'stamp_source_info':
                result = extraction.source_info(**args)
            elif operation == 'stamp_source_render':
                result = extraction.render_source_page(**args)
            elif operation == 'stamp_source_extract':
                result = extraction.extract_stamp(**args)
            else:
                raise ValueError('Неизвестная операция с источником оттиска.')
            connection.send((True, result))
            return
        if operation == 'image_to_pdf':
            # Decode untrusted pictures away from the web process. The declared
            # dimensions are checked before loading pixels to prevent bombs.
            with Image.open(args['image_path']) as source:
                if source.format not in ('JPEG', 'PNG') or not 16 <= min(source.size) or max(source.size) > 20000 or source.width * source.height > 24_000_000:
                    raise ValueError('Нужен JPG/PNG от 16 пикселей, не более 24 мегапикселей.')
                source.load()
                source = ImageOps.exif_transpose(source)
                rgb = Image.new('RGB', source.size, 'white')
                if source.mode in ('RGBA', 'LA') or 'transparency' in source.info:
                    source = source.convert('RGBA')
                    rgb.paste(source, mask=source.getchannel('A'))
                else:
                    rgb.paste(source.convert('RGB'))
                buffer = io.BytesIO()
                rgb.save(buffer, format='PNG')
                image_width, image_height = rgb.size
            # Use a stable A4-like physical size preserving image proportions.
            scale = min(595.276 / image_width, 841.89 / image_height)
            if image_width > image_height:
                scale = min(841.89 / image_width, 595.276 / image_height)
            with fitz.open() as converted:
                page = converted.new_page(width=image_width * scale, height=image_height * scale)
                page.insert_image(page.rect, stream=buffer.getvalue())
                converted.save(args['output_path'], deflate=True)
            connection.send((True, {'width': image_width, 'height': image_height}))
            return
        path = args['pdf_path']
        with fitz.open(path) as doc:
            if doc.needs_pass:
                raise ValueError('PDF защищён паролем. Сначала сохраните незашифрованную копию.')
            if not 0 < len(doc) <= args.pop('max_pages', 50):
                raise ValueError('Превышен допустимый лимит страниц PDF.')
            for page in doc:
                w, h = page.rect.width, page.rect.height
                if min(w, h) < 10 or max(w, h) > 5000 or max(w / h, h / w) > 30:
                    raise ValueError('Размер страницы не поддерживается.')
        if operation == 'inspect':
            result = engine.inspect_pdf(**args)
        elif operation == 'render':
            result = engine.render_page(**args)
        elif operation == 'stamp':
            result = engine.stamp_pdf(**args)
        elif operation == 'scan':
            engine.stamp_pdf(pdf_path=args['pdf_path'], output_path=args['stamped_path'],
                             stamp_path=args['stamp_path'], placement=args['placement'])
            result = engine.scan_pdf(args['stamped_path'], args['output_path'],
                                     profile=args['profile'], dpi=args['dpi'])
        elif operation in ('compose', 'compose_scan'):
            composed_path = args['composed_path'] if operation == 'compose_scan' else args['output_path']
            result = engine.compose_pdf(args['pdf_path'], composed_path, overlays=args['overlays'])
            if operation == 'compose_scan':
                result['scan'] = engine.scan_pdf(composed_path, args['output_path'],
                                                 profile=args['profile'], dpi=args['dpi'], seed=args.get('seed'))
                result['composed_sha256'] = result['output_sha256']
                result['output_sha256'] = result['scan']['output_sha256']
        else:
            raise ValueError('Неизвестная операция.')
        connection.send((True, result))
    except (UnidentifiedImageError, OSError) as exc:
        connection.send((False, 'Не удалось прочитать изображение. Проверьте, что JPG/PNG не повреждён.'
                         if operation in ('image_to_pdf', 'validate_stamp_png', 'validate_signature_png') or args.get('source_type') in ('jpg', 'png')
                         else 'Не удалось прочитать PDF. Проверьте, что файл не повреждён.'))
    except ValueError as exc:
        connection.send((False, str(exc)))
    except Exception:
        LOG.exception('PDF operation failed')
        connection.send((False, 'Не удалось обработать PDF. Проверьте, что файл не повреждён.'))
    finally:
        connection.close()


class Credentials(BaseModel):
    username: str = Field(max_length=100)
    password: str = Field(max_length=1024)


class Settings(BaseModel):
    company_inn: str = Field(default='7700000000', pattern=r'^\d{10}(\d{2})?$')
    company_name: str = Field(default='Тестовая компания', min_length=1, max_length=120)
    width_mm: float = Field(default=35.6, ge=20, le=60, allow_inf_nan=False)


class Placement(BaseModel):
    page: int = Field(ge=0)
    x: float = Field(ge=0, allow_inf_nan=False)
    y: float = Field(ge=0, allow_inf_nan=False)
    width: float = Field(gt=0, allow_inf_nan=False)
    height: float = Field(gt=0, allow_inf_nan=False)


class ScanRequest(BaseModel):
    placement: Placement
    profile: str = Field(default='standard', pattern=r'^(light|standard|strong)$')
    dpi: int = Field(default=150)


class CompositionRequest(BaseModel):
    placement: Placement | None = None
    signature_placement: Placement | None = None
    profile: Literal['light', 'standard', 'strong'] = 'standard'
    dpi: int = Field(default=150, strict=True)


class SignatureBinding(BaseModel):
    signature_id: str | None = Field(pattern=r'^[a-f0-9]{32}$')


class SignatureFields(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    signer: str | None = Field(default=None, max_length=120)
    width_mm: float = Field(default=70, ge=10, le=100, allow_inf_nan=False)


class NormalizedCrop(BaseModel):
    x: float = Field(ge=0, le=1, allow_inf_nan=False)
    y: float = Field(ge=0, le=1, allow_inf_nan=False)
    width: float = Field(gt=0, le=1, allow_inf_nan=False)
    height: float = Field(gt=0, le=1, allow_inf_nan=False)


class ExtractionRequest(BaseModel):
    page: int = Field(default=0, ge=0, strict=True)
    crop: NormalizedCrop
    color: Literal['blue', 'red', 'dark'] = 'blue'
    strength: int = Field(default=50, ge=0, le=100, strict=True)
    rotation: float = Field(default=0, ge=-15, le=15, allow_inf_nan=False)


class SaveExtractionRequest(ExtractionRequest):
    name: str = Field(min_length=1, max_length=120)
    company_name: str = Field(min_length=1, max_length=120)
    company_inn: str = Field(pattern=r'^\d{10}(\d{2})?$')
    width_mm: float = Field(ge=20, le=60, allow_inf_nan=False)


class SaveSignatureRequest(ExtractionRequest, SignatureFields):
    pass


def atomic_json(path: Path, value):
    tmp = path.with_name(path.name + '.' + secrets.token_hex(8) + '.tmp')
    try:
        tmp.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)


def create_app(data_dir: Path | None = None) -> FastAPI:
    data = Path(data_dir or os.environ.get('DATA_DIR', ROOT / 'data'))
    jobs = data / 'jobs'
    max_upload = int(os.environ.get('MAX_UPLOAD_MB', '25')) * 1024 * 1024
    max_pages = int(os.environ.get('MAX_PAGES', '50'))
    # History and results are durable. Old JOB_TTL_SECONDS deployments must not
    # silently erase a workspace after switching to the library interface.
    job_ttl = 0
    session_ttl = int(os.environ.get('SESSION_TTL_SECONDS', '28800'))
    max_jobs = int(os.environ.get('MAX_JOBS', '100'))
    max_total = int(os.environ.get('MAX_TOTAL_MB', '500')) * 1024 * 1024
    max_result = int(os.environ.get('MAX_RESULT_MB', '100')) * 1024 * 1024
    username = os.environ.get('APP_USERNAME', 'admin')
    password = os.environ.get('APP_PASSWORD', '')
    auth_mode = os.environ.get('AUTH_MODE', 'password')
    if auth_mode not in ('password', 'workshop'):
        raise ValueError('AUTH_MODE must be password or workshop.')
    workshop_auth_url = validate_authority_url(os.environ.get('WORKSHOP_AUTH_URL', '')) if auth_mode == 'workshop' else None
    secure_cookie = os.environ.get('COOKIE_SECURE', 'false').lower() == 'true'
    base_path = os.environ.get('APP_BASE_PATH', '').rstrip('/')
    if not re.fullmatch(r'(?:/[A-Za-z0-9_-]+)*', base_path):
        raise ValueError('APP_BASE_PATH must be empty or a path such as /tools/stamp')
    cookie_path = base_path + '/'
    sessions: dict = {}
    attempts = defaultdict(deque)
    active: set[str] = set()
    upload_reservations: dict[str, int] = {}
    stamp_path = data / 'stamp.png'
    settings_path = data / 'settings.json'
    stamp_meta = data / 'stamp.json'
    stamps = data / 'stamps'
    signatures = data / 'signatures'
    signatures_path = data / 'signatures.json'
    stamp_sources = data / 'stamp-sources'
    library_path = data / 'stamps.json'
    storage_lock = asyncio.Lock()

    def cleanup():
        now = time.time()
        for sid in list(sessions):
            if sessions[sid]['expires'] < now:
                del sessions[sid]

    @asynccontextmanager
    async def lifespan(app):
        if auth_mode == 'password' and len(password) < 16:
            raise RuntimeError('APP_PASSWORD must contain at least 16 characters. Run scripts/setup.sh.')
        data.mkdir(parents=True, exist_ok=True, mode=0o700)
        if auth_mode == 'workshop':
            app.state.csrf_secret = load_csrf_secret(data)
        jobs.mkdir(exist_ok=True, mode=0o700)
        stamps.mkdir(exist_ok=True, mode=0o700)
        signatures.mkdir(exist_ok=True, mode=0o700)
        if not signatures_path.exists():
            atomic_json(signatures_path, {'items': [], 'active_id': None})
        stamp_sources.mkdir(exist_ok=True, mode=0o700)
        if not settings_path.exists():
            atomic_json(settings_path, Settings().model_dump())
        if not stamp_path.exists() and (ROOT / 'assets/demo-stamp.png').is_file():
            shutil.copyfile(ROOT / 'assets/demo-stamp.png', stamp_path)
            atomic_json(stamp_meta, {'notice': DEFAULT_NOTICE})
        if not library_path.exists():
            library = {'items': [], 'active_id': None}
            if stamp_path.is_file():
                cfg = Settings.model_validate_json(settings_path.read_text(encoding='utf-8')).model_dump()
                with Image.open(stamp_path) as image:
                    aspect = image.height / image.width
                stamp_id = secrets.token_hex(16)
                shutil.copyfile(stamp_path, stamps / (stamp_id + '.png'))
                library['items'].append({**cfg, 'id': stamp_id, 'name': cfg['company_name'],
                                         'aspect': aspect, 'created': time.time(),
                                         'notice': json.loads(stamp_meta.read_text(encoding='utf-8')).get('notice', '') if stamp_meta.exists() else ''})
                library['active_id'] = stamp_id
            atomic_json(library_path, library)
        app.state.pdf_slot = asyncio.Semaphore(1)
        await workshop_service.startup()
        cleanup()

        async def janitor():
            while True:
                await asyncio.sleep(60)
                cleanup()

        task = asyncio.create_task(janitor())
        yield
        await workshop_service.shutdown()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    app = FastAPI(lifespan=lifespan, root_path=base_path, docs_url=None, redoc_url=None, openapi_url=None)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, exc):
        return JSONResponse({'detail': 'Проверьте значения полей: ИНН, размер печати и координаты.'}, status_code=422)

    @app.middleware('http')
    async def security(request: Request, call_next):
        path = request.url.path
        # Match the same path the router sees, with or without a stripped proxy prefix.
        root_path = request.scope.get('root_path', '').rstrip('/')
        if root_path and (path == root_path or path.startswith(root_path + '/')):
            path = path[len(root_path):] or '/'
        if auth_mode == 'workshop' and path in ('/api/login', '/api/logout'):
            return JSONResponse({'detail': 'Вход и выход выполняются в мастерской.'}, status_code=409)
        if path.startswith('/api/') and path != '/api/login':
            if auth_mode == 'workshop':
                owner_cookie = request.cookies.get(OWNER_COOKIE, '')
                if not valid_cookie(owner_cookie):
                    return JSONResponse({'detail': 'Войдите в мастерскую.'}, status_code=401)
                for header in ('origin', 'referer'):
                    value = request.headers.get(header)
                    if value is not None and not matching_origin(request.headers.get('host', ''), value):
                        return JSONResponse({'detail': 'Запрос с другого сайта запрещён.'}, status_code=403)
                try:
                    authenticated = await asyncio.to_thread(verify_owner_session, workshop_auth_url, owner_cookie)
                except AuthenticationUnavailable:
                    return JSONResponse({'detail': 'Мастерская временно недоступна. Повторите вход позже.'}, status_code=503)
                if not authenticated:
                    return JSONResponse({'detail': 'Сессия мастерской истекла. Войдите снова.'}, status_code=401)
                session = {'csrf': csrf_for_owner(app.state.csrf_secret, owner_cookie)}
            else:
                session = sessions.get(request.cookies.get(COOKIE, ''))
                if not session or session['expires'] < time.time():
                    return JSONResponse({'detail': 'Войдите в сервис.'}, status_code=401)
            request.state.session = session
            if request.method not in ('GET', 'HEAD', 'OPTIONS'):
                token = request.headers.get('x-csrf-token', '')
                if not hmac.compare_digest(token, session['csrf']):
                    return JSONResponse({'detail': 'Обновите страницу и повторите действие.'}, status_code=403)
        if request.method in ('POST', 'PUT', 'PATCH'):
            try:
                length = int(request.headers.get('content-length', '-1'))
            except ValueError:
                length = -1
            cap = max_upload + 1024 * 1024 if path in ('/api/documents', '/api/stamp', '/api/stamps', '/api/signatures', '/api/stamp-sources') or path.startswith('/api/workshop/v1/documents/') else 16384
            if length < 0:
                return JSONResponse({'detail': 'Не указан размер запроса (Content-Length).'}, status_code=411)
            if length > cap:
                return JSONResponse({'detail': 'Файл или запрос слишком большой.'}, status_code=413)
        response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['X-Frame-Options'] = 'DENY'
        response.headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
        if path.startswith('/api/'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    async def run_pdf(operation, **args):
        work_dir = args.pop('_work_dir', None)
        file_limit = min(max_result, args.pop('_file_limit', max_result))
        try:
            await asyncio.wait_for(app.state.pdf_slot.acquire(), timeout=2)
        except TimeoutError:
            raise HTTPException(429, 'Обрабатывается другой документ. Повторите через несколько секунд.')
        receiver = sender = process = None
        try:
            context = mp.get_context('spawn')
            receiver, sender = context.Pipe(duplex=False)
            args['max_pages'] = max_pages
            process = context.Process(target=_worker, args=(sender, operation, args), daemon=True)
            process.start()
            sender.close()
            deadline = time.monotonic() + 70
            while not receiver.poll():
                candidates = list(Path(work_dir).rglob('*')) if work_dir else [Path(args[key]) for key in ('output_path', 'stamped_path') if key in args]
                too_large = False
                for candidate in candidates:
                    try:
                        if candidate.is_file() and candidate.stat().st_size > file_limit:
                            too_large = True
                            break
                    except FileNotFoundError:
                        # The worker can atomically publish a scratch file
                        # between this directory listing and the size check.
                        continue
                if too_large:
                    raise HTTPException(413, 'Результат превышает допустимый размер. Уменьшите число страниц или качество сканирования.')
                if not process.is_alive():
                    raise HTTPException(422, 'Обработка PDF прервана. Попробуйте другой файл.')
                if time.monotonic() > deadline:
                    raise HTTPException(422, 'Превышено время обработки PDF. Уменьшите число страниц.')
                await asyncio.sleep(.05)
            try:
                ok, result = await asyncio.to_thread(receiver.recv)
            except EOFError:
                raise HTTPException(422, 'Не удалось прочитать PDF.')
            if not ok:
                raise HTTPException(422, result)
            return result
        finally:
            if process is not None:
                await asyncio.to_thread(process.join, .3)
                if process.is_alive():
                    process.terminate()
                    await asyncio.to_thread(process.join, 1)
                if process.is_alive():
                    process.kill()
                    await asyncio.to_thread(process.join, 1)
            if receiver is not None:
                receiver.close()
            if sender is not None:
                sender.close()
            app.state.pdf_slot.release()

    def config():
        result = Settings.model_validate_json(settings_path.read_text(encoding='utf-8')).model_dump()
        library = read_library()
        selected = next((item for item in library['items'] if item['id'] == library['active_id']), None)
        ready = bool(selected and (stamps / (selected['id'] + '.png')).is_file())
        if selected:
            result.update({key: selected[key] for key in ('company_name', 'company_inn', 'width_mm')})
        result.update(stamp_ready=ready, stamp_aspect=selected['aspect'] if ready else 1.0,
                      stamp_notice=selected.get('notice', '') if selected else '',
                      active_stamp_id=selected['id'] if selected else None,
                      active_stamp_name=selected['name'] if selected else None,
                      ocr_available=bool(shutil.which('tesseract')), retention_minutes=0,
                      persistent_history=True, max_upload_mb=max_upload // (1024 * 1024),
                      max_result_mb=max_result // (1024 * 1024), supported_formats=['PDF', 'JPG', 'PNG'])
        result['auth_mode'] = auth_mode
        signature_library = read_signatures()
        signature = next((item for item in signature_library['items'] if item['id'] == signature_library['active_id']), None)
        signature_ready = bool(signature and (signatures / (signature['id'] + '.png')).is_file())
        result.update(signature_ready=signature_ready,
                      active_signature_id=signature['id'] if signature else None,
                      active_signature_name=signature['name'] if signature else None,
                      signature_aspect=signature['aspect'] if signature_ready else None,
                      signature_width_mm=signature['width_mm'] if signature else 70)
        return result

    def read_library():
        return json.loads(library_path.read_text(encoding='utf-8'))

    def get_stamp(stamp_id):
        if not re.fullmatch(r'[a-f0-9]{32}', stamp_id):
            raise HTTPException(404, 'Оттиск не найден.')
        library = read_library()
        selected = next((item for item in library['items'] if item['id'] == stamp_id), None)
        if not selected or not (stamps / (stamp_id + '.png')).is_file():
            raise HTTPException(404, 'Оттиск не найден.')
        return library, selected

    def read_signatures():
        return json.loads(signatures_path.read_text(encoding='utf-8'))

    def get_signature(signature_id):
        if not re.fullmatch(r'[a-f0-9]{32}', signature_id):
            raise HTTPException(404, 'Подпись не найдена.')
        library = read_signatures()
        selected = next((item for item in library['items'] if item['id'] == signature_id), None)
        if not selected or not (signatures / (signature_id + '.png')).is_file():
            raise HTTPException(404, 'Подпись не найдена.')
        return library, selected

    def storage_used():
        total = 0
        for path in data.rglob('*'):
            try:
                if path.is_file():
                    total += path.stat().st_size
            except FileNotFoundError:
                # Native workers may atomically move their scratch files.
                continue
        return total

    def ensure_storage(reservation, *, exclude=None):
        pending = sum(size for key, size in upload_reservations.items() if key != exclude)
        if storage_used() + pending + reservation > max_total or shutil.disk_usage(data).free < reservation + 16 * 1024 * 1024:
            raise HTTPException(429, 'Хранилище заполнено. Удалите ненужные документы или увеличьте лимит хранения.')

    def get_job(job_id):
        if not re.fullmatch(r'[a-f0-9]{32}', job_id):
            raise HTTPException(404, 'Документ не найден.')
        folder = jobs / job_id
        if not (folder / 'manifest.json').is_file():
            raise HTTPException(404, 'Документ не найден или был удалён.')
        manifest = json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))
        manifest.setdefault('source_type', 'pdf')
        manifest.setdefault('source_path', 'input.pdf')
        manifest.setdefault('size', (folder / manifest['source_path']).stat().st_size)
        manifest.setdefault('page_count', len(manifest['pages']))
        manifest.setdefault('results', [])
        manifest.setdefault('status', 'ready')
        manifest.setdefault('stamp_id', None)
        manifest.setdefault('stamp_name', 'Оттиск документа')
        manifest['stamp_ready'] = (folder / 'stamp.png').is_file()
        manifest.setdefault('stamp_enabled', manifest['stamp_ready'])
        manifest.setdefault('signature_id', None)
        manifest.setdefault('signature_name', None)
        manifest.setdefault('signature_aspect', None)
        manifest.setdefault('signature_width_mm', 70)
        manifest.setdefault('signature_placement', None)
        manifest.setdefault('signature_enabled', False)
        manifest.setdefault('signature_snapshots', {})
        signature_id = manifest['signature_id']
        manifest['signature_ready'] = bool(signature_id and re.fullmatch(r'[a-f0-9]{32}', signature_id)
                                           and (folder / ('signature-' + signature_id + '.png')).is_file())
        return folder, manifest

    def require_mutable(manifest):
        if manifest.get('origin') == 'workshop-v1':
            raise HTTPException(409, 'Документ создан в заказе Мастерской. Его результаты доступны только для чтения.')

    def get_stamp_source(source_id):
        if not re.fullmatch(r'[a-f0-9]{32}', source_id):
            raise HTTPException(404, 'Исходный скан не найден.')
        folder = stamp_sources / source_id
        if not (folder / 'manifest.json').is_file() or not (folder / 'original').is_file():
            raise HTTPException(404, 'Исходный скан не найден.')
        return folder, json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))

    def detect_source_type(path, filename):
        extension = Path(filename).suffix.lower()
        with path.open('rb') as stream:
            header = stream.read(1024)
        if extension == '.pdf' and b'%PDF-' in header:
            return 'pdf'
        if extension in ('.jpg', '.jpeg', '.png'):
            if header.startswith(b'\xff\xd8\xff'):
                return 'jpg'
            if header.startswith(b'\x89PNG\r\n\x1a\n'):
                return 'png'
        raise HTTPException(422, 'Поддерживаются PDF и изображения JPG/PNG. Проверьте формат и расширение файла.')

    def file_sha256(path):
        with path.open('rb') as stream:
            return hashlib.file_digest(stream, 'sha256').hexdigest()

    async def publish_stamp(temp, *, name, settings, reservation_id, provenance=None):
        # Uploaded and extracted artwork share the same usable profile. The
        # native extraction can legitimately return a line or oversized crop;
        # those previews must never become the active document stamp.
        # Decoding stays in the isolated worker and shares the same one-job
        # slot as PDF work; concurrent uploads cannot multiply parent memory.
        profile = await run_pdf('validate_stamp_png', stamp_path=str(temp))
        aspect = profile['aspect']
        name = name.strip()
        if not 1 <= len(name) <= 120 or any(ord(char) < 32 for char in name):
            raise HTTPException(422, 'Укажите название оттиска: от 1 до 120 символов.')
        async with storage_lock:
            library = read_library()
            if len(library['items']) >= 100:
                raise HTTPException(429, 'В библиотеке допускается не более 100 оттисков.')
            ensure_storage(0, exclude=reservation_id)
            stamp_id = secrets.token_hex(16)
            destination = stamps / (stamp_id + '.png')
            item = {**settings, 'id': stamp_id, 'name': name,
                    'aspect': aspect, 'notice': '', 'created': time.time()}
            if provenance:
                item.update(provenance)
                item['source_url'] = base_path + f'/api/stamps/{stamp_id}/source'
            previous_settings = json.loads(settings_path.read_text(encoding='utf-8'))
            try:
                temp.replace(destination)
                library['items'].insert(0, item)
                library['active_id'] = stamp_id
                atomic_json(settings_path, settings)
                atomic_json(library_path, library)
            except BaseException as exc:
                destination.unlink(missing_ok=True)
                try:
                    atomic_json(settings_path, previous_settings)
                except OSError:
                    LOG.warning('Could not restore settings after failed stamp publication')
                if isinstance(exc, OSError):
                    raise HTTPException(507, 'Не удалось сохранить оттиск. Проверьте доступ и свободное место в хранилище.') from None
                raise
            return library

    async def publish_signature(temp, *, fields, reservation_id, provenance=None):
        profile = await run_pdf('validate_signature_png', image_path=str(temp))
        name = fields.name.strip()
        signer = (fields.signer or '').strip() or None
        if not name or any(ord(char) < 32 for char in name) or (signer and any(ord(char) < 32 for char in signer)):
            raise HTTPException(422, 'Проверьте название подписи и имя подписанта.')
        sha256 = await asyncio.to_thread(file_sha256, temp)
        async with storage_lock:
            library = read_signatures()
            if len(library['items']) >= 100:
                raise HTTPException(429, 'В библиотеке допускается не более 100 подписей.')
            ensure_storage(0, exclude=reservation_id)
            signature_id = secrets.token_hex(16)
            destination = signatures / (signature_id + '.png')
            item = {'id': signature_id, 'name': name, 'signer': signer,
                    'width_mm': fields.width_mm, 'aspect': profile['aspect'], 'created': time.time(),
                    'sha256': sha256, 'size': temp.stat().st_size}
            if provenance:
                item.update(provenance)
                item['source_url'] = base_path + f'/api/signatures/{signature_id}/source'
            try:
                temp.replace(destination)
                library['items'].insert(0, item)
                library['active_id'] = signature_id
                atomic_json(signatures_path, library)
            except BaseException as exc:
                destination.unlink(missing_ok=True)
                if isinstance(exc, OSError):
                    raise HTTPException(507, 'Не удалось сохранить подпись. Проверьте доступ и свободное место в хранилище.') from None
                raise
            return library

    def snapshot_signature(folder, manifest, item):
        signature_id = item['id']
        path = folder / ('signature-' + signature_id + '.png')
        snapshots = manifest.setdefault('signature_snapshots', {})
        if path.is_file() and signature_id in snapshots:
            return snapshots[signature_id], None
        temporary = folder / ('.signature-' + signature_id + '-' + secrets.token_hex(8) + '.tmp')
        created = None
        try:
            if not path.exists():
                shutil.copyfile(signatures / (signature_id + '.png'), temporary)
                temporary.replace(path)
                created = path
            sha256 = file_sha256(path)
            if item.get('sha256') and item['sha256'] != sha256:
                raise HTTPException(409, 'Файл подписи изменён вне сервиса. Загрузите подпись заново.')
            snapshot = {**item, 'sha256': sha256}
            snapshots[signature_id] = snapshot
            return snapshot, created
        except BaseException:
            if created:
                created.unlink(missing_ok=True)
            raise
        finally:
            temporary.unlink(missing_ok=True)

    def select_signature(manifest, snapshot):
        manifest.update(signature_id=snapshot['id'] if snapshot else None,
                        signature_name=snapshot['name'] if snapshot else None,
                        signature_aspect=snapshot['aspect'] if snapshot else None,
                        signature_width_mm=snapshot['width_mm'] if snapshot else 70,
                        signature_ready=bool(snapshot), signature_enabled=False, signature_placement=None)

    async def upload_form(request, destination: Path, *, document=False):
        async with request.form(max_files=1, max_fields=6, max_part_size=max_upload) as form:
            upload = form.get('file')
            if upload is None or not hasattr(upload, 'read'):
                raise HTTPException(400, 'Выберите файл.')
            filename = str(upload.filename or 'document.pdf').replace('\\', '/').split('/')[-1]
            filename = ''.join(c for c in filename if ord(c) >= 32)[:160] or 'document.pdf'
            limit = max_upload if document else min(max_upload, 8 * 1024 * 1024)
            size = 0
            with destination.open('wb') as output:
                while chunk := await upload.read(1024 * 1024):
                    size += len(chunk)
                    if size > limit:
                        raise HTTPException(413, 'Файл превышает допустимый размер.')
                    output.write(chunk)
            if not size:
                raise HTTPException(422, 'Файл пуст.')
            fields = {key: str(form[key]) for key in ('name', 'signer', 'company_name', 'company_inn', 'width_mm', 'ocr') if key in form}
            return filename, fields, size

    @app.get('/health')
    async def health():
        return {'status': 'ok'}

    @app.post('/api/login')
    async def login(body: Credentials, request: Request):
        key = request.client.host if request.client else 'unknown'
        now = time.time()
        for host in list(attempts):
            while attempts[host] and attempts[host][0] < now - 300:
                attempts[host].popleft()
            if not attempts[host]:
                del attempts[host]
        if len(attempts[key]) >= 10:
            raise HTTPException(429, 'Слишком много попыток. Подождите 5 минут.')
        attempts[key].append(now)
        good_user = hmac.compare_digest(body.username.encode(), username.encode())
        good_pass = hmac.compare_digest(hashlib.sha256(body.password.encode()).digest(), hashlib.sha256(password.encode()).digest())
        if not (good_user and good_pass):
            raise HTTPException(401, 'Неверный логин или пароль.')
        attempts.pop(key, None)
        cleanup()
        if len(sessions) >= 100:
            sessions.pop(next(iter(sessions)))
        old_sid = request.cookies.get(COOKIE, '')
        sessions.pop(old_sid, None)
        sid, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        sessions[sid] = {'csrf': csrf, 'expires': now + session_ttl}
        response = JSONResponse({'csrf': csrf, 'username': username})
        response.set_cookie(COOKIE, sid, httponly=True, secure=secure_cookie, samesite='strict', max_age=session_ttl, path=cookie_path)
        return response

    @app.get('/api/me')
    async def me(request: Request):
        return {'username': 'Мастерская' if auth_mode == 'workshop' else username,
                'csrf': request.state.session['csrf'], 'auth_mode': auth_mode}

    @app.post('/api/logout')
    async def logout(request: Request):
        sessions.pop(request.cookies.get(COOKIE, ''), None)
        response = JSONResponse({'ok': True})
        response.delete_cookie(COOKIE, path=cookie_path)
        return response

    @app.get('/api/config')
    async def read_config():
        return config()

    @app.get('/api/documentation')
    async def documentation():
        parts = []
        for path in (ROOT / 'README.md', ROOT / 'docs/HANDOFF.md'):
            if path.is_file():
                parts.append('<section><h2>' + escape(path.name) + '</h2><pre>' + escape(path.read_text(encoding='utf-8')) + '</pre></section>')
        return HTMLResponse('<!doctype html><html lang="ru"><meta charset="utf-8">'
                            '<meta name="viewport" content="width=device-width,initial-scale=1">'
                            '<title>Документация — Печать на PDF</title>'
                            '<style>body{max-width:1000px;margin:32px auto;padding:0 20px;font:16px/1.6 system-ui;color:#17242b}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.65 ui-monospace,monospace}section{margin:40px 0}a{color:#136851}</style>'
                            '<a href="' + escape(cookie_path, quote=True) + '">← Вернуться в приложение</a>' + ''.join(parts) + '</html>')

    @app.get('/api/source')
    async def source_code():
        allowed = ['app', 'scripts', 'tests', 'docs', 'requirements.txt', 'requirements-dev.txt',
                   'Dockerfile', 'compose.yaml', 'Caddyfile.example', '.env.example',
                   '.dockerignore', '.gitignore', 'README.md', 'LICENSE', 'nginx.example', 'Открыть инструмент.cmd', 'compose.workshop.yaml']
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
            assets_dir = tarfile.TarInfo('stamp-service/assets')
            assets_dir.type = tarfile.DIRTYPE
            assets_dir.mode = 0o755
            archive.addfile(assets_dir)
            for name in allowed:
                path = ROOT / name
                if path.is_file():
                    archive.add(path, arcname=f'stamp-service/{name}', recursive=False)
                elif path.is_dir():
                    for child in path.rglob('*'):
                        if child.is_file() and '__pycache__' not in child.parts and child.suffix != '.pyc':
                            archive.add(child, arcname='stamp-service/' + child.relative_to(ROOT).as_posix(), recursive=False)
        return Response(buffer.getvalue(), media_type='application/gzip',
                        headers={'Content-Disposition': 'attachment; filename=stamp-service-source.tar.gz'})

    @app.post('/api/settings')
    async def write_settings(body: Settings):
        async with storage_lock:
            atomic_json(settings_path, body.model_dump())
            library = read_library()
            selected = next((item for item in library['items'] if item['id'] == library['active_id']), None)
            if selected:
                selected.update(body.model_dump())
                atomic_json(library_path, library)
        return config()

    @app.get('/api/stamp/image')
    async def stamp_image():
        stamp_id = read_library()['active_id']
        if not stamp_id:
            raise HTTPException(404, 'Сначала загрузите PNG печати.')
        return FileResponse(stamps / (stamp_id + '.png'), media_type='image/png')

    @app.get('/api/stamps')
    async def list_stamps():
        return read_library()

    @app.get('/api/stamps/{stamp_id}/image')
    async def library_stamp_image(stamp_id: str):
        get_stamp(stamp_id)
        return FileResponse(stamps / (stamp_id + '.png'), media_type='image/png')

    @app.get('/api/stamps/{stamp_id}/source')
    async def library_stamp_source(stamp_id: str):
        _, item = get_stamp(stamp_id)
        if not item.get('source_id'):
            raise HTTPException(404, 'У этого оттиска нет сохранённого исходного скана.')
        folder, source = get_stamp_source(item['source_id'])
        media_type = {'pdf': 'application/pdf', 'jpg': 'image/jpeg', 'png': 'image/png'}[source['source_type']]
        return FileResponse(folder / 'original', media_type=media_type, filename=source['filename'])

    @app.post('/api/stamps/{stamp_id}/activate')
    async def activate_stamp(stamp_id: str):
        async with storage_lock:
            library, selected = get_stamp(stamp_id)
            library['active_id'] = stamp_id
            atomic_json(library_path, library)
            atomic_json(settings_path, {key: selected[key] for key in ('company_name', 'company_inn', 'width_mm')})
        return config()

    async def add_stamp(request: Request):
        temp = data / f'upload-{secrets.token_hex(8)}.png'
        reservation_id = 'stamp-' + secrets.token_hex(16)
        async with storage_lock:
            if len(read_library()['items']) >= 100:
                raise HTTPException(429, 'В библиотеке допускается не более 100 оттисков.')
            ensure_storage(min(max_upload, 8 * 1024 * 1024))
            upload_reservations[reservation_id] = min(max_upload, 8 * 1024 * 1024)
        try:
            filename, fields, _ = await upload_form(request, temp)
            defaults = config()
            try:
                settings = Settings.model_validate({key: fields.get(key, defaults[key]) for key in ('company_name', 'company_inn', 'width_mm')}).model_dump()
            except ValueError:
                raise HTTPException(422, 'Проверьте название компании, ИНН и размер печати.')
            return await publish_stamp(temp, name=fields.get('name', Path(filename).stem),
                                       settings=settings, reservation_id=reservation_id)
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(422, 'Не удалось прочитать PNG печати.')
        finally:
            temp.unlink(missing_ok=True)
            upload_reservations.pop(reservation_id, None)

    @app.post('/api/stamps')
    async def create_stamp(request: Request):
        return await add_stamp(request)

    @app.post('/api/stamp')
    async def replace_stamp(request: Request):
        await add_stamp(request)
        return config()

    @app.get('/api/signatures')
    async def list_signatures():
        return read_signatures()

    @app.post('/api/signatures')
    async def add_signature(request: Request):
        operation_id = secrets.token_hex(16)
        temporary = data / ('signature-upload-' + operation_id + '.png')
        reservation_id = 'signature-upload-' + operation_id
        reservation = min(max_upload, 8 * 1024 * 1024)
        async with storage_lock:
            if len(read_signatures()['items']) >= 100:
                raise HTTPException(429, 'В библиотеке допускается не более 100 подписей.')
            ensure_storage(reservation)
            upload_reservations[reservation_id] = reservation
        try:
            filename, values, _ = await upload_form(request, temporary)
            try:
                fields = SignatureFields.model_validate({
                    'name': values.get('name', Path(filename).stem),
                    'signer': values.get('signer'), 'width_mm': values.get('width_mm', 70),
                })
            except ValueError:
                raise HTTPException(422, 'Проверьте название подписи, подписанта и ширину (10–100 мм).')
            return await publish_signature(temporary, fields=fields, reservation_id=reservation_id)
        finally:
            temporary.unlink(missing_ok=True)
            upload_reservations.pop(reservation_id, None)

    @app.post('/api/signatures/{signature_id}/activate')
    async def activate_signature(signature_id: str):
        async with storage_lock:
            library, _ = get_signature(signature_id)
            library['active_id'] = signature_id
            atomic_json(signatures_path, library)
        return config()

    @app.get('/api/signatures/{signature_id}/image')
    async def signature_image(signature_id: str):
        get_signature(signature_id)
        return FileResponse(signatures / (signature_id + '.png'), media_type='image/png')

    @app.get('/api/signatures/{signature_id}/source')
    async def signature_source(signature_id: str):
        _, item = get_signature(signature_id)
        if not item.get('source_id'):
            raise HTTPException(404, 'У этой подписи нет сохранённого исходного скана.')
        folder, source = get_stamp_source(item['source_id'])
        media_type = {'pdf': 'application/pdf', 'jpg': 'image/jpeg', 'png': 'image/png'}[source['source_type']]
        return FileResponse(folder / 'original', media_type=media_type, filename=source['filename'])

    @app.post('/api/stamp-sources')
    async def upload_stamp_source(request: Request):
        source_id = secrets.token_hex(16)
        folder = stamp_sources / source_id
        active_key = 'source:' + source_id
        reservation_id = 'source-upload-' + source_id
        async with storage_lock:
            if len([path for path in stamp_sources.iterdir() if path.is_dir()]) >= max_jobs:
                raise HTTPException(429, 'Достигнут лимит исходных сканов. Увеличьте лимит хранения.')
            ensure_storage(max_upload)
            folder.mkdir(mode=0o700)
            active.add(active_key)
            upload_reservations[reservation_id] = max_upload
        try:
            original = folder / 'original'
            name, _, size = await upload_form(request, original, document=True)
            source_type = detect_source_type(original, name)
            info = await run_pdf('stamp_source_info', input_path=str(original), source_type=source_type)
            manifest = {'id': source_id, 'filename': name, 'source_type': source_type,
                        'size': size, 'created': time.time(), 'page_count': info['page_count'],
                        'pages': [{'page': page['index'], 'width': page['width'], 'height': page['height']}
                                  for page in info['pages']],
                        'source_sha256': await asyncio.to_thread(file_sha256, original),
                        'original_url': base_path + f'/api/stamp-sources/{source_id}/original'}
            async with storage_lock:
                ensure_storage(0, exclude=reservation_id)
                atomic_json(folder / 'manifest.json', manifest)
            return manifest
        except BaseException:
            shutil.rmtree(folder, ignore_errors=True)
            raise
        finally:
            active.discard(active_key)
            upload_reservations.pop(reservation_id, None)

    @app.get('/api/stamp-sources')
    async def list_stamp_sources():
        items = []
        for folder in stamp_sources.iterdir():
            if folder.is_dir() and (folder / 'manifest.json').is_file():
                try:
                    _, manifest = get_stamp_source(folder.name)
                    items.append(manifest)
                except (HTTPException, ValueError, OSError):
                    LOG.warning('Skipped unreadable stamp source manifest: %s', folder.name)
        return {'items': sorted(items, key=lambda item: item['created'], reverse=True)}

    @app.get('/api/stamp-sources/{source_id}')
    async def read_stamp_source(source_id: str):
        _, manifest = get_stamp_source(source_id)
        return manifest

    @app.get('/api/stamp-sources/{source_id}/original')
    async def original_stamp_source(source_id: str):
        folder, manifest = get_stamp_source(source_id)
        media_type = {'pdf': 'application/pdf', 'jpg': 'image/jpeg', 'png': 'image/png'}[manifest['source_type']]
        return FileResponse(folder / 'original', media_type=media_type, filename=manifest['filename'])

    @app.delete('/api/stamp-sources/{source_id}')
    async def delete_stamp_source(source_id: str):
        async with storage_lock:
            folder, _ = get_stamp_source(source_id)
            if 'source:' + source_id in active:
                raise HTTPException(409, 'Дождитесь окончания обработки этого скана.')
            if any(item.get('source_id') == source_id for item in read_library()['items'] + read_signatures()['items']):
                raise HTTPException(409, 'Этот скан сохранён как источник оттиска или подписи и не может быть удалён.')
            shutil.rmtree(folder)
        return {'ok': True}

    async def process_stamp_source(source_id, body, *, render_page=None, save=False):
        folder, source = get_stamp_source(source_id)
        page = render_page if render_page is not None else body.page
        if not 0 <= page < source['page_count']:
            raise HTTPException(404 if render_page is not None else 422, 'Страница не найдена.')
        params = None
        if body is not None:
            if body.crop.x + body.crop.width > 1.0000000001 or body.crop.y + body.crop.height > 1.0000000001:
                raise HTTPException(422, 'Область оттиска выходит за границу страницы.')
            params = body.model_dump(include={'page', 'crop', 'color', 'strength', 'rotation'})
        operation_id = secrets.token_hex(16)
        reservation_id = 'source-operation-' + operation_id
        active_key = 'source:' + source_id
        work_dir = folder / ('work-' + operation_id)
        png_limit = min(max_result, 8 * 1024 * 1024)
        # The exclusive PNG writer briefly owns its native temporary file and
        # destination together. Reserve both until the worker has completed.
        reservation = 2 * png_limit
        async with storage_lock:
            if active_key in active:
                raise HTTPException(409, 'Дождитесь окончания предыдущей операции с этим сканом.')
            if save:
                target_library = read_signatures() if save == 'signature' else read_library()
                if len(target_library['items']) >= 100:
                    raise HTTPException(429, 'Достигнут лимит изображений в библиотеке.')
            ensure_storage(reservation)
            try:
                work_dir.mkdir(mode=0o700)
            except OSError:
                raise HTTPException(507, 'Не удалось подготовить обработку скана. Проверьте доступ к хранилищу.')
            active.add(active_key)
            upload_reservations[reservation_id] = reservation
        output = work_dir / 'preview.png'
        try:
            args = {'input_path': str(folder / 'original'), 'source_type': source['source_type'],
                    'output_path': str(output), '_work_dir': str(work_dir), '_file_limit': png_limit}
            if render_page is not None:
                args['page'] = page
                metadata = await run_pdf('stamp_source_render', **args)
            else:
                args.update(params)
                metadata = await run_pdf('stamp_source_extract', **args)
                if metadata['source_sha256'] != source['source_sha256']:
                    raise HTTPException(409, 'Исходный скан изменён вне сервиса. Загрузите его заново.')
            if not output.is_file() or not 0 < output.stat().st_size <= png_limit:
                raise HTTPException(413, 'PNG оттиска или предпросмотра превышает допустимый размер. Выберите меньшую область.')
            output_sha256 = await asyncio.to_thread(file_sha256, output)
            if render_page is None and output_sha256 != metadata['output_sha256']:
                raise HTTPException(422, 'Не удалось проверить извлечённый оттиск. Повторите обработку.')
            if save:
                provenance = {'source_id': source_id, 'source_sha256': source['source_sha256'],
                              'output_sha256': output_sha256, 'extraction': params,
                              'extraction_result': metadata}
                if save == 'signature':
                    return await publish_signature(output, fields=body, reservation_id=reservation_id,
                                                   provenance=provenance)
                settings = {key: getattr(body, key) for key in ('company_name', 'company_inn', 'width_mm')}
                return await publish_stamp(output, name=body.name, settings=settings,
                                           reservation_id=reservation_id, provenance=provenance)
            return Response(output.read_bytes(), media_type='image/png', headers={
                'X-Source-SHA256': source['source_sha256'], 'X-Output-SHA256': output_sha256,
                'X-Extraction-Coverage': str(metadata.get('coverage', '')),
                'X-Extraction-Warnings': json.dumps(metadata.get('warnings', []), ensure_ascii=True),
            })
        finally:
            # Worker termination cannot leave its native temporary files in
            # permanent source storage. The original upload is never removed.
            shutil.rmtree(work_dir, ignore_errors=True)
            active.discard(active_key)
            upload_reservations.pop(reservation_id, None)

    @app.get('/api/stamp-sources/{source_id}/pages/{page}.png')
    async def stamp_source_page(source_id: str, page: int):
        return await process_stamp_source(source_id, None, render_page=page)

    @app.post('/api/stamp-sources/{source_id}/extract')
    async def extract_stamp_source(source_id: str, body: ExtractionRequest):
        return await process_stamp_source(source_id, body)

    @app.post('/api/stamp-sources/{source_id}/save')
    async def save_stamp_source(source_id: str, body: SaveExtractionRequest):
        return await process_stamp_source(source_id, body, save=True)

    @app.post('/api/stamp-sources/{source_id}/save-signature')
    async def save_signature_source(source_id: str, body: SaveSignatureRequest):
        return await process_stamp_source(source_id, body, save='signature')

    @app.post('/api/documents')
    async def upload_document(request: Request):
        cleanup()
        cfg = config()
        reservation = 3 * max_upload
        job_id = secrets.token_hex(16)
        folder = jobs / job_id
        async with storage_lock:
            if len([path for path in jobs.iterdir() if path.is_dir()]) >= max_jobs:
                raise HTTPException(429, 'Достигнут лимит документов. Удалите ненужные документы или увеличьте лимит хранения.')
            ensure_storage(reservation)
            folder.mkdir(mode=0o700)
            active.add(job_id)
            upload_reservations[job_id] = reservation
        try:
            source = folder / 'upload'
            name, fields, source_size = await upload_form(request, source, document=True)
            extension = Path(name).suffix.lower()
            with source.open('rb') as stream:
                header = stream.read(1024)
            if extension == '.pdf' and b'%PDF-' in header:
                source_type, source_path = 'pdf', 'input.pdf'
                source.replace(folder / source_path)
            elif extension in ('.jpg', '.jpeg', '.png') and (header.startswith(b'\xff\xd8\xff') or header.startswith(b'\x89PNG\r\n\x1a\n')):
                source_type = 'png' if header.startswith(b'\x89PNG') else 'jpg'
                source_path = 'original.' + source_type
                source.replace(folder / source_path)
                await run_pdf('image_to_pdf', image_path=str(folder / source_path), output_path=str(folder / 'input.pdf'))
            else:
                raise HTTPException(422, 'Поддерживаются PDF и изображения JPG/PNG. Проверьте формат и расширение файла.')
            if cfg['stamp_ready']:
                shutil.copyfile(stamps / (cfg['active_stamp_id'] + '.png'), folder / 'stamp.png')
            analysis = await run_pdf('inspect', pdf_path=str(folder / 'input.pdf'),
                                     company_inn=cfg['company_inn'], company_name=cfg['company_name'],
                                     width_mm=cfg['width_mm'], stamp_aspect=cfg['stamp_aspect'], ocr=fields.get('ocr', '').lower() == 'true')
            manifest = {**analysis, 'id': job_id, 'filename': name, 'created': time.time(),
                        'stamp_aspect': cfg['stamp_aspect'], 'width_mm': cfg['width_mm'],
                        'source_type': source_type, 'source_path': source_path, 'size': source_size,
                        'page_count': len(analysis['pages']),
                        'stamp_id': cfg['active_stamp_id'] if cfg['stamp_ready'] else None,
                        'stamp_name': cfg['active_stamp_name'] if cfg['stamp_ready'] else None,
                        'stamp_ready': cfg['stamp_ready'], 'stamp_enabled': cfg['stamp_ready'],
                        'stamp_sha256': await asyncio.to_thread(file_sha256, folder / 'stamp.png') if cfg['stamp_ready'] else None,
                        'results': [], 'status': 'ready', 'signature_snapshots': {}}
            if cfg['signature_ready']:
                _, selected = get_signature(cfg['active_signature_id'])
                snapshot, _ = snapshot_signature(folder, manifest, selected)
                select_signature(manifest, snapshot)
            else:
                select_signature(manifest, None)
            async with storage_lock:
                ensure_storage(0, exclude=job_id)
                atomic_json(folder / 'manifest.json', manifest)
            return manifest
        except BaseException:
            shutil.rmtree(folder, ignore_errors=True)
            raise
        finally:
            active.discard(job_id)
            upload_reservations.pop(job_id, None)

    @app.get('/api/documents')
    async def list_documents():
        items = []
        for folder in jobs.iterdir():
            if folder.is_dir() and (folder / 'manifest.json').is_file():
                try:
                    _, manifest = get_job(folder.name)
                    items.append(manifest)
                except (HTTPException, ValueError, OSError):
                    LOG.warning('Skipped unreadable document manifest: %s', folder.name)
        return {'items': sorted(items, key=lambda item: item['created'], reverse=True)}

    @app.get('/api/documents/{job_id}')
    async def read_document(job_id: str):
        _, manifest = get_job(job_id)
        return manifest

    @app.get('/api/documents/{job_id}/original')
    async def original_document(job_id: str):
        folder, manifest = get_job(job_id)
        media_type = {'pdf': 'application/pdf', 'jpg': 'image/jpeg', 'png': 'image/png'}[manifest['source_type']]
        return FileResponse(folder / manifest['source_path'], media_type=media_type, filename=manifest['filename'])

    @app.get('/api/documents/{job_id}/results/{result_id}')
    async def download_result(job_id: str, result_id: str):
        folder, manifest = get_job(job_id)
        result = next((item for item in manifest['results'] if item['id'] == result_id), None)
        if not result or not re.fullmatch(r'[a-f0-9]{32}', result_id):
            raise HTTPException(404, 'Результат не найден.')
        path = folder / 'results' / (result_id + '.pdf')
        if not path.is_file():
            raise HTTPException(404, 'Файл результата не найден.')
        return FileResponse(path, media_type='application/pdf', filename=result['filename'])

    @app.get('/api/documents/{job_id}/pages/{page_index}.png')
    async def document_page(job_id: str, page_index: int):
        folder, manifest = get_job(job_id)
        if not 0 <= page_index < len(manifest['pages']):
            raise HTTPException(404, 'Страница не найдена.')
        if job_id in active:
            raise HTTPException(409, 'Дождитесь окончания предыдущей операции с документом.')
        active.add(job_id)
        try:
            page = manifest['pages'][page_index]
            max_width = min(1600, int(math.sqrt(8_000_000 * page['width'] / page['height'])))
            png = await run_pdf('render', pdf_path=str(folder / 'input.pdf'), page_index=page_index, max_width=max_width)
            return Response(png, media_type='image/png')
        finally:
            active.discard(job_id)

    @app.get('/api/documents/{job_id}/stamp.png')
    async def document_stamp(job_id: str):
        folder, manifest = get_job(job_id)
        if not manifest['stamp_ready']:
            raise HTTPException(404, 'К документу не привязан оттиск.')
        return Response((folder / 'stamp.png').read_bytes(), media_type='image/png')

    @app.get('/api/documents/{job_id}/signature.png')
    async def document_signature(job_id: str):
        folder, manifest = get_job(job_id)
        if not manifest['signature_ready']:
            raise HTTPException(404, 'К документу не привязана подпись.')
        return FileResponse(folder / ('signature-' + manifest['signature_id'] + '.png'), media_type='image/png')

    @app.post('/api/documents/{job_id}/signature')
    async def bind_document_signature(job_id: str, body: SignatureBinding):
        created = None
        async with storage_lock:
            folder, manifest = get_job(job_id)
            require_mutable(manifest)
            if job_id in active:
                raise HTTPException(409, 'Дождитесь окончания обработки документа.')
            if body.signature_id == manifest['signature_id'] and (body.signature_id is None or manifest['signature_ready']):
                return manifest
            if body.signature_id is not None:
                _, selected = get_signature(body.signature_id)
                size = (signatures / (body.signature_id + '.png')).stat().st_size
                if size > min(max_upload, 8 * 1024 * 1024):
                    raise HTTPException(413, 'Файл подписи превышает допустимый размер.')
                ensure_storage(size + 65536)
                snapshot, created = snapshot_signature(folder, manifest, selected)
            else:
                snapshot = None
            select_signature(manifest, snapshot)
            try:
                atomic_json(folder / 'manifest.json', manifest)
            except OSError:
                if created:
                    created.unlink(missing_ok=True)
                raise HTTPException(507, 'Не удалось сохранить выбранную подпись документа.') from None
        return manifest

    def validate_placement(manifest, body):
        if not manifest['stamp_ready']:
            raise HTTPException(409, 'К документу не привязан оттиск.')
        if not 0 <= body.page < len(manifest['pages']):
            raise HTTPException(422, 'Страница не найдена.')
        page = manifest['pages'][body.page]
        if not 20 * 72 / 25.4 <= body.width <= 60 * 72 / 25.4:
            raise HTTPException(422, 'Ширина печати должна быть от 20 до 60 мм.')
        if abs(body.height / body.width - manifest['stamp_aspect']) > .001:
            raise HTTPException(422, 'Пропорции печати должны сохраняться.')
        if body.x + body.width > page['width'] + .01 or body.y + body.height > page['height'] + .01:
            raise HTTPException(422, 'Печать выходит за границу страницы.')

    async def generate_result(job_id, body, *, kind, profile=None, dpi=None):
        folder, manifest = get_job(job_id)
        require_mutable(manifest)
        validate_placement(manifest, body)
        result_id = secrets.token_hex(16)
        reservation_id = 'result-' + result_id
        reservation = max_result * (2 if kind == 'scan' else 1)
        results_dir = folder / 'results'
        work_dir = folder / ('work-' + result_id)
        async with storage_lock:
            if job_id in active:
                raise HTTPException(409, 'Дождитесь окончания предыдущей операции с документом.')
            ensure_storage(reservation)
            # A failed mkdir must not leave an in-memory processing flag or
            # reserved quota that prevents all future attempts on this job.
            try:
                results_dir.mkdir(exist_ok=True, mode=0o700)
                work_dir.mkdir(mode=0o700)
            except OSError:
                raise HTTPException(507, 'Не удалось подготовить папку результатов. Проверьте место на диске и доступ к хранилищу.')
            upload_reservations[reservation_id] = reservation
            active.add(job_id)
        output_path = work_dir / 'output.pdf'
        stored_path = results_dir / (result_id + '.pdf')
        intermediate = work_dir / 'stamped.pdf'
        committed = False
        try:
            args = dict(pdf_path=str(folder / 'input.pdf'), output_path=str(output_path),
                        stamp_path=str(folder / 'stamp.png'), placement=body.model_dump(), _work_dir=str(work_dir))
            if kind == 'scan':
                args.update(stamped_path=str(intermediate), profile=profile, dpi=dpi)
            scan_metadata = await run_pdf('scan' if kind == 'scan' else 'stamp', **args)
            intermediate.unlink(missing_ok=True)
            if not output_path.is_file() or output_path.stat().st_size > max_result:
                raise HTTPException(413, 'Результат превышает допустимый размер. Уменьшите число страниц или качество сканирования.')
            filename = Path(manifest['filename']).stem + ('-скан.pdf' if kind == 'scan' else '-с-печатью.pdf')
            url = base_path + f'/api/documents/{job_id}/results/{result_id}'
            result = {'id': result_id, 'kind': kind, 'filename': filename, 'created': time.time(),
                      'url': url, 'size': output_path.stat().st_size,
                      'sha256': hashlib.sha256(output_path.read_bytes()).hexdigest(),
                      'stamp_enabled': True, 'signature_enabled': False,
                      'placement': body.model_dump(), 'signature_placement': None,
                      'stamp_id': manifest['stamp_id'], 'stamp_name': manifest['stamp_name'],
                      'stamp_sha256': await asyncio.to_thread(file_sha256, folder / 'stamp.png'),
                      'signature_id': None, 'signature_name': None, 'signature_sha256': None}
            if kind == 'scan':
                result.update(profile=profile, dpi=dpi, simulated_scan=True)
                if isinstance(scan_metadata, dict):
                    result['scan'] = scan_metadata
            async with storage_lock:
                ensure_storage(0, exclude=reservation_id)
                # Each successful request is a new immutable result. Repeating
                # an operation cannot replace an already downloaded document.
                manifest['results'].append(result)
                manifest.update(placement=body.model_dump(), status='completed', updated=result['created'],
                                stamp_enabled=True, signature_enabled=False)
                output_path.replace(stored_path)
                atomic_json(folder / 'manifest.json', manifest)
                committed = True
            return Response(stored_path.read_bytes(), media_type='application/pdf',
                            headers={'Content-Disposition': "attachment; filename=result.pdf; filename*=UTF-8''" + quote(filename),
                                     'X-Result-Id': result_id, 'X-Result-Url': url})
        finally:
            # Termination bypasses the native worker's finally blocks. Its
            # entire exclusive scratch directory belongs to this operation.
            shutil.rmtree(work_dir, ignore_errors=True)
            if not committed:
                stored_path.unlink(missing_ok=True)
            upload_reservations.pop(reservation_id, None)
            active.discard(job_id)

    @app.post('/api/documents/{job_id}/stamp')
    async def apply_stamp(job_id: str, body: Placement):
        return await generate_result(job_id, body, kind='stamped')

    @app.post('/api/documents/{job_id}/scan')
    async def scan_document(job_id: str, body: ScanRequest):
        if body.dpi not in (150, 200):
            raise HTTPException(422, 'Для сканирования выберите 150 или 200 DPI.')
        return await generate_result(job_id, body.placement, kind='scan', profile=body.profile, dpi=body.dpi)

    def validate_signature_placement(manifest, body):
        if not manifest['signature_ready']:
            raise HTTPException(409, 'К документу не привязана подпись. Выберите её перед сохранением.')
        if not 0 <= body.page < len(manifest['pages']):
            raise HTTPException(422, 'Страница подписи не найдена.')
        if not 10 * 72 / 25.4 <= body.width <= 100 * 72 / 25.4:
            raise HTTPException(422, 'Ширина подписи должна быть от 10 до 100 мм.')
        aspect = manifest['signature_aspect']
        if not aspect or abs((body.height / body.width) / aspect - 1) > .001:
            raise HTTPException(422, 'Пропорции подписи должны сохраняться.')
        page = manifest['pages'][body.page]
        if body.x + body.width > page['width'] + .01 or body.y + body.height > page['height'] + .01:
            raise HTTPException(422, 'Подпись выходит за границу страницы.')

    async def generate_composition(job_id, body, *, scan=False):
        if body.placement is None and body.signature_placement is None:
            raise HTTPException(422, 'Разместите печать, подпись или оба изображения.')
        if scan and body.dpi not in (150, 200):
            raise HTTPException(422, 'Для сканирования выберите 150 или 200 DPI.')
        folder, manifest = get_job(job_id)
        require_mutable(manifest)
        overlays = []
        descriptions = []
        if body.placement is not None:
            validate_placement(manifest, body.placement)
            overlays.append({'kind': 'stamp', 'image_path': str(folder / 'stamp.png'),
                             'placement': body.placement.model_dump()})
            descriptions.append({'kind': 'stamp', 'id': manifest['stamp_id'], 'name': manifest['stamp_name']})
        if body.signature_placement is not None:
            validate_signature_placement(manifest, body.signature_placement)
            overlays.append({'kind': 'signature',
                             'image_path': str(folder / ('signature-' + manifest['signature_id'] + '.png')),
                             'placement': body.signature_placement.model_dump()})
            descriptions.append({'kind': 'signature', 'id': manifest['signature_id'], 'name': manifest['signature_name']})
        result_id = secrets.token_hex(16)
        reservation_id = 'composition-' + result_id
        reservation = max_result * (3 if scan else 2)
        results_dir = folder / 'results'
        work_dir = folder / ('work-' + result_id)
        async with storage_lock:
            if job_id in active:
                raise HTTPException(409, 'Дождитесь окончания предыдущей операции с документом.')
            ensure_storage(reservation)
            try:
                results_dir.mkdir(exist_ok=True, mode=0o700)
                work_dir.mkdir(mode=0o700)
            except OSError:
                raise HTTPException(507, 'Не удалось подготовить папку результатов.')
            active.add(job_id)
            upload_reservations[reservation_id] = reservation
        output = work_dir / 'output.pdf'
        intermediate = work_dir / 'composed.pdf'
        stored = results_dir / (result_id + '.pdf')
        committed = False
        try:
            args = {'pdf_path': str(folder / 'input.pdf'), 'output_path': str(output),
                    'overlays': overlays, '_work_dir': str(work_dir)}
            if scan:
                args.update(composed_path=str(intermediate), profile=body.profile, dpi=body.dpi)
            metadata = await run_pdf('compose_scan' if scan else 'compose', **args)
            intermediate.unlink(missing_ok=True)
            if not output.is_file() or not 0 < output.stat().st_size <= max_result:
                raise HTTPException(413, 'Результат превышает допустимый размер. Уменьшите число страниц или качество сканирования.')
            sha256 = await asyncio.to_thread(file_sha256, output)
            if metadata['output_sha256'] != sha256:
                raise HTTPException(422, 'Не удалось проверить готовый PDF.')
            if len(metadata['overlays']) != len(descriptions):
                raise HTTPException(422, 'Не удалось проверить изображения готового документа.')
            overlay_results = []
            for description, receipt in zip(descriptions, metadata['overlays']):
                if description['kind'] != receipt['kind']:
                    raise HTTPException(422, 'Не удалось проверить изображения готового документа.')
                expected_sha256 = (manifest.get('stamp_sha256') if description['kind'] == 'stamp'
                                   else manifest['signature_snapshots'].get(description['id'], {}).get('sha256'))
                if expected_sha256 and expected_sha256 != receipt['image_sha256']:
                    raise HTTPException(409, 'Изображение документа изменено вне сервиса. Выберите исходное изображение заново.')
                overlay_results.append({**description, **receipt})
            placement = body.placement.model_dump() if body.placement else None
            signature_placement = body.signature_placement.model_dump() if body.signature_placement else None
            stamp_result = next((item for item in overlay_results if item['kind'] == 'stamp'), None)
            signature_result = next((item for item in overlay_results if item['kind'] == 'signature'), None)
            filename = Path(manifest['filename']).stem + ('-скан.pdf' if scan else '-готовый.pdf')
            url = base_path + f'/api/documents/{job_id}/results/{result_id}'
            result = {'id': result_id, 'kind': 'scan' if scan else 'composed',
                      'filename': filename, 'created': time.time(), 'url': url,
                      'size': output.stat().st_size, 'sha256': sha256,
                      'source_sha256': metadata['source_sha256'], 'overlays': overlay_results,
                      'stamp_enabled': bool(stamp_result), 'signature_enabled': bool(signature_result),
                      'placement': placement, 'signature_placement': signature_placement,
                      'stamp_id': stamp_result['id'] if stamp_result else None,
                      'stamp_name': stamp_result['name'] if stamp_result else None,
                      'stamp_sha256': stamp_result['image_sha256'] if stamp_result else None,
                      'signature_id': signature_result['id'] if signature_result else None,
                      'signature_name': signature_result['name'] if signature_result else None,
                      'signature_sha256': signature_result['image_sha256'] if signature_result else None}
            if scan:
                result.update(profile=body.profile, dpi=body.dpi, simulated_scan=True,
                              scan=metadata['scan'], composed_sha256=metadata['composed_sha256'])
            async with storage_lock:
                ensure_storage(0, exclude=reservation_id)
                manifest['results'].append(result)
                manifest.update(stamp_enabled=bool(stamp_result), signature_enabled=bool(signature_result),
                                status='completed', updated=result['created'])
                if placement is not None:
                    manifest['placement'] = placement
                if signature_placement is not None:
                    manifest['signature_placement'] = signature_placement
                try:
                    output.replace(stored)
                    atomic_json(folder / 'manifest.json', manifest)
                except OSError:
                    raise HTTPException(507, 'Не удалось сохранить готовый документ в истории.') from None
                committed = True
            return Response(stored.read_bytes(), media_type='application/pdf', headers={
                'Content-Disposition': "attachment; filename=result.pdf; filename*=UTF-8''" + quote(filename),
                'X-Result-Id': result_id, 'X-Result-Url': url,
            })
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)
            if not committed:
                stored.unlink(missing_ok=True)
            active.discard(job_id)
            upload_reservations.pop(reservation_id, None)

    @app.post('/api/documents/{job_id}/compose')
    async def compose_document(job_id: str, body: CompositionRequest):
        return await generate_composition(job_id, body)

    @app.post('/api/documents/{job_id}/compose-scan')
    async def compose_scan_document(job_id: str, body: CompositionRequest):
        return await generate_composition(job_id, body, scan=True)

    @app.delete('/api/documents/{job_id}')
    async def delete_document(job_id: str):
        async with storage_lock:
            folder, manifest = get_job(job_id)
            require_mutable(manifest)
            if job_id in active:
                raise HTTPException(409, 'Дождитесь окончания обработки документа.')
            shutil.rmtree(folder)
        return {'ok': True}

    workshop_service = register_workshop_documents(
        app, data=data, jobs=jobs, stamps=stamps, signatures=signatures,
        read_library=read_library, read_signatures=read_signatures, run_pdf=run_pdf,
        storage_lock=storage_lock, ensure_storage=ensure_storage, active=active,
        reservations=upload_reservations, max_upload=max_upload, max_jobs=max_jobs,
        max_result=max_result, base_path=base_path)

    app.mount('/static', StaticFiles(directory=ROOT / 'app/static'), name='static')

    @app.get('/')
    async def index(request: Request):
        html = (ROOT / 'app/static/index.html').read_text(encoding='utf-8')
        href = request.scope.get('root_path', '').rstrip('/') + '/'
        html = html.replace('<base href="/">', '<base href="' + escape(href, quote=True) + '">', 1)
        if auth_mode == 'workshop':
            html = html.replace('<body>', '<body data-auth-mode="workshop" data-main-app-url="/">', 1)
        return HTMLResponse(html)

    return app


app = create_app()
