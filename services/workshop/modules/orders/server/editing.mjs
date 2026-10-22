import crypto from 'node:crypto';
import { estimatedOrderProfit } from '../../../server/order-profit.mjs';
import { a1 } from './sheets.mjs';
import { OrderError, columnName, configuredStatuses, findUniqueOrder, parseDate, parseNumber, readTables } from './orders.mjs';

export const INSTALLATION_STATUSES = ['На согласовании', 'Назначен', 'Выполнен', 'Отменён'];
export const INSTALLATION_HEADERS = ['ID монтажа', '№ заказа', 'Статус монтажа', 'Дата', 'Время', 'Контакт', 'Телефон', 'Адрес', 'Комментарий', 'Исполнитель'];
const TYPE_SHEETS = { order: 'Заказы', item: 'Позиции', contact: 'Клиенты', production: 'Производство', payment: 'Платежи', expense: 'Расходы', installation: 'Монтажи' };
const string = value => value === undefined || value === null ? '' : String(value).trim();
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const trueValue = value => value === true || /^(true|истина|да|1|✓)$/iu.test(string(value));
const formula = value => typeof value === 'string' && value.startsWith('=');
const revisions = new WeakMap();
const field = (id, label, type = 'text', extra = {}) => ({ id, label, type, ...extra });
const derived = (id, label, source, type = 'text', extra = {}) => field(id, label, type, { derived: true, source, ...extra });

