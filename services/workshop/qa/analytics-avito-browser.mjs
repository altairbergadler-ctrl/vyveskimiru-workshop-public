import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createDirectory, launch, removeDirectory, root } from './sandbox-lib.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const directory = createDirectory('avito-browser-');
const out = path.join(root, 'work/validation/avito'); fs.mkdirSync(out, { recursive: true });
let instance, browser; const errors = [], checks = [];
try {
  instance = await launch(directory, { avito: true });
  const before = fs.readFileSync(path.join(directory, 'sheet.json'), 'utf8');
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.addCookies([{ name: 'finance_session', value: instance.token, url: instance.base, httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(instance.base + '/#analytics');
  await page.getByRole('navigation', { name: 'Разделы аналитики' }).getByRole('button', { name: 'Источники', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Отчёт Авито' });
  await page.getByText('Краткая сводка кабинета', { exact: true }).click();
  await panel.getByRole('button', { name: 'Загрузить из Авито', exact: true }).click();
  await panel.locator('[data-avito-metric="views"]').waitFor();
  assert.equal(await panel.locator('[data-avito-metric="views"] strong').innerText(), '0');
  assert.equal(await panel.locator('[data-avito-metric="contacts"] strong').innerText(), '—');
  assert.match(await panel.locator('[data-avito-metric="spending"] strong').innerText(), /^50(?:,00)?\s*₽$/);
  assert.equal(await panel.getByRole('button', { name: /Обновление через/ }).isDisabled(), true);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 384, height: 832 }]) {
    await page.setViewportSize(viewport); await panel.scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await panel.screenshot({ path: path.join(out, `report-${viewport.width}.png`) });
    checks.push(`report ${viewport.width}px, no overflow`);
  }
  const downloadPromise = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'CSV Авито', exact: true }).click();
  const file = path.join(out, 'fictional-avito.csv'); await (await downloadPromise).saveAs(file);
  const csv = fs.readFileSync(file, 'utf8'); assert.ok(csv.includes('"Расходы деньгами";"50";"RUB"'));
  checks.push('CSV stores RUB once, missing and zero distinguished');
  // A failed refresh must preserve the old successful timestamp and mark its data stale.
  await page.route('**/api/analytics/avito**', async route => {
    if (route.request().method() === 'POST') return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Для этого метода Авито нет доступа.', code: 'forbidden' }) });
    const response = await route.fetch(), value = await response.json(); value.retryAfterSeconds = 0;
    return route.fulfill({ response, json: value });
  });
  await panel.getByRole('button', { name: 'Показать Авито', exact: true }).click();
  await panel.getByRole('button', { name: 'Загрузить из Авито', exact: true }).click();
  await panel.getByRole('alert').waitFor();
  assert.equal(await panel.locator('[data-avito-metric="views"] strong').innerText(), '0');
  await panel.getByText('Сохранённый отчёт', { exact: true }).waitFor();
  checks.push('failed refresh preserves report and marks stale');
  await page.unroute('**/api/analytics/avito**');
  await panel.getByLabel('Авито: начало периода').fill('2026-01-01');
  await panel.getByRole('button', { name: 'Показать Авито', exact: true }).click();
  await panel.getByRole('alert').waitFor();
  assert.equal(await panel.locator('[data-avito-metric]').count(), 0);
  checks.push('invalid period hides previous report');
  assert.equal(fs.readFileSync(path.join(directory, 'sheet.json'), 'utf8'), before);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ ok: true, checks, noSheetWrites: true, errors }, null, 2));
  console.log(JSON.stringify({ ok: true, checks, noSheetWrites: true, errors }));
} finally { await browser?.close(); await instance?.stop(); removeDirectory(directory); }
