// Run against qa/analytics-compact-preview.mjs --complete-expenses; fictional data only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = 'work/validation/response-times';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  const errors = [], writes = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (!['GET', 'HEAD'].includes(r.method())) writes.push(r.method()); });
  const response = page.waitForResponse(r => r.url().includes('/api/analytics/live?') && r.status() === 200);
  await page.goto('http://127.0.0.1:18398/open');
  const report = await (await response).json();
  assert.equal(report.rows.find(a => a.id === '1000').firstResponseSeconds,180);
  assert.equal(report.rows.find(a => a.id === '1001').responseStats.waiting,1);
  assert.equal(report.responses.summary.answered,2);
  assert(report.rows.every(a => a.result === (a.spend == null ? null : -a.spend)));
  const section = page.locator('.ac-tables > section').filter({ has: page.getByRole('heading', { name: 'Эффективность объявлений', exact: true }) });
  const rows = section.locator('tbody tr');
  await rows.first().waitFor();
  for (const ad of report.rows.filter(a => a.spend != null)) {
    const row = rows.filter({ has: page.getByRole('button', { name: `Детали объявления ${ad.id}`, exact: true }) });
    assert.equal(await row.locator('[data-label="Прибыль после рекламы"]').textContent(), ad.result.toLocaleString('ru-RU') + ' ₽');
    assert.equal(await row.locator('[data-label="Подтверждённые заказы"]').textContent(), '0');
  }
  // A controlled UI response covers positive, zero, negative and unknown values,
  // Russian/numeric names, ties and every column without writing business data.
  const data = structuredClone(report);
  const values = [3, 0, null, 12, 2, 3, 1, 8];
  data.rows = data.rows.slice(0, values.length).map((a, i) => ({ ...a,
    title: ['Яркая вывеска', 'Баннер 10', 'Баннер 2', 'Афиша', 'Штендер', 'Баннер 10', 'Оклейка', 'Вывеска'][i],
    firstResponseSeconds: values[i] == null ? null : values[i]*60, responseStats: { answered:values[i]==null?0:2, waiting:1,unknown:0 },
    contacts: values[i], confirmedOrders: values[i], orderRate: values[i],
    receipts: values[i] == null ? null : values[i] * 200,
    spend: values[i] == null ? null : values[i] * 100,
    result: values[i] == null ? null : (values[i] - 3) * 100,
  }));
  await page.route('**/api/analytics/live?*', route => route.fulfill({ json: data }));
  await page.reload();
  await page.getByRole('button', { name: 'Объявления · 8', exact: true }).click();
  const keys = ['title', 'contacts', 'confirmedOrders', 'orderRate', 'spend', 'receipts', 'result', 'firstResponseSeconds'];
  const labels = ['Объявление', 'Контакты', 'Заказы', 'Заказы / контакты', 'Расходы', 'Поступило', 'Прибыль после рекламы', 'Первый ответ'];
  const select = section.getByLabel('Сортировка объявлений');
  const ids = async () => (await rows.locator('td:first-child button').all()).reduce(async (promise, button) => [...await promise, (await button.getAttribute('aria-label')).replace('Детали объявления ', '')], Promise.resolve([]));
  async function verify(key, direction) {
    const ordered = (await ids()).map(id => data.rows.find(a => a.id === id));
    assert.equal(ordered.length, 8);
    assert.equal(new Set(ordered.map(a => a.id)).size, 8);
    let unknown = false;
    for (let i = 0; i < ordered.length; i++) {
      const value = ordered[i][key];
      if (value == null) { unknown = true; continue; }
      assert.equal(unknown, false, 'Unknowns must be last in both directions');
      if (i && ordered[i - 1][key] != null) {
        const previous = ordered[i - 1][key];
        const compare = key === 'title' ? previous.localeCompare(value, 'ru', { numeric: true }) : previous - value;
        assert(direction === 'asc' ? compare <= 0 : compare >= 0, `${key}:${direction}`);
      }
    }
  }
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i], first = key === 'title' ? 'asc' : 'desc';
    // Select another column so the first header click tests its default direction.
    await select.selectOption(`${key === 'title' ? 'contacts' : 'title'}:desc`);
    const header = section.locator('th').nth(i), button = header.getByRole('button');
    await button.click();
    assert.equal(await header.getAttribute('aria-sort'), first === 'asc' ? 'ascending' : 'descending');
    assert.equal(await select.inputValue(), `${key}:${first}`);
    await verify(key, first);
    await button.focus();
    await page.keyboard.press('Enter');
    await verify(key, first === 'asc' ? 'desc' : 'asc');
    assert((await button.textContent()).includes(labels[i]));
  }
  await select.selectOption('title:asc');
  await section.getByLabel('Поиск объявления').fill('Баннер');
  assert.equal(await rows.count(), 3);
  assert((await rows.first().textContent()).includes('Баннер 2'));
  await section.getByLabel('Поиск объявления').fill('');
  for (const width of [1440, 384, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const key of keys) for (const direction of ['asc', 'desc']) {
      await select.selectOption(`${key}:${direction}`);
      await verify(key, direction);
    }
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
    await section.screenshot({ path: `${out}/ui-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Обзор', exact: true }).click();
  await section.getByRole('button', { name: 'Загрузить ещё' }).click();
  assert.equal(await rows.count(), 8);
  await section.locator('th').first().getByRole('button').click();
  assert.equal(await rows.count(), 4);
  await section.getByRole('button', { name: 'Загрузить ещё' }).click();
  await verify('title', 'asc');
  await page.getByLabel('Среднее время первого ответа', {exact:true}).check();
  const chart=page.locator('.ac-plot').filter({hasText:'Время первого ответа'});
  await chart.waitFor();
  assert((await page.locator('.ac-chart-values').textContent()).includes('3 мин'));
  await page.getByLabel('Группировка графика').selectOption('week');
  assert((await page.locator('.ac-chart-values').textContent()).includes('3 мин'));
  for(const width of [1440,384,320]) {
    await page.setViewportSize({width,height:1000});
    await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth);
    await page.locator('.ac-response-status').screenshot({path:`${out}/status-${width}.png`});
    await page.locator('.ac-chart').screenshot({path:`${out}/chart-${width}.png`});
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(writes, []);
  fs.writeFileSync(`${out}/report.json`, JSON.stringify({ ok: true, realBackendLoss: true, columns: keys, directions: ['asc', 'desc'], nullsLast: true, keyboard: true, filter: true, loadMore: true, widths: [1440,384,320], errors, writes }, null, 2));
  console.log('Ad losses and all eight sortable columns passed at 1440/384/320; no writes or JS errors.');
} finally { await browser.close(); }
