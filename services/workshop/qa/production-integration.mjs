import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { GoogleSheetsClient, a1 } from '../server/google-sheets.mjs';
import { installSheetsGuard } from '../server/sheets-guard.mjs';
import {
  createWarehouseItem,
  installWarehouseReceipts,
} from '../server/warehouse.mjs';
import { createClient } from '../modules/orders/server/clients.mjs';
import { createOrder } from '../modules/orders/server/creation.mjs';
import { moveOrder } from '../modules/orders/server/orders.mjs';
import { prepareProductionSheet } from '../server/production-migrate.mjs';
import {
  ProductionSheetStore,
  PRODUCTION_SHEET,
} from '../server/production-sheet.mjs';
import { applyProductionCommand } from '../server/production-workflow.mjs';
import { openDatabase } from '../server/db.mjs';
import { assertTestSheet, assertOwned } from './safety.mjs';
const spreadsheetId = assertTestSheet(
  process.env.GOOGLE_SPREADSHEET_ID,
  process.env.QA_CONFIRM_SHEET,
);
const directory = assertOwned(process.env.QA_DIRECTORY);
const config = {
  spreadsheetId,
  credentialsFile: process.env.GOOGLE_CREDENTIALS_FILE,
};
const raw = new GoogleSheetsClient(config),
  client = new GoogleSheetsClient(config);
let blockReads = false,
  loseResponse = false;
// The live service uses the same service account: leave ample quota for its reads.
const send = raw.request.bind(raw);
let readQueue = Promise.resolve();
raw.request = (route, options) => {
  const run = readQueue.then(async () => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    return send(route, options);
  });
  readQueue = run.catch(() => {});
  return run;
};
const pause = () => new Promise((resolve) => setTimeout(resolve, 12000));
const checks = [],
  id = crypto.randomUUID(),
  marker = `QA contract ${id}`;
const journalFile = path.join(directory, 'contract-write-journal.json');
assert.ok(
  !fs.existsSync(journalFile),
  'use a fresh isolated run; recover existing journal first',
);
const journal = { spreadsheetId, cells: [] };
const save = () => fs.writeFileSync(journalFile, JSON.stringify(journal));
const entered = (cell) => cell?.userEnteredValue ?? {};
const value = (cell) =>
  cell?.formulaValue ??
  cell?.numberValue ??
  cell?.boolValue ??
  cell?.stringValue ??
  '';
