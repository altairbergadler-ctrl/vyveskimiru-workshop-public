import test from 'node:test';
import assert from 'node:assert/strict';
import {
  periodFrom,
  businessToday,
  connections,
} from './analytics/contracts.mjs';
import {
  projectFinance,
  projectOrders,
  projectProduction,
  projectWarehouse,
  sumMoney,
  cents,
} from './analytics/metrics.mjs';
import { AnalyticsService } from './analytics/service.mjs';
import { parseWarehouse } from './warehouse.mjs';
import { fixtures } from '../qa/fixtures.mjs';

const params = (extra = '') =>
  new URLSearchParams(`from=2026-09-01&to=2026-09-08${extra}`);
const payment = (id, amount, date = '2026-09-06', extra = {}) => ({
  id,
  amount,
  date,
  type: 'income',
  account: 'Учебная касса',
  category: 'Оплата заказа',
  orderNumber: 'QA-1',
  ...extra,
});
const order = (id, extra = {}) => ({
  id,
  title: `Учебный заказ ${id}`,
  status: 'В работе',
  createdDate: '2026-09-01',
  dueDate: '2026-09-05',
  amount: 1000,
  paid: 700,
  debt: 300,
  profit: 800,
  contacts: [
    {
      source: 'Авито',
      phone: 'private-phone',
      email: 'private@example.invalid',
    },
  ],
  items: [{ name: 'Учебное изделие', amount: 1000, quantity: 1, unit: 'шт' }],
  installations: [],
  ...extra,
});
function harness() {
  let now = new Date('2026-09-08T12:00:00Z');
  const values = {
    finance: {
      records: [
        payment('p1', 400),
        payment('p2', 300),
        payment('p3', 125, '2026-09-03', {
          orderNumber: null,
          category: 'Замеры',
        }),
        payment('e1', 90, '2026-09-04', {
          type: 'expense',
          category: 'Реклама и продвижение',
        }),
        payment('old', 50, '2026-08-30'),
      ],
      missingIds: [],
    },
    orders: {
      statuses: ['В работе', 'Сдан', 'Отменён'],
      warnings: [],
      orders: [
        order('QA-1'),
        order('QA-2', { status: 'Отменён', amount: 9999 }),
        order('QA-3', {
          createdDate: '2026-08-20',
          status: 'Сдан',
          debt: -10,
          contacts: [],
        }),
      ],
    },
    production: {
      today: '2026-09-08',
      tasks: [
        {
          orderNumber: 'QA-1',
          completed: false,
          availability: 'можно',
          overdue: true,
        },
        { orderNumber: 'QA-2', completed: false },
        { orderNumber: 'QA-3', completed: false },
      ],
    },
    warehouse: {
      items: [
        {
          sku: 'QA-M1',
          name: 'Учебный пластик',
          stock: 5,
          minStock: 3,
          reserved: 4,
          unit: 'шт',
        },
      ],
    },
  };
  const calls = {},
    failed = new Set();
  const readers = Object.fromEntries(
    Object.keys(values).map((id) => [
      id,
      async () => {
        calls[id] = (calls[id] || 0) + 1;
        if (failed.has(id)) throw new Error('PRIVATE_PROVIDER_BODY_SECRET');
        return structuredClone(values[id]);
      },
    ]),
  );
  const service = new AnalyticsService({ readers, now: () => now });
  return {
    service,
    values,
    calls,
    failed,
    advance: (ms) => {
      now = new Date(now.getTime() + ms);
    },
  };
}
test('analytics period uses inclusive calendar days and Moscow today without shifting historical dates', () => {
  assert.equal(businessToday(new Date('2026-09-07T21:05:00Z')), '2026-09-08');
  assert.deepEqual(
    periodFrom(params(), new Date('2026-09-08T12:00:00Z')).previous,
    { from: '2026-08-24', to: '2026-08-31' },
  );
  for (const query of [
    'from=2026-02-30&to=2026-03-01',
    'from=2026-09-09',
    'from=2025-01-01',
    'from=2026-09-02&to=2026-09-01',
    'from=2026-09-01&from=2026-09-02',
    'sql=select',
    'refresh=true',
  ])
    assert.throws(
      () =>
        periodFrom(
          new URLSearchParams(query),
          new Date('2026-09-08T12:00:00Z'),
        ),
      { code: 'ANALYTICS_PERIOD' },
    );
});
test('analytics money preserves zero and cents; missing, fractional scales and overflow remain unavailable', () => {
  assert.equal(
    sumMoney([0, 0.1, 0.2], (x) => x),
    0.3,
  );
  assert.equal(
    sumMoney([], (x) => x),
    0,
  );
  assert.equal(
    sumMoney([0, null], (x) => x),
    null,
  );
  assert.equal(cents(0.001), null);
  assert.equal(cents('2'), null);
  assert.equal(
    sumMoney([90_000_000_000_000, 90_000_000_000_000], (x) => x),
    null,
  );
});
test('business projections strip contacts, editing commands, notes and arbitrary profile fields', () => {
  const value = projectOrders({
    statuses: ['В работе'],
    orders: [
      order('QA-1', { comment: 'SECRET_NOTE', edit: { fields: ['secret'] } }),
    ],
  });
  assert.equal(value.orders[0].source, 'Авито');
  for (const text of [
    'SECRET',
    'private',
    'email',
    'phone',
    'edit',
    'contacts',
  ])
    assert.equal(JSON.stringify(value).includes(text), false);
  const financial = projectFinance({
    records: [
      payment('p', 100, '2026-09-01', {
        comment: 'secret',
        description: 'secret',
        counterparty: 'secret',
      }),
    ],
  });
  assert.equal(JSON.stringify(financial).includes('secret'), false);
});
test('missing or ambiguous client sources stay unknown and formula gaps are not converted to zero', () => {
  const value = projectOrders({
    statuses: [],
    orders: [
      order('QA-1', { contacts: [] }),
      order('QA-2', {
        contacts: [{ source: 'Авито' }, { source: 'Авито' }],
        amount: null,
      }),
      order('QA-3', { createdDate: '' }),
    ],
  });
  assert.equal(value.orders[0].source, 'Не определён');
  assert.equal(value.orders[1].sourceKnown, false);
  assert.equal(value.orders[1].amount, null);
  assert.deepEqual(
    value.issues.map((i) => i.code),
    ['order_dates', 'order_formulas'],
  );
});
test('duplicate order/payment IDs and missing financial IDs reject the source rather than inflate totals', () => {
  assert.throws(
    () =>
      projectOrders({ statuses: [], orders: [order('same'), order('same')] }),
    { code: 'ANALYTICS_ORDER_ID' },
  );
  assert.throws(() => projectFinance({ records: [], missingIds: [{}] }), {
    code: 'ANALYTICS_FINANCE_INCOMPLETE',
  });
  assert.throws(
    () => projectFinance({ records: [payment('same', 1), payment('same', 2)] }),
    { code: 'ANALYTICS_FINANCE_INVALID' },
  );
  assert.throws(
    () => projectFinance({ records: [payment('a', 1, '2026-02-30')] }),
    { code: 'ANALYTICS_FINANCE_INVALID' },
  );
});
test('separate payment and order aggregations avoid fanout; cancellations, measurements, debt and periods have distinct bases', async () => {
  const { service } = harness(),
    report = await service.report(params());
  assert.equal(report.overview.finance.income, 825);
  assert.equal(report.overview.finance.expense, 90);
  assert.equal(report.overview.finance.net, 735);
  assert.equal(report.overview.finance.measurements, 125);
  assert.equal(report.overview.finance.advertisingPayments, 90);
  assert.equal(report.overview.previousFinance.income, 50);
  assert.equal(report.overview.orders.count, 1);
  assert.equal(report.overview.orders.cancelled, 1);
  assert.equal(report.overview.orders.amount, 1000);
  assert.equal(report.overview.orders.profit, 800);
  assert.equal(report.overview.current.debt, 300);
  assert.equal(report.overview.current.overpayments, 10);
  assert.equal(report.orders.statusesTotal, 2);
  assert.equal(report.orders.rows.length, 2);
  assert.equal(report.operations.production.open, 1);
  assert.equal(report.operations.production.overdue, 1);
  assert.equal(report.operations.warehouse.attention, 1);
  assert.equal(report.acquisition.manualSources[0].amount, 1000);
  assert.equal(report.acquisition.advertising, null);
  assert.equal(report.acquisition.romi, null);
  assert.equal(
    report.finance.daily.reduce((n, r) => n + r.income, 0),
    report.overview.finance.income,
  );
});
test('true zero activity differs from unavailable sources and unknown average', async () => {
  const { service, values } = harness();
  values.finance.records = [];
  values.orders.orders = [];
  const report = await service.report(params());
  assert.equal(report.overview.finance.income, 0);
  assert.equal(report.overview.orders.count, 0);
  assert.equal(report.overview.orders.average, null);
  assert.equal(report.quality.sourceCoverage.percent, null);
  assert.equal(report.overview.current.debt, 0);
});
test('failed source keeps the successful projection and original load time; other sources continue', async () => {
  const h = harness(),
    first = await h.service.report(params());
  h.failed.add('finance');
  h.values.orders.orders[0].amount = 2000;
  h.advance(31_000);
  const next = await h.service.report(params('&refresh=1'));
  assert.equal(next.overview.finance.income, 825);
  assert.equal(next.overview.orders.amount, 2000);
  const source = next.sources.find((s) => s.id === 'finance');
  assert.equal(source.state, 'stale');
  assert.equal(
    source.loadedAt,
    first.sources.find((s) => s.id === 'finance').loadedAt,
  );
  assert.notEqual(source.loadedAt, source.checkedAt);
  assert.equal(JSON.stringify(next).includes('PRIVATE'), false);
  h.failed.clear();
  h.advance(31_000);
  const recovered = await h.service.report(params('&refresh=1'));
  assert.equal(
    recovered.sources.find((s) => s.id === 'finance').state,
    'ready',
  );
});
test('first unavailable source returns null data with error state, not fake zeroes', async () => {
  const h = harness();
  h.failed.add('finance');
  h.failed.add('orders');
  const report = await h.service.report(params());
  assert.equal(report.overview.finance, null);
  assert.equal(report.overview.orders, null);
  assert.equal(report.overview.current, null);
  assert.equal(report.operations.production, null);
  assert.deepEqual(
    report.sources.filter((s) => s.state === 'unavailable').map((s) => s.id),
    ['finance', 'orders'],
  );
});
test('single flight and refresh cooldown bound source requests across callers, filters and retries', async () => {
  const h = harness();
  const reports = await Promise.all(
    Array.from({ length: 8 }, () => h.service.report(params('&refresh=1'))),
  );
  assert.equal(new Set(reports.map((r) => r.snapshotId)).size, 1);
  assert.deepEqual(h.calls, {
    finance: 1,
    orders: 1,
    production: 1,
    warehouse: 1,
  });
  await h.service.report(
    new URLSearchParams('from=2026-08-01&to=2026-08-31&refresh=1'),
  );
  assert.equal(h.calls.finance, 1);
  h.advance(301_000);
  await h.service.report(params());
  assert.equal(h.calls.finance, 2);
});

