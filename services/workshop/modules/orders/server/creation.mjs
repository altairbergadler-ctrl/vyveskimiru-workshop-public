import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { a1 } from './sheets.mjs';
import { OrderError, columnName, parseDate, readTables } from './orders.mjs';

const INITIAL_STATUS = 'Расчёт / КП';
const SHEETS = ['Заказы', 'Настройки', 'Клиенты', 'Позиции', 'Производство', 'Платежи', 'Расходы'];
const FORMULAS = ['Срок сдачи', 'Сумма заказа', 'Себестоимость', 'Доп. расходы', 'Валовая прибыль', 'Маржа, %', 'Оплачено', 'Долг', 'Дней до сдачи', 'сорт.'];
const FIELDS = [
  { id: 'title', label: 'Название заказа', type: 'text', required: true },
  { id: 'createdDate', label: 'Дата заказа', type: 'date', required: true },
  { id: 'client', label: 'Клиент', type: 'select', required: true },
  { id: 'manager', label: 'Менеджер', type: 'select', setting: 'Сотрудник' },
  { id: 'amountOverride', label: 'Сумма вручную', type: 'number', minimum: 0 },
  { id: 'costOverride', label: 'Себестоимость вручную', type: 'number', minimum: 0 },
  { id: 'desiredDate', label: 'Желаемая дата клиента', type: 'date' },
  { id: 'dueOverride', label: 'Срок сдачи вручную', type: 'date' },
  { id: 'comment', label: 'Комментарий', type: 'textarea' },
];
const queues = new Map();
const text = value => value === undefined || value === null ? '' : String(value).trim();
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const blank = value => value === '' || value === undefined || value === null;
const formula = value => typeof value === 'string' && value.startsWith('=');
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
const unconfirmed = () => new OrderError('ORDER_CREATE_UNCONFIRMED', 'Создание заказа пока не подтверждено. Обновите доску и повторите проверку этой же заявки. Повторная запись не выполняется.', 409);

function optionsFor(field, tables) {
  const table = tables[field.id === 'client' ? 'Клиенты' : 'Настройки'];
  const label = field.id === 'client' ? 'Название / ФИО клиента' : field.setting;
  return table.rows.map(row => table.rawCell(row, label)).filter(value => text(value));
}

function schema(tables) {
  const table = tables['Заказы'];
  for (const label of ['№ заказа', 'Статус', 'Фактическая дата готовности', ...FORMULAS, ...FIELDS.map(field => field.label)]) {
    if (!table.indices.has(label)) throw new OrderError('ORDER_CREATE_SCHEMA', 'В таблице не хватает полей для нового заказа. Проверьте структуру листа «Заказы».', 409);
  }
  const settings = tables['Настройки'];
  const statuses = [...new Set(settings.rows.map(row => settings.rawCell(row, 'Статус заказа')).filter(value => text(value) === INITIAL_STATUS))];
  if (statuses.length !== 1) throw new OrderError('ORDER_CREATE_STATUS', 'В настройках должен быть один статус «Расчёт / КП».', 409);
  return statuses[0];
}

export async function orderCreationForm(client) {
  const { tables } = await readTables(client, ['Заказы', 'Настройки', 'Клиенты'], { includeFormulas: true });
  schema(tables);
  return {
    initialStatus: INITIAL_STATUS,
    fields: FIELDS.map(field => ({
      id: field.id, label: field.label, type: field.type, editable: true, derived: false,
      required: Boolean(field.required), value: field.id === 'createdDate' ? today() : '',
      ...(field.minimum !== undefined ? { minimum: field.minimum } : {}),
      ...(field.id === 'client' ? { contacts: tables['Клиенты'].rows.map(row=>({name:text(tables['Клиенты'].cell(row,'Название / ФИО клиента')),phone:text(tables['Клиенты'].cell(row,'Телефон')),contact:text(tables['Клиенты'].cell(row,'Контактное лицо'))})).filter(c=>c.name) } : {}),
      ...(field.type === 'select' ? { options: [...new Set(optionsFor(field, tables).map(text))] } : {}),
    })),
  };
}

