import { a1 } from './google-sheets.mjs';
import { WarehouseReceipts } from './warehouse-receipts.mjs';
import { parseNumber } from '../modules/orders/server/orders.mjs';

const receiptsByClient = new WeakMap();
export function installWarehouseReceipts(client, db) {
  const receipts = new WarehouseReceipts(db);
  receiptsByClient.set(client, receipts);
  return receipts;
}

function assertWarehouseClear(client) {
  const receipts = receiptsByClient.get(client);
  if (receipts?.pending().length || receipts?.pendingIssues().length)
    throw new WarehouseError('pending', 'Сначала проверьте неподтверждённую операцию склада. Новые складские записи временно остановлены.');
}

const CATALOG_SHEET = 'Склад';
const MOVEMENTS_SHEET = 'Движения склада';
const CATALOG_LAST_ROW = 200;
const MOVEMENTS_LAST_ROW = 500;
let warehouseWriteQueue = Promise.resolve();
const CATALOG_HEADERS = [
  'Код',
  'Категория',
  'Наименование',
  'Ед.',
  'Цена, ₽',
  'По счёту +8%, ₽',
  'Остаток',
  'Минимум',
  'К закупке',
  'Факт',
  'Разница',
  'Место',
  'Категория расхода',
];
const MOVEMENT_HEADERS = [
  'Дата',
  'Операция',
  'Код',
  'Наименование',
  'Количество',
  'Ед.',
  'Цена, ₽',
  'Сумма, ₽',
  '№ заказа',
  'Ответственный',
  'Комментарий',
  'Изменение',
];

export class WarehouseError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function text(value) {
  return String(value ?? '').trim();
}

