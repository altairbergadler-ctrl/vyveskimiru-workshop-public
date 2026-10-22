import crypto from 'node:crypto';
import { a1 } from './google-sheets.mjs';
const SHEETS = [
  { name: 'Платежи', type: 'income', sheetId: 904386043 },
  { name: 'Расходы', type: 'expense', sheetId: 1534385402 },
];

export const MEASUREMENT_CATEGORY = 'Замеры';
export const MEASUREMENT_MARKER = '[Замеры]';
export const isMeasurement = record => record?.type === 'income' && record.category === MEASUREMENT_CATEGORY;
export const hasMeasurementMarker = value => value === MEASUREMENT_MARKER || value.startsWith(`${MEASUREMENT_MARKER}\n`);

function text(value) {
  return value == null ? '' : String(value).trim();
}

function amount(value) {
  const normalized = text(value).replace(/[^\d,-]/g, '').replace(',', '.');
  return Math.round(Number(normalized || 0));
}

function checked(value) {
  const normalized = text(value).toLocaleLowerCase('ru-RU');
  if (['true', 'истина', '1', 'да', '+', '✓'].includes(normalized)) return true;
  if (['false', 'ложь', '0', 'нет', '-', ''].includes(normalized)) return false;
  return null;
}

function isoDate(value) {
  const raw = text(value);
  const match = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (match) return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return '';
}

