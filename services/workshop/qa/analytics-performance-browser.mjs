import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { preview } from './analytics-concepts-preview.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE ||
    'C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
);
const out = path.resolve(
  process.env.ANALYTICS_QA_OUT || 'work/validation/analytics-performance',
);
fs.mkdirSync(out, { recursive: true });
const server = process.env.ANALYTICS_QA_URL ? null : await preview(0),
  base =
    process.env.ANALYTICS_QA_URL || `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath:
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});
const errors = [],
  external = [];
try {
  for (const width of [1440, 384]) {
    const context = await browser.newContext({
        viewport: { width, height: width === 1440 ? 1000 : 832 },
        serviceWorkers: 'block',
      }),
      page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => {
      if (!r.url().startsWith(base)) external.push(r.url());
    });
    const click = async (a, v) =>
      page
        .locator(
          `[data-p="${a}"]${v !== undefined ? `[data-value="${v}"]` : ''}`,
        )
        .first()
        .click();
    const shot = async (name) => {
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        'no page overflow',
      );
      await page.screenshot({
        path: path.join(out, `${name}-${width}.png`),
        fullPage: true,
      });
    };
    await page.goto(base + '/#concept=performance-demo');
    await page.locator('.p-table').waitFor();
    assert.deepEqual(await page.locator('.s-tabs button').allTextContents(), [
      'Источники',
      'Объявления',
      'Продукция',
    ]);
    assert.equal(
      await page.locator('[data-stage-count="0"]').innerText(),
      '109',
    );
    assert.equal(
      await page.locator('[data-stage-count="3"]').innerText(),
      '24',
    );
    assert.equal(
      await page.locator('[data-stage-count="4"]').innerText(),
      '19',
    );
    assert.equal(
      await page.locator('[data-total="paid"]').innerText(),
      '804 500 ₽',
    );
    await shot('sources');
    await click('open-ad', 'a1');
    assert.equal(
      await page.locator('[data-stage-count="0"]').innerText(),
      '24',
    );
    await click('drop', '2');
    assert.equal(await page.locator('.p-lead').count(), 6);
    assert.ok(
      (await page.locator('.p-details').innerText()).includes(
        'Потеряно: 3. Ещё в работе: 3.',
      ),
    );
    await shot('ad-dropoffs');
    await click('stage', '4');
    assert.equal(await page.locator('.p-lead').count(), 5);
    await click('order', 'З-A1-01');
    assert.ok(
      (await page.locator('.p-order-detail').innerText()).includes('80 000 ₽'),
    );
    await click('metrics', 'cost');
    assert.equal(
      await page
        .locator('[data-performance-row="a1"] [data-metric="cpo"]')
        .innerText(),
      '3 000 ₽',
    );
    await page.locator('[data-pcompare="a1"]').check();
    await page.locator('[data-pcompare="d1"]').check();
    assert.equal(await page.locator('.p-compare-grid article').count(), 2);
    await shot('ad-comparison');
    await page.locator('[data-pcompare="v1"]').check();
    await page.locator('[data-pcompare="v2"]').click();
    assert.equal(await page.locator('.p-compare-grid article').count(), 3);
    assert.equal(await page.locator('[data-pcompare="v2"]').isChecked(), false);
    await click('tab', 'product');
    assert.equal(await page.locator('.p-compare').count(), 0);
    assert.equal(
      await page
        .locator('[data-performance-row="letters"] [data-metric="cpo"]')
        .innerText(),
      '4 800 ₽',
    );
    assert.equal(
      await page
        .locator('[data-performance-row="plates"] [data-metric="cpo"]')
        .innerText(),
      '—',
    );
    await click('expand', 'letters');
    assert.equal(await page.locator('[data-performance-row="a2"]').count(), 1);
    assert.equal(
      await page.locator('[data-performance-row="none"]').count(),
      1,
    );
    await click('select', 'letters');
    assert.equal(
      await page.locator('[data-stage-count="0"]').innerText(),
      '18',
    );
    await shot('products');
    await page.locator('#p-source').selectOption('direct');
    await page.locator('#p-product').selectOption('windows');
    assert.equal(await page.locator('[data-stage-count="0"]').innerText(), '0');
    assert.ok(
      (await page.locator('.p-table').innerText()).includes(
        'В этом срезе нет данных',
      ),
    );
    await shot('empty');
    await click('reset');
    await page.locator('#p-product').selectOption('letters');
    await page.locator('#p-source').selectOption('avito');
    assert.equal(
      await page.locator('[data-stage-count="0"]').innerText(),
      '18',
    );
    await click('tab', 'ad');
    assert.equal(await page.locator('[data-performance-row]').count(), 2);
    await click('select', 'none');
    assert.equal(await page.locator('[data-stage-count="0"]').innerText(), '0');
    assert.ok((await page.locator('.p-details').innerText()).includes('З-201'));
    await shot('unattributed');
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  fs.writeFileSync(
    path.join(out, 'result.json'),
    JSON.stringify(
      {
        url: base,
        viewports: [1440, 384],
        flows: [
          'source drilldown',
          'ad funnel',
          'lost versus pending',
          'stage inquiries',
          'order payment details',
          'ad comparison and limit',
          'product cost and breakdown',
          'source-product intersection',
          'unknown cost',
          'unattributed orders',
          'empty',
        ],
        errors,
        external,
      },
      null,
      2,
    ) + '\n',
  );
  console.log('Performance demo: all flows passed on 1440 and 384.');
} finally {
  await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
}
