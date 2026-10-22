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
const out = path.resolve('work/validation/analytics-concepts');
fs.mkdirSync(out, { recursive: true });
const server = await preview(0),
  base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath:
    process.env.QA_BROWSER_PATH ||
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});
const checks = [],
  errors = [],
  external = [];
try {
  for (const width of [1440, 384]) {
    const context = await browser.newContext({
      viewport: { width, height: width === 1440 ? 1000 : 832 },
      serviceWorkers: 'block',
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => {
      if (!r.url().startsWith(base) && !r.url().startsWith('data:'))
        external.push(r.url());
    });
    const noOverflow = async () =>
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `overflow at ${width}`,
      );
    for (const concept of ['map', 'desk', 'story', 'matrix', 'actions']) {
      await page.goto(
        base + `/#concept=${concept}&source=avito&ad=all&period=mature`,
      );
      await page.locator('h1').waitFor();
      await noOverflow();
      assert.equal(await page.getByTestId('lead-count').innerText(), '5');
      assert.equal(
        await page.getByTestId('paid-total').innerText(),
        '120 000 ₽',
      );
      await page.screenshot({
        path: path.join(out, `${concept}-${width}.png`),
        fullPage: true,
      });
      // Each independent interface supports source -> ad -> lead -> order -> payment.
      await page.locator('#ad').selectOption('a2');
      assert.equal(await page.getByTestId('lead-count').innerText(), '3');
      if (concept === 'actions') {
        // Follow a loss signal, then inspect a successful case from the same source.
        await page
          .locator('[data-action="lead"][data-value="L08"]')
          .first()
          .click();
        assert.ok(
          (await page.locator('#evidence').innerText()).includes(
            'Запрос вне нашего профиля',
          ),
        );
        await page.locator('#ad').selectOption('a1');
        await page
          .locator('[data-action="lead"][data-value="L03"]')
          .first()
          .click();
        assert.ok(
          (await page.locator('#evidence').innerText()).includes('180 мин'),
        );
        await page.locator('.all-signal-leads summary').click();
        await page
          .locator('.all-signal-leads [data-action="lead"][data-value="L01"]')
          .click();
        await page.locator('[data-action="order"][data-value="O101"]').click();
        assert.ok(
          (await page.locator('.order-detail').innerText()).includes('T2'),
        );
      } else {
        await page
          .locator('[data-action="lead"][data-value="L07"]')
          .first()
          .click();
        const evidence = await page.locator('#evidence').innerText();
        assert.ok(
          evidence.includes('Яндекс Директ') && evidence.includes('Авито'),
        );
        await page.locator('[data-action="order"][data-value="O104"]').click();
        assert.ok(
          (await page.locator('.order-detail').innerText()).includes('T4'),
        );
        assert.ok(
          (await page.locator('.order-detail').innerText()).includes(
            '30 000 ₽',
          ),
        );
      }
      await noOverflow();
      await page.locator('#evidence').scrollIntoViewIfNeeded();
      await page.screenshot({
        path: path.join(out, `${concept}-evidence-${width}.png`),
        fullPage: true,
      });
      await page.locator('#source').selectOption('telegram');
      assert.equal(await page.getByTestId('lead-count').innerText(), '0');
      assert.equal(await page.locator('#ad').inputValue(), 'all');
      assert.ok(
        (await page
          .getByText('Нет данных в этом срезе', { exact: true })
          .count()) > 0,
      );
      await noOverflow();
      checks.push(
        `${concept}: ${width}px, filters, drilldown, empty, overflow`,
      );
    }
    await page.goto(base + '/#concept=desk&source=avito&ad=all&period=mature');
    await page.locator('[data-compare="a1"]').check();
    await page.locator('[data-compare="a2"]').check();
    assert.equal(await page.locator('.compare-cards article').count(), 2);
    await page.locator('[data-action="lead"][data-value="L01"]').click();
    await page.locator('[data-action="save"]').click();
    await page.locator('#source').selectOption('direct');
    await page.locator('[data-action="restore"]').click();
    assert.equal(await page.locator('#source').inputValue(), 'avito');
    assert.equal(await page.locator('.compare-cards article').count(), 2);
    assert.ok((await page.locator('#evidence').innerText()).includes('L01'));
    await page.locator('[data-action="concept"][data-value="story"]').click();
    assert.ok((await page.locator('#evidence').innerText()).includes('L01'));
    await page.locator('#source').selectOption('direct');
    await page.locator('[data-action="lead"][data-value="L04"]').click();
    assert.equal(await page.locator('[data-action="order"]').count(), 2);
    await page.locator('[data-action="order"][data-value="O103"]').click();
    assert.ok(
      (await page.locator('.order-detail').innerText()).includes('0 ₽'),
    );
    await page.locator('#source').selectOption('unknown');
    await page.locator('[data-action="lead"][data-value="L06"]').click();
    assert.equal(await page.getByTestId('paid-total').innerText(), '0 ₽');
    assert.ok(
      (await page.locator('#evidence').innerText()).includes(
        'связь не подтверждена',
      ),
    );
    await page.screenshot({
      path: path.join(out, `uncertain-${width}.png`),
      fullPage: true,
    });
    await page.goto(
      base + '/#concept=matrix&source=avito&ad=all&period=mature',
    );
    await page.locator('#lens').selectOption('cost');
    await page
      .locator('[data-action="cell"][data-value="avito:recent"]')
      .click();
    assert.equal(await page.locator('#period').inputValue(), 'recent');
    assert.ok(
      (await page.locator('.cohort-grid').innerText()).includes('Ещё рано'),
    );
    await page.goto(base + '/#concept=desk&source=avito&ad=a3&period=mature');
    assert.ok(
      (await page.locator('.ad-table tbody').innerText()).includes('0 ₽'),
    );
    assert.ok(
      (await page.locator('.ad-table tbody').innerText()).includes('—'),
    );
    await page.goto(base + '/#concept=desk&source=all&ad=all&period=mature');
    assert.ok(
      (await page.locator('.ad-table').innerText()).includes('Неполный импорт'),
    );
    assert.ok(
      (await page.locator('.ad-table').innerText()).includes('Устарело'),
    );
    await page
      .locator('[data-action="concept"][data-value="compare"]')
      .first()
      .click();
    assert.equal(await page.locator('.concept-cards>article').count(), 5);
    await noOverflow();
    await page.screenshot({
      path: path.join(out, `compare-${width}.png`),
      fullPage: true,
    });
    checks.push(
      `${width}px: pair comparison, saved context, concept switch, two orders, unknown link, zero, partial, stale, immature, comparison page`,
    );
    await page.goto(base + '/#concept=map&source=avito&ad=all&period=mature');
    await page.locator('[data-action="stage"][data-value="ads"]').click();
    assert.equal(await page.locator('.ad-table tbody tr').count(), 3);
    await page.locator('[data-action="stage"][data-value="orders"]').click();
    await page
      .locator('[data-action="mapOrder"][data-value="O101"]')
      .first()
      .click();
    assert.ok((await page.locator('.order-detail').innerText()).includes('T2'));
    await page.locator('[data-action="stage"][data-value="payments"]').click();
    assert.ok((await page.locator('main').innerText()).includes('T1 → O101'));
    await page.goto(
      base + '/#concept=actions&source=avito&ad=all&period=mature',
    );
    await page.locator('[data-action="signal"][data-value="price-a2"]').click();
    await page
      .locator('.action-evidence [data-action="lead"][data-value="L07"]')
      .click();
    assert.ok(
      (await page.locator('.order-detail').innerText()).includes(
        'История стадий заказа',
      ),
    );
    await page.locator('[data-action="signal"][data-value="slow"]').click();
    assert.equal(await page.locator('#evidence').count(), 0);
    await page.locator('#source').focus();
    await page.locator('#source').selectOption('vk');
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      'source',
    );
    checks.push(
      `${width}px: map stages, shared-order drilldown, cost signal, signal context reset, keyboard focus`,
    );
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  const result = {
    ok: true,
    checks,
    errors,
    externalRequests: external,
    viewports: [1440, 384],
    screenshots: fs.readdirSync(out).filter((f) => f.endsWith('.png')),
  };
  fs.writeFileSync(
    path.join(out, 'results.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
