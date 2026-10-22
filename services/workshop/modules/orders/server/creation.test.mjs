import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrder, orderCreationForm } from './creation.mjs';

const HEADERS = ['№ заказа', 'Название заказа', 'Дата заказа', 'Клиент', 'Сумма вручную', 'Себестоимость вручную', 'Менеджер', 'Статус', 'Желаемая дата клиента', 'Срок сдачи', 'Сумма заказа', 'Себестоимость', 'Доп. расходы', 'Валовая прибыль', 'Маржа, %', 'Оплачено', 'Долг', 'Дней до сдачи', 'Комментарий', 'сорт.', 'Фактическая дата готовности', 'Срок сдачи вручную'];
const formulaColumns = [9, 10, 11, 12, 13, 14, 15, 16, 17, 19];
function prepared(rowNumber) {
  return HEADERS.map((_, column) => formulaColumns.includes(column) ? `=IF(A${rowNumber}="","",A${rowNumber})` : '');
}
class Mock {
  constructor() {
    this.raw = {
      'Заказы': [HEADERS, prepared(2), prepared(3), prepared(4)],
      'Настройки': [['Статус заказа', 'Сотрудник'], ['Расчёт / КП', ' Олег '], ['Согласован', 'Анна']],
      'Клиенты': [['Название / ФИО клиента', 'Телефон'], [' Клиент А ', '+79991234567']],
      'Позиции': [['№ заказа', 'Наименование работы / изделия']],
      'Производство': [['№ заказа', 'Изделие', 'Этап']],
      'Платежи': [['№ заказа', 'Сумма платежа']],
      'Расходы': [['№ заказа (если есть)', 'Сумма', 'Категория']],
      'Монтажи': [['ID монтажа', '№ заказа', 'Статус монтажа']],
    };
    this.raw['Заказы'][1][0] = 13;
    this.raw['Заказы'][1][1] = 'Исходный заказ';
    this.raw['Заказы'][1][7] = 'Согласован';
    this.writes = [];
    this.metadataReads = 0;
  }
  async getSpreadsheet() {
    this.metadataReads++;
    this.beforeMetadata?.(this.metadataReads);
    return { spreadsheetId: 'mock', sheets: Object.keys(this.raw).map((title, sheetId) => ({ properties: { title, sheetId, gridProperties: { rowCount: 1000, columnCount: 28 } } })) };
  }
  async getRanges(ranges, { valueRenderOption } = {}) {
    if (this.failReadback && this.writes.length) throw new Error('read timeout');
    return { valueRanges: ranges.map(range => {
      const name = range.match(/^'([^']+)'!/u)[1];
      const values = structuredClone(this.raw[name]);
      if (valueRenderOption !== 'FORMULA') for (const row of values.slice(1)) for (let column = 0; column < row.length; column++) {
        if (typeof row[column] === 'string' && row[column].startsWith('=')) row[column] = '';
      }
      return { range, values };
    }) };
  }
  async updateValues(updates) {
    this.writes.push(structuredClone(updates));
    if (this.noApply) throw new Error('timeout before result');
    for (const update of updates) {
      const [, letters, row] = update.range.match(/^'Заказы'!([A-Z]+)(\d+)$/u);
      let column = 0;
      for (const letter of letters) column = column * 26 + letter.charCodeAt(0) - 64;
      this.raw['Заказы'][Number(row) - 1][column - 1] = update.values[0][0];
    }
    this.afterWrite?.();
    if (this.throwAfterApply) throw new Error('lost write response');
  }
}
function context(t) {
  const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-creation-'));
  t.after(() => fs.rmSync(journalDir, { recursive: true, force: true }));
  return { journalDir };
}
const payload = changes => ({ requestId: crypto.randomUUID(), changes: { title: 'Новый заказ', createdDate: '2026-09-05', client: 'Клиент А', ...changes } });

