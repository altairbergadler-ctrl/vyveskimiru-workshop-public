import crypto from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
let db, hash, archive;
try {
  if (process.argv.slice(2).some(v => v !== '--load') || !process.env.DATA_DIR) throw new Error();
  db = new Database(path.join(process.env.DATA_DIR, 'finance.sqlite3'), { fileMustExist: true });
  const token = crypto.randomBytes(32).toString('base64url'); hash = crypto.createHash('sha256').update(token).digest('hex');
  db.prepare('INSERT INTO sessions(token_hash,expires_at,created_at) VALUES(?,?,?)').run(hash, new Date(Date.now() + 120000).toISOString(), new Date().toISOString());
  const base = `http://127.0.0.1:${Number(process.env.PORT || 3000)}`;
  const headers = { Cookie: `finance_session=${token}`, Origin: process.env.PUBLIC_ORIGIN, 'Content-Type': 'application/json' };
  let response = await fetch(base + '/api/analytics/avito', { headers });
  let view = await response.json();
  if (!view.report && process.argv.includes('--load')) {
    response = await fetch(base + '/api/analytics/avito', { method: 'POST', headers, body: JSON.stringify(view.defaultPeriod) });
    view = await response.json();
  }
  if (!response.ok || !view.report) {
    console.log(JSON.stringify({ ok: false, state: view.state, code: view.code || view.lastAttempt?.code || 'not_loaded', retryAfterSeconds: view.retryAfterSeconds }));
    process.exitCode = 1;
  } else {
    archive = new Database(path.join(process.env.DATA_DIR, 'analytics.sqlite3'), { readonly: true, fileMustExist: true });
    const row = archive.prepare('SELECT account_id,payload,payload_hash FROM provider_imports WHERE id=?').get(view.report.importId);
    const persisted = Boolean(row && crypto.createHash('sha256').update(row.payload).digest('hex') === row.payload_hash && row.payload_hash === view.report.payloadHash);
    const accountPinned = row?.account_id === process.env.AVITO_ACCOUNT_ID;
    const health = await fetch(base + '/api/health').then(r => r.json());
    const ok = persisted && accountPinned && view.state === 'ready' && health.status === 'ok';
    console.log(JSON.stringify({ ok, state: view.state, automatic: view.automatic, loadedAt: view.report.loadedAt,
      period: { from: view.report.dateFrom, to: view.report.dateTo }, metricVersion: view.report.metricVersion,
      availableMetrics: view.report.availableMetrics, unreturnedMetrics: view.report.unreturnedMetrics,
      rows: view.report.groups.length, persisted, accountPinned, health: health.status, businessWrites: false }));
    if (!ok) process.exitCode = 1;
  }
} catch { console.log(JSON.stringify({ ok: false, code: 'AVITO_ACCEPTANCE_UNCONFIRMED' })); process.exitCode = 1; }
finally { if (hash && db) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash); archive?.close(); db?.close(); }
