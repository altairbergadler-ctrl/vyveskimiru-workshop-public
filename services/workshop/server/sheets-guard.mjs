import fs from 'node:fs';
import { SheetsError, a1 } from './sheets-client.mjs';
import { isProductionSheetWrite, validateProductionSheetWrite } from './production-sheet.mjs';
import { isDocumentSheetWrite, validateDocumentSheetWrite } from './document-sheets.mjs';

export const SHEETS_SCHEMA = JSON.parse(fs.readFileSync(new URL('./sheets-schema.json', import.meta.url), 'utf8'));
const entries = Object.entries(SHEETS_SCHEMA.sheets).filter(([, s]) => s.headerRow);
const normal = value => String(value ?? '').normalize('NFC').trim().replace(/\s+/gu, ' ');
const column = letters => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
function letter(index) {
  let result = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result;
  return result;
}
const blank = v => v === undefined || v === null || v === '';
const raw = cell => cell?.userEnteredValue?.formulaValue ?? cell?.userEnteredValue?.numberValue ?? cell?.userEnteredValue?.boolValue ?? cell?.userEnteredValue?.stringValue ?? '';
const effective = cell => cell?.effectiveValue?.numberValue ?? cell?.effectiveValue?.boolValue ?? cell?.effectiveValue?.stringValue ?? raw(cell);
const formula = value => typeof value === 'string' && value.startsWith('=');

export class SheetsContractError extends SheetsError {
  constructor(code, location = '') {
    super(`SHEETS_CONTRACT_${code}`, `Запись остановлена: ${location ? `${location} — ` : ''}структура или поля Google Таблицы не соответствуют проверенному контракту. Обновите данные; если ошибка повторится, нужна проверка таблицы.`, 409);
    this.notSubmitted = true;
  }
}
const deny = (code, location) => { throw new SheetsContractError(code, location); };
function only(object, keys) {
  if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).some(k => !keys.includes(k))) deny('REQUEST');
}

