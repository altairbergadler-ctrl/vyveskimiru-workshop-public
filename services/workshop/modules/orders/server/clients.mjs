import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { a1 } from './sheets.mjs';
import { OrderError, columnName, parseDate, readTables } from './orders.mjs';

const FORMULAS = ['Заказов, шт', 'Сумма заказов', 'Оплачено', 'Долг', 'Последний заказ', 'сорт.'];
const FIELDS = [
  { id: 'companyName', label: 'Название / ФИО клиента', type: 'text', required: true, maximum: 300 },
  { id: 'type', label: 'Тип', type: 'select', setting: 'Тип клиента', maximum: 160 },
  { id: 'name', label: 'Контактное лицо', type: 'text', maximum: 300 },
  { id: 'phone', label: 'Телефон', type: 'tel', maximum: 160 },
  { id: 'email', label: 'Email', type: 'email', maximum: 320 },
  { id: 'requisites', label: 'ИНН / реквизиты', type: 'textarea', maximum: 12_000 },
  { id: 'source', label: 'Источник', type: 'select', setting: 'Источник клиента', maximum: 160 },
  { id: 'createdDate', label: 'Дата добавления', type: 'date' },
  { id: 'comment', label: 'Комментарий', type: 'textarea', maximum: 12_000 },
];
const queues = new Map();
const text = value => value === undefined || value === null ? '' : String(value).trim();
const blank = value => value === '' || value === undefined || value === null;
const formula = value => typeof value === 'string' && value.startsWith('=');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
const normalizedName = value => text(value).toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
const unconfirmed = () => new OrderError('CLIENT_CREATE_UNCONFIRMED', 'Создание клиента пока не подтверждено. Нажмите «Проверить клиента»: повторная запись не выполняется.', 409);

function idColumn(table) {
  const name = table.indices.get('Название / ФИО клиента');
  return table.indices.get('ID клиента') ?? table.indices.get('ID') ?? (name > 0 && table.headers[name - 1] === '' ? name - 1 : undefined);
}

function schema(tables) {
  const table = tables['Клиенты'];
  for (const label of [...FIELDS.map(field => field.label), ...FORMULAS]) if (!table.indices.has(label)) {
    throw new OrderError('CLIENT_CREATE_SCHEMA', 'В таблице не хватает полей для нового клиента. Проверьте структуру листа «Клиенты».', 409);
  }
  if (idColumn(table) === undefined) throw new OrderError('CLIENT_CREATE_SCHEMA', 'В таблице не найден формульный ID клиента.', 409);
  return table;
}

function options(field, tables) {
  const settings = tables['Настройки'];
  if (!field.setting || !settings.indices.has(field.setting)) return [];
  return settings.rows.map(row => settings.rawCell(row, field.setting)).filter(value => text(value));
}

export async function clientCreationForm(client) {
  const { tables } = await readTables(client, ['Клиенты', 'Настройки'], { includeFormulas: true });
  schema(tables);
  return { fields: FIELDS.map(field => ({
    id: field.id, label: field.label, type: field.type, editable: true, derived: false,
    required: Boolean(field.required), value: field.id === 'createdDate' ? today() : '',
    ...(field.maximum ? { maxLength: field.maximum } : {}),
    ...(field.type === 'select' ? { options: [...new Set(options(field, tables).map(text))] } : {}),
  })) };
}

function canonicalOption(field, value, tables) {
  if (!value || !field.setting) return value;
  const matches = [...new Set(options(field, tables).filter(option => text(option) === value).map(String))];
  if (matches.length !== 1) throw new OrderError('INVALID_FIELD', `«${field.label}»: выберите значение из настроек таблицы.`, 422);
  return matches[0];
}

