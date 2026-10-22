import assert from 'node:assert/strict';
import test from 'node:test';
import { canArchiveOrder, orderZone } from '../public/board-model.js';

test('ready orders remain on the main board without a non-cancelled separate installation', () => {
  for (const installations of [undefined, [], [{ status: 'Отменён' }], [{ status: 'Отменён' }, { status: 'Отменён' }]]) {
    assert.equal(orderZone({ status: 'Готов к выдаче', installations }), 'board');
  }
  assert.equal(orderZone({ status: 'Готов к выдаче', installations: [{ status: 'Отменён' }, { status: 'Назначен' }] }), 'installation');
});

test('completed installations stay in the installation workspace until the order is archived', () => {
  for (const status of ['На согласовании', 'Назначен', 'Выполнен', 'Неизвестный статус']) {
    assert.equal(orderZone({ status: 'Готов к выдаче', installations: [{ status }] }), 'installation');
  }
  assert.equal(orderZone({ status: 'Монтаж', installations: [] }), 'installation');
  assert.equal(orderZone({ status: 'Монтаж', installations: [{ status: 'Отменён' }] }), 'installation');
});

test('archived order status wins over scheduled and completed installation records', () => {
  for (const status of ['Сдан', 'Отменён']) {
    assert.equal(orderZone({ status, installations: [{ status: 'Назначен' }, { status: 'Выполнен' }] }), status === 'Отменён' ? 'cancelled' : 'archive');
    assert.equal(canArchiveOrder({ status }), false);
  }
});

test('a prearranged installation never removes an unfinished order from manufacturing', () => {
  for (const status of ['Расчёт / КП', 'Согласован', 'В производстве', 'Новый пользовательский статус', '']) {
    assert.equal(orderZone({ status, installations: [{ status: 'Назначен' }] }), 'board');
    assert.equal(canArchiveOrder({ status }), false);
  }
});

test('archive availability depends only on the two explicitly eligible order statuses', () => {
  for (const status of ['Готов к выдаче', 'Монтаж']) {
    for (const installations of [[], [{ status: 'Назначен' }], [{ status: 'Выполнен' }], [{ status: 'Отменён' }]]) {
      assert.equal(canArchiveOrder({ status, installations }), true);
    }
  }
  for (const order of [undefined, null, {}, { status: 42 }, { status: 'Неизвестно' }]) {
    assert.equal(canArchiveOrder(order), false);
    assert.equal(orderZone(order), 'board');
  }
});

test('exclusive grouping preserves every order exactly once without mutating source records', () => {
  const orders = [
    { id: 'ready', status: 'Готов к выдаче', installations: [] },
    { id: 'manufacturing', status: 'В производстве', installations: [{ status: 'Назначен' }] },
    { id: 'unknown', status: 'Особая обработка', installations: [{ status: 'Выполнен' }] },
    { id: 'done-install', status: 'Готов к выдаче', installations: [{ status: 'Выполнен' }] },
    { id: 'install-status', status: 'Монтаж', installations: [{ status: 'Отменён' }] },
    { id: 'archived', status: 'Сдан', installations: [{ status: 'Назначен' }] },
    { id: 'cancelled', status: 'Отменён', installations: [{ status: 'Назначен' }] },
  ];
  const before = structuredClone(orders);
  const zones = Object.fromEntries(['board', 'installation', 'archive', 'cancelled'].map(zone => [zone, orders.filter(order => orderZone(order) === zone)]));
  assert.deepEqual(zones.board.map(order => order.id), ['ready', 'manufacturing', 'unknown']);
  assert.deepEqual(zones.installation.map(order => order.id), ['done-install', 'install-status']);
  assert.deepEqual(zones.archive.map(order => order.id), ['archived']);
  assert.deepEqual(zones.cancelled.map(order => order.id), ['cancelled']);
  const combined = Object.values(zones).flat();
  assert.equal(combined.length, orders.length);
  assert.equal(new Set(combined).size, orders.length);
  assert.deepEqual(orders, before);
});