// Shift relative A1 rows, keeping absolute rows, quoted strings and sheet names.
// This is deliberately not a formula evaluator and never changes the workbook.
export function shiftFormula(value, delta) {
  return value.replace(/"(?:[^"]|"")*"|'(?:[^']|'')*'|\b(\$?[A-Z]{1,3})(\$?)(\d+)\b/gu,
    (match, col, absolute, row) => col && !absolute ? `${col}${Number(row) + delta}` : match);
}
export function expectedFormula(schema, col, row) {
  return schema.formulas[col] ? shiftFormula(schema.formulas[col], row - schema.headerRow - 1) : undefined;
}
function tableCells(sheet) {
  const cells = [];
  for (const block of sheet.data ?? []) for (const [i, row] of (block.rowData ?? []).entries()) {
    const r = (block.startRow ?? 0) + i;
    cells[r] ??= [];
    for (const [j, cell] of (row?.values ?? []).entries()) cells[r][(block.startColumn ?? 0) + j] = cell;
  }
  return cells;
}
function location(table, row, col) { return `${table.name}!${letter(col)}${row}`; }
function checkKeys(tables) {
  const financeIds = new Set();
  for (const table of tables.values()) for (const key of table.schema.keys) {
    const seen = ['Платежи', 'Расходы'].includes(table.name) ? financeIds : new Set();
    for (let r = table.schema.headerRow; r < table.schema.lastRow; r++) {
      const value = normal(effective(table.cells[r]?.[column(key)]));
      if (!value) continue;
      const canonical = table.name === 'Склад' || table.name === 'Клиенты' && key === 'B' ? value.toLocaleLowerCase('ru-RU').replaceAll('ё', 'е') : value;
      if (seen.has(canonical)) deny('DUPLICATE_KEY', location(table, r + 1, column(key)));
      seen.add(canonical);
    }
  }
}
export function validateSnapshot(data) {
  const tables = new Map();
  for (const [name, schema] of entries) {
    const matches = (data.sheets ?? []).filter(s => s.properties?.title === name);
    if (matches.length !== 1) deny('SHEET', name);
    const source = matches[0], grid = source.properties.gridProperties;
    if (!Number.isInteger(source.properties.sheetId) || !Number.isInteger(grid?.rowCount) || !Number.isInteger(grid?.columnCount) || grid.rowCount < schema.lastRow || grid.columnCount < schema.headers.length) deny('GRID', name);
    const cells = tableCells(source), headers = cells[schema.headerRow - 1] ?? [];
    const width = Math.max(headers.length, schema.headers.length);
    for (let c = 0; c < width; c++) if (normal(raw(headers[c])) !== normal(schema.headers[c])) deny('HEADER', `${name}!${letter(c)}${schema.headerRow}`);
    const table = { name, schema, cells, id: source.properties.sheetId, nativeTables: source.tables ?? [] };
    // Anchor formulas prove the current dependency ranges without recalculating them.
    for (const [col, expected] of Object.entries(schema.formulas)) {
      const value = raw(cells[schema.headerRow]?.[column(col)]);
      // A completed stock movement keeps its historical snapshot, including row 2.
      if (name === 'Движения склада' && !blank(raw(cells[1]?.[0])) && !formula(value)) {
        typed(value, schema.types[col] || 'text', location(table, 2, column(col)), 'RAW');
      } else if (value !== expected) deny('FORMULA', location(table, schema.headerRow + 1, column(col)));
    }
    for (let row = schema.headerRow + 1; row <= schema.lastRow; row++) for (const col of Object.keys(schema.formulas)) {
      const current = cells[row - 1]?.[column(col)]?.userEnteredValue?.formulaValue;
      if (current && current !== expectedFormula(schema, col, row)) deny('FORMULA', location(table, row, column(col)));
    }
    tables.set(name, table);
  }
  if (new Set([...tables.values()].map(t => t.id)).size !== tables.size) deny('SHEET_ID');
  checkKeys(tables);
  return tables;
}
function parseRange(range, tables) {
  if (typeof range !== 'string') deny('RANGE');
  const m = range.match(/^'((?:[^']|'')+)'!([A-Z]+)([1-9]\d*)(?::([A-Z]+)([1-9]\d*))?$/u);
  if (!m) deny('RANGE');
  const table = tables.get(m[1].replaceAll("''", "'"));
  if (!table || table.schema.role !== 'data') deny('READ_ONLY');
  const c = column(m[2]), r = Number(m[3]), endC = column(m[4] || m[2]), endR = Number(m[5] || m[3]);
  if (r <= table.schema.headerRow || r > endR || endR > table.schema.lastRow || c > endC || endC >= table.schema.headers.length) deny('RANGE', table.name);
  return { table, r, c, endR, endC };
}
function typed(value, type, at, mode) {
  // values.batchUpdate treats null as "skip", not clear; never confuse the two.
  if (value === null || value === undefined) deny('TYPE', at);
  if (blank(value)) return;
  if (!['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) deny('TYPE', at);
  if (formula(value) && mode === 'USER_ENTERED') deny('FORMULA_INPUT', at);
  const serial = typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 2958466;
  const date = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4})$/u.test(value);
  const valid = {
    text: typeof value === 'string', id: typeof value === 'string' || typeof value === 'number',
    number: typeof value === 'number', boolean: typeof value === 'boolean', date: serial || date,
    uuid: typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(value),
    timestamp: typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/gu.test(value) && Number.isFinite(Date.parse(value)),
    time: typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/u.test(value) || typeof value === 'number' && value >= 0 && value < 1,
  }[type];
  if (!valid) deny('TYPE', at);
}
function cellsToValues(rows) {
  if (!Array.isArray(rows) || !rows.length) deny('REQUEST');
  return rows.map(row => {
    only(row, ['values']);
    if (!Array.isArray(row.values)) deny('REQUEST');
    return row.values.map(cell => {
      only(cell, ['userEnteredValue']);
      const v = cell.userEnteredValue ?? {};
      only(v, ['stringValue', 'numberValue', 'boolValue']);
      if (Object.keys(v).length > 1) deny('REQUEST');
      if (Object.hasOwn(v, 'stringValue') && typeof v.stringValue !== 'string' || Object.hasOwn(v, 'numberValue') && typeof v.numberValue !== 'number' || Object.hasOwn(v, 'boolValue') && typeof v.boolValue !== 'boolean') deny('TYPE');
      return v.stringValue ?? v.numberValue ?? v.boolValue ?? '';
    });
  });
}
function checkPrepared(table, row) {
  for (const col of Object.keys(table.schema.formulas)) {
    if (raw(table.cells[row - 1]?.[column(col)]) !== expectedFormula(table.schema, col, row)) deny('FORMULA', location(table, row, column(col)));
  }
}
function emptyInputs(table, row) {
  return table.schema.headers.every((_, c) => table.schema.formulas[letter(c)] || blank(raw(table.cells[row - 1]?.[c])));
}

