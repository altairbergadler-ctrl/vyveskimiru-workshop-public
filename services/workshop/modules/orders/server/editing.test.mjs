import test from 'node:test';
import assert from 'node:assert/strict';
import { readBoard, moveOrder, editRecord, createInstallation, prepareFinancialEdit, INSTALLATION_HEADERS, INSTALLATION_STATUSES } from './orders.mjs';

const HEADERS = {
  'Заказы': ['№ заказа', 'Название заказа', 'Дата заказа', 'Клиент', 'Сумма вручную', 'Себестоимость вручную', 'Менеджер', 'Статус', 'Желаемая дата клиента', 'Срок сдачи', 'Сумма заказа', 'Себестоимость', 'Доп. расходы', 'Валовая прибыль', 'Маржа, %', 'Оплачено', 'Долг', 'Дней до сдачи', 'Комментарий', 'сорт.', 'Фактическая дата готовности', 'Срок сдачи вручную'],
  'Настройки': ['Статус заказа', 'Сотрудник', 'Касса / счёт', 'Категория расхода'],
  'Позиции': ['№ заказа', 'Название заказа', 'Наименование работы / изделия', 'Описание, макет, адрес', 'Ед. изм.', 'Ширина, м', 'Высота, м', 'Кол-во', 'Объём (расч.)', 'Цена за ед.', 'Сумма', 'Себест. за ед.', 'Себестоимость', 'Дата заказа'],
  'Клиенты': ['', 'Название / ФИО клиента', 'Тип', 'Контактное лицо', 'Телефон', 'Email', 'ИНН / реквизиты', 'Источник', 'Дата добавления', 'Комментарий'],
  'Производство': ['№ заказа', 'Название заказа', 'Изделие', 'Клиент', 'Срок сдачи', 'Этап', 'Готово', 'Можно', 'Исполнитель', 'План', 'Факт', 'Часы', 'Норма, ч', 'К оплате', 'Ждёт 1', 'Ждёт 2', 'Комментарий'],
  'Платежи': ['Дата', '№ заказа', 'Название заказа', 'Клиент', 'Сумма заказа', 'Оплачено до этого', 'Сумма платежа', 'Касса / счёт', 'Вид платежа', 'Остаток после платежа', 'Комментарий', 'Деньги в кассе', 'sync_id', 'sync_updated_at', 'sync_deleted', 'sync_origin'],
  'Расходы': ['Дата', 'Категория', 'Описание', 'Сумма', 'Касса / счёт', '№ заказа (если есть)', 'Название заказа', 'Поставщик', 'Комментарий', 'sync_id', 'sync_updated_at', 'sync_deleted', 'sync_origin'],
  'Монтажи': INSTALLATION_HEADERS,
};
const row = (name, values) => HEADERS[name].map(header => values[header] ?? '');
class Mock {
  constructor() {
    this.spreadsheetId = 'mock';
    this.writes = [];
    this.appends = [];
    this.nativeTables = [{ tableId: 'installation-table', range: { sheetId: 7, startRowIndex: 0, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex: 10 } }];
    this.raw = {
      'Заказы': [HEADERS['Заказы'], row('Заказы', { '№ заказа': '001', 'Название заказа': 'Вывеска', 'Дата заказа': 46267, 'Клиент': 'Клиент А', 'Статус': 'В производстве', 'Менеджер': 'Анна', 'Желаемая дата клиента': 46274, 'Срок сдачи': '=IF(V2<>"";V2;I2)', 'Сумма заказа': '=SUM(Позиции!K2:K9)', 'Себестоимость': '=SUM(Позиции!M2:M9)', 'Оплачено': '=SUM(Платежи!G2:G9)', 'Долг': '=K2-P2' }), row('Заказы', { '№ заказа': '002', 'Название заказа': 'Баннер', 'Клиент': 'Клиент А', 'Статус': 'В производстве' })],
      'Настройки': [HEADERS['Настройки'], ['В производстве', 'Анна', 'Банк', 'Материалы'], ['Готов к выдаче', 'Пётр', 'Касса', 'Доставка'], ['Монтаж'], ['Сдан'], ['Отменён']],
      'Клиенты': [HEADERS['Клиенты'], row('Клиенты', { 'Название / ФИО клиента': 'Клиент А', 'Контактное лицо': 'Алексей', 'Телефон': '+79990000000' })],
      'Позиции': [HEADERS['Позиции'], row('Позиции', { '№ заказа': '001', 'Название заказа': '=Заказы!B2', 'Наименование работы / изделия': 'Буквы', 'Описание, макет, адрес': 'Макет', 'Кол-во': 2, 'Цена за ед.': 5000, 'Сумма': '=H2*J2', 'Объём (расч.)': '=H2' })],
      'Производство': [[], [], [], [], [], [], [], HEADERS['Производство'], row('Производство', { '№ заказа': '001', 'Название заказа': '=Заказы!B2', 'Изделие': 'Вывеска', 'Этап': 'Монтаж неона на основание', 'Готово': false, 'Можно': '=TRUE', 'Исполнитель': 'Анна' }), row('Производство', { '№ заказа': '001', 'Изделие': 'Вывеска', 'Этап': 'Монтаж', 'Готово': false })],
      'Платежи': [HEADERS['Платежи'], row('Платежи', { 'Дата': 46267, '№ заказа': '001', 'Клиент': '=Заказы!D2', 'Сумма платежа': 1000, 'Касса / счёт': 'Банк', 'Вид платежа': '=IF(G2<K2;"Предоплата";"Оплата")', 'Деньги в кассе': false, 'sync_id': 'payment-1' })],
      'Расходы': [HEADERS['Расходы'], row('Расходы', { 'Дата': 46267, 'Категория': 'Материалы', 'Описание': 'Пластик', 'Сумма': 100, 'Касса / счёт': 'Банк', '№ заказа (если есть)': '001', 'Поставщик': 'Склад', 'sync_id': 'expense-1' })],
      'Монтажи': [INSTALLATION_HEADERS],
    };
  }
  set(name, rowNumber, header, value) { this.raw[name][rowNumber - 1][this.raw[name][name === 'Производство' ? 7 : 0].indexOf(header)] = value; }
  get(name, rowNumber, header) { return this.raw[name][rowNumber - 1][this.raw[name][name === 'Производство' ? 7 : 0].indexOf(header)]; }
  async getSpreadsheet() { return { spreadsheetId: 'mock', sheets: Object.keys(this.raw).map((title, sheetId) => ({ properties: { title, sheetId, gridProperties: { rowCount: 1000, columnCount: 26 } } })) }; }
  async getRanges(ranges, { valueRenderOption } = {}) {
    return { valueRanges: ranges.map(range => {
      const name = range.match(/^'([^']+)'!/)[1];
      const values = structuredClone(this.raw[name]);
      if (valueRenderOption !== 'FORMULA') for (const [i, cells] of values.entries()) for (const [j, value] of cells.entries()) {
        if (typeof value === 'string' && value.startsWith('=')) {
          const header = values[name === 'Производство' ? 7 : 0][j];
          cells[j] = ({ 'Клиент': 'Клиент А', 'Вид платежа': 'Предоплата', 'Название заказа': 'Вывеска', 'Срок сдачи': 46274, 'Сумма заказа': 10000, 'Себестоимость': 2000, 'Оплачено': 1000, 'Долг': 9000, 'Сумма': 10000, 'Объём (расч.)': 2, 'Можно': 'Можно' })[header] ?? '';
        }
        if (valueRenderOption === 'FORMATTED_VALUE' && name === 'Монтажи' && i > 0 && j === 3 && typeof value === 'number') cells[j] = '9/14/2026';
      }
      return { range, values };
    }) };
  }
  async updateValues(data) {
    this.writes.push(structuredClone(data));
    for (const entry of data) {
      const [, name, letters, rowString] = entry.range.match(/^'([^']+)'!([A-Z]+)(\d+)$/);
      let column = 0; for (const letter of letters) column = column * 26 + letter.charCodeAt(0) - 64;
      this.raw[name][Number(rowString) - 1][column - 1] = entry.values[0][0];
    }
    this.afterWrite?.();
  }
  async request(path, options) {
    if (path.startsWith('?fields=')) return { sheets: [{ properties: { title: 'Монтажи', sheetId: 7 }, tables: structuredClone(this.nativeTables) }] };
    assert.equal(path, ':batchUpdate');
    const { requests } = JSON.parse(options.body);
    assert.equal(requests.length, 1);
    const append = requests[0].appendCells;
    assert.equal(append.sheetId, 7, 'Google validates grid ID before resolving the native table ID');
    assert.equal(append.tableId, 'installation-table');
    assert.equal(append.fields, 'userEnteredValue');
    this.appends.push(append);
    for (const rowData of append.rows) {
      const values = rowData.values.map(cell => Object.values(cell.userEnteredValue)[0]);
      const free = this.raw['Монтажи'].findIndex((cells, index) => index > 0 && cells.every(value => value === '' || value === undefined || value === null));
      if (free < 0) this.raw['Монтажи'].push(values);
      else this.raw['Монтажи'][free] = values;
    }
    return {};
  }
  async appendValues() { assert.fail('values.append must never determine a native table insertion row'); }
}
const field = (entity, id) => entity.edit.fields.find(entry => entry.id === id);

