// Temporary, journaled fixture alignment on the one allowlisted Google copy.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { GoogleSheetsClient } from '../server/sheets-client.mjs';
import { SHEETS_SCHEMA, expectedFormula } from '../server/sheets-guard.mjs';
import { assertTestSheet, assertOwned } from './safety.mjs';

const spreadsheetId = assertTestSheet(process.env.GOOGLE_SPREADSHEET_ID, process.env.QA_CONFIRM_SHEET);
const directory = assertOwned(process.env.QA_DIRECTORY);
const file = path.join(directory, 'contract-copy-formulas.json');
if (process.argv[2] === 'restore' && !fs.existsSync(file)) process.exit(0);
const client = new GoogleSheetsClient({ spreadsheetId, credentialsFile: process.env.GOOGLE_CREDENTIALS_FILE });
const range = "'Заказы'!M2:M301";
const expected = Array.from({ length: 300 }, (_, i) => [expectedFormula(SHEETS_SCHEMA.sheets['Заказы'], 'M', i + 2)]);
const current = (await client.getRanges([range], { valueRenderOption: 'FORMULA' })).valueRanges[0].values;
async function write(values) {
  const metadata = await client.getSpreadsheet();
  const sheet = metadata.sheets.find(s => s.properties.title === 'Заказы');
  await client.batchUpdate([{ updateCells: { start: { sheetId: sheet.properties.sheetId, rowIndex: 1, columnIndex: 12 }, fields: 'userEnteredValue', rows: values.map(([formulaValue]) => ({ values: [{ userEnteredValue: { formulaValue } }] })) } }]);
  const after = (await client.getRanges([range], { valueRenderOption: 'FORMULA' })).valueRanges[0].values;
  assert.deepEqual(after, values);
}
if (process.argv[2] === 'prepare') {
  assert.ok(!fs.existsSync(file), 'alignment journal already exists');
  assert.equal(current.length, 300);
  current.forEach(([value], i) => assert.ok(value === expected[i][0] || value === expected[i][0].replaceAll('$498', '$497'), 'unexpected test-copy formula; no overwrite'));
  fs.writeFileSync(file, JSON.stringify({ spreadsheetId, range, originals: current, expected }), { flag: 'wx' });
  await write(expected);
  console.log('Test-copy formula fixture aligned; originals journaled.');
} else if (process.argv[2] === 'restore') {
  if (fs.existsSync(file)) {
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(journal.spreadsheetId, spreadsheetId); assert.equal(journal.range, range);
    assert.ok(JSON.stringify(current) === JSON.stringify(journal.expected) || JSON.stringify(current) === JSON.stringify(journal.originals), 'copy changed externally; restore stopped');
    await write(journal.originals);
    console.log('Original test-copy formulas restored and verified.');
  }
} else throw new Error('Use prepare or restore');
