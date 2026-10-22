import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(
  new URL('../lib/widget-model.ts', import.meta.url),
  'utf8',
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
  },
}).outputText;
const m = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);
const order = (id, patch = {}) => ({
  id,
  title: 'Вымышленная вывеска',
  client: 'Тестовый клиент',
  manager: 'Анна',
  status: 'В производстве',
  dueDate: '2026-09-07',
  manufacturingDone: false,
  debt: 0,
  amount: 100,
  paid: 0,
  production: [],
  installations: [],
  ...patch,
});
const stock = (sku, patch = {}) => ({
  sku,
  name: sku,
  category: 'Материал',
  unit: 'м',
  stock: 20,
  reserved: 5,
  minStock: 10,
  used: { 7: 0, 30: 0, 90: 0 },
  ...patch,
});

test('widget preferences recover from corrupt storage and retain an intentionally empty home', () => {
  assert.deepEqual(m.parseLayout('{bad'), m.defaultLayout());
  assert.deepEqual(
    m.parseLayout('{"version":99,"widgets":[]}'),
    m.defaultLayout(),
  );
  assert.deepEqual(m.parseLayout('{"version":1,"widgets":[]}').widgets, []);
});
test('persisted layout only admits known safe preferences, unique IDs and bounded lists', () => {
  const w = m.newWidget('favorites', 'one');
  const parsed = m.parseLayout(
    JSON.stringify({
      version: 1,
      widgets: [
        {
          ...w,
          days: 900,
          size: 'huge',
          month: '2026-99',
          pinned: [
            '1',
            '1',
            {},
            ...Array.from({ length: 30 }, (_, i) => String(i)),
          ],
          transactions: [{ secret: 'must not persist' }],
        },
        w,
        { ...w, id: 'crm', kind: 'crm' },
        { ...w, id: 'unknown', kind: 'eval' },
      ],
    }),
  );
  assert.equal(parsed.widgets.length, 1);
  assert.equal(parsed.widgets[0].days, 7);
  assert.equal(parsed.widgets[0].month, '');
  assert.equal(parsed.widgets[0].pinned.length, 20);
  assert.equal('transactions' in parsed.widgets[0], false);
});
test('duplicate widget types keep independent filters; reordering never drops instances', () => {
  const a = m.newWidget('deadlines', 'a'),
    b = { ...m.newWidget('deadlines', 'b'), filter: 'overdue' };
  const layout = m.parseLayout(JSON.stringify({ version: 1, widgets: [a, b] }));
  assert.deepEqual(
    m.moveWidget(layout, 'b', 0).widgets.map((w) => [w.id, w.filter]),
    [
      ['b', 'overdue'],
      ['a', 'all'],
    ],
  );
  assert.equal(m.moveWidget(layout, 'a', -1), layout);
});
test('deadlines distinguish overdue, horizon, undated and finished manufacturing', () => {
  const rows = [
    order('past', { dueDate: '2026-09-06' }),
    order('today'),
    order('edge', { dueDate: '2026-09-13' }),
    order('later', { dueDate: '2026-09-14' }),
    order('undated', { dueDate: null }),
    order('ready', { manufacturingDone: true, status: 'Готов к выдаче' }),
  ];
  const w = m.newWidget('deadlines');
  assert.deepEqual(
    m.deadlineOrders(rows, w, '2026-09-07').map((o) => o.id),
    ['past', 'today', 'edge', 'undated'],
  );
  assert.deepEqual(
    m
      .deadlineOrders(rows, { ...w, filter: 'overdue' }, '2026-09-07')
      .map((o) => o.id),
    ['past'],
  );
  assert.deepEqual(
    m
      .deadlineOrders(rows, { ...w, filter: 'undated' }, '2026-09-07')
      .map((o) => o.id),
    ['undated'],
  );
  assert.deepEqual(
    m.deadlineOrders(rows, { ...w, owner: 'Олег' }, '2026-09-07'),
    [],
  );
});
test('stock respects reserved material, minimum boundary and period, without mixing units', () => {
  const w = m.newWidget('stock');
  const rows = [
    stock('reserved', { reserved: 30 }),
    stock('edge', { reserved: 10 }),
    stock('ample'),
  ];
  assert.equal(m.freeStock(rows[0]), 0);
  assert.deepEqual(
    m.stockItems(rows, w).map((i) => i.sku),
    ['reserved', 'edge'],
  );
  assert.deepEqual(m.stockItems(rows, { ...w, category: 'Нет категории' }), []);
  const used = [
    stock('sheet', { unit: 'лист', used: { 7: 0, 30: 2, 90: 3 } }),
    stock('meters', { used: { 7: 1, 30: 7, 90: 8 } }),
  ];
  assert.equal(
    m.stockItems(used, { ...m.newWidget('consumption'), days: 7 }).length,
    1,
  );
});
test('debt remains positive per order and never nets a different order overpayment', () => {
  const rows = [
    order('a', { debt: 100 }),
    order('b', { debt: -200 }),
    order('c', { debt: 25, status: 'Сдан' }),
  ];
  assert.equal(m.debtGroups(rows, m.newWidget('debt'))[0].total, 125);
  assert.equal(
    m.debtGroups(rows, { ...m.newWidget('debt'), filter: 'delivered' })[0]
      .total,
    25,
  );
});
test('installation dates come from installations, not order deadlines; completed and cancelled excluded', () => {
  const installations = [
    { id: 'no-date', date: '', status: 'На согласовании' },
    { id: 'future', date: '2026-09-09', status: 'Назначен' },
    { id: 'done', date: '2026-09-08', status: 'Выполнен' },
    { id: 'cancelled', date: '2026-09-08', status: 'Отменён' },
  ];
  assert.deepEqual(
    m
      .installationRows(
        [order('a', { installations })],
        m.newWidget('installations'),
        '2026-09-07',
      )
      .map((r) => r.installation.id),
    ['future', 'no-date'],
  );
});
test('cashflow uses full dates, calendar length and separate income and expenses', () => {
  const rows = m.cashflowRows(
    [
      { id: '1', date: '2024-02-29', type: 'income', amount: 100 },
      { id: '2', date: '2024-02-29', type: 'expense', amount: 40 },
      { id: '3', date: '2024-03-01', type: 'income', amount: 999 },
    ],
    '2024-02',
  );
  assert.equal(rows.length, 29);
  assert.equal(rows[28].income, 100);
  assert.equal(rows[28].expense, 40);
  assert.equal(rows[0].income, 0);
});
test('order links preserve IDs with URL metacharacters and transaction filters are independent', () => {
  const id = 'Заказ & 1/#?';
  const url = new URL(m.orderHref(id, 'finance'), 'https://example.test');
  assert.equal(url.searchParams.get('order'), id);
  assert.equal(url.searchParams.get('tab'), 'finance');
  const rows = [
    { id: '1', date: '2026-09-06', type: 'income', account: 'A' },
    { id: '2', date: '2026-09-07', type: 'expense', account: 'A' },
    { id: '3', date: '2026-09-08', type: 'income', account: 'B' },
  ];
  assert.deepEqual(
    m
      .transactionRows(rows, {
        ...m.newWidget('transactions'),
        account: 'A',
        filter: 'income',
      })
      .map((t) => t.id),
    ['1'],
  );
});
