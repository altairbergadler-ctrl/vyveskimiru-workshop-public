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
const out = path.resolve('work/validation/analytics-hybrid');
fs.mkdirSync(out, { recursive: true });
const server = await preview(0),
  base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath:
    process.env.QA_BROWSER_PATH ||
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});
const errors = [],
  external = [],
  checks = [];
try {
  for (const width of [1440, 384]) {
    const context = await browser.newContext({
      viewport: { width, height: width === 1440 ? 1000 : 832 },
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => {
      if (!r.url().startsWith(base)) external.push(r.url());
    });
    await page.goto(base + '/#concept=hybrid&source=all&ad=all&period=mature');
    await page.locator('.h-table').waitFor();
    const shot = async (name) => {
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        'horizontal page overflow',
      );
      await page.screenshot({
        path: path.join(out, `${name}-${width}.png`),
        fullPage: true,
      });
    };
    assert.equal(await page.locator('[data-hkpi="leads"]').innerText(), '8');
    assert.equal(
      await page.locator('[data-hkpi="paid"]').innerText(),
      '200 000 ₽',
    );
    assert.equal(await page.locator('.h-row.source').count(), 6);
    assert.equal(await page.locator('.h-row.ad').count(), 5);
    await shot('overview');
    await page.locator('#hGroup').selectOption('ads');
    assert.equal(await page.locator('.h-row.ad').count(), 5);
    assert.equal(await page.locator('[data-hrow="source:unknown"]').count(), 1);
    assert.equal(await page.locator('[data-action="h-expand"]').count(), 0);
    await page.locator('#hGroup').selectOption('campaign');
    assert.equal(await page.locator('.h-row.campaign').count(), 4);
    await page
      .locator(
        '[data-action="h-select"][data-value="campaign:avito:Вывески / локальный бизнес"]',
      )
      .click();
    assert.ok(
      (await page.locator('.h-investigation').innerText()).includes(
        '120 000 ₽',
      ),
    );
    await page
      .locator('[data-action="h-toggle"][data-value="source:avito"]')
      .click();
    assert.equal(await page.locator('[data-hrow="ad:a1"]').count(), 0);
    await page
      .locator('[data-action="h-toggle"][data-value="source:avito"]')
      .click();
    await page.locator('#hSort').selectOption('leads');
    await page.locator('[data-action="h-direction"]').click();
    assert.ok(
      await page
        .locator('[data-hrow="campaign:avito:Вывески / локальный бизнес"]')
        .count(),
    );
    await page.locator('[data-action="h-set"][data-value="ads"]').click();
    assert.ok(
      (await page.locator('.h-traffic').innerText()).includes('Контакты Авито'),
    );
    assert.ok(
      (await page.locator('.h-traffic').innerText()).includes('не установлена'),
    );
    await page.locator('[data-action="h-sort"][data-value="views"]').click();
    assert.equal(await page.locator('#hSort').inputValue(), 'views');
    assert.equal(
      await page
        .locator('[data-hrow="ad:a3"] [data-metric="contacts"] b')
        .innerText(),
      '0',
    );
    assert.equal(
      await page
        .locator('[data-hrow="ad:a3"] [data-metric="costContact"] b')
        .innerText(),
      '—',
    );
    await shot('campaigns-ads');
    await page
      .locator('[data-hcompare="campaign:avito:Вывески / локальный бизнес"]')
      .check();
    await page
      .locator('[data-hcompare="campaign:avito:Интерьер / малые тиражи"]')
      .check();
    assert.equal(await page.locator('.h-compare-grid article').count(), 2);
    await page.locator('.h-compare [data-action="h-clear"]').click();
    await page.locator('[data-hcompare="ad:a1"]').check();
    await page.locator('[data-hcompare="ad:a2"]').check();
    assert.equal(await page.locator('.h-compare-grid article').count(), 2);
    assert.ok(
      (await page.locator('.h-compare').innerText()).includes('720 ₽') ===
        false,
      'comparison uses cost per order, not mislabeled contact cost',
    );
    await page
      .locator('[data-action="h-select"][data-value="ad:a2"]')
      .first()
      .click();
    await page.locator('[data-action="h-stage"][data-value="ordered"]').click();
    assert.equal(await page.locator('.h-leads button').count(), 2);
    await page.locator('.h-leads [data-value="L07"]').click();
    assert.ok(
      (await page.locator('#evidence').innerText()).includes('Яндекс Директ'),
    );
    assert.ok((await page.locator('#evidence').innerText()).includes('T4'));
    await shot('comparison-detail');
    await page.locator('[data-action="h-stage"][data-value="lost"]').click();
    assert.equal(await page.locator('.h-leads button').count(), 1);
    await page.locator('.h-leads [data-value="L08"]').click();
    assert.ok(
      (await page.locator('#evidence').innerText()).includes(
        'вне нашего профиля',
      ),
    );
    await page.locator('#hGroup').selectOption('source');
    await page.locator('[data-hcompare="source:avito"]').check();
    assert.equal(await page.locator('.h-compare-grid article').count(), 1);
    await page.locator('[data-hcompare="source:direct"]').check();
    assert.equal(await page.locator('.h-compare-grid article').count(), 2);
    await page.locator('[data-action="h-set"][data-value="quality"]').click();
    await shot('source-comparison');
    await page.locator('#hSearch').fill('буквы');
    await page.locator('#hSearch').press('Enter');
    assert.equal(await page.locator('[data-hkpi="leads"]').innerText(), '3');
    assert.equal(await page.locator('.h-row.ad').count(), 1);
    await page.locator('#hSearch').fill('нет такого объявления');
    await page.locator('#hSearch').press('Enter');
    assert.equal(await page.locator('[data-hkpi="leads"]').innerText(), '0');
    await shot('empty');
    await page.locator('[data-action="h-reset"]').click();
    await page.locator('#source').selectOption('unknown');
    assert.equal(await page.locator('[data-hkpi="paid"]').innerText(), '0 ₽');
    await page.locator('.h-leads [data-value="L06"]').click();
    assert.ok(
      (await page.locator('#evidence').innerText()).includes(
        'связь не подтверждена',
      ),
    );
    await page.locator('#source').selectOption('avito');
    await page.locator('#period').selectOption('recent');
    await page.locator('[data-action="h-set"][data-value="result"]').click();
    assert.ok(
      (await page.locator('.h-scope').innerText()).includes('созревает'),
    );
    assert.equal(
      await page
        .locator('[data-hrow="source:avito"] [data-metric="cost"] b')
        .innerText(),
      '—',
    );
    await page.locator('#hPrevious').uncheck();
    assert.equal(await page.locator('.h-delta').count(), 0);
    await shot('immature');
    checks.push(
      `${width}: overview, nested campaigns, collapse, sibling sort, metric sets, zero/null, comparisons at ad/source level, funnel stages, orders/payments, lost reasons, search totals, empty, uncertain link, immature, comparison toggle, no overflow`,
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
    screenshots: fs.readdirSync(out).filter((f) => f.endsWith('.png')),
  };
  fs.writeFileSync(
    path.join(out, 'results.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
