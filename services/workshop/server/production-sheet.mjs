import crypto from 'node:crypto';
import { a1 } from './sheets-client.mjs';
import { readWarehouse, issueWarehouseItem } from './warehouse.mjs';
import { readBoard } from '../modules/orders/server/orders.mjs';
import { requireValue, taskDeadline } from './production-planner.mjs';

export const PRODUCTION_SHEET = 'Производство · данные';
export const PRODUCTION_HEADERS = [
  'Тип',
  'ID',
  'Заказ',
  'Название',
  'Данные',
  'Ревизия',
];
export const PRODUCTION_CAPACITY = 5000;
const collections = [
  'workers',
  'products',
  'resources',
  'items',
  'tasks',
  'records',
  'events',
  'movements',
];
const hash = (value) =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function encodeProduction(state) {
  const meta = Object.fromEntries(
    Object.entries(state).filter(
      ([key]) =>
        ![...collections, 'warehouse', 'orders', 'receipts'].includes(key),
    ),
  );
  const rows = [['meta', 'main', '', '', JSON.stringify(meta), state.revision]];
  for (const key of collections)
    for (const [index, value] of (state[key] || []).entries())
      rows.push([
        key,
        value.id || String(index),
        value.orderId || '',
        value.name || value.stage || '',
        JSON.stringify(value),
        state.revision,
      ]);
  for (const [id, value] of Object.entries(state.receipts || {}))
    rows.push(['receipts', id, '', '', JSON.stringify(value), state.revision]);
  requireValue(
    rows.length < PRODUCTION_CAPACITY && rows.every((r) => r[4].length < 48000),
    'Достигнут предел листа производства. Нужна архивация завершённых маршрутов.',
  );
  return rows;
}
export function decodeProduction(rows) {
  requireValue(
    rows[0]?.[0] === 'meta' && rows[0]?.[1] === 'main',
    'Не найден контракт нового производства.',
  );
  const state = JSON.parse(rows[0][4]);
  requireValue(
    state.version === 1 && Number.isInteger(state.revision),
    'Неизвестная версия производства.',
  );
  for (const key of collections) state[key] = [];
  state.receipts = {};
  const seen = new Set();
  for (const row of rows.slice(1)) {
    requireValue(
      !seen.has(`${row[0]}:${row[1]}`),
      'В производстве повторяется идентификатор.',
    );
    seen.add(`${row[0]}:${row[1]}`);
    const value = JSON.parse(row[4]);
    if (row[0] === 'receipts') state.receipts[row[1]] = value;
    else {
      requireValue(
        collections.includes(row[0]),
        'Неизвестная запись производства.',
      );
      state[row[0]].push(value);
    }
  }
  state.orders = [];
  state.warehouse = [];
  return state;
}
export function isProductionSheetWrite(route, options) {
  if (route !== '/values:batchUpdate') return false;
  const input = JSON.parse(options.body || '{}');
  return input.data?.some((d) => d.range?.startsWith(a1(PRODUCTION_SHEET, '')));
}
export async function validateProductionSheetWrite(route, options, request) {
  const input = JSON.parse(options.body);
  requireValue(
    route === '/values:batchUpdate' &&
      input.valueInputOption === 'RAW' &&
      input.data?.length === 1,
    'Некорректная запись нового производства.',
  );
  const block = input.data[0];
  requireValue(
    block.range === a1(PRODUCTION_SHEET, `A2:F${block.values.length + 1}`) &&
      block.values.length < PRODUCTION_CAPACITY,
    'Запись выходит за границы производства.',
  );
  const response = await request(
    `/values/${encodeURIComponent(a1(PRODUCTION_SHEET, 'A1:F1'))}?valueRenderOption=FORMULA`,
  );
  requireValue(
    JSON.stringify(response.values?.[0]) === JSON.stringify(PRODUCTION_HEADERS),
    'Изменилась структура листа производства.',
  );
  const nonempty = block.values.filter((row) => row.some((v) => v !== ''));
  decodeProduction(nonempty);
  requireValue(
    block.values.every(
      (row) =>
        row.length === 6 &&
        row.every((v) => typeof v === 'string' || typeof v === 'number'),
    ),
    'Некорректные поля производства.',
  );
}

