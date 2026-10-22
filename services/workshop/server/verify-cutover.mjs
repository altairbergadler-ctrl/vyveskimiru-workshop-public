// Read-only business comparison. Run against a COPY of the legacy SQLite file.
import assert from 'node:assert/strict';
import { openDatabase, listTransactions } from './db.mjs';
import { GoogleSheetsClient } from './google-sheets.mjs';
import { FinanceSheetStore } from './finance-sheet.mjs';
import { hashRecord } from './finance-contract.mjs';

const db = openDatabase(process.env.VERIFY_DATABASE);
try {
  assert.equal(db.prepare('SELECT count(*) AS n FROM transactions WHERE pending=1').get().n, 0, 'Unsent commands exist');
  const client = new GoogleSheetsClient({ credentialsFile: process.env.GOOGLE_CREDENTIALS_FILE,
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, timeoutMs: 60000 });
  const current = await new FinanceSheetStore({ db, client }).snapshot();
  assert.equal(current.missingIds.length, 0, 'Missing IDs');
  const expected = listTransactions(db);
  const before = new Map(expected.map(r => [r.id, hashRecord(r)]));
  const after = new Map(current.records.map(r => [r.id, hashRecord(r)]));
  assert.equal(before.size, after.size, 'Record count mismatch');
  let mismatches = 0;
  for (const [id, hash] of before) if (after.get(id) !== hash) mismatches++;
  assert.equal(mismatches, 0, 'Business fields differ');
  console.log(JSON.stringify({ check: 'finance-business-parity', records: before.size, mismatches, pending: 0, missingIds: 0 }));
} finally { db.close(); }