const col = (c) => c.charCodeAt(0) - 65;
client.request = async (route, options) => {
  if (blockReads) throw new Error('QA_LOST_READBACK');
  if (options?.method) {
    const body = JSON.parse(options.body);
    if (route === '/values:batchUpdate') {
      for (const entry of body.data) {
        const match = entry.range.match(
          /^'([^']+)'!([A-Z])(\d+)(?::([A-Z])(\d+))?$/u,
        );
        assert.ok(match);
        const [, name, column, row] = match,
          table = before.get(name);
        assert.ok(
          [
            'Склад',
            'Движения склада',
            'Заказы',
            'Клиенты',
            PRODUCTION_SHEET,
          ].includes(name),
          'unexpected production test target',
        );
        if (name === PRODUCTION_SHEET) continue;
        entry.values.forEach((values, i) =>
          values.forEach((v, j) => {
            const r = Number(row) + i,
              c = col(column) + j,
              original = entered(table.cells[r - 1]?.[c]);
            assert.ok(
              value(original) === '' || original.formulaValue,
              'test may write only a previously empty input or a prepared formula',
            );
            const prior = journal.cells.find(
              (cell) =>
                cell.name === name && cell.row === r && cell.column === c,
            );
            let expected = v;
            if (
              body.valueInputOption === 'USER_ENTERED' &&
              table.schema.types[String.fromCharCode(65 + c)] === 'date' &&
              typeof v === 'string' &&
              /^\d{2}\.\d{2}\.\d{4}$/u.test(v)
            ) {
              const [d, m, y] = v.split('.');
              expected =
                (Date.UTC(Number(y), Number(m) - 1, Number(d)) -
                  Date.UTC(1899, 11, 30)) /
                86400000;
            }
            if (prior) prior.expected = expected;
            else
              journal.cells.push({
                name,
                sheetId: table.id,
                row: r,
                column: c,
                original,
                expected,
              });
          }),
        );
      }
    } else throw new Error('unexpected refill integration mutation');
    save();
    await pause();
  }
  const result = await raw.request(route, options);
  if (options?.method) {
    if (loseResponse) {
      blockReads = true;
      throw new Error('QA_LOST_RESPONSE_AFTER_APPLY');
    }
  }
  return result;
};
const guard = installSheetsGuard(client);
const before = await guard.check();
save();
async function restoreCreated() {
  if (!journal.cells.length) return;
  const ranges = journal.cells.map((cell) =>
    a1(cell.name, `${String.fromCharCode(65 + cell.column)}${cell.row}`),
  );
  const current = (
    await raw.getRanges(ranges, { valueRenderOption: 'FORMULA' })
  ).valueRanges;
  current.forEach((entry, i) => {
    const actual = entry.values?.[0]?.[0] ?? '',
      saved = journal.cells[i];
    assert.ok(
      actual === saved.expected ||
        (typeof actual === 'number' &&
          typeof saved.expected === 'string' &&
          String(actual) === saved.expected) ||
        actual === value(saved.original),
      'test cell changed externally; do not overwrite',
    );
  });
  await raw.batchUpdate(
    journal.cells.map((cell) => ({
      updateCells: {
        start: {
          sheetId: cell.sheetId,
          rowIndex: cell.row - 1,
          columnIndex: cell.column,
        },
        fields: 'userEnteredValue',
        rows: [
          {
            values: [
              Object.keys(cell.original).length
                ? { userEnteredValue: cell.original }
                : {},
            ],
          },
        ],
      },
    })),
  );
  const restored = (
    await raw.getRanges(ranges, { valueRenderOption: 'FORMULA' })
  ).valueRanges;
  restored.forEach((entry, i) =>
    assert.equal(
      entry.values?.[0]?.[0] ?? '',
      value(journal.cells[i].original),
    ),
  );
  journal.restored = true;
  save();
  checks.push(
    'all temporary command inputs and prepared formulas restored exactly',
  );
}

let db,
  store,
  createdSheet = false;
