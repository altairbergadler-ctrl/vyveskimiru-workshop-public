import { a1 } from './sheets.mjs';
import { estimatedOrderProfit, PROFIT_BASIS } from '../../../server/order-profit.mjs';
import { amount as financeAmount } from '../../../server/finance-contract.mjs';
import { describeRecord, describeInstallation, readyDateWrites, verifyWrites } from './editing.mjs';
export { editRecord, createInstallation, prepareFinancialEdit, INSTALLATION_HEADERS, INSTALLATION_STATUSES } from './editing.mjs';
export { archiveOrder } from './archive.mjs';

export class OrderError extends Error {
  constructor(code, message, statusCode = 422) {
    super(message);
    this.name = 'OrderError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export { OrderError as OrdersError };

const text = value => value === null || value === undefined ? '' : String(value).trim();
const headerKey = value => text(value).normalize('NFC').replace(/\s+/gu, ' ');
const isTrue = value => value === true || /^(true|истина|да|1|✓)$/iu.test(text(value));
const SHEETS = ['Заказы', 'Настройки', 'Позиции', 'Клиенты', 'Производство', 'Платежи', 'Расходы'];
const SIGNATURES = {
  'Заказы': ['№ заказа', 'Название заказа', 'Статус'],
  'Настройки': ['Статус заказа'],
  'Позиции': ['№ заказа', 'Наименование работы / изделия'],
  'Клиенты': ['Название / ФИО клиента', 'Телефон'],
  'Производство': ['№ заказа', 'Изделие', 'Этап'],
  'Платежи': ['№ заказа', 'Сумма платежа'],
  'Расходы': ['№ заказа (если есть)', 'Сумма', 'Категория'],
  'Монтажи': ['ID монтажа', '№ заказа', 'Статус монтажа'],
  'Маршруты': ['Вид изделия', 'Этап', 'Норма, ч'],
};

export function columnName(index) {
  let result = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result;
  return result;
}

export function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let normalized = text(value).replace(/[\s\u00a0\u202f]/gu, '');
  if (!normalized) return null;
  // The sheet's currency format uses an em dash for an explicit numeric zero.
  if (/^—(?:₽|руб\.?|р\.?|RUB)?$/iu.test(normalized)) return 0;
  normalized = normalized.replace(/(?:₽|руб\.?|р\.?|RUB)$/iu, '').replaceAll('−', '-');
  if (/^\(.*\)$/u.test(normalized)) normalized = `-${normalized.slice(1, -1)}`;
  if (normalized.includes(',')) {
    if (/^[+-]?\d{1,3}(?:\.\d{3})+,\d+$/u.test(normalized)) normalized = normalized.replaceAll('.', '');
    normalized = normalized.replace(',', '.');
  }
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

export function parseDate(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86_400_000);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : text(value);
  }
  const raw = text(value);
  let parts = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/u);
  if (parts) parts = [parts[0], parts[3], parts[2], parts[1]];
  else parts = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s.*)?$/u);
  if (!parts) return raw;
  const [, day, month, year] = parts;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return raw;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function makeTable(name, values, properties, rawValues = values) {
  const required = SIGNATURES[name];
  const headerRows = values.flatMap((row, index) => required.every(key => row.some(value => headerKey(value) === key)) ? [index] : []);
  if (headerRows.length !== 1) throw new OrderError('SHEET_HEADERS', `Не удалось однозначно определить заголовки листа «${name}».`);
  const headerIndex = headerRows[0];
  const headers = values[headerIndex].map(headerKey);
  if (rawValues !== values) {
    const rawHeaders = (rawValues[headerIndex] ?? []).map(headerKey);
    const fail = () => { throw new OrderError('SHEET_READ_CHANGED', 'Таблица изменилась во время загрузки. Обновите доску перед редактированием.', 409); };
    if (headers.length !== rawHeaders.length || headers.some((header, column) => header !== rawHeaders[column])) fail();
    for (let row = headerIndex + 1; row < Math.max(values.length, rawValues.length); row++) {
      const rawCells = rawValues[row] ?? [];
      const effectiveCells = values[row] ?? [];
      for (let column = 0; column < Math.max(rawCells.length, effectiveCells.length); column++) {
        const raw = rawCells[column];
        if (typeof raw === 'string' && raw.startsWith('=')) continue;
        if ((raw ?? '') !== (effectiveCells[column] ?? '')) fail();
      }
    }
  }
  const indices = new Map();
  for (let i = 0; i < headers.length; i++) {
    if (!headers[i]) continue;
    if (indices.has(headers[i])) throw new OrderError('SHEET_HEADERS', `На листе «${name}» повторяется заголовок «${headers[i]}».`);
    indices.set(headers[i], i);
  }
  return {
    name, properties, headerIndex, headers, indices, rawValues,
    rows: values.slice(headerIndex + 1).map((cells, index) => ({ cells, rowNumber: headerIndex + index + 2 }))
      .filter(row => row.cells.some(value => text(value) !== '')),
    cell(row, ...names) {
      for (const candidate of names) if (indices.has(candidate)) return row.cells[indices.get(candidate)];
      return undefined;
    },
    rawCell(row, ...names) {
      for (const candidate of names) if (indices.has(candidate)) return rawValues[row.rowNumber - 1]?.[indices.get(candidate)];
      return undefined;
    },
  };
}

