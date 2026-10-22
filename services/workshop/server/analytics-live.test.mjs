import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildLiveReport, LiveAnalytics } from './analytics/live.mjs';
import { CommandQueue } from './command-queue.mjs';
import { analyticsCatalog } from './analytics/categories.mjs';
import { NightlyAttribution } from './analytics/nightly-attribution.mjs';
import { aggregateResponses } from './analytics/response-times.mjs';

test('response times join by ad without orders and feed daily chart; finance facts stay unchanged', () => {
  const input = fixture();
  const original = buildLiveReport(input);
  const responses = { indexedChats: 2, ...aggregateResponses([
    { item_id:'a1',first_in:'2026-09-03T10:00:00Z',state:'answered',seconds:120 },
    { item_id:'a2',first_in:'2026-09-03T10:00:00Z',state:'waiting',seconds:null },
  ],input.period) };
  const report = buildLiveReport({...input,responses});
  assert.equal(report.rows[0].firstResponseSeconds,120);
  assert.equal(report.rows[1].firstResponseSeconds,null);
  assert.equal(report.rows[1].responseStats.waiting,1);
  assert.equal(report.daily[2].responseSecondsTotal,120);
  assert.equal(report.daily[2].responseAnswered,1);
  assert.deepEqual(report.summary,original.summary);
  assert.deepEqual(report.products,original.products);
  assert.equal(report.rows[0].confirmedOrders,0);
});

const fixture = () => ({
  confirmedLinks: [],
  period: { from: '2026-09-01', to: '2026-09-15', days: 15 },
  business: {
    clients: [
      {
        row: 2,
        name: 'Учебный клиент',
        source: 'Авито',
        createdDate: '2026-09-01',
      },
      {
        row: 3,
        name: 'Старый клиент',
        source: 'Авито',
        createdDate: '2026-08-01',
      },
    ],
    issues: [],
    orders: [
      {
        id: '1',
        title: 'Учебный заказ',
        createdDate: '2026-09-03',
        source: 'Авито',
        sourceKnown: true,
        clientRow: 2,
        status: 'В работе',
        amount: 100,
        profit: 40,
        items: [{ row: 2 }],
      },
      {
        id: '2',
        title: 'Повторный заказ',
        createdDate: '2026-09-04',
        source: 'Авито',
        sourceKnown: true,
        clientRow: 2,
        status: 'В работе',
        amount: 100,
        profit: 20,
        items: [{ row: 3 }],
      },
      {
        id: '3',
        title: 'Старый заказ',
        createdDate: '2026-08-02',
        source: 'Авито',
        sourceKnown: true,
        clientRow: 3,
        status: 'Сдан',
        amount: 100,
        profit: 30,
        items: [],
      },
    ],
  },
  finance: {
    records: [
      {
        id: 'p1',
        type: 'income',
        orderNumber: '1',
        date: '2026-09-05',
        amount: 40.01,
      },
      {
        id: 'p2',
        type: 'income',
        orderNumber: '3',
        date: '2026-09-05',
        amount: 30,
      },
    ],
  },
  catalog: {
    products: [{ id: 's1', name: 'Учебная услуга' }],
    positions: [
      { sourcePosition: 'position:1:2', productId: 's1' },
      { sourcePosition: 'position:2:3', productId: 's1' },
    ],
  },
  ads: {
    enabled: true,
    spendComplete: true,
    summary: { spending: 7000, contacts: 4, views: 40, impressions: 400 },
    rows: [
      {
        id: 'a1',
        title: 'Первое',
        metrics: { spending: 1000, contacts: 3 },
        rates: {},
      },
      {
        id: 'a2',
        title: 'Второе',
        metrics: { spending: 6000, contacts: 1 },
        rates: {},
      },
    ],
  },
  mappings: [
    { kind: 'ad', entityId: 'a1', productId: 's1' },
    { kind: 'ad', entityId: 'a2', productId: 's1' },
    { kind: 'order', entityId: '3', productId: 's1' },
  ],
});
test('live funnel deduplicates clients and counts repeated orders, receipts include older orders', () => {
  const r = buildLiveReport(fixture());
  assert.equal(r.summary.newClients, 1);
  assert.equal(r.summary.clientsWithOrders, 1);
  assert.equal(r.summary.cohortOrders, 2);
  assert.equal(r.summary.paidClients, 1);
  assert.equal(r.summary.receipts, 70.01);
  assert.equal(r.summary.profit, 60);
  assert.equal(r.summary.result, -10);
  assert.equal(r.summary.spend, 70);
  assert.equal(r.rows[0].orders, 0);
  assert.equal(r.rows[1].orders, 0);
  assert.equal(r.rows[0].result, -10);
  assert.equal(r.rows[1].result, -60);
  assert.equal(r.rows[0].orderRate, null);
  assert.equal(r.rows[0].confirmedOrders, 0);
  assert.equal(r.daily.find((d) => d.date === '2026-09-05').receipts, 70.01);
});

