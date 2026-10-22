import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleSheetsClient } from './sheets-client.mjs';
import { fixtures } from '../qa/fixtures.mjs';
import { SHEETS_SCHEMA, expectedFormula, installSheetsGuard, validateSnapshot, validateWrite, shiftFormula } from './sheets-guard.mjs';

const scalar = value => typeof value === 'number' ? { numberValue: value } : typeof value === 'boolean' ? { boolValue: value } : { stringValue: String(value ?? '') };
function snapshot() {
  return { sheets: Object.entries(fixtures()).map(([name, rows], sheetId) => ({
    properties: { title: name, sheetId, gridProperties: { rowCount: Math.max(1001, SHEETS_SCHEMA.sheets[name].lastRow), columnCount: 30 } },
    tables: name === 'Монтажи' ? [{ tableId: 'native', range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endRowIndex: 1001, endColumnIndex: 10 } }] : [],
    data: [{ rowData: rows.map(row => ({ values: row.map(v => ({ userEnteredValue: v?.formula ? { formulaValue: v.formula } : scalar(v), effectiveValue: scalar(v?.formula ? v.value : v) })) })) }],
  })) };
}
const sheet = (data, name) => data.sheets.find(s => s.properties.title === name);
function set(data, name, row, col, value) {
  const rows = sheet(data, name).data[0].rowData;
  rows[row - 1] ??= { values: [] }; rows[row - 1].values[col.charCodeAt(0) - 65] = value;
}
function valueWrite(data, range, values, mode = 'RAW') {
  return validateWrite('/values:batchUpdate', { method: 'POST', body: JSON.stringify({ valueInputOption: mode, data: [{ range, values }] }) }, validateSnapshot(data));
}
function gridWrite(data, requests) { return validateWrite(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests }) }, validateSnapshot(data)); }
const denial = code => ({ code: `SHEETS_CONTRACT_${code}`, notSubmitted: true });

test('schema uses live positions and bounds; relative formula shifts preserve constants, strings and absolute references', () => {
  assert.equal(validateSnapshot(snapshot()).size, 11);
  assert.equal(SHEETS_SCHEMA.sheets['Клиенты'].lastRow, 201);
  assert.equal(SHEETS_SCHEMA.sheets['Заказы'].lastRow, 301);
  assert.equal(shiftFormula('=IF($A2="A2";\'Sheet2\'!$G$1:$G1;2)', 10), '=IF($A12="A2";\'Sheet2\'!$G$1:$G11;2)');
});

for (const fault of ['rename', 'move', 'duplicate', 'missing', 'grid', 'formula', 'late-formula']) test(`schema refuses ${fault} before submitting anything`, async () => {
  const data = snapshot(), target = sheet(data, 'Заказы');
  if (fault === 'rename') target.properties.title = 'Заказы новые';
  if (fault === 'move') [target.data[0].rowData[0], target.data[0].rowData[1]] = [target.data[0].rowData[1], target.data[0].rowData[0]];
  if (fault === 'duplicate') target.data[0].rowData[0].values[25] = { userEnteredValue: scalar('№ заказа') };
  if (fault === 'missing') data.sheets.splice(data.sheets.indexOf(target), 1);
  if (fault === 'grid') target.properties.gridProperties.rowCount = 300;
  if (fault === 'formula') set(data, 'Заказы', 2, 'K', { userEnteredValue: { formulaValue: '=1' } });
  if (fault === 'late-formula') set(data, 'Заказы', 300, 'Q', { userEnteredValue: { formulaValue: '=1' } });
  const client = new GoogleSheetsClient({}); let writes = 0;
  client.request = async (_path, options) => { if (options?.method) writes++; return structuredClone(data); };
  installSheetsGuard(client);
  await assert.rejects(() => client.updateValues([{ range: "'Заказы'!H2", values: [['В работе']] }]), e => e.code.startsWith('SHEETS_CONTRACT_') && e.notSubmitted);
  assert.equal(writes, 0);
});

test('a cached successful read never authorizes a later write after a column move', async () => {
  const data = snapshot(); let writes = 0, reads = 0;
  const client = new GoogleSheetsClient({});
  client.request = async (_path, options) => { if (options?.method) writes++; else reads++; return structuredClone(data); };
  const guard = installSheetsGuard(client); await guard.check();
  const header = sheet(data, 'Расходы').data[0].rowData[0].values;
  [header[2], header[3]] = [header[3], header[2]];
  await assert.rejects(() => client.updateValues([{ range: "'Расходы'!D2", values: [[1]] }]), denial('HEADER'));
  assert.equal(reads, 2); assert.equal(writes, 0); assert.equal(guard.status().ok, false);
});

