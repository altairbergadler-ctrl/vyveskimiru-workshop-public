import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  encodeProduction,
  decodeProduction,
  ProductionSheetStore,
  PRODUCTION_HEADERS,
  validateProductionSheetWrite,
  PRODUCTION_SHEET,
} from './production-sheet.mjs';
import { migrateProduction } from './production-migrate.mjs';
import { productionFixture } from '../qa/production-fixture.mjs';
import { a1 } from './sheets-client.mjs';

test('migration preserves every branch, norm and completion without inventing masters or material requirements', () => {
  const common = {
    orderNumber: '100',
    item: 'Вывеска',
    normHours: 0.5,
    assignee: null,
    plannedDate: null,
    dueDate: '2026-09-20',
    completedDate: null,
    comment: null,
  };
  const tasks = [
    { ...common, row: 9, stage: 'Раскрой', completed: true, waitingFor: [] },
    { ...common, row: 10, stage: 'Гибка', completed: false, waitingFor: [] },
    {
      ...common,
      row: 11,
      stage: 'Сборка',
      completed: false,
      waitingFor: ['Раскрой', 'Гибка'],
    },
  ];
  const state = migrateProduction({ tasks, today: '2026-09-07' });
  assert.equal(state.tasks.length, 3);
  assert.equal(state.tasks[0].status, 'done');
  assert.equal(state.tasks[0].minutes, 30);
  assert.deepEqual(state.tasks[2].dependencies, [
    'legacy-row-9',
    'legacy-row-10',
  ]);
  assert.equal(state.workers.length, 0);
  assert.deepEqual(state.tasks[0].materials, []);
  assert.deepEqual(decodeProduction(encodeProduction(state)), state);
  assert.throws(
    () =>
      migrateProduction({
        tasks: [
          ...tasks,
          {
            ...common,
            row: 12,
            stage: 'Ещё раскрой',
            completed: false,
            waitingFor: ['Нет такого этапа'],
          },
        ],
        today: '2026-09-07',
      }),
    /однозначно/,
  );
});
test('a lost Sheets write response is recovered by readback with no second write; stale data blocks submission', async () => {
  const db = new Database(':memory:');
  let rows = encodeProduction(productionFixture()),
    writes = 0,
    lose = true;
  const client = {
    getValues: async () => ({ values: [PRODUCTION_HEADERS, ...rows] }),
    updateValues: async (data) => {
      writes++;
      rows = data[0].values.filter((r) => r[0]);
      if (lose) {
        lose = false;
        throw new Error('lost response');
      }
    },
  };
  const store = new ProductionSheetStore({ client, db });
  store.currentRows = structuredClone(rows);
  store.load = async () => decodeProduction(rows);
  const next = decodeProduction(rows);
  next.revision++;
  next.workers[0].name = 'Обновлённый мастер';
  await assert.rejects(store.commit(next), /lost/);
  assert.ok(store.pending());
  const restarted = new ProductionSheetStore({ client, db });
  await restarted.recover();
  assert.equal(restarted.pending(), undefined);
  assert.equal(writes, 1);
  assert.equal(decodeProduction(rows).revision, 1);
  store.currentRows = structuredClone(rows);
  rows[0][4] = JSON.stringify({ ...JSON.parse(rows[0][4]), revision: 8 });
  await assert.rejects(store.commit(next), /изменилось/);
  assert.equal(writes, 1);
  db.close();
});
test('production write contract rejects a foreign range, wrong header and malformed state', async () => {
  const rows = encodeProduction(productionFixture());
  const options = {
    body: JSON.stringify({
      valueInputOption: 'RAW',
      data: [
        { range: a1(PRODUCTION_SHEET, `A2:F${rows.length + 1}`), values: rows },
      ],
    }),
  };
  await validateProductionSheetWrite(
    '/values:batchUpdate',
    options,
    async () => ({ values: [PRODUCTION_HEADERS] }),
  );
  await assert.rejects(
    validateProductionSheetWrite('/values:batchUpdate', options, async () => ({
      values: [['Не тот лист']],
    })),
    /структура/,
  );
  await assert.rejects(
    validateProductionSheetWrite(
      '/values:batchUpdate',
      { body: options.body.replace(PRODUCTION_SHEET, 'Склад') },
      async () => ({ values: [PRODUCTION_HEADERS] }),
    ),
    /границы/,
  );
});


test('confirmed task commands reuse verified rows without re-reading every order and stock item', async () => {
  const db = new Database(':memory:');
  const next = productionFixture();
  let rows = encodeProduction(next), reads = 0, writes = 0;
  const client = {
    getValues: async () => { reads++; return { values: [PRODUCTION_HEADERS, ...rows] }; },
    updateValues: async data => { writes++; rows = structuredClone(data[0].values); },
  };
  const store = new ProductionSheetStore({ client, db });
  store.currentRows = structuredClone(rows);
  next.revision++;
  await store.commit(next);
  assert.equal(writes, 1);
  assert.equal(reads, 3, 'preflight, recovery preflight and exact readback remain mandatory');
  const confirmed = await store.load();
  assert.equal(confirmed.revision, next.revision);
  assert.equal(reads, 3, 'read after commit uses the confirmed snapshot');
  confirmed.workers[0].name = 'Changed only in returned copy';
  assert.notEqual((await store.load()).workers[0].name, confirmed.workers[0].name);
  assert.equal(store.pending(), undefined);
  db.close();
});