test('ad conversion counts confirmed orders individually, without category or finance requirements', () => {
  const f = fixture();
  f.confirmedLinks = [{orderId:'1', itemId:'a1'}, {orderId:'2', itemId:'a2'}, {orderId:'3', itemId:'a1'}];
  let r = buildLiveReport(f);
  assert.equal(r.rows[0].confirmedOrders, 1); // Old order is outside the period.
  assert(Math.abs(r.rows[0].orderRate - 100 / 3) < 1e-10);
  assert.equal(r.rows[1].orderRate, 100);
  assert.equal(r.rows[0].orders, 1); // Orders are no longer fractional allocations.
  f.finance = null;
  f.catalog = null;
  f.mappings = [];
  r = buildLiveReport(f);
  assert(Math.abs(r.rows[0].orderRate - 100 / 3) < 1e-10);
  assert.equal(r.rows[1].orderRate, 100);
  f.business.orders[1].status = 'Отменён';
  r = buildLiveReport(f);
  assert.equal(r.rows[1].confirmedOrders, 0);
  assert.equal(r.rows[1].orderRate, null);
  for (const contacts of [0, null]) {
    f.ads.rows[0].metrics.contacts = contacts;
    r = buildLiveReport(f);
    assert.equal(r.rows[0].confirmedOrders, 1);
    assert.equal(r.rows[0].orderRate, null);
  }
  f.confirmedLinks = [];
  assert(buildLiveReport(f).rows.every(a => a.confirmedOrders === 0 && a.orderRate === null));
  f.business = null;
  assert(buildLiveReport(f).rows.every(a => a.confirmedOrders === null && a.orderRate === null));
});

