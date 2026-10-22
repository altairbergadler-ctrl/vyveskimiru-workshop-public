import fs from 'node:fs';
import { GoogleSheetsClient } from './google-sheets.mjs';
const client = new GoogleSheetsClient({ credentialsFile: process.env.GOOGLE_CREDENTIALS_FILE,
  spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, timeoutMs: 120000 });
const snapshot = await client.request('?includeGridData=true');
if (!snapshot.sheets?.length) throw new Error('EMPTY_SHEETS_BACKUP');
fs.writeFileSync(process.argv[2], JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ backup: 'google', sheets: snapshot.sheets.length }));
