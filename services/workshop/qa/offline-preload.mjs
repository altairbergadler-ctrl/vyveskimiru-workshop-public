import { widgetFixtures } from './widget-fixtures.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { GoogleSheetsClient } from '../server/sheets-client.mjs';
import { fixtures } from './fixtures.mjs';
import { productionSheetFixtures } from './production-fixture.mjs';
import { SHEETS_SCHEMA, shiftFormula } from '../server/sheets-guard.mjs';
import { assertOwned } from './safety.mjs';

const directory = assertOwned(process.env.QA_DIRECTORY || '');
if (process.env.GOOGLE_SPREADSHEET_ID !== 'offline-workshop' || process.env.GOOGLE_CREDENTIALS_FILE || process.env.DATA_DIR !== path.join(directory, 'data')) throw new Error('OFFLINE_ENV_NOT_ISOLATED');
const file = path.join(directory, 'sheet.json');
if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(process.env.QA_FIXTURE_PROFILE === 'production' ? productionSheetFixtures() : process.env.QA_FIXTURE_PROFILE === 'widgets' ? widgetFixtures() : fixtures()));
const tables = JSON.parse(fs.readFileSync(file, 'utf8'));
const names = Object.keys(tables);
const save = () => fs.writeFileSync(file, JSON.stringify(tables));
const col = letters => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
function selection(range) {
  const m = range.match(/^'([^']+)'!([A-Z]+)(\d*)?(?::([A-Z]+)(\d*)?)?$/);
  if (!m || !tables[m[1]]) throw new Error('UNSUPPORTED_OFFLINE_RANGE');
  return { name: m[1], c: col(m[2]), r: Number(m[3] || 1) - 1, endC: col(m[4] || m[2]), endR: Number(m[5] || m[3] || tables[m[1]].length) };
}
const format = (value, c, r, name) => typeof value === 'number' && r > 0 && c === 0 && ['Платежи', 'Расходы', 'Движения склада'].includes(name)
  ? new Date(Date.UTC(1899, 11, 30) + value * 86400000).toISOString().slice(0, 10) : value;
