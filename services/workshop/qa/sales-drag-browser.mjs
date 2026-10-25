import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { productionSheetFixtures } from './production-fixture.mjs';
import { launchBrowser } from './browser-runtime.mjs';
import { createDirectory, removeDirectory, launch } from './sandbox-lib.mjs';
const dir = createDirectory('sales-drag-'),
  out = path.resolve('work/validation/sales-drag');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(
  path.join(dir, 'sheet.json'),
  JSON.stringify(productionSheetFixtures()),
);
let instance, browser;
const results = [],
  errors = [];
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
      value: 'dddddddddddddddddddddddddddddddd',
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
  const cmd = (action, data) =>
    api('/api/sales/command', { requestId: crypto.randomUUID(), action, data });
  const note = await cmd('note.create', {
    title: 'Учебный баннер для кафе',
    owner: 'Анна',
    manual: 'Проверить цвет перед печатью',
  });

  await cmd('layout.patch', { positions: { [note.id]: { x: 30, y: 30 } } });
  const p = await context.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(instance.base + '/sales/');
  await p.locator('.note').waitFor();
  await p.evaluate(() => {
    sessionStorage.setItem(
      'sales.drafts',
      JSON.stringify([
        {
          at: new Date().toISOString(),
          input: {
            requestId: 'old-manual-draft',
            action: 'note.manual',
            data: {
              id: 'fictional-note',
              before: '',
              manual: 'Не потерять ручной текст',
            },
          },
        },
      ]),
    );
  });
  await p.reload();
  await p.locator('.note').waitFor();
  const top = (await p.locator('#content').boundingBox()).y;
  assert.equal(await p.locator('#drafts').isVisible(), true);
  await p.locator('#review-drafts').click();
  assert.match(
    await p.locator('#source-body').innerText(),
    /Не потерять ручной текст/,
  );
  await p.locator('#close-source').click();
  const idle = () =>
    p.waitForFunction(
      () =>
        !JSON.parse(sessionStorage.getItem('sales.pending') || 'null') &&
        !JSON.parse(sessionStorage.getItem('sales.layout-changes') || '[]')
          .length,
    );
  const move = async (dx, dy, { release = true } = {}) => {
    const b = await p
      .waitForFunction(() => {
        const el = document.querySelector('.note');
        return el
          ? JSON.parse(JSON.stringify(el.getBoundingClientRect()))
          : null;
      })
      .then((h) => h.jsonValue());
    // Plain title/text inside the upper third; neither an edge nor the handle.
    const x = b.x + b.width * 0.5,
      y = b.y + b.height * 0.26;
    await p.mouse.move(x, y);
    await p.mouse.down();
    await p.mouse.move(x + dx, y + dy, { steps: 6 });
    if (release) await p.mouse.up();
  };
  await p.evaluate(() => {
    window.jumps = [];
    window.pendingShown = 0;
    window.sample = setInterval(() => {
      window.jumps.push(
        document.querySelector('#content').getBoundingClientRect().y,
      );
      if (!document.querySelector('#pending').hidden) window.pendingShown++;
    }, 10);
  });
  let delays = 0;
  await p.route('**/api/sales/command', async (route) => {
    if (route.request().postDataJSON().action === 'layout.patch') {
      delays++;
      await new Promise((r) => setTimeout(r, 200));
    }
    await route.continue();
  });
  for (let i = 0; i < 3; i++) await move(30, 18);
  const canvas = await p.locator('#content').boundingBox();
  await p.mouse.move(canvas.x + canvas.width - 60, canvas.y + 150);
  await p.mouse.wheel(0, -100);
  await p.waitForTimeout(650);
  await idle();
  await p.unroute('**/api/sales/command');
  const saved = (await api('/api/sales')).layout;
  assert.ok(saved.positions[note.id].x >= 115, JSON.stringify(saved));
  assert.ok(saved.zoom > 1.05);
  assert.ok(delays >= 3);
  assert.equal(await p.evaluate(() => window.pendingShown), 0);
  assert.deepEqual(await p.evaluate(() => [...new Set(window.jumps)]), [top]);
  assert.equal(await p.locator('#notice').isVisible(), false);
  results.push(
    'upper third drag, rapid gestures and wheel save without pending flashes or canvas displacement; genuine draft preserved',
  );
  await p.locator('#arrange').click();
  await idle();
  // A second tab updates a different field while this tab still has its old snapshot.
  await cmd('layout.patch', {
    positions: { [note.id]: { zone: 'parallel-zone' } },
    zones: [{ id: 'parallel-zone', name: 'Замеры' }],
  });
  await move(35, 20);
  await idle();
  const parallel = (await api('/api/sales')).layout;
  assert.equal(parallel.positions[note.id].zone, 'parallel-zone');
  assert.equal(parallel.zones[0].name, 'Замеры');
  assert.equal(await p.locator('#notice').isVisible(), false);
  results.push(
    'stale layout from another tab merges movement without losing its zone or producing conflict drafts',
  );
  let before = (await api('/api/sales')).layout.revision;
  const b = await p.locator('.note').boundingBox();
  await p.mouse.click(b.x + b.width / 2, b.y + b.height * 0.26);
  await p.waitForTimeout(80);
  assert.equal((await api('/api/sales')).layout.revision, before);
  await move(60, 40, { release: false });
  await p.keyboard.press('Escape');
  await p.mouse.up();
  await p.waitForTimeout(80);
  assert.equal((await api('/api/sales')).layout.revision, before);
  assert.equal(
    await p
      .locator('#trash-strip')
      .evaluate((el) => el.classList.contains('drag-active')),
    false,
  );
  await p.locator('[data-pin]').click();
  await idle();
  before = (await api('/api/sales')).layout.revision;
  await move(35, 25);
  await p.waitForTimeout(80);
  assert.equal((await api('/api/sales')).layout.revision, before);
  await p.locator('[data-pin]').click();
  await idle();
  const input = p.locator('[data-quick-note]');
  await input.click();
  await input.fill('Ручной текст после перемещения');
  await p.locator('#zoom-label').click();
  await p.waitForFunction(
    async (id) =>
      (await (await fetch('/api/sales/note?id=' + id)).json()).manual ===
      'Ручной текст после перемещения',
    note.id,
  );
  results.push(
    'header click and Escape never save; pin and one-click manual notes remain interactive',
  );
  let rejectedPatch = false;
  await p.route('**/api/sales/command', async (route) => {
    if (
      !rejectedPatch &&
      route.request().postDataJSON().action === 'layout.patch'
    ) {
      rejectedPatch = true;
      await route.fulfill({
        status: 400,
        json: { error: 'Учебная ошибка раскладки', code: 'SALES_INPUT' },
      });
      return;
    }
    await route.continue();
  });
  await move(15, 10);
  await p.locator('#notice').waitFor({ state: 'visible' });
  await idle();
  const beforeRejected = (await api('/api/sales')).layout.revision;
  await move(20, 12);
  await idle();
  assert.ok((await api('/api/sales')).layout.revision > beforeRejected);
  await p.unroute('**/api/sales/command');
  await p.locator('#dismiss-notice').click();
  results.push(
    'rejected layout patch keeps a draft but cannot poison subsequent gestures',
  );
  const releaseManual = [],
    manualCommitted = [];
  const manualGates = [0, 1].map(
    (i) =>
      new Promise((resolve) => {
        releaseManual[i] = resolve;
      }),
  );
  const committedManual = [0, 1].map(
    (i) =>
      new Promise((resolve) => {
        manualCommitted[i] = resolve;
      }),
  );
  let heldManual = 0;
  await p.route('**/api/sales/command', async (route) => {
    if (
      heldManual < 2 &&
      route.request().postDataJSON().action === 'note.manual'
    ) {
      const i = heldManual++;
      const response = await route.fetch();
      manualCommitted[i]();
      await manualGates[i];
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });
  const draftCount = await p.evaluate(
    () => JSON.parse(sessionStorage.getItem('sales.drafts')).length,
  );
  await p.locator('[data-quick-note]').fill('Первая собственная правка');
  await p.locator('#zoom-label').click();
  await committedManual[0];
  await p.locator('[data-quick-note]').fill('Вторая собственная правка');
  await p.locator('#zoom-label').click();
  releaseManual[0]();
  await committedManual[1];
  await p.waitForFunction(
    () =>
      document.querySelector('[data-quick-note]')?.dataset.before ===
      'Первая собственная правка',
  );
  await p.locator('[data-quick-note]').fill('Ручной текст после перемещения');
  await p.locator('#zoom-label').click();
  releaseManual[1]();
  await p.waitForFunction(
    async (id) =>
      (await (await fetch('/api/sales/note?id=' + id)).json()).manual ===
      'Ручной текст после перемещения',
    note.id,
  );
  await idle();
  assert.equal(
    await p.evaluate(
      () => JSON.parse(sessionStorage.getItem('sales.drafts')).length,
    ),
    draftCount,
  );
  assert.equal(await p.locator('#notice').isVisible(), false);
  await p.unroute('**/api/sales/command');
  results.push(
    'three rapid manual edits wait for their own acknowledgements without inventing an external conflict',
  );
  let failurePhase = 0,
    failedRequestId;
  await p.route('**/api/sales/command', async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === 'layout.patch' && failurePhase === 0) {
      failedRequestId = body.requestId;
      failurePhase = 1;
      await route.abort();
      return;
    }
    if (body.requestId === failedRequestId && failurePhase === 1) {
      failurePhase = 2;
      await route.fulfill({
        status: 400,
        json: { error: 'Предыдущее положение отклонено', code: 'SALES_INPUT' },
      });
      return;
    }
    await route.continue();
  });
  const beforeRecovery = (await api('/api/sales')).layout.positions[note.id].x;
  await move(10, 8);
  await p.locator('#pending').waitFor({ state: 'visible' });
  await move(20, 12);
  assert.equal(
    await p.evaluate(
      () => JSON.parse(sessionStorage.getItem('sales.layout-changes')).length,
    ),
    2,
  );
  await p.locator('#retry-pending').click();
  await idle();
  assert.equal(failurePhase, 2);
  assert.ok(
    (await api('/api/sales')).layout.positions[note.id].x > beforeRecovery + 20,
  );
  await p.unroute('**/api/sales/command');
  await p.locator('#dismiss-notice').click();
  results.push(
    'final rejection during receipt recovery drains the later durable movement without requiring another gesture',
  );
  // Server commits a movement but the network loses its response. The queued UUID is replayed exactly.
  let lost = false;
  await p.route('**/api/sales/command', async (route) => {
    if (!lost && route.request().postDataJSON().action === 'layout.patch') {
      lost = true;
      await route.fetch();
      await route.abort();
      return;
    }
    await route.continue();
  });
  await move(25, 18);
  await p.locator('#pending').waitFor({ state: 'visible' });
  assert.equal((await p.locator('#content').boundingBox()).y, top);
  const committed = (await api('/api/sales')).layout;
  await p.unroute('**/api/sales/command');
  await p.reload();
  await p.locator('#pending').waitFor({ state: 'visible' });
  await p.locator('#retry-pending').click();
  await idle();
  assert.equal((await api('/api/sales')).layout.revision, committed.revision);
  assert.equal(await p.locator('#pending').isVisible(), false);
  results.push(
    'lost response survives reload, verifies receipt and replays layout once without moving canvas',
  );
  const drop = async () => {
    const card = await p.locator('.note').boundingBox(),
      trash = await p.locator('#trash-strip').boundingBox();
    await p.mouse.move(card.x + card.width * 0.5, card.y + card.height * 0.26);
    await p.mouse.down();
    await p.mouse.move(
      trash.x + trash.width * 0.55,
      trash.y + trash.height / 2,
      { steps: 10 },
    );
    assert.equal(
      await p
        .locator('#trash-strip')
        .evaluate((el) => el.classList.contains('drop-ready')),
      true,
    );
    await p.mouse.up();
    await p.locator('.note').waitFor({ state: 'detached' });
  };
  await drop();
  await p.locator('#undo-trash').click();
  await p.locator('.note').waitFor();
  assert.equal(
    await p.locator('[data-quick-note]').inputValue(),
    'Ручной текст после перемещения',
  );
  assert.equal('tasks' in (await api('/api/sales/note?id=' + note.id)), false);
  await drop();
  await p.reload();
  await p.locator('#open-trash').waitFor();
  await p.locator('#open-trash').click();
  let restoreReleased;
  const restoreGate = new Promise((resolve) => {
    restoreReleased = resolve;
  });
  await p.route('**/api/sales/command', async (route) => {
    if (route.request().postDataJSON().action === 'note.restore')
      await restoreGate;
    await route.continue();
  });
  await p.locator('[data-restore]').click();
  await p.locator('#close-source').click();
  restoreReleased();
  await p.locator('.note').waitFor();
  await p.waitForTimeout(150);
  assert.equal(await p.locator('#source-dialog').isVisible(), false);
  await p.unroute('**/api/sales/command');
  assert.deepEqual(
    (await api('/api/sales')).layout.positions[note.id],
    committed.positions[note.id],
  );
  results.push(
    'trash drop highlights, Undo restores, persistent basket restores after reload; manual text and position retained',
  );
  for (const width of [1440, 390, 320]) {
    await p.setViewportSize({ width, height: 1000 });
    await p.waitForTimeout(100);
    assert.equal(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      'overflow ' + width,
    );
    await p.screenshot({
      path: path.join(out, 'desk-' + width + '.png'),
      fullPage: true,
    });
  }
  await p.locator('#content [data-open]').click();
  await p.locator('[data-detail-action=trash]').click();
  await p.locator('.note').waitFor({ state: 'detached' });
  await p.locator('#open-trash').click();
  await p.locator('[data-restore]').click();
  await p.locator('#close-source').click();
  await p.locator('.note').waitFor();
  results.push(
    '1440/390/320 no horizontal overflow; narrow screen has explicit delete and restore actions',
  );
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(out, 'results.json'),
    JSON.stringify({ results, errors }, null, 2),
  );
  console.log(JSON.stringify({ results, errors }, null, 2));
} finally {
  await browser?.close();
  await instance?.stop();
  removeDirectory(dir);
}
