import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { MediaStore } from './media.mjs';
import { MailWorker } from './mail-worker.mjs';
import { MailImapSource } from './mail-imap.mjs';
import crypto from 'node:crypto';

const raw = Buffer.from('From: designer@example.invalid\r\nTo: workshop@example.invalid\r\nSubject: Order #9001\r\nMessage-ID: <auto@example.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=source.pdf\r\n\r\n%PDF-1.4\n%%EOF\n\r\n--x--\r\n');
async function setup(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mail-worker-'));
  const db = new Database(':memory:');
  t.after(async () => {
    db.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('mail-worker-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const mediaStore = new MediaStore({ directory });
  const source = { identity: 'test-inbox', sender: 'designer@example.invalid', configured: true,
    scan: async () => ({ cursor: { validity: '1', lastUid: 1 }, messages: [{ uid: 1, raw }] }), ...overrides };
  const options = { db, source, mediaStore, readOrders: async () => [{ id: '9001', title: 'Учебная вывеска', client: 'Луна' }] };
  return { directory, db, source, mediaStore, options, worker: new MailWorker(options) };
}

test('background ingest requires no EML upload; linking waits for agent decision, original and receipt survive retries', async t => {
  const { worker, mediaStore, options, db } = await setup(t);
  await Promise.all([worker.tick(), worker.tick()]);
  let queue = worker.queue();
  assert.equal(queue.counts.review, 1);
  assert.equal((await mediaStore.list('9001')).items.length, 0);
  assert.deepEqual(db.prepare('SELECT raw FROM mail_messages').get().raw, raw);
  const selection = { messageKey: queue.messages[0].key, partId: '1', orderId: '9001', reason: 'В теме письма указан заказ #9001; он существует в доске.' };
  await worker.resolve(selection);
  await worker.tick();
  const restarted = new MailWorker(options);
  await restarted.resolve(selection); await restarted.tick();
  queue = restarted.queue();
  assert.equal(queue.counts.done, 1);
  const items = (await mediaStore.list('9001')).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].source.messageKey, selection.messageKey);
  assert.match(queue.messages[0].attachments[0].decision.reason, /9001/);
  await assert.rejects(restarted.resolve({ ...selection, orderId: '9002' }), { code: 'MAIL_IMPORT_CONFLICT' });
});

const linkedRaw = Buffer.from('From: designer@example.invalid\r\nMessage-ID: <link@example.invalid>\r\nSubject: Order #9001\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<a href="https://yadi.sk/d/fixture123">Учебный.cdr (26429547)</a>');
function linkedSource() {
  const bytes = Buffer.alloc(26 * 1024 * 1024);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('CDRFvrsn', 8);
  return { bytes, name: 'Учебный.cdr', size: bytes.length, contentType: 'application/vnd.corel-draw',
    publicUrl: 'https://disk.yandex.ru/d/fixture123', contentHash: crypto.createHash('sha256').update(bytes).digest('hex') };
}

test('previously done HTML mail is backfilled; large linked original survives restart and offline repeated resolution', async t => {
  const { options, db, source, mediaStore } = await setup(t);
  source.scan = async () => ({ cursor: { validity: '1', lastUid: 1 }, messages: [{ uid: 1, raw: linkedRaw }] });
  let calls = 0;
  const payload = linkedSource();
  options.linkSource = { download: async () => { calls++; return payload; } };
  let worker = new MailWorker(options);
  // Simulate an old deployed parser that marked the HTML-only email done.
  const key = 'a'.repeat(64);
  db.prepare('INSERT INTO mail_messages VALUES(?,?,?,?,?,?,?)').run(key, worker.accountKey, linkedRaw, 'done', '{"attachments":[]}', new Date().toISOString(), '');
  worker = new MailWorker(options);
  assert.equal(worker.queue().messages[0].state, 'pending');
  await worker.tick();
  assert.equal(calls, 1); // Duplicate source after mailbox discovery shares the same original.
  const mail = worker.queue().messages.find(message => message.key === key);
  assert.equal(mail.attachments[0].size, payload.size);
  assert.equal(mail.state, 'review');
  const selection = { messageKey: key, partId: '51', orderId: '9001', reason: 'Номер учебного заказа подтверждён темой письма.' };
  await worker.resolve(selection);
  const first = (await mediaStore.list('9001')).items[0];
  options.linkSource = { download: async () => { throw new Error('offline'); } };
  worker = new MailWorker(options);
  await worker.resolve(selection);
  assert.equal((await mediaStore.list('9001')).items.length, 1);
  assert.deepEqual((await mediaStore.read('9001', first.id)).bytes, payload.bytes);
  assert.equal(db.prepare('SELECT count(*) AS n FROM mail_link_files').get().n, 1);
  assert.ok(worker.spoolBytes() > payload.bytes.length);
});

test('linked download failure remains review, backs off, retries and never blocks shared commands', async t => {
  const { options, source, db } = await setup(t);
  source.scan = async () => ({ cursor: { validity: '1', lastUid: 1 }, messages: [{ uid: 1, raw: linkedRaw }] });
  let held = false, calls = 0, fail = true;
  options.runCommand = async action => { assert.equal(held, false); held = true; try { return await action(); } finally { held = false; } };
  options.linkSource = { download: async () => { assert.equal(held, false); calls++; if (fail) throw new Error('signed-url-must-not-leak'); return linkedSource(); } };
  const worker = new MailWorker(options);
  await worker.tick(); await worker.tick();
  assert.equal(calls, 1);
  assert.equal(worker.queue().counts.review, 1);
  assert.equal(worker.queue().messages[0].attachments[0].error, 'MAIL_LINK_UNAVAILABLE');
  assert.equal(JSON.stringify(worker.queue()).includes('must-not-leak'), false);
  db.prepare("UPDATE mail_link_files SET retry_at=''").run(); fail = false;
  await worker.tick();
  assert.equal(calls, 2);
  assert.equal(worker.queue().messages[0].attachments[0].error, undefined);
});

test('linked spool quota leaves retryable review without storing a partial original', async t => {
  const { options, source, db } = await setup(t);
  source.scan = async () => ({ cursor: { validity: '1', lastUid: 1 }, messages: [{ uid: 1, raw: linkedRaw }] });
  options.maxSpoolBytes = 1024 * 1024;
  options.linkSource = { download: async () => linkedSource() };
  const worker = new MailWorker(options);
  await worker.tick();
  assert.equal(worker.queue().messages[0].attachments[0].error, 'MAIL_SPOOL_FULL');
  assert.equal(db.prepare('SELECT bytes FROM mail_link_files').get().bytes, null);
  assert.deepEqual(db.prepare('SELECT raw FROM mail_messages').get().raw, linkedRaw);
});

test('absent key performs no network IO and wrong sender is not imported', async t => {
  const { worker, db } = await setup(t, { configured: false, scan: async () => { throw new Error('must not call'); } });
  await worker.tick(); assert.equal(worker.status().state, 'awaiting_key');
  assert.equal(db.prepare('SELECT count(*) AS n FROM mail_messages').get().n, 0);
  worker.source.configured = true; worker.source.sender = 'another@example.invalid';
  worker.source.scan = async () => ({ cursor: { validity: '1', lastUid: 1 }, messages: [{ uid: 1, raw }] });
  await worker.tick(); assert.equal(worker.queue().counts.ignored, 1);
});

test('failed staging never advances cursor; UIDVALIDITY reset may restage but never duplicates file', async t => {
  const { worker, db, source, mediaStore } = await setup(t);
  worker.maxSpoolBytes = 1;
  await worker.tick();
  assert.equal(db.prepare('SELECT count(*) AS n FROM mail_cursor').get().n, 0);
  worker.maxSpoolBytes = 1024 * 1024;
  await worker.tick();
  let key = worker.queue().messages[0].key;
  await worker.resolve({ messageKey: key, partId: '1', orderId: '9001', reason: 'Verified order number in subject.' });
  source.scan = async () => ({ cursor: { validity: '2', lastUid: 1 }, messages: [{ uid: 1, raw }] });
  await worker.tick();
  key = worker.queue().messages.find(message => message.state === 'review').key;
  await worker.resolve({ messageKey: key, partId: '1', orderId: '9001', reason: 'Same source message after mailbox reset.' });
  assert.equal((await mediaStore.list('9001')).items.length, 1);
});

test('IMAP uses TLS, EXAMINE, UID windows and bounded fetch; never changes flags or sends mail', async t => {
  const { directory } = await setup(t);
  const passwordFile = path.join(directory, 'test-key'); await fs.writeFile(passwordFile, 'test-only');
  let options, searchQuery, lockOptions, sourceQuery;
  const client = new EventEmitter();
  Object.assign(client, { mailbox: { uidValidity: 2n, uidNext: 900 }, connect: async () => {},
    getMailboxLock: async (_folder, opts) => { lockOptions = opts; return { release() {} }; },
    search: async query => { searchQuery = query; return [3, 1, 2, 4]; },
    fetchOne: async (_uid, query) => { if (query.source) { sourceQuery = query.source; return { source: raw }; } return { size: raw.length }; },
    logout: async () => {}, close() {} });
  const source = new MailImapSource({ enabled: true, user: 'workshop@example.invalid', sender: 'designer@example.invalid', passwordFile,
    clientFactory: opts => { options = opts; return client; } });
  const batch = await source.scan({ validity: '1', lastUid: 700 });
  assert.equal(options.secure, true); assert.equal(options.logger, false); assert.equal(options.tls.rejectUnauthorized, true);
  assert.deepEqual(lockOptions, { readOnly: true });
  assert.equal(searchQuery.uid, '1:500'); assert.equal(searchQuery.from, 'designer@example.invalid');
  assert.equal(batch.messages.length, 3); assert.equal(batch.cursor.lastUid, 3); assert.equal(batch.cursor.validity, '2');
  assert.equal(sourceQuery.maxLength, 96 * 1024 * 1024 + 1);

  source.since = '2026-08-01';
  const searches = [];
  client.search = async query => { searches.push(query); return query.since ? [805, 800, 820] : [800, 805, 820]; };
  const seeded = await source.scan();
  assert.equal(searches[0].from, 'designer@example.invalid');
  assert.equal(searches[0].since.toISOString(), '2026-08-01T00:00:00.000Z');
  assert.equal(searches[1].uid, '800:899');
  assert.equal(seeded.cursor.lastUid, 820);
  searches.length = 0;
  await source.scan(seeded.cursor);
  assert.equal(searches.length, 1); assert.equal(searches[0].uid, '821:899');
  client.search = async () => [];
  assert.equal((await source.scan()).cursor.lastUid, 899);
  assert.throws(() => new MailImapSource({ since: '2026-02-31' }), /MAIL_SINCE_INVALID/);
});
