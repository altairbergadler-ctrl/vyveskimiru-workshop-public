import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clientCreationForm, createClient } from './clients.mjs';

const HEADERS = [
  '', 'Название / ФИО клиента', 'Тип', 'Контактное лицо', 'Телефон', 'Email',
  'ИНН / реквизиты', 'Источник', 'Дата добавления', 'Комментарий', 'Заказов, шт',
  'Сумма заказов', 'Оплачено', 'Долг', 'Последний заказ', 'сорт.',
];
const FORMULA_COLUMNS = [0, 10, 11, 12, 13, 14, 15];

function prepared(rowNumber) {
  return HEADERS.map((_, column) => FORMULA_COLUMNS.includes(column)
    ? column === 0
      ? `=IF($B${rowNumber}="";"";"К-"&TEXT(ROW()-1;"000"))`
      : `=IF($B${rowNumber}="";"";0)`
    : '');
}

function existing(rowNumber, companyName = ' Клиент Ёлка ') {
  const row = prepared(rowNumber);
  row[1] = companyName;
  row[2] = 'Физ. лицо';
  row[3] = 'Контакт';
  row[4] = '+79990000000';
  row[5] = 'existing@example.test';
  row[7] = 'Сарафан';
  row[8] = 46000;
  return row;
}

function columnIndex(letters) {
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return result - 1;
}

class Mock {
  constructor() {
    this.raw = {
      'Клиенты': [HEADERS, existing(2), prepared(3), prepared(4), prepared(5)],
      'Настройки': [
        ['Тип клиента', 'Источник клиента', 'Статус заказа'],
        [' Юр. лицо ', ' Сарафан ', 'Расчёт / КП'],
        ['ИП', 'Авито', 'Согласован'],
        ['Физ. лицо', 'Другое', 'В производстве'],
      ],
    };
    this.writes = [];
    this.metadataReads = 0;
  }

  async getSpreadsheet() {
    this.metadataReads++;
    this.beforeMetadata?.(this.metadataReads);
    return {
      spreadsheetId: 'mock',
      sheets: Object.keys(this.raw).map((title, sheetId) => ({
        properties: { title, sheetId, gridProperties: { rowCount: 250, columnCount: 20 } },
      })),
    };
  }

  effective(name) {
    const values = structuredClone(this.raw[name]);
    if (name !== 'Клиенты') return values;
    for (let rowIndex = 1; rowIndex < values.length; rowIndex++) {
      const row = values[rowIndex];
      for (let column = 0; column < row.length; column++) {
        if (typeof row[column] !== 'string' || !row[column].startsWith('=')) continue;
        if (column === 0) row[column] = String(row[1] ?? '').trim() ? `К-${String(rowIndex).padStart(3, '0')}` : '';
        else row[column] = String(row[1] ?? '').trim() ? 0 : '';
      }
    }
    return values;
  }

  async getRanges(ranges, { valueRenderOption } = {}) {
    if (this.failReadback && this.writes.length) throw new Error('read timeout');
    return { valueRanges: ranges.map(range => {
      const name = range.match(/^'([^']+)'!/u)[1];
      return { range, values: valueRenderOption === 'FORMULA' ? structuredClone(this.raw[name]) : this.effective(name) };
    }) };
  }

  async updateValues(updates) {
    this.writes.push(structuredClone(updates));
    if (this.noApply) throw new Error('timeout before apply');
    for (const update of updates) {
      const match = update.range.match(/^'Клиенты'!([A-Z]+)(\d+)$/u);
      assert.ok(match, `unexpected range ${update.range}`);
      this.raw['Клиенты'][Number(match[2]) - 1][columnIndex(match[1])] = update.values[0][0];
    }
    this.afterWrite?.();
    if (this.throwAfterApply) throw new Error('lost write response');
  }
}

function context(t) {
  const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-client-creation-'));
  t.after(() => fs.rmSync(journalDir, { recursive: true, force: true }));
  return { journalDir };
}

function payload(changes = {}) {
  return {
    requestId: crypto.randomUUID(),
    changes: { companyName: 'Новый клиент', createdDate: '2026-09-05', ...changes },
  };
}

test('client form exposes only writable fields, source options and a default date', async () => {
  const form = await clientCreationForm(new Mock());
  assert.deepEqual(form.fields.map(field => field.id), [
    'companyName', 'type', 'name', 'phone', 'email', 'requisites', 'source', 'createdDate', 'comment',
  ]);
  assert.equal(form.fields.find(field => field.id === 'companyName').required, true);
  assert.deepEqual(form.fields.find(field => field.id === 'type').options, ['Юр. лицо', 'ИП', 'Физ. лицо']);
  assert.deepEqual(form.fields.find(field => field.id === 'source').options, ['Сарафан', 'Авито', 'Другое']);
  assert.match(form.fields.find(field => field.id === 'createdDate').value, /^\d{4}-\d{2}-\d{2}$/u);
  assert.equal(form.fields.every(field => field.editable && !field.derived), true);
  assert.equal(form.fields.some(field => FORMULA_COLUMNS.includes(HEADERS.indexOf(field.label))), false);
});