const ordersClient = {
  get configured() {
    return client.configured;
  },
  getSpreadsheet: client.getSpreadsheet.bind(client),
  getValues: client.getValues.bind(client),
  getRanges: client.getRanges.bind(client),
  request: client.request.bind(client),
  batchUpdate: client.batchUpdate.bind(client),
  updateValues: (data) =>
    client.updateValues(data, { valueInputOption: 'RAW' }),
};
try {
  const metadata = await raw.getSpreadsheet({ fields: 'sheets.properties' });
  assert.ok(
    !metadata.sheets.some((s) => s.properties.title === PRODUCTION_SHEET),
    'test sheet already has v2; do not replace',
  );
  const migrated = await prepareProductionSheet(raw, { apply: true });
  createdSheet = true;
  checks.push('atomic migration on real test Google copy');
  await createClient(
    ordersClient,
    {
      requestId: crypto.randomUUID(),
      changes: { companyName: marker, createdDate: '2026-09-07' },
    },
    { journalDir: path.join(directory, 'clients') },
  );
  const order = await createOrder(
    ordersClient,
    {
      requestId: crypto.randomUUID(),
      changes: { title: marker, client: marker, createdDate: '2026-09-07' },
    },
    { journalDir: path.join(directory, 'orders') },
  );
  await moveOrder(ordersClient, {
    id: String(order.id),
    expectedStatus: 'Расчёт / КП',
    status: 'В производстве',
  });
  const sku = 'QA-' + id;
  await createWarehouseItem(client, {
    sku,
    name: marker,
    category: 'Прочее',
    expenseCategory: 'Прочее',
    unit: 'шт',
    stock: 4,
    minStock: 0,
    reserved: 0,
    location: 'QA',
  });
  db = openDatabase(path.join(directory, 'data', 'production-test.sqlite3'));
  installWarehouseReceipts(client, db);
  store = new ProductionSheetStore({ client, ordersClient, db });
  const owner = { id: 'owner', role: 'owner' };
  async function command(type, data) {
    const state = await store.load(true);
    const request = {
      requestId: crypto.randomUUID(),
      revision: state.revision,
      type,
      data,
    };
    const result = applyProductionCommand(state, owner, request);
    await store.commit(result.state);
    return request;
  }
  await command('worker.save', {
    id: '',
    name: marker,
    skills: ['QA сборка'],
    zones: ['Сборочная'],
    enabled: true,
    access: false,
    role: 'master',
    shiftStart: '00:00',
    shiftEnd: '23:59',
    days: [0, 1, 2, 3, 4, 5, 6],
  });
  await command('product.save', {
    id: '',
    name: marker,
    unit: 'шт',
    stages: [
      {
        id: 'qa-stage',
        name: marker,
        kind: 'manual',
        minutes: 1,
        skill: 'QA сборка',
        resourceId: '',
        materials: [{ sku, quantity: 1 }],
        dependencies: [],
        setupMinutes: 0,
        finishMinutes: 0,
        controlEvery: 0,
        controlMinutes: 0,
      },
    ],
  });
  let state = await store.load();
  const product = state.products.find((p) => p.name === marker);
  await command('item.add', {
    orderId: String(order.id),
    productId: product.id,
    quantity: 2,
  });
  state = await store.load();
  const task = state.tasks.find((t) => t.orderId === String(order.id));
  const receipt = await command('task.issue', { taskId: task.id });
  state = await store.load(true);
  assert.equal(state.tasks.find((t) => t.id === task.id).issued[sku], 2);
  assert.equal(state.warehouse.find((w) => w.sku === sku).stock, 2);
  assert.equal(applyProductionCommand(state, owner, receipt).duplicate, true);
  checks.push(
    'real stock issue, exact receipt replay, persisted received quantity',
  );
  await command('task.start', { taskId: task.id });
  await command('task.complete', { taskId: task.id, quantity: 1 });
  state = await store.load();
  assert.equal(state.tasks.find((t) => t.id === task.id).status, 'paused');
  assert.equal(state.pendingOrders.includes(String(order.id)), false);
  await command('task.resume', { taskId: task.id });
  await command('task.complete', { taskId: task.id });
  state = await store.load();
  assert.ok(state.pendingOrders.includes(String(order.id)));
  assert.equal(state.records.filter((r) => r.taskId === task.id).length, 2);
  await moveOrder(ordersClient, {
    id: String(order.id),
    expectedStatus: 'В производстве',
    status: 'Готов к выдаче',
  });
  const restarted = new ProductionSheetStore({ client, ordersClient, db });
  state = await restarted.load(true);
  assert.equal(
    state.orders.find((o) => o.id === String(order.id)).actualStatus,
    'Готов к выдаче',
  );
  checks.push(
    'partial work, resume, personal records and actual ready column survive reload',
  );
  console.log(
    JSON.stringify({ passed: true, migratedTasks: migrated.tasks, checks }),
  );
} finally {
  blockReads = false;
  loseResponse = false;
  assert.ok(
    !store?.pending(),
    'Production receipt pending: preserve test state and journal for recovery',
  );
  db?.close();
  await restoreCreated();
  if (createdSheet) {
    await raw.batchUpdate([{ deleteSheet: { sheetId: 19760907 } }]);
    checks.push('only this run new sheet removed');
  }
  fs.writeFileSync(
    path.join(directory, 'production-results.json'),
    JSON.stringify({ checks, restored: journal.restored }, null, 2),
  );
}
