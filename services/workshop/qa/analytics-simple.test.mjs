import test from 'node:test';
import assert from 'node:assert/strict';
import {
  simpleSeed,
  simpleRows,
  simplePaid,
  simpleAssign,
  simpleLink,
  simpleCreate,
} from '../prototypes/analytics/simple-model.mjs';
import { orders } from '../prototypes/analytics/model.mjs';

test('simple: orders without inquiries contribute money and unknown ads remain inside source', () => {
  const db = simpleSeed(),
    avito = simpleRows(db).find((r) => r.key === 'avito');
  assert.equal(avito.paid, 15000000);
  assert.equal(avito.orders.length, 3);
  assert.equal(
    simpleRows(db, 'avito').find((r) => r.key === 'none').paid,
    3000000,
  );
  assert.equal(
    simpleRows(db).reduce((s, r) => s + r.paid, 0),
    24000000,
  );
  for (const r of simpleRows(db)) {
    const children = simpleRows(db, r.key);
    assert.equal(
      children.reduce((s, x) => s + x.paid, 0),
      r.paid,
    );
    assert.equal(
      children.reduce((s, x) => s + x.orders.length, 0),
      r.orders.length,
    );
    assert.equal(
      children.reduce((s, x) => s + x.leads, 0),
      r.leads,
    );
  }
});
test('simple: reattribution moves money once, preserves payments and clears incompatible ad', () => {
  const db = simpleSeed(),
    next = simpleAssign(db, ['O101', 'O106'], 'vk');
  assert.equal(simpleRows(next).find((r) => r.key === 'vk').paid, 10000000);
  assert.equal(next.orders.find((o) => o.id === 'O101').ad, null);
  assert.deepEqual(next.payments, db.payments);
  assert.deepEqual(next.links, db.links);
  assert.equal(db.orders.find((o) => o.id === 'O101').source, 'avito');
  assert.throws(() => simpleAssign(db, ['missing'], 'vk'));
  assert.throws(() => simpleAssign(db, ['O101'], 'invalid'));
});
test('simple: manual linkage transfers source/ad, is idempotent and does not duplicate money', () => {
  const db = simpleSeed(),
    next = simpleLink(db, 'L05', 'O106');
  assert.equal(next.orders.find((o) => o.id === 'O106').source, 'vk');
  assert.equal(next.orders.find((o) => o.id === 'O106').ad, 'v1');
  assert.deepEqual(simpleLink(next, 'L05', 'O106'), next);
  assert.equal(
    simpleRows(next).reduce((s, r) => s + r.paid, 0),
    24000000,
  );
  const alternate = simpleLink(db, 'L02', 'O101');
  assert.equal(
    simpleRows(alternate, 'avito').find((r) => r.key === 'a1').paid,
    0,
  );
  assert.equal(
    simpleRows(alternate, 'avito').find((r) => r.key === 'a2').paid,
    12000000,
  );
});
test('simple: create requires exact money, transfers attribution without inventing a payment', () => {
  const db = simpleSeed(),
    next = simpleCreate(db, 'L05', '12500,25');
  const o = next.orders.at(-1);
  assert.deepEqual(
    [o.id, o.customer, o.source, o.ad, o.amount],
    ['D201', 'c4', 'vk', 'v1', 1250025],
  );
  assert.equal(simplePaid(next, o.id), 0);
  assert.equal(simpleCreate(next, 'L05', '1').orders.at(-1).id, 'D202');
  assert.deepEqual(next.payments, db.payments);
  for (const invalid of [
    '',
    '0',
    '-1',
    '12.345',
    '1e4',
    'Infinity',
    '100000000',
  ])
    assert.throws(() => simpleCreate(db, 'L05', invalid));
  assert.equal(orders.length, 5, 'earlier concepts remain immutable');
  assert.equal(simpleSeed().orders.length, 7);
});
