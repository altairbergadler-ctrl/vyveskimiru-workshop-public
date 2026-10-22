import { a1 } from './google-sheets.mjs';

const SHEET_NAME = 'Производство';
const FIRST_DATA_ROW = 9;
const LAST_DATA_ROW = 308;
const REQUIRED_HEADERS = [
  '№ заказа',
  'Название заказа',
  'Изделие',
  'Клиент',
  'Срок сдачи',
  'Этап',
  'Готово',
  'Можно',
  'Исполнитель',
  'План',
  'Факт',
  'Часы',
  'Норма, ч',
  'К оплате',
  'Ждёт 1',
  'Ждёт 2',
  'Комментарий',
];

export class ProductionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function text(value) {
  return String(value ?? '').trim();
}

function boolean(value) {
  return value === true || text(value).toLocaleLowerCase('ru-RU') === 'true';
}

function number(value) {
  const normalized = text(value).replaceAll('\u00a0', '').replace(',', '.').replace(/[^0-9.-]/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoDate(value) {
  const input = text(value);
  if (!input) return null;
  const russian = input.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (russian) return `${russian[3]}-${russian[2].padStart(2, '0')}-${russian[1].padStart(2, '0')}`;
  const iso = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return iso ? input : null;
}

function dateInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function russianDate(iso) {
  const [year, month, day] = iso.split('-');
  return `${day}.${month}.${year}`;
}

function taskKey(row, orderNumber, item, stage) {
  return Buffer.from(JSON.stringify([row, orderNumber, item, stage])).toString('base64url');
}

function layoutFromHeaders(headers) {
  const positions = Object.fromEntries(headers.map((header, index) => [text(header), index]));
  const missing = REQUIRED_HEADERS.filter((header) => !Number.isInteger(positions[header]));
  if (missing.length) throw new ProductionError('schema', `В листе «${SHEET_NAME}» отсутствуют столбцы: ${missing.join(', ')}`);
  return positions;
}

export function parseProduction(values, { now = new Date(), timeZone = 'Europe/Athens' } = {}) {
  const rows = values ?? [];
  if (rows.length < 4) throw new ProductionError('schema', `Лист «${SHEET_NAME}» пуст или повреждён`);
  const headers = rows[3] ?? [];
  const layout = layoutFromHeaders(headers);
  const today = dateInTimeZone(now, timeZone);
  const allowOutOfOrder = boolean(rows[0]?.[11]);
  const tasks = [];

  for (let index = 4; index < rows.length; index += 1) {
    const source = rows[index] ?? [];
    const orderNumber = text(source[layout['№ заказа']]);
    const item = text(source[layout['Изделие']]);
    const stage = text(source[layout['Этап']]);
    if (!orderNumber || !item || !stage) continue;
    const row = index + 5;
    const completed = boolean(source[layout['Готово']]);
    const availability = text(source[layout['Можно']]);
    const dueDate = isoDate(source[layout['Срок сдачи']]);
    const plannedDate = isoDate(source[layout.План]);
    const completedDate = isoDate(source[layout.Факт]);
    const waitingFor = [text(source[layout['Ждёт 1']]), text(source[layout['Ждёт 2']])].filter(Boolean);
    tasks.push({
      key: taskKey(row, orderNumber, item, stage),
      row,
      orderNumber,
      orderName: text(source[layout['Название заказа']]),
      item,
      client: text(source[layout.Клиент]),
      dueDate,
      stage,
      completed,
      availability,
      canComplete: completed || allowOutOfOrder || availability === 'можно',
      assignee: text(source[layout.Исполнитель]) || null,
      plannedDate,
      completedDate,
      hours: number(source[layout.Часы]),
      normHours: number(source[layout['Норма, ч']]),
      payment: number(source[layout['К оплате']]),
      waitingFor,
      comment: text(source[layout.Комментарий]) || null,
      overdue: !completed && Boolean(dueDate && dueDate < today),
    });
  }

  return {
    sheetName: SHEET_NAME,
    today,
    allowOutOfOrder,
    stats: {
      total: tasks.length,
      completed: tasks.filter((task) => task.completed).length,
      ready: tasks.filter((task) => !task.completed && task.availability === 'можно').length,
      waiting: tasks.filter((task) => !task.completed && task.availability === 'ждёт').length,
      overdue: tasks.filter((task) => task.overdue).length,
      planToday: tasks.filter((task) => task.plannedDate === today).length,
      completedToday: tasks.filter((task) => task.completed && task.completedDate === today).length,
      dueTodayOrders: new Set(tasks
        .filter((task) => !task.completed && task.dueDate === today)
        .map((task) => task.orderNumber)).size,
    },
    tasks,
    refreshedAt: now.toISOString(),
  };
}

export async function readProduction(client, options = {}) {
  if (!client.configured) throw new ProductionError('unavailable', 'Google Таблица производства не подключена');
  const response = await client.getValues(SHEET_NAME, `A5:Q${LAST_DATA_ROW}`);
  return parseProduction(response.values ?? [], options);
}

export async function setProductionCompletion(client, payload, options = {}) {
  const row = Number(payload?.row);
  const key = text(payload?.key);
  const completed = payload?.completed;
  if (!Number.isInteger(row) || row < FIRST_DATA_ROW || row > LAST_DATA_ROW || !key || typeof completed !== 'boolean') {
    throw new ProductionError('invalid', 'Некорректная задача производства');
  }

  const production = await readProduction(client, options);
  const task = production.tasks.find((candidate) => candidate.row === row);
  if (!task || task.key !== key) throw new ProductionError('stale', 'План производства изменился. Обновите страницу и повторите действие.');
  if (completed && !task.canComplete) {
    const reason = task.waitingFor.length ? `Сначала выполните: ${task.waitingFor.join(', ')}` : 'Предыдущий этап ещё не выполнен';
    throw new ProductionError('blocked', reason);
  }
  if (task.completed === completed) return production;

  await client.updateValues([
    { range: a1(SHEET_NAME, `G${row}`), values: [[completed]] },
    { range: a1(SHEET_NAME, `K${row}`), values: [[completed ? russianDate(production.today) : '']] },
  ]);
  const updated = await readProduction(client, options);
  const confirmed = updated.tasks.find((candidate) => candidate.row === row && candidate.key === key);
  const expectedDate = completed ? production.today : null;
  if (!confirmed || confirmed.completed !== completed || confirmed.completedDate !== expectedDate) {
    throw new ProductionError('sync', 'Отметка не подтверждена Google Таблицей. Обновите страницу и повторите действие.');
  }
  return updated;
}

export const productionInternals = { boolean, dateInTimeZone, isoDate, number, russianDate, taskKey };
