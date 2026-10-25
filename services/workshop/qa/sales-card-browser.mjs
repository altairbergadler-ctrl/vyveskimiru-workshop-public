import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { SalesDesk, salesHash } from '../server/sales-desk.mjs';
import { productionSheetFixtures } from './production-fixture.mjs';
import { launchBrowser } from './browser-runtime.mjs';
import { createDirectory, removeDirectory, launch } from './sandbox-lib.mjs';
const dir = createDirectory('sales-card-'),
  out = path.resolve('work/validation/sales-card');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(
  path.join(dir, 'sheet.json'),
  JSON.stringify(productionSheetFixtures()),
);
let instance, browser, db, finance;
const errors = [],
  results = [];
try {
  instance = await launch(dir, { production: true, mail: true });
  db = new Database(path.join(dir, 'data/sales.sqlite3'));
  finance = new Database(path.join(dir, 'data/finance.sqlite3'));
  const desk = new SalesDesk({ db }),
    account = salesHash('\nINBOX\ndesigner@example.invalid');
  desk.setSetting('intakePolicy', 'new');
  const command = (action, data) =>
    desk.command({ requestId: crypto.randomUUID(), action, data });
  const note = command('note.create', {
    title: 'Вывеска учебной кофейни',
    owner: 'Тест',
    manual: 'Ручной замер остаётся здесь',
  });
  const add = (id, text) => {
    const raw = Buffer.from(
      'From: designer@example.invalid\r\nSubject: Учебный запрос\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' +
        text,
    );
    finance
      .prepare(
        "INSERT INTO mail_messages(key,account_key,raw,state,details,updated_at) VALUES(?,?,?,'done','{}',?)",
      )
      .run(id, account, raw, new Date().toISOString());
    const e = desk.ingest({
      source: 'mail',
      account,
      nativeId: id,
      conversationId: 'card-fixture-chat',
      version: 'v1',
      type: 'mail',
      direction: 'in',
      occurredAt: new Date().toISOString(),
      title: 'Письмо клиента',
    });
    if (!desk.events(note.id).some((x) => x.id === e.id))
      command('event.link', {
        eventId: e.id,
        eventRevision: 1,
        noteId: note.id,
        revision: desk.note(note.id).revision,
      });
    return e;
  };
  add('card-message-1', 'Нужна вывеска для учебной кофейни шириной 2 метра.');
  const selected = add(
    'card-message-2',
    'Ещё нужны наклейки для учебной витрины. Количество пока неизвестно.',
  );
  desk.putNote({
    ...desk.note(note.id),
    summary: {
      text: '## Запрос\n- Вывеска и наклейки для кофейни',
      requestTitle: 'Вывеска и наклейки для кофейни',
      changes: 'Количество уточняется',
      sources: [],
      watermark: desk.watermark(note.id),
      jobId: 'fixture-summary',
      at: new Date().toISOString(),
      coverage: { processed: [], omitted: [], truncated: [] },
      partial: false,
    },
  });
  browser = await launchBrowser({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext();
  await context.addCookies([
    { name: 'finance_session', value: instance.token, url: instance.base },
  ]);
  const p = await context.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  for (const width of [1440, 390, 320]) {
    await p.setViewportSize({ width, height: 950 });
    await p.goto(instance.base + '/sales/');
    await p.locator(`[data-open="${note.id}"]`).first().click();
    await p.locator('.detail-title').waitFor();
    assert.equal(
      await p
        .locator(
          '[data-tab=tasks],[data-tab=history],[data-detail-action=task]',
        )
        .count(),
      0,
    );
    assert.equal(
      await p.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    if (width === 1440) {
      const r = await p.locator('#detail').boundingBox();
      assert.ok(Math.abs(r.x + r.width / 2 - width / 2) < 2);
      assert.ok(Math.abs(r.y + r.height / 2 - 475) < 2);
      await p.mouse.click(5, 475);
      await p.locator('#detail').waitFor({ state: 'hidden' });
      await p.locator(`[data-open="${note.id}"]`).first().click();
    }
    await p.screenshot({ path: path.join(out, `card-${width}.png`) });
    results.push({ width, centered: true, overflow: false });
  }
  await p.setViewportSize({ width: 1440, height: 950 });
  await p.locator('[data-detail-action=split]').click();
  await p.locator(`input[name=eventIds][value="${selected.id}"]`).waitFor();
  assert.match(
    await p.locator('#split-messages').innerText(),
    /Ещё нужны наклейки/,
  );
  await p.locator(`input[name=eventIds][value="${selected.id}"]`).check();
  await p.locator('#editor-form [name=title]').fill('Наклейки для витрины');
  await p.locator('#editor-form button[type=submit]').click();
  await p.locator('#editor').waitFor({ state: 'hidden' });
  await p
    .locator('#detail')
    .getByRole('heading', { name: 'Наклейки для витрины', exact: true })
    .waitFor();
  const separate = desk.notes().find((n) => n.title === 'Наклейки для витрины');
  assert.equal(desk.events(separate.id).length, 1);
  assert.equal(desk.events(note.id).length, 1);
  assert.equal(desk.note(note.id).manual, 'Ручной замер остаётся здесь');
  await p.locator('[data-detail-action=merge]').click();
  await p.locator('#editor-form [name=targetId]').selectOption(note.id);
  await p.locator('#editor-form button[type=submit]').click();
  await p.locator('.merge-preview').waitFor();
  await p.screenshot({ path: path.join(out, 'merge.png') });
  assert.match(await p.locator('.merge-preview').innerText(), /Присоединяем/);
  await p.locator('#editor-form button[type=submit]').click();
  await p.locator('#editor').waitFor({ state: 'hidden' });
  assert.equal(desk.events(note.id).length, 2);
  assert.equal(desk.note(separate.id).status, 'merged');
  results.push({
    splitTextVisible: true,
    selectionTransferred: true,
    mergePreview: true,
  });
  // No draft from AI is available. The existing editor must still open and no Sheet write may precede confirmation.
  let writes = 0;
  p.on('request', (r) => {
    if (
      r.method() === 'POST' &&
      /\/kanban\/api\/(orders|clients)$/.test(new URL(r.url()).pathname)
    )
      writes++;
  });
  let preparationPending = true;
  await p.route('**/api/sales/order-prepare?*', async (route) => {
    if (preparationPending)
      return route.fulfill({
        json: {
          id: 'fixture-root',
          latestId: 'fixture-child',
          state: 'running',
        },
      });
    await route.continue();
  });
  const pendingRead = p.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/sales/order-prepare' &&
      r.request().method() === 'GET',
  );
  await p.locator('[data-detail-action=order]').click();
  await pendingRead;
  assert.match(p.url(), /\/sales\//);
  assert.equal(
    await p.locator('[data-detail-action=order]').isDisabled(),
    true,
  );
  preparationPending = false;
  await p.waitForURL('**/kanban/?action=create&salesNote=*');
  const editor = p.locator('.record-dialog[open]');
  await editor.locator('[name=title]').waitFor();
  assert.equal(writes, 0);
  assert.match(await editor.innerText(), /Дополните|Проверьте/);
  await p.screenshot({
    path: path.join(out, 'partial-order.png'),
    fullPage: true,
  });
  results.push({
    partialOrderOpened: true,
    businessWritesBeforeConfirmation: 0,
  });
  // Restore in a new browser page, with no sessionStorage from the creation tab.
  // The durable server status alone makes continuation accessible.
  let resumed = 0,
    finished = false;
  await context.route('**/api/sales/note?*', async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    await route.fulfill({
      response,
      json: {
        ...data,
        orderId: '123',
        orderTransfer: {
          orderId: '123',
          done: finished,
          processed: finished ? 2 : 1,
          total: 2,
          pending: 0,
          unavailable: 0,
        },
      },
    });
  });
  await context.route('**/api/sales/order-files', async (route) => {
    assert.deepEqual(route.request().postDataJSON(), {
      noteId: note.id,
      orderId: '123',
    });
    resumed++;
    finished = true;
    await route.fulfill({
      json: {
        done: true,
        processed: 2,
        total: 2,
        attached: 2,
        pending: 0,
        unavailable: 0,
      },
    });
  });
  const fresh = await context.newPage();
  fresh.on('pageerror', (e) => errors.push(e.message));
  await fresh.goto(instance.base + '/sales/');
  await fresh.locator(`[data-open="${note.id}"]`).first().click();
  await fresh.locator('[data-detail-action=transfer]').click();
  await fresh.getByText('Файлы перенесены в заказ.', { exact: true }).waitFor();
  assert.equal(resumed, 1);
  assert.equal(writes, 0);
  assert.equal(await fresh.locator('[data-detail-action=order]').count(), 0);
  results.push({
    sourceRetryWaited: true,
    continuationWithoutSessionStorage: true,
    duplicateOrderWrites: 0,
  });
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(out, 'result.json'),
    JSON.stringify({ results, errors }, null, 2),
  );
  console.log(JSON.stringify({ results, errors }));
} finally {
  await browser?.close();
  finance?.close();
  db?.close();
  await instance?.stop();
  removeDirectory(dir);
}