test('live business snapshot reads only orders and finance, retaining single flight and cooldown', async () => {
  const h = harness();
  const service = new AnalyticsService({ readers: h.service.readers, sourceIds: ['orders', 'finance'] });
  await Promise.all(Array.from({ length: 12 }, () => service.refresh()));
  assert.deepEqual(h.calls, { finance: 1, orders: 1 });
  assert.deepEqual(service.status().sources.map(s => s.id), ['finance', 'orders']);
  assert.equal(service.sources.orders.state, 'ready');
  assert.equal(service.sources.finance.state, 'ready');
  await service.refresh(true);
  assert.deepEqual(h.calls, { finance: 1, orders: 1 });
});
test('invalid request never calls sources, and read projections have no writing methods', async () => {
  const h = harness();
  await assert.rejects(h.service.report(new URLSearchParams('from=bad')), {
    code: 'ANALYTICS_PERIOD',
  });
  assert.deepEqual(h.calls, {});
  assert.equal(h.service.execute, undefined);
  assert.ok(
    connections.every(
      (s) =>
        s.state === 'not_connected' &&
        s.lastSuccessAt === null &&
        s.metrics === null,
    ),
  );
});
test('stock and production projections retain unknown quantities and zeroes separately', () => {
  assert.equal(
    projectWarehouse({
      items: [{ sku: 'QA', stock: 0, minStock: null, reserved: 0 }],
    }).items[0].stock,
    0,
  );
  assert.equal(
    projectWarehouse({
      items: [{ sku: 'QA', stock: 0, minStock: null, reserved: 0 }],
    }).items[0].minStock,
    null,
  );
  assert.deepEqual(projectProduction({ tasks: [] }).tasks, []);
});
test('an unknown stock minimum or reserve is not reported as a confirmed shortage', async () => {
  const h = harness();
  h.values.warehouse.items[0].minStock = null;
  h.values.warehouse.items[0].reserved = null;
  const report = await h.service.report(params());
  assert.equal(report.operations.warehouse.belowMinimum, 0);
  assert.equal(report.operations.warehouse.incomplete, 1);
  assert.equal(report.operations.warehouse.attention, 1);
});
test('analytics opts into strict stock numbers while legacy warehouse interpretation stays compatible', () => {
  const sheet = fixtures(),
    catalog = sheet['Склад'];
  catalog[1][6] = 'Ошибка';
  catalog[1][7] = '';
  catalog[1][12] = 0;
  const strict = parseWarehouse(catalog, sheet['Движения склада'], {
    strictNumbers: true,
  }).items[0];
  assert.equal(strict.stock, null);
  assert.equal(strict.minStock, null);
  assert.equal(strict.reserved, 0);
  assert.equal(
    parseWarehouse(catalog, sheet['Движения склада']).items[0].stock,
    0,
  );
});