const FIELDS = {
  order: [
    field('id', '№ заказа', 'text', { locked: true, source: 'Общий номер связывает заказ, позиции, производство и финансы. Изменение номера требует переноса связей.' }),
    field('title', 'Название заказа'), field('createdDate', 'Дата заказа', 'date'), field('client', 'Клиент', 'select'),
    field('amountOverride', 'Сумма вручную', 'number', { minimum: 0 }), field('costOverride', 'Себестоимость вручную', 'number', { minimum: 0 }),
    field('manager', 'Менеджер', 'select', { setting: 'Сотрудник' }), field('status', 'Статус', 'select', { setting: 'Статус заказа' }),
    field('desiredDate', 'Желаемая дата клиента', 'date'), field('dueOverride', 'Срок сдачи вручную', 'date'),
    field('readyDate', 'Фактическая дата готовности', 'date'), field('comment', 'Комментарий', 'textarea'),
    derived('dueDate', 'Срок сдачи', 'Срок сдачи вручную; если пусто — Желаемая дата клиента.', 'date'),
    derived('amount', 'Сумма заказа', 'Сумма вручную или стоимость позиций заказа.', 'number'),
    derived('cost', 'Себестоимость', 'Себестоимость вручную или себестоимость позиций.', 'number'),
    derived('extraCost', 'Доп. расходы', 'Связанные расходы на листе «Расходы».', 'number'),
    derived('profit', 'Валовая прибыль', 'Сумма заказа, себестоимость и дополнительные расходы.', 'number'),
    derived('margin', 'Маржа, %', 'Валовая прибыль и сумма заказа.', 'text', { aliases: ['Маржа %'] }),
    derived('paid', 'Оплачено', 'Связанные платежи. Изменяется редактированием платежей.', 'number'),
    derived('debt', 'Долг', 'Сумма заказа минус оплачено. Переплата сохраняется отрицательной.', 'number'),
    derived('daysUntilDue', 'Дней до сдачи', 'Плановый срок сдачи и статус заказа.', 'number'),
  ],
  item: [
    field('orderId', '№ заказа'), derived('orderTitle', 'Название заказа', 'Название связанного заказа.'),
    field('name', 'Наименование работы / изделия'), field('description', 'Описание, макет, адрес', 'textarea', { aliases: ['Описание макет адрес'] }),
    field('unit', 'Ед. изм.', 'select', { setting: 'Ед. изм.' }), field('width', 'Ширина, м', 'number', { aliases: ['Ширина м'], minimum: 0 }),
    field('height', 'Высота, м', 'number', { aliases: ['Высота м'], minimum: 0 }), field('quantity', 'Кол-во', 'number', { minimum: 0 }),
    field('unitPrice', 'Цена за ед.', 'number', { minimum: 0 }), field('unitCost', 'Себест. за ед.', 'number', { minimum: 0 }),
    derived('volume', 'Объём (расч.)', 'Единица измерения, ширина, высота и количество.', 'number'),
    derived('amount', 'Сумма', 'Объём и цена за единицу.', 'number'), derived('cost', 'Себестоимость', 'Объём и себестоимость за единицу.', 'number'),
    derived('createdDate', 'Дата заказа', 'Дата связанного заказа.', 'date'),
  ],
  contact: [
    field('companyName', 'Название / ФИО клиента', 'text', { reason: 'Общий клиент: новое название также изменится в связанных заказах.' }),
    field('type', 'Тип', 'select', { setting: 'Тип клиента' }), field('name', 'Контактное лицо'), field('phone', 'Телефон'), field('email', 'Email'),
    field('requisites', 'ИНН / реквизиты', 'textarea'), field('source', 'Источник', 'select', { setting: 'Источник клиента' }),
    field('createdDate', 'Дата добавления', 'date'), field('comment', 'Комментарий', 'textarea'),
    derived('ordersCount', 'Заказов, шт', 'Заказы этого клиента.', 'number'), derived('amount', 'Сумма заказов', 'Заказы этого клиента.', 'number'),
    derived('paid', 'Оплачено', 'Платежи по заказам клиента.', 'number'), derived('debt', 'Долг', 'Суммы и оплата заказов клиента.', 'number'),
    derived('lastOrderDate', 'Последний заказ', 'Последняя дата заказа клиента.', 'date'),
  ],
  production: [
    field('orderId', '№ заказа'), derived('orderTitle', 'Название заказа', 'Название связанного заказа.'), field('product', 'Изделие'),
    derived('client', 'Клиент', 'Клиент связанного заказа.'), derived('dueDate', 'Срок сдачи', 'Плановый срок связанного заказа.', 'date'),
    field('name', 'Этап'), field('done', 'Готово', 'boolean'), derived('availability', 'Можно', 'Готовность предыдущих этапов.'),
    field('assignee', 'Исполнитель', 'select', { setting: 'Сотрудник' }), field('planDate', 'План', 'date'), field('actualDate', 'Факт', 'date'),
    field('hours', 'Часы', 'number', { minimum: 0 }), field('comment', 'Комментарий', 'textarea'),
    derived('standardHours', 'Норма, ч', 'Норматив этапа производства.', 'number', { aliases: ['Норма ч'] }),
    derived('payable', 'К оплате', 'Часы и ставка исполнителя.', 'number'), derived('wait1', 'Ждёт 1', 'Зависимости этапа.'), derived('wait2', 'Ждёт 2', 'Зависимости этапа.'),
  ],
  payment: [
    field('date', 'Дата', 'date'), field('orderId', '№ заказа'), derived('orderTitle', 'Название заказа', 'Название связанного заказа.'),
    derived('client', 'Клиент', 'Клиент связанного заказа.'), derived('orderAmount', 'Сумма заказа', 'Сумма связанного заказа.', 'number'),
    derived('paidBefore', 'Оплачено до этого', 'Предыдущие платежи заказа.', 'number'), field('amount', 'Сумма платежа', 'number', { minimum: 1 }),
    field('account', 'Касса / счёт', 'select', { setting: 'Касса / счёт' }), derived('kind', 'Вид платежа', 'Вычисляется по сумме и предыдущим платежам.'),
    derived('remaining', 'Остаток после платежа', 'Сумма заказа и платежи.', 'number'), field('comment', 'Комментарий', 'textarea'),
  ],
  expense: [
    field('date', 'Дата', 'date'), field('category', 'Категория', 'select', { setting: 'Категория расхода' }), field('description', 'Описание', 'textarea'),
    field('amount', 'Сумма', 'number', { minimum: 1 }), field('account', 'Касса / счёт', 'select', { setting: 'Касса / счёт' }),
    field('orderId', '№ заказа (если есть)'), derived('orderTitle', 'Название заказа', 'Название связанного заказа.'),
    field('counterparty', 'Поставщик'), field('comment', 'Комментарий', 'textarea'),
  ],
  installation: [
    field('id', 'ID монтажа', 'text', { locked: true, source: 'Постоянный номер записи монтажа.' }), field('orderId', '№ заказа', 'text', { locked: true, source: 'Монтаж связан с этим заказом.' }),
    field('status', 'Статус монтажа', 'select', { options: INSTALLATION_STATUSES }), field('date', 'Дата', 'date'), field('time', 'Время', 'time'),
    field('contact', 'Контакт'), field('phone', 'Телефон'), field('address', 'Адрес', 'textarea'), field('comment', 'Комментарий', 'textarea'),
    field('assignee', 'Исполнитель', 'select', { setting: 'Сотрудник' }),
  ],
};

