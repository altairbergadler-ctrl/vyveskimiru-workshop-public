import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { GoogleSheetsClient, a1 } from '../server/sheets-client.mjs';
import { installSheetsGuard } from '../server/sheets-guard.mjs';
import { createClient } from '../modules/orders/server/clients.mjs';
import { createOrder } from '../modules/orders/server/creation.mjs';
import { createPosition } from '../modules/orders/server/positions.mjs';
import { createInstallation } from '../modules/orders/server/editing.mjs';
import { createWarehouseItem, refillWarehouseItem, installWarehouseReceipts } from '../server/warehouse.mjs';
import { openDatabase } from '../server/db.mjs';
import { assertTestSheet, assertOwned, assertLoopback } from './safety.mjs';

const spreadsheetId = assertTestSheet(process.env.GOOGLE_SPREADSHEET_ID, process.env.QA_CONFIRM_SHEET);
const directory = assertOwned(process.env.QA_DIRECTORY), base = assertLoopback(process.env.QA_BASE_URL || 'http://127.0.0.1:3000');
const config = { spreadsheetId, credentialsFile: process.env.GOOGLE_CREDENTIALS_FILE };
const raw = new GoogleSheetsClient(config), client = new GoogleSheetsClient(config);
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
const journal = { spreadsheetId, cells: [], native: null };
const save = () => fs.writeFileSync(journalFile, JSON.stringify(journal));
const entered = cell => cell?.userEnteredValue ?? {};
const value = cell => cell?.formulaValue ?? cell?.numberValue ?? cell?.boolValue ?? cell?.stringValue ?? '';
const scalar = v => typeof v === 'number' ? { numberValue: v } : typeof v === 'boolean' ? { boolValue: v } : { stringValue: v };
const col = c => c.charCodeAt(0) - 65;
client.request = async (route, options) => {
  if (options?.method) {
    const body = JSON.parse(options.body);
    if (route === '/values:batchUpdate') {
      for (const entry of body.data) {
        const match = entry.range.match(/^'([^']+)'!([A-Z])(\d+)(?::([A-Z])(\d+))?$/u);
        assert.ok(match); const [, name, column, row] = match, table = before.get(name);
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
    } else if (route === ':batchUpdate' && body.requests.length === 1 && body.requests[0].appendCells) {
      const append = body.requests[0].appendCells;
      journal.native = { sheetId: append.sheetId, values: append.rows[0].values.map(cell => value(cell.userEnteredValue)) };
    } else throw new Error('unexpected integration mutation');
    save(); await pause();
  }
  return raw.request(route, options);
};
const guard = installSheetsGuard(client);
const before = await guard.check();
save();
async function restoreCreated() {
  if (journal.native) {
    const rows = (await raw.getValues('Монтажи', 'A1:J1001', { valueRenderOption: 'FORMULA' })).values ?? [];
    const matches = rows.flatMap((row, i) => row[0] === journal.native.values[0] ? [i] : []);
    assert.ok(matches.length <= 1, 'duplicate native ID; recovery requires review');
    if (matches.length) {
      const r = matches[0];
      assert.ok((before.get('Монтажи').cells[r] ?? []).every(cell => value(entered(cell)) === ''), 'native append must use an originally empty row');
      journal.native.values.forEach((v, c) => journal.cells.push({ name: 'Монтажи', sheetId: journal.native.sheetId, row: r + 1, column: c, original: entered(before.get('Монтажи').cells[r]?.[c]), expected: v }));
      journal.native = null; save();
    }
  }
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
try {
  await createClient(client, { requestId: crypto.randomUUID(), changes: { companyName: marker, createdDate: '2026-09-06' } }, { journalDir: path.join(directory, 'contract-clients') });
  checks.push('real client creation through the guarded RAW path'); await pause();
  const order = await createOrder(client, { requestId: crypto.randomUUID(), changes: { title: marker, client: marker, createdDate: '2026-09-06' } }, { journalDir: path.join(directory, 'contract-orders') });
  checks.push('real order creation, linked to the temporary client'); await pause();
  await createPosition(client, { requestId: crypto.randomUUID(), orderId: String(order.id), position: { template: 'custom', name: marker, description: marker, unit: 'шт', quantity: 1, unitPrice: 1, unitCost: 0 } }, { journalDir: path.join(directory, 'contract-positions') });
  checks.push('real position creation preserves prepared formulas'); await pause();
  await createInstallation(client, { orderId: String(order.id), changes: { comment: marker } });
  checks.push('real native-table installation append'); await pause();
  const warehouse = { sku: `QA-${id}`, name: marker, category: 'Прочее', expenseCategory: 'Прочее', unit: 'шт', stock: 1, minStock: 0, reserved: 0, location: 'QA' };
  // Warehouse keeps its established USER_ENTERED path.
  const stockClient = { get configured() { return client.configured; }, getValues: client.getValues.bind(client), updateValues: data => client.updateValues(data, { valueInputOption: 'USER_ENTERED' }) };
  await createWarehouseItem(stockClient, warehouse);
  checks.push('real catalog creation and initial historical movement'); await pause();
  const stockDb = openDatabase(path.join(directory, 'data', 'contract-stock.sqlite3'));
  installWarehouseReceipts(stockClient, stockDb);
  try { await refillWarehouseItem(stockClient, { requestId: crypto.randomUUID(), code: warehouse.sku, quantity: 1 }); }
  finally { stockDb.close(); }
  checks.push('real stock refill through guarded historical movement');
} finally { await pause(); await restoreCreated(); }

// Mutate only known headers/formulas on the allowlisted test copy, restore in finally.
const db = openDatabase(path.join(directory, 'data', 'finance.sqlite3'));
const token = crypto.randomBytes(32).toString('base64url'), hash = crypto.createHash('sha256').update(token).digest('hex');
db.prepare('INSERT INTO sessions(token_hash,expires_at,created_at) VALUES(?,?,?)').run(hash, new Date(Date.now() + 3600000).toISOString(), new Date().toISOString());
async function http(route, method = 'GET', body) {
  await pause();
  const response = await fetch(base + route, { method, headers: { Cookie: `finance_session=${token}`, Origin: base, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, value: await response.json() };
}
try {
  for (const fault of [{ column: 3, row: 1, next: scalar('QA changed header'), code: 'SHEETS_CONTRACT_HEADER' }, { column: 6, row: 498, next: { formulaValue: '=0' }, code: 'SHEETS_CONTRACT_FORMULA' }]) {
    const t = before.get('Расходы'), original = entered(t.cells[fault.row - 1]?.[fault.column]);
    const change = v => raw.batchUpdate([{ updateCells: { start: { sheetId: t.id, rowIndex: fault.row - 1, columnIndex: fault.column }, fields: 'userEnteredValue', rows: [{ values: [{ userEnteredValue: v }] }] } }]);
    fs.writeFileSync(path.join(directory, 'contract-fault-journal.json'), JSON.stringify({ spreadsheetId, sheetId: t.id, ...fault, original }));
    try {
      await change(fault.next);
      // Explicit refresh bypasses the permitted 30-second read-check cache.
      const diagnostics = await http('/api/diagnostics');
      assert.equal(diagnostics.value.sheetsContract.ok, false); assert.equal(diagnostics.value.pendingCommands.length, 0);
      const rejected = await http('/api/transactions', 'POST', { requestId: crypto.randomUUID(), type: 'expense', date: '2026-09-06', category: 'Прочее', description: marker, amount: 1, account: 'В кассе' });
      assert.equal(rejected.status, 409); assert.equal(rejected.value.code, fault.code);
      checks.push(`${fault.code}: real HTTP rejection and failed diagnostics, no pending command`);
    } finally { await change(original); }
  }
  const final = await http('/api/diagnostics'); assert.equal(final.value.sheetsContract.ok, true);
  checks.push('diagnostics recovered after exact header/formula restoration');
} finally { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash); db.close(); }
fs.writeFileSync(path.join(directory, 'contract-report.json'), JSON.stringify({ ok: true, at: new Date().toISOString(), checks }, null, 2));
console.log(JSON.stringify({ ok: true, checks }));