test('creation form works without orders and has source client and manager options', async () => {
  const client = new Mock();
  client.raw['Заказы'][1] = prepared(2);
  const form = await orderCreationForm(client);
  assert.equal(form.initialStatus, 'Расчёт / КП');
  assert.deepEqual(form.fields.find(field => field.id === 'client').options, ['Клиент А']);
  assert.deepEqual(form.fields.find(field=>field.id==='client').contacts,[{name:'Клиент А',phone:'+79991234567',contact:''}]);
  assert.deepEqual(form.fields.find(field => field.id === 'manager').options, ['Олег', 'Анна']);
  assert.match(form.fields.find(field => field.id === 'createdDate').value, /^\d{4}-\d{2}-\d{2}$/u);
  assert.equal(form.fields.find(field => field.id === 'title').required, true);
  assert.equal(form.fields.find(field => field.id === 'client').required, true);
  assert.equal(form.fields.some(field => ['id', 'status', 'paid'].includes(field.id)), false);
});

test('create fills first prepared row, preserves every formula and neighboring sheet/row, stores numeric dates and zero', async t => {
  const client = new Mock(); const config = context(t); const before = structuredClone(client.raw);
  const result = await createOrder(client, payload({ client: 'Клиент А', manager: 'Олег', amountOverride: 0, costOverride: 0, desiredDate: '2026-09-14', dueOverride: '2026-09-15', comment: '=SUM(A1:A99)' }), config);
  assert.deepEqual(result, { id: '14', changed: true });
  const row = client.raw['Заказы'][2];
  assert.equal(row[0], 14);
  assert.equal(row[2], 46270);
  assert.equal(row[3], ' Клиент А ');
  assert.equal(row[4], 0);
  assert.equal(row[5], 0);
  assert.equal(row[6], ' Олег ');
  assert.equal(row[7], 'Расчёт / КП');
  assert.equal(row[8], 46279);
  assert.equal(row[18], '=SUM(A1:A99)');
  assert.equal(row[21], 46280);
  for (const column of formulaColumns) assert.equal(row[column], before['Заказы'][2][column]);
  before['Заказы'][2] = row;
  assert.deepEqual(client.raw, before);
  assert.equal(client.writes.length, 1);
  assert.equal(client.writes[0].some(update => /![J-R]|!T/u.test(update.range)), false);
});

test('auto number accounts for orphan linked IDs and every linked source', async t => {
  const client = new Mock();
  client.raw['Позиции'].push(['00020', 'Позиция']);
  client.raw['Производство'].push(['27', 'Буквы', 'Резка']);
  client.raw['Платежи'].push(['31', 100]);
  client.raw['Расходы'].push(['35', 100, 'Материалы']);
  client.raw['Монтажи'].push(['uuid', '42', 'Назначен']);
  assert.equal((await createOrder(client, payload(), context(t))).id, '43');
});

test('empty optional fields are not sent to Sheets, preserving native currency and date formats', async t => {
  const client = new Mock(); const before = structuredClone(client.raw['Заказы'][2]);
  await createOrder(client, payload({ manager: ' ', amountOverride: null, costOverride: '', desiredDate: null, dueOverride: '', comment: '' }), context(t));
  assert.deepEqual(client.writes[0].map(update => update.range), ["'Заказы'!A3", "'Заказы'!H3", "'Заказы'!B3", "'Заказы'!C3", "'Заказы'!D3"]);
  for (const column of [4, 5, 6, 8, 18, 20, 21]) assert.equal(client.raw['Заказы'][2][column], before[column]);
  assert.equal(client.writes[0].some(update => update.values[0][0] === ''), false);
});

test('missing, null, empty and whitespace clients fail before writing or reserving an order', async t => {
  for (const value of [undefined, null, '', '   ']) {
    const client = new Mock(); const config = context(t); const input = payload({ client: value });
    if (value === undefined) delete input.changes.client;
    const before = structuredClone(client.raw);
    await assert.rejects(createOrder(client, input, config), { code: 'REQUIRED_FIELD', statusCode: 422 });
    assert.deepEqual(client.raw, before);
    assert.equal(client.writes.length, 0);
    assert.deepEqual(fs.readdirSync(config.journalDir), []);
  }
});