function hashRecord(record) {
  const canonical = [record.type, record.date, record.category, record.description, record.amount,
    record.account, record.type === 'income' ? Boolean(record.cashInRegister) : '',
    record.orderNumber, record.counterparty, record.comment]
    .map((value) => value ?? '');
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function layoutFromHeaders(config, headers) {
  const normalized = headers.map((value) => text(value).toLocaleLowerCase('ru-RU'));
  const index = (...names) => {
    for (const name of names) {
      const found = normalized.indexOf(name.toLocaleLowerCase('ru-RU'));
      if (found >= 0) return found;
    }
    return -1;
  };
  const layout = {
    dateIndex: index('Дата'),
    categoryIndex: index(config.type === 'income' ? 'Вид платежа' : 'Категория'),
    descriptionIndex: index('Описание'),
    amountIndex: index(config.type === 'income' ? 'Сумма платежа' : 'Сумма'),
    accountIndex: index('Касса / счёт'),
    cashInRegisterIndex: config.type === 'income' ? index('Деньги в кассе') : -1,
    orderNumberIndex: index('№ заказа', '№ заказа (если есть)'),
    counterpartyIndex: index(config.type === 'income' ? 'Клиент' : 'Поставщик'),
    commentIndex: index('Комментарий'),
    idIndex: index('sync_id'),
    updatedIndex: index('sync_updated_at'),
    deletedIndex: index('sync_deleted'),
    originIndex: index('sync_origin'),
  };
  const required = ['dateIndex', 'categoryIndex', 'amountIndex', 'accountIndex', 'idIndex',
    'updatedIndex', 'deletedIndex', 'originIndex'];
  if (config.type === 'income') required.push('cashInRegisterIndex');
  else required.push('descriptionIndex');
  const missing = required.filter((name) => layout[name] < 0);
  if (missing.length) throw new Error(`${config.name}: отсутствуют обязательные столбцы (${missing.join(', ')})`);
  return { ...layout, width: Math.max(headers.length,
    ...Object.values(layout).filter(Number.isInteger).map((value) => value + 1)) };
}

function fromSheet(config, row, rowNumber, layout = config) {
  const id = text(row[layout.idIndex]);
  if (config.type === 'income') {
    const rawComment = text(row[layout.commentIndex]);
    const measurement = hasMeasurementMarker(rawComment);
    const category = measurement ? MEASUREMENT_CATEGORY : text(row[layout.categoryIndex]);
    const counterparty = text(row[layout.counterpartyIndex]);
    const account = text(row[layout.accountIndex]);
    return {
      id,
      type: 'income',
      date: isoDate(row[layout.dateIndex]),
      category: !measurement && category === MEASUREMENT_CATEGORY ? '' : category,
      description: measurement ? MEASUREMENT_CATEGORY : `${category} · ${counterparty}`,
      amount: amount(row[layout.amountIndex]),
      account,
      cashInRegister: checked(row[layout.cashInRegisterIndex]),
      orderNumber: text(row[layout.orderNumberIndex]) || null,
      counterparty: counterparty || null,
      comment: (measurement ? rawComment.slice(MEASUREMENT_MARKER.length).trim() : rawComment) || null,
      source: 'sheet',
      sheetName: config.name,
      sheetRow: rowNumber,
    };
  }
  return {
    id,
    type: 'expense',
    date: isoDate(row[layout.dateIndex]),
    category: text(row[layout.categoryIndex]),
    description: text(row[layout.descriptionIndex]),
    amount: amount(row[layout.amountIndex]),
    account: text(row[layout.accountIndex]),
    orderNumber: text(row[layout.orderNumberIndex]) || null,
    counterparty: text(row[layout.counterpartyIndex]) || null,
    comment: text(row[layout.commentIndex]) || null,
    source: 'sheet',
    sheetName: config.name,
    sheetRow: rowNumber,
  };
}

function validationProblems(record) {
  const problems = [];
  if (!record.date) problems.push('date');
  if (!record.category) problems.push('category');
  if (!(record.amount > 0)) problems.push('amount');
  if (!record.account) problems.push('account');
  if (record.type === 'income' && !isMeasurement(record) && !record.counterparty) problems.push('counterparty');
  if (isMeasurement(record) && (record.orderNumber || record.counterparty)) problems.push('measurementOrder');
  if (record.type === 'income' && typeof record.cashInRegister !== 'boolean') problems.push('cashInRegister');
  if (record.type === 'expense' && !record.description) problems.push('description');
  return problems;
}

function sheetConfig(type) {
  return SHEETS.find((item) => item.type === type);
}

function columnName(index) {
  let value = index + 1;
  let output = '';
  while (value) {
    const remainder = (value - 1) % 26;
    output = String.fromCharCode(65 + remainder) + output;
    value = Math.floor((value - 1) / 26);
  }
  return output;
}

function recordValueUpdates(record, rowNumber, syncTime, layout) {
  const config = sheetConfig(record.type);
  const data = [];
  const put = (index, value) => data.push({ range: a1(config.name, `${columnName(index)}${rowNumber}`), values: [[value ?? '']] });
  if (record.type === 'income') {
    put(layout.dateIndex, record.date);
    if (layout.orderNumberIndex >= 0) put(layout.orderNumberIndex, record.orderNumber);
    put(layout.amountIndex, record.amount);
    put(layout.accountIndex, record.account);
    if (layout.cashInRegisterIndex >= 0) put(layout.cashInRegisterIndex, Boolean(record.cashInRegister));
    if (layout.commentIndex >= 0) put(layout.commentIndex, isMeasurement(record)
      ? MEASUREMENT_MARKER + (record.comment ? `\n${record.comment}` : '') : record.comment);
  } else {
    put(layout.dateIndex, record.date);
    put(layout.categoryIndex, record.category);
    put(layout.descriptionIndex, record.description);
    put(layout.amountIndex, record.amount);
    put(layout.accountIndex, record.account);
    if (layout.orderNumberIndex >= 0) put(layout.orderNumberIndex, record.orderNumber);
    if (layout.counterpartyIndex >= 0) put(layout.counterpartyIndex, record.counterparty);
    if (layout.commentIndex >= 0) put(layout.commentIndex, record.comment);
  }
  put(layout.idIndex, record.id);
  put(layout.updatedIndex, syncTime);
  put(layout.deletedIndex, '');
  put(layout.originIndex, 'vps');
  return data;
}


export { SHEETS, text, amount, checked, isoDate, hashRecord, layoutFromHeaders, fromSheet, validationProblems, sheetConfig, columnName, recordValueUpdates };