function fieldColumn(table, definition) {
  return [definition.label, ...(definition.aliases ?? [])].map(label => table.indices.get(label)).find(index => index !== undefined);
}

function fieldValue(table, row, definition) {
  const column = fieldColumn(table, definition);
  const raw = table.rawValues[row.rowNumber - 1]?.[column];
  const value = formula(raw) || definition.derived ? row.cells[column] : raw;
  if (definition.id === 'margin' && typeof value === 'number') return new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 2 }).format(value);
  if (definition.type === 'number') return parseNumber(value);
  if (definition.type === 'date') return parseDate(value);
  if (definition.type === 'boolean') return trueValue(value);
  return string(value);
}

function settingsOptions(table, setting) {
  if (!table || !setting) return [];
  return [...new Set(table.rows.map(row => string(table.cell(row, setting))).filter(Boolean))];
}

function canonicalSettingValue(table, setting, value) {
  if (!table || !setting) return value;
  const matches = [...new Set(table.rows.map(row => table.rawCell(row, setting)).filter(candidate => string(candidate) === value).map(candidate => String(candidate)))];
  if (matches.length > 1) throw new OrderError('AMBIGUOUS_OPTION', 'В настройках есть неоднозначные значения. Проверьте пробелы и повторы в таблице.', 409);
  return matches[0] ?? value;
}

function rowKey(type, table, row) {
  if (type === 'order') return string(table.cell(row, '№ заказа'));
  if (type === 'installation') return string(table.rawCell(row, 'ID монтажа'));
  if (type === 'payment' || type === 'expense') return string(table.rawCell(row, 'sync_id'));
  return hash(table.rawValues[row.rowNumber - 1] ?? []);
}

function recordToken(type, table, row) {
  if (!revisions.has(table)) revisions.set(table, hash([table.properties.sheetId, table.headers, table.rawValues]));
  const key = rowKey(type, table, row);
  return { sheet: table.name, rowNumber: row.rowNumber, key, revision: hash([revisions.get(table), row.rowNumber, key]) };
}

export function describeRecord(type, table, row, tables) {
  const record = recordToken(type, table, row);
  const fields = FIELDS[type].map(definition => {
    const column = fieldColumn(table, definition);
    const value = fieldValue(table, row, definition);
    const hasFormula = column !== undefined && formula(table.rawValues[row.rowNumber - 1]?.[column]);
    const options = type === 'order' && definition.id === 'client'
      ? [...new Set((tables['Клиенты']?.rows ?? []).map(candidate => string(tables['Клиенты'].rawCell(candidate, 'Название / ФИО клиента'))).filter(Boolean))]
      : definition.options ?? settingsOptions(tables['Настройки'], definition.setting);
    const financeMissingId = (type === 'payment' || type === 'expense') && !record.key;
    const editable = column !== undefined && !definition.derived && !definition.locked && !hasFormula && !financeMissingId;
    const result = {
      id: definition.id, label: definition.label, type: definition.type, value, editable,
      derived: Boolean(definition.derived || hasFormula),
      source: definition.source || `${table.name} → ${definition.label}`,
    };
    if (type === 'order' && definition.id === 'client') {
      result.required = true;
      result.contacts = (tables['Клиенты']?.rows ?? []).map(candidate => ({
        name: string(tables['Клиенты'].rawCell(candidate, 'Название / ФИО клиента')),
        phone: string(tables['Клиенты'].cell(candidate, 'Телефон')),
        contact: string(tables['Клиенты'].cell(candidate, 'Контактное лицо')),
      })).filter(contact => contact.name);
    }
    // Read-only presentation follows the site's temporary estimate. Column
    // mapping and revision guards still use the untouched Google source.
    if (type === 'order' && ['profit', 'margin'].includes(definition.id)) {
      const amount = parseNumber(table.cell(row, 'Сумма заказа'));
      result.value = definition.id === 'profit' ? estimatedOrderProfit(amount) : (amount ? '50 %' : null);
      result.label = definition.id === 'profit' ? 'Оценочная прибыль (50%)' : 'Оценочная маржа, %';
      result.source = 'Временная оценка: 50% суммы заказа до рекламы. Формулы Google не изменены.';
    }
    if (definition.type === 'select') result.options = [...new Set([...options, ...(value ? [value] : [])])];
    if (definition.minimum !== undefined) result.minimum = definition.minimum;
    if (definition.reason) result.reason = definition.reason;
    if (column === undefined) result.reason = 'Поле пока отсутствует в таблице.';
    else if (hasFormula && !definition.derived) result.reason = 'В ячейке формула: её исходные данные нужно изменить в таблице.';
    else if (financeMissingId) result.reason = 'Операция ещё не связана с финансовым приложением.';
    return result;
  });
  return { type, record, fields };
}

