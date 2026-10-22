import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createDirectory, launch, removeDirectory, root } from './sandbox-lib.mjs';
import { seedCancelledFixture } from './cancelled-fixture.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const directory = createDirectory('cancelled-browser-'); seedCancelledFixture(directory);
const out = path.join(root, 'work', 'validation', 'cancelled-orders'); fs.mkdirSync(out, { recursive: true });
let instance, browser; const errors = [];
try {
  instance = await launch(directory);
  browser = await chromium.launch({ executablePath: process.env.QA_BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'finance_session', value: instance.token, url: instance.base, httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  const card = () => page.locator('#board [data-order-id="9001"]');
  await page.goto(instance.base + '/kanban/'); await card().waitFor();
  const cancelResponse = page.waitForResponse(r => r.url().endsWith('/orders/9001/status') && r.request().method() === 'PATCH');
  await card().dragTo(page.locator('#cancelled'));
  assert.equal((await cancelResponse).status(), 200);
  await card().waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#archive [data-order-id="9001"]').count(), 0);
  await page.waitForFunction(() => document.querySelector('#cancelled .subtle-count').textContent === '1');
  await page.screenshot({ path: path.join(out, 'board-desktop.png') });
  await page.waitForTimeout(350); // The board suppresses the click emitted at drag end.
  await page.locator('#cancelled').click();
  await page.locator('#cancelled-dialog [data-order-id="9001"]').click();
  await page.locator('#order-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#cancelled-dialog').isVisible(), false);
  await page.getByRole('button', { name: 'Вернуть на доску', exact: true }).click();
  await page.waitForFunction(() => {
    const status = document.querySelector('#order-status');
    return status && !status.disabled && status.value !== 'Отменён';
  });
  await card().waitFor();
  await page.keyboard.press('Escape');
  // The existing status selector provides the touch/keyboard cancellation path.
  await page.setViewportSize({ width: 384, height: 832 });
  await card().click();
  await page.locator('#order-dialog select').first().selectOption('Отменён');
  await page.waitForFunction(() => {
    const status = document.querySelector('#order-status');
    return status && !status.disabled && status.value === 'Отменён';
  });
  await page.waitForFunction(() => document.querySelector('#cancelled .subtle-count').textContent === '1');
  await page.keyboard.press('Escape');
  await page.locator('#cancelled').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(out, 'board-mobile.png') });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator('#cancelled').click();
  await page.locator('#cancelled-dialog').waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(out, 'cancelled-mobile.png') });
  // A fresh finance page must omit the cancelled order, with no production fallback.
  await page.goto(instance.base + '/');
  await page.getByRole('button', { name: 'Добавить доход', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('#orderNumber option[value="9002"]').waitFor({ state: 'attached' });
  assert.equal(await dialog.locator('#orderNumber option[value="9001"]').count(), 0);
  await page.screenshot({ path: path.join(out, 'payment-mobile.png') });
  await dialog.getByRole('button', { name: 'Замеры', exact: true }).click();
  assert.equal(await dialog.locator('#orderNumber').count(), 0);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const row = page.getByRole('row').filter({ hasText: 'Предоплата' });
  await row.getByRole('button', { name: /^Редактировать/ }).click();
  assert.equal(await dialog.locator('#orderNumber').inputValue(), '9001');
  assert.equal(await dialog.locator('#orderNumber option[value="9001"]').count(), 1);
  await page.screenshot({ path: path.join(out, 'history-desktop.png') });
  await page.keyboard.press('Escape');
  const cancelledLast = await page.evaluate(async () => {
    const response = await fetch('/kanban/api/orders/9002/status', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'Отменён', expectedStatus: 'Расчёт / КП' }) });
    return response.status;
  });
  assert.equal(cancelledLast, 200);
  await page.getByRole('button', { name: 'Добавить доход', exact: true }).first().click();
  await page.waitForFunction(() => document.querySelectorAll('#orderNumber option').length === 1);
  assert.equal(await dialog.locator('#orderNumber').inputValue(), '');
  assert.equal(await dialog.getByRole('button', { name: 'Записать оплату', exact: true }).isEnabled(), false);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'browser-report.json'), JSON.stringify({ ok: true, viewports: ['1440x1000', '384x832'], checks: ['real drag cancellation', 'separate cancelled list', 'restore order', 'mobile status cancellation', 'new payment exclusion', 'historic payment editable', 'measurements still visible', 'no document overflow'], errors }, null, 2));
  console.log('Cancelled order browser checks passed.');
} finally { await browser?.close(); await instance?.stop(); removeDirectory(directory); }
