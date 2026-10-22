import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fixtures } from './fixtures.mjs';
import { createDirectory, launch, removeDirectory, root } from './sandbox-lib.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const directory = createDirectory('order-comment-');
const out = path.join(root, 'work/validation/order-comment');
fs.mkdirSync(out, { recursive: true });
let instance, browser;
const errors = [], writes = [];
try {
  const sheet = JSON.parse(JSON.stringify(fixtures()));
  const column = sheet['Заказы'][0].indexOf('Комментарий');
  const original = 'ПРОДУКЦИЯ\n1. Учебная вывеска\nРазмер 2 × 1 м';
  const separator = '\n\nКОММЕНТАРИЙ К ЗАКАЗУ\n';
  sheet['Заказы'][1][column] = original + separator + 'Согласовать цвет перед изготовлением.';
  const descriptionColumn = sheet['Позиции'][0].indexOf('Описание, макет, адрес');
  assert(descriptionColumn >= 0);
  sheet['Позиции'][1][descriptionColumn] = 'Тип продукции: Объёмные буквы\nСостав: Буквы\nЦвет лица: Белый';
  fs.writeFileSync(path.join(directory, 'sheet.json'), JSON.stringify(sheet));
  instance = await launch(directory);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'finance_session', value: instance.token, url: instance.base, httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'PATCH') writes.push(request.postDataJSON()); });
  const board = async () => (await context.request.get(instance.base + '/kanban/api/board?fresh=1')).json();
  const current = async () => (await board()).orders.find(order => order.id === '9001');
  const openOrder = async (id = '9001') => {
    await page.goto(instance.base + '/kanban/');
    await page.locator(`.order-card[data-order-id="${id}"]`).first().click();
  };
  const edit = async () => page.locator('#order-dialog .order-comment-section button').click();
  const dialog = page.locator('.record-dialog[open]');
  const field = dialog.locator('textarea[name=comment]');
  const save = async () => { await dialog.locator('button[type=submit]').click(); await dialog.waitFor({ state: 'detached' }); };
  await openOrder();
  const description = page.locator('.order-card[data-order-id="9001"] .card-item-description');
  assert.equal(await description.textContent(), 'Объёмные буквы\nСостав: Буквы\nЦвет лица: Белый');
  assert.equal(await description.getAttribute('title'), await description.textContent());
  await edit();
  assert.equal(await dialog.locator('textarea,input,select').count(), 1);
  assert.equal(await field.inputValue(), 'Согласовать цвет перед изготовлением.');
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  assert.equal(writes.length, 0);
  await edit();
  await field.fill('Этот черновик будет отменён');
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  await dialog.getByRole('button', { name: 'Не сохранять', exact: true }).click();
  assert.equal(writes.length, 0);
  const note = 'Лицо — белое, рама — чёрная.\nМонтаж согласовать отдельно. <текст> =SUM(A1)';
  await edit(); await field.fill(note); await save();
  assert.deepEqual(Object.keys(writes.at(-1).changes), ['comment']);
  assert.equal((await current()).comment, original + separator + note);
  await openOrder();
  assert.equal(await page.locator('.order-comment-section .note-box').innerText(), note);
  assert.equal(await page.locator('.original-composition .note-box').textContent(), original);
  for (const width of [1440, 384, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator('.order-comment-section').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, `comment-${width}.png`) });
    await edit();
    assert.equal(await field.inputValue(), note);
    const fits = await dialog.evaluate(node => node.scrollWidth <= node.clientWidth && [...node.querySelectorAll('.record-body,.record-shell')].every(el => el.scrollWidth <= el.clientWidth));
    assert(fits, `Editor overflow at ${width}`);
    await page.screenshot({ path: path.join(out, `editor-${width}.png`) });
    await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Another writer changes the same record while the local draft is open.
  await edit(); await field.fill('Мой черновик');
  const stale = await current();
  const other = await context.request.patch(instance.base + '/kanban/api/records/order', {
    headers: { Origin: instance.base }, data: { record: stale.edit.record, changes: { comment: original + separator + 'Новая запись другого пользователя' } },
  });
  assert(other.ok());
  await dialog.locator('button[type=submit]').click();
  await dialog.getByText('Данные изменились после открытия редактора.', { exact: true }).waitFor();
  assert.equal(await field.inputValue(), 'Мой черновик');
  assert(await dialog.locator('button[type=submit]').isDisabled());
  await dialog.getByRole('button', { name: 'Обновить исходные данные', exact: true }).click();
  await dialog.getByRole('button', { name: 'Оставить мой вариант', exact: true }).click();
  await save();
  assert.equal((await current()).comment, original + separator + 'Мой черновик');
  // Clearing only the visible note must keep the original product description.
  await edit(); await field.fill(''); await save();
  assert.equal((await current()).comment, original);
  await page.getByRole('tab', { name: 'Состав', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить комментарий к заказу', exact: true }).click();
  await field.fill('Добавлено из состава'); await save();
  assert.equal((await current()).comment, original + separator + 'Добавлено из состава');
  // A plain empty comment can also be added and cleared, even with no positions.
  await openOrder('9002'); await edit(); await field.fill('Новый комментарий'); await save();
  await openOrder('9002'); await edit(); assert.equal(await field.inputValue(), 'Новый комментарий');
  await field.fill(''); await save();
  const after = JSON.parse(fs.readFileSync(path.join(directory, 'sheet.json'), 'utf8'));
  assert.equal(after['Заказы'][1][column], original + separator + 'Добавлено из состава');
  assert.equal(after['Заказы'][2][column], '');
  // Ignore only the two intentionally edited cells; every other cell/formula matches.
  after['Заказы'][1][column] = sheet['Заказы'][1][column];
  after['Заказы'][2][column] = sheet['Заказы'][2][column];
  assert.deepEqual(after, sheet);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ ok: true, widths: [1440,384,320], checks: ['single-field editor', 'clean and dirty cancel without writes', 'save and reload', 'legacy description preserved', 'conflict and draft recovery', 'clear and add in both tabs', 'empty order', 'only comment cells changed'], browserErrors: errors }, null, 2));
  console.log('Order comment browser checks passed.');
} finally {
  await browser?.close();
  await instance?.stop();
  removeDirectory(directory);
}
