import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDirectory, launch, removeDirectory } from './sandbox-lib.mjs';
import { seedPaymentSafeguards } from './payment-safeguards-fixture.mjs';

test('HTTP financial safeguards serialize simultaneous entries, acknowledge exact candidates and preserve formulas', async () => {
  const directory = createDirectory('payment-safeguards-http-'); seedPaymentSafeguards(directory);
  let instance;
  try {
    instance = await launch(directory);
    const request = async (route, method = 'GET', body) => {
      const response = await fetch(instance.base + route, { method,
        headers: { Origin: instance.base, Cookie: `finance_session=${instance.token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json() };
    };
    const original = (await request('/api/transactions')).data.transactions.find(row => row.type === 'income');
    const before = fs.readFileSync(path.join(directory, 'sheet.json'), 'utf8');
    for (const orderNumber of ['9002', '9003', '9005']) {
      const result = await request('/api/transactions', 'POST', { ...original, orderNumber, requestId: crypto.randomUUID() });
      assert.equal(result.status, 409); assert.equal(result.data.code, 'FINANCE_ORDER_PAID');
    }
    assert.equal(fs.readFileSync(path.join(directory, 'sheet.json'), 'utf8'), before, 'paid-order rejection must not write');
    const income = { ...original, requestId: crypto.randomUUID() };
    const warning = await request('/api/transactions', 'POST', income);
    assert.equal(warning.status, 409); assert.equal(warning.data.code, 'FINANCE_POSSIBLE_DUPLICATE');
    assert.equal(warning.data.duplicateWarning.matches[0].id, original.id);
    assert.equal(fs.readFileSync(path.join(directory, 'sheet.json'), 'utf8'), before, 'warning must not write');
    assert.equal((await request('/api/transactions', 'POST', { ...income, duplicateConfirmation: warning.data.duplicateWarning.confirmation })).status, 201);
    assert.equal((await request('/api/transactions', 'POST', income)).data.transaction.id, income.requestId);
    const expense = { type: 'expense', date: '2026-09-11', amount: 321, category: 'Прочее', description: 'Учебная покупка', account: 'В кассе' };
    const commands = [0, 1].map(() => ({ ...expense, requestId: crypto.randomUUID() }));
    const results = await Promise.all(commands.map(body => request('/api/transactions', 'POST', body)));
    assert.deepEqual(results.map(r => r.status).sort((a, b) => a - b), [201, 409]);
    const rejectedIndex = results.findIndex(r => r.status === 409);
    const acknowledgement = results[rejectedIndex].data.duplicateWarning.confirmation;
    assert.equal((await request('/api/transactions', 'POST', { ...commands[rejectedIndex], requestId: crypto.randomUUID(), duplicateConfirmation: acknowledgement })).status, 409);
    const created = await request('/api/transactions', 'POST', { ...commands[rejectedIndex], duplicateConfirmation: acknowledgement });
    assert.equal(created.status, 201);
    assert.equal((await request('/api/transactions', 'POST', commands[rejectedIndex])).data.transaction.id, created.data.transaction.id);
    const records = (await request('/api/transactions')).data.transactions;
    assert.equal(records.filter(row => row.amount === 321).length, 2);
    const health = (await request('/api/health')).data;
    assert.equal(health.sync.pending, 0); assert.equal(health.sync.invalidRows, 0);
    const sheet = JSON.parse(fs.readFileSync(path.join(directory, 'sheet.json')));
    const originalSheets = JSON.parse(before);
    for (const name of ['Платежи', 'Расходы']) {
      originalSheets[name].forEach((row, i) => row.forEach((value, j) => {
        if (value?.formula) assert.equal(sheet[name][i][j].formula, value.formula);
      }));
    }
  } finally { await instance?.stop(); removeDirectory(directory); }
});
