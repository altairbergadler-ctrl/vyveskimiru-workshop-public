import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  createDirectory,
  launch,
  removeDirectory,
  root,
} from './sandbox-lib.mjs';
import { fixtures } from './fixtures.mjs';
const require = createRequire(import.meta.url);
const {
  chromium,
} = require('C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.join(root, 'work', 'validation', 'analytics');
fs.mkdirSync(out, { recursive: true });
const directory = createDirectory('analytics-browser-');
const sheet = fixtures();
sheet['Клиенты'][1][7] = '=2+3';
fs.writeFileSync(path.join(directory, 'sheet.json'), JSON.stringify(sheet));
let instance, browser;
const errors = [],
  checks = [];
try {
  instance = await launch(directory);
  browser = await chromium.launch({
    executablePath:
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: 'block',
  });
  await context.addCookies([
    {
      name: 'finance_session',
      value: instance.token,
      url: instance.base,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const before = fs.readFileSync(path.join(directory, 'sheet.json'), 'utf8');
  await page.goto(instance.base + '/#analytics');
  await page.getByRole('heading', { name: 'Аналитика', exact: true }).waitFor();
  await page.getByLabel('Начало периода', { exact: true }).fill('2026-09-01');
  await page.getByLabel('Конец периода', { exact: true }).fill('2026-09-08');
  await page.getByRole('button', { name: 'Показать', exact: true }).click();
  await page
    .getByRole('button', { name: 'Детализация: Поступления', exact: true })
    .waitFor();
  await page.waitForFunction(
    () => !document.querySelector('.an-content-loading'),
  );
  assert.match(
    await page
      .getByRole('button', { name: 'Детализация: Поступления', exact: true })
      .innerText(),
    /3\s*000/,
  );
  const nav = page.getByRole('navigation', { name: 'Разделы аналитики' });
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 384, height: 832 },
  ]) {
    await page.setViewportSize(viewport);
    for (const [tab, label] of [
      ['overview', 'Обзор'],
      ['finance', 'Деньги'],
      ['orders', 'Заказы'],
      ['acquisition', 'Источники'],
      ['funnel', 'Воронка'],
      ['operations', 'Производство и склад'],
      ['quality', 'Качество данных'],
    ]) {
      await nav
        .getByRole('button', { name: label, exact: tab !== 'quality' })
        .click();
      await page.evaluate(() => window.scrollTo(0, 0));
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `${tab} overflow at ${viewport.width}`,
      );
      await page.screenshot({
        path: path.join(out, `${tab}-${viewport.width}.png`),
        fullPage: tab === 'overview' || tab === 'acquisition',
        animations: 'disabled',
      });
      checks.push(`${tab}: ${viewport.width}px without overflow`);
    }
  }
  await nav.getByRole('button', { name: 'Обзор', exact: true }).click();
  await page
    .getByRole('button', { name: 'Как считается: Поступления', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('heading', { name: 'Поступления', exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  await page
    .getByRole('button', { name: 'Детализация: Новые заказы', exact: true })
    .click();
  await page.getByLabel('Поиск заказов в аналитике').fill('9001');
  assert.equal(await page.locator('.an-order-row').count(), 1);
  assert.equal(
    await page.locator('.an-order-title a').getAttribute('href'),
    '/kanban/?order=9001',
  );
  await page.getByLabel('Поиск заказов в аналитике').fill('не существует');
  assert.equal(await page.locator('.an-order-row').count(), 0);
  await nav.getByRole('button', { name: 'Источники', exact: true }).click();
  await page
    .locator('.an-connection')
    .filter({ has: page.getByRole('heading', { name: 'Авито', exact: true }) })
    .getByRole('button')
    .click();
  await page
    .getByRole('dialog')
    .getByText('Источник пока не подключён.', { exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.an-source-row').filter({ hasText: '=2+3' }).click();
  assert.equal(await page.locator('.an-order-row').count(), 1);
  const downloadPromise = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Экспорт периода', exact: true })
    .click();
  const download = await downloadPromise;
  const csv = path.join(out, 'fictional-export.csv');
  await download.saveAs(csv);
  const content = fs.readFileSync(csv, 'utf8');
  assert.ok(content.includes('"\'=2+3"'));
  assert.ok(content.includes('workshop-business-v1'));
  assert.ok(content.includes('2026-09-01'));
  assert.ok(content.includes('Поступления'));
  assert.ok(content.includes('История ограничена'));
  checks.push(
    'definitions, drilldown, search, source filter, disconnected Avito, period CSV with formula protection',
  );
  // A delayed old response must not replace a newly selected period.
  await page.route('**/api/analytics/overview?*', async (route) => {
    const response = await route.fetch();
    const report = await response.json();
    if (
      new URL(route.request().url()).searchParams.get('from') === '2026-08-01'
    )
      await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({ response, json: report });
  });
  await page
    .getByRole('button', { name: 'Прошлый месяц', exact: true })
    .click();
  await page.getByRole('button', { name: 'Этот месяц', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('.an-content') &&
      !document.querySelector('.an-content-loading'),
  );
  await page.waitForTimeout(1000);
  assert.ok(
    (await page.locator('.an-period-info').innerText()).includes('01.09.2026'),
  );
  await page.unroute('**/api/analytics/overview?*');
  await page.route('**/api/analytics/overview?*', (route) =>
    route.fulfill({ status: 503, json: { error: 'Учебный сбой загрузки' } }),
  );
  await page.getByRole('button', { name: '90 дней', exact: true }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: 'Учебный сбой загрузки' })
    .waitFor();
  assert.equal(await page.locator('.an-content').count(), 0); // no old values under a new date range
  await page.unroute('**/api/analytics/overview?*');
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('.an-content') &&
      !document.querySelector('.an-content-loading'),
  );
  checks.push(
    'out-of-order period requests, error without mismatched old data, retry recovery',
  );
  assert.equal(
    fs.readFileSync(path.join(directory, 'sheet.json'), 'utf8'),
    before,
  );
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(out, 'browser-report.json'),
    JSON.stringify(
      { ok: true, checks, consoleErrors: errors, sheetUnchanged: true },
      null,
      2,
    ),
  );
  console.log(
    'Analytics browser checks passed: desktop, mobile, drilldowns, export, failure and recovery.',
  );
} finally {
  await browser?.close();
  await instance?.stop();
  removeDirectory(directory);
}
