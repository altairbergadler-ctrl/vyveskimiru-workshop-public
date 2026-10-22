import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDirectory, launch, removeDirectory } from './sandbox-lib.mjs';

test('HTTP income is automatically received on every account and cannot be unchecked by old clients', async () => {
  const directory = createDirectory('automatic-cash-');
  let instance;
  try {
    instance = await launch(directory);
    const request = async (route, method = 'GET', body) => {
      const response = await fetch(instance.base + route, { method,
        headers: { Origin: instance.base, Cookie: `finance_session=${instance.token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json() };
    };
    for (const [index, account] of ['В кассе', 'Банк'].entries()) {
      const payload = { type: 'income', category: 'Замеры', date: '2026-09-23', amount: 123 + index,
        account, cashInRegister: false, requestId: crypto.randomUUID() };
      const created = await request('/api/transactions', 'POST', payload);
      assert.equal(created.status, 201);
      assert.equal(created.data.transaction.cashInRegister, true);
      assert.equal(created.data.transaction.account, account);
      const replay = await request('/api/transactions', 'POST', payload);
      assert.equal(replay.data.transaction.id, created.data.transaction.id);
      const edited = await request('/api/transactions', 'PATCH', { ...created.data.transaction,
        amount: 223 + index, cashInRegister: false, requestId: crypto.randomUUID(), expectedHash: created.data.transaction.sheetHash });
      assert.equal(edited.status, 200);
      assert.equal(edited.data.transaction.cashInRegister, true);
      const sheet = JSON.parse(fs.readFileSync(path.join(directory, 'sheet.json')));
      const row = sheet['Платежи'].find(row => row[12] === created.data.transaction.id);
      assert.equal(row[11], true, 'Google input is true, not only the API projection');
    }
    const obsolete = await request('/api/transactions/cash-register', 'PATCH', {
      id: '11111111-1111-4111-8111-111111111111', cashInRegister: false });
    assert.equal(obsolete.status, 404, 'retired action is not callable');
    const board = (await request('/kanban/api/board')).data;
    assert.ok(board.orders.length);
    const payment = board.orders[0].payments[0];
    assert.ok(!JSON.stringify(payment.edit).includes('cashInRegister'));
    const edited = await request('/kanban/api/records/payment', 'PATCH', {
      record: payment.edit.record, changes: { comment: 'Automatic receipt QA' } });
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    const ledger = (await request('/api/transactions')).data.transactions;
    assert.equal(ledger.filter(row => row.category === 'Замеры').length, 2);
    assert.equal((await request('/api/health')).data.sync.pending, 0);
  } finally { await instance?.stop(); removeDirectory(directory); }
});
