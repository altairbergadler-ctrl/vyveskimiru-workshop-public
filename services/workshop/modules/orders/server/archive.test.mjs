import assert from 'node:assert/strict';
import test from 'node:test';
import { archiveOrder, readTables } from './orders.mjs';
import { describeRecord } from './editing.mjs';

class Mock {
  constructor() {
    this.writes = [];
    this.raw = {
      'Заказы': [['№ заказа', 'Название заказа', 'Статус', 'Комментарий', 'Сумма заказа'], ['42', 'Вывеска', 'Готов к выдаче', 'Сохранить комментарий', '=1000'], ['777', 'Другой заказ', 'Готов к выдаче', '', '=2000']],
      'Настройки': [['Статус заказа'], ['В производстве'], ['Готов к выдаче'], ['Монтаж'], ['Сдан'], ['Отменён']],
      'Монтажи': [['ID монтажа', '№ заказа', 'Статус монтажа', 'Дата', 'Комментарий', 'Телефон'],
        ['a', '42', 'На согласовании', '', 'Комментарий А', '+79990000001'],
        ['b', '42', 'Назначен', 46280, 'Комментарий Б', '+79990000002'],
        ['c', '42', 'Выполнен', 46279, 'Сохранить выполненный', '+79990000003'],
        ['d', '42', 'Отменён', '', 'Сохранить отмену', '+79990000004'],
        ['other', '777', 'Назначен', 46281, 'Чужой монтаж', '+79990000005']],
    };
  }
  async getSpreadsheet() {
    return { sheets: Object.keys(this.raw).map((title, sheetId) => ({ properties: { title, sheetId, gridProperties: { rowCount: 1000, columnCount: 26 } } })) };
  }
  async getRanges(ranges, options = {}) {
    return { valueRanges: ranges.map(range => {
      const name = range.match(/^'([^']+)'!/u)[1];
      const values = structuredClone(this.raw[name]);
      if (options.valueRenderOption !== 'FORMULA') for (const row of values) for (let column = 0; column < row.length; column++) {
        if (row[column] === '=ACTIVE') row[column] = 'Назначен';
        else if (row[column] === '=READY') row[column] = 'Готов к выдаче';
        else if (row[column] === '=DONE_ON_READY') row[column] = this.raw['Заказы'][1][2] === 'Сдан' ? 'Назначен' : 'Выполнен';
        else if (typeof row[column] === 'string' && row[column].startsWith('=')) row[column] = 1000;
      }
      return { range, values };
    }) };
  }
  async updateValues(data) {
    this.writes.push(structuredClone(data));
    for (const update of data) {
      const [, name, letters, rowNumber] = update.range.match(/^'([^']+)'!([A-Z]+)(\d+)$/u);
      let column = 0; for (const letter of letters) column = column * 26 + letter.charCodeAt(0) - 64;
      this.raw[name][Number(rowNumber) - 1][column - 1] = update.values[0][0];
    }
    this.afterWrite?.();
  }
}

async function input(client, orderId = '42') {
  const { tables } = await readTables(client, ['Заказы', 'Настройки'], { includeFormulas: true, optional: ['Монтажи'] });
  const order = tables['Заказы'].rows.find(row => String(tables['Заказы'].cell(row, '№ заказа')) === orderId);
  return {
    orderId,
    expectedStatus: order ? tables['Заказы'].cell(order, 'Статус') : 'Готов к выдаче',
    installations: (tables['Монтажи']?.rows ?? []).filter(row => tables['Монтажи'].cell(row, '№ заказа') === orderId)
      .map(row => ({ record: describeRecord('installation', tables['Монтажи'], row, tables).record })),
  };
}

