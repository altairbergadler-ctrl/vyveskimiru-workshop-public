// Run against qa/analytics-compact-preview.mjs --complete-expenses.
// All import responses below are intercepted; no external or business writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = 'work/validation/analytics-period';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  const errors = [], imports = [], unexpected = [];
  page.on('pageerror', e => errors.push(e.message));
  const first = page.waitForResponse(r => r.url().includes('/api/analytics/live?') && r.status() === 200);
  await page.goto('http://127.0.0.1:18398/open');
  const template = await (await first).json();
  await page.getByRole('heading', { name: 'Эффективность объявлений', exact: true }).waitFor();
  const to = template.period.to;
  const date = days => new Date(Date.parse(to) - days * 86400000).toISOString().slice(0, 10);
  const states = new Map();
  let rejection = 0, hold = null;
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/api/analytics/live') {
      const from = url.searchParams.get('from'), end = url.searchParams.get('to');
      const state = states.get(from) || 'ready';
      const report = structuredClone(template);
      report.period = { from, to: end, days: (Date.parse(end) - Date.parse(from)) / 86400000 + 1 };
      report.avito.jobs = [];
      report.avito.stale = false;
      if (state !== 'ready') report.avito.loadedAt = null;
      if (state === 'disabled') report.avito.enabled = false;
      if (['running', 'partial'].includes(state)) report.avito.jobs = [{ state, total: 67, done: 33, failed: state === 'partial' ? 1 : 0 }];
      if (state === 'ready') report.avito.jobs = [{ state: 'done', total: 67, done: 67, failed: 0 }];
      return route.fulfill({ json: report });
    }
    if (request.method() === 'POST' && url.pathname === '/api/analytics/avito/deep') {
      imports.push(request.postDataJSON());
      if (hold) await hold;
      return route.fulfill({ status: rejection || 202, json: rejection ? { error: 'Учебный отказ: повторите загрузку вручную.' } : { jobId: 'fictional-period', existing: false } });
    }
    if (!['GET', 'HEAD'].includes(request.method())) { unexpected.push(url.pathname); return route.abort(); }
    return route.continue();
  });
  await page.clock.install();
  async function select(from) {
    await page.getByLabel('Начало периода').fill(from);
    await page.getByLabel('Конец периода').fill(to);
    await page.getByRole('button', { name: 'Показать', exact: true }).click();
    await page.clock.runFor(10);
    await page.waitForFunction(() => !document.querySelector('.al-toolbar form button').disabled);
  }
  async function poll(ms = 15010) {
    const response = page.waitForResponse(r => r.url().includes('/api/analytics/live?'));
    await page.clock.runFor(ms);
    await response;
    await page.waitForFunction(() => !document.querySelector('.al-toolbar form button').disabled);
  }
  const crossMonth = new Date(Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, 0)).toISOString().slice(0, 10);
  states.set(crossMonth, 'missing');
  await select(crossMonth);
  assert.deepEqual(imports, [{ dateFrom: crossMonth, dateTo: to }]);
  await page.getByRole('status').filter({ hasText: 'Загружаем статистику Авито' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Авито обновляется…', exact: true }).isDisabled(), true);
  assert.equal(await page.getByText('Нажмите «Обновить данные».', { exact: false }).count(), 0);
  states.set(crossMonth, 'running');
  await poll();
  await page.getByText('Выполнено 49%.', { exact: false }).waitFor();
  for (const width of [1440, 384, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
    await page.screenshot({ path: `${out}/loading-${width}.png` });
  }
  states.set(crossMonth, 'ready');
  await poll();
  assert.equal(await page.getByRole('status').filter({ hasText: 'Загружаем статистику Авито' }).count(), 0);
  assert.equal(imports.length, 1);
  await select(crossMonth);
  assert.equal(imports.length, 1, 'Cached range must not trigger an import');
  // An existing job is polled rather than duplicated, including partial failure.
  const running = date(40);
  states.set(running, 'running');
  await select(running);
  assert.equal(imports.length, 1);
  states.set(running, 'partial');
  await poll();
  await page.getByText('Не все данные Авито удалось загрузить.', { exact: false }).waitFor();
  await poll(60010);
  assert.equal(imports.length, 1);
  states.set(running, 'running');
  await page.getByRole('button', { name: 'Обновить данные', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.al-toolbar form button').disabled);
  assert.equal(imports.length, 2, 'Manual retry must remain available');
  // A rejected automatic request is surfaced once, never retried by polling.
  const denied = date(45);
  states.set(denied, 'missing'); rejection = 429;
  await select(denied);
  await page.getByRole('alert').filter({ hasText: 'Учебный отказ' }).waitFor();
  assert.equal(imports.length, 3);
  await poll(60010);
  assert.equal(imports.length, 3);
  rejection = 0;
  const disabled = date(50);
  states.set(disabled, 'disabled');
  await select(disabled);
  assert.equal(imports.length, 3);
  // A slow response for the old range must not overwrite the new selection.
  const old = date(55), current = date(60);
  states.set(old, 'missing');
  let release;
  hold = new Promise(resolve => { release = resolve; });
  const oldResponse = page.waitForResponse(r => r.url().includes('/api/analytics/live?') && r.url().includes(old));
  const oldImport = page.waitForRequest(r => r.url().endsWith('/api/analytics/avito/deep') && r.method() === 'POST');
  await page.getByLabel('Начало периода').fill(old);
  await page.getByRole('button', { name: 'Показать', exact: true }).click();
  await page.clock.runFor(10);
  await oldResponse;
  await oldImport;
  // Keyboard submit while the old import is pending exercises cancellation.
  await page.getByLabel('Начало периода').fill(current);
  await page.locator('.al-toolbar form').evaluate(form => form.requestSubmit());
  await page.clock.runFor(10);
  await page.waitForFunction(() => !document.querySelector('.al-toolbar form button').disabled);
  release(); hold = null;
  await page.clock.runFor(100);
  assert.equal(await page.getByLabel('Начало периода').inputValue(), current);
  assert.equal(await page.getByRole('button', { name: 'Авито обновляется…', exact: true }).count(), 0);
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  fs.writeFileSync(`${out}/report.json`, JSON.stringify({ ok: true, crossMonth, imports, widths: [1440, 384, 320], errors, unexpected, scenarios: ['auto', 'cached', 'progress', 'completion', 'existing', 'partial', 'manual-retry', '429-no-loop', 'disabled', 'stale-response'] }, null, 2));
  console.log('Period loading scenarios passed; no JS errors or business writes.');
} finally { await browser.close(); }