const calculated = value => value && typeof value === 'object' ? value.value : value;
function values(range, render = 'FORMATTED_VALUE') {
  const s = selection(range);
  return { range, values: tables[s.name].slice(s.r, s.endR).map((r, i) => r.slice(s.c, s.endC + 1).map((v, j) => render === 'FORMULA' ? v?.formula ?? v : render === 'UNFORMATTED_VALUE' ? calculated(v) : format(calculated(v), s.c + j, s.r + i, s.name))) };
}
Object.defineProperty(GoogleSheetsClient.prototype, 'configured', { get: () => true });
GoogleSheetsClient.prototype.request = async function(request, options) {
  // Deterministic slow upstream for concurrent HTTP regression tests only.
  if (request.startsWith('?') && request.includes('formattedValue')) {
    const pause = path.join(directory, 'pause-finance-read');
    if (fs.existsSync(pause)) {
      fs.writeFileSync(path.join(directory, 'finance-read-paused'), 'workshop-qa-v1');
      while (fs.existsSync(pause)) await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  if (fs.existsSync(path.join(directory, 'refill-readback-failed'))) throw new Error('OFFLINE_REFILL_READBACK_FAILURE');
  if (fs.existsSync(path.join(directory, `fail-${process.env.APP_VERSION}`))) throw new Error('OFFLINE_INJECTED_FAILURE');
  if (this.spreadsheetId !== 'offline-workshop') throw new Error('OFFLINE_SHEET_FORBIDDEN');
  if (request.startsWith('/values:batchGet')) {
    const params = new URLSearchParams(request.split('?')[1]);
    return { valueRanges: params.getAll('ranges').map(range => values(range, params.get('valueRenderOption'))) };
  }
  if (request.startsWith('/values:batchUpdate')) {
    const batch = JSON.parse(options.body).data;
    const refill = batch.some(update => update.values?.[0]?.[9]?.startsWith?.('PWA:refill:'));
    const faultFile = path.join(directory, 'refill-fault');
    const fault = refill && fs.existsSync(faultFile) ? fs.readFileSync(faultFile, 'utf8') : '';
    if (fault === 'before-write') throw new Error('OFFLINE_REFILL_NOT_APPLIED');
    for (const update of batch) {
      const s = selection(update.range);
      update.values.forEach((row, i) => row.forEach((v, j) => { tables[s.name][s.r + i] ??= []; tables[s.name][s.r + i][s.c + j] = v; }));
    }
    save();
    if (fault === 'lost-response') {
      fs.writeFileSync(path.join(directory, 'refill-readback-failed'), 'workshop-qa-v1');
      throw new Error('OFFLINE_REFILL_RESPONSE_LOST');
    }
    return {};
  }
  if (request.startsWith('/values/')) return values(decodeURIComponent(request.split('?')[0].slice(8)), new URLSearchParams(request.split('?')[1]).get('valueRenderOption'));
  if (request === ':batchUpdate') {
    const requests = JSON.parse(options.body).requests;
    const issue = requests.some(update => update.updateCells && names[update.updateCells.start.sheetId] === 'Движения склада');
    const faultFile = path.join(directory, 'warehouse-expense-fault');
    const fault = issue && fs.existsSync(faultFile) ? fs.readFileSync(faultFile, 'utf8') : '';
    if (fault === 'preflight') throw Object.assign(new Error('OFFLINE_ISSUE_PREFLIGHT_REJECTED'), { notSubmitted: true });
    if (fault === 'before-write') throw new Error('OFFLINE_ISSUE_NOT_APPLIED');
    for (const update of requests) {
      if (update.copyPaste) {
        const { source, destination } = update.copyPaste, name = names[source.sheetId];
        tables[name][destination.startRowIndex] = structuredClone(tables[name][source.startRowIndex]).map(v => v?.formula ? { ...v, formula: shiftFormula(v.formula, destination.startRowIndex - source.startRowIndex) } : v);
        continue;
      }
      if (!update.updateCells) throw new Error('UNSUPPORTED_OFFLINE_WRITE');
      const u = update.updateCells, name = names[u.start.sheetId];
      u.rows.forEach((row, i) => row.values.forEach((cell, j) => {
        const v = cell.userEnteredValue || {};
        tables[name][u.start.rowIndex + i] ??= [];
        tables[name][u.start.rowIndex + i][u.start.columnIndex + j] = v.numberValue ?? v.boolValue ?? v.stringValue ?? '';
      }));
    }
    // Payment lookup formulas return empty values when no order is selected.
    for (const row of tables['Платежи']) if (!row[1]) {
      for (const c of [2, 3, 4, 5, 8, 9]) if (row[c]?.formula) row[c].value = '';
    }
    save();
    if (fault === 'lost-response') throw new Error('OFFLINE_ISSUE_RESPONSE_LOST');
    if (fault === 'readback') fs.writeFileSync(path.join(directory, 'refill-readback-failed'), 'workshop-qa-v1');
    return {};
  }
  if (!request.startsWith('?')) throw new Error('UNSUPPORTED_OFFLINE_REQUEST');
  this.lastSuccessAt = new Date().toISOString();
  return { spreadsheetId: 'offline-workshop', spreadsheetUrl: 'https://example.invalid/offline-workshop', sheets: names.map((title, sheetId) => ({
    properties: { title, sheetId, gridProperties: { rowCount: Math.max(1000, SHEETS_SCHEMA.sheets[title].lastRow), columnCount: 30 } },
    ...(title === 'Монтажи' ? { tables: [{ tableId: 'offline-installations', range: { sheetId, startRowIndex: 0, endRowIndex: 1001, startColumnIndex: 0, endColumnIndex: 10 } }] } : {}),
    data: [{ rowData: tables[title].map((row, r) => ({ values: row.map((value, c) => ({
      userEnteredValue: value?.formula ? { formulaValue: value.formula } : typeof value === 'number' ? { numberValue: value } : typeof value === 'boolean' ? { boolValue: value } : { stringValue: String(value ?? '') },
      effectiveValue: typeof calculated(value) === 'number' ? { numberValue: calculated(value) } : typeof calculated(value) === 'boolean' ? { boolValue: calculated(value) } : { stringValue: String(calculated(value) ?? '') },
      formattedValue: String(format(calculated(value) ?? '', c, r, title)),
    })) })) }],
  })) };
};
// Deny external networking even if a future code path bypasses the client mock.
globalThis.fetch = () => { throw new Error('NETWORK_DISABLED_IN_OFFLINE_SANDBOX'); };
if (process.env.QA_AVITO_FIXTURE === 'true') {
  const { avitoFixture } = await import('./avito-fixture.mjs');
  globalThis.fetch = (url, options) => avitoFixture(directory, url, options);
}