export function describeInstallation(table, row, tables) {
  const edit = describeRecord('installation', table, row, tables);
  return { ...Object.fromEntries(edit.fields.map(entry => [entry.id, entry.value])), edit };
}

function dateSerial(iso) {
  return (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;
}

function validateValue(definition, value, tables) {
  if (definition.type === 'boolean') {
    if (typeof value !== 'boolean') throw new OrderError('INVALID_FIELD', `«${definition.label}»: ожидается отметка да/нет.`, 400);
    return value;
  }
  if (value === null || value === '') return '';
  if (definition.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (definition.minimum !== undefined && value < definition.minimum)) {
      throw new OrderError('INVALID_FIELD', `«${definition.label}»: проверьте число.`, 400);
    }
    return value;
  }
  if (typeof value !== 'string' || value.length > 12_000 || /\u0000/u.test(value)) throw new OrderError('INVALID_FIELD', `«${definition.label}»: некорректное значение.`, 400);
  const clean = value.trim();
  if (definition.type === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(clean) || parseDate(clean) !== clean || !Number.isFinite(Date.parse(`${clean}T00:00:00Z`)) || new Date(`${clean}T00:00:00Z`).toISOString().slice(0, 10) !== clean) {
      throw new OrderError('INVALID_FIELD', `«${definition.label}»: укажите существующую дату.`, 400);
    }
    return dateSerial(clean);
  }
  if (definition.type === 'time' && !/^([01]\d|2[0-3]):[0-5]\d$/u.test(clean)) throw new OrderError('INVALID_FIELD', 'Укажите время в формате ЧЧ:ММ.', 400);
  if (definition.type === 'select') {
    const allowed = definition.options ?? settingsOptions(tables['Настройки'], definition.setting);
    if (allowed.length && !allowed.includes(clean)) throw new OrderError('INVALID_FIELD', `«${definition.label}»: выберите значение из списка.`, 422);
    return canonicalSettingValue(tables['Настройки'], definition.setting, clean);
  }
  return clean;
}

function writeFor(table, row, column, value) {
  if (column === undefined) throw new OrderError('SCHEMA_REQUIRED', 'Нужное поле ещё не добавлено в таблицу.', 409);
  if (formula(table.rawValues[row.rowNumber - 1]?.[column])) throw new OrderError('FORMULA_PROTECTED', 'Поле вычисляется формулой. Измените его исходные данные.', 409);
  return { range: a1(table.name, `${columnName(column)}${row.rowNumber}`), values: [[value]] };
}

export function readyDateWrites(table, row, status) {
  if (status !== 'Готов к выдаче' || string(table.rawCell(row, 'Фактическая дата готовности'))) return [];
  const column = table.indices.get('Фактическая дата готовности');
  if (column === undefined) throw new OrderError('SCHEMA_REQUIRED', 'Для готовности заказа нужно поле «Фактическая дата готовности» в таблице.', 409);
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
  return [writeFor(table, row, column, dateSerial(today))];
}

function decodeRange(range) {
  const match = range.match(/^'((?:[^']|'')+)'!([A-Z]+)(\d+)$/u);
  if (!match) throw new Error('Unexpected write range');
  let column = 0;
  for (const letter of match[2]) column = column * 26 + letter.charCodeAt(0) - 64;
  return { name: match[1].replaceAll("''", "'"), column: column - 1, rowNumber: Number(match[3]) };
}

