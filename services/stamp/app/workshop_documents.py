"""Immutable, idempotent Workshop document exports using the existing PDF worker."""
from __future__ import annotations

import asyncio
from contextlib import nullcontext
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import time
from uuid import UUID

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from typing import Literal

HEX = r'^[a-f0-9]{64}$'
IMAGE_ID = r'^[a-f0-9]{32}$'
UUID_RE = re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$', re.I)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def sync_file(path):
    # Windows FlushFileBuffers requires a writable handle; no bytes are changed.
    with Path(path).open('rb+' if os.name == 'nt' else 'rb') as stream:
        os.fsync(stream.fileno())


def durable_bytes(path, data):
    path = Path(path)
    temporary = path.with_name(path.name + '.' + secrets.token_hex(8) + '.tmp')
    try:
        with temporary.open('xb') as output:
            os.chmod(temporary, 0o600)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(path)
        sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def sync_directory(path):
    descriptor = None
    try:
        descriptor = os.open(path, os.O_RDONLY)
        os.fsync(descriptor)
    except OSError as error:
        if os.name != 'nt' or error.errno not in (1, 13, 22):
            raise
    finally:
        if descriptor is not None:
            os.close(descriptor)


def durable_json(path, value):
    durable_bytes(path, canonical(value).encode('utf-8'))


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class Asset(StrictModel):
    id: str = Field(pattern=IMAGE_ID)
    sha256: str = Field(pattern=HEX)


class Placement(StrictModel):
    page: int = Field(ge=0)
    x: float = Field(ge=0, allow_inf_nan=False)
    y: float = Field(ge=0, allow_inf_nan=False)
    width: float = Field(gt=0, allow_inf_nan=False)
    height: float = Field(gt=0, allow_inf_nan=False)


class Spec(StrictModel):
    version: int = Field(ge=1, le=1)
    sourceSha256: str = Field(pattern=HEX)
    documentId: str = Field(min_length=36, max_length=36)
    orderId: str = Field(min_length=1, max_length=200)
    stamp: Asset | None
    signature: Asset | None
    placement: Placement | None
    signaturePlacement: Placement | None
    profile: Literal['light', 'standard', 'strong']
    dpi: int

    @model_validator(mode='after')
    def consistent(self):
        if not UUID_RE.fullmatch(self.documentId) or self.orderId != self.orderId.strip() or any(ord(c) < 32 for c in self.orderId):
            raise ValueError('Invalid document identity')
        if self.dpi not in (150, 200) or (self.stamp is None and self.signature is None):
            raise ValueError('Choose artwork and scan resolution')
        if (self.stamp is None) != (self.placement is None) or (self.signature is None) != (self.signaturePlacement is None):
            raise ValueError('Artwork requires its placement')
        return self


