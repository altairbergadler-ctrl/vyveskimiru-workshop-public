import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createDirectory, launch, removeDirectory, root } from './sandbox-lib.mjs';
import { seedPaymentSafeguards } from './payment-safeguards-fixture.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const directory = createDirectory('payment-safeguards-browser-'); seedPaymentSafeguards(directory);
const out = path.join(root, 'work/validation/payment-safeguards'); fs.mkdirSync(out, { recursive: true });
let instance, browser;
const errors = [], checks = [];
try {
  instance = await launch(directory);
  browser = await chromium.launch({ executablePath: process.env.QA_BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.addCookies([{ name: 'finance_session', value: instance.token, url: instance.base, httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const request = async (route, method = 'GET', body) => {
    const response = await context.request.fetch(instance.base + route, { method,
      headers: { Origin: instance.base }, ...(body ? { data: body } : {}) });
    return { status: response.status(), data: await response.json() };
  };
  const count = async () => (await request('/api/transactions')).data.transactions.length;
  const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page overflow');
  const dialog = page.getByRole('dialog');
  await page.goto(instance.base + '/');
  await page.locator('.hw-grid > [data-widget-id]').first().waitFor();
  await page.evaluate(() => {
    const widgets = [...document.querySelectorAll('.hw-grid > [data-widget-id]')].map(element =>
      ({ id: element.dataset.widgetId, kind: element.dataset.widgetKind }));
    localStorage.setItem('workshop.home.widgets.v1.desktop', JSON.stringify({ version: 1, widgets: [...widgets, { id: 'qa-finance-refresh', kind: 'cashflow' }] }));
  });
  await page.reload();
  await page.clock.install();
  await page.getByRole('button', { name: 'Добавить доход', exact: true }).first().click();
  await dialog.locator('#orderNumber option[value="9006"]').waitFor({ state: 'attached' });
  assert.deepEqual(await dialog.locator('#orderNumber option').evaluateAll(options => options.map(o => o.value).filter(Boolean)), ['9001', '9006']);
  await page.screenshot({ path: path.join(out, 'payment-desktop.png') });
  const initial = await count();
  await dialog.locator('#orderNumber').selectOption('9001');
  await dialog.locator('#date').fill('2026-09-06');
  await dialog.locator('#amount').fill('3000');
  const posts = [];
  page.on('request', r => { if (r.url().endsWith('/api/transactions') && r.method() === 'POST') posts.push(r.postDataJSON()); });
  await dialog.getByRole('button', { name: 'Записать оплату', exact: true }).click();
  await dialog.getByText('Возможно, эта операция уже внесена').waitFor();
  assert.equal(await count(), initial);
  assert.ok(await dialog.getByRole('button', { name: 'Записать оплату', exact: true }).isDisabled());
  await page.screenshot({ path: path.join(out, 'duplicate-income-desktop.png') });
  await page.setViewportSize({ width: 384, height: 832 });
  await noOverflow();
  await dialog.getByRole('button', { name: 'Сохранить отдельной операцией', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(out, 'duplicate-income-mobile.png') });
  // Simulate a response lost after the actual backend commit, then retry the same UI command.
  let dropped = false;
  await page.route('**/api/transactions', async route => {
    const r = route.request();
    if (!dropped && r.method() === 'POST' && r.postDataJSON().duplicateConfirmation) {
      const response = await route.fetch(); assert.equal(response.status(), 201);
      dropped = true; await route.abort('failed');
    } else await route.continue();
  });
  await dialog.getByRole('button', { name: 'Сохранить отдельной операцией', exact: true }).click();
  await dialog.getByText('Failed to fetch', { exact: true }).waitFor();
  assert.equal(await count(), initial + 1);
  // The order becomes fully paid while the unanswered form is still open.
  await page.route('**/api/orders', async route => {
    const response = await route.fetch(), data = await response.json();
    const order = data.orders.find(item => item.number === '9001');
    order.debt = 0; order.paid = order.total;
    await route.fulfill({ response, json: data });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const refreshedOrders = page.waitForResponse(response => response.url().endsWith('/api/orders'));
  await page.clock.fastForward(61_000); await refreshedOrders;
  assert.equal(await dialog.locator('#orderNumber').inputValue(), '9001');
  await dialog.getByRole('button', { name: 'Сохранить отдельной операцией', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await count(), initial + 1);
  assert.equal(new Set(posts.map(p => p.requestId)).size, 1);
  await page.unroute('**/api/transactions');
  await page.unroute('**/api/orders');
  await page.clock.resume();
  checks.push('income warning on desktop/mobile; no write before acknowledgement; lost-response replay after settlement and background refresh creates one record');

  await page.setViewportSize({ width: 384, height: 832 });
  await page.getByRole('button', { name: 'Расход', exact: true }).last().click();
  await dialog.locator('#date').fill('2026-09-06');
  await dialog.locator('#amount').fill('500');
  await dialog.locator('#expense-category').fill('Прочее');
  await page.getByRole('option', { name: 'Прочее', exact: true }).click();
  await dialog.locator('#description').fill('Повторная учебная покупка');
  await dialog.getByRole('button', { name: 'Сохранить расход', exact: true }).click();
  await dialog.getByText('Возможно, эта операция уже внесена').waitFor();
  assert.equal(await count(), initial + 1);
  await page.screenshot({ path: path.join(out, 'duplicate-expense-mobile.png') });
  await dialog.getByRole('button', { name: 'Вернуться к проверке', exact: true }).click();
  await dialog.locator('#amount').fill('501');
  await dialog.getByRole('button', { name: 'Сохранить расход', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await count(), initial + 2);
  checks.push('expense warning preserves draft and allows correcting the amount');

  // A paid order still appears when maintaining its existing payment, using a read-only UI fixture.
  await page.route('**/api/orders', async route => {
    const response = await route.fetch(), data = await response.json();
    data.orders.find(order => order.number === '9001').debt = 0;
    await route.fulfill({ response, json: data });
  });
  await page.reload();
  await page.getByRole('button', { name: 'Добавить доход', exact: true }).first().click();
  await dialog.locator('#orderNumber option[value="9006"]').waitFor({ state: 'attached' });
  assert.equal(await dialog.locator('#orderNumber option[value="9001"]').count(), 0);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const historical = page.getByRole('row').filter({ hasText: 'Предоплата' }).first();
  await historical.getByRole('button', { name: /^Редактировать/ }).click();
  assert.equal(await dialog.locator('#orderNumber').inputValue(), '9001');
  await page.keyboard.press('Escape');
  await page.unroute('**/api/orders');
  checks.push('settled orders hidden from new payments, existing payment retains its order');

  // Every action uses the actual widget UI and persisted device-specific layout.
  for (const [profile, width, height] of [['desktop', 1440, 1000], ['mobile', 384, 832]]) {
    await page.setViewportSize({ width, height });
    await page.reload();
    const cards = page.locator('.hw-grid > [data-widget-id]');
    await cards.first().waitFor();
    const originalCount = await cards.count();
    const firstId = await cards.first().getAttribute('data-widget-id');
    await cards.first().getByRole('button', { name: /^Убрать с главной:/ }).click();
    assert.equal(await cards.count(), originalCount - 1);
    await page.getByRole('button', { name: 'Отменить последнее', exact: true }).click();
    assert.equal(await cards.count(), originalCount);
    assert.equal(await cards.first().getAttribute('data-widget-id'), firstId);
    await cards.first().getByRole('button', { name: /^Настройки:/ }).click();
    await dialog.getByRole('button', { name: 'Убрать с главной', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.reload(); await cards.first().waitFor();
    assert.equal(await cards.count(), originalCount - 1);
    await page.locator('.widget-workspace').scrollIntoViewIfNeeded();
    await noOverflow();
    await page.screenshot({ path: path.join(out, `widgets-${profile}.png`) });
    while (await cards.count()) await cards.first().getByRole('button', { name: /^Убрать с главной:/ }).click();
    await page.reload();
    await page.locator('.hw-empty-dashboard').waitFor();
    assert.equal(await cards.count(), 0);
    await page.getByRole('button', { name: 'Добавить виджет', exact: true }).first().click();
    await dialog.getByRole('button', { name: /^Добавить:/ }).first().click();
    await dialog.getByRole('button', { name: 'Готово', exact: true }).click();
    assert.equal(await cards.count(), 1);
    await page.reload(); await cards.first().waitFor(); assert.equal(await cards.count(), 1);
    checks.push(`${profile}: direct removal, undo, settings removal, persistence, empty layout and re-add`);
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ ok: true, checks, errors }, null, 2));
  console.log(JSON.stringify({ ok: true, checks, screenshots: out }));
} finally { await browser?.close(); await instance?.stop(); removeDirectory(directory); }
