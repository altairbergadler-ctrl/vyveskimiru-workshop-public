import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { getTransaction, openDatabase } from './db.mjs';

function temporaryDatabase(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { directory, filename: path.join(directory, 'test.sqlite3') };
}

test('legacy databases gain the cash flag with a one-time account-based backfill', (t) => {
  const { directory, filename } = temporaryDatabase('finance-pwa-db-migration-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const legacy = new Database(filename);
  legacy.exec(`
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, date TEXT NOT NULL, category TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', amount INTEGER NOT NULL, account TEXT NOT NULL,
      order_number TEXT, counterparty TEXT, comment TEXT, source TEXT NOT NULL DEFAULT 'app',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, sheet_name TEXT,
      sheet_row INTEGER, sheet_hash TEXT, pending INTEGER NOT NULL DEFAULT 0,
      missing_count INTEGER NOT NULL DEFAULT 0, last_synced_at TEXT
    );
  `);
  const now = new Date().toISOString();
  const insert = legacy.prepare(`INSERT INTO transactions
    (id,type,date,category,description,amount,account,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  insert.run('cash-income', 'income', '2026-09-05', 'Доплата', 'Доплата', 1000, 'В кассе', now, now);
  insert.run('bank-income', 'income', '2026-09-05', 'Доплата', 'Доплата', 2000, 'Расчётный счёт', now, now);
  insert.run('cash-expense', 'expense', '2026-09-05', 'Прочее', 'Расход', 500, 'В кассе', now, now);
  legacy.close();

  const db = openDatabase(filename);
  assert.equal(getTransaction(db, 'cash-income').cashInRegister, true);
  assert.equal(getTransaction(db, 'bank-income').cashInRegister, false);
  assert.equal(getTransaction(db, 'cash-expense').cashInRegister, false);
  db.close();

  const reopened = openDatabase(filename);
  assert.equal(getTransaction(reopened, 'cash-income').cashInRegister, true);
  reopened.close();
});