test('preflight outage is definitely unsent; timeout after submission remains uncertain', async () => {
  const client = new GoogleSheetsClient({}); let failure = 'read';
  client.request = async (_path, options) => {
    if (failure === 'read' || options?.method) throw Object.assign(new Error('timeout'), { code: 'SHEETS_TIMEOUT' });
    return snapshot();
  };
  installSheetsGuard(client);
  const write = () => client.updateValues([{ range: "'Заказы'!H2", values: [['В работе']] }]);
  await assert.rejects(write, { code: 'SHEETS_TIMEOUT', notSubmitted: true });
  failure = 'write';
  await assert.rejects(write, e => e.code === 'SHEETS_TIMEOUT' && !e.notSubmitted);
});

test('known manual fields retain numbers, booleans, serial dates and literal RAW text', () => {
  const data = snapshot();
  valueWrite(data, "'Заказы'!E2:F2", [[1000, 50]]);
  valueWrite(data, "'Производство'!G9", [[true]], 'USER_ENTERED');
  valueWrite(data, "'Производство'!K9", [['06.09.2026']], 'USER_ENTERED');
  valueWrite(data, "'Заказы'!C2", [[46271]]);
  valueWrite(data, "'Заказы'!B2", [['=literal text']]);
  validateWrite('/values:batchUpdate', { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data: [
    { range: "'Клиенты'!B2", values: [['Вымышленное новое название']] }, { range: "'Заказы'!D2", values: [['Вымышленное новое название']] },
  ] }) }, validateSnapshot(data));
});

test('partial client renames and clearing only a finance key cannot break existing identity links', () => {
  assert.throws(() => valueWrite(snapshot(), "'Клиенты'!B2", [['Вымышленное новое название']]), denial('REFERENCE'));
  assert.throws(() => valueWrite(snapshot(), "'Расходы'!J2", [['']]), denial('KEY_CHANGE'));
  const data = snapshot(), schema = SHEETS_SCHEMA.sheets['Расходы'];
  validateWrite('/values:batchUpdate', { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data: schema.writable.map(col => ({ range: `'Расходы'!${col}2`, values: [['']] })) }) }, validateSnapshot(data));
});

for (const [range, values, code] of [
  ["'Расходы'!D2", [['100']], 'TYPE'], ["'Производство'!G9", [['TRUE']], 'TYPE'],
  ["'Расходы'!D2", [[null]], 'TYPE'], ["'Расходы'!D2", [[Infinity]], 'TYPE'],
  ["'Заказы'!K2", [[1]], 'READ_ONLY'], ["'Настройки'!A2", [['new']], 'READ_ONLY'],
  ["'Дашборд'!C5", [[1]], 'READ_ONLY'], ["'Unknown'!A2", [[1]], 'READ_ONLY'],
  ["'Заказы'!A1", [[1]], 'RANGE'], ["'Заказы'!B302", [['overflow']], 'RANGE'],
  ["'Клиенты'!B202", [['overflow']], 'RANGE'], ["'Платежи'!G501", [[1]], 'RANGE'],
  ["'Расходы'!D499", [[1]], 'RANGE'], ["'Производство'!G309", [[true]], 'RANGE'],
  ["'Заказы'!A2", [['renumber']], 'KEY_CHANGE'], ["'Расходы'!F2", [['unknown']], 'REFERENCE'],
  ["'Заказы'!B2:C2", [['short']], 'SHAPE'], ["'Заказы'!B2", [['wide', 'extra']], 'SHAPE'],
]) test(`rejects ${String(code)} at ${String(range)}`, () => assert.throws(() => valueWrite(snapshot(), range, values), denial(code)));

test('USER_ENTERED formulas cannot be introduced through text; existing input formulas cannot be cleared', () => {
  const data = snapshot();
  assert.throws(() => valueWrite(data, "'Расходы'!C2", [['=1+1']], 'USER_ENTERED'), denial('FORMULA_INPUT'));
  set(data, 'Заказы', 2, 'E', { userEnteredValue: { formulaValue: '=1+1' } });
  assert.throws(() => valueWrite(data, "'Заказы'!E2", [['']]), denial('FORMULA'));
});

test('duplicate keys in source or resulting batch are rejected, including cross-ledger sync IDs', () => {
  const data = snapshot();
  assert.throws(() => valueWrite(data, "'Клиенты'!B3", [['Вымышленная мастерская Луна']]), denial('DUPLICATE_KEY'));
  set(data, 'Расходы', 3, 'J', { userEnteredValue: scalar('11111111-1111-4111-8111-111111111111') });
  assert.throws(() => validateSnapshot(data), denial('DUPLICATE_KEY'));
});