export function validateWrite(path, options, tables) {
  if (options.method !== 'POST') deny('METHOD');
  let body;
  try { body = JSON.parse(options.body); } catch { deny('REQUEST'); }
  const writes = [], copies = [];
  const byId = id => [...tables.values()].find(t => t.id === id);
  let mode = 'RAW';
  if (path === '/values:batchUpdate') {
    only(body, ['valueInputOption', 'data']);
    if (!['RAW', 'USER_ENTERED'].includes(body.valueInputOption) || !Array.isArray(body.data)) deny('REQUEST');
    mode = body.valueInputOption;
    for (const entry of body.data) {
      only(entry, ['range', 'values', 'majorDimension']);
      if (entry.majorDimension && entry.majorDimension !== 'ROWS') deny('REQUEST');
      writes.push({ ...parseRange(entry.range, tables), values: entry.values });
    }
  } else if (path === ':batchUpdate') {
    only(body, ['requests']);
    if (!Array.isArray(body.requests)) deny('REQUEST');
    for (const request of body.requests) {
      only(request, ['updateCells', 'copyPaste', 'appendCells']);
      if (Object.keys(request).length !== 1) deny('REQUEST');
      if (request.updateCells) {
        const u = request.updateCells;
        only(u, ['start', 'rows', 'fields']); only(u.start, ['sheetId', 'rowIndex', 'columnIndex']);
        if (u.fields !== 'userEnteredValue') deny('REQUEST');
        const table = byId(u.start.sheetId), values = cellsToValues(u.rows);
        if (!table || !Number.isInteger(u.start.rowIndex) || !Number.isInteger(u.start.columnIndex)) deny('RANGE');
        const r = u.start.rowIndex + 1, c = u.start.columnIndex;
        writes.push({ ...parseRange(a1(table.name, `${letter(c)}${r}:${letter(c + Math.max(...values.map(v => v.length)) - 1)}${r + values.length - 1}`), tables), values });
      } else if (request.copyPaste) {
        const cp = request.copyPaste;
        only(cp, ['source', 'destination', 'pasteType', 'pasteOrientation']);
        for (const range of [cp.source, cp.destination]) only(range, ['sheetId', 'startRowIndex', 'endRowIndex', 'startColumnIndex', 'endColumnIndex']);
        const table = byId(cp.source.sheetId), s = cp.source, d = cp.destination;
        if (request !== body.requests[0] || copies.length || !table || !['Платежи', 'Расходы'].includes(table.name) || s.sheetId !== d.sheetId || cp.pasteType !== 'PASTE_NORMAL' || cp.pasteOrientation !== 'NORMAL') deny('COPY');
        for (const range of [s, d]) if (!Number.isInteger(range.startRowIndex) || range.startRowIndex < 1 || range.endRowIndex !== range.startRowIndex + 1 || range.endRowIndex > table.schema.lastRow || range.startColumnIndex !== 0 || range.endColumnIndex !== table.schema.headers.length) deny('COPY', table.name);
        if (!emptyInputs(table, d.endRowIndex) || s.startRowIndex === d.startRowIndex && !emptyInputs(table, s.endRowIndex)) deny('COPY_OCCUPIED', table.name);
        if (copies.some(c => c.table === table && c.row === d.endRowIndex)) deny('COPY');
        checkPrepared(table, s.endRowIndex);
        for (const col of Object.keys(table.schema.formulas)) {
          const current = raw(table.cells[d.startRowIndex]?.[column(col)]);
          if (!blank(current) && current !== expectedFormula(table.schema, col, d.endRowIndex)) deny('FORMULA', location(table, d.endRowIndex, column(col)));
        }
        copies.push({ table, row: d.endRowIndex });
      } else {
        const u = request.appendCells;
        only(u, ['sheetId', 'tableId', 'rows', 'fields']);
        const table = byId(u.sheetId), values = cellsToValues(u.rows);
        if (table?.name !== 'Монтажи' || u.fields !== 'userEnteredValue' || values.length !== 1 || values[0].length !== 10 || body.requests.length !== 1) deny('APPEND');
        const native = table.nativeTables.filter(t => t.range?.sheetId === table.id && (t.range.startRowIndex ?? 0) === 0 && (t.range.startColumnIndex ?? 0) === 0 && t.range.endColumnIndex === 10 && t.range.endRowIndex <= table.schema.lastRow);
        if (native.length !== 1 || !u.tableId || native[0].tableId !== u.tableId) deny('APPEND');
        // Conservative: require space after the last occupied row, even if there are holes.
        // Thus native-table first-free-row behaviour cannot grow beyond the contract.
        let last = 1;
        for (let r = 2; r <= table.schema.lastRow; r++) if (!emptyInputs(table, r)) last = r;
        if (last + 1 > native[0].range.endRowIndex) deny('CAPACITY', table.name);
        const r = last + 1;
        writes.push({ table, r, c: 0, endR: r, endC: 9, values });
      }
    }
  } else deny('REQUEST');
  if (!writes.length) deny('EMPTY');
  const changes = new Map();
  for (const w of writes) {
    if (!Array.isArray(w.values) || !w.values.length || w.values.length !== w.endR - w.r + 1) deny('SHAPE');
    for (const [i, values] of w.values.entries()) {
      if (!Array.isArray(values) || values.length !== w.endC - w.c + 1) deny('SHAPE');
      const row = w.r + i, table = w.table, schema = table.schema;
      const newCatalog = table.name === 'Склад' && w.c === 0 && values.length === 15 && emptyInputs(table, row);
      const movement = table.name === 'Движения склада' && w.c === 0 && values.length === 12 && emptyInputs(table, row);
      const copying = copies.some(cp => cp.table === table && cp.row === row);
      if (newCatalog && mode !== 'USER_ENTERED') deny('FORMULA_INPUT');
      if (newCatalog && (blank(values[0]) || values[4] !== 0 || values[5] !== 0 || values[9] !== '')) deny('CATALOG_CREATE');
      if (movement && [0, 1, 2, 3, 4, 5].some(c => blank(values[c]))) deny('MOVEMENT');
      if (!newCatalog && !movement && !copying) checkPrepared(table, row);
      for (const [j, value] of values.entries()) {
        const c = w.c + j, col = letter(c), at = location(table, row, c), previous = raw(table.cells[row - 1]?.[c]);
        if (changes.has(at)) deny('OVERLAP', at);
        if (newCatalog && schema.formulas[col]) {
          if (value !== expectedFormula(schema, col, row) || !blank(previous) && previous !== value) deny('FORMULA', at);
        } else {
          if (!schema.writable.includes(col) && !movement && !newCatalog) deny('READ_ONLY', at);
          if (movement && schema.formulas[col] && !blank(previous) && previous !== expectedFormula(schema, col, row)) deny('FORMULA', at);
          if (formula(previous) && !(movement && previous === expectedFormula(schema, col, row))) deny('FORMULA', at);
          typed(value, schema.types[col] || 'text', at, mode);
        }
        if (schema.keys.includes(col) && !(table.name === 'Клиенты' && col === 'B') && !blank(previous) && !formula(previous) && normal(previous) !== normal(value) && !(blank(value) && ['Платежи', 'Расходы'].includes(table.name))) deny('KEY_CHANGE', at);
        changes.set(at, { table, row, c, value });
      }
    }
  }
  for (const cp of copies) for (const col of cp.table.schema.writable) if (!changes.has(location(cp.table, cp.row, column(col)))) deny('COPY_INPUTS', cp.table.name);
  for (const { table, row, c, value } of changes.values()) {
    if (!['Платежи', 'Расходы'].includes(table.name) || !table.schema.keys.includes(letter(c)) || !blank(value) || blank(raw(table.cells[row - 1]?.[c]))) continue;
    if (!table.schema.writable.every(col => {
      const change = changes.get(location(table, row, column(col)));
      return change && blank(change.value);
    })) deny('KEY_CHANGE', location(table, row, c));
  }
  // Project only explicit inputs for key checks; no formulas are evaluated here.
  const projected = new Map([...tables].map(([name, t]) => [name, { ...t, cells: t.cells.map(r => r?.slice()) }]));
  for (const { table, row, c, value } of changes.values()) {
    const target = projected.get(table.name);
    target.cells[row - 1] ??= [];
    target.cells[row - 1][c] = { userEnteredValue: typeof value === 'number' ? { numberValue: value } : typeof value === 'boolean' ? { boolValue: value } : { stringValue: value } };
  }
  checkKeys(projected);
  // A client name is the existing foreign key: renaming it must update its orders.
  for (const { table, row, c, value } of changes.values()) {
    if (table.name !== 'Клиенты' || c !== 1) continue;
    const oldName = normal(raw(table.cells[row - 1]?.[c]));
    if (!oldName || oldName === normal(value)) continue;
    const orders = projected.get('Заказы');
    if (orders.cells.slice(orders.schema.headerRow).some(r => normal(effective(r?.[3])) === oldName)) deny('REFERENCE', location(table, row, c));
  }
  for (const { table, row, c, value } of changes.values()) {
    const reference = table.schema.references[letter(c)];
    if (!reference || blank(value)) continue;
    const [name, col] = reference.split('!'), target = projected.get(name);
    const matches = target.cells.slice(target.schema.headerRow, target.schema.lastRow).filter(r => normal(effective(r?.[column(col)])) === normal(value));
    if (matches.length !== 1) deny('REFERENCE', location(table, row, c));
  }
}

