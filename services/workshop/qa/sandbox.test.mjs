import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createDirectory, launch, removeDirectory } from './sandbox-lib.mjs';
import { assertTestSheet, assertLoopback, TEST_SHEET } from './safety.mjs';
import { openDatabase } from '../server/db.mjs';

test('integration guard denies production, reserve, missing confirmation and remote URLs', () => {
  for (const id of ['', 'EXAMPLE_PRODUCTION_GOOGLE_SHEET_ID_CHANGE_BEFORE_USE', 'EXAMPLE_BACKUP_GOOGLE_SHEET_ID_CHANGE_BEFORE_USE', 'other']) assert.throws(() => assertTestSheet(id, id));
  assert.throws(() => assertTestSheet(TEST_SHEET, ''));
  assert.equal(assertTestSheet(TEST_SHEET, TEST_SHEET), TEST_SHEET);
  for (const url of ['https://vm-app.ru', 'http://example.com', 'http://user:pass@localhost']) assert.throws(() => assertLoopback(url));
});

test('refill real HTTP lost response survives server restart, blocks competing writes and confirms exactly once', async () => {
  const directory = createDirectory('refill-http-'); let instance;
  try {
    instance = await launch(directory);
    const request = async (route, method = 'GET', body) => {
      const r = await fetch(instance.base + route, { method, headers: { Cookie: `finance_session=${instance.token}`, Origin: instance.base, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: r.status, value: await r.json() };
    };
    const payload = { requestId: crypto.randomUUID(), code: 'QA-M1', quantity: 1.25 };
    fs.writeFileSync(path.join(directory, 'refill-fault'), 'lost-response');
    const lost = await request('/api/warehouse/movements', 'POST', payload);
    assert.equal(lost.status, 502); assert.equal(lost.value.receiptState, 'submitted');
    const blocked = await request('/api/warehouse/issues', 'POST', { requestId: crypto.randomUUID(), code: 'QA-M1', quantity: 1, orderNumber: '9001' });
    assert.equal(blocked.status, 503);
    assert.equal((await request('/api/health')).value.warehousePending, 1);
    assert.equal((await request('/api/diagnostics')).value.warehousePending.length, 1);
    await instance.stop();
    fs.unlinkSync(path.join(directory, 'refill-fault'));
    fs.unlinkSync(path.join(directory, 'refill-readback-failed'));
    instance = await launch(directory, { version: 'refill-restart' });
    const retried = await request('/api/warehouse/movements', 'POST', payload);
    assert.equal(retried.status, 201); assert.equal(retried.value.refill.state, 'confirmed');
    const changed = await request('/api/warehouse/movements', 'POST', { ...payload, quantity: 2 });
    assert.equal(changed.status, 409);
    const sheet = JSON.parse(fs.readFileSync(path.join(directory, 'sheet.json'), 'utf8'));
    assert.equal(sheet['Движения склада'].filter(row => row[9] === `PWA:refill:${payload.requestId}`).length, 1);
    assert.equal((await request('/api/diagnostics')).value.warehousePending.length, 0);
    const db = openDatabase(path.join(directory, 'data', 'finance.sqlite3'));
    try { assert.equal(db.prepare('SELECT state FROM warehouse_refills').get().state, 'confirmed'); }
    finally { db.close(); }
  } finally { await instance?.stop(); removeDirectory(directory); }
});

test('real offline HTTP server reads all modules, confirms a write once, preserves it on restart and isolates cleanup', async () => {
  const directory = createDirectory('test-'), neighbor = createDirectory('neighbor-');
  fs.writeFileSync(path.join(neighbor, 'keep'), 'owned by another run');
  let instance;
  try {
    instance = await launch(directory);
    const request = async (route, method = 'GET', body) => {
      const r = await fetch(instance.base + route, { method, headers: { Cookie: `finance_session=${instance.token}`, Origin: instance.base, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.ok(r.ok, `${route}: HTTP ${r.status}`); return r.json();
    };
    for (const route of ['/api/transactions', '/api/orders', '/api/production', '/api/warehouse', '/api/expense-categories', '/kanban/api/board']) await request(route);
    assert.equal((await fetch(instance.base + '/api/transactions')).status, 401);
    const payload = { requestId: crypto.randomUUID(), type: 'expense', date: '2026-09-06', category: 'Прочее', description: 'Вымышленный проверочный расход', amount: 123, account: 'В кассе' };
    const created = await request('/api/transactions', 'POST', payload);
    assert.equal(created.transaction.amount, 123);
    await request('/api/transactions', 'POST', payload);
    await instance.stop(); instance = await launch(directory, { version: 'offline-previous' });
    const rows = await request('/api/transactions');
    const transactions = Array.isArray(rows) ? rows : rows.transactions;
    assert.equal(transactions.filter(v => v.id === payload.requestId).length, 1);
    assert.equal(transactions.find(v => v.id === payload.requestId).amount, 123);
  } finally { await instance?.stop(); removeDirectory(directory); assert.equal(fs.readFileSync(path.join(neighbor, 'keep'), 'utf8'), 'owned by another run'); removeDirectory(neighbor); }
});
