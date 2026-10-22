// UI acceptance on a fictional backend. Material routes below use explicit
// fictional responses; their real persistence/auth is covered by readiness-http.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE ||
    'C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
);
const out = 'work/validation/readiness';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: 'block',
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const today = new Date().toISOString().slice(0, 10),
    from = today.slice(0, 7) + '-01';
  const view = {
    contentVersion: 0,
    content: null,
    chats: [{ id: 'fictional-chat', firstIn: from, state: 'answered' }],
    notes: [],
    excerpts: [],
  };
  const posted = [];
  await page.route('**/api/analytics/materials**', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.method() === 'GET') return route.fulfill({ json: view });
    const data = request.postDataJSON();
    posted.push({ path: url.pathname, data });
    if (url.pathname.endsWith('/content')) {
      if (data.expectedVersion !== view.contentVersion)
        return route.fulfill({
          status: 409,
          json: { error: 'Конфликт версии' },
        });
      view.content = {
        text: data.text,
        photos: data.photos,
        observedAt: new Date().toISOString(),
      };
      view.contentVersion++;
      return route.fulfill({
        json: { saved: true, version: view.contentVersion },
      });
    }
    if (url.pathname.endsWith('/page'))
      return route.fulfill({
        json: {
          token: 'fictional-token',
          messages: [
            {
              id: 'fictional-message',
              createdAt: from + 'T10:00:00Z',
              direction: 'in',
              text: 'дорого, пока не готов заказать',
            },
          ],
          nextOffset: null,
          historyLimited: false,
        },
      });
    if (url.pathname.endsWith('/excerpt'))
      view.excerpts.push({
        id: 'ex1',
        chatId: 'fictional-chat',
        messageId: 'fictional-message',
        messageAt: from + 'T10:00:00Z',
        excerpt: 'дорого, пока не готов заказать',
      });
    return route.fulfill({ json: { saved: true } });
  });
  await page.route('**/api/analytics/avito/deep/history?*', (route) =>
    route.fulfill({ json: { rows: [], nextBefore: null } }),
  );
  await page.route('**/api/analytics/avito/deep/daily?*', (route) =>
    route.fulfill({
      json: {
        days: [
          { date: from, spend: 0, views: 10, contacts: 0 },
          { date: today, spend: null, views: null, contacts: null },
        ],
      },
    }),
  );
  const ready = page.waitForResponse(
    (r) => r.url().includes('/api/analytics/live?') && r.status() === 200,
  );
  await page.goto('http://127.0.0.1:18398/open');
  await ready;
  await page
    .getByText('Полнота данных и оценка прибыли', { exact: true })
    .click();
  await page
    .getByText('50% суммы заказа до рекламы', { exact: true })
    .waitFor();
  await page
    .getByRole('button', { name: 'Детали объявления 1000', exact: true })
    .first()
    .click();
  await page.locator('.ar-materials').waitFor();
  await page.getByText('Текст и фотографии', { exact: true }).click();
  await page
    .getByLabel('Текст объявления', { exact: true })
    .fill('Учебная вывеска. Проверка снимка.');
  await page
    .getByRole('button', { name: 'Сохранить снимок', exact: true })
    .click();
  await page.getByText('Ручной снимок сохранён.', { exact: true }).waitFor();
  assert.equal(posted.filter((p) => p.path.endsWith('/content')).length, 1);
  // Another tab saves v2 while this draft is still based on v1. The unrelated
  // excerpt reload below must not silently rebase this draft onto v2.
  view.contentVersion++;
  view.content.text = 'Сохранено в другой вкладке';
  await page.getByText('Фрагменты переписок', { exact: true }).click();
  await page
    .getByLabel('Диалог (доступно не более 100)')
    .selectOption('fictional-chat');
  await page
    .getByRole('button', { name: 'Прочитать сообщения', exact: true })
    .click();
  await page.locator('.ar-message').click();
  assert(
    await page
      .getByRole('button', { name: 'Сохранить выбранный фрагмент' })
      .isDisabled(),
  );
  await page
    .getByLabel(
      'Проверено: в выбранном фрагменте нет имён, контактов и других личных данных',
    )
    .check();
  await page
    .getByRole('button', { name: 'Сохранить выбранный фрагмент' })
    .click();
  await page
    .getByText('Проверенный фрагмент сохранён с источником.', { exact: true })
    .waitFor();
  assert.equal(posted.filter((p) => p.path.endsWith('/excerpt')).length, 1);
  await page
    .getByRole('button', { name: 'Сохранить снимок', exact: true })
    .click();
  await page
    .getByRole('alert')
    .filter({ hasText: 'Конфликт версии' })
    .waitFor();
  assert.equal(
    posted.filter((p) => p.path.endsWith('/content')).at(-1).data
      .expectedVersion,
    1,
  );
  assert.equal(view.content.text, 'Сохранено в другой вкладке');
  await page
    .getByRole('button', { name: 'Заменить черновик сохранённым снимком' })
    .click();
  await page.waitForFunction(
    () => [...document.querySelectorAll('.ar-materials textarea')].some(t => t.value === 'Сохранено в другой вкладке'),
  );
  fs.writeFileSync(`${out}/fixture-dom.html`, await page.content());
  assert.equal(
    await page.getByLabel('Текст объявления', { exact: true }).inputValue(),
    'Сохранено в другой вкладке',
  );
  await page.getByText('Расходы по дням', { exact: true }).click();
  assert.equal(await page.locator('.ar-table tbody tr').count(), 2);
  assert(
    (await page.locator('.ar-table tbody tr').last().textContent()).includes(
      '—',
    ),
  );
  for (const width of [1440, 384, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForFunction(
      () => document.documentElement.scrollWidth <= innerWidth,
    );
    await page.screenshot({ path: `${out}/page-${width}.png`, fullPage: true });
    await page
      .locator('.ar-materials')
      .screenshot({ path: `${out}/materials-${width}.png` });
  }
  assert.deepEqual(errors, []);
  assert(!(await page.locator('body').textContent()).includes('Invalid Date'));
  fs.writeFileSync(
    `${out}/result.json`,
    JSON.stringify(
      {
        widths: [1440, 384, 320],
        errors,
        posted: posted.map((p) => p.path),
        scope: 'fictional browser; HTTP persistence separately tested',
      },
      null,
      2,
    ),
  );
  console.log(
    'Readiness browser: passed at 1440/384/320; no overflow or JS errors.',
  );
} finally {
  await browser.close();
}
