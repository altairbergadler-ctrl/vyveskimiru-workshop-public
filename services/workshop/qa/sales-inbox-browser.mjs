import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SalesDesk } from '../server/sales-desk.mjs';
import { launchBrowser } from './browser-runtime.mjs';
import { createDirectory, removeDirectory, launch } from './sandbox-lib.mjs';
const dir = createDirectory('sales-inbox-'),
  output = path.resolve('work/validation/sales-inbox');
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
const db = new Database(path.join(dir, 'data/sales.sqlite3'));
let now = Date.now();
const desk = new SalesDesk({ db, now: () => now });
for (let i = 0; i < 1001; i++) {
  now++;
  desk.ingest({
    source: 'avito',
    account: 'fictional-account',
    nativeId: 'fictional-message-' + i,
    version: 'v1',
    conversationId: 'fictional-chat-' + i,
    occurredAt: new Date(now).toISOString(),
    direction: 'in',
    title:
      i === 5
        ? 'Особый макет за рамками первой страницы'
        : 'Учебное сообщение ' + i,
    historical: i !== 0,
  });
}
const extra = desk.db
  .prepare('SELECT data FROM sales_events ORDER BY received_at DESC LIMIT 1')
  .get();
const { owner: _owner, state: _state, ...metadata } = JSON.parse(extra.data);
desk.ingest({
  ...metadata,
  nativeId: 'same-chat-follow-up',
  version: 'v1',
  observedAt: new Date(now).toISOString(),
});
db.close();
let instance, browser;
const errors = [],
  results = [];