test('live conversion follows existing confirmation and unlink without changing nightly schedule or suggestions', async () => {
  const db = new Database(':memory:'), f = fixture();
  const base = {storage: () => db, namespace: () => 'test-account'};
  const attribution = new NightlyAttribution({base, readOrders: async () => f.business});
  try {
    attribution.db();
    db.prepare('INSERT INTO attribution_schedule VALUES(?,?)').run('test-account', 1790542800000);
    db.prepare('INSERT INTO attribution_suggestions VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run('s1','test-account','chat1','a1','Test','1','v1','["order_reference"]','["m1"]','pending','2026-09-15');
    const nightlyState = () => JSON.stringify({
      schedule: db.prepare('SELECT * FROM attribution_schedule').all(),
      runs: db.prepare('SELECT * FROM attribution_runs').all(),
      versions: db.prepare('SELECT * FROM attribution_versions').all(),
    });
    const before = nightlyState();
    const service = new LiveAnalytics({base, attribution,
      analytics: {refresh: async () => {}, sources: {orders: {data:f.business}, finance: {data:f.finance}}},
      deep: {view: () => f.ads}, readProducts: async () => ({...f.catalog, source:'production-routes'}),
      runCommand: fn => fn(), now: () => new Date('2026-09-15T12:00:00Z'),
    });
    const params = new URLSearchParams({from:f.period.from,to:f.period.to});
    let r = await service.report(params);
    assert.equal(r.rows[0].orderRate, null);
    assert.equal(r.attribution.pending.length, 1);
    assert.equal(r.rows[0].receipts, null);
    assert.equal(r.rows[0].result, -10);
    await attribution.decide({id:'s1', action:'confirm'});
    r = await service.report(params);
    assert(Math.abs(r.rows[0].orderRate - 100 / 3) < 1e-10);
    assert.equal(r.rows[0].confirmedOrders, r.attribution.facts[0].orders);
    assert.equal(r.rows[0].receipts, 40.01);
    assert.equal(r.rows[0].result, 30);
    assert.equal(r.rows[1].orderRate, null);
    await attribution.decide({id:'s1', action:'unlink'});
    r = await service.report(params);
    assert.equal(r.rows[0].orderRate, null);
    assert.equal(r.rows[0].confirmedOrders, 0);
    assert.equal(r.rows[0].receipts, null);
    assert.equal(r.rows[0].result, -10);
    assert.equal(nightlyState(), before);
    assert.equal(db.prepare('SELECT count(*) n FROM attribution_decisions').get().n, 2);
  } finally { db.close(); }
});

test('chart daily counts follow order dates, money follows payment dates and missing Avito days stay null', () => {
  const f=fixture();
  f.ads.daily=[{date:'2026-09-05',metrics:{impressions:120,views:10,contacts:2,spending:500}}];
  let r=buildLiveReport(f);
  assert.equal(r.daily.find(d=>d.date==='2026-09-03').orders,1);
  assert.equal(r.daily.find(d=>d.date==='2026-09-03').profit,40);
  const paid=r.daily.find(d=>d.date==='2026-09-05');
  assert.equal(paid.receipts,70.01);assert.equal(paid.orders,0);assert.equal(paid.profit,0);
  assert.equal(paid.impressions,120);assert.equal(paid.views,10);assert.equal(paid.spend,5);
  assert.equal(r.daily[0].impressions,null);
  f.business.orders[0].status='Отменён';r=buildLiveReport(f);
  assert.equal(r.daily.find(d=>d.date==='2026-09-03').orders,0);
  f.business=null;r=buildLiveReport(f);
  assert.equal(r.daily[0].orders,null);assert.equal(r.daily[0].profit,null);
});

test('legacy order and ad links resolve to shared category without changing receipts or manual records',()=>{
  const f=fixture(),before=buildLiveReport(f),mappings=JSON.stringify(f.mappings);
  f.catalog.products[0].name='Уличная вывеска';
  f.catalog=analyticsCatalog(f.catalog);
  const after=buildLiveReport(f);
  assert(after.rows.every(r=>r.productId==='category:signs'));
  assert(after.orders.every(o=>o.productId==='category:signs'));
  assert.equal(after.summary.receipts,before.summary.receipts);
  assert.equal(after.summary.allocated,before.summary.allocated);
  assert.equal(after.summary.profit,before.summary.profit);
  assert.equal(JSON.stringify(f.mappings),mappings);
});
test('ad money uses only confirmed orders, preserves cents, ignores categories and counts old payments separately', () => {
  const f = fixture();
  f.confirmedLinks = [{orderId:'1',itemId:'a1'}, {orderId:'3',itemId:'a1'}, {orderId:'2',itemId:'a2'}];
  let r = buildLiveReport(f);
  assert.deepEqual(r.rows.map(a => [a.orders,a.receipts,a.profit,a.result]), [[1,70.01,40,30],[1,0,20,-40]]);
  assert.equal(r.rows[0].romi,300);
  assert.equal(r.summary.allocated,70.01);
  assert.equal(r.summary.unallocated,0);
  f.mappings = [];
  f.catalog = null;
  f.ads.rows[0].metrics.contacts = null;
  r = buildLiveReport(f);
  assert.deepEqual(r.rows.map(a => [a.receipts,a.profit,a.result]), [[70.01,40,30],[0,20,-40]]);
  f.confirmedLinks = [{orderId:'3',itemId:'a1'}];
  r = buildLiveReport(f);
  assert.deepEqual([r.rows[0].orders,r.rows[0].receipts,r.rows[0].profit,r.rows[0].result], [0,30,0,-10]);
  assert.equal(r.summary.unallocated,40.01);
  assert.equal(r.rows[1].receipts,null);
  f.finance = null;
  r = buildLiveReport(f);
  assert.equal(r.rows[0].receipts,null);
  assert.equal(r.summary.allocated,null);
});

test('partial expenses never produce category or channel profit/ROMI and zero costs stay valid', () => {
  const f = fixture();
  f.ads.rows[1].metrics.spending = null;
  f.ads.rows[1].metrics.contacts = null;
  f.ads.spendComplete = false;
  const r = buildLiveReport(f);
  assert.equal(r.products[0].spend,10);
  assert.equal(r.products[0].spendComplete,false);
  assert.equal(r.products[0].contacts,null);
  assert.equal(r.products[0].result,null);
  assert.equal(r.summary.spendComplete,false);
  assert.equal(r.summary.result,null);
  assert.equal(r.summary.romi,null);
  assert.equal(r.summary.roas,null);
  f.ads.rows[1].metrics.spending = 0;
  f.ads.spendComplete = true;
  const complete = buildLiveReport(f);
  assert.equal(complete.products[0].spendComplete,true);
  assert.equal(complete.products[0].result,50);
});

test('unknown linked profit stays unknown; absent or cancelled orders count zero confirmed profit', () => {
  const f = fixture();
  f.confirmedLinks = [{orderId:'1',itemId:'a1'}, {orderId:'missing',itemId:'a2'}];
  f.business.orders[0].profit = null;
  let r = buildLiveReport(f);
  assert.equal(r.rows[0].receipts,40.01);
  assert.equal(r.rows[0].result,null);
  assert.equal(r.rows[0].romi,null);
  assert.equal(r.rows[1].receipts,null);
  assert.equal(r.rows[1].result,-60);
  f.business.orders[0].status='Отменён';
  r=buildLiveReport(f);
  assert.equal(r.rows[0].receipts,null);
  assert.equal(r.rows[0].profit,0);
  assert.equal(r.rows[0].result,-10);
});

test('unknown contacts, absent costs, missing service and incomplete finance never manufacture profit', () => {
  const f = fixture();
  f.ads.rows[1].metrics.contacts = null;
  let r = buildLiveReport(f);
  assert.deepEqual(r.rows.map(a => a.result), [-10, -60]);
  assert.equal(r.summary.unallocated, 70.01);
  f.ads.rows[1].metrics.contacts = 1;
  f.business.orders[0].profit = null;
  r = buildLiveReport(f);
  assert.equal(r.summary.profit, null);
  assert.deepEqual(r.rows.map(a => a.result), [-10, -60]);
  f.business.orders[0].profit = 40;
  f.catalog.positions = [];
  r = buildLiveReport(f);
  assert.equal(r.summary.unassignedOrders, 2);
  assert.deepEqual(r.rows.map(a => a.result), [-10, -60]);
  f.finance = null;
  r = buildLiveReport(f);
  assert.equal(r.summary.receipts, null);
  assert.equal(r.summary.unallocated, null);
});
test('zero contacts and spend avoid divisions by zero; missing sources and cancelled orders stay outside funnel', () => {
  const f = fixture();
  f.ads.summary.spending = 0;
  f.ads.rows.forEach((a) => (a.metrics.contacts = 0));
  f.business.orders[1].status = 'Отменён';
  f.business.orders[2].sourceKnown = false;
  f.business.orders[2].source = 'Не определён';
  const r = buildLiveReport(f);
  assert.equal(r.summary.orders, 1);
  assert.equal(r.summary.cohortOrders, 1);
  assert.equal(r.summary.romi, null);
  assert.deepEqual(r.rows.map(a => a.result), [-10, -60]);
  assert.equal(r.summary.receipts, 40.01);
  assert.equal(r.quality.unknownPaymentSource, 30);
});
test('explicit order mapping overrides automatic route, unmapped multi-service orders are never guessed', () => {
  const f = fixture();
  f.catalog.products.push({ id: 's2', name: 'Другая' });
  f.catalog.positions.push({ sourcePosition: 'position:1:4', productId: 's2' });
  f.business.orders[0].items.push({ row: 4 });
  let r = buildLiveReport(f);
  assert.equal(r.orders.find((o) => o.id === '1').productId, null);
  f.mappings.push({ kind: 'order', entityId: '1', productId: 's2' });
  r = buildLiveReport(f);
  assert.equal(r.orders.find((o) => o.id === '1').productId, 's2');
  f.mappings.at(-1).productId = null;
  r = buildLiveReport(f);
  assert.equal(r.orders.find((o) => o.id === '1').productId, null);
});
test('link persistence is account-scoped, replay safe, rejects stale revisions and unknown entities', async () => {
  const db = new Database(':memory:'),
    queue = new CommandQueue();
  let account = 'one';
  const make = () =>
    new LiveAnalytics({
      base: {
        storage: () => db,
        namespace: () => account,
        currentPeriod: () => ({}),
      },
      deep: { view: () => ({ rows: [{ id: 'a1' }] }) },
      readProducts: async () => ({
        source: 'production-routes',
        products: [{ id: 's1' }, { id: 's2' }],
      }),
      readOrders: async () => ({ orders: [], statuses: [] }),
    });
  try {
    const service = make(),
      input = {
        kind: 'ad',
        entityId: 'a1',
        productId: 's1',
        expectedRevision: 0,
      };
    const results = await Promise.allSettled([
      queue.run(() => service.save(input)),
      queue.run(() => service.save({ ...input, productId: 's2' })),
    ]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].reason.code, 'LINK_CONFLICT');
    assert.deepEqual(await service.save(input), { saved: true, revision: 1 });
    assert.equal(
      db
        .prepare('SELECT count(*) AS n FROM analytics_service_link_history')
        .get().n,
      1,
    );
    assert.equal(make().mappings()[0].productId, 's1');
    account = 'two';
    assert.deepEqual(make().mappings(), []);
    account = 'one';
    await assert.rejects(service.save({ ...input, entityId: 'unknown' }), {
      code: 'ENTITY_MISSING',
    });
    await assert.rejects(service.save({ ...input, productId: 'missing' }), {
      code: 'PRODUCT_MISSING',
    });
    await service.save({ ...input, productId: null, expectedRevision: 1 });
    assert.equal(service.mappings()[0].revision, 2);
  } finally {
    db.close();
  }
});


test('zero confirmed orders subtract known spend without inventing receipts; unavailable sources remain unknown', () => {
  const f = fixture();
  f.ads.rows[0].metrics.spending = 216023;
  f.ads.rows[1].metrics.spending = 0;
  let r = buildLiveReport(f);
  assert.deepEqual(r.rows.map(a => [a.profit, a.result, a.romi, a.receipts]), [[0,-2160.23,-100,null],[0,0,null,null]]);
  f.ads.rows[0].metrics.spending = null;
  r = buildLiveReport(f);
  assert.equal(r.rows[0].result, null);
  assert.equal(r.rows[0].romi, null);
  f.ads.rows[0].metrics.spending = 216023;
  f.confirmedLinks = null;
  r = buildLiveReport(f);
  assert(r.rows.every(a => a.profit === null && a.result === null && a.confirmedOrders === null));
  f.confirmedLinks = [];
  f.business = null;
  r = buildLiveReport(f);
  assert(r.rows.every(a => a.profit === null && a.result === null && a.confirmedOrders === null));
});
