import crypto from 'node:crypto';
import {
  getTransaction,
  listPending,
  markMissing,
  setSyncState,
  touchSheetRow,
  upsertFromSheet,
} from './db.mjs';
import { a1 } from './google-sheets.mjs';

import { SHEETS, text, amount, checked, isoDate, hashRecord, layoutFromHeaders, fromSheet, validationProblems, sheetConfig, columnName, recordValueUpdates } from './finance-contract.mjs';

export class SheetSynchronizer {
  constructor({ db, client, intervalMs = 60_000, logger = console }) {
    this.db = db;
    this.client = client;
    this.intervalMs = intervalMs;
    this.logger = logger;
    this.running = null;
    this.timer = null;
  }

  get configured() {
    return this.client.configured;
  }

  start() {
    if (!this.configured || this.timer) return;
    void this.run();
    this.timer = setInterval(() => void this.run(), this.intervalMs);
    this.timer.unref();
  }

  async run() {
    if (!this.configured) return { configured: false };
    if (this.running) return this.running;
    this.running = this.perform().finally(() => { this.running = null; });
    return this.running;
  }

  async perform() {
    const startedAt = new Date().toISOString();
    setSyncState(this.db, 'last_attempt_at', startedAt);
    try {
      const snapshots = new Map();
      const invalidRows = [];
      for (const config of SHEETS) {
        const response = await this.client.getValues(config.name, 'A1:Z1000');
        const [headers = [], ...rows] = response.values ?? [];
        const layout = layoutFromHeaders(config, headers);
        const presentIds = [];
        const rowMap = new Map();
        for (let index = 0; index < rows.length; index += 1) {
          const row = rows[index];
          const rowNumber = index + 2;
          const hasVisibleData = Boolean(text(row[layout.dateIndex]) ||
            text(row[layout.orderNumberIndex]) || text(row[layout.amountIndex]));
          if (!hasVisibleData) continue;
          let record = fromSheet(config, row, rowNumber, layout);
          const problems = validationProblems(record);
          if (record.id && rowMap.has(record.id)) problems.push('duplicate_sync_id');
          if (problems.length) {
            invalidRows.push({ sheet: config.name, row: rowNumber, problems });
            if (record.id && !rowMap.has(record.id)) {
              presentIds.push(record.id);
              rowMap.set(record.id, { rowNumber, hash: null });
            }
            continue;
          }
          if (!record.id) {
            record = { ...record, id: crypto.randomUUID() };
            const now = new Date().toISOString();
            await this.client.updateValues([
              { range: a1(config.name, `${columnName(layout.idIndex)}${rowNumber}`), values: [[record.id]] },
              { range: a1(config.name, `${columnName(layout.updatedIndex)}${rowNumber}`), values: [[now]] },
              { range: a1(config.name, `${columnName(layout.originIndex)}${rowNumber}`), values: [['sheet']] },
            ]);
          }
          const hash = hashRecord(record);
          presentIds.push(record.id);
          rowMap.set(record.id, { rowNumber, hash });
          const existing = getTransaction(this.db, record.id);
          if (existing?.pending && existing.deletedAt) continue;
          if (!existing || existing.sheetHash !== hash || existing.deletedAt) {
            upsertFromSheet(this.db, record, hash, rowNumber, new Date().toISOString());
          } else {
            touchSheetRow(this.db, record.id, rowNumber, hash, new Date().toISOString(), !existing.pending, config.name, existing.revision);
          }
        }
        markMissing(this.db, config.name, presentIds, new Date().toISOString());
        snapshots.set(config.name, { rows, rowMap, layout });
      }

      for (const pending of listPending(this.db)) {
        const config = sheetConfig(pending.type);
        const snapshot = snapshots.get(config.name);
        const located = snapshot.rowMap.get(pending.id);
        if (pending.deletedAt) {
          if (located) {
            await this.client.batchUpdate([{ deleteDimension: { range: {
              sheetId: config.sheetId,
              dimension: 'ROWS', startIndex: located.rowNumber - 1, endIndex: located.rowNumber,
            } } }]);
            snapshot.rows.splice(located.rowNumber - 2, 1);
            snapshot.rowMap.delete(pending.id);
            for (const [id, value] of snapshot.rowMap) {
              if (value.rowNumber > located.rowNumber) snapshot.rowMap.set(id, { ...value, rowNumber: value.rowNumber - 1 });
            }
          }
          touchSheetRow(this.db, pending.id, null, pending.sheetHash, new Date().toISOString(), true, config.name, pending.revision);
          continue;
        }
        let rowNumber = located?.rowNumber;
        if (!rowNumber) {
          const lastUsed = snapshot.rows.reduce((last, row, index) => {
            const hasData = text(row[snapshot.layout.dateIndex]) || text(row[snapshot.layout.amountIndex]);
            return hasData ? index + 2 : last;
          }, 1);
          rowNumber = lastUsed + 1;
          const templateRow = Math.max(2, lastUsed);
          await this.client.batchUpdate([{ copyPaste: {
            source: { sheetId: config.sheetId, startRowIndex: templateRow - 1, endRowIndex: templateRow, startColumnIndex: 0, endColumnIndex: snapshot.layout.width },
            destination: { sheetId: config.sheetId, startRowIndex: rowNumber - 1, endRowIndex: rowNumber, startColumnIndex: 0, endColumnIndex: snapshot.layout.width },
            pasteType: 'PASTE_NORMAL', pasteOrientation: 'NORMAL',
          } }]);
        }
        const syncTime = new Date().toISOString();
        await this.client.updateValues(recordValueUpdates(pending, rowNumber, syncTime, snapshot.layout));
        const hash = hashRecord(pending);
        touchSheetRow(this.db, pending.id, rowNumber, hash, syncTime, true, config.name, pending.revision);
        snapshot.rowMap.set(pending.id, { rowNumber, hash });
        const marker = [];
        marker[snapshot.layout.dateIndex] = pending.date;
        marker[snapshot.layout.amountIndex] = pending.amount;
        snapshot.rows[rowNumber - 2] = marker;
      }

      const finishedAt = new Date().toISOString();
      setSyncState(this.db, 'invalid_rows_count', invalidRows.length);
      setSyncState(this.db, 'last_success_at', finishedAt);
      setSyncState(this.db, 'last_error', '');
      return { configured: true, success: true, finishedAt, invalidRows: invalidRows.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSyncState(this.db, 'last_error', message.slice(0, 1000));
      this.logger.error('sheet-sync-failed', { message });
      return { configured: true, success: false, error: message };
    }
  }
}

export const syncInternals = { amount, checked, fromSheet, hashRecord, isoDate, layoutFromHeaders, validationProblems };
