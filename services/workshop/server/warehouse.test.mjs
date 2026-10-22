import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import {
  refillWarehouseItem,
  installWarehouseReceipts,
  verifyPendingRefills,
  createWarehouseItem,
  updateWarehouseItem,
  WarehouseError,
  issueWarehouseItem,
  parseWarehouse,
} from './warehouse.mjs';

const catalogHeader = [
  'Код',
  'Категория',
  'Наименование',
  'Ед.',
  'Цена, ₽',
  'По счёту +8%, ₽',
  'Остаток',
  'Минимум',
  'К закупке',
  'Факт',
  'Разница',
  'Место',
  'Резерв',
  'Фото',
  'Категория расхода',
];
const movementHeader = [
  'Дата',
  'Операция',
  'Код',
  'Наименование',
  'Количество',
  'Ед.',
  'Цена, ₽',
  'Сумма, ₽',
  '№ заказа',
  'Ответственный',
  'Комментарий',
  'Изменение',
];

function warehouseState() {
  return {
    catalog: [
      catalogHeader,
      [
        'VST-001',
        'Электрика',
        'Блок питания',
        'шт',
        '1200',
        '',
        '7',
        '3',
        '',
        '',
        '',
        'Шкаф 1',
        '2',
        '',
        'Материалы: электрика, диоды, БП',
      ],
    ],
    movements: [movementHeader],
  };
}

function warehouseClient(
  state = warehouseState(),
  { failReadAfterWrite = false } = {},
) {
  const writes = [];
  let hasWritten = false;
  let readbackFailed = false;
  return {
    state,
    writes,
    client: {
      configured: true,
      async getValues(sheetName) {
        if (failReadAfterWrite && hasWritten && !readbackFailed) {
          readbackFailed = true;
          throw new Error('readback_failed');
        }
        return {
          values: sheetName === 'Склад' ? state.catalog : state.movements,
        };
      },
      async updateValues(data) {
        writes.push(...data);
        for (const write of data) {
          const match = write.range.match(/'Движения склада'!A(\d+):L\d+$/);
          if (match)
            state.movements[Number(match[1]) - 1] = write.values[0];
        }
        hasWritten = true;
      },
    },
  };
}

function issueOptions(orderReads = null) {
  return {
    now: new Date('2026-09-06T08:00:00Z'),
    timeZone: 'Asia/Riyadh',
    async getValidOrderNumbers() {
      if (orderReads) orderReads.count += 1;
      return ['184'];
    },
  };
}

function refillFixture(t, options) {
  const fixture = warehouseClient(undefined, options), db = new Database(':memory:');
  t.after(() => db.close());
  const receipts = installWarehouseReceipts(fixture.client, db);
  return { ...fixture, db, receipts, command: { requestId: randomUUID(), code: 'VST-001', quantity: 1.25 } };
}

test('refill confirms a lost Google response, keeps historical price and serial dates, concurrent retry writes once', async t => {
  const f = refillFixture(t), send = f.client.updateValues.bind(f.client);
  f.client.updateValues = async data => {
    assert.equal(f.receipts.get(f.command.requestId).state, 'submitted');
    await send(data);
    const [d, m, y] = f.state.movements[1][0].split('.');
    f.state.movements[1][0] = (Date.UTC(Number(y), Number(m) - 1, Number(d)) - Date.UTC(1899, 11, 30)) / 86400000;
    f.state.catalog[1][4] = 9999;
    throw new Error('response lost after Google applied');
  };
  const results = await Promise.all([refillWarehouseItem(f.client, f.command), refillWarehouseItem(f.client, f.command)]);
  assert.ok(results.every(r => r.refill.state === 'confirmed'));
  assert.equal(f.writes.length, 1);
  assert.equal(f.state.movements[1][6], 1200);
  assert.equal(f.state.movements[1][7], 1500);
});

test('uncertain absent refill survives receipt reinitialization, blocks every warehouse writer, and confirms delayed application', async t => {
  const f = refillFixture(t), send = f.client.updateValues.bind(f.client);
  let deferred;
  f.client.updateValues = async data => { deferred = structuredClone(data); throw new Error('timeout'); };
  const pending = e => e.code === 'pending' && e.receiptState === 'submitted';
  await assert.rejects(refillWarehouseItem(f.client, f.command), pending);
  installWarehouseReceipts(f.client, f.db);
  await assert.rejects(refillWarehouseItem(f.client, f.command), pending);
  for (const run of [
    () => refillWarehouseItem(f.client, { ...f.command, requestId: randomUUID() }),
    () => createWarehouseItem(f.client, {}),
    () => updateWarehouseItem(f.client, 'VST-001', {}),
    () => issueWarehouseItem(f.client, {}, issueOptions()),
  ]) await assert.rejects(run(), e => e.code === 'pending');
  assert.equal(f.writes.length, 0);
  await send(deferred);
  await verifyPendingRefills(f.client);
  assert.equal(f.receipts.pending().length, 0);
  await refillWarehouseItem(f.client, f.command);
  assert.equal(f.writes.length, 1);
});

