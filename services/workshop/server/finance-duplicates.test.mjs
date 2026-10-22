import test from 'node:test';
import assert from 'node:assert/strict';
import { duplicateWarning } from './finance-duplicates.mjs';

const expense = { id: 'a', sheetHash: 'one', type: 'expense', date: '2026-09-11', amount: 1500,
  category: 'Зарплата', account: 'В кассе', counterparty: 'Анна', description: 'Смена', orderNumber: null };
const check = (wanted, record) => duplicateWarning(wanted, [record], 'command');

test('expense warnings compare date boundary, amount and context, retaining distinct recipients', () => {
  assert.ok(check(expense, { ...expense, date: '2026-09-08', counterparty: ' АННА ' }));
  assert.ok(check(expense, { ...expense, account: 'Банк' }));
  assert.ok(check({ ...expense, counterparty: null }, { ...expense, description: 'Оплата смены' }));
  for (const patch of [{ date: '2026-09-07' }, { date: '2026-09-15' }, { date: 'invalid' },
    { amount: 1501 }, { category: 'Аренда' }, { counterparty: 'Борис' }, { type: 'income' }]) {
    assert.equal(check(expense, { ...expense, ...patch }), null);
  }
});

test('income warnings require the same order; measurements stay independent of order payments', () => {
  const income = { ...expense, type: 'income', category: 'Предоплата', orderNumber: '12' };
  assert.ok(check(income, { ...income, account: 'Банк', category: 'Доплата' }));
  assert.equal(check(income, { ...income, orderNumber: '13' }), null);
  const measurement = { ...income, category: 'Замеры', orderNumber: null, counterparty: null };
  assert.ok(check(measurement, { ...measurement, date: '2026-09-10' }));
  assert.equal(check(measurement, income), null);
});

test('acknowledgement covers the exact command and every candidate, with bounded display', () => {
  const records = Array.from({ length: 7 }, (_, i) => ({ ...expense, id: String(i) }));
  const warning = duplicateWarning(expense, records, 'first-command');
  assert.equal(warning.matches.length, 5); assert.equal(warning.total, 7);
  assert.equal(duplicateWarning(expense, [...records].reverse(), 'first-command').confirmation, warning.confirmation);
  assert.notEqual(duplicateWarning(expense, records, 'second-command').confirmation, warning.confirmation);
  records[6].sheetHash = 'changed';
  assert.notEqual(duplicateWarning(expense, records, 'first-command').confirmation, warning.confirmation);
});