export function verifyWrites(before, after, updates) {
  const changedRows = new Map();
  for (const update of updates) {
    const { name, column, rowNumber } = decodeRange(update.range);
    const key = `${name}:${rowNumber}`;
    if (!changedRows.has(key)) changedRows.set(key, { name, rowNumber, changes: new Map() });
    changedRows.get(key).changes.set(column, update.values[0][0]);
  }
  for (const { name, rowNumber, changes } of changedRows.values()) {
    if (!after[name] || hash(before[name].headers) !== hash(after[name].headers)) throw new Error('Header moved during write');
    const old = before[name].rawValues[rowNumber - 1] ?? [];
    const current = after[name].rawValues[rowNumber - 1] ?? [];
    for (let column = 0; column < Math.max(old.length, current.length, before[name].headers.length); column++) {
      const expected = changes.has(column) ? changes.get(column) : old[column];
      if ((expected ?? '') !== (current[column] ?? '')) throw new Error('Record changed during write');
    }
  }
}

async function loadRecord(client, type, record) {
  const name = TYPE_SHEETS[type];
  if (!name || !record || record.sheet !== name || !Number.isInteger(record.rowNumber) || typeof record.key !== 'string' || !/^[a-f0-9]{64}$/u.test(record.revision ?? '')) {
    throw new OrderError('INVALID_RECORD', 'Не удалось определить редактируемую запись. Обновите доску.', 400);
  }
  const names = [...new Set([name, 'Заказы', 'Настройки', 'Клиенты'])];
  const { tables } = await readTables(client, names, { includeFormulas: true });
  const table = tables[name];
  const row = table.rows.find(candidate => candidate.rowNumber === record.rowNumber);
  if (!row || JSON.stringify(recordToken(type, table, row)) !== JSON.stringify({ sheet: record.sheet, rowNumber: record.rowNumber, key: record.key, revision: record.revision })) {
    throw new OrderError('RECORD_CONFLICT', 'Запись или порядок строк в таблице изменились. Обновите доску и повторите правку.', 409);
  }
  if (type === 'order') findUniqueOrder(table, record.key);
  if (['payment', 'expense', 'installation'].includes(type)) {
    const idHeader = type === 'installation' ? 'ID монтажа' : 'sync_id';
    if (!record.key || table.rows.filter(candidate => string(table.rawCell(candidate, idHeader)) === record.key).length !== 1) {
      throw new OrderError('DUPLICATE_RECORD_ID', 'Для правки записи нужен уникальный постоянный номер.', 409);
    }
  }
  return { tables, table, row };
}

function planChanges(type, table, row, tables, changes) {
  if (!changes || Array.isArray(changes) || typeof changes !== 'object' || Object.keys(changes).length > 30) throw new OrderError('INVALID_CHANGES', 'Не переданы корректные изменения.', 400);
  const edits = describeRecord(type, table, row, tables);
  const updates = [];
  const cleaned = {};
  for (const [id, value] of Object.entries(changes)) {
    const definition = FIELDS[type].find(entry => entry.id === id);
    const description = edits.fields.find(entry => entry.id === id);
    if (!definition || !description?.editable) throw new OrderError('FIELD_READ_ONLY', `Поле «${description?.label ?? id}» нельзя изменить напрямую.`, 422);
    let normalized = validateValue(definition, value, tables);
    if (type === 'order' && id === 'client') {
      const clients = tables['Клиенты'];
      const matches = clients.rows.filter(candidate => string(clients.rawCell(candidate, 'Название / ФИО клиента')) === string(normalized));
      if (!normalized || matches.length !== 1) throw new OrderError('CLIENT_NOT_UNIQUE', 'Выберите существующего клиента с уникальным названием. Название клиента можно изменить в его контактах.', 422);
      normalized = clients.rawCell(matches[0], 'Название / ФИО клиента');
    }
    if (type === 'installation' && id === 'status' && !INSTALLATION_STATUSES.includes(normalized)) throw new OrderError('INVALID_STATUS', 'Выберите статус монтажа из списка.', 422);
    if (id === 'orderId' && normalized) findUniqueOrder(tables['Заказы'], normalized);
    if (type === 'order' && id === 'status' && !configuredStatuses(tables['Настройки']).includes(string(normalized))) throw new OrderError('INVALID_STATUS', 'Выберите статус заказа из настроек.', 422);
    if ((type === 'contact' && id === 'companyName') || (id === 'orderId' && type !== 'expense')) {
      if (!normalized) throw new OrderError('REQUIRED_FIELD', `Поле «${definition.label}» не может быть пустым.`, 422);
    }
    cleaned[id] = normalized;
    const column = fieldColumn(table, definition);
    if ((table.rawValues[row.rowNumber - 1]?.[column] ?? '') !== normalized) updates.push(writeFor(table, row, column, normalized));
  }
  if (type === 'installation') {
    const status = Object.hasOwn(cleaned, 'status') ? cleaned.status : table.rawCell(row, 'Статус монтажа');
    const date = Object.hasOwn(cleaned, 'date') ? cleaned.date : table.rawCell(row, 'Дата');
    if (status === 'Назначен' && !date) throw new OrderError('INSTALLATION_DATE_REQUIRED', 'Для назначенного монтажа укажите дату. Время можно согласовать позднее.', 422);
  }
  return { updates, cleaned };
}