test('archive uses one batch for order plus active installations and preserves every other cell', async () => {
  const client = new Mock(); const request = await input(client); const expected = structuredClone(client.raw);
  const result = await archiveOrder(client, request);
  expected['Заказы'][1][2] = 'Сдан'; expected['Монтажи'][1][2] = 'Выполнен'; expected['Монтажи'][2][2] = 'Выполнен';
  assert.deepEqual(client.raw, expected, 'cancelled/completed installations, dates, phone, comments, formula totals and unrelated orders remain intact');
  assert.deepEqual(client.writes, [[
    { range: "'Заказы'!C2", values: [['Сдан']] },
    { range: "'Монтажи'!C2", values: [['Выполнен']] },
    { range: "'Монтажи'!C3", values: [['Выполнен']] },
  ]]);
  assert.equal(result.completedInstallations, 2);
});

test('stale order status and non-ready orders cannot be archived', async () => {
  const stale = new Mock(); const request = await input(stale); stale.raw['Заказы'][1][2] = 'В производстве';
  await assert.rejects(archiveOrder(stale, request), { code: 'STATUS_CONFLICT', statusCode: 409 });
  assert.equal(stale.writes.length, 0);
  for (const status of ['В производстве', 'Сдан', 'Отменён']) {
    const client = new Mock(); client.raw['Заказы'][1][2] = status;
    await assert.rejects(archiveOrder(client, await input(client)), { code: 'ARCHIVE_NOT_READY', statusCode: 422 });
    assert.equal(client.writes.length, 0);
  }
});

test('changed added deleted relinked and reordered installations all invalidate the archive request', async () => {
  const mutations = [
    client => { client.raw['Монтажи'][1][4] = 'Правка коллеги'; },
    client => { client.raw['Монтажи'].push(['new', '42', 'Назначен', 46282]); },
    client => { client.raw['Монтажи'].splice(2, 1); },
    client => { client.raw['Монтажи'][1][1] = '777'; },
    client => { [client.raw['Монтажи'][1], client.raw['Монтажи'][2]] = [client.raw['Монтажи'][2], client.raw['Монтажи'][1]]; },
  ];
  for (const mutate of mutations) {
    const client = new Mock(); const request = await input(client); mutate(client);
    await assert.rejects(archiveOrder(client, request), { code: 'ARCHIVE_INSTALLATIONS_CONFLICT', statusCode: 409 });
    assert.equal(client.writes.length, 0);
  }
});

test('requests must include all installations including already complete and cancelled records', async () => {
  const client = new Mock(); const request = await input(client);
  request.installations = request.installations.slice(0, 2);
  await assert.rejects(archiveOrder(client, request), { code: 'ARCHIVE_INSTALLATIONS_CONFLICT' });
  assert.equal(client.writes.length, 0);
});

test('orphan request tokens, duplicate supplied tokens and duplicate source IDs cannot write', async () => {
  const unrelated = new Mock(); const request = await input(unrelated); const other = await input(unrelated, '777');
  request.installations[0] = other.installations[0];
  await assert.rejects(archiveOrder(unrelated, request), { code: 'ARCHIVE_INSTALLATIONS_CONFLICT' });
  assert.equal(unrelated.writes.length, 0);
  const duplicated = new Mock(); const duplicateInput = await input(duplicated); duplicateInput.installations[1] = duplicateInput.installations[0];
  await assert.rejects(archiveOrder(duplicated, duplicateInput), { code: 'ARCHIVE_INSTALLATIONS_CONFLICT' });
  assert.equal(duplicated.writes.length, 0);
  const sourceDuplicate = new Mock(); sourceDuplicate.raw['Монтажи'][5][0] = 'a';
  await assert.rejects(archiveOrder(sourceDuplicate, await input(sourceDuplicate)), { code: 'ARCHIVE_DUPLICATE_INSTALLATION' });
  assert.equal(sourceDuplicate.writes.length, 0);
});

test('missing and duplicate orders fail without writing', async () => {
  const missing = new Mock(); await assert.rejects(archiveOrder(missing, await input(missing, 'missing')), { code: 'ORDER_NOT_FOUND' });
  assert.equal(missing.writes.length, 0);
  const duplicate = new Mock(); duplicate.raw['Заказы'].push([...duplicate.raw['Заказы'][1]]);
  await assert.rejects(archiveOrder(duplicate, await input(duplicate)), { code: 'DUPLICATE_ORDER_ID' });
  assert.equal(duplicate.writes.length, 0);
});

