import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { GoogleSheetsClient } from './sheets-client.mjs';
import { readProduction } from './production.mjs';
import { readBoard } from '../modules/orders/server/orders.mjs';
import { validateRoute, requireValue } from './production-planner.mjs';
import {
  PRODUCTION_SHEET,
  PRODUCTION_HEADERS,
  PRODUCTION_CAPACITY,
  encodeProduction,
  decodeProduction,
} from './production-sheet.mjs';

const digest = (value) =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function migrateProduction(legacy) {
  const state = {
    version: 1,
    revision: 0,
    timeZone: 'Europe/Athens',
    travelMinutes: 5,
    workers: [],
    products: [],
    resources: [],
    items: [],
    tasks: [],
    records: [],
    events: [],
    receipts: {},
    pendingOrders: [],
    movements: [],
    orders: [],
    warehouse: [],
    migration: {
      source: 'Производство',
      sourceDigest: digest(legacy.tasks),
      importedAt: new Date().toISOString(),
      tasks: legacy.tasks.length,
    },
  };
  state.resources = [
    ['cnc', 'ЧПУ', 'Станочная'],
    ['bender', 'Фендер', 'Печатная'],
    ['plotter', 'Плоттер', 'Печатная'],
    ['printer', 'Промышленный принтер', 'Печатная'],
    ['welding', 'Сварочный пост', 'Сварочная'],
    ['bench', 'Сборочный стол', 'Сборочная'],
    ['drying', 'Место сушки', 'Сборочная'],
  ].map(([id, name, zone]) => ({ id, name, zone }));
  const groups = new Map();
  for (const task of legacy.tasks) {
    const key = JSON.stringify([task.orderNumber, task.item]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  for (const [key, tasks] of groups) {
    const itemId = 'legacy-item-' + digest(key).slice(0, 20);
    const stageIds = new Map(tasks.map((t, i) => [t.row, `s${i}`]));
    const stages = tasks.map((t) => ({
      id: stageIds.get(t.row),
      name: t.stage,
      kind: 'manual',
      minutes: Math.max(1, Math.round((t.normHours || t.hours || 1) * 60)),
      skill: t.stage,
      resourceId: '',
      materials: [],
      setupMinutes: 0,
      finishMinutes: 0,
      controlEvery: 0,
      controlMinutes: 0,
      dependencies: t.waitingFor.map((name) => {
        const matches = tasks.filter((d) => d.stage === name);
        requireValue(
          matches.length === 1,
          `Невозможно однозначно перенести зависимость этапа в строке ${t.row}.`,
        );
        return stageIds.get(matches[0].row);
      }),
    }));
    validateRoute(stages);
    const productId =
      'legacy-product-' + digest({ name: tasks[0].item, stages }).slice(0, 20);
    if (!state.products.some((p) => p.id === productId))
      state.products.push({
        id: productId,
        name: tasks[0].item,
        unit: 'позиция',
        versions: [{ version: 1, stages }],
        needsSetup: true,
      });
    state.items.push({
      id: itemId,
      orderId: tasks[0].orderNumber,
      productId,
      productVersion: 1,
      name: tasks[0].item,
      quantity: 1,
      unit: 'позиция',
      imported: true,
    });
    for (const [index, t] of tasks.entries()) {
      let workerId = null;
      if (t.assignee) {
        workerId = 'legacy-worker-' + digest(t.assignee).slice(0, 20);
        if (!state.workers.some((w) => w.id === workerId))
          state.workers.push({
            id: workerId,
            name: t.assignee,
            skills: [],
            zones: [],
            enabled: false,
            access: false,
            role: 'master',
            shiftStart: '09:00',
            shiftEnd: '18:00',
            days: [1, 2, 3, 4, 5],
            needsSetup: true,
          });
      }
      state.tasks.push({
        ...stages[index],
        id: `legacy-row-${t.row}`,
        stageId: stages[index].id,
        itemId,
        orderId: t.orderNumber,
        quantity: 1,
        doneQuantity: t.completed ? 1 : 0,
        unit: 'этап',
        status: t.completed ? 'done' : 'todo',
        workerId,
        issued: {},
        pin: null,
        mustDate: t.plannedDate || t.dueDate || legacy.today,
        dueAt: t.dueDate ? `${t.dueDate}T20:59:59Z` : null,
        dependencies: stages[index].dependencies.map(
          (id) =>
            `legacy-row-${tasks.find((d) => stageIds.get(d.row) === id).row}`,
        ),
        completedAt: t.completedDate ? `${t.completedDate}T12:00:00Z` : null,
        imported: true,
        legacyRow: t.row,
        legacyComment: t.comment,
        needsSetup: true,
      });
    }
  }
  return state;
}
export async function prepareProductionSheet(client, { apply = false } = {}) {
  const metadata = await client.getSpreadsheet({ fields: 'sheets.properties' });
  const existing = metadata.sheets.find(
    (s) => s.properties.title === PRODUCTION_SHEET,
  );
  if (existing) {
    const data = (
      await client.getValues(PRODUCTION_SHEET, `A1:F${PRODUCTION_CAPACITY}`, {
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
    ).values;
    requireValue(
      JSON.stringify(data?.[0]) === JSON.stringify(PRODUCTION_HEADERS),
      'Существующий лист производства не соответствует контракту.',
    );
    const state = decodeProduction(data.slice(1));
    return {
      existing: true,
      tasks: state.tasks.length,
      completed: state.tasks.filter((t) => t.status === 'done').length,
    };
  }
  const legacy = await readProduction(client);
  const orderIds = new Set((await readBoard(client)).orders.map((o) => o.id));
  requireValue(
    legacy.tasks.every((t) => orderIds.has(t.orderNumber)),
    'Есть этапы без соответствующего заказа. Сначала восстановите связь с заказом.',
  );
  const state = migrateProduction(legacy);
  const rows = encodeProduction(state);
  if (apply) {
    const sheetId = 19760907;
    requireValue(
      !metadata.sheets.some((s) => s.properties.sheetId === sheetId),
      'ID нового листа уже занят.',
    );
    const cell = (value) => ({
      userEnteredValue:
        typeof value === 'number'
          ? { numberValue: value }
          : { stringValue: String(value) },
    });
    // Sheet creation, header and every imported row form one atomic Sheets request.
    await client.batchUpdate([
      {
        addSheet: {
          properties: {
            sheetId,
            title: PRODUCTION_SHEET,
            gridProperties: {
              rowCount: PRODUCTION_CAPACITY,
              columnCount: 6,
              frozenRowCount: 1,
            },
          },
        },
      },
      {
        updateCells: {
          range: { sheetId, startRowIndex: 0, startColumnIndex: 0 },
          rows: [PRODUCTION_HEADERS, ...rows].map((row) => ({
            values: row.map(cell),
          })),
          fields: 'userEnteredValue',
        },
      },
      {
        addProtectedRange: {
          protectedRange: {
            range: { sheetId },
            description:
              'Управляется приложением производства. Ручное изменение может нарушить зависимости.',
            warningOnly: true,
          },
        },
      },
    ]);
    const confirmed = await prepareProductionSheet(client);
    requireValue(
      confirmed.tasks === legacy.tasks.length,
      'Перенос производства не подтверждён.',
    );
  }
  return {
    existing: false,
    applied: apply,
    tasks: state.tasks.length,
    completed: state.tasks.filter((t) => t.status === 'done').length,
    products: state.products.length,
    workers: state.workers.length,
    sourceUnchanged: true,
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const client = new GoogleSheetsClient({
    credentialsFile: process.env.GOOGLE_CREDENTIALS_FILE,
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
  });
  try {
    console.log(
      JSON.stringify(
        await prepareProductionSheet(client, {
          apply: process.argv.includes('--apply'),
        }),
      ),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        code: error.code || 'PRODUCTION_MIGRATION_BLOCKED',
        message: error.message,
      }),
    );
    process.exitCode = 1;
  }
}
