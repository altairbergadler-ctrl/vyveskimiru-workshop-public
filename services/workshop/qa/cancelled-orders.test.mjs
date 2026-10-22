import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createDirectory, launch, removeDirectory } from './sandbox-lib.mjs';
import { seedCancelledFixture } from './cancelled-fixture.mjs';

test('cancellation keeps finance history and formulas, rejects new payments, permits recovery and restoration', async () => {
  const directory = createDirectory('cancelled-http-'); seedCancelledFixture(directory);
  let instance;
  try {
    instance = await launch(directory);
    const request = async (url, method = 'GET', body) => {
      const response = await fetch(instance.base + url, { method,
        headers: { Cookie: `finance_session=${instance.token}`, Origin: instance.base, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json() };
    };
    const move = (id, status, expectedStatus) => request(`/kanban/api/orders/${id}/status`, 'PATCH', { status, expectedStatus });
    const original = (await request('/api/transactions')).data.transactions.find(t => t.type === 'income');
    const payload = { ...original, id: undefined, amount: 100, requestId: crypto.randomUUID() };
    const created = await request('/api/transactions', 'POST', payload);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const before = JSON.parse(fs.readFileSync(path.join(directory, 'sheet.json')));
    const financialBefore = (await request('/api/orders')).data.orders;
    assert.equal((await move('9001', 'Отменён', 'В работе')).status, 200);
    const after = JSON.parse(fs.readFileSync(path.join(directory, 'sheet.json')));
    before['Заказы'][1][7] = 'Отменён';
    assert.deepEqual(after, before, 'cancellation changes only status, never money or formulas');
    const financialAfter = (await request('/api/orders')).data.orders;
    assert.deepEqual(financialAfter.map(({status: _status, ...order}) => order), financialBefore.map(({status: _status, ...order}) => order));
    const rejected = await request('/api/transactions', 'POST', { ...payload, requestId: crypto.randomUUID() });
    assert.equal(rejected.status, 409); assert.equal(rejected.data.code, 'FINANCE_ORDER_CANCELLED');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'sheet.json'))), after);
    // The same confirmed request remains a success after the order is cancelled.
    assert.equal((await request('/api/transactions', 'POST', payload)).data.transaction.id, created.data.transaction.id);
    const edited = await request('/api/transactions', 'PATCH', { ...original, comment: 'QA: history retained', requestId: crypto.randomUUID() });
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    assert.equal(edited.data.transaction.orderNumber, '9001');
    assert.equal((await move('9002', 'Отменён', 'Расчёт / КП')).status, 200);
    const reassigned = await request('/api/transactions', 'PATCH', { ...edited.data.transaction, orderNumber: '9002', requestId: crypto.randomUUID() });
    assert.equal(reassigned.status, 409); assert.equal(reassigned.data.code, 'FINANCE_ORDER_CANCELLED');
    assert.equal((await request('/api/transactions', 'DELETE', { id: created.data.transaction.id, requestId: crypto.randomUUID() })).status, 200);
    assert.equal((await move('9001', 'В работе', 'Отменён')).status, 200);
    assert.equal((await request('/api/transactions', 'POST', { ...payload, requestId: crypto.randomUUID() })).status, 201);
    const health = (await request('/api/health')).data;
    assert.equal(health.sync.pending, 0); assert.equal(health.sync.invalidRows, 0);
  } finally { await instance?.stop(); removeDirectory(directory); }
});
