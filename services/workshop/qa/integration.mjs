import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.mjs';
import { GoogleSheetsClient } from '../server/google-sheets.mjs';
import { assertTestSheet, assertLoopback, assertOwned } from './safety.mjs';

const sheet = assertTestSheet(process.env.GOOGLE_SPREADSHEET_ID, process.env.QA_CONFIRM_SHEET);
const base = assertLoopback(process.env.QA_BASE_URL || 'http://127.0.0.1:3000');
const directory = assertOwned(process.env.QA_DIRECTORY || '');
const data = path.join(directory, 'data');
if (process.env.DATA_DIR !== data) throw new Error('INTEGRATION_DATA_NOT_ISOLATED');
const db = openDatabase(path.join(data, 'finance.sqlite3'));
const token = crypto.randomBytes(32).toString('base64url'), hash = crypto.createHash('sha256').update(token).digest('hex');
db.prepare('INSERT INTO sessions(token_hash,expires_at,created_at) VALUES(?,?,?)').run(hash, new Date(Date.now() + 3600000).toISOString(), new Date().toISOString());
const client = new GoogleSheetsClient({ spreadsheetId: sheet, credentialsFile: process.env.GOOGLE_CREDENTIALS_FILE });
const stateFile = path.join(directory, 'integration-state.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { requestId: crypto.randomUUID(), deleteId: crypto.randomUUID(), date: new Date().toISOString().slice(0, 10) };
fs.writeFileSync(stateFile, JSON.stringify(state));
const checks = [];
async function request(route, method = 'GET', body) {
  await new Promise(resolve => setTimeout(resolve, 10000));
  const r = await fetch(base + route, { method, headers: { Origin: base, Cookie: `finance_session=${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(90000) });
  const value = await r.json(); assert.ok(r.ok, `HTTP ${r.status}, code ${value.code || 'none'}`); return value;
}
try {
  const board = await request('/kanban/api/board?fresh=1');
  assert.equal(new URL(board.spreadsheetUrl).pathname.split('/')[3], sheet);
  checks.push('exact test workbook verified before mutations');
  for (const route of ['/api/transactions', '/api/orders', '/api/production', '/api/warehouse']) await request(route);
  checks.push('four modules read from the test workbook');
  if (!state.completed) {
    const input = { requestId: state.requestId, type: 'expense', date: state.date, category: 'Прочее', description: 'QA: вымышленный расход инфраструктурного стенда', amount: 1, account: 'В кассе' };
    const created = await request('/api/transactions', 'POST', input);
    await request('/api/transactions', 'POST', input);
    const list = await request('/api/transactions');
    assert.equal(list.transactions.filter(v => v.id === state.requestId).length, 1);
    checks.push('confirmed expense and identical retry produce exactly one record');
    const range = `A${created.transaction.sheetRow}:M${created.transaction.sheetRow}`;
    const before = await client.getValues('Расходы', range, { valueRenderOption: 'FORMULA' });
    await request('/api/transactions', 'DELETE', { id: state.requestId, requestId: state.deleteId });
    const after = await client.getValues('Расходы', range, { valueRenderOption: 'FORMULA' });
    const formulas = rows => (rows.values?.[0] || []).map((v, i) => typeof v === 'string' && v.startsWith('=') ? [i, v] : null).filter(Boolean);
    assert.ok(formulas(before).length, 'prepared row must contain a real formula');
    assert.deepEqual(formulas(after), formulas(before));
    checks.push('only the created expense cleared; prepared Google formulas preserved');
    state.completed = true; fs.writeFileSync(stateFile, JSON.stringify(state));
  }
  fs.writeFileSync(path.join(directory, 'integration-report.json'), JSON.stringify({ ok: true, at: new Date().toISOString(), checks }, null, 2));
  console.log(JSON.stringify({ ok: true, checks }));
} finally { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash); db.close(); }