class WorkshopDocuments:
    def __init__(self, *, app, data, jobs, stamps, signatures, read_library, read_signatures,
                 run_pdf, storage_lock, ensure_storage, active, reservations,
                 max_upload, max_jobs, max_result, base_path):
        self.app, self.data, self.jobs = app, data, jobs
        self.directory = data / 'workshop-v1'
        self.stamps, self.signatures = stamps, signatures
        self.read_library, self.read_signatures = read_library, read_signatures
        self.run_pdf, self.lock, self.ensure_storage = run_pdf, storage_lock, ensure_storage
        self.active, self.reservations = active, reservations
        self.max_upload, self.max_jobs = max_upload, max_jobs
        self.max_result, self.base_path = min(max_result, 12 * 1024 * 1024), base_path
        self.tasks = {}

    def receipt_path(self, operation_id):
        if not UUID_RE.fullmatch(operation_id):
            raise HTTPException(422, 'Некорректный идентификатор операции.')
        return self.directory / (str(UUID(operation_id)) + '.json')

    async def startup(self):
        self.directory.mkdir(exist_ok=True, mode=0o700)
        sync_directory(self.data)
        for path in self.directory.glob('*.json'):
            if UUID_RE.fullmatch(path.stem):
                receipt = json.loads(path.read_text(encoding='utf-8'))
                if receipt['state'] == 'processing':
                    if receipt.get('publication'):
                        try:
                            self.publish(receipt)
                        except (OSError, ValueError, HTTPException):
                            self.fail(receipt, 'PUBLICATION_UNCONFIRMED')
                    else:
                        self.fail(receipt, 'INTERRUPTED')

    async def shutdown(self):
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    def fail(self, receipt, code):
        receipt.update(state='failed', error=code, updated=time.time())
        durable_json(self.receipt_path(receipt['operationId']), receipt)

    def artwork(self, kind, asset_id):
        reader = self.read_library if kind == 'stamp' else self.read_signatures
        folder = self.stamps if kind == 'stamp' else self.signatures
        item = next((value for value in reader()['items'] if value['id'] == asset_id), None)
        path = folder / (asset_id + '.png')
        if not item or not path.is_file() or path.stat().st_size > min(self.max_upload, 8 * 1024 * 1024):
            raise HTTPException(409, 'Выбранное изображение недоступно. Обновите справочник.')
        pixels = path.read_bytes()
        with Image.open(io.BytesIO(pixels)) as image:
            limit = 4096 if kind == 'stamp' else 8192
            if image.format != 'PNG' or not 16 <= min(image.size) or max(image.size) > limit or image.width * image.height > 16_000_000 or getattr(image, 'n_frames', 1) != 1:
                raise HTTPException(409, 'Изображение имеет неподдерживаемый формат.')
            aspect = image.height / image.width
        public = {'id': asset_id, 'name': item['name'], 'widthMm': item['width_mm'], 'aspect': aspect, 'sha256': sha(pixels)}
        if kind == 'stamp':
            public.update(companyName=item['company_name'], companyInn=item['company_inn'])
        else:
            public['signer'] = item.get('signer')
        public['revision'] = sha(canonical(public).encode('utf-8'))
        return public, pixels

    def catalog(self):
        return {'version': 1,
                'stamps': [self.artwork('stamp', item['id'])[0] for item in self.read_library()['items']],
                'signatures': [self.artwork('signature', item['id'])[0] for item in self.read_signatures()['items']]}

    def verify_artifacts(self, receipt):
        folder = self.jobs / receipt['jobId']
        if not folder.is_dir():
            raise ValueError('Deleted integration job')
        manifest = json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))
        if manifest.get('origin') != 'workshop-v1' or manifest.get('operationId') != receipt['operationId']:
            raise ValueError('Wrong integration job')
        spec = receipt['spec']
        if sha(canonical(spec).encode('utf-8')) != receipt['requestHash'] or file_sha(folder / 'input.pdf') != spec['sourceSha256']:
            raise ValueError('Changed integration source')
        for kind in ('stamp', 'signature'):
            if spec[kind]:
                image = folder / ('stamp.png' if kind == 'stamp' else 'signature-' + spec[kind]['id'] + '.png')
                if file_sha(image) != spec[kind]['sha256']:
                    raise ValueError('Changed frozen artwork')
        artifacts = receipt['publication']['artifacts']
        if len(artifacts) != 2 or {item['kind'] for item in artifacts} != {'stamped', 'scan'}:
            raise ValueError('Incomplete artifact pair')
        for artifact in artifacts:
            if artifact['id'] != receipt['artifactIds'][artifact['kind']] or not 0 < artifact['size'] <= self.max_result:
                raise ValueError('Wrong artifact identity')
            path = folder / 'results' / (artifact['id'] + '.pdf')
            if not path.is_file() or path.stat().st_size != artifact['size'] or file_sha(path) != artifact['sha256']:
                raise ValueError('Missing or changed artifact')

    def publish(self, receipt):
        self.verify_artifacts(receipt)
        manifest_path = self.jobs / receipt['jobId'] / 'manifest.json'
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        if manifest.get('origin') != 'workshop-v1' or manifest.get('operationId') != receipt['operationId']:
            raise ValueError('Wrong integration job')
        manifest.update(receipt['publication']['manifest'])
        durable_json(manifest_path, manifest)
        receipt.update(state='completed', updated=time.time())
        receipt.pop('error', None)
        durable_json(self.receipt_path(receipt['operationId']), receipt)

    def status(self, operation_id):
        path = self.receipt_path(operation_id)
        if not path.is_file():
            raise HTTPException(404, 'Операция не найдена.')
        receipt = json.loads(path.read_text(encoding='utf-8'))
        if receipt['state'] == 'processing' and receipt.get('publication') and receipt['operationId'] not in self.tasks:
            try:
                self.publish(receipt)
            except (OSError, ValueError, HTTPException):
                self.fail(receipt, 'PUBLICATION_UNCONFIRMED')
        if receipt['state'] == 'completed':
            try:
                self.verify_artifacts(receipt)
            except (OSError, ValueError):
                self.fail(receipt, 'ARTIFACT_MISSING')
        return self.response(receipt)

    @staticmethod
    def response(receipt):
        result = {key: receipt[key] for key in ('state', 'operationId', 'jobId', 'requestHash', 'spec', 'sourceSha256')}
        if receipt['state'] == 'completed':
            result['artifacts'] = receipt['publication']['artifacts']
        if receipt['state'] == 'failed':
            result['error'] = receipt.get('error', 'PROCESSING_FAILED')
        return result

    async def submit(self, operation_id, request):
        operation_id = str(UUID(operation_id)) if UUID_RE.fullmatch(operation_id) else operation_id
        path = self.receipt_path(operation_id)
        incoming = self.directory / ('incoming-' + secrets.token_hex(16))
        folder = None
        reservation_id = 'workshop-upload-' + secrets.token_hex(16)
        reservation = self.max_upload + 16 * 1024 * 1024 + self.max_result * 3 + 65536
        replay = path.is_file()
        if not replay:
            async with self.lock:
                self.ensure_storage(reservation)
                self.reservations[reservation_id] = reservation
        try:
            async with request.form(max_files=1, max_fields=1, max_part_size=min(self.max_upload, 16384)) as form:
                if len(form.multi_items()) != 2 or set(form.keys()) != {'file', 'spec'} or not hasattr(form['file'], 'read') or not isinstance(form['spec'], str) or len(form['spec']) > 16384:
                    raise HTTPException(422, 'Передайте PDF и описание операции.')
                try:
                    spec = Spec.model_validate_json(form['spec']).model_dump()
                except ValidationError:
                    raise HTTPException(422, 'Проверьте параметры операции и координаты.') from None
                size = 0
                source_digest = hashlib.sha256()
                header = b''
                with nullcontext(None) if replay else incoming.open('xb') as output:
                    if output:
                        os.chmod(incoming, 0o600)
                    while chunk := await form['file'].read(1024 * 1024):
                        size += len(chunk)
                        if size > self.max_upload:
                            raise HTTPException(413, 'Исходный PDF слишком большой.')
                        source_digest.update(chunk)
                        if not header:
                            header = chunk[:8]
                        if output:
                            output.write(chunk)
                    if output:
                        output.flush(); os.fsync(output.fileno())
                if not size or not header.startswith(b'%PDF-') or source_digest.hexdigest() != spec['sourceSha256']:
                    raise HTTPException(422, 'SHA256 исходного PDF не совпадает.')
            request_hash = sha(canonical(spec).encode('utf-8'))
            async with self.lock:
                if path.is_file():
                    receipt = json.loads(path.read_text(encoding='utf-8'))
                    if receipt['requestHash'] != request_hash:
                        raise HTTPException(409, 'Эта операция уже использована с другими параметрами.')
                    result = self.status(operation_id)
                    return JSONResponse(result, status_code=202 if result['state'] == 'processing' else 200)
                if self.tasks or self.app.state.pdf_slot.locked():
                    raise HTTPException(429, 'Обрабатывается другой документ. Повторите позже.')
                if sum(folder.is_dir() for folder in self.jobs.iterdir()) >= self.max_jobs:
                    raise HTTPException(429, 'Достигнут лимит документов.')
                frozen = []
                for kind, asset_key, placement_key in [('stamp', 'stamp', 'placement'), ('signature', 'signature', 'signaturePlacement')]:
                    if spec[asset_key] is None:
                        continue
                    item, pixels = self.artwork(kind, spec[asset_key]['id'])
                    placement = spec[placement_key]
                    low, high = (20, 60) if kind == 'stamp' else (10, 100)
                    if item['sha256'] != spec[asset_key]['sha256']:
                        raise HTTPException(409, 'Изображение изменилось. Обновите справочник.')
                    if not low * 72 / 25.4 <= placement['width'] <= high * 72 / 25.4 or abs((placement['height'] / placement['width']) / item['aspect'] - 1) > .001:
                        raise HTTPException(422, 'Проверьте размер и пропорции изображения.')
                    frozen.append((kind, item, pixels, placement))
                job_id = secrets.token_hex(16)
                folder = self.jobs / job_id
                folder.mkdir(mode=0o700)
                sync_directory(self.jobs)
                (folder / 'results').mkdir(mode=0o700)
                incoming.replace(folder / 'input.pdf')
                for kind, item, pixels, _ in frozen:
                    durable_bytes(folder / ('stamp.png' if kind == 'stamp' else 'signature-' + item['id'] + '.png'), pixels)
                now = time.time()
                manifest = {'id': job_id, 'origin': 'workshop-v1', 'operationId': operation_id, 'filename': 'document-' + spec['documentId'] + '.pdf', 'created': now,
                            'pages': [], 'source_type': 'pdf', 'source_path': 'input.pdf', 'size': size, 'page_count': 0,
                            'results': [], 'status': 'processing', 'signature_snapshots': {}, 'readonly': True,
                            'stamp_aspect': 1.0, 'width_mm': 35.6, 'stamp_enabled': False,
                            'signature_enabled': False, 'candidates': [], 'auto_candidate_index': None}
                for kind, item, _, placement in frozen:
                    if kind == 'stamp':
                        manifest.update(stamp_id=item['id'], stamp_name=item['name'], stamp_sha256=item['sha256'], stamp_aspect=item['aspect'], width_mm=item['widthMm'], placement=placement)
                    else:
                        manifest.update(signature_id=item['id'], signature_name=item['name'], signature_aspect=item['aspect'], signature_placement=placement,
                                        signature_snapshots={item['id']: {'id': item['id'], 'sha256': item['sha256']}})
                receipt = {'version': 1, 'operationId': operation_id, 'jobId': job_id, 'requestHash': request_hash,
                           'sourceSha256': spec['sourceSha256'], 'spec': spec, 'state': 'processing', 'created': now,
                           'artifactIds': {'stamped': secrets.token_hex(16), 'scan': secrets.token_hex(16)}}
                durable_json(folder / 'manifest.json', manifest)
                durable_json(path, receipt)
                self.active.add(job_id)
                self.reservations[operation_id] = reservation
                task = asyncio.create_task(self.process(receipt, frozen))
                self.tasks[operation_id] = task
                task.add_done_callback(lambda _: self.tasks.pop(operation_id, None))
                return JSONResponse(self.response(receipt), status_code=202)
        finally:
            incoming.unlink(missing_ok=True)
            self.reservations.pop(reservation_id, None)
            if folder is not None and not path.is_file():
                shutil.rmtree(folder)
                sync_directory(self.jobs)

    async def process(self, receipt, frozen):
        folder = self.jobs / receipt['jobId']
        try:
            spec = receipt['spec']
            outputs = {kind: folder / 'results' / (artifact_id + '.pdf') for kind, artifact_id in receipt['artifactIds'].items()}
            overlays = [{'kind': kind, 'image_path': str(folder / ('stamp.png' if kind == 'stamp' else 'signature-' + item['id'] + '.png')), 'placement': placement}
                        for kind, item, _, placement in frozen]
            report = await self.run_pdf('compose_scan', pdf_path=str(folder / 'input.pdf'), composed_path=str(outputs['stamped']), output_path=str(outputs['scan']), overlays=overlays,
                                        profile=spec['profile'], dpi=spec['dpi'], seed=int(receipt['requestHash'][:16], 16), _work_dir=str(folder / 'results'), _file_limit=self.max_result)
            if report['source_sha256'] != spec['sourceSha256'] or len(report['overlays']) != len(frozen):
                raise ValueError('Source provenance mismatch')
            for actual, (kind, item, _, placement) in zip(report['overlays'], frozen):
                if actual['kind'] != kind or actual['image_sha256'] != item['sha256'] or actual['placement'] != placement:
                    raise ValueError('Artwork provenance mismatch')
            artifacts, results = [], []
            for kind in ('stamped', 'scan'):
                path = outputs[kind]
                actual_hash = await asyncio.to_thread(file_sha, path)
                expected = report['composed_sha256'] if kind == 'stamped' else report['output_sha256']
                if not 0 < path.stat().st_size <= self.max_result or actual_hash != expected:
                    raise ValueError('Output integrity mismatch')
                await asyncio.to_thread(sync_file, path)
                artifact_id = receipt['artifactIds'][kind]
                artifact = {'id': artifact_id, 'kind': kind, 'sha256': actual_hash, 'size': path.stat().st_size,
                            'url': self.base_path + f'/api/documents/{receipt["jobId"]}/results/{artifact_id}'}
                artifacts.append(artifact)
                results.append({**artifact, 'kind': 'composed' if kind == 'stamped' else 'scan', 'filename': 'document-' + spec['documentId'] + '-' + kind + '.pdf',
                                'created': time.time(), 'source_sha256': spec['sourceSha256'], 'overlays': report['overlays'], 'simulated_scan': kind == 'scan'})
            publication = {'artifacts': artifacts, 'manifest': {'results': results, 'status': 'completed', 'pages': report['page_dimensions'], 'page_count': report['pages']}}
            sync_directory(folder / 'results')
            receipt['publication'] = publication
            durable_json(self.receipt_path(receipt['operationId']), receipt)
            async with self.lock:
                self.publish(receipt)
        except asyncio.CancelledError:
            if not receipt.get('publication'):
                self.fail(receipt, 'INTERRUPTED')
            raise
        except (HTTPException, OSError, ValueError, KeyError):
            if not receipt.get('publication'):
                self.fail(receipt, 'PROCESSING_FAILED')
        finally:
            self.active.discard(receipt['jobId'])
            self.reservations.pop(receipt['operationId'], None)


def register_workshop_documents(app, **options):
    service = WorkshopDocuments(app=app, **options)
    app.state.workshop_documents = service

    @app.get('/api/workshop/v1/library')
    async def library():
        return await asyncio.to_thread(service.catalog)

    @app.post('/api/workshop/v1/documents/{operation_id}')
    async def submit(operation_id: str, request: Request):
        return await service.submit(operation_id, request)

    @app.get('/api/workshop/v1/documents/{operation_id}')
    async def status(operation_id: str):
        return await asyncio.to_thread(service.status, operation_id)

    return service