test('preflight rejection settles receipt and never resends that identity', async t => {
  const f = refillFixture(t); let attempts = 0;
  f.client.updateValues = async () => { attempts++; throw Object.assign(new Error('guard refusal'), { notSubmitted: true }); };
  await assert.rejects(refillWarehouseItem(f.client, f.command), e => e.receiptState === 'rejected');
  assert.equal(f.receipts.pending().length, 0);
  await assert.rejects(refillWarehouseItem(f.client, f.command), e => e.code === 'rejected');
  assert.equal(attempts, 1);
});

test('refill readback failure keeps receipt for a read-only retry', async t => {
  const f = refillFixture(t, { failReadAfterWrite: true });
  await assert.rejects(refillWarehouseItem(f.client, f.command), e => e.receiptState === 'submitted');
  assert.equal((await refillWarehouseItem(f.client, f.command)).refill.state, 'confirmed');
  assert.equal(f.writes.length, 1);
});

for (const fault of ['duplicate', 'price', 'quantity', 'comment', 'formula']) {
  test(`refill does not confirm a ${fault} mismatch or retry the write`, async t => {
    const f = refillFixture(t), send = f.client.updateValues.bind(f.client);
    f.client.updateValues = async data => {
      await send(data);
      if (fault === 'duplicate') f.state.movements.push([...f.state.movements[1]]);
      else f.state.movements[1][{ price: 6, quantity: 4, comment: 10, formula: 7 }[fault]] = fault === 'formula' ? '=1500' : 'changed';
    };
    await assert.rejects(refillWarehouseItem(f.client, f.command), e => e.code === 'pending');
    await assert.rejects(refillWarehouseItem(f.client, f.command), e => e.code === 'pending');
    assert.equal(f.writes.length, 1);
    assert.equal(f.receipts.pending().length, 1);
  });
}

test('refill identity cannot be reused for another payload, even after confirmation or manual row deletion', async t => {
  const f = refillFixture(t);
  await refillWarehouseItem(f.client, f.command);
  for (const change of [{ quantity: 2 }, { code: 'other' }, { comment: 'changed' }])
    await assert.rejects(refillWarehouseItem(f.client, { ...f.command, ...change }), e => e.code === 'duplicate');
  f.state.movements.splice(1);
  await refillWarehouseItem(f.client, f.command);
  assert.equal(f.writes.length, 1);
});

test('refill rejects legacy IDs, zero quantities, occupied inputs, orphan markers and full range without writing', async t => {
  const f = refillFixture(t);
  for (const change of [{ requestId: '' }, { requestId: 'legacy' }, { quantity: 0.001 }, { quantity: -1 }, { quantity: 'bad' }])
    await assert.rejects(refillWarehouseItem(f.client, { ...f.command, ...change }), e => e.code === 'invalid');
  f.state.movements[1] = ['', '', 'occupied'];
  await assert.rejects(refillWarehouseItem(f.client, f.command), e => e.code === 'duplicate');
  f.state.movements[1] = ['06.09.2026', 'Приход', 'VST-001', '', 1, '', 0, 0, '', `PWA:refill:${f.command.requestId}`, '', 1];
  await assert.rejects(refillWarehouseItem(f.client, f.command), e => e.code === 'duplicate');
  f.state.movements = [movementHeader, ...Array.from({ length: 499 }, () => ['06.09.2026'])];
  await assert.rejects(refillWarehouseItem(f.client, f.command), e => e.code === 'full');
  assert.equal(f.writes.length, 0); assert.equal(f.receipts.pending().length, 0);
});

function persistedIssue(requestId, overrides = {}) {
  const quantity = overrides.quantity ?? 1;
  const numericQuantity = Number(String(quantity).replace(',', '.'));
  return [
    '06.09.2026',
    'Расход на заказ',
    overrides.code ?? 'VST-001',
    'Блок питания',
    quantity,
    'шт',
    1200,
    1200,
    overrides.orderNumber ?? '184',
    `PWA:${requestId}`,
    overrides.comment ?? '',
    -numericQuantity,
  ];
}