export async function readTables(client, names, { includeFormulas = false, optional = [] } = {}) {
  const metadata = await client.getSpreadsheet();
  const properties = new Map((metadata.sheets ?? []).map(sheet => [sheet.properties.title, sheet.properties]));
  const selected = [...names, ...optional.filter(name => properties.has(name))].map(name => {
    const property = properties.get(name);
    if (!property) throw new OrderError('SHEET_MISSING', `В Google Таблице отсутствует лист «${name}».`);
    const rows = property.gridProperties?.rowCount;
    const columns = property.gridProperties?.columnCount;
    if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(columns) || columns < 1) {
      throw new OrderError('SHEET_METADATA', `Не удалось определить размер листа «${name}».`);
    }
    return { name, property, range: `A1:${columnName(columns - 1)}${rows}` };
  });
  let tables;
  if (typeof client.getRanges === 'function') {
    const ranges = selected.map(({ name, range }) => a1(name, range));
    const [response, raw] = await Promise.all([
      client.getRanges(ranges, { valueRenderOption: 'UNFORMATTED_VALUE' }),
      includeFormulas ? client.getRanges(ranges, { valueRenderOption: 'FORMULA' }) : Promise.resolve(null),
    ]);
    if (response.valueRanges?.length !== selected.length) throw new OrderError('SHEET_RESPONSE', 'Google Таблицы вернули неполные данные. Обновите доску.', 502);
    if (includeFormulas && raw?.valueRanges?.length !== selected.length) throw new OrderError('SHEET_RESPONSE', 'Не удалось проверить формулы таблицы.', 502);
    tables = selected.map(({ name, property }, index) => [name, makeTable(name, response.valueRanges[index].values ?? [], property, raw?.valueRanges[index].values)]);
  } else {
    tables = await Promise.all(selected.map(async ({ name, property, range }) => {
      const [response, raw] = await Promise.all([
        client.getValues(name, range, { valueRenderOption: 'UNFORMATTED_VALUE' }),
        includeFormulas ? client.getValues(name, range, { valueRenderOption: 'FORMULA' }) : Promise.resolve(null),
      ]);
      return [name, makeTable(name, response.values ?? [], property, raw?.values)];
    }));
  }
  return { tables: Object.fromEntries(tables), metadata };
}

export function configuredStatuses(table) {
  const statuses = [...new Set(table.rows.map(row => text(table.cell(row, 'Статус заказа'))).filter(Boolean))];
  if (!statuses.length) throw new OrderError('STATUSES_EMPTY', 'В настройках таблицы не указаны статусы заказов.');
  return statuses;
}

function recordsByOrder(table, idHeader = '№ заказа') {
  const result = new Map();
  for (const row of table.rows) {
    if (isTrue(table.cell(row, 'sync_deleted'))) continue;
    const id = text(table.cell(row, idHeader));
    if (!id) continue;
    if (!result.has(id)) result.set(id, []);
    result.get(id).push(row);
  }
  return result;
}