test('create writes only B:J manual cells in the first prepared row and stores a numeric date', async t => {
  const client = new Mock();
  const before = structuredClone(client.raw);
  const result = await createClient(client, payload({
    type: 'Юр. лицо', name: 'Иван', phone: '+79991234567', email: 'new@example.test',
    requisites: 'ИНН 123', source: 'Сарафан', comment: '=не формула для приложения',
  }), context(t));

  assert.deepEqual(result, { id: 'К-002', name: 'Новый клиент', changed: true });
  const row = client.raw['Клиенты'][2];
  assert.deepEqual(row.slice(1, 10), [
    'Новый клиент', ' Юр. лицо ', 'Иван', '+79991234567', 'new@example.test',
    'ИНН 123', ' Сарафан ', 46270, '=не формула для приложения',
  ]);
  for (const column of FORMULA_COLUMNS) assert.equal(row[column], before['Клиенты'][2][column]);
  before['Клиенты'][2] = row;
  assert.deepEqual(client.raw, before);
  assert.equal(client.writes.length, 1);
  assert.deepEqual(client.writes[0].map(update => update.range), [
    "'Клиенты'!B3", "'Клиенты'!C3", "'Клиенты'!D3", "'Клиенты'!E3", "'Клиенты'!F3",
    "'Клиенты'!G3", "'Клиенты'!H3", "'Клиенты'!I3", "'Клиенты'!J3",
  ]);
  assert.equal(client.writes[0].some(update => /![AK-P]\d+$/u.test(update.range)), false);
});

test('blank optional fields are not written and prepared formulas remain untouched', async t => {
  const client = new Mock();
  const before = structuredClone(client.raw['Клиенты'][2]);
  const result = await createClient(client, payload({ createdDate: '', phone: ' ', email: null }), context(t));
  assert.equal(result.id, 'К-002');
  assert.deepEqual(client.writes[0].map(update => update.range), ["'Клиенты'!B3"]);
  assert.equal(client.writes[0].some(update => update.values[0][0] === ''), false);
  for (const column of FORMULA_COLUMNS) assert.equal(client.raw['Клиенты'][2][column], before[column]);
});

test('a single normalized duplicate is selected without a write while ambiguous duplicates are rejected', async t => {
  const client = new Mock(); const config = context(t);
  const input = payload({ companyName: '  КЛИЕНТ ЕЛКА  ' });
  assert.deepEqual(await createClient(client, input, config), { id: 'К-001', name: 'Клиент Ёлка', changed: false });
  assert.equal(client.writes.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(config.journalDir, `${input.requestId}.json`), 'utf8')).state, 'verified');
  client.raw['Клиенты'][2][1] = ' клиент елка ';
  await assert.rejects(createClient(client, payload({ companyName: 'КЛИЕНТ ЁЛКА' }), config), { code: 'CLIENT_EXISTS' });
  assert.equal(client.writes.length, 0);
});

test('invalid fields, dates and configured options fail before reservation', async t => {
  const cases = [
    { companyName: ' ' },
    { unknown: 'field' },
    { phone: '\u0000' },
    { email: 'x'.repeat(321) },
    { createdDate: '2026-02-30' },
    { createdDate: '05.09.2026' },
    { type: 'Самозанятый' },
    { source: 'Не из настроек' },
    { comment: 10 },
  ];
  for (const changes of cases) {
    const client = new Mock(); const config = context(t);
    await assert.rejects(createClient(client, payload(changes), config));
    assert.equal(client.writes.length, 0);
    assert.deepEqual(fs.readdirSync(config.journalDir), []);
  }
});

test('lack of a fully prepared formula row does not overwrite or append data', async t => {
  const client = new Mock(); const config = context(t);
  for (let row = 2; row < client.raw['Клиенты'].length; row++) client.raw['Клиенты'][row][15] = '';
  const before = structuredClone(client.raw);
  await assert.rejects(createClient(client, payload(), config), { code: 'CLIENT_CREATE_NO_ROW' });
  assert.deepEqual(client.raw, before);
  assert.equal(client.writes.length, 0);
  assert.deepEqual(fs.readdirSync(config.journalDir), []);
});

test('concurrent requests serialize rows and the same request is written exactly once', async t => {
  const client = new Mock(); const config = context(t); const input = payload();
  const same = await Promise.all([createClient(client, input, config), createClient(client, input, config)]);
  assert.deepEqual(same.map(result => result.id), ['К-002', 'К-002']);
  const distinct = await Promise.all([
    createClient(client, payload({ companyName: 'Второй клиент' }), config),
    createClient(client, payload({ companyName: 'Третий клиент' }), config),
  ]);
  assert.deepEqual(distinct.map(result => result.id), ['К-003', 'К-004']);
  assert.equal(client.writes.length, 3);
});

test('lost write response and readback recover from the journal without another write', async t => {
  const client = new Mock(); const config = context(t); const input = payload();
  client.throwAfterApply = true;
  client.failReadback = true;
  await assert.rejects(createClient(client, input, config), { code: 'CLIENT_CREATE_UNCONFIRMED' });
  client.failReadback = false;
  assert.deepEqual(await createClient(client, input, config), { id: 'К-002', name: 'Новый клиент', changed: true });
  assert.equal(client.writes.length, 1);
});

