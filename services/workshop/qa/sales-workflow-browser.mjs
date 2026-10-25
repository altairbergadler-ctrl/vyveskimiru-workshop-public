import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { SalesDesk } from '../server/sales-desk.mjs';
import { productionSheetFixtures } from './production-fixture.mjs';
import { launchBrowser } from './browser-runtime.mjs';
import { createDirectory, removeDirectory, launch } from './sandbox-lib.mjs';
const dir = createDirectory('sales-workflow-'),
  out = path.resolve('work/validation/sales-workflow');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(
  path.join(dir, 'sheet.json'),
  JSON.stringify(productionSheetFixtures()),
);
let instance, browser, db;
const errors = [],
  results = [];
try {
  instance = await launch(dir, { production: true });
  browser = await launchBrowser({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.addCookies([
    { name: 'finance_session', value: instance.token, url: instance.base },
    {
      name: 'sales_layout',
      value: 'cccccccccccccccccccccccccccccccc',
      url: instance.base,
    },
  ]);
  const api = async (url, data) => {
    const r = await context.request.fetch(instance.base + url, {
      method: data ? 'POST' : 'GET',
      headers: { Origin: instance.base },
      ...(data ? { data } : {}),
    });
    assert.equal(r.ok(), true, await r.text());
    return r.json();
  };
  const descriptor = await api('/kanban/api/orders/new');
  const clientOption = descriptor.fields.find((f) => f.id === 'client')
    .options[0];
  const client =
    typeof clientOption === 'string' ? clientOption : clientOption.value;
  assert.ok(client);
  db = new Database(path.join(dir, 'data/sales.sqlite3'));
  const desk = new SalesDesk({ db });
  desk.setSetting('intakePolicy', 'new');
  const event = desk.ingest({
    source: 'avito',
    account: '1234',
    nativeId: 'workflow-message',
    conversationId: 'workflow-chat',
    version: 'v1',
    occurredAt: new Date().toISOString(),
    title: 'Учебный баннер',
  });
  const chat = desk.readChats().items[0];
  const made = desk.command({
    requestId: 'workflow-create',
    action: 'chat.create',
    data: { chatId: chat.id },
  });
  const job = db.prepare('SELECT * FROM sales_jobs WHERE id=?').get(made.jobId);
  desk.finishAnalysis(job, {
    summary:
      '## Запрос\n- Два учебных баннера.\n## Договорённости\n- Размер 3 × 2 м.\n## Уточнить\n- Время монтажа.',
    changes: 'Цена согласована в учебной переписке.',
    sources: [event.id],
    proposals: [
      { action: 'Уточнить', object: 'время монтажа', sources: [event.id] },
    ],
    orderDraft: {
      title: 'Учебные баннеры',
      client,
      description: 'Два баннера 3 × 2 м; без монтажа до подтверждения.',
      amount: 12000,
      desiredDate: '2026-11-01',
      items: [
        {
          name: 'Баннер',
          description: '3 × 2 м, люверсы по периметру',
          quantity: 2,
        },
      ],
      sources: [event.id],
    },
  });
  const note = desk.note(made.noteId);
  desk.putNote({
    ...note,
    title: 'Учебный баннер · ' + 'workflow-chat'.slice(-12),
  });
  db.close();
  db = null;
  const p = await context.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(instance.base + '/sales/');
  await p.locator('.note').waitFor();
  assert.equal(
    await p
      .locator('#shell')
      .evaluate(
        (el) =>
          el.classList.contains('left-collapsed') &&
          el.classList.contains('right-collapsed'),
      ),
    true,
  );
  assert.equal(await p.locator('#view-heading').isVisible(), false);
  assert.equal(await p.locator('#filters').isVisible(), false);
  assert.equal(await p.locator('.note h3').innerText(), 'Учебные баннеры');
  assert.equal(await p.locator('.note .next-task,.note .due').count(), 0);
  await p.locator('#toggle-navigation').click();
  assert.equal(
    await p.locator('#toggle-navigation').getAttribute('aria-expanded'),
    'true',
  );
  await p.locator('#toggle-navigation').click();
  await p.locator('#toggle-today').click();
  assert.equal(await p.locator('#today-list').isVisible(), true);
  await p.locator('#toggle-today').click();
  results.push(
    'clean card title, no deadline/role/task block; both panels collapsed by default and expandable',
  );
  await p.locator('#navigation [data-view=archive]').click();
  await p.locator('#status-filter').selectOption('merged');
  await p.locator('#unread-filter').check();
  await p.locator('#navigation [data-view=desk]').click();
  await p.locator('.note').waitFor();
  assert.equal(await p.locator('#filters').isVisible(), false);
  results.push('hidden archive filters cannot hide active desk cards');
  const quick = p.locator('[data-quick-note]');
  await quick.click();
  await quick.fill('Ручная заметка в один клик');
  await p.locator('#zoom-label').click();
  await p.waitForFunction(
    async (id) =>
      (await (await fetch('/api/sales/note?id=' + id)).json()).manual ===
      'Ручная заметка в один клик',
    made.noteId,
  );
  assert.equal(
    (await api('/api/sales/note?id=' + made.noteId)).summary.text.startsWith(
      '## Запрос',
    ),
    true,
  );
  await p.reload();
  await p.locator('.note').waitFor();
  assert.equal(
    await p.locator('[data-quick-note]').inputValue(),
    'Ручная заметка в один клик',
  );
  results.push(
    'inline note saves and survives reload without changing summary',
  );
  const canvas = await p.locator('#content').boundingBox();
  await p.mouse.move(canvas.x + canvas.width - 130, canvas.y + 160);
  await p.mouse.wheel(0, -180);
  await p.waitForFunction(
    async () => (await (await fetch('/api/sales')).json()).layout.zoom > 1.05,
  );
  const oldTransform = await p
    .locator('.board')
    .evaluate((el) => el.style.transform);
  await p.mouse.down({ button: 'middle' });
  await p.mouse.move(canvas.x + canvas.width - 230, canvas.y + 220, {
    steps: 5,
  });
  await p.mouse.up({ button: 'middle' });
  assert.notEqual(
    await p.locator('.board').evaluate((el) => el.style.transform),
    oldTransform,
  );
  // Return all cards to the visible viewport after zooming around empty space.
  await p.locator('#arrange').click();
  await p.waitForTimeout(350);
  for (const edge of ['top', 'right', 'bottom', 'left']) {
    await p.locator('.edge-' + edge).waitFor({ state: 'visible' });
    const b = await p.locator('.edge-' + edge).evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }),
      before = (await api('/api/sales')).layout.positions[made.noteId];
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await p.mouse.down();
    await p.mouse.move(b.x + b.width / 2 + 24, b.y + b.height / 2 + 18, {
      steps: 4,
    });
    await p.mouse.up();
    await p.waitForFunction(
      async ({ id, x }) =>
        (await (await fetch('/api/sales')).json()).layout.positions[id].x > x,
      { id: made.noteId, x: before.x },
    );
  }
  results.push(
    'wheel zoom persists, middle mouse pans, all four card edges drag',
  );
  await p.locator('#content [data-open="' + made.noteId + '"]').click();
  assert.equal(
    await p.locator('.formatted-summary h4').first().innerText(),
    'Запрос',
  );
  assert.equal(
    await p
      .locator(
        '[data-task-state],[data-detail-action=task],[data-tab=tasks],[data-tab=history]',
      )
      .count(),
    0,
  );
  results.push('formatted summary; task proposals and history are absent');
  let sends = 0,
    lastSend;
  const messages = Array.from({ length: 105 }, (_, i) => ({
    id: 'chat-fixture-' + i,
    createdAt: new Date(Date.now() - (105 - i) * 60000).toISOString(),
    direction: i % 2 ? 'out' : 'in',
    type: 'text',
    text:
      i === 104
        ? '<img src=x onerror=alert(1)> Учебный вопрос'
        : 'Вымышленное сообщение ' + i,
  }));
  let firstRead = true,
    allowFirstRead;
  const firstReadGate = new Promise((resolve) => {
    allowFirstRead = resolve;
  });
  await p.route('**/api/sales/chat?*', async (route) => {
    if (firstRead) {
      firstRead = false;
      await firstReadGate;
    }
    const offset = Number(
      new URL(route.request().url()).searchParams.get('offset') || 0,
    );
    return route.fulfill({
      json: {
        chatId: chat.id,
        title: 'Учебный чат',
        source: 'avito',
        url: 'https://www.avito.ru/profile/messenger/channel/workflow-chat',
        canSend: true,
        messages: [...messages].reverse().slice(offset, offset + 100),
        offset,
        hasMore: messages.length > offset + 100,
        limited: false,
      },
    });
  });
  await p.route('**/api/sales/chat/send', async (route) => {
    sends++;
    lastSend = route.request().postDataJSON();
    await new Promise((r) => setTimeout(r, 300));
    messages.push({
      id: 'sent-fixture',
      createdAt: new Date().toISOString(),
      direction: 'out',
      type: 'text',
      text: lastSend.text,
    });
    await route.fulfill({ json: { state: 'sent', messageId: 'sent-fixture' } });
  });
  await p.locator('[data-chat-open]').first().click();
  assert.equal(await p.locator('#chat-loading').isVisible(), true);
  assert.equal(
    await p.locator('#chat-loading').textContent(),
    'Загружаю переписку…',
  );
  allowFirstRead();
  await p.locator('.message').first().waitFor();
  assert.equal(await p.locator('.message').count(), 100);
  assert.equal(await p.locator('#chat-messages img').count(), 0);
  await p.locator('#chat-older').click();
  await p.waitForFunction(
    () => document.querySelectorAll('.message').length === 105,
  );
  await p.locator('#chat-text').fill('Учебный ответ из стола');
  await p.locator('#chat-send').evaluate((b) => {
    b.click();
    b.click();
  });
  await p.getByText('Отправлено', { exact: true }).waitFor();
  assert.equal(sends, 1);
  assert.equal(lastSend.chatId, chat.id);
  await p.locator('#chat-text').fill('Несохранённый ответ');
  await p.locator('#chat-refresh').click();
  await p.waitForTimeout(200);
  assert.equal(
    await p.locator('#chat-text').inputValue(),
    'Несохранённый ответ',
  );
  for (const width of [1440, 390, 320]) {
    await p.setViewportSize({ width, height: 900 });
    assert.equal(
      await p.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await p.screenshot({ path: path.join(out, 'chat-' + width + '.png') });
  }
  results.push(
    'chat has ordered incoming/outgoing messages, earlier pages, escaped text, one send per double click and preserved compose draft',
  );
  // A late receipt from a closed chat must not erase the next send's durable ID.
  await p.unroute('**/api/sales/chat/send');
  const waiting = [];
  await p.route('**/api/sales/chat/send', (route) => {
    waiting.push({ route, input: route.request().postDataJSON() });
  });
  const nextSend = async () => {
    for (let i = 0; i < 100; i++) {
      if (waiting.length) return waiting.shift();
      await p.waitForTimeout(25);
    }
    throw new Error('Expected chat send');
  };
  const sendKey = 'sales.chat-send.' + chat.id;
  await p.locator('#chat-text').fill('Первый задержанный ответ');
  await p.locator('#chat-send').click();
  const first = await nextSend();
  await p.locator('#close-source').click();
  await p.locator('[data-chat-open]').first().click();
  await p.locator('#chat-compose:not([hidden])').waitFor();
  await p.locator('#chat-send').click();
  const replay = await nextSend();
  assert.equal(replay.input.requestId, first.input.requestId);
  await replay.route.fulfill({ json: { state: 'sent', messageId: 'late-a' } });
  await p.getByText('Отправлено', { exact: true }).waitFor();
  await p.locator('#chat-text').fill('Следующий ответ');
  await p.locator('#chat-send').click();
  const following = await nextSend();
  assert.notEqual(following.input.requestId, first.input.requestId);
  await first.route.fulfill({ json: { state: 'sent', messageId: 'late-a' } });
  await p.waitForTimeout(150);
  assert.equal(
    await p.evaluate(
      (key) => JSON.parse(sessionStorage.getItem(key)).requestId,
      sendKey,
    ),
    following.input.requestId,
  );
  await following.route.fulfill({
    status: 503,
    json: { code: 'SALES_SEND_UNKNOWN', error: 'Вымышленный потерянный ответ' },
  });
  await p.getByText('Отправка не подтверждена', { exact: true }).waitFor();
  await p.locator('#chat-send').click();
  const followingReplay = await nextSend();
  assert.equal(followingReplay.input.requestId, following.input.requestId);
  await followingReplay.route.fulfill({
    json: { state: 'sent', messageId: 'late-b' },
  });
  await p.getByText('Отправлено', { exact: true }).waitFor();
  results.push(
    'late success from a closed chat preserves a newer send receipt and its lost-response replay UUID',
  );
  const resolving = [];
  await p.route('**/api/sales/chat/resolve', (route) => {
    resolving.push({ route, input: route.request().postDataJSON() });
  });
  const nextResolve = async () => {
    for (let i = 0; i < 100; i++) {
      if (resolving.length) return resolving.shift();
      await p.waitForTimeout(25);
    }
    throw new Error('Expected explicit resolution');
  };
  await p.locator('#chat-text').fill('Ответ до восстановления входа');
  await p.locator('#chat-send').click();
  const rejected = await nextSend();
  await rejected.route.fulfill({
    status: 401,
    json: { code: 'AUTH_REQUIRED', error: 'Вымышленный истекший вход' },
  });
  await p.getByText('Отправка не подтверждена', { exact: true }).waitFor();
  await p.locator('#chat-text').fill('Исправленный ответ');
  await p.locator('#chat-send').click();
  assert.equal(waiting.length, 0);
  await p.locator('#chat-resolve').click();
  const firstResolution = await nextResolve();
  await p.locator('#close-source').click();
  await p.locator('[data-chat-open]').first().click();
  await p.locator('#chat-compose:not([hidden])').waitFor();
  await p.locator('#chat-send').click();
  await p.locator('#chat-resolve').click();
  const secondResolution = await nextResolve();
  assert.equal(secondResolution.input.requestId, rejected.input.requestId);
  await secondResolution.route.fulfill({ json: { state: 'resolved' } });
  await p.getByText('Можно отправить повторно.', { exact: true }).waitFor();
  await p.locator('#chat-send').click();
  const afterResolution = await nextSend();
  assert.notEqual(afterResolution.input.requestId, rejected.input.requestId);
  await firstResolution.route.fulfill({ json: { state: 'resolved' } });
  await p.waitForTimeout(150);
  assert.equal(
    await p.evaluate(
      (key) => JSON.parse(sessionStorage.getItem(key)).requestId,
      sendKey,
    ),
    afterResolution.input.requestId,
  );
  await afterResolution.route.fulfill({
    json: { state: 'sent', messageId: 'after-resolution' },
  });
  await p.getByText('Отправлено', { exact: true }).waitFor();
  results.push(
    'explicit recovery from a pre-receipt refusal works; late resolution preserves the next send UUID',
  );
  const wav = Buffer.alloc(44 + 8000, 128);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(8000, 40);
  await p.route('**/qa-voice.wav', (route) =>
    route.fulfill({ contentType: 'audio/wav', body: wav }),
  );
  messages.push({
    id: 'playing-voice',
    createdAt: new Date().toISOString(),
    direction: 'in',
    type: 'voice',
    text: '',
    media: [
      {
        id: 'voice',
        kind: 'audio',
        name: 'Учебное голосовое',
        available: true,
        url: '/qa-voice.wav',
        source: 'avito',
      },
    ],
  });
  await p.locator('#chat-refresh').click();
  await p.locator('#chat-messages audio').waitFor();
  await p.locator('#chat-messages audio').evaluate(async (player) => {
    player.loop = true;
    player.dataset.playbackProbe = 'preserved';
    await player.play();
  });
  // A lost HTTP response has no SalesError code. Fresh-read failure must keep
  // human resolution disabled until a newer successful read shows the provider.
  await p.unroute('**/api/sales/chat/send');
  let failedFreshRead = true,
    physicalLostSend = 0;
  await p.route('**/api/sales/chat?*', (route) =>
    failedFreshRead &&
    new URL(route.request().url()).searchParams.get('offset') === '0'
      ? route.fulfill({
          status: 503,
          json: { error: 'Учебный источник пока недоступен' },
        })
      : route.fallback(),
  );
  await p.route('**/api/sales/chat/send', async (route) => {
    physicalLostSend++;
    messages.push({
      id: 'lost-http-accepted',
      createdAt: new Date().toISOString(),
      direction: 'out',
      type: 'text',
      text: route.request().postDataJSON().text,
    });
    await route.abort('failed');
  });
  await p.locator('#chat-text').fill('Принятый ответ с потерей HTTP');
  await p.locator('#chat-send').click();
  await p
    .locator('#chat-error')
    .getByText('Учебный источник пока недоступен', { exact: true })
    .waitFor();
  assert.equal(await p.locator('#chat-resolve').isVisible(), true);
  assert.equal(await p.locator('#chat-resolve').isDisabled(), true);
  await p.locator('#chat-older').click();
  await p.locator('#chat-loading').waitFor({ state: 'hidden' });
  assert.equal(await p.locator('#chat-resolve').isDisabled(), true);
  assert.equal(
    await p
      .locator('#chat-messages')
      .getByText('Принятый ответ с потерей HTTP', { exact: true })
      .count(),
    0,
  );
  failedFreshRead = false;
  await p.locator('#chat-refresh').click();
  await p
    .locator('#chat-messages')
    .getByText('Принятый ответ с потерей HTTP', { exact: true })
    .waitFor();
  assert.equal(await p.locator('#chat-resolve').isEnabled(), true);
  assert.equal(physicalLostSend, 1);
  assert.deepEqual(
    await p.locator('#chat-messages audio').evaluate((player) => ({
      playing: !player.paused,
      probe: player.dataset.playbackProbe,
    })),
    { playing: true, probe: 'preserved' },
  );
  await p.locator('#chat-messages audio').evaluate((player) => player.pause());
  results.push(
    'lost HTTP send response triggers a fresh read; failed read cannot enable resolution, accepted reply appears during uninterrupted voice playback without a resend',
  );
  await p.locator('#close-source').click();
  await p.setViewportSize({ width: 1440, height: 1000 });
  await p.screenshot({ path: path.join(out, 'summary.png') });
  let writes = 0;
  p.on('request', (req) => {
    if (
      req.method() === 'POST' &&
      new URL(req.url()).pathname === '/kanban/api/orders'
    )
      writes++;
  });
  await p.locator('[data-detail-action=order]').click();
  await p.waitForURL('**/kanban/?action=create&salesNote=*');
  const editor = p.locator('.record-dialog[open]');
  await editor.locator('[name=title]').waitFor();
  assert.equal(
    await editor.locator('[name=title]').inputValue(),
    'Учебные баннеры',
  );
  assert.equal(
    await editor.locator('[name=amountOverride]').inputValue(),
    '12000',
  );
  assert.equal(
    await editor.locator('[name=desiredDate]').inputValue(),
    '2026-11-01',
  );
  assert.match(
    await editor.locator('[name=comment]').inputValue(),
    /Ручная заметка/,
  );
  assert.match(
    await editor.locator('.client-selected').innerText(),
    new RegExp(client),
  );
  assert.equal(await editor.locator('[data-edit="0"]').count(), 1);
  assert.equal(writes, 0);
  await p.screenshot({
    path: path.join(out, 'order-review.png'),
    fullPage: true,
  });
  const attempts = [];
  await p.route('**/kanban/api/orders', async (route) => {
    const input = route.request().postDataJSON();
    attempts.push(input.requestId);
    if (attempts.length === 1) {
      const journal = path.join(dir, 'data/orders/creation');
      fs.mkdirSync(journal, { recursive: true });
      const payloadHash = crypto
        .createHash('sha256')
        .update(
          JSON.stringify(
            Object.fromEntries(
              Object.keys(input.changes)
                .sort()
                .map((key) => [key, input.changes[key]]),
            ),
          ),
        )
        .digest('hex');
      fs.writeFileSync(
        path.join(journal, input.requestId + '.json'),
        JSON.stringify({
          requestId: input.requestId,
          payloadHash,
          state: 'aborted',
        }),
      );
    }
    await route.continue();
  });
  const refused = p.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/kanban/api/orders' && r.status() === 409,
  );
  await editor
    .getByRole('button', { name: 'Создать заказ', exact: true })
    .click();
  assert.equal(
    (await (await refused).json()).code,
    'ORDER_CREATE_SOURCE_CHANGED',
  );
  await editor.getByText(/Таблица изменилась до отправки заказа/).waitFor();
  await editor
    .getByRole('button', { name: 'Создать заказ', exact: true })
    .click();
  await p.locator('.record-dialog[open]').waitFor({ state: 'hidden' });
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0], attempts[1]);
  await p.waitForFunction(
    async (id) =>
      Boolean((await (await fetch('/api/sales/note?id=' + id)).json()).orderId),
    made.noteId,
  );
  assert.equal(writes, 2);
  const linked = await api('/api/sales/note?id=' + made.noteId);
  const board = await api('/kanban/api/board?fresh=1'),
    created = board.orders.find((o) => String(o.id) === linked.orderId);
  assert.ok(created);
  assert.equal(created.title, 'Учебные баннеры');
  assert.equal(
    board.orders.filter((o) => o.title === 'Учебные баннеры').length,
    1,
  );
  results.push(
    'order form prefilled; no writes before human confirmation; canonical aborted receipt advances safely to one confirmed linked order',
  );
  await p.goto(instance.base + '/sales/');
  await p.locator('.note').waitFor();
  for (const width of [1440, 390, 320]) {
    await p.setViewportSize({ width, height: 900 });
    assert.equal(
      await p.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await p.screenshot({ path: path.join(out, 'desk-' + width + '.png') });
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(out, 'result.json'),
    JSON.stringify({ results, errors }, null, 2),
  );
  console.log(JSON.stringify({ results, errors }));
} finally {
  db?.close();
  await browser?.close();
  await instance?.stop();
  removeDirectory(dir);
}
