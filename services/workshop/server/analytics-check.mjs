import crypto from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from './db.mjs';
import { FinanceSheetStore } from './finance-sheet.mjs';
import { GoogleSheetsClient } from './google-sheets.mjs';
import { readBoard } from '../modules/orders/server/orders.mjs';

// Operator acceptance: only bounded, authenticated reads and one expiring technical session.
// Source values/credentials never go to output; this command cannot write Google.
let sessionDb, scratch, tokenHash;
try {
  if (!process.env.DATA_DIR || !process.env.GOOGLE_CREDENTIALS_FILE)
    throw new Error('configuration');
  const base = `http://127.0.0.1:${Number(process.env.PORT || 3000)}`;
  sessionDb = new Database(path.join(process.env.DATA_DIR, 'finance.sqlite3'), {
    fileMustExist: true,
  });
  const token = crypto.randomBytes(32).toString('base64url');
  tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  sessionDb
    .prepare(
      'INSERT INTO sessions(token_hash,expires_at,created_at) VALUES(?,?,?)',
    )
    .run(
      tokenHash,
      new Date(Date.now() + 120000).toISOString(),
      new Date().toISOString(),
    );
  const response = await fetch(`${base}/api/analytics/overview?refresh=1`, {
    headers: { Cookie: `finance_session=${token}` },
    signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) throw new Error('report_http');
  const report = await response.json();
  const client = new GoogleSheetsClient({
    credentialsFile: process.env.GOOGLE_CREDENTIALS_FILE,
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
  });
  const request = client.request.bind(client);
  client.request = (route, options) => {
    if (
      (options?.method && options.method !== 'GET') ||
      !(route.startsWith('?') || route.startsWith('/values'))
    )
      throw new Error('write_forbidden');
    return request(route, options);
  };
  scratch = openDatabase(':memory:');
  const finance = new FinanceSheetStore({ client, db: scratch });
  const [snapshot, board] = await Promise.all([
    finance.snapshot(),
    readBoard(client),
  ]);
  if (snapshot.missingIds.length) throw new Error('finance_incomplete');
  const inside = (date) =>
    date >= report.period.from && date <= report.period.to;
  const operations = snapshot.records.filter((r) => inside(r.date));
  const cohort = board.orders.filter(
    (o) => inside(o.createdDate) && o.status !== 'Отменён',
  );
  const sum = (rows, key) =>
    rows.some((r) => typeof r[key] !== 'number')
      ? null
      : rows.reduce((n, row) => n + Math.round(row[key] * 100), 0) / 100;
  const parity = {
    income:
      report.overview.finance?.income ===
      sum(
        operations.filter((r) => r.type === 'income'),
        'amount',
      ),
    expense:
      report.overview.finance?.expense ===
      sum(
        operations.filter((r) => r.type === 'expense'),
        'amount',
      ),
    orderCount: report.overview.orders?.count === cohort.length,
    orderAmount: report.overview.orders?.amount === sum(cohort, 'amount'),
    orderProfit: report.overview.orders?.profit === sum(cohort, 'profit'),
  };
  const ready = report.sources.every((source) => source.state === 'ready');
  const disconnected = report.acquisition.connections.every((source) =>
    source.id === 'avito'
      ? process.env.AVITO_ENABLED === 'true'
        ? source.state !== 'not_connected'
        : source.state === 'not_connected'
      : source.state === 'not_connected',
  );
  const ok = ready && disconnected && Object.values(parity).every(Boolean);
  console.log(
    JSON.stringify({
      ok,
      metricVersion: report.metricVersion,
      sources: report.sources.map(({ id, state }) => ({ id, state })),
      parity,
      advertisingConfigurationMatched: disconnected,
      quality: report.quality.issues.map(({ code, count }) => ({
        code,
        count,
      })),
      noGoogleWrites: true,
    }),
  );
  if (!ok) process.exitCode = 1;
} catch {
  console.log(
    JSON.stringify({ ok: false, code: 'ANALYTICS_ACCEPTANCE_UNCONFIRMED' }),
  );
  process.exitCode = 1;
} finally {
  if (tokenHash && sessionDb)
    sessionDb.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash);
  sessionDb?.close();
  scratch?.close();
}