test('legacy receipts without a client still confirm the same order without another write', async t => {
  for (const state of ['reserved', 'verified']) {
    const client = new Mock(); const config = context(t); const input = payload();
    const created = await createOrder(client, input, config);
    delete input.changes.client;
    const file = path.join(config.journalDir, input.requestId + '.json');
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    receipt.payloadHash = crypto.createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(input.changes).sort().map(key => [key, input.changes[key]])))).digest('hex');
    receipt.state = state; receipt.expected[3] = ''; client.raw['Заказы'][receipt.rowNumber - 1][3] = '';
    fs.writeFileSync(file, JSON.stringify(receipt));
    assert.equal((await createOrder(client, input, config)).id, created.id);
    assert.equal(client.writes.length, 1);
  }
});

test('concurrent calls serialize IDs and same request is written exactly once', async t => {
  const client = new Mock(); const config = context(t); const input = payload();
  const same = await Promise.all([createOrder(client, input, config), createOrder(client, input, config)]);
  assert.deepEqual(same.map(value => value.id), ['14', '14']);
  const second = await createOrder(client, payload({ title: 'Следующий заказ' }), config);
  assert.equal(second.id, '15');
  assert.equal(client.writes.length, 2);
});

test('parallel distinct requests occupy distinct prepared rows', async t => {
  const client = new Mock(); const config = context(t);
  const results = await Promise.all([createOrder(client, payload(), config), createOrder(client, payload({ title: 'Второй' }), config)]);
  assert.deepEqual(results.map(value => value.id), ['14', '15']);
  assert.equal(client.raw['Заказы'][3][1], 'Второй');
});

test('lost write response and board readback timeout recover by journal without another write', async t => {
  const client = new Mock(); const config = context(t); const input = payload();
  client.throwAfterApply = true;
  client.failReadback = true;
  await assert.rejects(createOrder(client, input, config), { code: 'ORDER_CREATE_UNCONFIRMED' });
  client.failReadback = false;
  assert.equal((await createOrder(client, input, config)).id, '14');
  assert.equal(client.writes.length, 1);
});

test('applied write with lost response succeeds on verified readback', async t => {
  const client = new Mock(); client.throwAfterApply = true;
  assert.equal((await createOrder(client, payload(), context(t))).id, '14');
  assert.equal(client.writes.length, 1);
});

test('uncertain unapplied write never retries or lets a new request reuse the row', async t => {
  const client = new Mock(); const config = context(t); const input = payload(); client.noApply = true;
  await assert.rejects(createOrder(client, input, config), { code: 'ORDER_CREATE_UNCONFIRMED' });
  client.noApply = false;
  await assert.rejects(createOrder(client, input, config), { code: 'ORDER_CREATE_UNCONFIRMED' });
  await assert.rejects(createOrder(client, payload(), config), { code: 'ORDER_CREATE_UNCONFIRMED' });
  assert.equal(client.writes.length, 1);
});

test('same request with changed payload cannot create another order', async t => {
  const client = new Mock(); const config = context(t); const input = payload();
  await createOrder(client, input, config);
  await assert.rejects(createOrder(client, { ...input, changes: { title: 'Другой' } }, config), { code: 'ORDER_CREATE_REQUEST_CONFLICT' });
  assert.equal(client.writes.length, 1);
});

test('UUID letter case does not bypass idempotency and verified numbers are never reused', async t => {
  const client = new Mock(); const config = context(t); const input = payload();
  await createOrder(client, input, config);
  assert.equal((await createOrder(client, { ...input, requestId: input.requestId.toUpperCase() }, config)).id, '14');
  assert.equal(client.writes.length, 1);
  client.raw['Заказы'][2] = prepared(3);
  assert.equal((await createOrder(client, payload(), config)).id, '15');
});

test('durably verified replay accepts later edits and sorting but still requires unique order identity', async t => {
  const client = new Mock(); const config = context(t); const input = payload();
  await createOrder(client, input, config);
  client.raw['Заказы'][2][1] = 'Переименован после создания';
  client.raw['Заказы'][2][7] = 'Согласован';
  [client.raw['Заказы'][1], client.raw['Заказы'][2]] = [client.raw['Заказы'][2], client.raw['Заказы'][1]];
  assert.equal((await createOrder(client, input, config)).id, '14');
  assert.equal(client.writes.length, 1);
  client.raw['Заказы'][3][0] = '0014';
  await assert.rejects(createOrder(client, input, config), { code: 'ORDER_CREATE_UNCONFIRMED' });
  client.raw['Заказы'][3][0] = '';
  client.raw['Заказы'][1][0] = '';
  await assert.rejects(createOrder(client, input, config), { code: 'ORDER_CREATE_UNCONFIRMED' });
  assert.equal(client.writes.length, 1);
});