test('legacy Монтаж orders without native records archive without changing production stages', async () => {
  const client = new Mock(); delete client.raw['Монтажи']; client.raw['Заказы'][1][2] = 'Монтаж';
  client.raw['Производство'] = [['№ заказа', 'Этап', 'Готово'], ['42', 'Монтаж', false], ['42', 'Монтаж неона на основание', false]];
  const before = structuredClone(client.raw['Производство']);
  await archiveOrder(client, await input(client));
  assert.deepEqual(client.writes, [[{ range: "'Заказы'!C2", values: [['Сдан']] }]]);
  assert.deepEqual(client.raw['Производство'], before);
});

test('archive uses canonical settings value and refuses a missing target status', async () => {
  const canonical = new Mock(); canonical.raw['Настройки'][4][0] = 'Сдан ';
  await archiveOrder(canonical, await input(canonical));
  assert.equal(canonical.raw['Заказы'][1][2], 'Сдан ');
  const missing = new Mock(); missing.raw['Настройки'].splice(4, 1);
  await assert.rejects(archiveOrder(missing, await input(missing)), { code: 'ARCHIVE_STATUS_MISSING' });
  assert.equal(missing.writes.length, 0);
});

test('unknown installation statuses and formula status cells fail before the batch', async () => {
  const unknown = new Mock(); unknown.raw['Монтажи'][1][2] = 'Неизвестный';
  await assert.rejects(archiveOrder(unknown, await input(unknown)), { code: 'ARCHIVE_INSTALLATION_STATUS' });
  assert.equal(unknown.writes.length, 0);
  for (const source of ['order', 'installation']) {
    const client = new Mock();
    if (source === 'order') client.raw['Заказы'][1][2] = '=READY';
    else client.raw['Монтажи'][1][2] = '=ACTIVE';
    await assert.rejects(archiveOrder(client, await input(client)), { code: 'FORMULA_PROTECTED' });
    assert.equal(client.writes.length, 0);
  }
});

test('readback catches changed adjacent fields and installation-set changes without retry or rollback', async () => {
  const mutations = [
    client => { client.raw['Заказы'][1][1] = 'Concurrent title'; },
    client => { client.raw['Монтажи'][4][4] = 'Changed cancelled comment'; },
    client => { client.raw['Монтажи'].push(['new', '42', 'На согласовании']); },
    client => { client.raw['Монтажи'][1][2] = 'Назначен'; },
  ];
  for (const mutation of mutations) {
    const client = new Mock(); const request = await input(client); client.afterWrite = () => mutation(client);
    await assert.rejects(archiveOrder(client, request), { code: 'ARCHIVE_UNCONFIRMED', statusCode: 409 });
    assert.equal(client.writes.length, 1);
  }
});

test('uncertain write is attempted once and a replay cannot perform a second archive', async () => {
  const client = new Mock(); const request = await input(client);
  client.afterWrite = () => { throw new Error('Connection lost after commit'); };
  await assert.rejects(archiveOrder(client, request), { code: 'ARCHIVE_UNCONFIRMED' });
  await assert.rejects(archiveOrder(client, request), { code: 'STATUS_CONFLICT' });
  assert.equal(client.writes.length, 1);
});

test('readback detects an unchanged status formula whose effective result became active', async () => {
  const client = new Mock(); client.raw['Монтажи'][3][2] = '=DONE_ON_READY';
  await assert.rejects(archiveOrder(client, await input(client)), { code: 'ARCHIVE_UNCONFIRMED' });
  assert.equal(client.writes.length, 1);
  assert.equal(client.raw['Монтажи'][3][2], '=DONE_ON_READY', 'derived status formula remains intact');
});
