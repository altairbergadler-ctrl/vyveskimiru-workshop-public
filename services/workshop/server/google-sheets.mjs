import { GoogleSheetsClient as SharedClient } from './sheets-client.mjs';
export { a1, SheetsError } from './sheets-client.mjs';

// Preserve locale-aware finance commands while orders explicitly use RAW.
export class GoogleSheetsClient extends SharedClient {
  updateValues(data, options = {}) {
    return super.updateValues(data, { valueInputOption: 'USER_ENTERED', ...options });
  }
}
