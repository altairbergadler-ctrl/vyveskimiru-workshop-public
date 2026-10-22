import test from 'node:test';
import assert from 'node:assert/strict';
import {
  performanceSlice as slice,
  performanceRows as rows,
  performanceSort as sort,
  performanceStageRows as stageRows,
  performanceOrders,
  performanceLeads,
} from '../prototypes/analytics/performance-model.mjs';
test('performance: single cohort funnel remains nested and matches actual linked orders', () => {
  const v = slice();
  assert.deepEqual(v.funnel, [109, 72, 48, 24, 19]);
  assert.equal(v.orders.length, 26);
  assert.equal(v.paid, 80450000);
  assert.equal(v.unlinked.length, 2);
  assert.equal(
    new Set(performanceOrders.map((o) => o.id)).size,
    performanceOrders.length,
  );
  for (const l of performanceLeads) {
    const linked = performanceOrders.filter((o) => o.lead === l.id);
    assert.equal(linked.length, l.rank >= 3 ? 1 : 0);
    if (l.rank === 4) assert.ok(linked[0].paid > 0);
    assert.equal(linked[0]?.ad || l.ad, l.ad);
  }
});
test('performance: products, sources and ads partition money and orders without loss', () => {
  const v = slice();
  for (const group of ['source', 'ad', 'product']) {
    const r = rows(group);
    assert.equal(
      r.reduce((s, x) => s + x.paid, 0),
      v.paid,
    );
    assert.equal(
      r.reduce((s, x) => s + x.orders.length, 0),
      v.orders.length,
    );
    assert.equal(
      r.reduce((s, x) => s + x.leads.length, 0),
      v.leads.length,
    );
    for (const x of r)
      assert.equal(
        rows('ad', x.scope).reduce((s, a) => s + a.paid, 0),
        x.paid,
      );
  }
});
test('performance: product and source filters intersect consistently; empty is not zero cost', () => {
  const v = slice({ source: 'avito', product: 'letters' });
  assert.equal(slice({ ad: 'a1' }).cpo, 300000);
  assert.equal(slice({ ad: 'a1' }).spend, 1800000);
  assert.deepEqual(v.funnel, [18, 12, 8, 3, 2]);
  assert.equal(v.orders.length, 4);
  assert.equal(v.paid, 11000000);
  assert.equal(rows('ad', { source: 'avito', product: 'letters' }).length, 2);
  assert.equal(
    rows('source', { source: 'direct', product: 'windows' }).length,
    0,
  );
  assert.equal(slice({ source: 'direct', product: 'windows' }).cr, null);
});
test('performance: unattributed orders cannot lower ad acquisition cost or inflate payback', () => {
  const v = slice({ source: 'avito', product: 'letters' });
  assert.equal(v.cpo, 480000);
  assert.equal(v.payback, 6.25);
  assert.equal(v.cr, (3 / 18) * 100);
  const unknown = slice({ ad: 'none' });
  assert.equal(unknown.orders.length, 2);
  assert.equal(unknown.paid, 3000000);
  assert.equal(unknown.cpo, null);
  assert.equal(unknown.payback, null);
});
test('performance: unknown spending blocks rates and sorts last in either direction', () => {
  const r = rows('ad'),
    unknown = r.find((x) => x.id === 'v2');
  for (const key of ['spend', 'cpl', 'cpo', 'payback'])
    assert.equal(unknown[key], null);
  assert.equal(slice({ product: 'plates' }).spend, null);
  for (const desc of [true, false]) {
    const sorted = sort(r, 'cpo', desc),
      firstNull = sorted.findIndex((x) => x.cpo == null);
    assert.ok(sorted.slice(firstNull).every((x) => x.cpo == null));
  }
});
test('performance: dropoffs partition the cohort, distinguish loss from pending and drill to exact IDs', () => {
  const v = slice({ ad: 'a1' });
  for (let i = 0; i < 4; i++) {
    assert.equal(stageRows(v, i).length, v.funnel[i]);
    assert.equal(stageRows(v, i, true).length, v.funnel[i] - v.funnel[i + 1]);
  }
  const unpaid = stageRows(v, 3, true);
  assert.equal(unpaid.length, 1);
  assert.ok(unpaid.every((l) => !l.lost));
});