export async function editRecord(client, { type, record, changes } = {}) {
  if (type === 'payment' || type === 'expense') throw new OrderError('FINANCE_ROUTE_REQUIRED', 'Финансовые операции изменяются через финансовое приложение.', 409);
  const { tables, table, row } = await loadRecord(client, type, record);
  const { updates, cleaned } = planChanges(type, table, row, tables, changes);
  if (type === 'order' && string(cleaned.status) === 'Сдан' && string(table.cell(row, 'Статус')) !== 'Сдан') {
    throw new OrderError('ARCHIVE_REQUIRED', 'Для завершения заказа используйте перенос в архив: он также завершит связанные монтажи.', 409);
  }
  if (type === 'order' && string(cleaned.status) === 'Готов к выдаче' && !Object.hasOwn(cleaned, 'readyDate')) updates.push(...readyDateWrites(table, row, string(cleaned.status)));
  if (type === 'contact' && cleaned.companyName && cleaned.companyName !== string(table.rawCell(row, 'Название / ФИО клиента'))) {
    const oldName = string(table.rawCell(row, 'Название / ФИО клиента'));
    if (table.rows.some(candidate => candidate.rowNumber !== row.rowNumber && string(table.rawCell(candidate, 'Название / ФИО клиента')) === cleaned.companyName)) {
      throw new OrderError('CLIENT_EXISTS', 'Клиент с таким названием уже есть. Выберите его в заказе.', 409);
    }
    if (table.rows.filter(candidate => string(table.rawCell(candidate, 'Название / ФИО клиента')) === oldName).length !== 1) {
      throw new OrderError('DUPLICATE_CLIENT', 'Название клиента повторяется. Сначала устраните неоднозначность в таблице.', 409);
    }
    const orders = tables['Заказы'];
    for (const order of orders.rows.filter(candidate => string(orders.rawCell(candidate, 'Клиент')) === oldName)) {
      updates.push(writeFor(orders, order, orders.indices.get('Клиент'), cleaned.companyName));
    }
  }
  if (!updates.length) return { changed: false };
  await client.updateValues(updates);
  try {
    const names = [...new Set(updates.map(update => decodeRange(update.range).name))];
    const verified = await readTables(client, names, { includeFormulas: true });
    verifyWrites(tables, verified.tables, updates);
  } catch {
    throw new OrderError('EDIT_UNCONFIRMED', 'Изменения отправлены, но результат не подтверждён. Обновите доску и проверьте таблицу.', 409);
  }
  return { changed: true };
}

export async function prepareFinancialEdit(client, { type, record, changes } = {}) {
  if (!['payment', 'expense'].includes(type)) throw new OrderError('INVALID_RECORD', 'Ожидается платёж или расход.', 400);
  const { tables, table, row } = await loadRecord(client, type, record);
  const { cleaned } = planChanges(type, table, row, tables, changes);
  const incoming = type === 'payment';
  const current = {
    date: parseDate(table.rawCell(row, 'Дата')), amount: parseNumber(table.rawCell(row, incoming ? 'Сумма платежа' : 'Сумма')),
    account: string(table.cell(row, 'Касса / счёт')), orderNumber: string(table.cell(row, incoming ? '№ заказа' : '№ заказа (если есть)')),
    counterparty: string(table.cell(row, incoming ? 'Клиент' : 'Поставщик')), comment: string(table.cell(row, 'Комментарий')),
    category: string(table.cell(row, incoming ? 'Вид платежа' : 'Категория')),
    description: incoming ? '' : string(table.cell(row, 'Описание')),
  };
  if (incoming) current.description = `${current.category} · ${current.counterparty}`;
  const mapped = Object.fromEntries(Object.entries(cleaned).map(([id, value]) => [id === 'orderId' ? 'orderNumber' : id, id === 'date' ? parseDate(value) : value]));
  const resulting = { ...current, ...mapped };
  if (!Number.isInteger(resulting.amount) || resulting.amount <= 0 || !resulting.date || !resulting.account || (!incoming && (!resulting.category || !resulting.description))) {
    throw new OrderError('FINANCE_INVALID', 'Финансовому приложению нужны дата, счёт и положительная сумма в целых рублях; расходу также нужны категория и описание. Значения не округляются автоматически.', 422);
  }
  return { syncId: record.key, type: incoming ? 'income' : 'expense', current, changes: mapped, record };
}

