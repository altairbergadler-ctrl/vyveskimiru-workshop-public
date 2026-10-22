import test from 'node:test';
import assert from 'node:assert/strict';
import {
  realModel,
  realSlice,
  realRows,
  productFromNames,
} from '../prototypes/analytics/real-model.mjs';
import { realFixture as f } from './analytics-real-fixture.mjs';
const model = () => realModel(f.ads, f.business, f.inquiries, f.catalog);
test('real: actual quantities preserve zero and missing, missing coverage has labelled known subtotal', () => {
  const v = realSlice(model());
  assert.equal(v.spend, null);
  assert.equal(v.known.spend, 100000);
  assert.equal(v.costContact, null);
  assert.equal(realSlice(model(), { ad: '2' }).spend, 0);
  assert.equal(realSlice(model(), { ad: '2' }).costContact, null);
  assert.equal(realSlice(model(), { ad: '1' }).costContact, 25000);
});
test('real: candidates and customer source never attribute orders, revenue or sales stages', () => {
  const m = model(),
    v = realSlice(m, { ad: '1' });
  assert.equal(v.paid, null);
  assert.equal(v.cpo, null);
  assert.equal(v.attributedOrders, null);
  assert.deepEqual(v.salesFunnel, [1, null, null, null, null]);
  const sources = realRows(m, 'source');
  assert.equal(sources[0].paid, null);
  assert.equal(sources[0].orders.length, 0);
  assert.equal(sources[1].paid, 400000);
  assert.equal(
    realRows(m, 'ad').reduce((n, r) => n + r.orders.length, 0),
    0,
  );
});
test('real: order products partition orders and money, mixed orders never split or duplicate payments', () => {
  const m = model(),
    rows = realRows(m, 'product');
  assert.equal(
    rows.reduce((s, r) => s + (r.paid ?? 0), 0),
    400000,
  );
  assert.equal(
    rows.reduce((s, r) => s + r.orders.length, 0),
    2,
  );
  assert.equal(rows.find((r) => r.id === 'mixed').paid, 300000);
  assert.equal(productFromNames(['Без категории']), 'unknown');
  assert.equal(
    productFromNames(['Табличка', 'Вывеска'], f.catalog.products),
    'mixed',
  );
  assert.deepEqual(realSlice(m).orderFunnel, [2, 2, 1]);
});
test('real: failed sources are not zero activity and ad search does not invent business linkage', () => {
  const m = realModel(f.ads, null, null);
  assert.equal(realSlice(m).paid, null);
  assert.deepEqual(realSlice(m).salesFunnel, [null, null, null, null, null]);
  assert.deepEqual(realSlice(m).orderFunnel, [null, null, null]);
  assert.equal(realSlice(model(), { query: 'Вывески' }).paid, null);
});

test('real: new route products are visible before their first sale; names alone never attach ads', () => {
  const catalog = structuredClone(f.catalog);
  catalog.products.push({ id: 'new-route', name: 'Новая продукция <пример>' });
  const m = realModel(f.ads, f.business, f.inquiries, catalog);
  assert.equal(
    realRows(m, 'product').find((r) => r.id === 'new-route').orders.length,
    0,
  );
  assert.ok(m.ads.every((a) => a.product === 'unknown'));
  const ambiguous = [
    { id: 'a', name: 'Вывеска' },
    { id: 'b', name: 'Вывеска' },
  ];
  assert.equal(productFromNames(['Вывеска'], ambiguous), 'unknown');
  assert.equal(
    productFromNames(['Вывеска с подсветкой'], f.catalog.products),
    'unknown',
  );
});
