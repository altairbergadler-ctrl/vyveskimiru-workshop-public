import test from 'node:test';
import assert from 'node:assert/strict';
import { DOCUMENT_TABLES, digest, documentColumn, documentWrite, isDocumentSheetWrite, nextDocumentRow, prepareDocumentSheets, readDocumentTables, validateDocumentSheetWrite } from './document-sheets.mjs';
import { validateSnapshot, SHEETS_SCHEMA } from './sheets-guard.mjs';
import { fixtures } from '../qa/fixtures.mjs';

const SELLER = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const DOCUMENT = '33333333-3333-4333-8333-333333333333';
const REQUEST = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-10-21T12:00:00.000Z';
const denied = error => error?.code === 'SHEETS_CONTRACT_DOCUMENTS';
const def = name => DOCUMENT_TABLES.find(table => table.name === name);
const sellerRow = () => [SELLER, 'Учебный продавец', 'ООО «Учебный продавец»', '9900990015', '990001001', '', 'Вымышленный адрес', 'Образцов Т. Т.', 'Директор', 'none', true, digest('synthetic seller revision'), NOW, '{}'];
const accountRow = () => [ACCOUNT, SELLER, 'Учебный счёт', 'Вымышленный банк', '019999999', '40702810000000000001', '30101810000000000001', true, digest('synthetic account revision'), NOW];
function documentRow(patch = {}) {
  const snapshot = JSON.stringify({ version: 1, type: 'invoice', number: 'TEST-001', date: '2026-10-21', orderId: 'TEST-9001', seller: { id: SELLER, name: 'Учебный продавец', vat: 'none' }, total: 100, amountDue: 50 });
  return Object.assign([DOCUMENT, 'TEST-9001', 'invoice', 'TEST-001', '2026-10-21', SELLER, ACCOUNT, 1, 'prepared', snapshot, digest(snapshot), '', '', NOW, REQUEST, digest('synthetic request'), true, NOW], patch);
}

