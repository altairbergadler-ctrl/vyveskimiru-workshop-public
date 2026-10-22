import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { GoogleSheetsClient, a1 } from '../server/sheets-client.mjs';
import { installSheetsGuard } from '../server/sheets-guard.mjs';
import { createWarehouseItem, refillWarehouseItem, installWarehouseReceipts } from '../server/warehouse.mjs';
import { openDatabase } from '../server/db.mjs';
import { assertTestSheet, assertOwned } from './safety.mjs';
const spreadsheetId = assertTestSheet(process.env.GOOGLE_SPREADSHEET_ID, process.env.QA_CONFIRM_SHEET);
const directory = assertOwned(process.env.QA_DIRECTORY);
const config = { spreadsheetId, credentialsFile: process.env.GOOGLE_CREDENTIALS_FILE };
const raw = new GoogleSheetsClient(config), client = new GoogleSheetsClient(config);
let blockReads = false, loseResponse = false, writes = 0;
// The live service uses the same service account: leave ample quota for its reads.
const send = raw.request.bind(raw);
let readQueue = Promise.resolve();
raw.request = (route, options) => {
  const run = readQueue.then(async () => { await new Promise(resolve => setTimeout(resolve, 3000)); return send(route, options); });
  readQueue = run.catch(() => {});
  return run;
};
const pause = () => new Promise(resolve => setTimeout(resolve, 12000));
const checks = [], id = crypto.randomUUID(), marker = `QA contract ${id}`;
const journalFile = path.join(directory, 'contract-write-journal.json');
assert.ok(!fs.existsSync(journalFile), 'use a fresh isolated run; recover existing journal first');
const journal = { spreadsheetId, cells: [] };
const save = () => fs.writeFileSync(journalFile, JSON.stringify(journal));
const entered = cell => cell?.userEnteredValue ?? {};
const value = cell => cell?.formulaValue ?? cell?.numberValue ?? cell?.boolValue ?? cell?.stringValue ?? '';
const col = c => c.charCodeAt(0) - 65;
client.request = async (route, options) => {
  if (blockReads) throw new Error('QA_LOST_READBACK');
  if (options?.method) {
    const body = JSON.parse(options.body);
    if (route === '/values:batchUpdate') {
      for (const entry of body.data) {
        const match = entry.range.match(/^'([^']+)'!([A-Z])(\d+)(?::([A-Z])(\d+))?$/u);
        assert.ok(match); const [, name, column, row] = match, table = before.get(name);
        assert.ok(['Склад', 'Движения склада'].includes(name), 'refill runner may only write stock fixtures');
        entry.values.forEach((values, i) => values.forEach((v, j) => {
          const r = Number(row) + i, c = col(column) + j, original = entered(table.cells[r - 1]?.[c]);
          assert.ok(value(original) === '' || original.formulaValue, 'test may write only a previously empty input or a prepared formula');
          assert.ok(!journal.cells.some(cell => cell.name === name && cell.row === r && cell.column === c), 'test writes each input once');
          let expected = v;
          if (body.valueInputOption === 'USER_ENTERED' && table.schema.types[String.fromCharCode(65 + c)] === 'date' && typeof v === 'string' && /^\d{2}\.\d{2}\.\d{4}$/u.test(v)) {
            const [d, m, y] = v.split('.'); expected = (Date.UTC(Number(y), Number(m) - 1, Number(d)) - Date.UTC(1899, 11, 30)) / 86400000;
          }
          journal.cells.push({ name, sheetId: table.id, row: r, column: c, original, expected });
        }));
      }
    } else throw new Error('unexpected refill integration mutation');
    save(); await pause();
  }
  const result = await raw.request(route, options);
  if (options?.method) { writes++; if (loseResponse) { blockReads = true; throw new Error('QA_LOST_RESPONSE_AFTER_APPLY'); } }
  return result;
};
const guard = installSheetsGuard(client);
const before = await guard.check();
save();
async function restoreCreated() {
  if (!journal.cells.length) return;
  const ranges = journal.cells.map(cell => a1(cell.name, `${String.fromCharCode(65 + cell.column)}${cell.row}`));
  const current = (await raw.getRanges(ranges, { valueRenderOption: 'FORMULA' })).valueRanges;
  current.forEach((entry, i) => {
    const actual = entry.values?.[0]?.[0] ?? '', saved = journal.cells[i];
    assert.ok(actual === saved.expected || actual === value(saved.original), 'test cell changed externally; do not overwrite');
  });
  await raw.batchUpdate(journal.cells.map(cell => ({ updateCells: { start: { sheetId: cell.sheetId, rowIndex: cell.row - 1, columnIndex: cell.column }, fields: 'userEnteredValue', rows: [{ values: [Object.keys(cell.original).length ? { userEnteredValue: cell.original } : {}] }] } })));
  const restored = (await raw.getRanges(ranges, { valueRenderOption: 'FORMULA' })).valueRanges;
  restored.forEach((entry, i) => assert.equal(entry.values?.[0]?.[0] ?? '', value(journal.cells[i].original)));
  journal.restored = true; save(); checks.push('all temporary command inputs and prepared formulas restored exactly');
}
let db;
try {
  const warehouse = { sku: `QA-${id}`, name: marker, category: 'Прочее', expenseCategory: 'Прочее', unit: 'шт', stock: 0, minStock: 0, reserved: 0, location: 'QA' };
  const stock = { get configured() { return client.configured; }, getValues: client.getValues.bind(client), updateValues: data => client.updateValues(data, { valueInputOption: 'USER_ENTERED' }) };
  await createWarehouseItem(stock, warehouse); await pause();
  const file = path.join(directory, 'data', 'refills.sqlite3');
  db = openDatabase(file);
  let receipts = installWarehouseReceipts(stock, db);
  const command = { requestId: crypto.randomUUID(), code: warehouse.sku, quantity: 1.25 };
  loseResponse = true;
  await assert.rejects(refillWarehouseItem(stock, command), e => e.receiptState === 'submitted');
  assert.equal(receipts.pending().length, 1);
  checks.push('Google accepted refill; simulated lost write response and unavailable readback leave durable receipt pending');
  db.close(); db = openDatabase(file); receipts = installWarehouseReceipts(stock, db);
  blockReads = false; loseResponse = false; await pause();
  assert.equal((await refillWarehouseItem(stock, command)).refill.state, 'confirmed');
  await pause();
  assert.equal((await refillWarehouseItem(stock, command)).refill.state, 'confirmed');
  await assert.rejects(refillWarehouseItem(stock, { ...command, quantity: 2 }), e => e.code === 'duplicate');
  assert.equal(writes, 2); // one catalog row plus exactly one movement
  assert.equal(receipts.pending().length, 0);
  const rows = (await raw.getValues('Движения склада', 'A1:L500', { valueRenderOption: 'FORMULA' })).values;
  const matches = rows.filter(row => row[9] === `PWA:refill:${command.requestId}`);
  assert.equal(matches.length, 1); assert.equal(matches[0][4], 1.25); assert.equal(matches[0][11], 1.25);
  checks.push('reopened SQLite confirms via Google serial-date readback; repeated retry creates no duplicate; changed payload rejected');
} finally { blockReads = false; loseResponse = false; db?.close(); await pause(); await restoreCreated(); }
fs.writeFileSync(path.join(directory, 'refill-report.json'), JSON.stringify({ ok: true, at: new Date().toISOString(), writes, restoredCells: journal.cells.length, checks }, null, 2));
console.log(JSON.stringify({ ok: true, writes, restoredCells: journal.cells.length, checks }));
