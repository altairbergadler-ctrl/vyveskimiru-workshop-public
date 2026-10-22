// Operator check: use a disposable archive copy, never migrate the running database.
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { AvitoDeepAnalytics } from '../server/analytics/avito-deep.mjs';

const directory = fs.mkdtempSync(path.join(process.env.DATA_DIR, 'analytics-performance-'));
const source = new Database(path.join(process.env.DATA_DIR, 'analytics.sqlite3'), { readonly: true });
try {
  await source.backup(path.join(directory, 'archive.sqlite3'));
  const db = new Database(path.join(directory, 'archive.sqlite3'));
  try {
    const account = db.prepare('SELECT account FROM ad_runs ORDER BY created_at DESC LIMIT 1').get().account;
    const deep = new AvitoDeepAnalytics({
      base: { storage: () => db, namespace: () => account },
      client: { status: () => ({ enabled: true }) },
      scheduler: false, automatic: false,
    });
    let start = performance.now();
    deep.db();
    console.log(JSON.stringify({ indexesMs: Math.round(performance.now() - start) }));
    const today = new Date().toISOString().slice(0, 10);
    for (const dateTo of [today, new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10)]) {
      start = performance.now();
      const report = deep.view({ dateFrom: today.slice(0, 7) + '-01', dateTo });
      console.log(JSON.stringify({ viewMs: Math.round(performance.now() - start), rows: report.rows.length, jobs: report.jobs.length }));
    }
    const newIds = db.prepare("SELECT MAX(id) id FROM ad_item_versions WHERE account=? AND kind IN ('inventory','services','info') GROUP BY item_id,kind").all(account).map(r => r.id).sort((a, b) => a - b);
    const oldIds = db.prepare("SELECT id FROM (SELECT id,ROW_NUMBER() OVER(PARTITION BY item_id,kind ORDER BY id DESC) rank FROM ad_item_versions WHERE account=? AND kind IN ('inventory','services','info')) WHERE rank=1").all(account).map(r => r.id).sort((a, b) => a - b);
    assert.deepEqual(newIds, oldIds);
    console.log(JSON.stringify({ latestVersionParity: true, selectedVersions: newIds.length, productionArchiveReadOnly: true }));
  } finally { db.close(); }
} finally {
  source.close();
  fs.rmSync(directory, { recursive: true });
}