test('warehouse uses catalog and movement ledger for stock metrics', () => {
  const result = parseWarehouse(
    [
      catalogHeader,
      [
        'VST-001',
        'Электрика',
        'Блок питания',
        'шт',
        '1200',
        '',
        '7',
        '3',
        '',
        '',
        '',
        'Шкаф 1',
        '2',
        '/api/warehouse/photos/power.jpg',
        'Материалы: электрика, диоды, БП',
      ],
    ],
    [
      movementHeader,
      [
        '01.06.2026',
        'Расход на заказ',
        'VST-001',
        'Блок питания',
        '9',
        'шт',
        '',
        '',
        '140',
        '',
        '',
        '-9',
      ],
      [
        '20.08.2026',
        'Расход на заказ',
        'VST-001',
        'Блок питания',
        '4',
        'шт',
        '',
        '',
        '180',
        '',
        '',
        '-4',
      ],
      [
        '02.09.2026',
        'Расход на заказ',
        'VST-001',
        'Блок питания',
        '2',
        'шт',
        '',
        '',
        '184',
        '',
        '',
        '-2',
      ],
      [
        '05.09.2026',
        'Приход',
        'VST-001',
        'Блок питания',
        '5',
        'шт',
        '',
        '',
        '',
        '',
        '',
        '5',
      ],
    ],
    { now: new Date('2026-09-06T08:00:00Z'), timeZone: 'Asia/Riyadh' },
  );

  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].used, { 7: 2, 30: 6, 90: 6 });
  assert.equal(result.items[0].stock, 7);
  assert.equal(result.items[0].reserved, 2);
  assert.equal(result.items[0].price, 1200);
  assert.equal(result.items[0].photoUrl, '/api/warehouse/photos/power.jpg');
  assert.equal(result.items[0].expenseCategory, 'Материалы: электрика, диоды, БП');
  assert.equal(result.items[0].group, 'electronics');
  assert.match(result.items[0].lastMovement, /приход 5 шт/);
});

test('warehouse rejects an incompatible sheet layout', () => {
  assert.throws(
    () => parseWarehouse([['Код']], [movementHeader]),
    (error) => error instanceof WarehouseError && error.code === 'schema',
  );
});

test('warehouse issue writes one exact order movement and returns refreshed data', async () => {
  const { client, writes } = warehouseClient();
  const result = await issueWarehouseItem(
    client,
    {
      code: 'VST-001',
      quantity: 2.5,
      orderNumber: '184',
      comment: 'На производство',
      requestId: 'issue-success-184-vst-001',
    },
    issueOptions(),
  );

  assert.deepEqual(writes, [
    {
      range: "'Движения склада'!A2:L2",
      values: [
        [
          '06.09.2026',
          'Расход на заказ',
          'VST-001',
          'Блок питания',
          2.5,
          'шт',
          1200,
          3000,
          '184',
          'PWA:issue-success-184-vst-001',
          'На производство',
          -2.5,
        ],
      ],
    },
  ]);
  assert.deepEqual(result.items[0].used, { 7: 2.5, 30: 2.5, 90: 2.5 });
  assert.match(result.items[0].lastMovement, /заказ №184/);
});

test('warehouse issue rejects an unknown item and order', async () => {
  const unknownItem = warehouseClient();
  await assert.rejects(
    issueWarehouseItem(
      unknownItem.client,
      {
        code: 'UNKNOWN',
        quantity: 1,
        orderNumber: '184',
        requestId: 'issue-unknown-item',
      },
      issueOptions(),
    ),
    (error) => error instanceof WarehouseError && error.code === 'missing',
  );
  assert.deepEqual(unknownItem.writes, []);

  const unknownOrder = warehouseClient();
  await assert.rejects(
    issueWarehouseItem(
      unknownOrder.client,
      {
        code: 'VST-001',
        quantity: 1,
        orderNumber: '999',
        requestId: 'issue-unknown-order',
      },
      issueOptions(),
    ),
    (error) =>
      error instanceof WarehouseError &&
      error.code === 'missing' &&
      /Заказ №999/.test(error.message),
  );
  assert.deepEqual(unknownOrder.writes, []);
});

test('warehouse issue rejects zero and quantities above free stock', async () => {
  const zeroQuantity = warehouseClient();
  await assert.rejects(
    issueWarehouseItem(
      zeroQuantity.client,
      {
        code: 'VST-001',
        quantity: 0,
        orderNumber: '184',
        requestId: 'issue-zero-quantity',
      },
      issueOptions(),
    ),
    (error) => error instanceof WarehouseError && error.code === 'invalid',
  );
  assert.deepEqual(zeroQuantity.writes, []);

  const insufficientStock = warehouseClient();
  await assert.rejects(
    issueWarehouseItem(
      insufficientStock.client,
      {
        code: 'VST-001',
        quantity: 5.01,
        orderNumber: '184',
        requestId: 'issue-insufficient-stock',
      },
      issueOptions(),
    ),
    (error) => error instanceof WarehouseError && error.code === 'insufficient',
  );
  assert.deepEqual(insufficientStock.writes, []);
});

