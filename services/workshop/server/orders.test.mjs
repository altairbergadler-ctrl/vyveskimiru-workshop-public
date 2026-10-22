import assert from 'node:assert/strict';
import test from 'node:test';
import { readOrders } from './orders.mjs';

test('orders are read from the source sheet and sorted by number', async () => {
  const client = {
    configured: true,
    async getValues(sheetName, range) {
      assert.equal(sheetName, 'Заказы');
      assert.equal(range, 'A1:AB1000');
      return { values: [
        ['№ заказа', 'Название заказа', 'Клиент', 'Сумма заказа', 'Оплачено', 'Долг', 'Статус'],
        ['8', 'Наш Мясной', 'Зинаида', '90 000 ₽', '25 000 ₽', '65 000 ₽', 'Отменён'],
        ['2', 'Елена · Уличная вывеска', 'Елена', '35 000 ₽', '20 000 ₽', '15 000 ₽', 'В работе'],
      ] };
    },
  };
  const result = await readOrders(client);
  assert.deepEqual(result.orders, [
    { number: '2', name: 'Елена · Уличная вывеска', client: 'Елена', total: 35000, paid: 20000, debt: 15000, status: 'В работе' },
    { number: '8', name: 'Наш Мясной', client: 'Зинаида', total: 90000, paid: 25000, debt: 65000, status: 'Отменён' },
  ]);
});

test('orders reject a sheet without the debt column', async () => {
  const client = {
    configured: true,
    async getValues() {
      return { values: [
        ['№ заказа', 'Название заказа'],
        ['1', 'Заказ без долга'],
      ] };
    },
  };
  await assert.rejects(readOrders(client), /долг заказа/);
});

test('missing status cannot silently make all orders payable', async () => {
  await assert.rejects(readOrders({ configured: true, getValues: async () => ({ values: [
    ['№ заказа', 'Название заказа', 'Долг'], ['1', 'QA', 0],
  ] }) }), /статус заказа/);
});