test('stock creation admits only the established formulas; a fresh movement freezes its historical values', () => {
  const data = snapshot(), schema = SHEETS_SCHEMA.sheets['Склад'];
  const row = ['QA-NEW', 'Учебные материалы', 'QA', 'шт', 0, 0, expectedFormula(schema, 'G', 3), 0, expectedFormula(schema, 'I', 3), '', expectedFormula(schema, 'K', 3), '', 0, '', 'Прочее'];
  valueWrite(data, "'Склад'!A3:O3", [row], 'USER_ENTERED');
  row[6] = '=100'; assert.throws(() => valueWrite(data, "'Склад'!A3:O3", [row], 'USER_ENTERED'), denial('FORMULA'));
  const movement = ['06.09.2026', 'Приход', 'QA-M1', 'QA', 2, 'шт', 100, 200, '', 'PWA', '', 2];
  valueWrite(data, "'Движения склада'!A2:L2", [movement], 'USER_ENTERED');
  movement.forEach((v, c) => set(data, 'Движения склада', 2, String.fromCharCode(65 + c), { userEnteredValue: scalar(v) }));
  validateSnapshot(data); // Replacing the first prepared movement must not break all future reads.
  assert.throws(() => valueWrite(data, "'Движения склада'!A2:L2", [movement], 'USER_ENTERED'), denial('FORMULA'));
  assert.throws(() => valueWrite(snapshot(), "'Движения склада'!G2", [[99]]), denial('READ_ONLY'));
});

test('unknown raw write APIs, row insertion, range clearing, field masks and formula cells fail closed', () => {
  const data = snapshot(), id = sheet(data, 'Расходы').properties.sheetId;
  for (const path of ['/values/x:append', '/values:batchClear', ':batchUpdate?fields=x']) assert.throws(() => validateWrite(path, { method: 'POST', body: '{}' }, validateSnapshot(data)));
  for (const request of [
    { deleteDimension: { range: { sheetId: id } } },
    { updateCells: { range: { sheetId: id }, rows: [], fields: 'userEnteredValue' } },
    { updateCells: { start: { sheetId: id, rowIndex: 1, columnIndex: 3 }, rows: [{ values: [{ userEnteredValue: { formulaValue: '=1' } }] }], fields: 'userEnteredValue' } },
    { updateCells: { start: { sheetId: id, rowIndex: 1, columnIndex: 3 }, rows: [{ values: [{}] }], fields: '*' } },
  ]) assert.throws(() => gridWrite(data, [request]), denial('REQUEST'));
});

test('native installation append validates table, preserves capacity and rejects ambiguous destination', () => {
  const data = snapshot(), s = sheet(data, 'Монтажи');
  const append = { appendCells: { sheetId: s.properties.sheetId, tableId: 'native', fields: 'userEnteredValue', rows: [{ values: ['77777777-7777-4777-8777-777777777777', '9001', 'Назначен', 46271, '12:00', '', '', '', '', ''].map(v => ({ userEnteredValue: scalar(v) })) }] } };
  gridWrite(data, [append]);
  append.appendCells.tableId = 'wrong'; assert.throws(() => gridWrite(data, [append]), denial('APPEND'));
  append.appendCells.tableId = 'native';
  s.tables.push({ ...s.tables[0], tableId: 'overlap' });
  assert.throws(() => gridWrite(data, [append]), denial('APPEND')); s.tables.pop();
  set(data, 'Монтажи', 1001, 'A', { userEnteredValue: scalar('66666666-6666-4666-8666-666666666666') });
  assert.throws(() => gridWrite(data, [append]), denial('CAPACITY'));
});

test('finance template copy is atomic with complete inputs, bounded and cannot replace a changed formula', () => {
  const data = snapshot(), t = sheet(data, 'Расходы'), schema = SHEETS_SCHEMA.sheets['Расходы'];
  const range = row => ({ sheetId: t.properties.sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: 0, endColumnIndex: 13 });
  const cp = { copyPaste: { source: range(2), destination: range(3), pasteType: 'PASTE_NORMAL', pasteOrientation: 'NORMAL' } };
  const values = { A: 46271, B: 'Прочее', C: 'QA', D: 1, E: 'В кассе', J: '77777777-7777-4777-8777-777777777777', K: '2026-09-06T00:00:00Z', M: 'vps' };
  const inputs = schema.writable.map(col => ({ updateCells: { start: { sheetId: t.properties.sheetId, rowIndex: 2, columnIndex: col.charCodeAt(0) - 65 }, fields: 'userEnteredValue', rows: [{ values: [{ userEnteredValue: scalar(values[col] ?? '') }] }] } }));
  gridWrite(data, [cp, ...inputs]);
  assert.throws(() => gridWrite(data, [...inputs, cp]), denial('COPY'));
  assert.throws(() => gridWrite(data, [cp, ...inputs.slice(1)]), denial('COPY_INPUTS'));
  cp.copyPaste.destination = range(499); assert.throws(() => gridWrite(data, [cp, ...inputs]), denial('COPY'));
  cp.copyPaste.destination = range(3);
  set(data, 'Расходы', 3, 'G', { userEnteredValue: scalar('manual override') });
  assert.throws(() => gridWrite(data, [cp, ...inputs]), denial('FORMULA'));
});
