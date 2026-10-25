import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { SalesDesk } from '../server/sales-desk.mjs';
import { productionSheetFixtures } from './production-fixture.mjs';
import { launchBrowser } from './browser-runtime.mjs';
import { createDirectory, removeDirectory, launch } from './sandbox-lib.mjs';
const dir = createDirectory('sales-layout-'),
  out = path.resolve('work/validation/sales-layout');
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
      value: 'dddddddddddddddddddddddddddddddd',
      url: instance.base,
    },
  ]);
  const api = async (url, data) => {
    const response = await context.request.fetch(instance.base + url, {
      method: data ? 'POST' : 'GET',
      headers: { Origin: instance.base },
      ...(data ? { data } : {}),
    });
    assert.equal(response.ok(), true, await response.text());
    return response.json();
  };
  const command = (action, data) =>
    api('/api/sales/command', { requestId: crypto.randomUUID(), action, data });
  db = new Database(path.join(dir, 'data/sales.sqlite3'));
  let now = Date.parse('2026-10-20T09:00:00Z');
  const desk = new SalesDesk({ db, now: () => now });
  const notes = [];
  for (const title of ['Самая старая', 'Средняя', 'Самая новая']) {
    notes.push(
      desk.command({
        requestId: crypto.randomUUID(),
        action: 'note.create',
        data: { title, client: 'Учебный клиент', owner: 'Руководитель' },
      }),
    );
    now += 3600000;
  }
  // Recent edits must not promote an older card above genuinely new ones.
  desk.putNote({
    ...desk.note(notes[0].id),
    manual: 'Свежая правка старой записки',
  });
  const positions = Object.fromEntries(
    notes.map((n, i) => [n.id, { x: 50 + i * 410, y: 110 + i * 90 }]),
  );
  await command('layout.patch', { positions });
  const saved = (await api('/api/sales')).layout.positions;
  const p = await context.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(instance.base + '/sales/');
  await p.locator('.note').first().waitFor();
  const ids = () =>
    p.locator('.note').evaluateAll((nodes) => nodes.map((n) => n.dataset.note));
  const expected = notes.map((n) => n.id).reverse();
  await p.locator('#toggle-newest').click();
  await p.waitForFunction(
    async () =>
      (await (await fetch('/api/sales')).json()).layout.mode === 'newest',
  );
  assert.deepEqual(await ids(), expected);
  const geometry = await p.locator('.note').evaluateAll((nodes) =>
    nodes.map((n) => ({
      top: parseFloat(n.style.top),
      left: parseFloat(n.style.left),
    })),
  );
  assert.equal(geometry[0].top, 10);
  assert.equal(geometry[1].top, 10);
  assert.ok(geometry[1].left > geometry[0].left);
  await p.reload();
  await p.locator('.note').first().waitFor();
  assert.deepEqual(await ids(), expected);
  assert.equal(
    await p.locator('#toggle-newest').getAttribute('aria-pressed'),
    'true',
  );
  const fresh = await command('note.create', {
    title: 'Новая после включения режима',
    client: 'Учебный клиент',
    owner: 'Руководитель',
  });
  await p.locator('#refresh').click();
  await p.locator(`[data-note="${fresh.id}"]`).waitFor();
  assert.deepEqual(await ids(), [fresh.id, ...expected]);
  const card = p.locator(`[data-note="${notes[2].id}"]`),
    b = await card.boundingBox();
  await p.mouse.move(b.x + b.width / 2, b.y + 80);
  await p.mouse.down();
  await p.mouse.move(b.x + b.width / 2 + 50, b.y + 125, { steps: 5 });
  await p.mouse.up();
  assert.deepEqual((await api('/api/sales')).layout.positions, saved);
  for (const width of [1440, 390, 320]) {
    await p.setViewportSize({ width, height: 1000 });
    assert.deepEqual(await ids(), [fresh.id, ...expected]);
    assert.equal(await p.locator('#toggle-newest').isVisible(), true);
    assert.equal(
      await p.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await p.screenshot({
      path: path.join(out, `newest-${width}.png`),
      fullPage: true,
    });
    results.push({ width, sorted: true, overflow: false });
  }
  await p.locator('#toggle-newest').click();
  await p.waitForFunction(
    async () =>
      (await (await fetch('/api/sales')).json()).layout.mode === 'free',
  );
  await p.locator('#toggle-newest').click();
  await p.waitForFunction(
    async () =>
      (await (await fetch('/api/sales')).json()).layout.mode === 'newest',
  );
  assert.deepEqual(await ids(), [fresh.id, ...expected]);
  await p.setViewportSize({ width: 1440, height: 1000 });
  await p.locator('#toggle-newest').click();
  await p.waitForFunction(
    async () =>
      (await (await fetch('/api/sales')).json()).layout.mode === 'free',
  );
  assert.deepEqual((await api('/api/sales')).layout.positions, saved);
  for (const n of notes)
    assert.deepEqual(
      await p.locator(`[data-note="${n.id}"]`).evaluate((el) => ({
        x: parseFloat(el.style.left),
        y: parseFloat(el.style.top),
      })),
      positions[n.id],
    );
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(out, 'report.json'),
    JSON.stringify(
      {
        results,
        persisted: true,
        newCardsFirst: true,
        freePositionsRestored: true,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      results,
      persisted: true,
      newCardsFirst: true,
      freePositionsRestored: true,
      errors,
    }),
  );
} finally {
  await browser?.close();
  if (db?.open) db.close();
  await instance?.stop();
  removeDirectory(dir);
}
