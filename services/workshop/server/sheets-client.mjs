import crypto from 'node:crypto';
import fs from 'node:fs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_URL = 'https://sheets.googleapis.com/v4/spreadsheets/';

export class SheetsError extends Error {
  constructor(code, message, statusCode = 502) {
    super(message);
    this.name = 'SheetsError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function a1(sheetName, cellRange) {
  return `'${String(sheetName).replaceAll("'", "''")}'!${cellRange}`;
}

export class GoogleSheetsClient {
  constructor({ credentialsFile, spreadsheetId, timeoutMs = 20_000 }) {
    this.credentialsFile = credentialsFile;
    this.spreadsheetId = spreadsheetId;
    this.timeoutMs = timeoutMs;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.tokenRequest = null;
  }

  get configured() {
    try {
      const credentials = JSON.parse(fs.readFileSync(this.credentialsFile, 'utf8'));
      return Boolean(this.spreadsheetId && credentials.client_email && credentials.private_key);
    } catch {
      return false;
    }
  }

  async fetchJson(url, options, context) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) {
        if (response.status === 429) throw new SheetsError('SHEETS_BUSY', 'Google Таблицы временно ограничили запросы. Повторите чуть позже.', 503);
        const error = new SheetsError(context === 'auth' ? 'SHEETS_AUTH' : 'SHEETS_UNAVAILABLE',
          context === 'auth' ? 'Не удалось подключиться к Google Таблицам.' : 'Не удалось выполнить запрос к Google Таблицам.');
        error.httpStatus = response.status;
        throw error;
      }
      return response.status === 204 ? null : await response.json();
    } catch (error) {
      if (error instanceof SheetsError) throw error;
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new SheetsError('SHEETS_TIMEOUT', 'Google Таблицы не ответили вовремя. Обновите доску перед повторной попыткой.', 504);
      }
      // Never relay response bodies, OAuth assertions, credentials, URLs or network internals.
      throw new SheetsError('SHEETS_UNAVAILABLE', 'Не удалось связаться с Google Таблицами.');
    }
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 300_000) return this.token;
    if (this.tokenRequest) return this.tokenRequest;
    this.tokenRequest = this.createAccessToken();
    try {
      return await this.tokenRequest;
    } finally {
      this.tokenRequest = null;
    }
  }

  async createAccessToken() {
    let credentials;
    let assertion;
    try {
      credentials = JSON.parse(fs.readFileSync(this.credentialsFile, 'utf8'));
      if (!credentials.client_email || !credentials.private_key || !this.spreadsheetId) throw new Error();
      const now = Math.floor(Date.now() / 1000);
      const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
      const unsigned = `${encoded({ alg: 'RS256', typ: 'JWT' })}.${encoded({
        iss: credentials.client_email,
        scope: 'https://www.googleapis.com/auth/spreadsheets',
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600,
      })}`;
      assertion = `${unsigned}.${crypto.sign('RSA-SHA256', Buffer.from(unsigned), credentials.private_key).toString('base64url')}`;
    } catch {
      throw new SheetsError('SHEETS_NOT_CONFIGURED', 'Подключение к Google Таблицам ещё не настроено.', 503);
    }
    const result = await this.fetchJson(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    }, 'auth');
    if (!result?.access_token) throw new SheetsError('SHEETS_AUTH', 'Не удалось подключиться к Google Таблицам.');
    this.token = result.access_token;
    this.tokenExpiresAt = Date.now() + Number(result.expires_in ?? 3600) * 1000;
    return this.token;
  }

  async request(path, options = {}) {
    try {
      const token = await this.accessToken();
      const value = await this.fetchJson(`${API_URL}${encodeURIComponent(this.spreadsheetId)}${path}`, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      }, 'sheets');
      this.lastSuccessAt = new Date().toISOString();
      this.lastError = null;
      return value;
    } catch (error) {
      this.lastError = { code: error.code || 'SHEETS_UNAVAILABLE', at: new Date().toISOString() };
      throw error;
    }
  }

  getSpreadsheet() {
    return this.request('?fields=spreadsheetId,spreadsheetUrl,sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))');
  }

  getValues(sheetName, range, { valueRenderOption = 'FORMATTED_VALUE' } = {}) {
    const dateTimeRenderOption = valueRenderOption === 'FORMATTED_VALUE' ? 'FORMATTED_STRING' : 'SERIAL_NUMBER';
    return this.request(`/values/${encodeURIComponent(a1(sheetName, range))}?valueRenderOption=${valueRenderOption}&dateTimeRenderOption=${dateTimeRenderOption}`);
  }

  getRanges(ranges, { valueRenderOption = 'FORMATTED_VALUE' } = {}) {
    const parameters = new URLSearchParams({ valueRenderOption, dateTimeRenderOption: valueRenderOption === 'FORMATTED_VALUE' ? 'FORMATTED_STRING' : 'SERIAL_NUMBER' });
    for (const range of ranges) parameters.append('ranges', range);
    return this.request(`/values:batchGet?${parameters}`);
  }

  updateValues(data, { valueInputOption = 'RAW' } = {}) {
    return this.request('/values:batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ valueInputOption, data }),
    });
  }

  batchUpdate(requests) {
    return this.request(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests }) });
  }

  appendValues(sheetName, range, values) {
    return this.request(`/values/${encodeURIComponent(a1(sheetName, range))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: 'POST', body: JSON.stringify({ majorDimension: 'ROWS', values }),
    });
  }
}

export function createSheetsClient(options) {
  return new GoogleSheetsClient(options);
}
