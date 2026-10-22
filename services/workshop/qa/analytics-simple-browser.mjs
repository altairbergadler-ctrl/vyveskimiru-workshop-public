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
  process.env.ANALYTICS_QA_OUT || 'work/validation/analytics-simple',
);
fs.mkdirSync(out, { recursive: true });
const server = process.env.ANALYTICS_QA_URL ? null : await preview(0),
  base =
    process.env.ANALYTICS_QA_URL || `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath:
    process.env.QA_BROWSER_PATH ||
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
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => {
      if (!r.url().startsWith(base)) external.push(r.url());
    });
    await page.goto(base + '/#concept=simple-archive');
    const click = async (action, value) =>
      page
        .locator(`[data-s="${action}"]${value ? `[data-v="${value}"]` : ''}`)
        .first()
        .click();
    const shot = async (name) => {
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        'no horizontal page overflow',
      );
      await page.screenshot({
        path: path.join(out, `${name}-${width}.png`),
        fullPage: true,
      });
    };
    await page.locator('.s-table').waitFor();
    assert.equal(
      await page.locator('[data-total="paid"]').innerText(),
      '240 000 ₽',
    );
    assert.equal(await page.locator('[data-total="orders"]').innerText(), '7');
    assert.equal(await page.locator('[data-source]').count(), 6);
    assert.ok(
      (await page.locator('[data-ad="none"]').innerText()).includes('30 000 ₽'),
    );
    await shot('overview');
    await click('sort', 'paid');
    assert.equal(
      await page.locator('[data-source]').first().getAttribute('data-source'),
      'avito',
    );
    await click('sort', 'paid');
    assert.match(
      await page
        .locator('[data-source]')
        .first()
        .locator('td')
        .last()
        .innerText(),
      /^0\s₽$/,
    );
    await click('order', 'O105');
    assert.ok(
      (await page.locator('.s-drawer').innerText()).includes(
        'Переписка не связана',
      ),
    );
    await page.locator('#s-order-source').selectOption('telegram');
    await page.locator('#s-order-form button[type=submit]').click();
    assert.equal(
      await page.locator('[data-source="telegram"] td').last().innerText(),
      '30 000 ₽',
    );
    await shot('order-source');
    await click('undo');
    await click('unmarked');
    await page
      .getByRole('checkbox', { name: 'Выбрать заказ O106', exact: true })
      .check();
    await page
      .getByRole('checkbox', { name: 'Выбрать заказ O107', exact: true })
      .check();
    await page.locator('#s-bulk-source').selectOption('vk');
    await shot('bulk-review');
    await click('bulk');
    assert.equal(await page.locator('.s-order-row').count(), 0);
    await click('tab', 'analytics');
    assert.equal(
      await page.locator('[data-source="vk"] td').last().innerText(),
      '10 000 ₽',
    );
    assert.equal(
      await page.locator('[data-total="paid"]').innerText(),
      '240 000 ₽',
    );
    await click('undo');
    await click('tab', 'inquiries');
    await shot('inquiries');
    await click('link', 'L05');
    await page.locator('#s-target').selectOption('O106');
    assert.ok(
      (await page.locator('.s-review').innerText()).includes('Не указан → VK'),
    );
    await shot('link-review');
    await page.locator('#s-form button[type=submit]').click();
    assert.equal(await page.locator('#s-order-source').inputValue(), 'vk');
    assert.ok(
      (await page.locator('.s-drawer').innerText()).includes(
        'Оформление витрин',
      ),
    );
    await click('close');
    await click('link', 'L05');
    await page.locator('#s-target').selectOption('O106');
    await page.locator('#s-form button[type=submit]').click();
    assert.equal(await page.locator('.s-conversation').count(), 1);
    await click('close');
    await click('create', 'L05');
    await page.locator('#s-amount').fill('-1');
    await page.locator('#s-form button[type=submit]').click();
    assert.equal(await page.locator('#s-amount').inputValue(), '-1');
    assert.ok(
      (await page.locator('.s-status').innerText()).includes('Укажите сумму'),
    );
    await page.locator('#s-amount').fill('12500,25');
    await page.locator('#s-form button[type=submit]').click();
    assert.equal(await page.locator('.s-drawer h2').innerText(), '№ D201');
    assert.ok(
      (await page.locator('.s-order-money').innerText()).includes(
        '12 500,25 ₽',
      ),
    );
    assert.equal(await page.locator('.s-payment').count(), 0);
    await shot('created-order');
    await click('tab', 'analytics');
    assert.equal(await page.locator('[data-total="orders"]').innerText(), '8');
    assert.equal(
      await page.locator('[data-total="paid"]').innerText(),
      '240 000 ₽',
    );
    await click('reset');
    assert.equal(await page.locator('[data-total="orders"]').innerText(), '7');
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  fs.writeFileSync(
    path.join(out, 'result.json'),
    JSON.stringify(
      {
        screens: [1440, 384],
        flows: [
          'source edit',
          'bulk assignment',
          'manual linkage and idempotency',
          'create and validation',
          'sort',
          'reset and undo',
        ],
        errors,
        external,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'Simple demo: all flows passed at 1440 and 384; no page overflow, JS errors or external requests.',
  );
} finally {
  await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
}