test('board exposes editable raw fields and explicit sources for formula totals', async () => {
  const client = new Mock(); const board = await readBoard(client); const order = board.orders[0];
  assert.equal(field(order, 'dueOverride').editable, true);
  assert.equal(field(order, 'dueDate').editable, false);
  assert.match(field(order, 'dueDate').source, /вручную/);
  assert.equal(field(order, 'amountOverride').editable, true);
  assert.equal(field(order, 'paid').derived, true);
  assert.equal(field(order, 'profit').value, 5000);
  assert.equal(field(order, 'profit').editable, false);
  assert.equal(field(order, 'margin').value, '50 %');
  assert.match(field(order, 'profit').source, /50% суммы заказа до рекламы/);
  assert.equal(field(order.payments[0], 'kind').editable, false);
  assert.equal(field(order.production[0], 'availability').editable, false);
  assert.equal(field(order.contacts[0], 'phone').editable, true);
  assert.match(order.edit.record.revision, /^[a-f0-9]{64}$/);
});

test('order edits use manual overrides and preserve deadline/financial formulas', async () => {
  const client = new Mock(); const order = (await readBoard(client)).orders[0]; const before = structuredClone(client.raw);
  await editRecord(client, { type: 'order', record: order.edit.record, changes: { title: 'Новая вывеска', amountOverride: 12000, costOverride: 2500, dueOverride: '2026-09-14' } });
  assert.deepEqual(client.writes[0].map(update => update.range), ["'Заказы'!B2", "'Заказы'!E2", "'Заказы'!F2", "'Заказы'!V2"]);
  assert.equal(client.get('Заказы', 2, 'Срок сдачи вручную'), 46279);
  assert.equal(client.get('Заказы', 2, 'Срок сдачи'), before['Заказы'][1][9]);
  assert.equal(client.get('Заказы', 2, 'Сумма заказа'), before['Заказы'][1][10]);
  assert.deepEqual(client.raw['Платежи'], before['Платежи']);
});

