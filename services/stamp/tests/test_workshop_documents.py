"""Workshop integration QA: synthetic geometry and identities only."""
import asyncio
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
from uuid import uuid4

import fitz
from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from app.main import create_app
from app import pdf_engine
from app import workshop_documents


def artwork(size=(120, 120), color=(20, 70, 180, 180)):
    output = io.BytesIO()
    with Image.new('RGBA', size, (0, 0, 0, 0)) as image:
        draw = ImageDraw.Draw(image)
        draw.rectangle((8, 8, 22, 22), fill=color)
        draw.line((8, size[1] // 2, size[0] - 8, size[1] // 2), fill=color, width=5)
        image.save(output, format='PNG')
    return output.getvalue()


def document(pages=2):
    with fitz.open() as pdf:
        for index in range(pages):
            page = pdf.new_page(width=595, height=842)
            page.insert_text((36, 60), 'SYNTHETIC WORKSHOP PAGE ' + str(index + 1))
        return pdf.tobytes()


class WorkshopDocumentAPI(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'stamp.png').write_bytes(artwork())
        (self.root / 'settings.json').write_text(json.dumps({'company_inn': '9900000017', 'company_name': 'SYNTHETIC COMPANY', 'width_mm': 35.6}), encoding='utf-8')
        (self.root / 'signatures').mkdir()
        self.signature_id = 'b' * 32
        pixels = artwork((400, 80), (160, 25, 40, 180))
        (self.root / 'signatures' / (self.signature_id + '.png')).write_bytes(pixels)
        (self.root / 'signatures.json').write_text(json.dumps({'active_id': self.signature_id, 'items': [
            {'id': self.signature_id, 'name': 'SYNTHETIC LINE', 'signer': 'Test T. T.', 'width_mm': 60, 'aspect': .2, 'sha256': hashlib.sha256(pixels).hexdigest(), 'created': 1}]}), encoding='utf-8')
        self.environment = patch.dict(os.environ, {'AUTH_MODE': 'password', 'APP_USERNAME': 'admin', 'APP_PASSWORD': 'test-password-not-for-production', 'APP_BASE_PATH': '',
                                                   'MAX_UPLOAD_MB': '25', 'MAX_TOTAL_MB': '500', 'MAX_RESULT_MB': '100', 'MAX_JOBS': '100', 'MAX_PAGES': '50'})
        self.environment.start()
        self.client = self.open_client()
        self.source = document()

    def open_client(self):
        self.app = create_app(self.root)
        client = TestClient(self.app)
        client.__enter__()
        login = client.post('/api/login', json={'username': 'admin', 'password': 'test-password-not-for-production'})
        self.assertEqual(login.status_code, 200, login.text)
        client.headers['X-CSRF-Token'] = login.json()['csrf']
        return client

    def restart(self):
        self.client.__exit__(None, None, None)
        self.client = self.open_client()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.environment.stop()
        self.temp.cleanup()

    def spec(self):
        catalog = self.client.get('/api/workshop/v1/library').json()
        return {'version': 1, 'sourceSha256': hashlib.sha256(self.source).hexdigest(), 'documentId': str(uuid4()), 'orderId': 'SYNTHETIC-9001',
                'stamp': {key: catalog['stamps'][0][key] for key in ('id', 'sha256')},
                'signature': {key: catalog['signatures'][0][key] for key in ('id', 'sha256')},
                'placement': {'page': 0, 'x': 400, 'y': 610, 'width': 85, 'height': 85},
                'signaturePlacement': {'page': 1, 'x': 70, 'y': 650, 'width': 150, 'height': 30}, 'profile': 'light', 'dpi': 150}

    def submit(self, operation, spec, source=None):
        return self.client.post('/api/workshop/v1/documents/' + operation, data={'spec': json.dumps(spec)}, files={'file': ('synthetic.pdf', self.source if source is None else source, 'application/pdf')})

    def status(self, operation):
        response = self.client.get('/api/workshop/v1/documents/' + operation)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def wait(self, operation):
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            result = self.status(operation)
            if result['state'] != 'processing':
                return result
            time.sleep(.05)
        self.fail('Synthetic operation did not finish within its deadline')

    def test_catalog_hashes_actual_artwork_without_changing_global_active_assets(self):
        before_stamp = (self.root / 'stamps.json').read_bytes()
        before_signature = (self.root / 'signatures.json').read_bytes()
        catalog = self.client.get('/api/workshop/v1/library')
        self.assertEqual(catalog.status_code, 200)
        body = catalog.json()
        self.assertEqual(body['version'], 1)
        for kind, folder in [('stamps', 'stamps'), ('signatures', 'signatures')]:
            for item in body[kind]:
                self.assertEqual(item['sha256'], hashlib.sha256((self.root / folder / (item['id'] + '.png')).read_bytes()).hexdigest())
                self.assertRegex(item['revision'], '^[a-f0-9]{64}$')
        self.assertEqual((self.root / 'stamps.json').read_bytes(), before_stamp)
        self.assertEqual((self.root / 'signatures.json').read_bytes(), before_signature)

    def test_real_worker_composes_and_scans_once_with_page_geometry_and_replays_exact_bytes_after_restart(self):
        spec, operation = self.spec(), str(uuid4())
        accepted = self.submit(operation, spec)
        self.assertEqual(accepted.status_code, 202, accepted.text)
        self.assertEqual(accepted.json()['state'], 'processing')
        completed = self.wait(operation)
        self.assertEqual(completed['state'], 'completed', completed)
        self.assertEqual(completed['spec'], spec)
        self.assertEqual(completed['sourceSha256'], spec['sourceSha256'])
        originals = {}
        for artifact in completed['artifacts']:
            response = self.client.get(artifact['url'])
            self.assertEqual(response.status_code, 200)
            self.assertEqual(hashlib.sha256(response.content).hexdigest(), artifact['sha256'])
            self.assertEqual(len(response.content), artifact['size'])
            originals[artifact['kind']] = response.content
        with fitz.open(stream=originals['stamped'], filetype='pdf') as stamped, fitz.open(stream=originals['scan'], filetype='pdf') as scanned:
            self.assertEqual(len(stamped), 2); self.assertEqual(len(scanned), 2)
            self.assertEqual([len(page.get_images()) for page in stamped], [1, 1])
            self.assertTrue(all('SYNTHETIC' in page.get_text() for page in stamped))
            self.assertTrue(all(not page.get_text().strip() for page in scanned))
        replay = self.submit(operation, spec)
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.json(), completed)
        self.restart()
        self.assertEqual(self.status(operation), completed)
        self.assertEqual(self.submit(operation, spec).json(), completed)
        for artifact in completed['artifacts']:
            self.assertEqual(self.client.get(artifact['url']).content, originals[artifact['kind']])
        folder = self.root / 'jobs' / completed['jobId']
        self.assertEqual(len(list((folder / 'results').glob('*.pdf'))), 2)
        self.assertEqual((folder / 'input.pdf').read_bytes(), self.source)

    def test_integration_jobs_reject_all_legacy_mutations_while_regular_upload_remains_mutable(self):
        spec, operation = self.spec(), str(uuid4())
        self.assertEqual(self.submit(operation, spec).status_code, 202)
        result = self.wait(operation)
        self.assertEqual(result['state'], 'completed')
        base = '/api/documents/' + result['jobId']
        for endpoint, body in [('/signature', {'signature_id': None}), ('/stamp', spec['placement']), ('/scan', {'placement': spec['placement']}), ('/compose', {'placement': spec['placement']}), ('/compose-scan', {'placement': spec['placement']})]:
            self.assertEqual(self.client.post(base + endpoint, json=body).status_code, 409, endpoint)
        self.assertEqual(self.client.delete(base).status_code, 409)
        ordinary = self.client.post('/api/documents', files={'file': ('ordinary.pdf', self.source, 'application/pdf')})
        self.assertEqual(ordinary.status_code, 200, ordinary.text)
        self.assertEqual(self.client.delete('/api/documents/' + ordinary.json()['id']).status_code, 200)

    def test_authentication_and_csrf_guard_new_routes_before_creating_operations(self):
        spec, operation = self.spec(), str(uuid4())
        csrf = self.client.headers.pop('X-CSRF-Token')
        self.assertEqual(self.submit(operation, spec).status_code, 403)
        self.client.headers['X-CSRF-Token'] = csrf
        self.client.cookies.clear()
        self.assertEqual(self.client.get('/api/workshop/v1/library').status_code, 401)
        self.assertEqual(self.client.get('/api/workshop/v1/documents/' + operation).status_code, 401)
        self.assertEqual(self.submit(operation, spec).status_code, 401)
        self.assertEqual(list((self.root / 'workshop-v1').glob('*.json')), [])

    def test_invalid_source_spec_and_template_hashes_are_rejected_without_creating_jobs(self):
        base = self.spec()
        for patch_fields in [{'sourceSha256': '0' * 64}, {'unexpected': True}, {'dpi': True}, {'version': True}, {'stamp': {**base['stamp'], 'sha256': '0' * 64}}, {'placement': {**base['placement'], 'page': True}}]:
            response = self.submit(str(uuid4()), {**base, **patch_fields})
            self.assertIn(response.status_code, (409, 422), response.text)
        self.assertEqual(list((self.root / 'workshop-v1').glob('*.json')), [])
        self.assertEqual(list((self.root / 'jobs').iterdir()), [])

    def test_frozen_explicit_assets_survive_library_file_changes_after_acceptance(self):
        spec, operation = self.spec(), str(uuid4())
        self.assertEqual(self.submit(operation, spec).status_code, 202)
        (self.root / 'stamps' / (spec['stamp']['id'] + '.png')).write_bytes(artwork(color=(180, 20, 10, 200)))
        (self.root / 'signatures' / (spec['signature']['id'] + '.png')).unlink()
        completed = self.wait(operation)
        self.assertEqual(completed['state'], 'completed', completed)
        folder = self.root / 'jobs' / completed['jobId']
        self.assertEqual(hashlib.sha256((folder / 'stamp.png').read_bytes()).hexdigest(), spec['stamp']['sha256'])
        self.assertEqual(self.submit(operation, spec).json(), completed, 'Replay never re-resolves global library assets')

    def test_bounded_processing_conflicts_and_interrupted_restart_never_regenerate_scan(self):
        async def hold(*args, **kwargs):
            await asyncio.sleep(60)
        self.app.state.workshop_documents.run_pdf = hold
        spec, operation = self.spec(), str(uuid4())
        accepted = self.submit(operation, spec).json()
        self.assertEqual(self.submit(operation, spec).json()['jobId'], accepted['jobId'])
        self.assertEqual(self.submit(operation, {**spec, 'profile': 'strong'}).status_code, 409)
        self.assertEqual(self.submit(str(uuid4()), spec).status_code, 429)
        self.restart()
        status = self.status(operation)
        self.assertEqual(status['state'], 'failed'); self.assertEqual(status['error'], 'INTERRUPTED')
        self.assertEqual(self.submit(operation, spec).json(), status)
        self.assertEqual(list((self.root / 'jobs' / status['jobId'] / 'results').glob('*.pdf')), [])

    def test_interrupted_publication_recovers_existing_verified_bytes_after_restart(self):
        service = self.app.state.workshop_documents
        def interrupted(receipt):
            raise OSError('Synthetic publication interruption')
        service.publish = interrupted
        spec, operation = self.spec(), str(uuid4())
        self.assertEqual(self.submit(operation, spec).status_code, 202)
        receipt_path = self.root / 'workshop-v1' / (operation + '.json')
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
            if receipt.get('publication'):
                break
            time.sleep(.05)
        self.assertIn('publication', receipt)
        hashes = [item['sha256'] for item in receipt['publication']['artifacts']]
        self.restart()
        completed = self.status(operation)
        self.assertEqual(completed['state'], 'completed', completed)
        self.assertEqual([item['sha256'] for item in completed['artifacts']], hashes)

    def test_partial_engine_failure_keeps_proof_but_never_retries_or_publishes_a_partial_result(self):
        async def partial(operation, **args):
            pdf_engine.compose_pdf(args['pdf_path'], args['composed_path'], args['overlays'])
            raise HTTPException(422, 'Synthetic scan interruption')
        self.app.state.workshop_documents.run_pdf = partial
        spec, operation = self.spec(), str(uuid4())
        self.assertEqual(self.submit(operation, spec).status_code, 202)
        failed = self.wait(operation)
        self.assertEqual(failed['state'], 'failed')
        folder = self.root / 'jobs' / failed['jobId']
        self.assertEqual(len(list((folder / 'results').glob('*.pdf'))), 1)
        self.assertEqual(self.client.get('/api/documents/' + failed['jobId']).json()['results'], [])
        self.restart()
        self.assertEqual(self.submit(operation, spec).json(), failed)
        self.assertEqual(len(list((folder / 'results').glob('*.pdf'))), 1)

    def test_missing_published_artifact_becomes_a_durable_failed_tombstone_without_regeneration(self):
        spec, operation = self.spec(), str(uuid4())
        self.assertEqual(self.submit(operation, spec).status_code, 202)
        completed = self.wait(operation)
        folder = self.root / 'jobs' / completed['jobId'] / 'results'
        (folder / (completed['artifacts'][1]['id'] + '.pdf')).unlink()
        failed = self.status(operation)
        self.assertEqual(failed['state'], 'failed'); self.assertEqual(failed['error'], 'ARTIFACT_MISSING')
        self.restart()
        self.assertEqual(self.submit(operation, spec).json(), failed)
        self.assertEqual(len(list(folder.glob('*.pdf'))), 1)

    def test_accepted_replay_remains_available_when_capacity_is_full(self):
        spec, operation = self.spec(), str(uuid4())
        self.assertEqual(self.submit(operation, spec).status_code, 202)
        completed = self.wait(operation)
        with patch.object(self.app.state.workshop_documents, 'ensure_storage', side_effect=HTTPException(429, 'Synthetic full disk')):
            self.assertEqual(self.submit(operation, spec).json(), completed)
            self.assertEqual(self.submit(str(uuid4()), spec).status_code, 429)
        self.assertFalse(list((self.root / 'workshop-v1').glob('incoming-*')))

    def test_both_output_files_are_synced_before_durable_publication_proof(self):
        events = []
        original_sync = workshop_documents.sync_file
        original_write = workshop_documents.durable_json
        def sync_output(path):
            original_sync(path)
            events.append(('synced', Path(path).stem))
        def write_json(path, value):
            if value.get('publication') and value['state'] == 'processing':
                expected = [('synced', value['artifactIds'][kind]) for kind in ('stamped', 'scan')]
                self.assertEqual(events, expected, 'Both file contents must reach fsync before the publication receipt')
                events.append(('proof', None))
            original_write(path, value)
        spec, operation = self.spec(), str(uuid4())
        with patch.object(workshop_documents, 'sync_file', side_effect=sync_output), patch.object(workshop_documents, 'durable_json', side_effect=write_json):
            self.assertEqual(self.submit(operation, spec).status_code, 202)
            self.assertEqual(self.wait(operation)['state'], 'completed')
        self.assertEqual([event[0] for event in events], ['synced', 'synced', 'proof'])

    def test_durable_publication_proof_cannot_publish_after_frozen_source_is_changed(self):
        service = self.app.state.workshop_documents
        with patch.object(service, 'publish', side_effect=OSError('Synthetic publication interruption')):
            spec, operation = self.spec(), str(uuid4())
            self.assertEqual(self.submit(operation, spec).status_code, 202)
            path = self.root / 'workshop-v1' / (operation + '.json')
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                receipt = json.loads(path.read_text(encoding='utf-8'))
                if receipt.get('publication'):
                    break
                time.sleep(.05)
            self.assertIn('publication', receipt)
            folder = self.root / 'jobs' / receipt['jobId']
            (folder / 'input.pdf').write_bytes(document(1))
        self.restart()
        failed = self.status(operation)
        self.assertEqual(failed['state'], 'failed')
        self.assertEqual(failed['error'], 'PUBLICATION_UNCONFIRMED')
        self.assertEqual(self.submit(operation, spec).json(), failed)
        self.assertEqual(self.client.get('/api/documents/' + failed['jobId']).json()['results'], [])
        self.assertEqual(len(list((folder / 'results').glob('*.pdf'))), 2)
