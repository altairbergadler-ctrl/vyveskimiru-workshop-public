import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const transactionColumns = `
  id, type, date, category, description, amount, account,
  cash_in_register AS cashInRegister,
  order_number AS orderNumber, counterparty, comment, source,
  created_at AS createdAt, updated_at AS updatedAt, deleted_at AS deletedAt,
  sheet_name AS sheetName, sheet_row AS sheetRow, sheet_hash AS sheetHash,
  pending, missing_count AS missingCount, last_synced_at AS lastSyncedAt, revision`;

export function openDatabase(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
      date TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      amount INTEGER NOT NULL CHECK (amount > 0),
      account TEXT NOT NULL,
      cash_in_register INTEGER NOT NULL DEFAULT 0 CHECK (cash_in_register IN (0, 1)),
      order_number TEXT,
      counterparty TEXT,
      comment TEXT,
      source TEXT NOT NULL DEFAULT 'app',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      sheet_name TEXT,
      sheet_row INTEGER,
      sheet_hash TEXT,
      pending INTEGER NOT NULL DEFAULT 0,
      missing_count INTEGER NOT NULL DEFAULT 0,
      last_synced_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_transactions_active ON transactions(deleted_at, type, date);
    CREATE TABLE IF NOT EXISTS transaction_history (
      history_id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_conflicts (
      conflict_id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id TEXT NOT NULL,
      app_snapshot_json TEXT NOT NULL,
      sheet_snapshot_json TEXT NOT NULL,
      resolution TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const transactionColumnNames = new Set(
    db.prepare('PRAGMA table_info(transactions)').all().map((column) => column.name),
  );
  if (!transactionColumnNames.has('cash_in_register')) {
    db.transaction(() => {
      db.exec(`ALTER TABLE transactions ADD COLUMN cash_in_register INTEGER NOT NULL DEFAULT 0
        CHECK (cash_in_register IN (0, 1))`);
      db.prepare(`UPDATE transactions SET cash_in_register = CASE
        WHEN type = 'income' AND account = 'В кассе' THEN 1 ELSE 0 END`).run();
    })();
  }
  if (!transactionColumnNames.has('revision')) {
    db.exec('ALTER TABLE transactions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
  }
  return db;
}

function normalizeTransaction(row) {
  return row ? { ...row, cashInRegister: Boolean(row.cashInRegister) } : null;
}

function rowById(db, id) {
  return normalizeTransaction(
    db.prepare(`SELECT ${transactionColumns} FROM transactions WHERE id = ?`).get(id),
  );
}

function snapshot(db, id, reason) {
  const current = rowById(db, id);
  if (!current) return;
  db.prepare(`INSERT INTO transaction_history (transaction_id, snapshot_json, reason, created_at)
    VALUES (?, ?, ?, ?)`).run(id, JSON.stringify(current), reason, new Date().toISOString());
}

export function bootstrapDatabase(db, rows) {
  const count = db.prepare('SELECT COUNT(*) AS count FROM transactions').get().count;
  if (count) return false;
  const now = new Date().toISOString();
  const insert = db.prepare(`INSERT INTO transactions (
    id, type, date, category, description, amount, account, cash_in_register, order_number,
    counterparty, comment, source, created_at, updated_at, sheet_name, sheet_row, pending
  ) VALUES (@id, @type, @date, @category, @description, @amount, @account, @cashInRegister, @orderNumber,
    @counterparty, @comment, @source, @createdAt, @updatedAt, @sheetName, @sheetRow, 0)`);
  db.transaction((items) => {
    for (const item of items) insert.run({
      ...item,
      cashInRegister: (item.cashInRegister ??
        (item.type === 'income' && item.account === 'В кассе')) ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    });
  })(rows);
  return true;
}

export function listTransactions(db) {
  return db.prepare(`SELECT ${transactionColumns} FROM transactions
    WHERE deleted_at IS NULL ORDER BY date DESC, created_at DESC`).all().map(normalizeTransaction);
}

export function getTransaction(db, id) {
  return rowById(db, id);
}

export function createTransaction(db, input) {
  const now = new Date().toISOString();
  const row = {
    ...input,
    cashInRegister: input.cashInRegister ? 1 : 0,
    id: crypto.randomUUID(),
    source: 'app',
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(`INSERT INTO transactions (
    id, type, date, category, description, amount, account, cash_in_register, order_number,
    counterparty, comment, source, created_at, updated_at, pending
  ) VALUES (@id, @type, @date, @category, @description, @amount, @account, @cashInRegister, @orderNumber,
    @counterparty, @comment, @source, @createdAt, @updatedAt, 1)`).run(row);
  return rowById(db, row.id);
}

export function updateTransaction(db, id, input) {
  if (!rowById(db, id)?.deletedAt) {
    snapshot(db, id, 'app_update');
    const result = db.prepare(`UPDATE transactions SET
      type=@type, date=@date, category=@category, description=@description, amount=@amount,
      account=@account, cash_in_register=@cashInRegister, order_number=@orderNumber,
      counterparty=@counterparty, comment=@comment,
      source='app', updated_at=@updatedAt, pending=1, missing_count=0, revision=revision+1
      WHERE id=@id AND deleted_at IS NULL`).run({
        ...input,
        cashInRegister: input.cashInRegister ? 1 : 0,
        id,
        updatedAt: new Date().toISOString(),
      });
    if (result.changes) return rowById(db, id);
  }
  return null;
}

export function deleteTransaction(db, id) {
  const current = rowById(db, id);
  if (!current || current.deletedAt) return false;
  snapshot(db, id, 'app_delete');
  const now = new Date().toISOString();
  db.prepare(`UPDATE transactions SET deleted_at=?, updated_at=?, source='app', pending=1, revision=revision+1 WHERE id=?`).run(now, now, id);
  return true;
}

export function listPending(db) {
  return db.prepare(`SELECT ${transactionColumns} FROM transactions WHERE pending = 1 ORDER BY updated_at`)
    .all().map(normalizeTransaction);
}

export function upsertFromSheet(db, item, sheetHash, sheetRow, detectedAt) {
  const existing = rowById(db, item.id);
  if (existing?.pending) {
    db.prepare(`INSERT INTO sync_conflicts
      (transaction_id, app_snapshot_json, sheet_snapshot_json, resolution, created_at)
      VALUES (?, ?, ?, 'sheet_wins_local_preserved', ?)`).run(item.id, JSON.stringify(existing), JSON.stringify(item), detectedAt);
  }
  if (existing) snapshot(db, item.id, 'sheet_update');
  db.prepare(`INSERT INTO transactions (
    id, type, date, category, description, amount, account, cash_in_register, order_number, counterparty,
    comment, source, created_at, updated_at, deleted_at, sheet_name, sheet_row, sheet_hash,
    pending, missing_count, last_synced_at
  ) VALUES (@id,@type,@date,@category,@description,@amount,@account,@cashInRegister,@orderNumber,@counterparty,
    @comment,'sheet',@createdAt,@updatedAt,NULL,@sheetName,@sheetRow,@sheetHash,0,0,@lastSyncedAt)
  ON CONFLICT(id) DO UPDATE SET
    type=excluded.type, date=excluded.date, category=excluded.category,
    description=excluded.description, amount=excluded.amount, account=excluded.account,
    cash_in_register=excluded.cash_in_register,
    order_number=excluded.order_number, counterparty=excluded.counterparty,
    comment=excluded.comment, source='sheet', updated_at=excluded.updated_at,
    deleted_at=NULL, sheet_name=excluded.sheet_name, sheet_row=excluded.sheet_row,
    sheet_hash=excluded.sheet_hash, pending=0, missing_count=0,
    last_synced_at=excluded.last_synced_at`).run({
      ...item,
      cashInRegister: (item.cashInRegister ??
        (item.type === 'income' && item.account === 'В кассе')) ? 1 : 0,
      createdAt: existing?.createdAt ?? detectedAt,
      updatedAt: detectedAt,
      sheetRow,
      sheetHash,
      lastSyncedAt: detectedAt,
    });
  return rowById(db, item.id);
}

export function touchSheetRow(db, id, sheetRow, sheetHash, syncedAt, clearPending = true, sheetName = null, expectedRevision = null) {
  // Acknowledgement belongs to the version that was sent, even if a newer edit
  // arrived in the same millisecond while the Google request was in flight.
  db.prepare(`UPDATE transactions SET sheet_row=?, sheet_hash=?,
    pending=CASE WHEN ?=1 AND (? IS NULL OR revision=?) THEN 0 ELSE pending END,
    sheet_name=COALESCE(?,sheet_name), missing_count=0, last_synced_at=? WHERE id=?`)
    .run(sheetRow, sheetHash, clearPending ? 1 : 0, expectedRevision, expectedRevision, sheetName, syncedAt, id);
}

export function markMissing(db, sheetName, presentIds, detectedAt) {
  const present = new Set(presentIds);
  const rows = db.prepare(`SELECT id, pending, missing_count AS missingCount FROM transactions
    WHERE sheet_name=? AND deleted_at IS NULL`).all(sheetName);
  for (const row of rows) {
    if (present.has(row.id) || row.pending) continue;
    const next = row.missingCount + 1;
    if (next >= 2) {
      snapshot(db, row.id, 'sheet_delete');
      db.prepare(`UPDATE transactions SET deleted_at=?, updated_at=?, source='sheet', pending=0,
        missing_count=? WHERE id=?`).run(detectedAt, detectedAt, next, row.id);
    } else {
      db.prepare('UPDATE transactions SET missing_count=? WHERE id=?').run(next, row.id);
    }
  }
}

export function setSyncState(db, key, value) {
  db.prepare(`INSERT INTO sync_state(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value));
}

export function syncStatus(db, configured) {
  const state = Object.fromEntries(db.prepare('SELECT key,value FROM sync_state').all().map((row) => [row.key, row.value]));
  const pending = db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE pending=1').get().count;
  const conflicts = db.prepare(`SELECT COUNT(*) AS count FROM sync_conflicts
    WHERE resolution IN ('pending', 'unresolved')`).get().count;
  const conflictHistory = db.prepare('SELECT COUNT(*) AS count FROM sync_conflicts').get().count;
  const { invalid_rows_count: invalidRowsRaw, ...publicState } = state;
  const invalidRows = Number(invalidRowsRaw || 0);
  return {
    configured,
    pending,
    conflicts,
    conflictHistory,
    invalidRows: Number.isFinite(invalidRows) ? invalidRows : 0,
    ...publicState,
  };
}

export function createSession(db, tokenHash, expiresAt) {
  const now = new Date().toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  db.prepare('INSERT INTO sessions(token_hash,expires_at,created_at) VALUES(?,?,?)').run(tokenHash, expiresAt, now);
}

export function hasSession(db, tokenHash) {
  return Boolean(db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?').get(tokenHash, new Date().toISOString()));
}

export function deleteSession(db, tokenHash) {
  db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash);
}
