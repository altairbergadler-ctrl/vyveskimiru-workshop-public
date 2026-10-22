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
import { productionSheetFixtures } from './production-fixture.mjs';
import { realFixture } from './analytics-real-fixture.mjs';
const require = createRequire(import.meta.url);
const {
  chromium,
} = require('C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const directory = createDirectory('route-products-browser-');
const out = path.join(root, 'work/validation/route-products');
fs.mkdirSync(out, { recursive: true });
const sheet = productionSheetFixtures();
fs.writeFileSync(path.join(directory, 'sheet.json'), JSON.stringify(sheet));
let instance, browser;
const errors = [];
try {
  instance = await launch(directory, { production: true });
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
  const get = async (url) => {
    const r = await context.request.get(instance.base + url);
    assert.equal(r.status(), 200);
    return r.json();
  };
  const name = 'Учебный новый вид <тест>';
  const before = await get('/api/analytics/products');
  await page.goto(instance.base + '/production/');
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Продукты', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Новый продукт', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByLabel('Название', { exact: true })
    .fill(name);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Сохранить новую версию', exact: true })
    .click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const catalog = await get('/api/analytics/products');
  assert.equal(catalog.products.length, before.products.length + 1);
  const product = catalog.products.find((p) => p.name === name);
  assert.ok(product);
  const form = await get('/kanban/api/orders/9002/positions/new');
  assert.ok(form.templates.some((t) => t.id === 'route:' + product.id));
  await page.screenshot({
    path: path.join(out, 'new-product-1440.png'),
    fullPage: true,
  });
  await page.goto(instance.base + '/kanban/');
  await page.locator('[data-order-id="9002"]').first().click();
  await page.locator('#order-dialog').waitFor();
  await page.locator('#order-dialog [data-focus-key="tab-positions"]').click();
  await page.locator('.position-add-button').click();
  await page
    .getByRole('button', { name: new RegExp('Учебный новый вид') })
    .click();
  await page
    .getByRole('dialog')
    .last()
    .getByLabel('Свободное описание')
    .fill('Вымышленная проверка автоматического маршрута');
  assert.equal(
    await page
      .getByRole('dialog')
      .last()
      .getByLabel('Название работы', { exact: true })
      .count(),
    0,
  );
  await page.screenshot({
    path: path.join(out, 'new-position-1440.png'),
    fullPage: true,
  });
  await page
    .getByRole('dialog')
    .last()
    .getByRole('button', { name: 'Добавить позицию', exact: true })
    .click();
  await page.locator('.record-dialog').waitFor({ state: 'hidden' });
  const production = await get('/api/production-pilot');
  const item = production.items.find(
    (i) => i.productId === product.id && i.orderId === '9002',
  );
  assert.ok(item);
  assert.ok(production.tasks.some((t) => t.itemId === item.id));
  const linked = await get('/api/analytics/products');
  assert.ok(linked.positions.some((p) => p.productId === product.id));
  // Only the demo shell/ad fixtures are served locally. Catalog, orders and production use the real sandbox HTTP handlers.
  const site = path.join(root, 'work/validation/analytics-public/site');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(site, 'manifest.json'), 'utf8'),
  );
  await page.route(instance.base + '/demo/analytics/**', async (route) => {
    const relative =
      decodeURIComponent(
        new URL(route.request().url()).pathname.slice(
          '/demo/analytics/'.length,
        ),
      ) || 'index.html';
    assert.ok(Object.hasOwn(manifest, relative));
    await route.fulfill({
      status: 200,
      contentType: relative.endsWith('.mjs')
        ? 'text/javascript'
        : relative.endsWith('.css')
          ? 'text/css'
          : 'text/html',
      body: fs.readFileSync(path.join(site, relative)),
    });
  });
  await page.route(instance.base + '/api/analytics/avito/deep**', (route) =>
    route.fulfill({ json: realFixture.ads }),
  );
  await page.route(instance.base + '/api/analytics/inquiries**', (route) =>
    route.fulfill({ json: realFixture.inquiries }),
  );
  for (const width of [1440, 384]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 832 });
    await page.goto(instance.base + '/demo/analytics/');
    await page.locator('#r-product').waitFor();
    assert.ok(
      (await page.locator('#r-product option').allTextContents()).includes(
        name,
      ),
    );
    await page.locator('[data-r="tab"][data-value="product"]').click();
    await page.locator('#r-product').selectOption(product.id);
    await page.locator('[data-r="mode"][data-value="orders"]').first().click();
    assert.equal(
      await page
        .locator('[data-real-row] [data-real-metric="orders"]')
        .innerText(),
      '1',
    );
    assert.equal(
      await page.locator('[data-real-row] .p-name b').innerText(),
      name,
    );
    assert.equal(await page.locator('[data-real-row] test').count(), 0);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: path.join(out, `analytics-${width}.png`),
      fullPage: true,
    });
    await page.goto(instance.base + '/kanban/');
    await page.locator('[data-order-id="9002"]').first().click();
    await page
      .locator('#order-dialog [data-focus-key="tab-positions"]')
      .click();
    await page.locator('.position-add-button').click();
    await page
      .getByRole('button', { name: new RegExp('Учебный новый вид') })
      .click();
    assert.ok(
      await page
        .getByRole('dialog')
        .last()
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    );
    await page.screenshot({
      path: path.join(out, `position-${width}.png`),
      fullPage: true,
    });
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(out, 'result.json'),
    JSON.stringify(
      {
        newProductFromWebsite: true,
        sharedCatalog: true,
        orderPositionCreated: true,
        productionRouteCreated: true,
        analyticsOrderCount: 1,
        viewports: [1440, 384],
        businessData: 'fictional local sandbox only',
        errors,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'New website product → order → production → analytics: 1440/384 passed.',
  );
} finally {
  await browser?.close();
  await instance?.stop();
  removeDirectory(directory);
}