test('clear override writes an empty raw cell and never replaces formula', async () => {
  const client = new Mock(); client.set('Заказы', 2, 'Сумма вручную', 12000); const order = (await readBoard(client)).orders[0];
  await editRecord(client, { type: 'order', record: order.edit.record, changes: { amountOverride: null } });
  assert.deepEqual(client.writes, [[{ range: "'Заказы'!E2", values: [['']] }]]);
});

test('generic order editor cannot set Сдан, while other fields of an archived order remain editable', async () => {
  const client = new Mock(); client.set('Заказы', 2, 'Статус', 'Готов к выдаче');
  const ready = (await readBoard(client)).orders[0];
  await assert.rejects(editRecord(client, { type: 'order', record: ready.edit.record, changes: { status: 'Сдан', comment: 'Не записывать частично' } }), { code: 'ARCHIVE_REQUIRED', statusCode: 409 });
  assert.equal(client.writes.length, 0);
  assert.equal(client.get('Заказы', 2, 'Комментарий'), '');
  client.set('Заказы', 2, 'Статус', 'Сдан');
  const archived = (await readBoard(client)).orders[0];
  await editRecord(client, { type: 'order', record: archived.edit.record, changes: { status: 'Сдан', comment: 'Уточнение архива' } });
  assert.deepEqual(client.writes, [[{ range: "'Заказы'!S2", values: [['Уточнение архива']] }]]);
});