export async function readBoard(client, { analytics = false } = {}) {
  const { tables, metadata } = await readTables(client, SHEETS, { includeFormulas: true, optional: ['Монтажи'] });
  const settingsStatuses = configuredStatuses(tables['Настройки']);
  const statuses = [...settingsStatuses];
  const warnings = [];
  const orderTable = tables['Заказы'];
  const itemsTable = tables['Позиции'];
  const clientsTable = tables['Клиенты'];
  const productionTable = tables['Производство'];
  const paymentsTable = tables['Платежи'];
  const expensesTable = tables['Расходы'];
  const itemRows = recordsByOrder(itemsTable);
  const productionRows = recordsByOrder(productionTable);
  const paymentRows = recordsByOrder(paymentsTable);
  const expenseRows = recordsByOrder(expensesTable, '№ заказа (если есть)');
  const installationRows = tables['Монтажи'] ? recordsByOrder(tables['Монтажи']) : new Map();
  const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(client.spreadsheetId ?? metadata.spreadsheetId)}/edit`;
  const counts = new Map();
  let ordersWithoutId = 0;
  const orders = orderTable.rows.flatMap(row => {
    const get = (...headers) => orderTable.cell(row, ...headers);
    const id = text(get('№ заказа'));
    if (!id) {
      if (text(get('Название заказа')) || text(get('Клиент'))) ordersWithoutId++;
      return [];
    }
    counts.set(id, (counts.get(id) ?? 0) + 1);
    const status = text(get('Статус'));
    if (!statuses.includes(status)) {
      statuses.push(status);
      warnings.push(status ? `Статус «${status}» есть в заказах, но отсутствует в настройках. Перенос в этот статус недоступен.` : 'Есть заказы без статуса. Выберите для них статус из настроек таблицы.');
    }
    const client = text(get('Клиент'));
    const clientNameIndex = clientsTable.indices.get('Название / ФИО клиента');
    const clientIdIndex = clientsTable.indices.get('ID') ?? clientsTable.indices.get('ID клиента') ??
      (clientNameIndex > 0 && clientsTable.headers[clientNameIndex - 1] === '' ? clientNameIndex - 1 : undefined);
    const contacts = clientsTable.rows.filter(candidate => client && (
      text(clientsTable.cell(candidate, 'Название / ФИО клиента')) === client ||
      (clientIdIndex !== undefined && text(candidate.cells[clientIdIndex]) === client)
    )).map(candidate => ({
      edit: describeRecord('contact', clientsTable, candidate, tables),
      name: text(clientsTable.cell(candidate, 'Контактное лицо')) || text(clientsTable.cell(candidate, 'Название / ФИО клиента')),
      phone: text(clientsTable.cell(candidate, 'Телефон')),
      email: text(clientsTable.cell(candidate, 'Email')),
      type: text(clientsTable.cell(candidate, 'Тип')),
      source: text(clientsTable.cell(candidate, 'Источник')),
      comment: text(clientsTable.cell(candidate, 'Комментарий')),
    }));
    return [{
      edit: describeRecord('order', orderTable, row, tables),
      id,
      title: text(get('Название заказа')),
      client,
      manager: text(get('Менеджер')),
      status,
      createdDate: parseDate(get('Дата заказа')),
      desiredDate: parseDate(get('Желаемая дата клиента')),
      dueDate: parseDate(get('Срок сдачи')),
      readyDate: parseDate(get('Фактическая дата готовности')),
      manufacturingDone: ['Готов к выдаче', 'Монтаж', 'Сдан', 'Отменён'].includes(status),
      amount: parseNumber(get('Сумма заказа')),
      paid: parseNumber(get('Оплачено')),
      debt: parseNumber(get('Долг')),
      cost: parseNumber(get('Себестоимость')),
      extraCost: parseNumber(get('Доп. расходы')),
      profit: estimatedOrderProfit(parseNumber(get('Сумма заказа'))),
      sourceProfit: parseNumber(get('Валовая прибыль')),
      profitBasis: PROFIT_BASIS,
      comment: text(get('Комментарий')),
      sourceUrl: `${spreadsheetUrl}#gid=${orderTable.properties.sheetId}&range=${row.rowNumber}:${row.rowNumber}`,
      items: (itemRows.get(id) ?? []).map(item => ({
        edit: describeRecord('item', itemsTable, item, tables),
        row: item.rowNumber,
        name: text(itemsTable.cell(item, 'Наименование работы / изделия')),
        description: text(itemsTable.cell(item, 'Описание, макет, адрес', 'Описание макет адрес')),
        width: parseNumber(itemsTable.rawCell(item, 'Ширина, м', 'Ширина м')),
        height: parseNumber(itemsTable.rawCell(item, 'Высота, м', 'Высота м')),
        quantity: parseNumber(itemsTable.rawCell(item, 'Кол-во')),
        unit: text(itemsTable.cell(item, 'Ед. изм.')),
        amount: parseNumber(itemsTable.cell(item, 'Сумма')),
      })),
      contacts,
      production: (productionRows.get(id) ?? []).map(stage => ({
        edit: describeRecord('production', productionTable, stage, tables),
        name: text(productionTable.cell(stage, 'Этап')),
        product: text(productionTable.cell(stage, 'Изделие')),
        done: isTrue(productionTable.cell(stage, 'Готово')),
        availability: text(productionTable.cell(stage, 'Можно')),
        assignee: text(productionTable.cell(stage, 'Исполнитель')),
        planDate: parseDate(productionTable.cell(stage, 'План')),
        actualDate: parseDate(productionTable.cell(stage, 'Факт')),
        comment: text(productionTable.cell(stage, 'Комментарий')),
      })),
      payments: (paymentRows.get(id) ?? []).map(payment => ({
        edit: describeRecord('payment', paymentsTable, payment, tables),
        date: parseDate(paymentsTable.cell(payment, 'Дата')),
        amount: parseNumber(paymentsTable.rawCell(payment, 'Сумма платежа')),
        // This board reads UNFORMATTED_VALUE. Supply its decimal number in
        // the finance parser's comma format; keep the exact raw amount above.
        financeAmount: financeAmount(String(paymentsTable.cell(payment, 'Сумма платежа') ?? '').replace('.', ',')),
        kind: text(paymentsTable.cell(payment, 'Вид платежа')),
        account: text(paymentsTable.cell(payment, 'Касса / счёт')),
        comment: text(paymentsTable.cell(payment, 'Комментарий')),
      })),
      expenses: (expenseRows.get(id) ?? []).map(expense => ({
        edit: describeRecord('expense', expensesTable, expense, tables),
        date: parseDate(expensesTable.cell(expense, 'Дата')),
        amount: parseNumber(expensesTable.rawCell(expense, 'Сумма')),
        category: text(expensesTable.cell(expense, 'Категория')),
        description: text(expensesTable.cell(expense, 'Описание')),
        account: text(expensesTable.cell(expense, 'Касса / счёт')),
        comment: text(expensesTable.cell(expense, 'Комментарий')),
      })),
      installations: (installationRows.get(id) ?? []).map(installation => describeInstallation(tables['Монтажи'], installation, tables)),
    }];
  });
  const duplicateCount = [...counts.values()].filter(count => count > 1).length;
  if (duplicateCount) warnings.push(`Повторяющихся номеров заказов: ${duplicateCount}. Перенос таких заказов отключён до исправления номеров в таблице.`);
  if (ordersWithoutId) warnings.push(`Строк заказов без номера: ${ordersWithoutId}. Они не отображаются на доске.`);
  for (const [name, records] of [['Позиции', itemRows], ['Производство', productionRows], ['Платежи', paymentRows], ['Расходы', expenseRows]]) {
    const orphanCount = [...records.entries()].filter(([id]) => !counts.has(id)).reduce((sum, [, rows]) => sum + rows.length, 0);
    if (orphanCount) warnings.push(`«${name}»: записей с номером отсутствующего заказа — ${orphanCount}.`);
  }
  const analyticsClients = analytics ? clientsTable.rows.filter(row => text(clientsTable.cell(row, 'Название / ФИО клиента'))).map(row => ({
    row: row.rowNumber, name: text(clientsTable.cell(row, 'Название / ФИО клиента')),
    source: text(clientsTable.cell(row, 'Источник')), createdDate: parseDate(clientsTable.cell(row, 'Дата добавления')),
  })) : undefined;
  return { statuses, configuredStatuses: settingsStatuses, orders, updatedAt: new Date().toISOString(), spreadsheetUrl, warnings, ...(analytics ? { analyticsClients } : {}) };
}