function validateChanges(changes, tables) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).some(id => !FIELDS.some(field => field.id === id))) {
    throw new OrderError('INVALID_ORDER_CREATE', 'Переданы неизвестные поля нового заказа.', 400);
  }
  const result = {};
  for (const field of FIELDS) {
    let value = Object.hasOwn(changes, field.id) ? changes[field.id] : field.id === 'createdDate' ? today() : '';
    if (value === null) value = '';
    if (value === '') {
      if (field.required) throw new OrderError('REQUIRED_FIELD', `Заполните поле «${field.label}».`, 422);
      result[field.id] = '';
      continue;
    }
    if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new OrderError('INVALID_FIELD', `«${field.label}»: укажите неотрицательное число.`, 400);
    } else {
      if (typeof value !== 'string' || value.length > 12000 || /\u0000/u.test(value)) throw new OrderError('INVALID_FIELD', `Проверьте поле «${field.label}».`, 400);
      value = value.trim();
      if (!value && field.required) throw new OrderError('REQUIRED_FIELD', `Заполните поле «${field.label}».`, 422);
      if (value && field.type === 'date') {
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || parseDate(value) !== value || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new OrderError('INVALID_FIELD', `«${field.label}»: укажите существующую дату.`, 400);
        value = (Date.parse(`${value}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000;
      }
      if (value && field.type === 'select') {
        const matches = optionsFor(field, tables).filter(option => text(option) === value);
        const unique = [...new Set(matches)];
        if (unique.length !== 1 || field.id === 'client' && matches.length !== 1) throw new OrderError('INVALID_FIELD', `«${field.label}»: выберите существующее однозначное значение из списка.`, 422);
        value = unique[0];
      }
    }
    result[field.id] = value;
  }
  return result;
}

function candidateRow(table) {
  const derived = new Set(FORMULAS.map(label => table.indices.get(label)));
  for (let index = table.headerIndex + 1; index < table.rawValues.length; index++) {
    const row = table.rawValues[index] ?? [];
    if (![...derived].every(column => formula(row[column]))) continue;
    if (row.some((value, column) => !derived.has(column) && !blank(value))) continue;
    return index + 1;
  }
  throw new OrderError('ORDER_CREATE_NO_ROW', 'В таблице закончились подготовленные строки с формулами. Добавьте их на листе «Заказы».', 409);
}

function nextId(tables, reservedMaximum = 0) {
  let largest = reservedMaximum;
  for (const table of Object.values(tables)) {
    const label = table.name === 'Расходы' ? '№ заказа (если есть)' : '№ заказа';
    if (!table.indices.has(label)) continue;
    for (const row of table.rows) {
      const raw = table.cell(row, label);
      if (!text(raw)) continue;
      const value = Number(text(raw));
      if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) continue;
      if (!Number.isSafeInteger(value) || value === Number.MAX_SAFE_INTEGER) throw new OrderError('ORDER_CREATE_ID', 'Нельзя безопасно назначить следующий номер заказа. Проверьте номера в таблице.', 409);
      largest = Math.max(largest, value);
    }
  }
  return largest + 1;
}

function syncDirectory(directory) {
  let fd;
  try { fd = fs.openSync(directory, 'r'); fs.fsyncSync(fd); }
  catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EISDIR', 'EINVAL'].includes(error.code)) throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function saveRecord(directory, record, fresh = false) {
  const filename = path.join(directory, `${record.requestId}.json`);
  const target = fresh ? filename : `${filename}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(target, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  if (!fresh) fs.renameSync(target, filename);
  syncDirectory(directory);
}

function readRecord(directory, requestId) {
  try { return JSON.parse(fs.readFileSync(path.join(directory, `${requestId}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new OrderError('ORDER_CREATE_JOURNAL', 'Не удалось проверить журнал создания заказов. Повторная запись заблокирована.', 503); }
}

// Read-only receipt state for callers choosing a new attempt after a proven unsent refusal.
export function orderCreationState(requestId, { journalDir = process.env.ORDER_CREATE_DIR || '/var/lib/orders-kanban/creation' } = {}) {
  if (typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(requestId)) throw new OrderError('INVALID_REQUEST_ID', 'Не указан постоянный номер заявки на создание заказа.', 400);
  return readRecord(path.resolve(journalDir), requestId.toLowerCase())?.state ?? null;
}

export function verifiedOrderCreation(requestId, options={}) {
  if(orderCreationState(requestId, options)!=='verified') return null;
  return String(readRecord(path.resolve(options.journalDir || process.env.ORDER_CREATE_DIR || '/var/lib/orders-kanban/creation'),requestId.toLowerCase()).id);
}

function matchingIds(record, table) {
  return table.rows.filter(row => text(table.cell(row, '№ заказа')) && Number(text(table.cell(row, '№ заказа'))) === record.id);
}

function verifyRecord(record, table) {
  if (record.sheetId !== table.properties.sheetId || hash(record.headers) !== hash(table.headers)) return false;
  const matches = matchingIds(record, table);
  if (matches.length !== 1 || matches[0].rowNumber !== record.rowNumber) return false;
  const actual = table.rawValues[record.rowNumber - 1] ?? [];
  return Array.from({ length: Math.max(actual.length, record.expected.length) }, (_, i) => (actual[i] ?? '') === (record.expected[i] ?? '')).every(Boolean);
}

async function serialized(key, operation) {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(operation);
  queues.set(key, run);
  try { return await run; }
  finally { if (queues.get(key) === run) queues.delete(key); }
}

export async function createOrder(client, { requestId, changes } = {}, { journalDir = process.env.ORDER_CREATE_DIR || '/var/lib/orders-kanban/creation' } = {}) {
  if (typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(requestId)) throw new OrderError('INVALID_REQUEST_ID', 'Не указан постоянный номер заявки на создание заказа.', 400);
  requestId = requestId.toLowerCase();
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new OrderError('INVALID_ORDER_CREATE', 'Не переданы поля нового заказа.', 400);
  const payloadHash = hash(Object.fromEntries(Object.keys(changes).sort().map(key => [key, changes[key]])));
  const directory = path.resolve(journalDir);
  return serialized(directory, async () => {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const existing = readRecord(directory, requestId);
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new OrderError('ORDER_CREATE_REQUEST_CONFLICT', 'Эта заявка уже отправлена с другими полями. Сначала проверьте результат создания.', 409);
      if (existing.state === 'aborted') throw new OrderError('ORDER_CREATE_SOURCE_CHANGED', 'Таблица изменилась до отправки заказа. Обновите форму и начните создание заново.', 409);
      const table = (await readTables(client, ['Заказы'], { includeFormulas: true })).tables['Заказы'];
      // Once readback was durably confirmed, later edits or row sorting must not
      // turn a replay into another creation. Only the unique identity is needed.
      const confirmed = existing.state === 'verified'
        ? existing.sheetId === table.properties.sheetId && matchingIds(existing, table).length === 1
        : verifyRecord(existing, table);
      if (!confirmed) throw unconfirmed();
      saveRecord(directory, { ...existing, state: 'verified' });
      return { id: String(existing.id), changed: true };
    }

    const before = await readTables(client, SHEETS, { includeFormulas: true, optional: ['Монтажи'] });
    const tables = before.tables;
    const status = schema(tables);
    const cleaned = validateChanges(changes, tables);
    const table = tables['Заказы'];
    let reservedMaximum = 0;
    for (const filename of fs.readdirSync(directory).filter(name => /^[a-f0-9-]+\.json$/iu.test(name))) {
      const reservation = readRecord(directory, filename.slice(0, -5));
      if (Number.isSafeInteger(reservation?.id) && reservation.state !== 'aborted') reservedMaximum = Math.max(reservedMaximum, reservation.id);
      if (!reservation || ['verified', 'aborted'].includes(reservation.state)) continue;
      if (!verifyRecord(reservation, table)) throw unconfirmed();
      saveRecord(directory, { ...reservation, state: 'verified' });
    }
    const rowNumber = candidateRow(table);
    if (reservedMaximum >= Number.MAX_SAFE_INTEGER) throw new OrderError('ORDER_CREATE_ID', 'Нельзя безопасно назначить следующий номер заказа.', 409);
    const id = nextId(tables, reservedMaximum);
    const values = { '№ заказа': id, 'Статус': status, ...Object.fromEntries(FIELDS.map(field => [field.label, cleaned[field.id]])) };
    const expected = [...table.rawValues[rowNumber - 1]];
    // Even a RAW empty-string write can clear the native cell's number format.
    // A new row is already empty: leave every omitted optional cell untouched.
    const updates = Object.entries(values).filter(([, value]) => value !== '').map(([label, value]) => {
      const column = table.indices.get(label);
      expected[column] = value;
      return { range: a1(table.name, `${columnName(column)}${rowNumber}`), values: [[value]] };
    });
    const record = { requestId, payloadHash, state: 'reserved', id, rowNumber, sheetId: table.properties.sheetId, headers: table.headers, expected };
    saveRecord(directory, record, true);

    // Reserve durably before the only write, then ensure the chosen row and all
    // linked IDs still match the snapshot used for planning it.
    try {
      const fresh = await readTables(client, SHEETS, { includeFormulas: true, optional: ['Монтажи'] });
      if (hash(Object.values(fresh.tables).map(item => [item.properties.sheetId, item.rawValues])) !== hash(Object.values(tables).map(item => [item.properties.sheetId, item.rawValues]))) throw new Error('changed');
    } catch {
      saveRecord(directory, { ...record, state: 'aborted' });
      throw new OrderError('ORDER_CREATE_SOURCE_CHANGED', 'Таблица изменилась или не ответила до отправки заказа. Обновите форму и повторите создание.', 409);
    }
    try { await client.updateValues(updates); }
    catch (error) {
      if (error.notSubmitted) { saveRecord(directory, { ...record, state: 'aborted' }); throw error; }
      // A timeout after submission still requires readback.
    }
    try {
      const verified = (await readTables(client, ['Заказы'], { includeFormulas: true })).tables['Заказы'];
      if (!verifyRecord(record, verified)) throw new Error('unconfirmed');
      saveRecord(directory, { ...record, state: 'verified' });
    } catch { throw unconfirmed(); }
    return { id: String(id), changed: true };
  });
}