test('formula unexpectedly inserted in an otherwise raw field is protected', async () => {
  const client = new Mock(); client.set('Заказы', 2, 'Комментарий', '=A2'); const order = (await readBoard(client)).orders[0];
  assert.equal(field(order, 'comment').editable, false);
  await assert.rejects(editRecord(client, { type: 'order', record: order.edit.record, changes: { comment: 'overwrite' } }), { code: 'FIELD_READ_ONLY' });
  assert.equal(client.writes.length, 0);
});

test('raw revision rejects source changes and row reordering before any write', async () => {
  for (const reorder of [false, true]) {
    const client = new Mock(); const order = (await readBoard(client)).orders[0];
    if (reorder) [client.raw['Заказы'][1], client.raw['Заказы'][2]] = [client.raw['Заказы'][2], client.raw['Заказы'][1]];
    else client.set('Заказы', 3, 'Название заказа', 'Изменение коллеги');
    await assert.rejects(editRecord(client, { type: 'order', record: order.edit.record, changes: { comment: 'Правка' } }), { code: 'RECORD_CONFLICT', statusCode: 409 });
    assert.equal(client.writes.length, 0);
  }
});

test('paired display/raw snapshots reject a sort between reads instead of attaching wrong edit token', async () => {
  const client = new Mock(); const getRanges = client.getRanges.bind(client);
  client.getRanges = async (ranges, options = {}) => {
    const result = await getRanges(ranges, options);
    if (options.valueRenderOption === 'FORMULA') {
      const orders = result.valueRanges.find(range => range.range.startsWith("'Заказы'!"));
      if (orders) [orders.values[1], orders.values[2]] = [orders.values[2], orders.values[1]];
    }
    return result;
  };
  await assert.rejects(readBoard(client), { code: 'SHEET_READ_CHANGED', statusCode: 409 });
  assert.equal(client.writes.length, 0);
});

test('paired snapshots detect literal field edits even when the order ID is unchanged', async () => {
  const client = new Mock(); const getRanges = client.getRanges.bind(client);
  client.getRanges = async (ranges, options = {}) => {
    const result = await getRanges(ranges, options);
    if (options.valueRenderOption === 'FORMULA') {
      const contacts = result.valueRanges.find(range => range.range.startsWith("'Клиенты'!"));
      if (contacts) contacts.values[1][4] = '+79992222222';
    }
    return result;
  };
  await assert.rejects(readBoard(client), { code: 'SHEET_READ_CHANGED', statusCode: 409 });
});

test('unformatted reads preserve exact source numbers without relying on rounded Google display', async () => {
  const client = new Mock(); client.set('Позиции', 2, 'Кол-во', 2.555); client.set('Платежи', 2, 'Сумма платежа', 1000.25);
  const getRanges = client.getRanges.bind(client);
  const modes = [];
  client.getRanges = async (ranges, options = {}) => {
    modes.push(options.valueRenderOption);
    const result = await getRanges(ranges, options);
    if (options.valueRenderOption === 'FORMATTED_VALUE' || !options.valueRenderOption) for (const range of result.valueRanges) {
      if (range.range.startsWith("'Позиции'!")) range.values[1][7] = '2,56';
      if (range.range.startsWith("'Платежи'!")) range.values[1][6] = '1 000 ₽';
    }
    return result;
  };
  const order = (await readBoard(client)).orders[0];
  assert.equal(order.items[0].quantity, 2.555);
  assert.equal(field(order.items[0], 'quantity').value, 2.555);
  assert.equal(order.payments[0].amount, 1000.25);
  assert.deepEqual(modes, ['UNFORMATTED_VALUE', 'FORMULA']);
  await assert.rejects(prepareFinancialEdit(client, { type: 'payment', record: order.payments[0].edit.record, changes: { comment: 'Правка' } }), { code: 'FINANCE_INVALID' });
  assert.equal(client.writes.length, 0);
});

test('post-write verification detects a concurrent edit and never retries', async () => {
  const client = new Mock(); const order = (await readBoard(client)).orders[0];
  client.afterWrite = () => client.set('Заказы', 2, 'Название заказа', 'Внешняя правка');
  await assert.rejects(editRecord(client, { type: 'order', record: order.edit.record, changes: { comment: 'Правка' } }), { code: 'EDIT_UNCONFIRMED' });
  assert.equal(client.writes.length, 1);
});

