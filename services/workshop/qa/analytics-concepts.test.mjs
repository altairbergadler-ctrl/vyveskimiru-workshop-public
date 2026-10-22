import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultState,
  select,
  normalizeState,
} from '../prototypes/analytics/model.mjs';
import { preview } from './analytics-concepts-preview.mjs';

test('Concepts: several leads share one order and payments never multiply', () => {
  const v = select(defaultState);
  assert.equal(v.rows.length, 5);
  assert.equal(v.converted, 3);
  assert.equal(v.connected.length, 2);
  assert.equal(v.paidTotal, 12000000);
  assert.equal(v.orderTotal, 18000000);
  const a1 = select({ ...defaultState, ad: 'a1' }),
    a2 = select({ ...defaultState, ad: 'a2' });
  assert.ok(
    a1.paidTotal + a2.paidTotal > v.paidTotal,
    'ad slices overlap and cannot be summed',
  );
});
test('Concepts: one lead can produce two orders without conversion exceeding 100%', () => {
  const v = select({ ...defaultState, source: 'direct' });
  assert.equal(v.rows.length, 1);
  assert.equal(v.connected.length, 2);
  assert.equal(v.conversion, 100);
  assert.equal(v.paidTotal, 8000000);
  assert.equal(v.metrics.spending, null);
  assert.equal(v.spendOrder, null);
});
test('Concepts: ambiguous links stay visible but never bring money into an unknown source', () => {
  const v = select({ ...defaultState, source: 'unknown' });
  assert.equal(v.rows.length, 1);
  assert.equal(v.edges.length, 1);
  assert.equal(v.edges[0].confirmed, false);
  assert.equal(v.paidTotal, 0);
  assert.equal(v.connected.length, 0);
});
test('Concepts: absent data, genuine zero, empty denominator and immature cohort are different', () => {
  const zero = select({ ...defaultState, ad: 'a3' }),
    missing = select({ ...defaultState, source: 'telegram' });
  assert.equal(zero.metrics.spending, 0);
  assert.equal(zero.metrics.contacts, 0);
  assert.equal(zero.rates.costContact, null);
  assert.equal(missing.metrics.spending, null);
  assert.equal(missing.conversion, null);
  assert.equal(select({ ...defaultState, period: 'recent' }).spendOrder, null);
});
test('Concepts: saved contexts cannot leave invisible ads or leads selected', () => {
  const s = normalizeState({
    ...defaultState,
    source: 'vk',
    ad: 'a1',
    focus: 'L01',
    order: 'O101',
    compare: 'invalid',
  });
  assert.equal(s.ad, 'all');
  assert.equal(s.focus, null);
  assert.equal(s.order, null);
  assert.deepEqual(s.compare, []);
  const all = select({ ...defaultState, source: 'all' });
  assert.equal(all.paidTotal, 20000000);
  assert.equal(all.connected.length, 4);
});
test('Concept preview only serves its allowlist; production files and APIs are unavailable', async () => {
  const server = await preview(0),
    base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of [
      '/api/analytics/overview',
      '/.env',
      '/package.json',
      '/server/index.mjs',
      '/../CHECKPOINT.md',
    ])
      assert.equal((await fetch(base + path)).status, 404);
    assert.equal((await fetch(base + '/', { method: 'POST' })).status, 404);
    const response = await fetch(base + '/');
    assert.equal(response.status, 200);
    assert.ok(
      response.headers
        .get('content-security-policy')
        .includes("connect-src 'self'"),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
