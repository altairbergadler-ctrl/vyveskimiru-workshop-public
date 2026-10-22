// Run after qa/analytics-compact-preview.mjs. This scenario only uses fictional data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {chromium} = require('C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = 'work/validation/confirmed-finance';
fs.mkdirSync(out, {recursive:true});
const browser = await chromium.launch({channel:'chrome',headless:true});
try {
  const page = await browser.newPage({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  const errors = [], writes = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => {if (!['GET','HEAD'].includes(r.method())) writes.push({method:r.method(),path:new URL(r.url()).pathname});});
  await page.goto('http://127.0.0.1:18398/open');
  const section = page.locator('.ac-tables > section').filter({has:page.getByRole('heading',{name:'Эффективность объявлений',exact:true})});
  const cell = id => section.locator('tbody tr').filter({has:page.getByRole('button',{name:`Детали объявления ${id}`,exact:true})}).locator('[data-label="Заказы / контакты"]');
  await cell('1000').waitFor();
  assert.equal(await cell('1000').textContent(), '—');
  assert.equal(await cell('1001').textContent(), '—');
  const report = () => page.evaluate(async () => (await fetch('/api/analytics/live')).json());
  const before = await report();
  assert(before.rows.every(a => a.receipts === null && a.result === (a.spend == null ? null : -a.spend)));
  const row = id => section.locator('tbody tr').filter({has:page.getByRole('button',{name:`Детали объявления ${id}`,exact:true})});
  assert.equal(await row('1000').locator('[data-label="Поступило"]').textContent(),'—');
  assert.equal(await row('1000').locator('[data-label="Прибыль после рекламы"]').textContent(),'-500 ₽');
  for (const order of ['9001','9002']) {
    await page.getByRole('button',{name:/^Сопоставления ·/}).click();
    const article = page.locator('.al-attribution article').filter({has:page.locator('strong',{hasText:`Заказ №${order} →`})});
    await article.getByRole('button',{name:'Подтвердить связь',exact:true}).click();
    await article.waitFor({state:'detached'});
  }
  await page.getByRole('button',{name:'Обзор',exact:true}).click();
  assert.equal(await cell('1000').textContent(), '11,1%');
  assert.equal(await cell('1001').textContent(), '33,3%');
  const confirmed = await report();
  for (const [id,orderId] of [['1000','9001'],['1001','9002']]) {
    const a = confirmed.rows.find(a => a.id === id), o = before.orders.find(o => o.id === orderId);
    assert.equal(a.receipts,o.receipts);
    assert.equal(a.profit,o.profit);
    assert.equal(a.result,Math.round((o.profit-a.spend)*100)/100);
    assert.equal(await row(id).locator('[data-label="Поступило"]').textContent(),o.receipts.toLocaleString('ru-RU',{maximumFractionDigits:0})+' ₽');
  }
  assert.equal(confirmed.attribution.nextAt, before.attribution.nextAt);
  assert.deepEqual(confirmed.attribution.run, before.attribution.run);
  const linkedCategory = await page.evaluate(async () => {
    const r = await fetch('/api/analytics/live/links',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'ad',entityId:'1002',productId:'category:signs',expectedRevision:0})});
    return r.status;
  });
  assert.equal(linkedCategory,200);
  await page.reload();
  await cell('1000').waitFor();
  const partial = await report();
  assert.equal(partial.products.find(p => p.id === 'category:signs').result,null);
  const categories = page.locator('.ac-tables > section').filter({has:page.getByRole('heading',{name:'Итоги по категориям заказов',exact:true})});
  const categoryRow = categories.locator('tbody tr').filter({has:page.getByRole('button',{name:'Вывески и объёмные буквы',exact:true})});
  assert.equal(await categoryRow.locator('[data-label="Прибыль после рекламы*"]').textContent(),'—');
  await categoryRow.getByText('Известная часть',{exact:true}).waitFor();
  for (const width of [1440,384,320]) {
    await page.setViewportSize({width,height:1000});
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await section.screenshot({path:`${out}/ui-${width}.png`});
  }
  await page.reload();
  await cell('1000').waitFor();
  assert.equal(await cell('1000').textContent(),'11,1%');
  await page.getByRole('button',{name:/^Сопоставления ·/}).click();
  const linked = page.locator('.al-attribution article').filter({has:page.getByText('Заказ №9001',{exact:true})});
  await linked.getByRole('button',{name:'Отменить связь',exact:true}).click();
  await linked.waitFor({state:'detached'});
  await page.getByRole('button',{name:'Обзор',exact:true}).click();
  assert.equal(await cell('1000').textContent(),'—');
  assert.equal(await cell('1001').textContent(),'33,3%');
  assert.equal(await row('1000').locator('[data-label="Поступило"]').textContent(),'—');
  assert.equal(await row('1000').locator('[data-label="Прибыль после рекламы"]').textContent(),'-500 ₽');
  assert.deepEqual(writes.map(r => r.path), ['/api/analytics/live/attribution','/api/analytics/live/attribution','/api/analytics/live/links','/api/analytics/live/attribution']);
  assert(writes.every(r => r.method === 'PUT'));
  assert.deepEqual(errors,[]);
  fs.writeFileSync(`${out}/report.json`,JSON.stringify({ok:true,widths:[1440,384,320],rates:['11,1%','33,3%'],pendingExcluded:true,confirmedMoney:true,partialCategoryBlocked:true,confirmationAndUnlink:true,reload:true,nightlyScheduleUnchanged:true,writes,errors},null,2));
  console.log('Confirmed finance UI passed: distinct rates, confirm/unlink/reload, nightly schedule, 1440/384/320.');
} finally {await browser.close();}
