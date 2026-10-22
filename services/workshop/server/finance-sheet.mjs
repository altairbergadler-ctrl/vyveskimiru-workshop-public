import crypto from 'node:crypto';
import { readOrders } from './orders.mjs';
import { duplicateWarning } from './finance-duplicates.mjs';
import { prepareWarehouseExpense, verifyWarehouseExpense, readWarehouse } from './warehouse.mjs';
import { SHEETS, text, fromSheet, layoutFromHeaders, validationProblems, hashRecord, recordValueUpdates, isMeasurement, hasMeasurementMarker } from './finance-contract.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fields = ['date', 'category', 'description', 'amount', 'account', 'cashInRegister', 'orderNumber', 'counterparty', 'comment'];
const comparable = v => v == null ? '' : v;
const fingerprint = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const dateSerial = v => (Date.parse(`${v}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000;
const wantedFields = (operation, payload) => {
  const wanted = Object.fromEntries(['type', ...fields].map(f => [f, payload[f] ?? null]));
  if (operation !== 'delete') wanted.cashInRegister = wanted.type === 'income';
  return wanted;
};
const commandFingerprint = (operation, payload, wanted = wantedFields(operation, payload)) =>
  fingerprint([operation, payload.id ?? null, wanted, payload.expectedHash ?? null,
    ...(payload.warehouseMovement ? [payload.warehouseMovement] : [])]);

export class FinanceError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message); this.name = 'FinanceError'; this.code = code; this.statusCode = statusCode;
  }
}
const fail = (code, message, status) => { throw new FinanceError(code, message, status); };
const inputFields = type => type === 'income'
  ? fields.filter(f => !['category', 'description', 'counterparty'].includes(f))
  : fields.filter(f => f !== 'cashInRegister');
const matches = (record, wanted) => record?.type === wanted.type && isMeasurement(record) === isMeasurement(wanted) && inputFields(wanted.type)
  .every(f => comparable(record[f]) === comparable(wanted[f]));

function cellWrite(sheetId, row, column, value) {
  const userEnteredValue = typeof value === 'number' ? { numberValue: value }
    : typeof value === 'boolean' ? { boolValue: value } : { stringValue: String(value ?? '') };
  return { updateCells: { start: { sheetId, rowIndex: row - 1, columnIndex: column },
    rows: [{ values: [{ userEnteredValue }] }], fields: 'userEnteredValue' } };
}

// SQLite holds command receipts and display timestamps only. No business values
// are loaded from the retired transaction replica or treated as confirmed there.
export class FinanceSheetStore {
  constructor({ db, client }) {
    this.db = db; this.client = client; this.lastSuccessAt = null; this.lastError = ''; this.invalidRows = 0;
    db.exec(`CREATE TABLE IF NOT EXISTS finance_commands (
      request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, operation TEXT NOT NULL,
      target_id TEXT NOT NULL, input_json TEXT NOT NULL, state TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS finance_record_meta (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);`);
    // Preserve the existing order of same-day records across the cutover.
    db.exec('INSERT OR IGNORE INTO finance_record_meta SELECT id,created_at FROM transactions');
  }

  status() {
    return { configured: this.client.configured, mode: 'google-direct', pending: this.pending().length,
      conflicts: 0, conflictHistory: this.db.prepare('SELECT count(*) AS n FROM sync_conflicts').get().n,
      invalidRows: this.invalidRows, last_success_at: this.lastSuccessAt, last_error: this.lastError };
  }

  pending() {
    return this.db.prepare("SELECT request_id AS requestId, operation, state, created_at AS createdAt FROM finance_commands WHERE state='submitted'").all();
  }

  async snapshot() {
    const parameters = new URLSearchParams({ includeGridData: 'true',
      fields: 'sheets(properties(sheetId,title,gridProperties),data(startRow,rowData(values(formattedValue,effectiveValue,userEnteredValue))))' });
    // The existing prepared sheet grids bound this read. No hard-coded sheet IDs.
    for (const sheet of SHEETS) parameters.append('ranges', `'${sheet.name}'!A:P`);
    const data = await this.client.request(`?${parameters}`);
    const tables = new Map(), records = [], missingIds = [], invalid = [], seen = new Set();
    for (const config of SHEETS) {
      const source = data.sheets?.find(s => s.properties.title === config.name);
      if (!source) fail('FINANCE_SCHEMA', `Не найден лист «${config.name}».`, 503);
      const cells = source.data?.[0]?.rowData?.map(r => r.values ?? []) ?? [];
      const rows = cells.map(row => row.map(c => c.formattedValue ?? c.effectiveValue?.boolValue ?? c.effectiveValue?.numberValue ?? c.effectiveValue?.stringValue ?? ''));
      let layout;
      try { layout = layoutFromHeaders(config, rows[0] ?? []); }
      catch { fail('FINANCE_SCHEMA', `Изменились обязательные столбцы листа «${config.name}».`, 503); }
      const table = { ...config, sheetId: source.properties.sheetId, gridRows: source.properties.gridProperties.rowCount,
        layout, rows, cells, records: [] };
      tables.set(config.type, table);
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!text(row[layout.dateIndex]) && !text(row[layout.amountIndex]) && !text(row[layout.orderNumberIndex])) continue;
        const record = fromSheet(config, row, i + 1, layout);
        const problems = validationProblems(record);
        if (record.id && seen.has(record.id)) problems.push('duplicate_sync_id');
        if (record.id) seen.add(record.id);
        if (problems.length) { invalid.push({ sheet: config.name, row: i + 1, problems }); continue; }
        if (!record.id) { missingIds.push({ table, row: i + 1 }); continue; }
        const stamp = this.db.prepare('SELECT created_at FROM finance_record_meta WHERE id=?').get(record.id)?.created_at
          ?? (text(row[layout.updatedIndex]) || `${record.date}T00:00:00.000Z`);
        Object.assign(record, { createdAt: stamp, updatedAt: text(row[layout.updatedIndex]) || stamp,
          sheetHash: hashRecord(record), cashInRegister: Boolean(record.cashInRegister), pending: 0, deletedAt: null });
        records.push(record); table.records.push(record);
      }
    }
    this.invalidRows = invalid.length;
    if (invalid.length) fail('FINANCE_INVALID_ROWS', `В таблице есть некорректные финансовые строки (${invalid.length}). Данные не подтверждены.`, 503);
    return { tables, records, missingIds };
  }

  async read() {
    try {
      let data = await this.snapshot();
      // Compatibility with manual entry in Google: add only technical UUIDs,
      // under the common command queue; never change manually entered values.
      if (data.missingIds.length) {
        const requests = data.missingIds.flatMap(({ table, row }) => [
          cellWrite(table.sheetId, row, table.layout.idIndex, crypto.randomUUID()),
          cellWrite(table.sheetId, row, table.layout.updatedIndex, new Date().toISOString()),
          cellWrite(table.sheetId, row, table.layout.originIndex, 'sheet'),
        ]);
        await this.client.batchUpdate(requests);
        data = await this.snapshot();
        if (data.missingIds.length) fail('FINANCE_IDS_UNCONFIRMED', 'Не удалось подтвердить идентификаторы финансовых строк.', 503);
      }
      this.lastSuccessAt = new Date().toISOString(); this.lastError = '';
      return data.records.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    } catch (error) { this.lastError = error.code || 'FINANCE_UNAVAILABLE'; throw error; }
  }

  async execute(operation, payload) {
    const requestId = payload.requestId || crypto.randomUUID(); // Compatibility with an already-open older PWA.
    if (!uuid.test(requestId)) fail('FINANCE_REQUEST_ID', 'Некорректный номер запроса.', 400);
    const wanted = wantedFields(operation, payload);
    // The sheet column remains part of the financial contract, never a manual control.
    if (operation !== 'delete') {
      if (wanted.type === 'income' && !isMeasurement(wanted) && !wanted.orderNumber) fail('FINANCE_ORDER_REQUIRED', 'Для оплаты заказа выберите заказ.', 400);
      if (isMeasurement(wanted) && (wanted.orderNumber || wanted.counterparty)) fail('FINANCE_MEASUREMENT_ORDER', 'Замеры сохраняются без заказа и клиента.', 400);
      if (wanted.type === 'income' && !isMeasurement(wanted) && hasMeasurementMarker(text(wanted.comment))) fail('FINANCE_RESERVED_COMMENT', 'Начало комментария зарезервировано для замеров.', 400);
    }
    const digest = commandFingerprint(operation, payload, wanted);
    let receipt = this.db.prepare('SELECT * FROM finance_commands WHERE request_id=?').get(requestId);
    if (receipt && receipt.fingerprint !== digest) fail('FINANCE_REQUEST_CHANGED', 'Этот запрос уже использован с другими данными. Обновите форму.');
    let data = await this.snapshot();
    if (data.missingIds.length) { await this.read(); data = await this.snapshot(); }
    const targetId = receipt?.target_id || (operation === 'create' ? requestId : String(payload.id ?? ''));
    const current = data.records.find(r => r.id === targetId);
    const confirmed = async () => (operation === 'delete' ? !current : matches(current, wanted)) &&
      (!payload.warehouseMovement || await verifyWarehouseExpense(this.client, payload.warehouseMovement));
    if (receipt && ['submitted', 'confirmed'].includes(receipt.state)) {
      if (await confirmed()) {
        this.confirm(requestId);
        return operation === 'delete' ? { success: true } : { transaction: current };
      }
      if (receipt.state === 'confirmed') fail('FINANCE_CHANGED_AFTER_SAVE', 'Операция уже была сохранена, затем изменилась. Обновите список.');
      fail('FINANCE_UNCONFIRMED', 'Результат записи пока не подтверждён. Повторите проверку этого запроса; новую операцию создавать не нужно.');
    }
    if (this.pending().length) fail('FINANCE_PENDING', 'Есть неподтверждённая запись. Сначала проверьте её результат.');
    if (operation !== 'create' && !current) fail('FINANCE_MISSING', 'Операция не найдена.', 404);
    if (operation === 'create' && current) fail('FINANCE_DUPLICATE', 'Идентификатор операции уже занят.');
    if (current && payload.expectedHash && current.sheetHash !== payload.expectedHash) fail('FINANCE_STALE', 'Операция изменилась. Обновите список перед сохранением.');
    if (current && operation !== 'delete' && isMeasurement(current) !== isMeasurement(wanted)) fail('FINANCE_MEASUREMENT_TYPE', 'Нельзя превращать оплату заказа в замер или обратно.', 400);
    if (current && operation !== 'delete' && current.type !== wanted.type) fail('FINANCE_TYPE', 'Нельзя изменить вид существующей операции.', 400);
    // MATCH in Google distinguishes a numeric ID from the same digits stored as
    // text. Preserve the actual order key's type; never coerce arbitrary IDs.
    // Keep this after receipt recovery so a replay cannot submit another write.
    let orderValue = wanted.orderNumber;
    if (operation !== 'delete' && wanted.orderNumber) {
      const { orders } = await readOrders(this.client, { includeRawNumber: true });
      const order = orders.find(order => order.number === wanted.orderNumber);
      if (order) orderValue = order.rawNumber;
      else if (current?.orderNumber === wanted.orderNumber) {
        const { layout, cells } = data.tables.get(current.type);
        const value = cells[current.sheetRow - 1]?.[layout.orderNumberIndex]?.userEnteredValue;
        orderValue = value?.numberValue ?? value?.stringValue ?? orderValue;
      }
      // Cancellation must not prevent maintaining an existing payment's history.
      if (wanted.type === 'income' && !isMeasurement(wanted) &&
          (!current || current.orderNumber !== wanted.orderNumber)) {
        if (!order) fail('FINANCE_ORDER_MISSING', 'Заказ не найден. Обновите список заказов.');
        if (['отменён', 'отменен'].includes(order.status.toLocaleLowerCase('ru-RU'))) {
          fail('FINANCE_ORDER_CANCELLED', 'Заказ отменён. Для новой оплаты сначала верните его на доску.');
        }
        if (!(order.debt > 0)) {
          fail('FINANCE_ORDER_PAID', 'По этому заказу нет суммы к получению. Обновите список и выберите неоплаченный заказ.');
        }
      }
      // An empty computed client would invalidate the ledger after committing.
      // Reject before submitting any write, including edits of legacy text keys.
      if (order && wanted.type === 'income' && !isMeasurement(wanted) && !order.client) {
        fail('FINANCE_ORDER_CLIENT', 'В заказе не указан клиент. Заполните клиента в карточке заказа перед сохранением оплаты.');
      }
    }
    if (operation === 'create' && !payload.warehouseMovement) {
      const warning = duplicateWarning(wanted, data.records, fingerprint([requestId, digest]));
      if (warning && payload.duplicateConfirmation !== warning.confirmation) {
        const error = new FinanceError('FINANCE_POSSIBLE_DUPLICATE', 'Похожая операция уже есть. Проверьте её перед сохранением.');
        error.duplicateWarning = warning;
        throw error;
      }
    }
    const table = data.tables.get(current?.type || wanted.type);
    if (!table) fail('FINANCE_TYPE', 'Некорректный вид операции.', 400);
    const { layout } = table;
    let row = current?.sheetRow;
    const requests = [];
    if (operation === 'delete') {
      // Remove the operation's inputs, keeping prepared formulas and all row
      // references intact. Physical row deletion silently shrinks SUMIF ranges.
      for (const entry of recordValueUpdates(current, row, '', layout)) {
        const letter = entry.range.match(/!([A-Z]+)/)[1];
        const col = [...letter].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        if (table.cells[row - 1]?.[col]?.userEnteredValue?.formulaValue) fail('FINANCE_FORMULA', 'В исходных полях операции появилась формула. Удаление остановлено.');
        requests.push({ updateCells: { start: { sheetId: table.sheetId, rowIndex: row - 1, columnIndex: col },
          rows: [{ values: [{}] }], fields: 'userEnteredValue' } });
      }
    } else {
      if (!row) {
        const lastUsed = table.rows.reduce((last, r, i) => i > 0 && (text(r[layout.dateIndex]) || text(r[layout.amountIndex])) ? i + 1 : last, 1);
        row = lastUsed + 1;
        // Existing formula coverage is part of the contract, not an infinite ledger.
        const coveredRows = wanted.type === 'income' ? 500 : 498;
        if (row > Math.min(table.gridRows, coveredRows)) fail('FINANCE_CAPACITY', 'Закончился проверенный диапазон финансовых строк. Требуется расширить формулы таблицы.', 409);
        const template = Math.max(2, lastUsed);
        requests.push({ copyPaste: { source: { sheetId: table.sheetId, startRowIndex: template - 1, endRowIndex: template, startColumnIndex: 0, endColumnIndex: layout.width },
          destination: { sheetId: table.sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: 0, endColumnIndex: layout.width }, pasteType: 'PASTE_NORMAL', pasteOrientation: 'NORMAL' } });
      }
      const stamp = new Date().toISOString();
      for (const entry of recordValueUpdates({ ...wanted, id: targetId }, row, stamp, layout)) {
        const letter = entry.range.match(/!([A-Z]+)/)[1];
        const col = [...letter].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        if (current && table.cells[row - 1]?.[col]?.userEnteredValue?.formulaValue) fail('FINANCE_FORMULA', 'Это поле стало формулой. Правка остановлена.');
        let value = entry.values[0][0];
        if (col === layout.dateIndex) value = dateSerial(value);
        if (col === layout.orderNumberIndex) value = orderValue;
        requests.push(cellWrite(table.sheetId, row, col, value));
      }
    }
    if (payload.warehouseMovement) {
      const movement = payload.warehouseMovement;
      requests.push({ updateCells: { start: { sheetId: movement.sheetId, rowIndex: movement.row - 1, columnIndex: 0 },
        rows: [{ values: movement.values.map((value, column) => ({ userEnteredValue: column === 0 ? { numberValue: dateSerial(payload.date) }
          : typeof value === 'number' ? { numberValue: value } : { stringValue: value } })) }], fields: 'userEnteredValue' } });
    }
    const now = new Date().toISOString();
    if (!receipt) {
      this.db.prepare(`INSERT INTO finance_commands VALUES(?,?,?,?,?,'prepared',?,?)`)
        .run(requestId, digest, operation, targetId, JSON.stringify({ ...payload, requestId }), now, now);
      receipt = { request_id: requestId };
    }
    this.db.prepare("UPDATE finance_commands SET state='submitted',updated_at=? WHERE request_id=?").run(now, requestId);
    try {
      // Structure/formula copy and inputs commit in one Google batch.
      await this.client.batchUpdate(requests);
    } catch (error) {
      if (error.notSubmitted || [400, 401, 403, 404].includes(error.httpStatus)) {
        this.db.prepare("UPDATE finance_commands SET state=? WHERE request_id=?").run(error.notSubmitted ? 'rejected' : 'prepared', requestId);
        throw error;
      }
      this.lastError = 'FINANCE_UNCONFIRMED';
      fail('FINANCE_UNCONFIRMED', 'Ответ Google потерян. Нажмите сохранить ещё раз для проверки того же запроса.');
    }
    const after = await this.read();
    const result = after.find(r => r.id === targetId);
    if ((operation === 'delete' ? Boolean(result) : !matches(result, wanted)) ||
        (payload.warehouseMovement && !await verifyWarehouseExpense(this.client, payload.warehouseMovement))) {
      this.lastError = 'FINANCE_UNCONFIRMED';
      fail('FINANCE_UNCONFIRMED', 'Не удалось подтвердить сохранение. Повторите проверку того же запроса.');
    }
    this.confirm(requestId);
    return operation === 'delete' ? { success: true } : { transaction: result };
  }

  async issueWarehouseExpense(input, options = {}) {
    const requestId = text(input.requestId);
    if (!uuid.test(requestId)) fail('FINANCE_REQUEST_ID', 'Обновите страницу: нужен постоянный номер операции.', 400);
    const issue = { code: text(input.code), quantity: Number(input.quantity), orderNumber: text(input.orderNumber), comment: text(input.comment) };
    const prior = this.db.prepare('SELECT input_json,state FROM finance_commands WHERE request_id=?').get(requestId);
    let payload;
    if (prior) {
      payload = JSON.parse(prior.input_json);
      if (!payload.warehouseMovement || JSON.stringify(payload.warehouseIssue) !== JSON.stringify(issue))
        fail('FINANCE_REQUEST_CHANGED', 'Этот запрос уже использован с другими данными. Обновите форму.');
    }
    if (!prior || !['submitted', 'confirmed'].includes(prior.state)) {
      const prepared = await prepareWarehouseExpense(this.client, { ...issue, requestId }, options);
      payload = { requestId, type: 'expense', date: prepared.today, category: prepared.item.expenseCategory,
        description: `Со склада: ${prepared.item.name} · ${prepared.movement[4]} ${prepared.item.unit}`,
        // The existing financial ledger records whole rubles; stock keeps its price snapshot.
        amount: Math.round(prepared.movement[7]), account: 'В кассе', orderNumber: issue.orderNumber || null,
        counterparty: null, comment: issue.comment || null,
        warehouseIssue: issue,
        warehouseMovement: { sheetId: prepared.sheetId, row: prepared.movementRow, values: prepared.movement },
      };
      // A definite preflight/rejection never reached Google. Revalidate stock and
      // choose a fresh row after another writer; uncertain commands keep their snapshot.
      if (prior) this.db.prepare('UPDATE finance_commands SET fingerprint=?,input_json=?,updated_at=? WHERE request_id=?')
        .run(commandFingerprint('create', payload), JSON.stringify(payload), new Date().toISOString(), requestId);
    }
    const result = await this.execute('create', payload);
    return { ...await readWarehouse(this.client, options), ...result };
  }

  confirm(requestId) {
    this.db.prepare("UPDATE finance_commands SET state='confirmed',updated_at=? WHERE request_id=?").run(new Date().toISOString(), requestId);
    this.lastError = '';
  }

  async verifyPending() {
    const pending = this.db.prepare("SELECT operation,input_json FROM finance_commands WHERE state='submitted'").all();
    for (const command of pending) await this.execute(command.operation, JSON.parse(command.input_json));
    return this.pending();
  }

  async editPrepared(prepared) {
    const current = (await this.read()).find(r => r.id === prepared.syncId);
    if (!current || fields.filter(f => f !== 'cashInRegister').some(f => comparable(current[f]) !== comparable(prepared.current[f]))) {
      fail('FINANCE_STALE', 'Финансовая запись изменилась. Обновите доску.');
    }
    // A retry of an uncertain Kanban edit has a stable key from its revision.
    const hex = fingerprint([prepared.syncId, prepared.current, prepared.changes]);
    const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
    return this.execute('update', { ...current, ...prepared.changes, requestId, expectedHash: current.sheetHash });
  }
}

export const financeSheetInternals = { matches, dateSerial, cellWrite };
