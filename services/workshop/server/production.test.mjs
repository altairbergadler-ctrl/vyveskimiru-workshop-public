import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProduction, ProductionError, setProductionCompletion } from './production.mjs';

const headers = ['№ заказа', 'Название заказа', 'Изделие', 'Клиент', 'Срок сдачи', 'Этап',
  'Готово', 'Можно', 'Исполнитель', 'План', 'Факт', 'Часы', 'Норма, ч', 'К оплате',
  'Ждёт 1', 'Ждёт 2', 'Комментарий'];

function fixture({ allowOutOfOrder = false } = {}) {
  const control = [];
  control[11] = allowOutOfOrder;
  return [
    control,
    [],
    [],
    headers,
    ['8', 'Тестовый заказ', 'Вывеска', 'Клиент', '02.09.2026', 'Каркас', false,
      'можно', 'Олег', '31.08.2026', '', '2', '3', '', '', '', ''],
    ['8', 'Тестовый заказ', 'Вывеска', 'Клиент', '02.09.2026', 'Покраска', false,
      'ждёт', 'Олег', '', '', '', '4', '', 'Каркас', '', ''],
    ['7', 'Готовый заказ', 'Неон', 'Клиент', '31.08.2026', 'Сборка', true,
      'можно', 'Витя', '31.08.2026', '31.08.2026', '1', '1', '', '', '', ''],
  ];
}

const now = new Date('2026-08-31T12:00:00.000Z');

test('production statistics use Plan and Fact dates from the sheet', () => {
  const result = parseProduction(fixture(), { now });
  assert.equal(result.stats.total, 3);
  assert.equal(result.stats.planToday, 2);
  assert.equal(result.stats.completedToday, 1);
  assert.equal(result.stats.dueTodayOrders, 0);
  assert.equal(result.stats.ready, 1);
  assert.equal(result.stats.waiting, 1);
  assert.equal(result.tasks[0].canComplete, true);
  assert.equal(result.tasks[1].canComplete, false);
});

test('production counts unique unfinished orders due today', () => {
  const values = fixture();
  values[4][4] = '31.08.2026';
  values[5][2] = 'Другое изделие';
  values[5][4] = '31.08.2026';
  const result = parseProduction(values, { now });
  assert.equal(result.stats.dueTodayOrders, 1);
});

test('production rejects a blocked stage', async () => {
  const client = {
    configured: true,
    async getValues() { return { values: fixture() }; },
    async updateValues() { throw new Error('must not write'); },
  };
  const production = parseProduction(fixture(), { now });
  await assert.rejects(
    setProductionCompletion(client, { row: 10, key: production.tasks[1].key, completed: true }, { now }),
    (error) => error instanceof ProductionError && error.code === 'blocked',
  );
});

test('production completion writes checkbox and Fact date, then returns recalculated data', async () => {
  const values = fixture();
  const writes = [];
  const client = {
    configured: true,
    async getValues() { return { values }; },
    async updateValues(data) {
      writes.push(...data);
      values[4][6] = true;
      values[4][10] = '31.08.2026';
    },
  };
  const production = parseProduction(values, { now });
  const updated = await setProductionCompletion(
    client,
    { row: 9, key: production.tasks[0].key, completed: true },
    { now },
  );
  assert.deepEqual(writes, [
    { range: "'Производство'!G9", values: [[true]] },
    { range: "'Производство'!K9", values: [['31.08.2026']] },
  ]);
  assert.equal(updated.tasks[0].completed, true);
  assert.equal(updated.stats.completedToday, 2);
});

test('production rejects an update that Google Sheets did not persist', async () => {
  const values = fixture();
  const client = {
    configured: true,
    async getValues() { return { values }; },
    async updateValues() {},
  };
  const production = parseProduction(values, { now });
  await assert.rejects(
    setProductionCompletion(
      client,
      { row: 9, key: production.tasks[0].key, completed: true },
      { now },
    ),
    (error) => error instanceof ProductionError && error.code === 'sync',
  );
});
