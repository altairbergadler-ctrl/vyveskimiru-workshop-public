import test from 'node:test';
import assert from 'node:assert/strict';
import { readBoard, moveOrder, parseDate, parseNumber, columnName } from './orders.mjs';
import { GoogleSheetsClient } from './sheets.mjs';

const HEADERS = {
  'Заказы': ['№ заказа', 'Название заказа', 'Дата заказа', 'Клиент', 'Сумма вручную', 'Себестоимость вручную', 'Менеджер', 'Статус', 'Желаемая дата клиента', 'Срок сдачи', 'Сумма заказа', 'Себестоимость', 'Доп. расходы', 'Валовая прибыль', 'Маржа %', 'Оплачено', 'Долг', 'Дней до сдачи', 'Комментарий'],
  'Настройки': ['Категория', '', '', '', '', 'Статус заказа'],
  'Позиции': ['№ заказа', 'Название заказа', 'Наименование работы / изделия', 'Описание, макет, адрес', 'Ед. изм.', 'Ширина м', 'Высота м', 'Кол-во', 'Объём (расч.)', 'Цена за ед.', 'Сумма', 'Себест. за ед.', 'Себестоимость', 'Дата заказа'],
  'Клиенты': ['', 'Название / ФИО клиента', 'Тип', 'Контактное лицо', 'Телефон', 'Email', 'ИНН / реквизиты', 'Источник', 'Дата добавления', 'Комментарий'],
  'Производство': ['№ заказа', 'Название заказа', 'Изделие', 'Клиент', 'Срок сдачи', 'Этап', 'Готово', 'Можно', 'Исполнитель', 'План', 'Факт', 'Часы', 'Норма ч', 'К оплате', 'Ждёт 1', 'Ждёт 2', 'Комментарий'],
  'Платежи': ['Дата', '№ заказа', 'Название заказа', 'Клиент', 'Сумма заказа', 'Оплачено до этого', 'Сумма платежа', 'Касса / счёт', 'Вид платежа', 'Остаток после платежа', 'Комментарий', 'sync_id', 'sync_updated_at', 'sync_deleted', 'sync_origin'],
  'Расходы': ['Дата', 'Категория', 'Описание', 'Сумма', 'Касса / счёт', '№ заказа (если есть)', 'Название заказа', 'Поставщик', 'Комментарий', 'sync_id', 'sync_updated_at', 'sync_deleted', 'sync_origin'],
};

function row(name, record) {
  return HEADERS[name].map(header => record[header] ?? '');
}

function fixture() {
  return {
    'Заказы': [HEADERS['Заказы'], row('Заказы', {
      '№ заказа': '007', 'Название заказа': 'Вывеска', 'Дата заказа': '01.09.2026', 'Клиент': 'Клиент А',
      'Менеджер': 'Анна', 'Статус': 'Новый', 'Желаемая дата клиента': '9.09.2026', 'Срок сдачи': '10.09.2026',
      'Сумма заказа': '12 500,50 ₽', 'Оплачено': '13 000,00 ₽', 'Долг': '−499,50 ₽',
      'Себестоимость': '4 000 ₽', 'Доп. расходы': '— ₽', 'Валовая прибыль': '8 500,50 ₽', 'Комментарий': 'Нужен звонок',
    }), row('Заказы', { '№ заказа': '7', 'Название заказа': 'Другой заказ', 'Статус': 'Новый', 'Клиент': 'Клиент Б' })],
    'Настройки': [HEADERS['Настройки'], row('Настройки', { 'Статус заказа': 'Новый' }), row('Настройки', { 'Статус заказа': 'В работе' }), row('Настройки', { 'Статус заказа': 'Готов' })],
    'Позиции': [HEADERS['Позиции'], row('Позиции', { '№ заказа': '007', 'Наименование работы / изделия': 'Световые буквы', 'Описание, макет, адрес': 'Красная улица', 'Кол-во': '2,5', 'Ед. изм.': 'м²', 'Сумма': '12 500,50 ₽' }), row('Позиции', { '№ заказа': '7', 'Наименование работы / изделия': 'Чужая позиция', 'Сумма': '30 ₽' })],
    'Клиенты': [HEADERS['Клиенты'], row('Клиенты', { '': 'C1', 'Название / ФИО клиента': 'Клиент А', 'Контактное лицо': 'Антон', 'Телефон': '+7 999 123-45-67', 'Email': 'anton@example.com' }), row('Клиенты', { '': 'C2', 'Название / ФИО клиента': 'Клиент АА', 'Телефон': 'wrong' })],
    'Производство': [[], ['Сводка'], [], [], [], [], [], HEADERS['Производство'], row('Производство', { '№ заказа': '007', 'Изделие': 'Вывеска', 'Этап': 'Печать', 'Готово': true, 'Можно': 'Можно', 'Исполнитель': 'Мастер' }), row('Производство', { '№ заказа': '007', 'Изделие': 'Вывеска', 'Этап': 'Монтаж', 'Готово': false, 'План': '10.09.2026' })],
    'Платежи': [HEADERS['Платежи'], row('Платежи', { 'Дата': '02.09.2026', '№ заказа': '007', 'Сумма платежа': '13 000 ₽', 'Касса / счёт': 'Банк', 'Вид платежа': 'Предоплата' }), row('Платежи', { '№ заказа': '007', 'Сумма платежа': '1 000 ₽', sync_deleted: true }), row('Платежи', { '№ заказа': '7', 'Сумма платежа': '900 ₽' }), row('Платежи', { '№ заказа': '007', 'Сумма платежа': '-50 ₽', 'Касса / счёт': '', 'Вид платежа': 'Возврат' })],
    'Расходы': [HEADERS['Расходы'], row('Расходы', { 'Дата': '03.09.2026', '№ заказа (если есть)': '007', 'Сумма': '300,75 ₽', 'Категория': 'Материалы', 'Описание': '', 'Касса / счёт': 'Наличные' }), row('Расходы', { 'Сумма': '100 000 ₽', 'Категория': 'Аренда' }), row('Расходы', { '№ заказа (если есть)': '7', 'Сумма': '999 ₽' })],
  };
}

