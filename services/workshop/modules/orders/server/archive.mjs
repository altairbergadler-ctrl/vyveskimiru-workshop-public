import { a1 } from './sheets.mjs';
import { OrderError, columnName, configuredStatuses, findUniqueOrder, readTables } from './orders.mjs';
import { describeRecord, verifyWrites } from './editing.mjs';

const text = value => value === undefined || value === null ? '' : String(value).trim();
const eligible = new Set(['Готов к выдаче', 'Монтаж']);
const active = new Set(['На согласовании', 'Назначен']);
const final = new Set(['Выполнен', 'Отменён']);
const linkedRows = (table, orderId) => (table?.rows ?? []).filter(row => text(table.cell(row, '№ заказа')) === orderId);
const installationId = (table, row) => text(table.rawCell(row, 'ID монтажа'));
const conflict = () => new OrderError('ARCHIVE_INSTALLATIONS_CONFLICT', 'Состав монтажей или их данные изменились. Обновите доску и повторите перенос в архив.', 409);

function statusUpdate(table, row, header, value) {
  const column = table.indices.get(header);
  if (column === undefined || String(table.rawCell(row, header) ?? '').startsWith('=')) {
    throw new OrderError('FORMULA_PROTECTED', 'Статус вычисляется формулой или его колонка недоступна. Проверьте таблицу.', 409);
  }
  return { range: a1(table.name, `${columnName(column)}${row.rowNumber}`), values: [[value]] };
}

function validateInput(orderId, expectedStatus, installations) {
  if (typeof orderId !== 'string' || !orderId.trim() || orderId.length > 200 || typeof expectedStatus !== 'string' || expectedStatus.length > 160 || !Array.isArray(installations) || installations.length > 1000) {
    throw new OrderError('INVALID_ARCHIVE', 'Передайте номер заказа, текущий статус и полный список связанных монтажей.', 400);
  }
  const records = installations.map(entry => entry?.record);
  for (const record of records) {
    if (!record || record.sheet !== 'Монтажи' || !Number.isInteger(record.rowNumber) || record.rowNumber < 1 || typeof record.key !== 'string' || !record.key || !/^[a-f0-9]{64}$/u.test(record.revision ?? '')) {
      throw new OrderError('INVALID_ARCHIVE', 'Не передана версия одной из записей монтажа. Обновите доску.', 400);
    }
  }
  if (new Set(records.map(record => record.key)).size !== records.length || new Set(records.map(record => record.rowNumber)).size !== records.length) throw conflict();
  return records;
}

function assertInstallationSet(table, rows, records, tables) {
  if (rows.length !== records.length) throw conflict();
  const expected = new Map(records.map(record => [record.key, record]));
  for (const row of rows) {
    const id = installationId(table, row);
    if (!id || table.rows.filter(candidate => installationId(table, candidate) === id).length !== 1) {
      throw new OrderError('ARCHIVE_DUPLICATE_INSTALLATION', 'Монтажам нужны уникальные постоянные номера. Исправьте пустые или повторяющиеся номера в таблице.', 409);
    }
    const record = expected.get(id);
    const current = describeRecord('installation', table, row, tables).record;
    if (!record || ['sheet', 'rowNumber', 'key', 'revision'].some(key => record[key] !== current[key])) throw conflict();
    if (!active.has(text(table.cell(row, 'Статус монтажа'))) && !final.has(text(table.cell(row, 'Статус монтажа')))) {
      throw new OrderError('ARCHIVE_INSTALLATION_STATUS', 'У одного из монтажей неизвестный статус. Уточните его перед переносом в архив.', 422);
    }
  }
}