test('Ready move records actual date while preserving planned date and production stages', async () => {
  const client = new Mock(); const before = structuredClone(client.raw);
  await moveOrder(client, { id: '001', expectedStatus: 'В производстве', status: 'Готов к выдаче' });
  assert.deepEqual(client.writes[0].map(update => update.range), ["'Заказы'!H2", "'Заказы'!U2"]);
  assert.equal(typeof client.get('Заказы', 2, 'Фактическая дата готовности'), 'number');
  assert.equal(client.get('Заказы', 2, 'Срок сдачи'), before['Заказы'][1][9]);
  assert.deepEqual(client.raw['Производство'], before['Производство']);
});

test('ready transition requires readiness schema before writing anything', async () => {
  const client = new Mock(); client.raw['Заказы'][0] = client.raw['Заказы'][0].map(header => header === 'Фактическая дата готовности' ? '' : header);
  await assert.rejects(moveOrder(client, { id: '001', expectedStatus: 'В производстве', status: 'Готов к выдаче' }), { code: 'SCHEMA_REQUIRED' });
  assert.equal(client.writes.length, 0);
});

test('stage checkboxes remain independent; only the order status completes manufacturing', async () => {
  const client = new Mock(); let order = (await readBoard(client)).orders[0];
  assert.equal(order.manufacturingDone, false);
  await editRecord(client, { type: 'production', record: order.production[0].edit.record, changes: { done: true } });
  order = (await readBoard(client)).orders[0];
  assert.equal(order.manufacturingDone, false);
  assert.equal(order.production[1].done, false);
  assert.equal(order.status, 'В производстве', 'checking a production stage does not move an order');
  assert.equal(order.readyDate, '');
  await moveOrder(client, { id: order.id, expectedStatus: order.status, status: 'Готов к выдаче' });
  order = (await readBoard(client)).orders[0];
  assert.equal(order.manufacturingDone, true);
  assert.equal(order.production[1].done, false);
});

test('Ready status completes manufacturing even with unchecked stages', async () => {
  const client = new Mock();
  const before = (await readBoard(client)).orders[0];
  await moveOrder(client, { id: before.id, expectedStatus: before.status, status: 'Готов к выдаче' });
  const after = (await readBoard(client)).orders[0];
  assert.equal(after.manufacturingDone, true);
  assert.equal(after.production[0].done, false);
});

test('contact rename updates exact linked orders and preserves all formula columns', async () => {
  const client = new Mock(); const contact = (await readBoard(client)).orders[0].contacts[0];
  await editRecord(client, { type: 'contact', record: contact.edit.record, changes: { companyName: 'Новое имя', phone: '+79991111111' } });
  assert.equal(client.get('Заказы', 2, 'Клиент'), 'Новое имя');
  assert.equal(client.get('Заказы', 3, 'Клиент'), 'Новое имя');
  assert.equal(client.get('Платежи', 2, 'Клиент'), '=Заказы!D2');
  assert.equal(client.writes[0].length, 4);
});

test('finance preparation supplies exact parity fields and performs no sheet writes', async () => {
  const client = new Mock(); const order = (await readBoard(client)).orders[0];
  const result = await prepareFinancialEdit(client, { type: 'payment', record: order.payments[0].edit.record, changes: { amount: 1500, date: '2026-09-14', comment: 'Уточнение' } });
  assert.equal(result.syncId, 'payment-1'); assert.equal(result.type, 'income');
  assert.deepEqual(result.current, { date: '2026-09-02', amount: 1000, account: 'Банк', orderNumber: '001', counterparty: 'Клиент А', comment: '', category: 'Предоплата', description: 'Предоплата · Клиент А' });
  assert.deepEqual(result.changes, { amount: 1500, date: '2026-09-14', comment: 'Уточнение' });
  assert.equal(client.writes.length, 0);
  const expense = await prepareFinancialEdit(client, { type: 'expense', record: order.expenses[0].edit.record, changes: { description: 'Пластик ПВХ' } });
  assert.equal('cashInRegister' in expense.current, false);
});

