import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAdvertisingReport } from './analytics/advertising-metrics.mjs';
import { buildLiveReport } from './analytics/live.mjs';

function fixture() {
  const items = Array.from({ length: 58 }, (_, i) => ({
    id: String(i + 1), title: `Fictional ad ${i + 1}`, status: i < 30 ? 'active' : 'old',
  }));
  const report = {
    dateFrom: '2026-09-01', dateTo: '2026-09-28', grouping: 'item',
    pagination: { offset: 0, total: 30, complete: true, nextOffset: null },
    groups: items.slice(0, 30).map(i => ({ sourceGroupId: i.id, metrics: { spending: 10000 } })),
  };
  return { items, report };
}

function calculate({ items, report }) {
  const snapshot = (kind, payload) => ({
    kind, payload: JSON.stringify(payload), date_from: '2026-09-01', date_to: '2026-09-28',
    loaded_at: '2026-09-28T12:00:00Z', run_id: 'fixture',
  });
  const ads = buildAdvertisingReport({
    period: { dateFrom: '2026-09-01', dateTo: '2026-09-28' },
    snapshots: [snapshot('inventory', { items }), ...(report ? [snapshot('items', report)] : [])],
    versions: [], jobs: [], failures: [], notes: [], now: Date.parse('2026-09-28T12:01:00Z'),
    automatic: false,
  });
  const live = buildLiveReport({
    ads, period: { from: '2026-09-01', to: '2026-09-28', days: 28 },
    business: { clients: [], orders: [{ id: 'order', source: 'Авито', status: 'В работе',
      createdDate: '2026-09-02', profit: 5000, items: [] }] },
    finance: { records: [{ type: 'income', orderNumber: 'order', date: '2026-09-03', amount: 6000 }] },
    catalog: { products: [{ id: 'signs' }, { id: 'archive' }] },
    mappings: [{ kind: 'order', entityId: 'order', productId: 'signs' },
      ...items.map(i => ({ kind: 'ad', entityId: i.id, productId: i.id === '58' ? 'archive' : 'signs' }))],
    confirmedLinks: [],
  });
  return { ads, live };
}

test('complete period with 30 reported ads and 28 catalog-only ads restores channel and category totals', () => {
  const { ads, live } = calculate(fixture());
  assert.equal(ads.reportedItems, 30);
  assert.equal(ads.inventoryItems, 58);
  assert.equal(ads.spendComplete, true);
  assert.equal(live.summary.spendComplete, true);
  assert.equal(live.summary.spend, 3000);
  assert.equal(live.summary.result, 2000);
  assert.equal(live.summary.roas, 2);
  assert.equal(live.summary.romi, 2000 / 3000 * 100);
  assert.equal(live.products[0].result, 2000);
  assert.equal(live.products[1].spend, 0);
  assert.equal(live.products[1].spendComplete, true);
  assert(live.rows.slice(30).every(r => r.spend === null));
  assert(live.rows.every(r => r.receipts === null && r.result === (r.spend == null ? null : -r.spend)));
});

test('incomplete pagination, mismatched period, duplicate groups and unknown costs keep derived totals unavailable', () => {
  const changes = [
    f => { f.report.pagination.complete = false; },
    f => { f.report.pagination.offset = 1000; },
    f => { f.report.pagination.total = 31; },
    f => { f.report.pagination.nextOffset = 1000; },
    f => { f.report.dateTo = '2026-09-27'; },
    f => { f.report.dateFrom = '2026-08-01'; },
    f => { f.report.grouping = 'day'; },
    f => { delete f.report.pagination; },
    f => { f.report.groups[1].sourceGroupId = f.report.groups[0].sourceGroupId; },
    f => { f.report.groups[0].metrics.spending = null; },
    f => { f.report = null; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f);
    const { ads, live } = calculate(f);
    assert.equal(ads.spendComplete, false);
    assert.equal(live.summary.spendComplete, false);
    assert.equal(live.summary.result, null);
    assert.equal(live.summary.romi, null);
    assert.equal(live.summary.roas, null);
    assert(live.products.every(p => !p.spendComplete && p.result === null));
  }
});

test('explicit zero period costs remain valid without manufacturing ratios or per-ad attribution', () => {
  const f = fixture();
  for (const group of f.report.groups) group.metrics.spending = 0;
  const { live } = calculate(f);
  assert.equal(live.summary.spendComplete, true);
  assert.equal(live.summary.spend, 0);
  assert.equal(live.summary.result, 5000);
  assert.equal(live.summary.romi, null);
  assert.equal(live.summary.roas, null);
  assert(live.rows.every(r => r.receipts === null));
});