class MockSheets {
  constructor(data = fixture()) {
    this.spreadsheetId = 'test-sheet';
    this.data = structuredClone(data);
    this.calls = [];
    this.writes = [];
    this.afterWrite = null;
  }
  async getSpreadsheet() {
    return { spreadsheetId: this.spreadsheetId, sheets: Object.keys(this.data).map((title, sheetId) => ({ properties: {
      title, sheetId, gridProperties: { rowCount: 1234 + sheetId, columnCount: 30 + sheetId },
    } })) };
  }
  async getValues(name, range) {
    this.calls.push({ name, range });
    return { values: structuredClone(this.data[name]) };
  }
  async updateValues(data) {
    this.writes.push(structuredClone(data));
    for (const entry of data) {
      const match = entry.range.match(/^'Заказы'!([A-Z]+)(\d+)$/);
      assert.ok(match, 'write must target exactly one orders cell');
      let column = 0;
      for (const char of match[1]) column = column * 26 + char.charCodeAt(0) - 64;
      this.data['Заказы'][Number(match[2]) - 1][column - 1] = entry.values[0][0];
    }
    if (this.afterWrite) this.afterWrite();
    return { totalUpdatedCells: data.length };
  }
}

test('board preserves exact source amounts, negative debt, linkage and source records', async () => {
  const client = new MockSheets();
  const board = await readBoard(client);
  assert.equal(board.orders.length, 2);
  const order = board.orders[0];
  assert.equal(order.id, '007');
  assert.equal(order.amount, 12500.5);
  assert.equal(order.paid, 13000);
  assert.equal(order.debt, -499.5);
  assert.equal(order.extraCost, 0);
  assert.equal(order.profit, 6250.25);
  assert.equal(order.sourceProfit, 8500.5);
  assert.equal(order.profitBasis, 'estimated_margin_50');
  assert.equal(order.createdDate, '2026-09-01');
  assert.equal(order.desiredDate, '2026-09-09');
  assert.equal(order.dueDate, '2026-09-10');
  assert.deepEqual(order.items.map(({ edit: _edit, ...item }) => item), [{ row: 2, name: 'Световые буквы', description: 'Красная улица', width: null, height: null, quantity: 2.5, unit: 'м²', amount: 12500.5 }]);
  assert.equal(order.contacts.length, 1);
  assert.equal(order.contacts[0].name, 'Антон');
  assert.equal(order.contacts[0].phone, '+7 999 123-45-67');
  assert.deepEqual(order.production.map(stage => [stage.name, stage.done]), [['Печать', true], ['Монтаж', false]]);
  assert.equal(order.payments.length, 2, 'keep linked payment with missing account; ignore explicit soft-deleted row');
  assert.equal(order.payments[1].amount, -50);
  assert.equal(order.payments[1].account, '');
  assert.equal(order.expenses.length, 1, 'never allocate unrelated overhead to an order');
  assert.equal(order.expenses[0].amount, 300.75);
  assert.equal(order.expenses[0].description, '', 'do not discard linked records with missing descriptions');
  assert.equal(board.orders[1].amount, null);
  assert.equal(board.orders[1].items[0].name, 'Чужая позиция');
  assert.equal(board.orders[1].payments[0].amount, 900);
  assert.equal(order.sourceUrl, 'https://docs.google.com/spreadsheets/d/test-sheet/edit#gid=0&range=2:2');
  assert.equal(client.writes.length, 0);
  assert.deepEqual(client.calls.filter((_, index) => index % 2 === 0).map(call => call.range), ['A1:AD1234', 'A1:AE1235', 'A1:AF1236', 'A1:AG1237', 'A1:AH1238', 'A1:AI1239', 'A1:AJ1240']);
});