test('finance edits reject derived fields and decimal values without rounding', async () => {
  const client = new Mock(); const payment = (await readBoard(client)).orders[0].payments[0];
  await assert.rejects(prepareFinancialEdit(client, { type: 'payment', record: payment.edit.record, changes: { kind: 'Оплата' } }), { code: 'FIELD_READ_ONLY' });
  await assert.rejects(prepareFinancialEdit(client, { type: 'payment', record: payment.edit.record, changes: { amount: 123.45 } }), { code: 'FINANCE_INVALID' });
  await assert.rejects(editRecord(client, { type: 'payment', record: payment.edit.record, changes: { amount: 1500 } }), { code: 'FINANCE_ROUTE_REQUIRED' });
  assert.equal(client.writes.length, 0);
});

test('new installation gets unique ID, default agreement status, and independent native date', async () => {
  const client = new Mock(); const before = structuredClone(client.raw['Заказы']);
  const result = await createInstallation(client, { orderId: '001', changes: { date: '2026-09-14', time: '14:30', contact: 'Алексей', phone: '+79990000000', address: 'Адрес монтажа' } });
  assert.match(result.id, /^[a-f0-9-]{36}$/);
  assert.equal(client.appends.length, 1);
  assert.deepEqual(client.appends[0].rows[0].values[3].userEnteredValue, { numberValue: 46279 });
  assert.deepEqual(client.appends[0].rows[0].values[4].userEnteredValue, { stringValue: '14:30' });
  assert.deepEqual(client.appends[0].rows[0].values[6].userEnteredValue, { stringValue: '+79990000000' });
  const order = (await readBoard(client)).orders[0];
  assert.equal(order.installations[0].status, 'На согласовании');
  assert.equal(order.installations[0].date, '2026-09-14', 'use native numeric date even when Google returns M/d/yyyy formatted text');
  assert.equal(order.installations[0].time, '14:30');
  assert.equal(order.installations[0].phone, '+79990000000');
  assert.deepEqual(client.raw['Заказы'], before);
});

test('native append fills row2 then row3 even when the native table has999 empty rows', async () => {
  const client = new Mock(); client.raw['Монтажи'] = [INSTALLATION_HEADERS, ...Array.from({ length: 999 }, () => [])];
  const first = await createInstallation(client, { orderId: '001', changes: { contact: 'Первый' } });
  const second = await createInstallation(client, { orderId: '002', changes: { contact: 'Второй' } });
  assert.equal(client.get('Монтажи', 2, 'ID монтажа'), first.id);
  assert.equal(client.get('Монтажи', 3, 'ID монтажа'), second.id);
  assert.equal(client.raw['Монтажи'].length, 1000, 'native range is preserved without creating row1001');
  assert.equal(client.appends.every(append => append.tableId === 'installation-table'), true);
  assert.equal(client.appends.every(append => append.sheetId === 7), true, 'never fall back to nonexistent sheetId0');
});

test('native append preserves an occupied partial row and uses the next free body row', async () => {
  const client = new Mock(); client.raw['Монтажи'].push(row('Монтажи', { 'Комментарий': 'Существующая заметка без номера' }));
  const added = await createInstallation(client, { orderId: '001', changes: {} });
  assert.equal(client.get('Монтажи', 2, 'Комментарий'), 'Существующая заметка без номера');
  assert.equal(client.get('Монтажи', 3, 'ID монтажа'), added.id);
});

test('missing ambiguous or misaligned native installation table fails before any append', async () => {
  for (const mode of ['missing', 'duplicate', 'misaligned']) {
    const client = new Mock();
    if (mode === 'missing') client.nativeTables = [];
    if (mode === 'duplicate') client.nativeTables.push({ ...client.nativeTables[0], tableId: 'other' });
    if (mode === 'misaligned') client.nativeTables[0].range.startColumnIndex = 1;
    await assert.rejects(createInstallation(client, { orderId: '001', changes: {} }), { code: 'INSTALLATION_TABLE_REQUIRED', statusCode: 409 });
    assert.equal(client.appends.length, 0);
    assert.equal(client.writes.length, 0);
  }
});