test('invalid fields, invalid dates, unknown clients, duplicate clients and readonly data fail before journal reservation', async t => {
  for (const changes of [{ title: ' ' }, { id: '20' }, { status: 'Сдан' }, { paid: 10 }, { amountOverride: -1 }, { amountOverride: '1' }, { desiredDate: '2026-02-30' }, { client: 'Несуществующий' }, { manager: 'Другой' }]) {
    const client = new Mock(); const config = context(t);
    await assert.rejects(createOrder(client, payload(changes), config));
    assert.equal(client.writes.length, 0);
    assert.deepEqual(fs.readdirSync(config.journalDir), []);
  }
  const client = new Mock(); client.raw['Клиенты'].push(['Клиент А', 'другой']);
  await assert.rejects(createOrder(client, payload({ client: 'Клиент А' }), context(t)), { code: 'INVALID_FIELD' });
});

test('no prepared formula row fails without overwriting or appending', async t => {
  const client = new Mock(); client.raw['Заказы'][2][10] = ''; client.raw['Заказы'][3][19] = '';
  await assert.rejects(createOrder(client, payload(), context(t)), { code: 'ORDER_CREATE_NO_ROW' });
  assert.equal(client.writes.length, 0);
});

test('rows with any existing input or unknown data are skipped', async t => {
  const client = new Mock(); client.raw['Заказы'][2][25] = 'чужая запись';
  const before = structuredClone(client.raw['Заказы'][2]);
  await createOrder(client, payload(), context(t));
  assert.deepEqual(client.raw['Заказы'][2], before);
  assert.equal(client.raw['Заказы'][3][0], 14);
});

test('source change before sending aborts safely and permits a fresh request', async t => {
  const client = new Mock(); const config = context(t);
  client.beforeMetadata = count => { if (count === 2) client.raw['Заказы'][2][1] = 'Заполнил коллега'; };
  await assert.rejects(createOrder(client, payload(), config), { code: 'ORDER_CREATE_SOURCE_CHANGED' });
  assert.equal(client.writes.length, 0);
  assert.equal((await createOrder(client, payload(), config)).id, '14');
  assert.equal(client.raw['Заказы'][3][0], 14);
});

test('readback checks unchanged formula cells and exact row identity', async t => {
  for (const edit of [client => { client.raw['Заказы'][2][10] = '=CHANGED'; }, client => { client.raw['Заказы'][3][0] = 14; }, client => { client.raw['Заказы'][3][0] = '0014'; }]) {
    const client = new Mock(); client.afterWrite = () => edit(client);
    await assert.rejects(createOrder(client, payload(), context(t)), { code: 'ORDER_CREATE_UNCONFIRMED' });
    assert.equal(client.writes.length, 1);
  }
});

test('request ID cannot escape journal directory', async t => {
  await assert.rejects(createOrder(new Mock(), { requestId: '../escape', changes: { title: 'Заказ' } }, context(t)), { code: 'INVALID_REQUEST_ID' });
});


test('a known unsent contract refusal aborts the reservation without claiming a lost response', async t => {
  const client = new Mock(), options = context(t), input = payload({});
  const before = structuredClone(client.raw);
  client.updateValues = async () => { throw Object.assign(new Error('Contract denied'), { code: 'SHEETS_CONTRACT_HEADER', notSubmitted: true }); };
  await assert.rejects(() => createOrder(client, input, options), { code: 'SHEETS_CONTRACT_HEADER' });
  const record = JSON.parse(fs.readFileSync(path.join(options.journalDir, `${input.requestId}.json`), 'utf8'));
  assert.equal(record.state, 'aborted');
  assert.deepEqual(client.raw, before);
});