async function appendInstallationRow(client, table, values) {
  if (typeof client.request !== 'function') throw new OrderError('INSTALLATION_TABLE_REQUIRED', 'Для добавления монтажа нужна родная таблица на листе «Монтажи».', 409);
  const metadata = await client.request('?fields=sheets(properties(sheetId,title),tables(tableId,range))');
  const sheet = (metadata.sheets ?? []).find(candidate => candidate.properties?.sheetId === table.properties.sheetId && candidate.properties?.title === table.name);
  const matches = (sheet?.tables ?? []).filter(candidate => {
    const range = candidate.range ?? {};
    return typeof candidate.tableId === 'string' && candidate.tableId &&
      range.sheetId === table.properties.sheetId &&
      (range.startRowIndex ?? 0) === table.headerIndex &&
      (range.startColumnIndex ?? 0) === 0 && range.endColumnIndex === table.headers.length;
  });
  if (matches.length !== 1) throw new OrderError('INSTALLATION_TABLE_REQUIRED', 'Не удалось однозначно определить родную таблицу монтажей. Проверьте её диапазон и заголовки.', 409);
  const cells = values.map(value => ({
    userEnteredValue: typeof value === 'number' ? { numberValue: value } :
      typeof value === 'boolean' ? { boolValue: value } : { stringValue: String(value ?? '') },
  }));
  // Native table append uses its first free body row, even if its range includes blank rows.
  // values.append instead appends after the entire native table range.
  await client.request(':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ requests: [{ appendCells: {
      sheetId: table.properties.sheetId, tableId: matches[0].tableId,
      rows: [{ values: cells }], fields: 'userEnteredValue',
    } }] }),
  });
}

export async function createInstallation(client, { orderId, changes } = {}) {
  if (typeof orderId !== 'string' || !orderId.trim()) throw new OrderError('INVALID_ORDER', 'Не указан заказ для монтажа.', 400);
  const { tables } = await readTables(client, ['Заказы', 'Настройки', 'Монтажи'], { includeFormulas: true });
  findUniqueOrder(tables['Заказы'], orderId.trim());
  const table = tables['Монтажи'];
  if (!INSTALLATION_HEADERS.every(header => table.indices.has(header))) throw new OrderError('SCHEMA_REQUIRED', 'Лист «Монтажи» ещё не подготовлен.', 409);
  const fake = { rowNumber: table.rawValues.length + 1, cells: [] };
  const input = { status: INSTALLATION_STATUSES[0], ...changes };
  const { cleaned } = planChanges('installation', table, fake, tables, input);
  const id = crypto.randomUUID();
  const values = Array.from({ length: table.headers.length }, () => '');
  values[table.indices.get('ID монтажа')] = id;
  values[table.indices.get('№ заказа')] = orderId.trim();
  for (const [key, value] of Object.entries(cleaned)) values[fieldColumn(table, FIELDS.installation.find(definition => definition.id === key))] = value;
  await appendInstallationRow(client, table, values);
  try {
    const verified = (await readTables(client, ['Монтажи'], { includeFormulas: true })).tables['Монтажи'];
    const matches = verified.rows.filter(row => string(verified.rawCell(row, 'ID монтажа')) === id);
    if (matches.length !== 1 || hash(verified.headers) !== hash(table.headers)) throw new Error();
    const actual = verified.rawValues[matches[0].rowNumber - 1];
    if (values.some((value, index) => value !== (actual[index] ?? ''))) throw new Error();
  } catch {
    throw new OrderError('INSTALLATION_UNCONFIRMED', 'Монтаж отправлен в таблицу, но результат не подтверждён. Обновите доску перед повторным добавлением.', 409);
  }
  return { id, orderId: orderId.trim(), changed: true };
}