test('installation editing preserves linkage and validates agreed statuses/time', async () => {
  const client = new Mock(); await createInstallation(client, { orderId: '001', changes: {} });
  const installation = (await readBoard(client)).orders[0].installations[0];
  assert.deepEqual(field(installation, 'status').options, INSTALLATION_STATUSES);
  for (const changes of [{ status: 'Запланирован' }, { status: '' }, { status: 'Назначен' }, { time: '25:30' }, { orderId: '002' }]) {
    await assert.rejects(editRecord(client, { type: 'installation', record: installation.edit.record, changes }));
  }
  assert.equal(client.writes.length, 0);
  await editRecord(client, { type: 'installation', record: installation.edit.record, changes: { status: 'Назначен', date: '2026-09-14', time: '09:15' } });
  assert.equal(client.get('Монтажи', 2, '№ заказа'), '001');
  assert.equal(client.get('Заказы', 2, 'Статус'), 'В производстве');
});

test('settings selectors preserve canonical trailing spaces for exact downstream matching', async () => {
  const client = new Mock(); client.raw['Настройки'][2][1] = 'Витя ';
  const stage = (await readBoard(client)).orders[0].production[0];
  assert.ok(field(stage, 'assignee').options.includes('Витя'));
  await editRecord(client, { type: 'production', record: stage.edit.record, changes: { assignee: 'Витя' } });
  assert.equal(client.get('Производство', 9, 'Исполнитель'), 'Витя ');
});

test('order client selector cannot orphan a contact and resolves a unique existing name', async () => {
  const client = new Mock(); client.raw['Клиенты'].push(row('Клиенты', { 'Название / ФИО клиента': 'Клиент Б ', 'Контактное лицо': 'Борис' }));
  const order = (await readBoard(client)).orders[0];
  assert.ok(field(order, 'client').options.includes('Клиент Б'));
  await assert.rejects(editRecord(client, { type: 'order', record: order.edit.record, changes: { client: 'Несуществующий' } }), { code: 'CLIENT_NOT_UNIQUE' });
  assert.equal(client.writes.length, 0);
  await editRecord(client, { type: 'order', record: order.edit.record, changes: { client: 'Клиент Б' } });
  assert.equal(client.get('Заказы', 2, 'Клиент'), 'Клиент Б ');
});

test('repairing a legacy order without a client updates its contact and preserves all other cells', async () => {
  const client = new Mock(); client.set('Заказы', 2, 'Клиент', '');
  client.raw['Клиенты'].push(row('Клиенты', { 'Название / ФИО клиента': 'Клиент Б', 'Контактное лицо': 'Борис', 'Телефон': '+79991112233' }));
  const order = (await readBoard(client)).orders[0]; const before = structuredClone(client.raw);
  assert.equal(field(order, 'client').required, true);
  assert.equal(field(order, 'client').contacts.find(contact => contact.name === 'Клиент Б').phone, '+79991112233');
  for (const value of [null, '', '   ']) {
    await assert.rejects(editRecord(client, { type: 'order', record: order.edit.record, changes: { client: value } }), { code: 'CLIENT_NOT_UNIQUE' });
  }
  assert.equal(client.writes.length, 0);
  await editRecord(client, { type: 'order', record: order.edit.record, changes: { client: 'Клиент Б' } });
  before['Заказы'][1][3] = 'Клиент Б';
  assert.deepEqual(client.raw, before);
  const fixed = (await readBoard(client)).orders[0];
  assert.equal(fixed.client, 'Клиент Б');
  assert.equal(fixed.contacts[0].phone, '+79991112233');
});

test('unknown fields, invalid date, and duplicate order IDs fail before mutation', async () => {
  const client = new Mock(); const order = (await readBoard(client)).orders[0];
  await assert.rejects(editRecord(client, { type: 'order', record: order.edit.record, changes: { debt: 0 } }), { code: 'FIELD_READ_ONLY' });
  await assert.rejects(editRecord(client, { type: 'order', record: order.edit.record, changes: { dueOverride: '2026-02-31' } }), { code: 'INVALID_FIELD' });
  client.raw['Заказы'].push([...client.raw['Заказы'][1]]);
  const duplicate = (await readBoard(client)).orders[0];
  await assert.rejects(editRecord(client, { type: 'order', record: duplicate.edit.record, changes: { comment: 'Правка' } }), { code: 'DUPLICATE_ORDER_ID' });
  assert.equal(client.writes.length, 0);
});