export class ProductionSheetStore {
  constructor({ client, db, ordersClient = client }) {
    this.client = client;
    this.ordersClient = ordersClient;
    this.db = db;
    this.cached = null;
    this.readAt = 0;
    db.exec(
      'CREATE TABLE IF NOT EXISTS production_v2_commands(id TEXT PRIMARY KEY, state TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL)',
    );
  }
  pending() {
    return this.db
      .prepare(
        "SELECT * FROM production_v2_commands WHERE state='pending' ORDER BY created_at LIMIT 1",
      )
      .get();
  }
  async rows() {
    const response = await this.client.getValues(
      PRODUCTION_SHEET,
      `A1:F${PRODUCTION_CAPACITY}`,
      { valueRenderOption: 'UNFORMATTED_VALUE' },
    );
    requireValue(
      JSON.stringify(response.values?.[0]) ===
        JSON.stringify(PRODUCTION_HEADERS),
      'Лист нового производства не подготовлен или изменён.',
    );
    return response.values
      .slice(1)
      .filter((row) => row.some((v) => v !== ''))
      .map((row) => Array.from({ length: 6 }, (_, i) => row[i] ?? ''));
  }
  async load(force = false) {
    if (!force && this.cached && Date.now() - this.readAt < 20000)
      return structuredClone(this.cached);
    const rows = await this.rows();
    const state = decodeProduction(rows);
    const board = await readBoard(this.ordersClient);
    const warehouse = await readWarehouse(this.client, {
      timeZone: state.timeZone,
    });
    state.orders = board.orders.map((o) => ({
      id: o.id,
      name: o.title,
      customer: o.client,
      dueAt: o.dueDate
        ? new Date(
            taskDeadline(
              { mustDate: String(o.dueDate).slice(0, 10) },
              state.timeZone,
            ),
          ).toISOString()
        : null,
      status: ['Готов к выдаче', 'Монтаж', 'Сдан', 'Выполненная'].includes(
        o.status,
      )
        ? 'Выполненная'
        : o.status,
      actualStatus: o.status,
    }));
    state.warehouse = warehouse.items;
    state.live = true;
    for (const task of state.tasks) {
      const order = state.orders.find((o) => o.id === task.orderId);
      if (order) task.dueAt = order.dueAt;
    }
    this.cached = state;
    this.currentRows = rows;
    this.readAt = Date.now();
    return structuredClone(state);
  }
  async commit(next) {
    requireValue(
      !this.pending(),
      'Предыдущее действие ещё проверяется. Повторная запись пока остановлена.',
      'pending',
      409,
    );
    const before = await this.rows();
    requireValue(
      hash(before) === hash(this.currentRows),
      'Производство изменилось в таблице. Обновите экран.',
      'stale',
      409,
    );
    const after = encodeProduction(next);
    const existing = new Set(
      (decodeProduction(before).movements || []).map((m) => m.id),
    );
    const materials = next.movements
      .filter((m) => !existing.has(m.id))
      .map((m) => ({
        id: m.id,
        state: 'ready',
        code: m.sku,
        quantity: m.quantity,
        orderNumber: m.orderId,
        comment: `Производство: ${m.taskId}; мастер: ${next.workers.find((w) => w.id === m.actorId)?.name || m.actorId}`,
      }));
    const payload = { before: hash(before), after, materials };
    const id = crypto.randomUUID();
    this.db
      .prepare('INSERT INTO production_v2_commands VALUES(?,?,?,?)')
      .run(id, 'pending', JSON.stringify(payload), new Date().toISOString());
    await this.recover();
    requireValue(
      !this.pending(),
      'Действие сохранено и ожидает подтверждения Google.',
      'pending',
      503,
    );
    if (materials.length) await this.load(true);
    else {
      // Readback already confirmed these exact rows. Avoid refetching the entire
      // order board and warehouse after every start/complete command.
      this.cached = structuredClone(next);
      this.currentRows = after;
      this.readAt = Date.now();
    }
  }
  async recover() {
    const entry = this.pending();
    if (!entry) return;
    const payload = JSON.parse(entry.payload);
    const save = () =>
      this.db
        .prepare('UPDATE production_v2_commands SET payload=? WHERE id=?')
        .run(JSON.stringify(payload), entry.id);
    const settle = () =>
      this.db
        .prepare(
          "UPDATE production_v2_commands SET state='confirmed',payload='{}' WHERE id=?",
        )
        .run(entry.id);
    const rows = await this.rows();
    if (hash(rows) === hash(payload.after)) {
      settle();
      this.cached = null;
      return;
    }
    requireValue(
      hash(rows) === payload.before,
      'Таблица изменена при неподтверждённой команде. Нужна проверка руководителя.',
      'pending',
      409,
    );
    for (const material of payload.materials) {
      if (material.state === 'confirmed') continue;
      if (material.state === 'ready') {
        material.state = 'submitted';
        save();
        try {
          await issueWarehouseItem(
            this.client,
            { ...material, requestId: material.id },
            { validOrderNumbers: [material.orderNumber] },
          );
        } catch (error) {
          if (
            error.notSubmitted ||
            [
              'invalid',
              'missing',
              'insufficient',
              'capacity',
              'pending',
            ].includes(error.code)
          ) {
            material.state = 'ready';
            save();
          }
          throw error;
        }
      }
      const ledger =
        (await this.client.getValues('Движения склада', 'A1:L500')).values ||
        [];
      const matches = ledger
        .slice(1)
        .filter((row) => row[9] === `PWA:${material.id}`);
      requireValue(
        matches.length === 1 &&
          matches[0][1] === 'Расход на заказ' &&
          String(matches[0][2]) === material.code &&
          Math.abs(
            Number(String(matches[0][4]).replace(',', '.')) - material.quantity,
          ) < 0.000001 &&
          String(matches[0][8]) === material.orderNumber &&
          matches[0][10] === material.comment,
        'Выдача материала ещё не подтверждена. Повторное списание не отправляется.',
        'pending',
        503,
      );
      material.state = 'confirmed';
      save();
    }
    const size = Math.max(rows.length, payload.after.length);
    const values = [
      ...payload.after,
      ...Array.from({ length: size - payload.after.length }, () => [
        '',
        '',
        '',
        '',
        '',
        '',
      ]),
    ];
    await this.client.updateValues(
      [{ range: a1(PRODUCTION_SHEET, `A2:F${size + 1}`), values }],
      { valueInputOption: 'RAW' },
    );
    requireValue(
      hash(await this.rows()) === hash(payload.after),
      'Запись производства ещё не подтверждена.',
      'pending',
      503,
    );
    settle();
    this.cached = null;
  }
}