export function findUniqueOrder(table, id) {
  const matches = table.rows.filter(row => text(table.cell(row, '№ заказа')) === id);
  if (!matches.length) throw new OrderError('ORDER_NOT_FOUND', 'Заказ уже отсутствует в таблице. Обновите доску.', 404);
  if (matches.length > 1) throw new OrderError('DUPLICATE_ORDER_ID', 'Номер заказа повторяется в таблице. Для переноса нужны уникальные номера.', 409);
  return matches[0];
}

export async function moveOrder(client, input) {
  if (!input || typeof input.id !== 'string' || !input.id.trim() || typeof input.status !== 'string' || typeof input.expectedStatus !== 'string') {
    throw new OrderError('INVALID_MOVE', 'Не переданы номер заказа, новый и исходный статусы.', 400);
  }
  const id = input.id.trim();
  const status = input.status.trim();
  const expectedStatus = input.expectedStatus.trim();
  const { tables } = await readTables(client, ['Заказы', 'Настройки'], { includeFormulas: true });
  if (!configuredStatuses(tables['Настройки']).includes(status)) {
    throw new OrderError('INVALID_STATUS', 'Этот статус отсутствует в настройках Google Таблицы. Обновите доску.', 422);
  }
  const table = tables['Заказы'];
  const row = findUniqueOrder(table, id);
  const currentStatus = text(table.cell(row, 'Статус'));
  if (currentStatus !== expectedStatus) throw new OrderError('STATUS_CONFLICT', 'Статус заказа уже изменился в таблице. Обновите доску и повторите перенос.', 409);
  if (status === 'Сдан' && currentStatus !== 'Сдан') throw new OrderError('ARCHIVE_REQUIRED', 'Для завершения заказа используйте перенос в архив: он также завершит связанные монтажи.', 409);
  if (currentStatus === status) return { id, status, changed: false, updatedAt: new Date().toISOString() };
  const column = table.indices.get('Статус');
  const cell = `${columnName(column)}${row.rowNumber}`;
  if (String(table.rawCell(row, 'Статус') ?? '').startsWith('=')) throw new OrderError('FORMULA_PROTECTED', 'Статус вычисляется формулой. Измените исходные данные в таблице.', 409);
  const readyWrites = readyDateWrites(table, row, status);
  const matchingStatuses = [...new Set(tables['Настройки'].rows.map(candidate => tables['Настройки'].rawCell(candidate, 'Статус заказа')).filter(value => text(value) === status))];
  if (matchingStatuses.length !== 1) throw new OrderError('INVALID_STATUS', 'В настройках неоднозначный статус. Проверьте повторы и пробелы.', 409);
  const updates = [{ range: a1('Заказы', cell), values: [[matchingStatuses[0]]] }, ...readyWrites];
  await client.updateValues(updates);
  // No write retries or rollback: a timeout can occur after a successful Google write.
  // Reread by ID and also verify the addressed row to detect concurrent sorting/insertions.
  try {
    const verified = (await readTables(client, ['Заказы'], { includeFormulas: true })).tables['Заказы'];
    const verifiedRow = findUniqueOrder(verified, id);
    if (verified.indices.get('Статус') !== column || verifiedRow.rowNumber !== row.rowNumber || text(verified.cell(verifiedRow, 'Статус')) !== status) {
      throw new Error();
    }
    verifyWrites({ 'Заказы': table }, { 'Заказы': verified }, updates);
  } catch {
    throw new OrderError('MOVE_UNCONFIRMED', 'Запрос на смену статуса отправлен, но результат не удалось подтвердить. Обновите доску и проверьте таблицу.', 409);
  }
  return { id, status, changed: true, updatedAt: new Date().toISOString() };
}
