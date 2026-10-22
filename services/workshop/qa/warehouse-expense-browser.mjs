import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fixtures } from './fixtures.mjs';
import { createDirectory, launch, removeDirectory, root } from './sandbox-lib.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.join(root, 'work', 'validation', 'warehouse-expense');
fs.mkdirSync(out, { recursive: true });
const directory = createDirectory('warehouse-expense-browser-');
const fixture = fixtures();
fixture['Склад'][1][4] = 9.99;
fixture['Склад'][1][2] = 'Вымышленный пластик с длинным названием для проверки узкого экрана '.repeat(3);
fixture['Заказы'][1][1] = 'Учебная вывеска с длинным названием заказа для проверки выбора '.repeat(4);
fs.writeFileSync(path.join(directory, 'sheet.json'), JSON.stringify(fixture));
let instance, browser;
const errors = [], posted = [];
try {
  instance = await launch(directory);
  browser = await chromium.launch({ executablePath: process.env.QA_BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.addCookies([{ name: 'finance_session', value: instance.token, url: instance.base }]);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/warehouse/issues')) posted.push(request.postDataJSON()); });
  // Order loading fails, yet an expense without an order stays available.
  await page.route('**/api/orders', route => route.fulfill({ status: 502, json: { error: 'Учебный сбой списка заказов' } }));
  async function fillForm(quantity) {
    await page.goto(instance.base + '/?action=expense');
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Со склада', exact: true }).click();
    await dialog.locator('#warehouse-material').fill('Вымышленный пластик');
    await page.getByRole('option').filter({ hasText: 'Вымышленный пластик' }).click();
    await dialog.locator('#warehouse-quantity').fill(quantity);
    assert.equal(await dialog.locator('#warehouse-order').inputValue(), '');
    assert.equal(await dialog.locator('#warehouse-order').getAttribute('required'), null);
    return dialog;
  }
  let dialog = await fillForm('0.25');
  await dialog.getByText('Расход из кассы: 3 ₽', { exact: false }).waitFor();
  await dialog.getByRole('button', { name: 'Списать со склада', exact: true }).isEnabled().then(assert.ok);
  for (const width of [1440, 384, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 832 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    await page.screenshot({ path: path.join(out, `warehouse-${width}.png`), animations: 'disabled' });
  }
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/warehouse/issues') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Списать со склада', exact: true }).click();
  const response = await responsePromise, result = await response.json();
  assert.equal(response.status(), 201, JSON.stringify(result));
  assert.equal(result.transaction.amount, 3);
  assert.equal(result.transaction.orderNumber, null);
  assert.equal(result.transaction.account, 'В кассе');
  await dialog.waitFor({ state: 'hidden' });
  await page.reload();
  const list = await page.evaluate(async () => (await fetch('/api/transactions')).json());
  assert.equal(list.transactions.filter(row => row.id === result.transaction.id).length, 1);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('finance-command:warehouse-expense')), null);

  // Drop the HTTP response after the actual local backend has committed both rows.
  await page.route('**/api/warehouse/issues', async route => { await route.fetch(); await route.abort('connectionfailed'); });
  dialog = await fillForm('0.05');
  await dialog.getByText('Расход из кассы: 1 ₽', { exact: false }).waitFor();
  await dialog.getByRole('button', { name: 'Списать со склада', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: 'Failed to fetch' }).waitFor();
  const pendingId = posted.at(-1).requestId;
  await page.unroute('**/api/warehouse/issues');
  dialog = await fillForm('0.05');
  const retryPromise = page.waitForResponse(response => response.url().endsWith('/api/warehouse/issues') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Списать со склада', exact: true }).click();
  const retry = await (await retryPromise).json();
  assert.equal(retry.transaction.id, pendingId);
  assert.equal(posted.at(-1).requestId, pendingId);
  await dialog.waitFor({ state: 'hidden' });
  const sheet = JSON.parse(fs.readFileSync(path.join(directory, 'sheet.json'), 'utf8'));
  assert.equal(sheet['Движения склада'].filter(row => row[9] === `PWA:${pendingId}`).length, 1);
  assert.equal(sheet['Расходы'].filter(row => row[9] === pendingId).length, 1);

  await page.unroute('**/api/orders');
  await page.setViewportSize({ width: 1440, height: 1000 });
  dialog = await fillForm('1');
  await dialog.locator('#warehouse-order').selectOption('9001');
  await dialog.getByRole('button', { name: 'Списать со склада', exact: true }).isEnabled().then(assert.ok);
  for (const width of [384, 320]) {
    await page.setViewportSize({ width, height: 832 });
    assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    await page.screenshot({ path: path.join(out, `long-order-${width}.png`), animations: 'disabled' });
  }
  assert.deepEqual(errors, []);
  const report = { ok: true, viewports: [1440, 384, 320], consoleErrors: errors,
    checks: ['without order even when orders fail', 'cash amount and rounding match backend', 'cash expense persists after reload', 'lost response and reload retry writes once', 'optional order can still be selected', 'no viewport or dialog overflow'] };
  fs.writeFileSync(path.join(out, 'browser-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser?.close(); await instance?.stop(); removeDirectory(directory); }