export function installSheetsGuard(client) {
  const request = client.request.bind(client);
  let lastCheck = 0, pending;
  const status = { version: SHEETS_SCHEMA.version, ok: false, checkedAt: null, code: 'NOT_CHECKED' };
  async function inspect() {
    const parameters = new URLSearchParams({ includeGridData: 'true', fields: 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),tables(tableId,range),data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue))))' });
    for (const [name, schema] of entries) {
      parameters.append('ranges', a1(name, `A1:${letter(schema.headers.length - 1)}${schema.lastRow}`));
      parameters.append('ranges', a1(name, `${schema.headerRow}:${schema.headerRow}`));
    }
    try {
      const tables = validateSnapshot(await request(`?${parameters}`));
      Object.assign(status, { ok: true, checkedAt: new Date().toISOString(), code: null }); lastCheck = Date.now();
      return tables;
    } catch (error) {
      Object.assign(status, { ok: false, checkedAt: new Date().toISOString(), code: error.code || 'SHEETS_UNAVAILABLE' });
      throw error;
    }
  }
  async function check() {
    pending ??= inspect().finally(() => { pending = null; });
    return pending;
  }
  client.request = async (path, options = {}) => {
    const writing = (options.method || 'GET') !== 'GET';
    if (!writing) {
      if (!status.ok || Date.now() - lastCheck > 30_000) await check();
      return request(path, options);
    }
    try {
      // A write never reuses a cached snapshot (including an in-flight read check).
      const tables = await inspect();
      if (isProductionSheetWrite(path, options)) await validateProductionSheetWrite(path, options, request);
      else if (isDocumentSheetWrite(path, options)) await validateDocumentSheetWrite(path, options, request);
      else {
        if (process.env.PRODUCTION_V2 === 'google' && JSON.parse(options.body || '{}').data?.some(d => d.range?.startsWith(a1('Производство', '')))) deny('LEGACY_PRODUCTION', 'Производство');
        validateWrite(path, options, tables);
      }
    } catch (error) {
      // Even a preflight network timeout is known to precede submission.
      if (error.code?.startsWith('SHEETS_CONTRACT_')) status.lastDenied = { code: error.code, at: new Date().toISOString() };
      error.notSubmitted = true;
      throw error;
    }
    lastCheck = 0;
    return request(path, options);
  };
  return { status: () => ({ ...status }), check };
}