class DocumentSheetsFixture {
  constructor({ present = true, seeded = true } = {}) {
    this.metadata = { sheets: [{ properties: { title: 'Existing core sheet', sheetId: 17, gridProperties: { rowCount: 1001, columnCount: 30 } } }] };
    this.data = {};
    this.requests = [];
    this.batches = [];
    if (present) for (const table of DOCUMENT_TABLES) {
      this.metadata.sheets.push({ properties: { title: table.name, sheetId: table.id, gridProperties: { rowCount: table.capacity, columnCount: table.headers.length } } });
      this.data[table.name] = [structuredClone(table.headers)];
    }
    if (present && seeded) {
      this.data['Продавцы'].push(sellerRow());
      this.data['Счета продавцов'].push(accountRow());
    }
  }
  async getSpreadsheet() { return structuredClone(this.metadata); }
  async getRanges(ranges, options) {
    assert.equal(options.valueRenderOption, 'UNFORMATTED_VALUE');
    return { valueRanges: ranges.map(range => ({ range, values: structuredClone(this.data[/^'([^']+)'!/.exec(range)[1]] || []) })) };
  }
  rawRequest = async (requestPath, options) => {
    assert.equal(options, undefined, 'Preflight issues reads only');
    this.requests.push(requestPath);
    if (requestPath.startsWith('?fields=')) return this.getSpreadsheet();
    assert.ok(requestPath.startsWith('/values:batchGet?'));
    const params = new URLSearchParams(requestPath.slice(requestPath.indexOf('?') + 1));
    return this.getRanges(params.getAll('ranges'), { valueRenderOption: params.get('valueRenderOption') });
  };
  async batchUpdate(requests) {
    this.batches.push(structuredClone(requests));
    const metadata = structuredClone(this.metadata);
    const data = structuredClone(this.data);
    for (const request of requests) {
      if (request.addSheet) {
        const properties = structuredClone(request.addSheet.properties);
        assert.ok(!metadata.sheets.some(sheet => sheet.properties.title === properties.title || sheet.properties.sheetId === properties.sheetId));
        metadata.sheets.push({ properties }); data[properties.title] = [];
      } else if (request.updateCells) {
        const update = request.updateCells;
        const name = metadata.sheets.find(sheet => sheet.properties.sheetId === update.start.sheetId).properties.title;
        assert.equal(update.fields, 'userEnteredValue');
        assert.equal(update.start.rowIndex, 0); assert.equal(update.start.columnIndex, 0);
        data[name] = update.rows.map(row => row.values.map(cell => {
          const entered = cell.userEnteredValue;
          assert.ok(!Object.hasOwn(entered, 'formulaValue'));
          return entered.stringValue ?? entered.numberValue ?? entered.boolValue;
        }));
      } else {
        assert.ok(request.addProtectedRange?.protectedRange.warningOnly);
      }
    }
    this.metadata = metadata; this.data = data;
    if (this.afterBatch) this.afterBatch();
    return { replies: requests.map(() => ({})) };
  }
  apply(name, row, values) { this.data[name][row - 1] = structuredClone(values); }
}

async function write(fixture, updates, patch = {}) {
  const body = { valueInputOption: 'RAW', data: updates, ...patch };
  return validateDocumentSheetWrite('/values:batchUpdate', { method: 'POST', body: JSON.stringify(body) }, fixture.rawRequest);
}
function rowWrite(name, row, values) { return { range: `'${name}'!A${row}:${documentColumn(def(name).headers.length - 1)}${row}`, values: [values] }; }

test('optional document tables may be absent without changing the established core snapshot contract', async () => {
  const fixture = new DocumentSheetsFixture({ present: false });
  assert.deepEqual(await readDocumentTables(fixture), { ready: false, tables: {} });
  const scalar = value => typeof value === 'number' ? { numberValue: value } : typeof value === 'boolean' ? { boolValue: value } : { stringValue: String(value ?? '') };
  const oldSource = { sheets: Object.entries(fixtures()).map(([name, rows], sheetId) => ({
    properties: { title: name, sheetId, gridProperties: { rowCount: Math.max(1001, SHEETS_SCHEMA.sheets[name].lastRow), columnCount: 30 } },
    tables: name === 'Монтажи' ? [{ tableId: 'native', range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endRowIndex: 1001, endColumnIndex: 10 } }] : [],
    data: [{ rowData: rows.map(row => ({ values: row.map(value => ({ userEnteredValue: value?.formula ? { formulaValue: value.formula } : scalar(value), effectiveValue: scalar(value?.formula ? value.value : value) })) })) }],
  })) };
  assert.equal(validateSnapshot(oldSource).size, 11);
  assert.equal(isDocumentSheetWrite('/values:batchGet', { body: JSON.stringify({ data: [rowWrite('Продавцы', 2, sellerRow())] }) }), false);
  assert.equal(isDocumentSheetWrite('/values:batchUpdate', { method: 'POST', body: JSON.stringify({ data: [{ range: "'Заказы'!B2", values: [['Учебный']] }] }) }), false);
  assert.equal(isDocumentSheetWrite('/values:batchUpdate', { method: 'POST', body: JSON.stringify({ data: [rowWrite('Продавцы', 2, sellerRow())] }) }), true);
});

test('document reads require exact headers, grid capacity, unique IDs and primitive values', async () => {
  const source = new DocumentSheetsFixture();
  const loaded = await readDocumentTables(source);
  assert.equal(loaded.ready, true);
  assert.equal(nextDocumentRow(loaded.tables['Продавцы']), 3);
  assert.deepEqual(documentWrite(loaded.tables['Продавцы'], 3, sellerRow()), rowWrite('Продавцы', 3, sellerRow()));
  for (const corrupt of [
    fixture => { fixture.data['Продавцы'][0][1] = 'Переименовано'; },
    fixture => { fixture.metadata.sheets.find(sheet => sheet.properties.title === 'Продавцы').properties.gridProperties.rowCount = 200; },
    fixture => { fixture.data['Продавцы'].push(sellerRow()); },
    fixture => { fixture.data['Продавцы'][1][0] = 'short'; },
    fixture => { fixture.data['Продавцы'][1][2] = { unsafe: true }; },
  ]) {
    const fixture = new DocumentSheetsFixture(); corrupt(fixture);
    await assert.rejects(readDocumentTables(fixture), denied);
  }
  assert.throws(() => documentWrite(loaded.tables['Продавцы'], 2, ['short']), denied);
  assert.throws(() => nextDocumentRow({ def: { capacity: 3 }, rows: [{ row: 2 }, { row: 3 }] }), { code: 'DOCUMENT_CAPACITY' });
});

test('one RAW batch may create a seller and its account while orphan account references are denied', async () => {
  const fixture = new DocumentSheetsFixture({ seeded: false });
  const updates = [rowWrite('Продавцы', 2, sellerRow()), rowWrite('Счета продавцов', 2, accountRow())];
  await write(fixture, updates);
  assert.equal(fixture.data['Продавцы'].length, 1, 'Validation never performs the proposed write');
  await assert.rejects(write(fixture, [rowWrite('Счета продавцов', 2, accountRow())]), denied);
  const wrongOwner = accountRow(); wrongOwner[1] = '99999999-9999-4999-8999-999999999999';
  await assert.rejects(write(fixture, [updates[0], rowWrite('Счета продавцов', 2, wrongOwner)]), denied);
  assert.ok(fixture.requests.every(request => request.startsWith('?fields=') || request.startsWith('/values:batchGet?')));
});

test('guard refuses formula text, non-RAW mode, partial/out-of-range rows and mixed writes to core sheets', async () => {
  const fixture = new DocumentSheetsFixture();
  const valid = rowWrite('Продавцы', 2, sellerRow());
  const formula = sellerRow(); formula[1] = '=IMPORTXML("https://invalid.example","x")';
  const unsafe = sellerRow(); unsafe[1] = 'nul\0value';
  for (const updates of [
    [rowWrite('Продавцы', 2, formula)], [rowWrite('Продавцы', 2, unsafe)],
    [{ ...valid, range: "'Продавцы'!A1:N1" }], [{ ...valid, range: "'Продавцы'!A202:N202" }],
    [{ ...valid, range: "'Продавцы'!B2:N2" }], [{ ...valid, values: [sellerRow().slice(1)] }],
    [valid, valid], [valid, { range: "'Заказы'!B2", values: [['Не записывать']] }],
  ]) await assert.rejects(write(fixture, updates), denied);
  await assert.rejects(write(fixture, [valid], { valueInputOption: 'USER_ENTERED' }), denied);
  await assert.rejects(write(fixture, [valid], { unexpected: true }), denied);
  await assert.rejects(validateDocumentSheetWrite(':batchUpdate', { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data: [valid] }) }, fixture.rawRequest), denied);
});

test('a prepared document can be confirmed once while its snapshot, identity and final status stay immutable', async () => {
  const fixture = new DocumentSheetsFixture();
  const prepared = documentRow();
  await write(fixture, [rowWrite('Документы заказов', 2, prepared)]);
  fixture.apply('Документы заказов', 2, prepared);
  const confirmed = [...prepared]; confirmed[8] = 'confirmed'; confirmed[11] = 'a'.repeat(32); confirmed[12] = digest('fictional PDF');
  await write(fixture, [rowWrite('Документы заказов', 2, confirmed)]);
  for (const mutation of [
    row => { row[9] = JSON.stringify({ changed: true }); row[10] = digest(row[9]); },
    row => { row[3] = 'OTHER-NUMBER'; }, row => { row[0] = '99999999-9999-4999-8999-999999999999'; },
  ]) {
    const altered = [...confirmed]; mutation(altered);
    await assert.rejects(write(fixture, [rowWrite('Документы заказов', 2, altered)]), denied);
  }
  fixture.apply('Документы заказов', 2, confirmed);
  await write(fixture, [rowWrite('Документы заказов', 2, confirmed)]);
  await assert.rejects(write(fixture, [rowWrite('Документы заказов', 2, prepared)]), denied);
  const changedFile = [...confirmed]; changedFile[11] = 'b'.repeat(32);
  await assert.rejects(write(fixture, [rowWrite('Документы заказов', 2, changedFile)]), denied);
});

test('document guard checks snapshot hash, initial status, references and unique requests/versions', async () => {
  const fixture = new DocumentSheetsFixture();
  for (const mutation of [
    row => { row[10] = digest('wrong snapshot'); },
    row => { row[8] = 'confirmed'; row[11] = 'a'.repeat(32); row[12] = digest('PDF'); },
    row => { row[8] = 'deleted'; }, row => { row[7] = 1.5; },
    row => { row[5] = '99999999-9999-4999-8999-999999999999'; },
    row => { row[6] = '99999999-9999-4999-8999-999999999999'; },
  ]) {
    const altered = documentRow(); mutation(altered);
    await assert.rejects(write(fixture, [rowWrite('Документы заказов', 2, altered)]), denied);
  }
  fixture.apply('Документы заказов', 2, documentRow());
  const duplicate = documentRow({ 0: '55555555-5555-4555-8555-555555555555' });
  await assert.rejects(write(fixture, [rowWrite('Документы заказов', 3, duplicate)]), denied);
  duplicate[14] = '66666666-6666-4666-8666-666666666666';
  await assert.rejects(write(fixture, [rowWrite('Документы заказов', 3, duplicate)]), denied);
  duplicate[7] = 2;
  await write(fixture, [rowWrite('Документы заказов', 3, duplicate)]);
});

test('migration preview does not write; apply creates three tabs, headers, seed and protections in one nine-request batch', async () => {
  const fixture = new DocumentSheetsFixture({ present: false });
  const initialRows = { Продавцы: [sellerRow()], 'Счета продавцов': [accountRow()] };
  const preview = await prepareDocumentSheets(fixture);
  assert.equal(preview.ready, false); assert.equal(preview.created, false); assert.equal(fixture.batches.length, 0);
  assert.deepEqual(preview.missing, DOCUMENT_TABLES.map(table => table.name));
  const applied = await prepareDocumentSheets(fixture, { apply: true, initialRows });
  assert.equal(applied.ready, true); assert.equal(applied.created, true);
  assert.equal(fixture.batches.length, 1); assert.equal(fixture.batches[0].length, 9);
  assert.equal(fixture.batches[0].filter(request => request.addSheet).length, 3);
  assert.equal(fixture.batches[0].filter(request => request.updateCells).length, 3);
  assert.equal(fixture.batches[0].filter(request => request.addProtectedRange).length, 3);
  assert.deepEqual(applied.tables['Продавцы'].rows.map(row => row.values), initialRows['Продавцы']);
  assert.deepEqual(applied.tables['Счета продавцов'].rows.map(row => row.values), initialRows['Счета продавцов']);
  const changedSeed = { Продавцы: [Object.assign(sellerRow(), { 1: 'Must never overwrite' })] };
  const again = await prepareDocumentSheets(fixture, { apply: true, initialRows: changedSeed });
  assert.equal(again.created, false); assert.equal(fixture.batches.length, 1);
  assert.equal(fixture.data['Продавцы'][1][1], 'Учебный продавец');
});

test('migration refuses partial namespaces, reserved-ID collisions and malformed seed before writing', async () => {
  const partial = new DocumentSheetsFixture({ present: false });
  partial.metadata.sheets.push({ properties: { title: 'Продавцы', sheetId: 99, gridProperties: { rowCount: 201, columnCount: 14 } } });
  await assert.rejects(prepareDocumentSheets(partial, { apply: true }), denied);
  assert.equal(partial.batches.length, 0);
  const collision = new DocumentSheetsFixture({ present: false });
  collision.metadata.sheets[0].properties.sheetId = DOCUMENT_TABLES[0].id;
  await assert.rejects(prepareDocumentSheets(collision, { apply: true }), denied);
  assert.equal(collision.batches.length, 0);
  for (const initialRows of [{ Unknown: [] }, { Продавцы: [['short']] }]) {
    const fixture = new DocumentSheetsFixture({ present: false });
    await assert.rejects(prepareDocumentSheets(fixture, { apply: true, initialRows }), denied);
    assert.equal(fixture.batches.length, 0);
  }
});

test('migration requires exact readback of the initial rows before reporting success', async () => {
  const fixture = new DocumentSheetsFixture({ present: false });
  fixture.afterBatch = () => { fixture.data['Продавцы'][1][1] = 'Unexpected readback'; };
  await assert.rejects(prepareDocumentSheets(fixture, { apply: true, initialRows: { Продавцы: [sellerRow()] } }), denied);
  assert.equal(fixture.batches.length, 1, 'Reports the unconfirmed applied state without a second batch');
});
