import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../server/db.mjs';
import { assertOwned } from './safety.mjs';
const directory = assertOwned(process.env.QA_DIRECTORY);
if (process.env.GOOGLE_SPREADSHEET_ID !== 'offline-workshop') throw new Error('OFFLINE_ONLY');
const db = openDatabase(path.join(directory, 'data/finance.sqlite3'));
const token = crypto.randomBytes(32).toString('hex'), hash = crypto.createHash('sha256').update(token).digest('hex');
db.prepare('INSERT INTO sessions(token_hash,expires_at,created_at) VALUES(?,?,?)').run(hash, new Date(Date.now() + 3600000).toISOString(), new Date().toISOString());
const requestId = '33333333-3333-4333-8333-333333333333';
try {
  const headers = { Cookie: `finance_session=${token}`, Origin: 'http://127.0.0.1:3000', 'Content-Type': 'application/json' };
  if (process.argv[2] === 'create') {
    const r = await fetch('http://127.0.0.1:3000/api/transactions', { method: 'POST', headers, body: JSON.stringify({ requestId, type: 'expense', date: '2026-09-06', category: 'Прочее', description: 'Учебная операция после выпуска', account: 'В кассе', amount: 321 }) });
    assert.equal(r.status, 201);
    fs.mkdirSync(path.join(directory, 'data/orders/media'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'data/orders/media/qa-preserved.txt'), 'fictional attachment after release');
  }
  const r = await fetch('http://127.0.0.1:3000/api/transactions', { headers });
  assert.equal(r.status, 200); const { transactions } = await r.json();
  assert.equal(transactions.filter(v => v.id === requestId).length, 1);
  assert.equal(transactions.find(v => v.id === requestId).amount, 321);
  assert.equal(db.prepare('SELECT state FROM finance_commands WHERE request_id=?').get(requestId).state, 'confirmed');
  assert.equal(fs.readFileSync(path.join(directory, 'data/orders/media/qa-preserved.txt'), 'utf8'), 'fictional attachment after release');
  console.log(JSON.stringify({ ok: true, recordCount: 1, confirmed: true, attachmentPreserved: true }));
} finally { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash); db.close(); }
