import assert from 'node:assert/strict';
import { productionFixture } from './production-fixture.mjs';
import { addProductionItem } from '../server/production-workflow.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import {
  createDirectory,
  launch,
  removeDirectory,
  root,
} from './sandbox-lib.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE ||
    'C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
);
const directory = createDirectory('production-browser-');
const out = path.join(root, 'work', 'validation', 'production');
fs.mkdirSync(out, { recursive: true });
let instance, browser;
const failures = [];
try {
  const imported = productionFixture();
  for (const [orderId, productId, quantity] of [['9001', 'letters', 4], ['9001', 'frame', 1], ['9002', 'print', 1]]) {
    addProductionItem(imported, { orderId, productId, quantity }, new Date());
  }
  imported.tasks.forEach(t => { t.needsSetup = true; });
  imported.products.forEach(p => { p.needsSetup = true; });
  fs.writeFileSync(path.join(directory, 'production.json'), JSON.stringify(imported));
  instance = await launch(directory, { production: true });
  browser = await chromium.launch({
    executablePath:
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
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
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });
  await page.goto(instance.base + '/production/');
  await page.getByRole('heading', { name: 'Моя работа' }).waitFor();
  await page.screenshot({
    path: path.join(out, 'master-desktop.png'),
    fullPage: true,
  });
  for (const label of ['План', 'Продукты', 'Мастера', 'Материалы', 'Заказы']) {
    await page
      .getByRole('navigation')
      .getByRole('button', { name: label, exact: true })
      .click();
    assert.equal(await page.locator('h1').count(), 1);
    if (label === 'План')
      await page.screenshot({
        path: path.join(out, 'plan-desktop.png'),
        fullPage: true,
      });
  }
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Продукты', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Новый продукт', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Название', { exact: true })
    .fill('Учебный тест браузера');
  await page.screenshot({
    path: path.join(out, 'product-desktop.png'),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(() =>
      document.querySelector('dialog').contains(document.activeElement),
    ),
    true,
  );
  await dialog.getByRole('button', { name: 'Сохранить новую версию' }).click();
  await dialog.waitFor({ state: 'hidden' });
  const product = page
    .getByRole('article')
    .filter({ hasText: 'Учебный тест браузера' });
  await product.getByRole('button', { name: 'Редактировать маршрут' }).click();
  await page
    .getByRole('dialog')
    .getByLabel('Этап', { exact: true })
    .fill('Проверенная сборка');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Сохранить новую версию' })
    .click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.match(await product.innerText(), /Версия 2/);
  await page.reload();
  await page.getByRole('heading', { name: 'Моя работа' }).waitFor();
  assert.match(await page.locator('main').innerText(), /Подтвердите получение материалов/);
  await page.getByRole('button', { name: /Материалы ·/ }).click();
  await page
    .getByRole('button', { name: 'Подтвердить получение со склада' })
    .click();
  // The write succeeds but its response is lost: confirmation must be read-only.
  let lostStartResponse = false, startPosts = 0;
  await page.route('**/api/production-pilot/command', async route => {
    const input = route.request().postDataJSON();
    if (input.type === 'task.start') startPosts++;
    if (input.type === 'task.start' && !lostStartResponse) {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      lostStartResponse = true;
      await route.fulfill({ status: 503, json: { code: 'pending', error: 'Действие принято. Ждём подтверждения Google; экран обновится автоматически.' } });
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Начать', exact: true }).click();
  await page.getByText('Действие принято. Ждём подтверждения Google; экран обновится автоматически.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Готово', exact: true }).waitFor({ timeout: 20000 });
  assert.equal(await page.getByRole('button', { name: 'Готово', exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Проверить действие', exact: true }).count(), 0);
  assert.equal(await page.getByText('Действие принято. Ждём подтверждения Google; экран обновится автоматически.', { exact: true }).count(), 0);
  assert.equal(startPosts, 1, 'confirmation polling must not resend the action');
  assert.deepEqual(failures, ['Failed to load resource: the server responded with a status of 503 (Service Unavailable)']);
  failures.length = 0; // Exactly the injected response above; other errors still fail.
  await page.unroute('**/api/production-pilot/command');
  await page.getByRole('button', { name: 'Готово', exact: true }).waitFor();
  await page.getByRole('button', { name: /Изображения ·/ }).click();
  await page.getByRole('dialog').waitFor();
  assert.ok(
    await page
      .getByRole('dialog')
      .locator('img')
      .evaluate((img) => img.complete && img.naturalWidth > 0),
  );
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 384, height: 832 });
  await page.screenshot({
    path: path.join(out, 'master-mobile.png'),
    fullPage: true,
  });
  for (const label of [
    'План',
    'Продукты',
    'Мастера',
    'Материалы',
    'Заказы',
    'Экран мастера',
  ]) {
    await page
      .getByRole('navigation')
      .getByRole('button', { name: label, exact: true })
      .click();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `Overflow: ${label}`,
    );
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({
    path: path.join(out, 'master-dark-mobile.png'),
    fullPage: true,
  });
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Продукты', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Новый продукт', exact: true })
    .click();
  await page.screenshot({
    path: path.join(out, 'product-mobile.png'),
    fullPage: true,
  });
  assert.ok(
    await page
      .getByRole('dialog')
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  );
  await page.keyboard.press('Escape');
  // A separate browser context proves the production-only login and simple master view.
  const pin = String(crypto.randomInt(100000, 1000000));
  const api = async (route, payload) => {
    const response = await context.request.post(instance.base + route, {
      headers: { Origin: instance.base },
      data: payload,
    });
    assert.equal(response.status(), 200);
    return response.json();
  };
  await api('/api/production-pilot/access', { workerId: 'boris', pin });
  const before = await (
    await context.request.get(instance.base + '/api/production-pilot')
  ).json();
  await api('/api/production-pilot/command', {
    requestId: crypto.randomUUID(),
    revision: before.revision,
    type: 'worker.save',
    data: { ...before.workers.find((w) => w.id === 'boris'), access: true },
  });
  const masterContext = await browser.newContext({
    viewport: { width: 384, height: 832 },
  });
  const masterPage = await masterContext.newPage();
  masterPage.on('pageerror', (error) => failures.push(error.message));
  await masterPage.goto(instance.base + '/production/');
  await masterPage.getByLabel('Логин мастера').fill('boris');
  await masterPage.getByLabel('Код доступа').fill(pin);
  await masterPage.getByRole('button', { name: 'Войти', exact: true }).click();
  await masterPage.getByRole('heading', { name: 'Моя работа' }).waitFor();
  assert.equal(await masterPage.getByRole('navigation').count(), 0);
  await masterPage
    .getByRole('button', { name: 'Часть работы', exact: true })
    .click();
  await masterPage
    .getByRole('dialog')
    .getByLabel(/Выполнено,/)
    .fill('0.5');
  await masterPage
    .getByRole('dialog')
    .getByRole('button', { name: 'Сохранить', exact: true })
    .click();
  await masterPage.getByRole('dialog').waitFor({ state: 'hidden' });
  await masterPage
    .getByRole('button', { name: 'Продолжить', exact: true })
    .click();
  await masterPage
    .getByRole('button', { name: 'Готово', exact: true })
    .waitFor();
  await masterPage.screenshot({
    path: path.join(out, 'master-personal-mobile.png'),
    fullPage: true,
  });
  const beforeFinish = await (await masterContext.request.get(instance.base + '/api/production-pilot')).json();
  let finishPosts = 0;
  await masterPage.route('**/api/production-pilot/command', async route => {
    const input = route.request().postDataJSON();
    assert.equal(input.type, 'task.complete');
    finishPosts++;
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    await route.fulfill({ status: 503, json: { code: 'pending', error: 'Проверяем завершение этапа.' } });
  });
  await masterPage.getByRole('button', { name: 'Готово', exact: true }).click();
  await masterPage.getByText('Проверяем завершение этапа.', { exact: true }).waitFor();
  await masterPage.getByText('Проверяем завершение этапа.', { exact: true }).waitFor({ state: 'hidden', timeout: 20000 });
  assert.equal(await masterPage.getByRole('button', { name: 'Проверить действие', exact: true }).count(), 0);
  const afterFinish = await (await masterContext.request.get(instance.base + '/api/production-pilot')).json();
  assert.equal(afterFinish.records.length, beforeFinish.records.length + 1);
  assert.equal(finishPosts, 1);
  await masterPage.unroute('**/api/production-pilot/command');
  await masterPage.getByRole('button', { name: /Выполненные работы/ }).click();
  assert.match(await masterPage.locator('main').innerText(), /0.5/);
  assert.equal(
    (
      await masterContext.request.get(instance.base + '/api/transactions')
    ).status(),
    401,
  );
  assert.deepEqual(failures, []);
  fs.writeFileSync(
    path.join(out, 'browser-results.json'),
    JSON.stringify(
      {
        passed: true,
        viewports: ['1440x1000', '384x832'],
        scenarios: [
          'imported markers allow start without resaving; material reason is visible',
          'lost successful command response settles through read-only polling without another POST',
          'all manager tabs',
          'create product',
          'edit version',
          'persistence after reload',
          'issue materials',
          'start task',
          'shared order image',
          'dialog focus and Escape',
          'mobile overflow',
          'dark mode',
          'personal master login',
          'partial completion and resume',
          'personal history',
          'no financial access',
        ],
        runtimeErrors: failures,
      },
      null,
      2,
    ),
  );
  console.log(
    'Production browser scenarios passed; screenshots in work/validation/production.',
  );
} finally {
  await browser?.close();
  await instance?.stop();
  removeDirectory(directory);
}