function number(value) {
  const normalized = text(value)
    .replaceAll('\u00a0', '')
    .replace(',', '.')
    .replace(/[^0-9.-]/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function layout(headers, required, sheetName) {
  const positions = Object.fromEntries(
    headers.map((header, index) => [text(header), index]),
  );
  const missing = required.filter(
    (header) => !Number.isInteger(positions[header]),
  );
  if (missing.length)
    throw new WarehouseError(
      'schema',
      `В листе «${sheetName}» отсутствуют столбцы: ${missing.join(', ')}`,
    );
  return positions;
}

function isoDate(value) {
  const input = text(value);
  const russian = input.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (russian)
    return `${russian[3]}-${russian[2].padStart(2, '0')}-${russian[1].padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(input) ? input : null;
}

function dateInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function russianDate(iso) {
  const [year, month, day] = iso.split('-');
  return `${day}.${month}.${year}`;
}

function categoryGroup(category, name) {
  const value = `${category} ${name}`.toLocaleLowerCase('ru-RU');
  if (/блок|светодиод|led|лента|провод|контакт|электр/.test(value))
    return 'electronics';
  if (/чернил|печать|плоттер/.test(value)) return 'printing';
  return 'materials';
}

function cutoff(today, days) {
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days + 1);
  return date.toISOString().slice(0, 10);
}

function movementLabel(movement) {
  const order = movement.orderNumber ? ` · заказ №${movement.orderNumber}` : '';
  return `${movement.date || 'Без даты'}, ${movement.operation.toLocaleLowerCase('ru-RU')} ${movement.quantity} ${movement.unit}${order}`;
}

export function parseWarehouse(
  catalogValues,
  movementValues,
  { now = new Date(), timeZone = 'Asia/Riyadh', strictNumbers = false } = {},
) {
  const catalogRows = catalogValues ?? [];
  const movementRows = movementValues ?? [];
  if (!catalogRows.length)
    throw new WarehouseError('schema', `Лист «${CATALOG_SHEET}» пуст`);
  const catalogLayout = layout(
    catalogRows[0] ?? [],
    CATALOG_HEADERS,
    CATALOG_SHEET,
  );
  const movementLayout = layout(
    movementRows[0] ?? [],
    MOVEMENT_HEADERS,
    MOVEMENTS_SHEET,
  );
  const today = dateInTimeZone(now, timeZone);
  const usedByCode = new Map();
  const lastByCode = new Map();

  for (const row of movementRows.slice(1)) {
    const code = text(row[movementLayout.Код]);
    const operation = text(row[movementLayout.Операция]);
    const date = isoDate(row[movementLayout.Дата]);
    if (!code || !operation) continue;
    const movement = {
      date,
      operation,
      quantity: number(row[movementLayout.Количество]),
      unit: text(row[movementLayout['Ед.']]),
      orderNumber: text(row[movementLayout['№ заказа']]),
    };
    lastByCode.set(code, movement);
    if (!['Расход на заказ', 'Списание'].includes(operation) || !date) continue;
    const used = usedByCode.get(code) ?? { 7: 0, 30: 0, 90: 0 };
    for (const period of [7, 30, 90]) {
      if (date >= cutoff(today, period) && date <= today)
        used[period] += movement.quantity;
    }
    usedByCode.set(code, used);
  }

  const items = catalogRows.slice(1).flatMap((row, index) => {
    const sku = text(row[catalogLayout.Код]);
    const name = text(row[catalogLayout.Наименование]);
    if (!sku || !name) return [];
    const category = text(row[catalogLayout.Категория]);
    const unit = text(row[catalogLayout['Ед.']]) || 'шт';
    const movement = lastByCode.get(sku);
    return [
      {
        id: sku,
        row: index + 2,
        sku,
        name,
        category,
        group: categoryGroup(category, name),
        unit,
        price: number(row[catalogLayout['Цена, ₽']]),
        stock: strictNumbers ? parseNumber(row[catalogLayout.Остаток]) : number(row[catalogLayout.Остаток]),
        minStock: strictNumbers ? parseNumber(row[catalogLayout.Минимум]) : number(row[catalogLayout.Минимум]),
        reserved: strictNumbers ? parseNumber(row[12]) : number(row[12]),
        photoUrl: text(row[13]) || null,
        expenseCategory: text(row[catalogLayout['Категория расхода']]),
        location: text(row[catalogLayout.Место]) || 'Не указано',
        used: usedByCode.get(sku) ?? { 7: 0, 30: 0, 90: 0 },
        lastMovement: movement ? movementLabel(movement) : 'Движений пока нет',
      },
    ];
  });

  return { items, today, refreshedAt: now.toISOString() };
}

async function sheetValues(client) {
  if (!client.configured)
    throw new WarehouseError(
      'unavailable',
      'Google Таблица склада не подключена',
    );
  const [catalog, movements] = await Promise.all([
    client.getValues(CATALOG_SHEET, `A1:O${CATALOG_LAST_ROW}`),
    client.getValues(MOVEMENTS_SHEET, `A1:L${MOVEMENTS_LAST_ROW}`),
  ]);
  return { catalog: catalog.values ?? [], movements: movements.values ?? [] };
}

export async function readWarehouse(client, options = {}) {
  const values = await sheetValues(client);
  return parseWarehouse(values.catalog, values.movements, options);
}

function nextBlankRow(values, firstRow, lastRow) {
  for (let index = 0; index < lastRow - firstRow + 1; index += 1) {
    if (!text(values[index]?.[0])) return firstRow + index;
  }
  throw new WarehouseError(
    'full',
    'В Google Таблице закончились подготовленные строки',
  );
}

function validQuantity(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new WarehouseError('invalid', `Некорректное значение: ${field}`);
  return Math.round(parsed * 100) / 100;
}

function roundedQuantity(value) {
  const normalized = text(value).replaceAll('\u00a0', '').replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

function normalizeItem(input, existing = null) {
  const sku = existing?.sku ?? text(input?.sku);
  const name = text(input?.name);
  const category = text(input?.category);
  const expenseCategory = text(input?.expenseCategory) || existing?.expenseCategory;
  const unit = text(input?.unit);
  const location = text(input?.location);
  if (!sku || !name || !category || !expenseCategory || !unit || !location)
    throw new WarehouseError(
      'invalid',
      'Заполните код, название, категорию расхода, единицу и место хранения',
    );
  return {
    sku,
    name,
    category,
    expenseCategory,
    unit,
    location,
    stock: validQuantity(input?.stock, 'остаток'),
    minStock: validQuantity(input?.minStock, 'минимальный остаток'),
    reserved: validQuantity(input?.reserved, 'резерв'),
    photoUrl: text(input?.photoUrl),
  };
}

function movementValues({
  today,
  operation,
  item,
  quantity,
  orderNumber = '',
  responsible = 'PWA',
  comment = '',
}) {
  const sign =
    operation === 'Приход' ||
    operation === 'Возврат' ||
    operation === 'Корректировка +'
      ? 1
      : -1;
  return [
    russianDate(today),
    operation,
    item.sku,
    item.name,
    quantity,
    item.unit,
    item.price ?? 0,
    Math.round(quantity * (item.price ?? 0) * 100) / 100,
    orderNumber,
    responsible,
    comment,
    sign * quantity,
  ];
}

async function mutationContext(client, options) {
  const values = await sheetValues(client);
  return {
    ...values,
    parsed: parseWarehouse(values.catalog, values.movements, options),
    today: dateInTimeZone(
      options?.now ?? new Date(),
      options?.timeZone ?? 'Asia/Riyadh',
    ),
  };
}

function enqueueWarehouseWrite(operation) {
  const result = warehouseWriteQueue.then(operation, operation);
  warehouseWriteQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function createWarehouseItemOnce(client, input, options = {}) {
  assertWarehouseClear(client);
  const context = await mutationContext(client, options);
  const item = normalizeItem(input);
  if (
    context.parsed.items.some(
      (candidate) =>
        candidate.sku.toLocaleLowerCase('ru-RU') ===
        item.sku.toLocaleLowerCase('ru-RU'),
    )
  ) {
    throw new WarehouseError('duplicate', `Код ${item.sku} уже используется`);
  }
  const catalogCodes = context.catalog.slice(1).map((row) => [row?.[0]]);
  const movementDates = context.movements.slice(1).map((row) => [row?.[0]]);
  const row = nextBlankRow(catalogCodes, 2, CATALOG_LAST_ROW);
  const writes = [
    {
      range: a1(CATALOG_SHEET, `A${row}:O${row}`),
      values: [
        [
          item.sku,
          item.category,
          item.name,
          item.unit,
          0,
          0,
          `=IF($A${row}="";"";SUMIF('${MOVEMENTS_SHEET}'!$C$2:$C$${MOVEMENTS_LAST_ROW};$A${row};'${MOVEMENTS_SHEET}'!$L$2:$L$${MOVEMENTS_LAST_ROW}))`,
          item.minStock,
          `=IF(OR($A${row}="";$H${row}="");"";MAX(0;$H${row}-$G${row}))`,
          '',
          `=IF(OR($A${row}="";$J${row}="");"";$J${row}-$G${row})`,
          item.location,
          item.reserved,
          item.photoUrl,
          item.expenseCategory,
        ],
      ],
    },
  ];
  if (item.stock > 0) {
    const movementRow = nextBlankRow(movementDates, 2, MOVEMENTS_LAST_ROW);
    writes.push({
      range: a1(MOVEMENTS_SHEET, `A${movementRow}:L${movementRow}`),
      values: [
        movementValues({
          today: context.today,
          operation: 'Корректировка +',
          item,
          quantity: item.stock,
          comment: 'Начальный остаток из PWA',
        }),
      ],
    });
  }
  await client.updateValues(writes);
  return readWarehouse(client, options);
}

export function createWarehouseItem(client, input, options = {}) {
  return enqueueWarehouseWrite(() =>
    createWarehouseItemOnce(client, input, options),
  );
}

async function updateWarehouseItemOnce(client, code, input, options = {}) {
  assertWarehouseClear(client);
  const context = await mutationContext(client, options);
  const existing = context.parsed.items.find((item) => item.sku === code);
  if (!existing)
    throw new WarehouseError('missing', 'Позиция склада не найдена');
  const item = { ...normalizeItem(input, existing), price: existing.price };
  const writes = [
    {
      range: a1(CATALOG_SHEET, `B${existing.row}:D${existing.row}`),
      values: [[item.category, item.name, item.unit]],
    },
    { range: a1(CATALOG_SHEET, `H${existing.row}`), values: [[item.minStock]] },
    {
      range: a1(CATALOG_SHEET, `L${existing.row}:N${existing.row}`),
      values: [[item.location, item.reserved, item.photoUrl]],
    },
    { range: a1(CATALOG_SHEET, `O${existing.row}`), values: [[item.expenseCategory]] },
  ];
  const difference = Math.round((item.stock - existing.stock) * 100) / 100;
  if (difference !== 0) {
    const movementDates = context.movements.slice(1).map((row) => [row?.[0]]);
    const movementRow = nextBlankRow(movementDates, 2, MOVEMENTS_LAST_ROW);
    writes.push({
      range: a1(MOVEMENTS_SHEET, `A${movementRow}:L${movementRow}`),
      values: [
        movementValues({
          today: context.today,
          operation: difference > 0 ? 'Корректировка +' : 'Корректировка -',
          item,
          quantity: Math.abs(difference),
          comment: 'Ручная корректировка из PWA',
        }),
      ],
    });
  }
  await client.updateValues(writes);
  return readWarehouse(client, options);
}

export function updateWarehouseItem(client, code, input, options = {}) {
  return enqueueWarehouseWrite(() =>
    updateWarehouseItemOnce(client, code, input, options),
  );
}

async function refillWarehouseItemOnce(client, input, options = {}) {
  const receipts = receiptsByClient.get(client);
  if (!receipts) throw new WarehouseError('unavailable', 'Хранилище квитанций недоступно');
  const requestId = text(input?.requestId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(requestId))
    throw new WarehouseError('invalid', 'Обновите страницу: для пополнения нужен постоянный номер операции');
  const quantity = validQuantity(input?.quantity, 'количество');
  if (quantity <= 0) throw new WarehouseError('invalid', 'Количество должно быть больше нуля');
  const payload = { code: text(input?.code), quantity, comment: text(input?.comment) || 'Пополнение из PWA' };
  const prior = receipts.get(requestId);
  if (prior) {
    if (prior.payload !== JSON.stringify(payload))
      throw new WarehouseError('duplicate', 'Номер пополнения уже использован с другими данными');
    if (prior.state === 'rejected')
      throw new WarehouseError('rejected', 'Это пополнение не было отправлено. Можно создать новое.');
    if (prior.state === 'submitted') await verifyRefill(client, receipts, prior);
    return { ...await readWarehouse(client, options), refill: { id: requestId, state: 'confirmed' } };
  }
  assertWarehouseClear(client);
  const context = await mutationContext(client, options);
  const item = context.parsed.items.find(
    (candidate) => candidate.sku === text(input?.code),
  );
  if (!item) throw new WarehouseError('missing', 'Позиция склада не найдена');
  const marker = `PWA:refill:${requestId}`;
  if (context.movements.some(row => text(row[9]) === marker))
    throw new WarehouseError('duplicate', 'Пополнение уже есть в таблице, но его квитанция отсутствует. Нужна проверка.');
  const movementDates = context.movements.slice(1).map((row) => [row?.[0]]);
  const movementRow = nextBlankRow(movementDates, 2, MOVEMENTS_LAST_ROW);
  const movement = movementValues({ today: context.today, operation: 'Приход', item, quantity,
    responsible: marker, comment: payload.comment });
  const existingRows = (await client.getValues(MOVEMENTS_SHEET, `A1:L${MOVEMENTS_LAST_ROW}`, { valueRenderOption: 'FORMULA' })).values ?? [];
  const target = existingRows[movementRow - 1] ?? [];
  if (existingRows.some(row => text(row[9]) === marker) || target.some((v, c) =>
    text(v) !== '' && !([3, 5, 6, 7, 11].includes(c) && typeof v === 'string' && v.startsWith('='))))
    throw new WarehouseError('duplicate', 'Строка движения уже занята. Обновите склад перед пополнением.');
  // Persist before entering the transport, including the crash window before submission.
  const receipt = receipts.submit(requestId, payload, movement, movementRow);
  try {
    await client.updateValues([{ range: a1(MOVEMENTS_SHEET, `A${movementRow}:L${movementRow}`), values: [movement] }]);
  } catch (error) {
    if (error?.notSubmitted) { receipts.settle(requestId, 'rejected'); throw error; }
    // Lost response: only read back. An absent row never authorizes a second write.
  }
  await verifyRefill(client, receipts, receipt);
  return { ...await readWarehouse(client, options), refill: { id: requestId, state: 'confirmed' } };
}

export function refillWarehouseItem(client, input, options = {}) {
  return enqueueWarehouseWrite(async () => {
    try { return await refillWarehouseItemOnce(client, input, options); }
    catch (error) {
      const id = typeof input?.requestId === 'string' ? input.requestId.trim() : '';
      error.receiptState = receiptsByClient.get(client)?.get(id)?.state ?? 'not_submitted';
      throw error;
    }
  });
}

async function verifyRefill(client, receipts, receipt) {
  const expected = JSON.parse(receipt.movement);
  const rows = (await client.getValues(MOVEMENTS_SHEET, `A1:L${MOVEMENTS_LAST_ROW}`, { valueRenderOption: 'FORMULA' })).values ?? [];
  layout(rows[0] ?? [], MOVEMENT_HEADERS, MOVEMENTS_SHEET);
  if (MOVEMENT_HEADERS.some((header, c) => rows[0][c] !== header))
    throw new WarehouseError('pending', 'Изменились колонки движений склада. Нужна проверка пополнения.');
  const matches = rows.slice(1).filter(row => row[9] === expected[9]);
  const canonical = row => row.map((v, c) => {
    if (c === 0) {
      if (typeof v === 'number') return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
      return isoDate(v);
    }
    return v;
  });
  if (matches.length !== 1 || JSON.stringify(canonical(matches[0])) !== JSON.stringify(canonical(expected)))
    throw new WarehouseError('pending', 'Пополнение пока не подтверждено. Нажмите «Проверить пополнение». Повторная запись не отправляется.');
  receipts.settle(receipt.request_id, 'confirmed');
}

export function verifyPendingRefills(client) {
  return enqueueWarehouseWrite(async () => {
    const receipts = receiptsByClient.get(client);
    if (!receipts) return;
    for (const entry of receipts.pending()) {
      try { await verifyRefill(client, receipts, receipts.get(entry.request_id)); }
      catch { /* Keep the durable receipt pending; diagnostics and the release gate expose it. */ }
    }
  });
}

function issuePayload(input) {
  return {
    code: text(input?.code),
    quantity: roundedQuantity(input?.quantity),
    orderNumber: text(input?.orderNumber),
    comment: text(input?.comment),
  };
}

function movementIssuePayload(row, movementLayout) {
  return {
    code: text(row[movementLayout.Код]),
    quantity: roundedQuantity(row[movementLayout.Количество]),
    orderNumber: text(row[movementLayout['№ заказа']]),
    comment: text(row[movementLayout.Комментарий]),
  };
}

function sameIssuePayload(left, right) {
  return (
    left.code === right.code &&
    left.quantity === right.quantity &&
    left.orderNumber === right.orderNumber &&
    left.comment === right.comment
  );
}

async function issueWarehouseItemOnce(client, input, options = {}) {
  assertWarehouseClear(client);
  const requestId = text(input?.requestId);
  if (!requestId)
    throw new WarehouseError('invalid', 'Не указан идентификатор операции');

  const context = await mutationContext(client, options);
  const movementLayout = layout(
    context.movements[0] ?? [],
    MOVEMENT_HEADERS,
    MOVEMENTS_SHEET,
  );
  const marker = `PWA:${requestId}`;
  const duplicateRows = context.movements.slice(1).filter(
    (row) => text(row[movementLayout.Ответственный]) === marker,
  );
  if (duplicateRows.length) {
    const requested = issuePayload(input);
    const matches = duplicateRows.every(
      (row) =>
        text(row[movementLayout.Операция]) === 'Расход на заказ' &&
        sameIssuePayload(movementIssuePayload(row, movementLayout), requested),
    );
    if (!matches)
      throw new WarehouseError(
        'duplicate',
        'Идентификатор операции уже использован с другими данными',
      );
    return context.parsed;
  }

  const { movementRow, movement } = await prepareIssueMovement(context, input, options);
  await client.updateValues([
    { range: a1(MOVEMENTS_SHEET, `A${movementRow}:L${movementRow}`), values: [movement] },
  ]);
  return readWarehouse(client, options);
}

async function prepareIssueMovement(context, input, options) {
  const item = context.parsed.items.find(
    (candidate) => candidate.sku === text(input?.code),
  );
  if (!item) throw new WarehouseError('missing', 'Позиция склада не найдена');

  const quantity = validQuantity(input?.quantity, 'количество');
  if (quantity <= 0)
    throw new WarehouseError('invalid', 'Количество должно быть больше нуля');

  const orderNumber = text(input?.orderNumber);
  if (!orderNumber && !options.optionalOrder) throw new WarehouseError('invalid', 'Выберите заказ');
  const configuredOrderNumbers = orderNumber && options.getValidOrderNumbers
    ? await options.getValidOrderNumbers()
    : (options.validOrderNumbers ?? []);
  const validOrderNumbers = new Set(
    [...configuredOrderNumbers].map((value) => text(value)),
  );
  if (orderNumber && !validOrderNumbers.has(orderNumber))
    throw new WarehouseError('missing', `Заказ №${orderNumber} не найден`);

  const available = Math.round(Math.max(item.stock - item.reserved, 0) * 100) / 100;
  if (quantity > available)
    throw new WarehouseError(
      'insufficient',
      `Недостаточно свободного остатка: доступно ${available} ${item.unit}`,
    );

  const movementDates = context.movements.slice(1).map((row) => [row?.[0]]);
  const movementRow = nextBlankRow(movementDates, 2, MOVEMENTS_LAST_ROW);
  return { item, today: context.today, movementRow,
    movement: movementValues({
      today: context.today,
      operation: orderNumber ? 'Расход на заказ' : 'Списание',
      item,
      quantity,
      orderNumber,
      responsible: `PWA:${text(input.requestId)}`,
      comment: text(input?.comment),
    }),
  };
}

// The finance form combines this prepared stock movement with its cash expense
// in the existing finance writer's single Google batch. Production stays stock-only.
export async function prepareWarehouseExpense(client, input, options = {}) {
  assertWarehouseClear(client);
  const context = await mutationContext(client, options);
  if (context.movements.some(row => text(row[9]) === `PWA:${text(input.requestId)}`))
    throw new WarehouseError('duplicate', 'Списание уже есть без финансовой квитанции. Нужна проверка операции.');
  const prepared = await prepareIssueMovement(context, input, { ...options, optionalOrder: true });
  if (!(Math.round(prepared.movement[7]) > 0) || !Number.isFinite(prepared.movement[7]))
    throw new WarehouseError('invalid', 'Для записи расхода заполните цену больше нуля в Google Таблице, лист «Склад».');
  if (!prepared.item.expenseCategory)
    throw new WarehouseError('invalid', 'В карточке склада не указана статья расхода.');
  const metadata = await client.getSpreadsheet();
  const sheetId = metadata.sheets?.find(sheet => sheet.properties.title === MOVEMENTS_SHEET)?.properties.sheetId;
  if (!Number.isInteger(sheetId)) throw new WarehouseError('schema', 'Не найден лист движений склада.');
  return { ...prepared, sheetId };
}

export async function verifyWarehouseExpense(client, movement) {
  const rows = (await client.getValues(MOVEMENTS_SHEET, `A1:L${MOVEMENTS_LAST_ROW}`, { valueRenderOption: 'FORMULA' })).values ?? [];
  layout(rows[0] ?? [], MOVEMENT_HEADERS, MOVEMENTS_SHEET);
  const matches = rows.slice(1).filter(row => text(row[9]) === movement.values[9]);
  const canonical = row => Array.from({ length: 12 }, (_, c) => c === 0
    ? typeof row[c] === 'number' ? new Date(Date.UTC(1899, 11, 30) + row[c] * 86400000).toISOString().slice(0, 10) : isoDate(row[c])
    : row[c] ?? '');
  return matches.length === 1 && JSON.stringify(canonical(matches[0])) === JSON.stringify(canonical(movement.values));
}

export function issueWarehouseItem(client, input, options = {}) {
  return enqueueWarehouseWrite(() =>
    issueWarehouseItemOnce(client, input, options),
  );
}

export const warehouseInternals = {
  categoryGroup,
  dateInTimeZone,
  isoDate,
  number,
  russianDate,
};