test('an applied write with a lost response succeeds when exact readback is available', async t => {
  const client = new Mock(); client.throwAfterApply = true;
  assert.equal((await createClient(client, payload(), context(t))).id, 'К-002');
  assert.equal(client.writes.length, 1);
});

test('an uncertain unapplied write is never retried and blocks reuse of its row', async t => {
  const client = new Mock(); const config = context(t); const input = payload();
  client.noApply = true;
  await assert.rejects(createClient(client, input, config), { code: 'CLIENT_CREATE_UNCONFIRMED' });
  client.noApply = false;
  await assert.rejects(createClient(client, input, config), { code: 'CLIENT_CREATE_UNCONFIRMED' });
  await assert.rejects(createClient(client, payload({ companyName: 'Другой клиент' }), config), { code: 'CLIENT_CREATE_UNCONFIRMED' });
  assert.equal(client.writes.length, 1);
});

test('source change before write aborts the request and a fresh request uses the next safe row', async t => {
  const client = new Mock(); const config = context(t);
  client.beforeMetadata = count => { if (count === 2) client.raw['Клиенты'][2][1] = 'Создал коллега'; };
  await assert.rejects(createClient(client, payload(), config), { code: 'CLIENT_CREATE_SOURCE_CHANGED' });
  assert.equal(client.writes.length, 0);
  const result = await createClient(client, payload({ companyName: 'После обновления' }), config);
  assert.equal(result.id, 'К-003');
  assert.equal(client.raw['Клиенты'][3][1], 'После обновления');
});

test('readback detects changed formulas and a duplicate normalized client name', async t => {
  for (const edit of [
    client => { client.raw['Клиенты'][2][10] = '=CHANGED'; },
    client => { client.raw['Клиенты'][3][1] = ' НОВЫЙ КЛИЕНТ '; },
  ]) {
    const client = new Mock();
    client.afterWrite = () => edit(client);
    await assert.rejects(createClient(client, payload(), context(t)), { code: 'CLIENT_CREATE_UNCONFIRMED' });
    assert.equal(client.writes.length, 1);
  }
});

test('verified replay follows sorting and returns the current formula ID while requiring unique identity', async t => {
  const client = new Mock(); const config = context(t); const input = payload();
  await createClient(client, input, config);
  [client.raw['Клиенты'][1], client.raw['Клиенты'][2]] = [client.raw['Клиенты'][2], client.raw['Клиенты'][1]];
  assert.deepEqual(await createClient(client, input, config), { id: 'К-001', name: 'Новый клиент', changed: true });
  assert.equal(client.writes.length, 1);
  client.raw['Клиенты'][3][1] = ' новый клиент ';
  await assert.rejects(createClient(client, input, config), { code: 'CLIENT_CREATE_UNCONFIRMED' });
  assert.equal(client.writes.length, 1);
});

test('verified journal is minimized and contains no contact data or exact expected row', async t => {
  const client = new Mock(); const config = context(t); const input = payload({
    phone: '+79991234567', email: 'private@example.test', comment: 'Внутренняя заметка',
  });
  await createClient(client, input, config);
  const record = JSON.parse(fs.readFileSync(path.join(config.journalDir, `${input.requestId}.json`), 'utf8'));
  assert.deepEqual(Object.keys(record).sort(), ['name', 'payloadHash', 'requestId', 'sheetId', 'state']);
  assert.equal(record.state, 'verified');
  const serialized = JSON.stringify(record);
  for (const value of [input.changes.phone, input.changes.email, input.changes.comment]) assert.equal(serialized.includes(value), false);
  assert.equal(Object.hasOwn(record, 'expected'), false);
  assert.equal(Object.hasOwn(record, 'rowNumber'), false);
  assert.equal(Object.hasOwn(record, 'headers'), false);
});

test('request IDs cannot escape the journal directory and payload reuse conflicts', async t => {
  const client = new Mock(); const config = context(t);
  await assert.rejects(createClient(client, { requestId: '../escape', changes: { companyName: 'Клиент' } }, config), { code: 'INVALID_REQUEST_ID' });
  const input = payload();
  await createClient(client, input, config);
  await assert.rejects(createClient(client, { ...input, changes: { companyName: 'Другое имя' } }, config), { code: 'CLIENT_CREATE_REQUEST_CONFLICT' });
  assert.equal(client.writes.length, 1);
});


test('a known unsent contract refusal aborts the reservation without claiming a lost response', async t => {
  const client = new Mock(), options = context(t), input = payload({});
  const before = structuredClone(client.raw);
  client.updateValues = async () => { throw Object.assign(new Error('Contract denied'), { code: 'SHEETS_CONTRACT_HEADER', notSubmitted: true }); };
  await assert.rejects(() => createClient(client, input, options), { code: 'SHEETS_CONTRACT_HEADER' });
  const record = JSON.parse(fs.readFileSync(path.join(options.journalDir, `${input.requestId}.json`), 'utf8'));
  assert.equal(record.state, 'aborted');
  assert.deepEqual(client.raw, before);
});