function validate(changes, tables) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).some(id => !FIELDS.some(field => field.id === id))) {
    throw new OrderError('INVALID_CLIENT_CREATE', 'Переданы неизвестные поля нового клиента.', 400);
  }
  const result = {};
  for (const field of FIELDS) {
    let value = Object.hasOwn(changes, field.id) ? changes[field.id] : field.id === 'createdDate' ? today() : '';
    if (value === null) value = '';
    if (typeof value !== 'string' || /\u0000/u.test(value)) throw new OrderError('INVALID_FIELD', `Проверьте поле «${field.label}».`, 400);
    value = value.trim();
    if (field.required && !value) throw new OrderError('REQUIRED_FIELD', `Заполните поле «${field.label}».`, 422);
    if (field.maximum && value.length > field.maximum) throw new OrderError('INVALID_FIELD', `Поле «${field.label}» слишком длинное.`, 422);
    if (value && field.type === 'date') {
      const stamp = Date.parse(`${value}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || parseDate(value) !== value || !Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value) {
        throw new OrderError('INVALID_FIELD', `«${field.label}»: укажите существующую дату.`, 422);
      }
      value = (stamp - Date.UTC(1899, 11, 30)) / 86400000;
    } else value = canonicalOption(field, value, tables);
    result[field.id] = value;
  }
  return result;
}

function candidateRow(table) {
  const derived = new Set([idColumn(table), ...FORMULAS.map(label => table.indices.get(label))]);
  for (let index = table.headerIndex + 1; index < table.rawValues.length; index++) {
    const row = table.rawValues[index] ?? [];
    if (![...derived].every(column => formula(row[column]))) continue;
    if (row.some((value, column) => !derived.has(column) && !blank(value))) continue;
    return index + 1;
  }
  throw new OrderError('CLIENT_CREATE_NO_ROW', 'На листе «Клиенты» закончились подготовленные строки с формулами.', 409);
}

function plan(table, cleaned) {
  const rowNumber = candidateRow(table);
  const expected = [...(table.rawValues[rowNumber - 1] ?? [])];
  const values = Object.fromEntries(FIELDS.map(field => [field.label, cleaned[field.id]]));
  const updates = Object.entries(values).filter(([, value]) => value !== '').map(([label, value]) => {
    const column = table.indices.get(label);
    expected[column] = value;
    return { range: a1(table.name, `${columnName(column)}${rowNumber}`), values: [[value]] };
  });
  return { rowNumber, expected, updates };
}

function currentByName(record, table) {
  if (record.sheetId !== table.properties.sheetId) return null;
  const matches = table.rows.filter(row => normalizedName(row.cells[table.indices.get('Название / ФИО клиента')]) === normalizedName(record.name));
  if (matches.length !== 1) return null;
  const row = matches[0];
  const id = text(row.cells[idColumn(table)]);
  if (!id) return null;
  return { id, name: text(row.cells[table.indices.get('Название / ФИО клиента')]), rowNumber: row.rowNumber };
}

function exactRow(record, table) {
  if (record.sheetId !== table.properties.sheetId || hash(record.headers) !== hash(table.headers)) return null;
  const row = table.rows.find(candidate => candidate.rowNumber === record.rowNumber);
  if (!row) return null;
  const actual = table.rawValues[record.rowNumber - 1] ?? [];
  const exact = Array.from({ length: Math.max(actual.length, record.expected.length) }, (_, index) => (actual[index] ?? '') === (record.expected[index] ?? '')).every(Boolean);
  if (!exact) return null;
  const current = currentByName(record, table);
  if (!current || current.rowNumber !== record.rowNumber) return null;
  return { id: current.id, name: current.name };
}

function verifiedRecord(record, confirmed) {
  return { requestId: record.requestId, payloadHash: record.payloadHash, state: 'verified', sheetId: record.sheetId, name: confirmed.name };
}

function snapshot(tables) {
  return hash(['Клиенты', 'Настройки'].map(name => [tables[name].properties.sheetId, tables[name].headers, tables[name].rawValues]));
}

function syncDirectory(directory) {
  let fd;
  try { fd = fs.openSync(directory, 'r'); fs.fsyncSync(fd); }
  catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EISDIR', 'EINVAL'].includes(error.code)) throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function save(directory, record, fresh = false) {
  const filename = path.join(directory, `${record.requestId}.json`);
  const target = fresh ? filename : `${filename}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(target, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  if (!fresh) fs.renameSync(target, filename);
  syncDirectory(directory);
}

function load(directory, requestId) {
  try { return JSON.parse(fs.readFileSync(path.join(directory, `${requestId}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new OrderError('CLIENT_CREATE_JOURNAL', 'Не удалось проверить журнал создания клиентов.', 503); }
}

async function serialized(key, operation) {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(operation);
  queues.set(key, run);
  try { return await run; }
  finally { if (queues.get(key) === run) queues.delete(key); }
}

export async function createClient(client, { requestId, changes } = {}, { journalDir = process.env.CLIENT_CREATE_DIR || '/var/lib/orders-kanban/client-creation' } = {}) {
  if (typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(requestId)) throw new OrderError('INVALID_REQUEST_ID', 'Не указан постоянный номер заявки на создание клиента.', 400);
  requestId = requestId.toLowerCase();
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new OrderError('INVALID_CLIENT_CREATE', 'Не переданы поля нового клиента.', 400);
  const payloadHash = hash(Object.fromEntries(Object.keys(changes).sort().map(key => [key, changes[key]])));
  const directory = path.resolve(journalDir);
  return serialized(directory, async () => {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const existing = load(directory, requestId);
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new OrderError('CLIENT_CREATE_REQUEST_CONFLICT', 'Эта заявка уже отправлена с другими полями.', 409);
      if (existing.state === 'aborted') throw new OrderError('CLIENT_CREATE_SOURCE_CHANGED', 'Таблица изменилась до отправки клиента. Обновите форму и начните создание заново.', 409);
      const table = (await readTables(client, ['Клиенты'], { includeFormulas: true })).tables['Клиенты'];
      const confirmed = existing.state === 'verified' ? currentByName(existing, table) : exactRow(existing, table);
      if (!confirmed) throw unconfirmed();
      save(directory, verifiedRecord(existing, confirmed));
      return { id: confirmed.id, name: confirmed.name, changed: true };
    }

    const before = await readTables(client, ['Клиенты', 'Настройки'], { includeFormulas: true });
    const tables = before.tables;
    const table = schema(tables);
    const cleaned = validate(changes, tables);
    const matches = table.rows.filter(row => normalizedName(table.cell(row, 'Название / ФИО клиента')) === normalizedName(cleaned.companyName));
    if (matches.length > 1) throw new OrderError('CLIENT_EXISTS', 'В таблице несколько клиентов с таким именем. Уточните имя в карточке клиента.', 422);
    if (matches.length === 1) {
      const matched = matches[0];
      const confirmed = { id: text(matched.cells[idColumn(table)]), name: text(matched.cells[table.indices.get('Название / ФИО клиента')]) };
      if (!confirmed.id || !confirmed.name) throw new OrderError('CLIENT_CREATE_SCHEMA', 'У найденного клиента нет корректного формульного ID.', 409);
      save(directory, verifiedRecord({ requestId, payloadHash, sheetId: table.properties.sheetId }, confirmed), true);
      return { ...confirmed, changed: false };
    }
    for (const filename of fs.readdirSync(directory).filter(name => /^[a-f0-9-]+\.json$/iu.test(name))) {
      const record = load(directory, filename.slice(0, -5));
      if (!record || ['verified', 'aborted'].includes(record.state)) continue;
      const confirmed = exactRow(record, table);
      if (!confirmed) throw unconfirmed();
      save(directory, verifiedRecord(record, confirmed));
    }
    const planned = plan(table, cleaned);
    const record = {
      requestId, payloadHash, state: 'reserved', name: cleaned.companyName, rowNumber: planned.rowNumber,
      sheetId: table.properties.sheetId, headers: table.headers, expected: planned.expected,
    };
    save(directory, record, true);
    try {
      const fresh = await readTables(client, ['Клиенты', 'Настройки'], { includeFormulas: true });
      if (snapshot(fresh.tables) !== snapshot(tables)) throw new Error('changed');
    } catch {
      save(directory, { ...record, state: 'aborted' });
      throw new OrderError('CLIENT_CREATE_SOURCE_CHANGED', 'Таблица изменилась до отправки клиента. Обновите форму и повторите создание.', 409);
    }
    try { await client.updateValues(planned.updates); } catch (error) {
      if (error.notSubmitted) { save(directory, { ...record, state: 'aborted' }); throw error; }
    }
    try {
      const verified = (await readTables(client, ['Клиенты'], { includeFormulas: true })).tables['Клиенты'];
      const confirmed = exactRow(record, verified);
      if (!confirmed) throw new Error('unconfirmed');
      save(directory, verifiedRecord(record, confirmed));
      return { ...confirmed, changed: true };
    } catch { throw unconfirmed(); }
  });
}
