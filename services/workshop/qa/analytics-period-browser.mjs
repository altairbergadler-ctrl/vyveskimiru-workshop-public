// Run after qa/analytics-compact-preview.mjs --complete-expenses (fictional backend).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = 'work/validation/period-completeness';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  const errors = [], writes = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (!['GET', 'HEAD'].includes(r.method())) writes.push(r.method()); });
  const response = page.waitForResponse(r => r.url().includes('/api/analytics/live?') && r.status() === 200);
  await page.goto('http://127.0.0.1:18398/open');
  const report = await (await response).json();
  assert.equal(report.summary.spendComplete, true);
  assert.equal(report.avito.reported, 2);
  assert.equal(report.avito.inventory, 26);
  assert.equal(report.summary.result, report.summary.profit - report.summary.spend);
  assert(report.rows.slice(2).every(r => r.spend === null));
  assert(report.rows.every(r => r.receipts === null));
  const money = n => n.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ₽';
  const kpis = page.locator('.ac-kpis');
  await kpis.getByText('Полный отчёт за период', { exact: true }).waitFor();
  const profit = kpis.locator(':scope > div').filter({ has: page.getByText('Прибыль после рекламы', { exact: true }) });
  assert.equal(await profit.locator('strong').textContent(), money(report.summary.result));
  for (const width of [1440, 384, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
    await kpis.screenshot({ path: `${out}/kpis-${width}.png` });
  }
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  fs.writeFileSync(`${out}/browser.json`, JSON.stringify({ ok: true, widths: [1440, 384, 320],
    spendComplete: true, summary: report.summary, missingAdCostsRemainNull: true, writes, errors }, null, 2));
  console.log('Period completeness UI passed on desktop and mobile; no writes or JS errors.');
} finally { await browser.close(); }