try {
  instance = await launch(dir);
  browser = await launchBrowser({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext();
  await context.addCookies([
    { name: 'finance_session', value: instance.token, url: instance.base },
  ]);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(instance.base + '/sales/');
  await page.locator('#app:not([hidden])').waitFor();
  await page.locator('#navigation [data-view=inbox]').click();
  await page.waitForFunction(
    () => document.querySelectorAll('.inbox-item').length === 50,
  );
  assert.equal(await page.locator('#inbox-count').textContent(), '1001');
  const ids = new Set();
  for (let i = 0; i < 21; i++) {
    for (const id of await page
      .locator('.inbox-item [data-chat-open]')
      .evaluateAll((nodes) => nodes.map((n) => n.dataset.chatOpen))) {
      assert.equal(ids.has(id), false);
      ids.add(id);
    }
    const next = page.locator('[data-inbox-next]').first();
    if (await next.isDisabled()) break;
    const old = await page
      .locator('.inbox-item [data-chat-open]')
      .first()
      .getAttribute('data-chat-open');
    await next.click();
    await page.waitForFunction(
      (old) =>
        document.querySelector('.inbox-item [data-chat-open]')?.dataset
          .chatOpen !== old,
      old,
    );
  }
  assert.equal(ids.size, 1001);
  results.push('all 1001 chats reachable without duplicates');
  await page.locator('#search').fill('оСОБЫЙ МАКЕТ');
  await page.waitForFunction(
    () =>
      document.querySelector('.inbox-item strong')?.textContent ===
      'Особый макет за рамками первой страницы',
  );
  assert.equal(await page.locator('.inbox-item').count(), 1);
  assert.match(await page.locator('.inbox-item').textContent(), /Особый макет/);
  assert.equal(await page.locator('#inbox-count').textContent(), '1001');
  results.push('global Russian case-insensitive search reaches old event');
  await page.locator('#search').fill('нет такого учебного сообщения');
  await page
    .getByText('По запросу ничего не найдено', { exact: true })
    .waitFor();
  assert.equal(
    await page.getByText('Входящие разобраны', { exact: true }).count(),
    0,
  );
  results.push('no search match does not claim queue complete');
  await page.locator('#search').fill('');
  await page.waitForFunction(
    () => document.querySelectorAll('.inbox-item').length === 50,
  );
  const first = await page
    .locator('.inbox-item [data-chat-open]')
    .first()
    .getAttribute('data-chat-open');
  let failed = false;
  await page.route('**/api/sales?**', async (route) => {
    if (
      !failed &&
      new URL(route.request().url()).searchParams.get('chatCursor')
    ) {
      failed = true;
      await route.abort('failed');
    } else await route.continue();
  });
  await page.locator('[data-inbox-next]').first().click();
  await page.waitForFunction(
    () => !document.querySelector('[data-inbox-next]')?.disabled,
  );
  assert.equal(
    await page
      .locator('.inbox-item [data-chat-open]')
      .first()
      .getAttribute('data-chat-open'),
    first,
  );
  assert.equal(
    await page.locator('[data-inbox-prev]').first().isDisabled(),
    true,
  );
  await page.unroute('**/api/sales?**');
  await page.locator('[data-inbox-next]').first().click();
  await page.waitForFunction(
    (first) =>
      document.querySelector('.inbox-item [data-chat-open]')?.dataset
        .chatOpen !== first,
    first,
  );
  await page.locator('[data-inbox-prev]').first().click();
  await page.waitForFunction(
    (first) =>
      document.querySelector('.inbox-item [data-chat-open]')?.dataset
        .chatOpen === first,
    first,
  );
  results.push('failed page load preserves cursor; retry and previous work');
  for (const failRefresh of [false, true]) {
    let releasePage,
      releaseRefresh,
      pageReady,
      refreshReady,
      held = false;
    const pageSeen = new Promise((resolve) => {
      pageReady = resolve;
    });
    const refreshSeen = new Promise((resolve) => {
      refreshReady = resolve;
    });
    await page.route('**/api/sales?**', async (route) => {
      if (
        !held &&
        new URL(route.request().url()).searchParams.get('chatCursor')
      ) {
        held = true;
        pageReady();
        await new Promise((resolve) => {
          releasePage = resolve;
        });
        await route.continue();
      } else if (held) {
        refreshReady();
        await new Promise((resolve) => {
          releaseRefresh = resolve;
        });
        if (failRefresh) await route.abort('failed');
        else await route.continue();
      } else await route.continue();
    });
    await page.locator('[data-inbox-next]').first().click();
    await pageSeen;
    await page.locator('#refresh').click();
    await refreshSeen;
    const oldResponse = page.waitForResponse(
      (r) =>
        r.url().includes('/api/sales?') &&
        Boolean(new URL(r.url()).searchParams.get('chatCursor')),
    );
    releasePage();
    await oldResponse;
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseRefresh();
    await page.waitForFunction(
      () => !document.querySelector('[data-inbox-next]')?.disabled,
    );
    assert.equal(
      await page
        .locator('.inbox-item [data-chat-open]')
        .first()
        .getAttribute('data-chat-open'),
      first,
    );
    assert.equal(
      await page.locator('[data-inbox-prev]').first().isDisabled(),
      true,
    );
    await page.unroute('**/api/sales?**');
    results.push(
      'superseded page keeps committed cursor when header refresh ' +
        (failRefresh ? 'fails' : 'succeeds'),
    );
  }
  await page.locator('[data-inbox-next]').first().click();
  await page.waitForFunction(
    (first) =>
      document.querySelector('.inbox-item [data-chat-open]')?.dataset
        .chatOpen !== first,
    first,
  );
  let releaseSearch, searchReady;
  const searchSeen = new Promise((resolve) => {
    searchReady = resolve;
  });
  await page.route('**/api/sales?**', async (route) => {
    if (
      new URL(route.request().url()).searchParams.get('inboxQuery') === 'Особый'
    ) {
      searchReady();
      await new Promise((resolve) => {
        releaseSearch = resolve;
      });
      await route.continue();
    } else await route.continue();
  });
  await page.locator('#search').fill('Особый');
  await searchSeen;
  assert.equal(
    await page.locator('[data-inbox-next]').first().isDisabled(),
    true,
  );
  assert.equal(
    await page.locator('[data-inbox-prev]').first().isDisabled(),
    true,
  );
  releaseSearch();
  await page.waitForFunction(
    () =>
      document.querySelector('.inbox-item strong')?.textContent ===
      'Особый макет за рамками первой страницы',
  );
  assert.equal(await page.locator('.inbox-item').count(), 1);
  assert.equal(
    await page.locator('[data-inbox-prev]').first().isDisabled(),
    true,
  );
  await page.unroute('**/api/sales?**');
  results.push(
    'pending search blocks stale page controls and commits a matching cursor',
  );
  await page.locator('#search').fill('');
  await page.waitForFunction(
    () => document.querySelectorAll('.inbox-item').length === 50,
  );
  await page.locator('[data-inbox-channel="mail"]').count();
  await page.locator('[data-inbox-channel=""]').click();
  await page.waitForFunction(
    () => !document.querySelector('[data-inbox-next]')?.disabled,
  );
  const selected = await page
    .locator('[data-chat-create]')
    .first()
    .getAttribute('data-chat-create');
  let madeId = null,
    noteReads = 0,
    commands = 0,
    automaticPhase = '',
    holdPoll = false,
    releasePoll,
    pollSeen;
  const delayedPoll = new Promise((resolve) => {
    pollSeen = resolve;
  });
  await page.route('**/api/sales/command', async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === 'chat.create') commands++;
    const response = await route.fetch();
    const value = await response.json();
    if (body.action === 'chat.create') madeId = value.noteId;
    await route.fulfill({ response, json: value });
  });
  // Provider output fixture tests polling only; server analysis and live provider are checked separately.
  await page.route('**/api/sales/note?*', async (route) => {
    const response = await route.fetch(),
      value = await response.json();
    if (value.id === madeId) {
      noteReads++;
      value.jobs[0].state = noteReads < 2 ? 'running' : 'done';
      value.analysis =
        noteReads < 2 ? { state: 'running', automatic: false } : null;
      if (noteReads >= 2)
        value.summary = {
          text: 'Учебное саммари чата готово',
          changes: 'Нужно согласовать размеры',
          sources: [],
          watermark: value.watermark,
          at: '2026-10-23T10:00:00Z',
          partial: false,
        };
      if (automaticPhase === 'pending')
        value.analysis = { state: 'pending', automatic: true };
      if (automaticPhase === 'done')
        value.summary.text = 'Саммари после новой реплики';
      if (holdPoll) {
        holdPoll = false;
        pollSeen();
        await new Promise((resolve) => {
          releasePoll = resolve;
        });
      }
    }
    await route.fulfill({ response, json: value });
  });
  await page.locator(`[data-chat-create="${selected}"]`).evaluate((button) => {
    button.click();
    button.click();
  });
  await page.locator('#detail[open]').waitFor();
  assert.equal(await page.locator('#editor').evaluate((el) => el.open), false);
  await page
    .locator('#detail')
    .getByText('Учебное саммари чата готово', { exact: true })
    .waitFor();
  assert.equal(commands, 1);
  const actual = await (
    await context.request.get(instance.base + '/api/sales/note?id=' + madeId)
  ).json();
  assert.equal(actual.events.length, 2);
  assert.equal(actual.jobs[0].state, 'error');
  results.push(
    'one click links both chat messages; double click does not duplicate; summary completion appears without reload',
  );
  automaticPhase = 'pending';
  await page
    .locator('#detail')
    .getByText('Новые сообщения получены.', { exact: false })
    .waitFor();
  assert.equal(
    await page
      .locator('#detail .summary-box')
      .getByText('Учебное саммари чата готово', { exact: true })
      .count(),
    1,
  );
  automaticPhase = 'done';
  await page
    .locator('#detail')
    .getByText('Саммари после новой реплики', { exact: true })
    .waitFor();
  results.push(
    'an already completed open card discovers an automatic job and its new summary without reload',
  );
  holdPoll = true;
  await delayedPoll;
  await page.locator('[data-detail-action="edit"]').click();
  await page
    .locator('#editor-form [name="manual"]')
    .fill('Несохранённый учебный черновик');
  releasePoll();
  await page.waitForTimeout(3500);
  assert.equal(
    await page.locator('#editor-form [name="manual"]').inputValue(),
    'Несохранённый учебный черновик',
  );
  assert.equal(await page.locator('#editor').evaluate((el) => el.open), true);
  await page.locator('[data-cancel-editor]').click();
  results.push(
    'late automatic poll and subsequent ticks preserve an open manager draft',
  );
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: path.join(output, 'automatic-card-' + width + '.png'),
    });
  }
  await page.locator('#close-detail').click();
  await page.unroute('**/api/sales/note?*');
  await page.unroute('**/api/sales/command');
  await page.locator('[data-inbox-scope="all"]').click();
  await page.locator(`[data-open="${madeId}"]`).first().waitFor();
  await page.locator(`[data-open="${madeId}"]`).first().click();
  await page
    .locator('#detail')
    .getByText('Анализ недоступен или прерван.', { exact: false })
    .waitFor();
  results.push(
    'all chats reopens existing card and exposes retryable provider outage',
  );
  await page.locator('#close-detail').click();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: path.join(output, 'inbox-' + width + '.png'),
    });
    results.push('layout ' + width + ' without overflow');
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(output, 'result.json'),
    JSON.stringify({ results, errors }, null, 2),
  );
  console.log(JSON.stringify({ results, errors }));
} finally {
  await browser?.close();
  await instance?.stop();
  removeDirectory(dir);
}
