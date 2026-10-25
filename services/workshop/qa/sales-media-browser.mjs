import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SalesDesk, salesHash } from '../server/sales-desk.mjs';
import { launchBrowser } from './browser-runtime.mjs';
import { createDirectory, removeDirectory, launch } from './sandbox-lib.mjs';
const dir = createDirectory('sales-media-'),
  out = path.resolve('work/validation/sales-media');
fs.mkdirSync(out, { recursive: true });
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X8xQAAAAASUVORK5CYII=',
  'base64',
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
const account = salesHash('\nINBOX\ndesigner@example.invalid');
const makeMail = (files) =>
  Buffer.from(
    [
      'From: designer@example.invalid',
      'To: test@example.invalid',
      'Subject: Учебный макет',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary=qa',
      '',
      '--qa',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Вымышленная переписка для проверки.',
      ...files.flatMap(([name, type, bytes]) => [
        '--qa',
        'Content-Type: ' + type,
        'Content-Disposition: attachment; filename="' + name + '"',
        'Content-Transfer-Encoding: base64',
        '',
        bytes.toString('base64'),
      ]),
      '--qa--',
      '',
    ].join('\r\n'),
  );
let instance, browser, finance, sales;
const errors = [],
  results = [];
try {
  instance = await launch(dir, { mail: true });
  finance = new Database(path.join(dir, 'data/finance.sqlite3'));
  sales = new Database(path.join(dir, 'data/sales.sqlite3'));
  const desk = new SalesDesk({ db: sales });
  desk.setSetting('intakePolicy', 'new');
  const add = (id, files) => {
    finance
      .prepare(
        "INSERT INTO mail_messages(key,account_key,raw,state,details,updated_at) VALUES(?,?,?,'done','{}',?)",
      )
      .run(id, account, makeMail(files), new Date().toISOString());
    return desk.ingest({
      source: 'mail',
      account,
      nativeId: id,
      conversationId: 'fictional-mail-chat',
      version: 'v1',
      type: 'mail',
      occurredAt: new Date().toISOString(),
      title: 'Макет для учебной кофейни',
    });
  };
  add('media-mail-1', [
    ['proof.png', 'image/png', png],
    ['voice.wav', 'audio/wav', wav],
    ['layout.html', 'text/html', Buffer.from('<script>alert(1)</script>')],
  ]);
  const chat = desk.readChats().items[0];
  const note = desk.command({
    requestId: 'media-browser-card',
    action: 'chat.create',
    data: { chatId: chat.id },
  });
  const other = desk.command({
    requestId: 'media-browser-empty',
    action: 'note.create',
    data: { title: 'Другая учебная карточка', owner: 'Тест' },
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
  p.on('pageerror', (error) => errors.push(error.message));
  for (const width of [1440, 390, 320]) {
    await p.setViewportSize({ width, height: 950 });
    await p.goto(instance.base + '/sales/');
    await p.locator(`[data-open="${note.noteId}"]`).first().click();
    await p.locator('#note-media .media-item').nth(2).waitFor();
    assert.equal(await p.locator('#note-media .media-item').count(), 3);
    await p.waitForFunction(() =>
      [...document.querySelectorAll('#note-media img')].every(
        (img) => img.complete && img.naturalWidth > 0,
      ),
    );
    assert.equal(await p.locator('#note-media audio').count(), 1);
    assert.equal(
      await p
        .locator('#note-media')
        .evaluate((el) => el.scrollWidth > el.clientWidth),
      false,
    );
    assert.equal(
      await p.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await p.locator('[data-tab="files"]').click();
    assert.equal(await p.locator('#note-media .media-item').count(), 3);
    await p.screenshot({
      path: path.join(out, 'media-' + width + '.png'),
      fullPage: true,
    });
    await p.locator(`[data-chat-open="${chat.id}"]`).click();
    await p.locator('#chat-messages .media-item').nth(2).waitFor();
    assert.equal(await p.locator('#chat-messages .media-item').count(), 3);
    assert.equal(
      await p
        .locator('#source-dialog')
        .evaluate((el) => el.scrollWidth > el.clientWidth),
      false,
    );
    await p.locator('#close-source').click();
    results.push({
      width,
      card: 3,
      chat: 3,
      imagesLoaded: true,
      overflow: false,
    });
  }
  const html = p
    .locator('#note-media .media-item')
    .filter({ hasText: 'layout.html' });
  const response = await context.request.get(
    instance.base + (await html.locator('a').first().getAttribute('href')),
  );
  assert.equal(response.headers()['content-type'], 'application/octet-stream');
  assert.match(response.headers()['content-disposition'], /^attachment/);
  const audio = p.locator('#note-media audio');
  await audio.evaluate(async (player) => {
    player.loop = true;
    await player.play();
    player.dataset.playbackProbe = 'kept';
  });
  add('media-mail-2', [['second.png', 'image/png', png]]);
  await new Promise((resolve) => setTimeout(resolve, 3800));
  assert.equal(await audio.getAttribute('data-playback-probe'), 'kept');
  await audio.evaluate((player) => player.pause());
  await p.waitForFunction(
    () => document.querySelectorAll('#note-media .media-item').length === 4,
  );
  assert.equal(desk.detail(note.noteId).files.length, 0);
  results.push({
    newMessageAutoGallery: true,
    playbackPreserved: true,
    noAutomaticApproval: true,
  });
  await p.locator('#close-detail').click();
  // A late gallery response from card A cannot replace card B.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await p.route('**/api/sales/note-media?**', async (route) => {
    if (
      new URL(route.request().url()).searchParams.get('noteId') === note.noteId
    )
      await gate;
    await route.continue();
  });
  await p.locator(`[data-open="${other.id}"]`).first().click();
  await p.getByText('В связанных сообщениях пока нет вложений.').waitFor();
  await p.locator('#close-detail').click();
  await p.locator(`[data-open="${note.noteId}"]`).first().click();
  await p.getByText('Загружаю вложения…').waitFor();
  await p.locator('#close-detail').click();
  await p.locator(`[data-open="${other.id}"]`).first().click();
  await p.getByText('В связанных сообщениях пока нет вложений.').waitFor();
  release();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await p.locator('#note-media .media-item').count(), 0);
  await p.unrouteAll({ behavior: 'wait' });
  results.push({ staleCardResponseIgnored: true });
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(out, 'results.json'),
    JSON.stringify({ results, errors }, null, 2),
  );
  console.log(JSON.stringify({ results, errors }));
} finally {
  await browser?.close();
  finance?.close();
  sales?.close();
  await instance?.stop();
  removeDirectory(dir);
}