test('linked payment retains exact source cents and the existing formatted finance-ruble projection', async () => {
  const client = new MockSheets();
  client.data['Платежи'][1][HEADERS['Платежи'].indexOf('Сумма платежа')] = 1000.5;
  const modes = [];
  client.getRanges = async (ranges, options) => {
    modes.push(options.valueRenderOption);
    return { valueRanges: ranges.map(range => ({ range, values: client.data[range.match(/^'([^']+)'!/)[1]] })) };
  };
  const payment = (await readBoard(client)).orders[0].payments[0];
  assert.equal(payment.amount, 1000.5);
  assert.equal(payment.financeAmount, 1001);
  assert.equal(client.writes.length, 0);
  assert.deepEqual(modes, ['UNFORMATTED_VALUE', 'FORMULA']);
});

test('shifted header rows and reordered columns preserve reads and exact one-cell moves', async () => {
  const data = fixture();
  data['Позиции'][1][HEADERS['Позиции'].indexOf('Ширина м')] = '2,4';
  data['Позиции'][1][HEADERS['Позиции'].indexOf('Высота м')] = '0,75';
  for (const [name, values] of Object.entries(data)) {
    const shifted = values.map(cells => ['unrelated', ...cells.slice().reverse()]);
    data[name] = [[], [], ...shifted];
  }
  const client = new MockSheets(data);
  const board = await readBoard(client);
  assert.equal(board.orders[0].amount, 12500.5);
  assert.equal(board.orders[0].production[1].name, 'Монтаж');
  assert.equal(board.orders[0].items[0].width, 2.4);
  assert.equal(board.orders[0].items[0].height, 0.75);
  const before = structuredClone(client.data);
  const result = await moveOrder(client, { id: '007', status: 'В работе', expectedStatus: 'Новый' });
  assert.equal(result.changed, true);
  assert.deepEqual(client.writes, [[{ range: "'Заказы'!M4", values: [['В работе']] }]]);
  before['Заказы'][3][12] = 'В работе';
  assert.deepEqual(client.data, before, 'no other value, formula, linked record, or status was changed');
});

test('duplicate IDs are retained with warning and cannot be moved', async () => {
  const client = new MockSheets();
  client.data['Заказы'].push([...client.data['Заказы'][1]]);
  const board = await readBoard(client);
  assert.equal(board.orders.length, 3);
  assert.ok(board.warnings.some(warning => warning.includes('Повторяющихся')));
  await assert.rejects(moveOrder(client, { id: '007', status: 'В работе', expectedStatus: 'Новый' }), { code: 'DUPLICATE_ORDER_ID', statusCode: 409 });
  assert.equal(client.writes.length, 0);
});

test('move rejects stale source status with no write', async () => {
  const client = new MockSheets();
  client.data['Заказы'][1][7] = 'Готов';
  await assert.rejects(moveOrder(client, { id: '007', status: 'В работе', expectedStatus: 'Новый' }), { code: 'STATUS_CONFLICT', statusCode: 409 });
  assert.equal(client.writes.length, 0);
});

test('unknown and blank statuses remain visible but are invalid destinations', async () => {
  const client = new MockSheets();
  client.data['Заказы'][1][7] = 'Архивный';
  client.data['Заказы'][2][7] = '';
  const board = await readBoard(client);
  assert.deepEqual(board.configuredStatuses, ['Новый', 'В работе', 'Готов']);
  assert.deepEqual(board.statuses, ['Новый', 'В работе', 'Готов', 'Архивный', '']);
  for (const status of ['Архивный', '', '=IMPORTXML("bad")']) {
    await assert.rejects(moveOrder(client, { id: '007', status, expectedStatus: 'Архивный' }), { code: 'INVALID_STATUS', statusCode: 422 });
  }
  assert.equal(client.writes.length, 0);
  await moveOrder(client, { id: '7', status: 'Новый', expectedStatus: '' });
  assert.deepEqual(client.writes[0], [{ range: "'Заказы'!H3", values: [['Новый']] }]);
});

test('moves require expected status and refuse missing order', async () => {
  const client = new MockSheets();
  await assert.rejects(moveOrder(client, { id: '007', status: 'Готов' }), { code: 'INVALID_MOVE', statusCode: 400 });
  await assert.rejects(moveOrder(client, { id: 'missing', status: 'Готов', expectedStatus: 'Новый' }), { code: 'ORDER_NOT_FOUND', statusCode: 404 });
  assert.equal(client.writes.length, 0);
});

test('unchanged valid status is a no-op', async () => {
  const client = new MockSheets();
  const result = await moveOrder(client, { id: '007', status: 'Новый', expectedStatus: 'Новый' });
  assert.equal(result.changed, false);
  assert.equal(client.writes.length, 0);
});

test('ordinary status moves cannot bypass archive completion but existing Сдан remains a no-op', async () => {
  const client = new MockSheets();
  client.data['Настройки'].push(row('Настройки', { 'Статус заказа': 'Сдан' }));
  client.data['Заказы'][1][7] = 'Готов к выдаче';
  await assert.rejects(moveOrder(client, { id: '007', status: 'Сдан', expectedStatus: 'Готов к выдаче' }), { code: 'ARCHIVE_REQUIRED', statusCode: 409 });
  assert.equal(client.writes.length, 0);
  client.data['Заказы'][1][7] = 'Сдан';
  assert.equal((await moveOrder(client, { id: '007', status: 'Сдан', expectedStatus: 'Сдан' })).changed, false);
  assert.equal(client.writes.length, 0);
});

test('verification detects a concurrent row reorder without issuing rollback or retry', async () => {
  const client = new MockSheets();
  client.afterWrite = () => { [client.data['Заказы'][1], client.data['Заказы'][2]] = [client.data['Заказы'][2], client.data['Заказы'][1]]; };
  await assert.rejects(moveOrder(client, { id: '007', status: 'Готов', expectedStatus: 'Новый' }), { code: 'MOVE_UNCONFIRMED', statusCode: 409 });
  assert.equal(client.writes.length, 1);
});

test('verification detects rejected or overwritten status', async () => {
  const client = new MockSheets();
  client.afterWrite = () => { client.data['Заказы'][1][7] = 'Новый'; };
  await assert.rejects(moveOrder(client, { id: '007', status: 'Готов', expectedStatus: 'Новый' }), { code: 'MOVE_UNCONFIRMED' });
  assert.equal(client.writes.length, 1);
});

test('ambiguous status header refuses writes', async () => {
  const client = new MockSheets();
  client.data['Заказы'][0].push('Статус');
  await assert.rejects(moveOrder(client, { id: '007', status: 'Готов', expectedStatus: 'Новый' }), { code: 'SHEET_HEADERS' });
  assert.equal(client.writes.length, 0);
});

test('client joins also support the source blank-header client ID column', async () => {
  const client = new MockSheets();
  client.data['Заказы'][1][3] = 'C1';
  const board = await readBoard(client);
  assert.equal(board.orders[0].contacts[0].name, 'Антон');
});

test('number parsing distinguishes missing, zero, negative and invalid data', () => {
  for (const empty of ['', null, undefined, '-', '#REF!', 'abc', '12 34 bad', '1,2,3']) assert.equal(parseNumber(empty), null);
  for (const zero of [0, '0', '0,00 ₽', '—', '— ₽']) assert.equal(parseNumber(zero), 0);
  assert.equal(parseNumber('1\u202f234\u00a0567,89 ₽'), 1234567.89);
  assert.equal(parseNumber('−12,50 руб.'), -12.5);
  assert.equal(parseNumber('(12,50 ₽)'), null, 'unknown accounting formats are not guessed');
  assert.equal(parseNumber('-1.234,50'), -1234.5);
  assert.equal(parseNumber('12 500,50 ₽'), 12500.5);
  assert.equal(parseNumber('3 000'), 3000);
});

test('dates use explicit day-month-year and preserve invalid source text', () => {
  assert.equal(parseDate('2.9.2026'), '2026-09-02');
  assert.equal(parseDate('2026-09-02'), '2026-09-02');
  assert.equal(parseDate('31.02.2026'), '31.02.2026');
  assert.equal(parseDate('после согласования'), 'после согласования');
  assert.equal(parseDate(46267), '2026-09-02');
  assert.equal(columnName(26), 'AA');
});

test('Google write request explicitly uses RAW and has exactly the requested cell', async () => {
  const client = new GoogleSheetsClient({ spreadsheetId: 'test-sheet' });
  let request;
  client.request = async (path, options) => { request = { path, options }; return {}; };
  await client.updateValues([{ range: "'Заказы'!H2", values: [['Готов']] }]);
  assert.equal(request.path, '/values:batchUpdate');
  assert.deepEqual(JSON.parse(request.options.body), { valueInputOption: 'RAW', data: [{ range: "'Заказы'!H2", values: [['Готов']] }] });
});

test('real-client batch path reads every bounded tab in two batches for effective values and formula guards', async () => {
  const client = new MockSheets();
  const batches = [];
  client.getRanges = async ranges => {
    batches.push(ranges);
    return { valueRanges: ranges.map(range => ({ range, values: client.data[range.match(/^'([^']+)'!/)[1]] })) };
  };
  client.getValues = async () => { assert.fail('batch-capable client should not request each tab separately'); };
  const board = await readBoard(client);
  assert.equal(board.orders.length, 2);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 7);
  assert.equal(batches[0][0], "'Заказы'!A1:AD1234");
  assert.equal(batches[0][6], "'Расходы'!A1:AJ1240");
  await moveOrder(client, { id: '007', status: 'Готов', expectedStatus: 'Новый' });
  assert.equal(batches[2].length, 2, 'move re-reads current settings and order data together');
  assert.equal(batches[4].length, 1, 'move verification re-reads orders');
  assert.equal(client.writes.length, 1);
});

test('incomplete batch result fails closed and cannot present a partial board', async () => {
  const client = new MockSheets();
  client.getRanges = async () => ({ valueRanges: [{ values: client.data['Заказы'] }] });
  await assert.rejects(readBoard(client), { code: 'SHEET_RESPONSE', statusCode: 502 });
  assert.equal(client.writes.length, 0);
});

test('batch URL contains all requested ranges and formatted-value mode', async () => {
  const client = new GoogleSheetsClient({ spreadsheetId: 'test-sheet' });
  let request;
  client.request = async path => { request = path; return {}; };
  await client.getRanges(["'Заказы'!A1:S200", "'Настройки'!A1:H100"]);
  const url = new URL(request, 'https://example.invalid');
  assert.equal(url.pathname, '/values:batchGet');
  assert.deepEqual(url.searchParams.getAll('ranges'), ["'Заказы'!A1:S200", "'Настройки'!A1:H100"]);
  assert.equal(url.searchParams.get('valueRenderOption'), 'FORMATTED_VALUE');
  await client.getRanges(["'Монтажи'!A1:J1000"], { valueRenderOption: 'FORMULA' });
  const rawUrl = new URL(request, 'https://example.invalid');
  assert.equal(rawUrl.searchParams.get('dateTimeRenderOption'), 'SERIAL_NUMBER', 'raw formula request must retain actual numeric dates');
});

test('uncertain write is never retried automatically', async () => {
  const client = new MockSheets();
  let writes = 0;
  client.updateValues = async () => { writes++; throw Object.assign(new Error('Timeout'), { code: 'SHEETS_TIMEOUT' }); };
  await assert.rejects(moveOrder(client, { id: '007', status: 'Готов', expectedStatus: 'Новый' }), { code: 'SHEETS_TIMEOUT' });
  assert.equal(writes, 1);
});

test('Google response body never enters user-visible error', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => 'secret token credential email' });
    const client = new GoogleSheetsClient({ spreadsheetId: 'test-sheet' });
    await assert.rejects(client.fetchJson('https://example.invalid', {}, 'sheets'), error => {
      assert.equal(error.code, 'SHEETS_UNAVAILABLE');
      assert.equal(error.statusCode, 502);
      assert.ok(!/secret|token|credential|email|403/.test(error.message));
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
