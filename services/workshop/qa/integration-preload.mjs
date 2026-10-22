import { assertTestSheet, assertOwned } from './safety.mjs';
assertTestSheet(process.env.GOOGLE_SPREADSHEET_ID, process.env.QA_CONFIRM_SHEET);
assertOwned(process.env.QA_DIRECTORY || '');
if (!process.env.DATA_DIR?.startsWith(process.env.QA_DIRECTORY + '/')) throw new Error('INTEGRATION_DATA_NOT_ISOLATED');
