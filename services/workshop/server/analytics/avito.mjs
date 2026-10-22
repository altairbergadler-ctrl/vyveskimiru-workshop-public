import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';
import { AvitoError, validateAvitoReport } from '../avito.mjs';

const TTL = 6 * 60 * 60_000;
// Only validated provider projections; no tokens, profile details, Sheets rows or business writers.
export class AvitoAnalytics {
  constructor({
    client,
    directory,
    now = Date.now,
    automatic = process.env.AVITO_AUTO_IMPORT === 'true',
  }) {
    this.client = client;
    this.filename = path.join(directory, 'analytics.sqlite3');
    this.now = now;
    this.account = process.env.AVITO_ACCOUNT_ID || '';
    this.automatic = automatic && client.status().enabled;
    this.db = null;
    this.flight = null;
    this.closed = false;
    if (this.automatic) {
      this.timer = setTimeout(() => this.tick(), 30_000);
      this.timer.unref();
    }
  }
  storage() {
    if (!this.db) {
      const db = new Database(this.filename);
      try {
        db.pragma('journal_mode = WAL');
        db.pragma('busy_timeout = 5000');
        db.exec(`CREATE TABLE IF NOT EXISTS provider_imports (
          id TEXT PRIMARY KEY, source TEXT NOT NULL, account_id TEXT NOT NULL,
          date_from TEXT NOT NULL, date_to TEXT NOT NULL, loaded_at TEXT NOT NULL,
          metric_version TEXT NOT NULL, payload_hash TEXT NOT NULL, payload TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS provider_import_period ON provider_imports(source,account_id,date_from,date_to,loaded_at);
          CREATE TABLE IF NOT EXISTS provider_attempts (
          id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, account_id TEXT NOT NULL,
          date_from TEXT NOT NULL, date_to TEXT NOT NULL, attempted_at TEXT NOT NULL,
          code TEXT, retry_at INTEGER);`);
        this.db = db;
      } catch (error) {
        db.close();
        throw error;
      }
    }
    return this.db;
  }
  namespace() {
    return this.account || this.client.status().accountId || '';
  }
  period(input) {
    return validateAvitoReport({ ...input, grouping: 'totals' }, this.now());
  }
  currentPeriod() {
    const dateTo = new Date(this.now()).toISOString().slice(0, 10);
    return { dateFrom: `${dateTo.slice(0, 8)}01`, dateTo };
  }
  view(input) {
    const status = this.client.status();
    const config = {
      enabled: status.enabled,
      configured: status.configured,
      automatic: this.automatic,
      busy: Boolean(this.flight),
      capabilities: status.capabilities,
      defaultPeriod: this.currentPeriod(),
      earliestDate: new Date(
        Math.floor(this.now() / 86400000) * 86400000 - 269 * 86400000,
      )
        .toISOString()
        .slice(0, 10),
    };
    const request = this.period(input);
    if (!status.enabled)
      return {
        ...config,
        state: 'not_connected',
        report: null,
        lastAttempt: null,
        retryAfterSeconds: 0,
      };
    const db = this.storage(),
      account = this.namespace();
    const row = db
      .prepare(
        "SELECT * FROM provider_imports WHERE source='avito' AND account_id=? AND date_from=? AND date_to=? ORDER BY loaded_at DESC,rowid DESC LIMIT 1",
      )
      .get(account, request.dateFrom, request.dateTo);
    const attempt = db
      .prepare(
        "SELECT attempted_at AS at,code,retry_at FROM provider_attempts WHERE source='avito' AND account_id=? AND date_from=? AND date_to=? ORDER BY id DESC LIMIT 1",
      )
      .get(account, request.dateFrom, request.dateTo);
    const retry = db
      .prepare(
        "SELECT MAX(retry_at) AS at FROM provider_attempts WHERE source='avito' AND account_id=?",
      )
      .get(account);
    const report = row
      ? {
          ...JSON.parse(row.payload),
          importId: row.id,
          payloadHash: row.payload_hash,
          metricVersion: row.metric_version,
        }
      : null;
    return {
      ...config,
      report,
      lastAttempt: attempt ? { at: attempt.at, code: attempt.code } : null,
      state: row
        ? attempt?.code || this.now() - Date.parse(row.loaded_at) >= TTL
          ? 'stale'
          : 'ready'
        : attempt?.code
          ? 'unavailable'
          : 'not_loaded',
      retryAfterSeconds: Math.max(
        0,
        Math.ceil(((retry?.at || 0) - this.now()) / 1000),
      ),
    };
  }
  async sync(input) {
    const request = this.period(input);
    if (this.closed) throw new AvitoError('closed');
    if (this.flight) throw new AvitoError('rate_limit', 429, 65);
    if (!this.client.status().enabled) throw new AvitoError('disabled', 409);
    const db = this.storage(); // fail before calling a provider if an import cannot be stored
    const before = this.view(input);
    if (before.retryAfterSeconds)
      throw new AvitoError('rate_limit', 429, before.retryAfterSeconds);
    const promise = (async () => {
      let code = null,
        wait = 65;
      try {
        const value = await this.client.statistics({
          dateFrom: request.dateFrom,
          dateTo: request.dateTo,
          grouping: 'totals',
        });
        const { accountId, ...report } = value;
        const payload = JSON.stringify(report);
        db.prepare(
          'INSERT INTO provider_imports(id,source,account_id,date_from,date_to,loaded_at,metric_version,payload_hash,payload) VALUES(?,?,?,?,?,?,?,?,?)',
        ).run(
          crypto.randomUUID(),
          'avito',
          accountId,
          request.dateFrom,
          request.dateTo,
          value.loadedAt,
          'avito-items-v2-totals-v1',
          crypto.createHash('sha256').update(payload).digest('hex'),
          payload,
        );
      } catch (error) {
        const safe =
          error instanceof AvitoError ? error : new AvitoError('storage');
        code = safe.code;
        wait = safe.retryAfterSeconds || 65;
        throw safe;
      } finally {
        db.prepare(
          'INSERT INTO provider_attempts(source,account_id,date_from,date_to,attempted_at,code,retry_at) VALUES(?,?,?,?,?,?,?)',
        ).run(
          'avito',
          this.namespace(),
          request.dateFrom,
          request.dateTo,
          new Date(this.now()).toISOString(),
          code,
          this.now() + wait * 1000,
        );
      }
    })();
    this.flight = promise;
    try {
      await promise;
    } finally {
      this.flight = null;
    }
    return this.view(input);
  }
  async tick() {
    if (this.closed) return;
    try {
      await this.sync(this.currentPeriod());
    } catch {
      /* persisted safe status; no provider errors in logs */
    }
    if (!this.closed) {
      this.timer = setTimeout(() => this.tick(), TTL);
      this.timer.unref();
    }
  }
  diagnostics() {
    try {
      const value = this.view(this.currentPeriod());
      return {
        enabled: value.enabled,
        state: value.state,
        automatic: value.automatic,
        loadedAt: value.report?.loadedAt || null,
        lastAttempt: value.lastAttempt,
      };
    } catch {
      return {
        enabled: this.client.status().enabled,
        state: 'unavailable',
        code: 'storage',
      };
    }
  }
  connection() {
    const value = this.diagnostics();
    return {
      state: !value.enabled
        ? 'not_connected'
        : value.state === 'ready'
          ? 'connected'
          : value.state,
      lastSuccessAt: value.loadedAt || null,
    };
  }
  async handle(request, response, url, json, body) {
    const headers = { 'Cache-Control': 'private, no-store' };
    if (!['GET', 'POST'].includes(request.method))
      return json(
        response,
        405,
        { error: 'Метод недоступен.' },
        { ...headers, Allow: 'GET, POST' },
      );
    try {
      let input;
      if (request.method === 'POST') {
        if (url.search) throw new AvitoError('invalid', 400);
        input = await body(request, 4096);
      } else {
        if (
          [...url.searchParams.keys()].some(
            (k) =>
              !['dateFrom', 'dateTo'].includes(k) ||
              url.searchParams.getAll(k).length !== 1,
          )
        )
          throw new AvitoError('invalid', 400);
        input = url.search
          ? Object.fromEntries(url.searchParams)
          : this.currentPeriod();
      }
      if (
        !input ||
        Object.keys(input).some((k) => !['dateFrom', 'dateTo'].includes(k))
      )
        throw new AvitoError('invalid', 400);
      const value =
        request.method === 'POST' ? await this.sync(input) : this.view(input);
      return json(response, 200, value, headers);
    } catch (error) {
      const safe =
        error instanceof AvitoError ? error : new AvitoError('storage');
      return json(
        response,
        safe.statusCode === 401 ? 502 : safe.statusCode,
        {
          error: safe.message,
          code: safe.code,
          retryAfterSeconds: safe.retryAfterSeconds,
        },
        {
          ...headers,
          ...(safe.retryAfterSeconds
            ? { 'Retry-After': String(safe.retryAfterSeconds) }
            : {}),
        },
      );
    }
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    // The client is aborted by the host; let its final attempt commit before closing storage.
    if (this.flight)
      void this.flight.catch(() => {}).finally(() => this.db?.close());
    else this.db?.close();
  }
}
