import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createDirectory, launch, removeDirectory } from './sandbox-lib.mjs';

async function sandbox(t) {
  const directory = createDirectory('warehouse-expense-');
  let instance = await launch(directory);
  t.after(async () => { await instance.stop(); removeDirectory(directory); });
  return {
    directory,
    sheet: () => JSON.parse(fs.readFileSync(path.join(directory, 'sheet.json'), 'utf8')),
    async restart(edit, allowPending = false) {
      await instance.stop();
      if (edit) {
        const file = path.join(directory, 'sheet.json');
        const sheet = JSON.parse(fs.readFileSync(file, 'utf8'));
        edit(sheet); fs.writeFileSync(file, JSON.stringify(sheet));
      }
      instance = await launch(directory, { version: 'warehouse-expense-restart', allowPending });
    },
    async request(route, method = 'GET', body) {
      const response = await fetch(instance.base + route, { method,
        headers: { Cookie: `finance_session=${instance.token}`, Origin: instance.base, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, value: await response.json() };
    },
  };
}
const payload = extra => ({ requestId: crypto.randomUUID(), code: 'QA-M1', quantity: 1.25, comment: 'Учебное списание', ...extra });
const issueRows = (sheet, id) => sheet['Движения склада'].filter(row => row[9] === `PWA:${id}`);
const expenseRows = (sheet, id) => sheet['Расходы'].filter(row => row[9] === id);

test('warehouse form creates one cash expense with an optional order and preserves previous operations', async t => {
  const s = await sandbox(t), before = s.sheet();
  const beforeTransactions = (await s.request('/api/transactions')).value.transactions;
  const cash = rows => rows.filter(row => row.account === 'В кассе').reduce((sum, row) => sum + (row.type === 'income' ? row.amount : -row.amount), 0);
  for (const orderNumber of ['', '9001']) {
    const input = payload({ orderNumber });
    const result = await s.request('/api/warehouse/issues', 'POST', input);
    assert.equal(result.status, 201, JSON.stringify(result.value));
    assert.equal(result.value.transaction.amount, 125);
    assert.equal(result.value.transaction.account, 'В кассе');
    assert.equal(result.value.transaction.category, 'Прочее');
    assert.equal(result.value.transaction.orderNumber, orderNumber || null);
    const movement = issueRows(s.sheet(), input.requestId);
    assert.equal(movement.length, 1);
    assert.equal(movement[0][1], orderNumber ? 'Расход на заказ' : 'Списание');
    assert.equal(movement[0][8], orderNumber);
    assert.equal(movement[0][11], -1.25);
    assert.equal(expenseRows(s.sheet(), input.requestId).length, 1);
    const repeat = await s.request('/api/warehouse/issues', 'POST', input);
    assert.equal(repeat.status, 201);
    assert.equal(issueRows(s.sheet(), input.requestId).length, 1);
    assert.equal(expenseRows(s.sheet(), input.requestId).length, 1);
  }
  const after = s.sheet();
  assert.deepEqual(after['Платежи'], before['Платежи']);
  assert.deepEqual(after['Расходы'][1], before['Расходы'][1]);
  assert.equal(cash((await s.request('/api/transactions')).value.transactions), cash(beforeTransactions) - 250);
  assert.equal((await s.request('/api/warehouse')).value.items[0].used[7], 2.5);
});

for (const fault of ['lost-response', 'readback', 'before-write']) {
  test(`combined warehouse expense ${fault} keeps its receipt across restart and never writes twice`, async t => {
    const s = await sandbox(t), input = payload();
    const file = path.join(s.directory, 'warehouse-expense-fault');
    fs.writeFileSync(file, fault);
    const first = await s.request('/api/warehouse/issues', 'POST', input);
    assert.ok(first.status >= 400);
    assert.equal(issueRows(s.sheet(), input.requestId).length, fault === 'before-write' ? 0 : 1);
    assert.equal(expenseRows(s.sheet(), input.requestId).length, fault === 'before-write' ? 0 : 1);
    fs.unlinkSync(file);
    const blockedReadback = path.join(s.directory, 'refill-readback-failed');
    if (fs.existsSync(blockedReadback)) fs.unlinkSync(blockedReadback);
    await s.restart(sheet => { sheet['Склад'][1][4] = 777; }, fault === 'before-write');
    const retry = await s.request('/api/warehouse/issues', 'POST', input);
    if (fault === 'before-write') {
      assert.equal(retry.status, 409);
      assert.equal(retry.value.code, 'FINANCE_UNCONFIRMED');
      const other = await s.request('/api/warehouse/issues', 'POST', payload());
      assert.ok(other.status >= 400);
      const production = await s.request('/api/warehouse/movements', 'POST', { requestId: crypto.randomUUID(), code: 'QA-M1', quantity: 1 });
      assert.ok(production.status >= 400);
      assert.equal(issueRows(s.sheet(), input.requestId).length, 0);
      assert.equal(expenseRows(s.sheet(), input.requestId).length, 0);
    } else {
      assert.equal(retry.status, 201, JSON.stringify(retry.value));
      assert.equal(retry.value.transaction.amount, 125);
      assert.equal(issueRows(s.sheet(), input.requestId)[0][6], 100);
      assert.equal(issueRows(s.sheet(), input.requestId).length, 1);
      assert.equal(expenseRows(s.sheet(), input.requestId).length, 1);
      assert.equal((await s.request('/api/health')).value.sync.pending, 0);
    }
    const changed = await s.request('/api/warehouse/issues', 'POST', { ...input, quantity: 2 });
    assert.equal(changed.status, 409);
    assert.equal(changed.value.code, 'FINANCE_REQUEST_CHANGED');
  });
}

test('unknown order, absent material, zero quantity and insufficient stock create neither record', async t => {
  const s = await sandbox(t), before = s.sheet();
  for (const input of [payload({ orderNumber: 'missing' }), payload({ code: 'missing' }), payload({ quantity: 0 }), payload({ quantity: 1000 })]) {
    assert.ok((await s.request('/api/warehouse/issues', 'POST', input)).status >= 400);
  }
  assert.deepEqual(s.sheet(), before);
});

test('a missing warehouse price or category rejects before stock is consumed; rounding follows the financial ledger', async t => {
  const s = await sandbox(t);
  for (const price of [0, 0.1]) {
    await s.restart(sheet => { sheet['Склад'][1][4] = price; });
    const input = payload(), result = await s.request('/api/warehouse/issues', 'POST', input);
    assert.equal(result.status, 400);
    assert.equal(issueRows(s.sheet(), input.requestId).length, 0);
  }
  await s.restart(sheet => { sheet['Склад'][1][4] = 99; });
  const input = payload(), result = await s.request('/api/warehouse/issues', 'POST', input);
  assert.equal(result.status, 201);
  assert.equal(result.value.transaction.amount, 124);
  assert.equal(issueRows(s.sheet(), input.requestId)[0][7], 123.75);
  await s.restart(sheet => { sheet['Склад'][1][14] = ''; });
  assert.equal((await s.request('/api/warehouse/issues', 'POST', payload())).status, 400);
});

test('repeated and simultaneous HTTP submissions share one cash expense and movement', async t => {
  const s = await sandbox(t), input = payload();
  const results = await Promise.all(Array.from({ length: 3 }, () => s.request('/api/warehouse/issues', 'POST', input)));
  assert.ok(results.every(result => result.status === 201));
  assert.equal(issueRows(s.sheet(), input.requestId).length, 1);
  assert.equal(expenseRows(s.sheet(), input.requestId).length, 1);
});

test('definite preflight rejection retries with a fresh row after a competing stock writer', async t => {
  const s = await sandbox(t), input = payload();
  const file = path.join(s.directory, 'warehouse-expense-fault');
  fs.writeFileSync(file, 'preflight');
  assert.ok((await s.request('/api/warehouse/issues', 'POST', input)).status >= 400);
  fs.unlinkSync(file);
  const refill = { requestId: crypto.randomUUID(), code: 'QA-M1', quantity: 1 };
  assert.equal((await s.request('/api/warehouse/movements', 'POST', refill)).status, 201);
  await s.restart(sheet => { sheet['Склад'][1][4] = 9.99; });
  const result = await s.request('/api/warehouse/issues', 'POST', input);
  assert.equal(result.status, 201, JSON.stringify(result.value));
  assert.equal(result.value.transaction.amount, 12);
  assert.equal(s.sheet()['Движения склада'][1][9], `PWA:refill:${refill.requestId}`);
  assert.equal(s.sheet()['Движения склада'][2][9], `PWA:${input.requestId}`);
});

test('definite rejection revalidates available stock before retrying', async t => {
  const s = await sandbox(t), input = payload();
  const file = path.join(s.directory, 'warehouse-expense-fault');
  fs.writeFileSync(file, 'preflight');
  assert.ok((await s.request('/api/warehouse/issues', 'POST', input)).status >= 400);
  fs.unlinkSync(file);
  await s.restart(sheet => { sheet['Склад'][1][6].value = 0; });
  const result = await s.request('/api/warehouse/issues', 'POST', input);
  assert.equal(result.status, 409);
  assert.equal(issueRows(s.sheet(), input.requestId).length, 0);
  assert.equal(expenseRows(s.sheet(), input.requestId).length, 0);
});

test('replay cannot confirm a changed or missing movement even if the cash expense survived', async t => {
  const s = await sandbox(t), input = payload();
  assert.equal((await s.request('/api/warehouse/issues', 'POST', input)).status, 201);
  await s.restart(sheet => { issueRows(sheet, input.requestId)[0][7] = 999; });
  const result = await s.request('/api/warehouse/issues', 'POST', input);
  assert.equal(result.status, 409);
  assert.equal(result.value.code, 'FINANCE_CHANGED_AFTER_SAVE');
  assert.equal(expenseRows(s.sheet(), input.requestId).length, 1);
});