function verifyInstallationSet(before, after, orderId, initialRows) {
  const currentRows = linkedRows(after, orderId);
  if (currentRows.length !== initialRows.length) throw new Error('Installation set changed');
  if (!before && !after) return;
  if (!before || !after || JSON.stringify(before.headers) !== JSON.stringify(after.headers)) throw new Error('Installation headers changed');
  for (const row of initialRows) {
    const id = installationId(before, row);
    const matches = after.rows.filter(candidate => installationId(after, candidate) === id);
    if (matches.length !== 1 || matches[0].rowNumber !== row.rowNumber || text(after.cell(matches[0], '№ заказа')) !== orderId) throw new Error('Installation identity changed');
    const old = before.rawValues[row.rowNumber - 1] ?? [];
    const current = after.rawValues[row.rowNumber - 1] ?? [];
    const statusColumn = before.indices.get('Статус монтажа');
    const changed = active.has(text(before.cell(row, 'Статус монтажа')));
    const expectedStatus = changed ? 'Выполнен' : text(before.cell(row, 'Статус монтажа'));
    if (text(after.cell(matches[0], 'Статус монтажа')) !== expectedStatus) throw new Error('Installation status changed');
    for (let column = 0; column < Math.max(old.length, current.length); column++) {
      const expected = changed && column === statusColumn ? 'Выполнен' : old[column];
      if ((expected ?? '') !== (current[column] ?? '')) throw new Error('Installation fields changed');
    }
  }
}

export async function archiveOrder(client, { orderId, expectedStatus, installations } = {}) {
  const records = validateInput(orderId, expectedStatus, installations);
  const id = orderId.trim();
  const { tables } = await readTables(client, ['Заказы', 'Настройки'], { includeFormulas: true, optional: ['Монтажи'] });
  const orders = tables['Заказы'];
  const row = findUniqueOrder(orders, id);
  const status = text(orders.cell(row, 'Статус'));
  if (status !== expectedStatus.trim()) throw new OrderError('STATUS_CONFLICT', 'Статус заказа изменился. Обновите доску перед переносом в архив.', 409);
  if (!eligible.has(status)) throw new OrderError('ARCHIVE_NOT_READY', 'Перенести в архив можно только готовый заказ или заказ на монтаже.', 422);
  const settings = tables['Настройки'];
  if (!configuredStatuses(settings).includes('Сдан')) throw new OrderError('ARCHIVE_STATUS_MISSING', 'В настройках таблицы отсутствует статус «Сдан».', 422);
  const targets = [...new Set(settings.rows.map(candidate => settings.rawCell(candidate, 'Статус заказа')).filter(value => typeof value === 'string' && value.trim() === 'Сдан'))];
  if (targets.length !== 1) throw new OrderError('ARCHIVE_STATUS_MISSING', 'Статус «Сдан» должен быть однозначно указан в настройках таблицы.', 409);
  const table = tables['Монтажи'];
  const rows = linkedRows(table, id);
  assertInstallationSet(table, rows, records, tables);
  const updates = [statusUpdate(orders, row, 'Статус', targets[0])];
  for (const installation of rows) if (active.has(text(table.cell(installation, 'Статус монтажа')))) {
    updates.push(statusUpdate(table, installation, 'Статус монтажа', 'Выполнен'));
  }
  try {
    // A single RAW batch covers both sheets. Never retry an uncertain write or roll it back.
    await client.updateValues(updates);
    const verified = (await readTables(client, ['Заказы'], { includeFormulas: true, optional: ['Монтажи'] })).tables;
    const verifiedOrder = findUniqueOrder(verified['Заказы'], id);
    if (verifiedOrder.rowNumber !== row.rowNumber || text(verified['Заказы'].cell(verifiedOrder, 'Статус')) !== 'Сдан') throw new Error('Order changed');
    verifyWrites(tables, verified, updates);
    verifyInstallationSet(table, verified['Монтажи'], id, rows);
  } catch {
    throw new OrderError('ARCHIVE_UNCONFIRMED', 'Запрос на перенос в архив отправлен, но результат не подтверждён. Обновите доску и проверьте заказ перед повторной попыткой.', 409);
  }
  return { orderId: id, status: 'Сдан', completedInstallations: updates.length - 1, changed: true };
}
