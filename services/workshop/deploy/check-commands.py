"""Read-only gate after draining/stopping the writer; never repair or discard a receipt."""
import json
import pathlib
import sqlite3
import sys

data = pathlib.Path(sys.argv[1]).resolve()
db = sqlite3.connect((data / 'finance.sqlite3').as_uri() + '?mode=ro', uri=True)
try:
    media_index = data / 'orders' / 'media' / 'index.json'
    if len(sys.argv) > 2 and media_index.is_file():
        records = json.loads(media_index.read_text()).get('records', [])
        if any(r.get('contentType') == 'application/vnd.corel-draw' or r.get('source') for r in records):
            manifest = pathlib.Path(sys.argv[2]) / 'server' / 'release-capabilities.json'
            assert manifest.is_file() and json.loads(manifest.read_text()).get('mailCorelMedia') == 1, 'TARGET_CANNOT_READ_MAIL_COREL_MEDIA'
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert 'transactions' in tables, 'MISSING_TECHNICAL_DATABASE'
    assert db.execute('SELECT count(*) FROM transactions WHERE pending=1').fetchone()[0] == 0, 'LEGACY_PENDING_COMMANDS'
    if 'finance_commands' in tables:
        assert db.execute("SELECT count(*) FROM finance_commands WHERE state NOT IN ('confirmed','rejected')").fetchone()[0] == 0, 'UNCONFIRMED_FINANCE_COMMANDS'
    if 'finance_commands' in tables and len(sys.argv) > 2:
        measurements = any(json.loads(r[0]).get('category') == 'Замеры' for r in db.execute(
            "SELECT input_json FROM finance_commands WHERE state != 'rejected'"))
        if measurements:
            manifest = pathlib.Path(sys.argv[2]) / 'server' / 'release-capabilities.json'
            assert manifest.is_file() and json.loads(manifest.read_text()).get('measurementIncome') == 1, 'TARGET_CANNOT_READ_MEASUREMENT_INCOME'
    if 'warehouse_refills' in tables:
        assert db.execute("SELECT count(*) FROM warehouse_refills WHERE state NOT IN ('confirmed','rejected')").fetchone()[0] == 0, 'UNCONFIRMED_WAREHOUSE_REFILLS'
        # Even confirmed receipts may still have a retry waiting in a browser.
        if len(sys.argv) > 2 and db.execute('SELECT count(*) FROM warehouse_refills').fetchone()[0]:
            manifest = pathlib.Path(sys.argv[2]) / 'server' / 'release-capabilities.json'
            assert manifest.is_file(), 'TARGET_CANNOT_REPLAY_WAREHOUSE_REFILLS'
            assert json.loads(manifest.read_text()).get('warehouseRefillReceipts') == 1, 'TARGET_CANNOT_REPLAY_WAREHOUSE_REFILLS'
    if 'max_order_notes' in tables:
        assert db.execute("SELECT count(*) FROM max_order_notes WHERE state IN ('writing','uncertain')").fetchone()[0] == 0, 'UNCONFIRMED_MAX_ORDER_NOTES'
        if len(sys.argv) > 2 and db.execute('SELECT count(*) FROM max_order_notes').fetchone()[0]:
            manifest = pathlib.Path(sys.argv[2]) / 'server' / 'release-capabilities.json'
            assert manifest.is_file() and json.loads(manifest.read_text()).get('maxOrderNoteReceipts') == 1, 'TARGET_CANNOT_REPLAY_MAX_ORDER_NOTES'
    if 'production_v2_commands' in tables:
        assert db.execute("SELECT count(*) FROM production_v2_commands WHERE state='pending'").fetchone()[0] == 0, 'UNCONFIRMED_PRODUCTION_COMMANDS'
        if len(sys.argv) > 2 and db.execute('SELECT count(*) FROM production_v2_commands').fetchone()[0]:
            manifest = pathlib.Path(sys.argv[2]) / 'server' / 'release-capabilities.json'
            assert manifest.is_file() and json.loads(manifest.read_text()).get('productionV2') == 1, 'TARGET_CANNOT_READ_PRODUCTION_V2'
    for folder in ['creation', 'client-creation', 'position-creation']:
        directory = data / 'orders' / folder
        for file in directory.glob('*.json'):
            receipt = json.loads(file.read_text())
            assert receipt.get('state') in ['verified', 'aborted'], 'UNCONFIRMED_ORDER_COMMANDS'
    document_receipts = list((data / 'orders' / 'documents').glob('*.json'))
    for file in document_receipts:
        receipt = json.loads(file.read_text())
        assert receipt.get('state') in ['verified', 'aborted'], 'UNCONFIRMED_DOCUMENT_COMMANDS'
    generated = media_index.is_file() and any(r.get('generatedDocument') for r in json.loads(media_index.read_text()).get('records', []))
    stamp_receipts = list((data / 'orders' / 'document-stamps').glob('*.json'))
    for file in stamp_receipts:
        receipt = json.loads(file.read_text())
        assert receipt.get('state') in ['prepared', 'processing', 'completed', 'verified', 'failed'], 'UNCONFIRMED_DOCUMENT_STAMP_FILES'
    decorated = media_index.is_file() and any(r.get('generatedDocument', {}).get('decoration') for r in json.loads(media_index.read_text()).get('records', []))
    if len(sys.argv) > 2 and (stamp_receipts or decorated):
        manifest = pathlib.Path(sys.argv[2]) / 'server' / 'release-capabilities.json'
        assert manifest.is_file() and json.loads(manifest.read_text()).get('orderDocumentStamps') == 1, 'TARGET_CANNOT_REPLAY_ORDER_DOCUMENT_STAMPS'
    if len(sys.argv) > 2 and (generated or any(json.loads(file.read_text()).get('type') == 'document' for file in document_receipts)):
        manifest = pathlib.Path(sys.argv[2]) / 'server' / 'release-capabilities.json'
        assert manifest.is_file() and json.loads(manifest.read_text()).get('orderDocuments') == 1, 'TARGET_CANNOT_REPLAY_ORDER_DOCUMENTS'
finally:
    db.close()
print('Command gate: clear')
