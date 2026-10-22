import path from 'node:path';
import Database from 'better-sqlite3';
import { AvitoClient, AvitoError, avitoConfig } from './avito.mjs';

// Run inside the configured container. Output contains readiness/counters, never raw records.
let db, client;
try {
  const [action = 'identity', dateFrom, dateTo, extra] = process.argv.slice(2);
  if (!['identity', 'listings', 'statistics'].includes(action) || extra || (action !== 'statistics' && (dateFrom || dateTo))) throw new AvitoError('invalid', 400);
  const config = avitoConfig();
  if (!config.enabled) throw new AvitoError('disabled', 409);
  if (!process.env.DATA_DIR) throw new AvitoError('configuration');
  try { db = new Database(path.join(path.resolve(process.env.DATA_DIR), 'finance.sqlite3'), { fileMustExist: true }); }
  catch { throw new AvitoError('storage'); }
  client = new AvitoClient({ db, config });
  const value = action === 'identity' ? await client.checkConnection()
    : action === 'listings' ? await client.listings() : await client.statistics({ dateFrom, dateTo });
  console.log(JSON.stringify({ ok: true, action, accountVerified: Boolean(client.status().accountId),
    capabilities: client.status().capabilities, ...(value.items ? { rows: value.items.length, complete: value.complete, nextPage: value.nextPage } : {}),
    ...(value.groups ? { rows: value.groups.length, pagination: value.pagination, unreturnedMetrics: value.unreturnedMetrics } : {}) }));
} catch (error) {
  const safe = error instanceof AvitoError ? error : new AvitoError('unavailable');
  console.log(JSON.stringify({ ok: false, code: safe.code, error: safe.message, retryAfterSeconds: safe.retryAfterSeconds }));
  process.exitCode = 1;
} finally { client?.close(); db?.close(); }