test('warehouse issue requires a request id before reading warehouse data', async () => {
  const warehouse = warehouseClient();
  const orderReads = { count: 0 };
  await assert.rejects(
    issueWarehouseItem(
      warehouse.client,
      { code: 'VST-001', quantity: 1, orderNumber: '184' },
      issueOptions(orderReads),
    ),
    (error) => error instanceof WarehouseError && error.code === 'invalid',
  );
  assert.equal(orderReads.count, 0);
  assert.deepEqual(warehouse.writes, []);
});

test('warehouse issue recognizes a durable retry without loading orders', async () => {
  const requestId = 'durable-issue-retry';
  const state = warehouseState();
  state.movements.push(persistedIssue(requestId, { quantity: '1,5' }));
  const restarted = warehouseClient(state);
  const orderReads = { count: 0 };
  const result = await issueWarehouseItem(
    restarted.client,
    {
      code: 'VST-001',
      quantity: 1.5,
      orderNumber: '184',
      requestId,
    },
    issueOptions(orderReads),
  );

  assert.equal(orderReads.count, 0);
  assert.deepEqual(restarted.writes, []);
  assert.match(result.items[0].lastMovement, /заказ №184/);
});

test('warehouse issue rejects a durable request id reused with changed payload', async () => {
  const requestId = 'durable-issue-conflict';
  const base = {
    code: 'VST-001',
    quantity: 1,
    orderNumber: '184',
    comment: '',
    requestId,
  };
  const variants = [
    { code: 'UNKNOWN' },
    { quantity: 2 },
    { orderNumber: '999' },
    { comment: 'Другое назначение' },
  ];

  for (const variant of variants) {
    const state = warehouseState();
    state.movements.push(persistedIssue(requestId));
    const restarted = warehouseClient(state);
    const orderReads = { count: 0 };
    await assert.rejects(
      issueWarehouseItem(
        restarted.client,
        { ...base, ...variant },
        issueOptions(orderReads),
      ),
      (error) => error instanceof WarehouseError && error.code === 'duplicate',
    );
    assert.equal(orderReads.count, 0);
    assert.deepEqual(restarted.writes, []);
  }
});

test('warehouse issue retry survives a successful write followed by readback failure', async () => {
  const state = warehouseState();
  const first = warehouseClient(state, { failReadAfterWrite: true });
  const requestId = 'issue-readback-failure';
  const input = {
    code: 'VST-001',
    quantity: 1,
    orderNumber: '184',
    requestId,
  };
  await assert.rejects(
    issueWarehouseItem(first.client, input, issueOptions()),
    /readback_failed/,
  );
  assert.equal(first.writes.length, 1);

  const retry = warehouseClient(state);
  const retryOrderReads = { count: 0 };
  const result = await issueWarehouseItem(
    retry.client,
    input,
    issueOptions(retryOrderReads),
  );

  assert.equal(retryOrderReads.count, 0);
  assert.deepEqual(retry.writes, []);
  assert.match(result.items[0].lastMovement, /заказ №184/);
});

test('warehouse serializes concurrent issue and refill into different rows', async t => {
  const warehouse = warehouseClient();
  const db = new Database(':memory:'); t.after(() => db.close());
  installWarehouseReceipts(warehouse.client, db);
  await Promise.all([
    issueWarehouseItem(
      warehouse.client,
      {
        code: 'VST-001',
        quantity: 1,
        orderNumber: '184',
        requestId: 'concurrent-issue',
      },
      issueOptions(),
    ),
    refillWarehouseItem(warehouse.client, {
      requestId: randomUUID(),
      code: 'VST-001',
      quantity: 2,
      comment: 'Параллельный приход',
    }),
  ]);

  assert.deepEqual(
    warehouse.writes.map((write) => write.range),
    ["'Движения склада'!A2:L2", "'Движения склада'!A3:L3"],
  );
  assert.equal(warehouse.state.movements[1][1], 'Расход на заказ');
  assert.equal(warehouse.state.movements[2][1], 'Приход');
});

test('warehouse issue rounds free stock before comparing decimal quantities', async () => {
  const state = warehouseState();
  state.catalog[1][6] = '0.3';
  state.catalog[1][12] = '0.2';
  const warehouse = warehouseClient(state);

  await issueWarehouseItem(
    warehouse.client,
    {
      code: 'VST-001',
      quantity: 0.1,
      orderNumber: '184',
      requestId: 'decimal-stock-issue',
    },
    issueOptions(),
  );

  assert.equal(warehouse.writes.length, 1);
  assert.equal(warehouse.writes[0].values[0][4], 0.1);
});
