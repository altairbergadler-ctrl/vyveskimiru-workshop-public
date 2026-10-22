import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { preview } from './analytics-concepts-preview.mjs';
import { realFixture } from './analytics-real-fixture.mjs';
import { realModel, realSlice } from '../prototypes/analytics/real-model.mjs';
const require = createRequire(import.meta.url),
  {
    chromium,
  } = require('C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const privateInput = process.env.REAL_PRIVATE_FIXTURE;
const fixture = privateInput
  ? JSON.parse(fs.readFileSync(privateInput, 'utf8'))
  : realFixture;
const out = path.resolve(
  process.env.ANALYTICS_QA_OUT || 'work/validation/analytics-real/browser',
);
fs.mkdirSync(out, { recursive: true });
const server = process.env.ANALYTICS_QA_URL ? null : await preview(0),
  base =
    process.env.ANALYTICS_QA_URL || `http://127.0.0.1:${server.address().port}`;
const origin = new URL(base).origin;
const browser = await chromium.launch({
  executablePath:
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});
const errors = [],
  writes = [];
try {
  for (const width of [1440, 384]) {
    const context = await browser.newContext({
        viewport: { width, height: width === 1440 ? 1000 : 832 },
        serviceWorkers: 'block',
      }),
      page = await context.newPage();
    let authorized = false,
      expire = false;
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(origin + '/api/**', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      let value,
        status = 200;
      if (request.method() !== 'GET') writes.push(url.pathname);
      if (url.pathname === '/api/session') {
        if (request.method() === 'POST') authorized = true;
        value = { authenticated: authorized && !expire };
      } else if (!authorized || expire) {
        status = 401;
        value = { error: 'Требуется вход' };
      } else if (url.pathname === '/api/analytics/avito/deep')
        value = fixture.ads;
      else if (url.pathname === '/api/analytics/overview')
        value = fixture.business;
      else if (url.pathname === '/api/analytics/products')
        value = fixture.catalog;
      else if (url.pathname === '/api/analytics/inquiries')
        value = fixture.inquiries;
      else throw new Error('Unexpected API path');
      await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(value),
      });
    });
    const click = async (a, v) =>
      page
        .locator(`[data-r="${a}"]${v ? `[data-value="${v}"]` : ''}`)
        .first()
        .click();
    const check = async (name) => {
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        'no horizontal page overflow',
      );
      if (!privateInput)
        await page.screenshot({
          path: path.join(out, `${name}-${width}.png`),
          fullPage: true,
        });
    };
    await page.goto(base + '/#concept=simple');
    await page.locator('#r-login button:not([disabled])').waitFor();
    assert.equal(await page.locator('.p-table').count(), 0);
    await check('login');
    await page.locator('[name=pin]').fill('000000');
    await page.locator('#r-login button').click();
    await page.locator('.p-table').waitFor();
    assert.equal(await page.locator('h1').innerText(), 'Ваши данные');
    assert.equal(
      await page
        .locator('[data-real-row="avito"] [data-real-metric="spend"]')
        .innerText()
        .then((s) => s.includes('*')),
      true,
    );
    await check('sources');
    await click('mode', 'orders');
    assert.equal(
      await page
        .locator('[data-real-row="avito"] [data-real-metric="paid"]')
        .innerText(),
      '—',
    );
    assert.equal(
      await page
        .locator('[data-real-row="avito"] [data-real-metric="orders"]')
        .innerText(),
      '—',
    );
    await click('tab', 'ad');
    assert.ok(
      (await page.locator('[data-real-metric="paid"]').allTextContents()).every(
        (v) => v === '—',
      ),
    );
    await click('mode', 'ads');
    await page.locator('[data-rcompare]').nth(0).check();
    await page.locator('[data-rcompare]').nth(1).check();
    assert.equal(await page.locator('.p-compare-grid article').count(), 2);
    await check('ads');
    await click('clear-compare');
    assert.equal(await page.locator('.p-compare-grid').count(), 0);
    if (!privateInput) {
      await page.locator('[name=query]').fill('Световые');
      await page.locator('#r-search button').click();
      assert.equal(await page.locator('[data-real-row]').count(), 1);
      await click('select', '1');
      assert.ok(
        (await page.locator('#r-details').innerText()).includes(
          'Подтверждённых связей',
        ),
      );
    }
    await click('tab', 'product');
    await click('mode', 'orders');
    await check('products');
    const m = realModel(
        fixture.ads,
        fixture.business,
        fixture.inquiries,
        fixture.catalog,
      ),
      sum = realSlice(m);
    assert.equal(
      await page.locator('.p-stages .p-stage b').first().innerText(),
      String(sum.orders.length),
    );
    expire = true;
    await click('refresh');
    await page.locator('#r-login').waitFor();
    assert.equal(await page.locator('.p-table').count(), 0);
    assert.equal(await page.locator('.r-business').count(), 0);
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.ok(writes.every((p) => p === '/api/session'));
  const m = realModel(
      fixture.ads,
      fixture.business,
      fixture.inquiries,
      fixture.catalog,
    ),
    summary = realSlice(m);
  fs.writeFileSync(
    path.join(out, 'result.json'),
    JSON.stringify(
      {
        viewports: [1440, 384],
        privateSnapshot: !!privateInput,
        authenticatedTransport: 'mocked; production API remains protected',
        ads: m.ads.length,
        orders: m.orders.length,
        dialogs: m.dialogs.length,
        knownSpendingKopecks: summary.known.spend,
        unknownSalesStages: 4,
        errors,
        businessWrites: false,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'Real analytics: login gate, source honesty, products, no business writes, expiry and 1440/384 layouts passed.',
  );
} finally {
  await browser.close();
  if (server) await new Promise((r) => server.close(r));
}
