import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import { SalesDesk } from './sales-desk.mjs';
import { SalesSources } from './sales-sources.mjs';
import { salesOrderPrefill, salesOrderRequestId } from './sales-order.mjs';
import { SalesOrderFiles } from './sales-order-files.mjs';
import { MediaStore } from '../modules/orders/server/media.mjs';
import { stageUpload } from './file-streams.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-card-'));
  const db = new Database(':memory:'),
    mailDb = new Database(':memory:');
  const desk = new SalesDesk({
    db,
    filesDirectory: path.join(directory, 'sales-files'),
  });
  desk.setSetting('intakePolicy', 'new');
  const command = (action, data) =>
    desk.command({ requestId: crypto.randomUUID(), action, data });
  const note = command('note.create', {
    title: 'Объявление о печати',
    owner: 'Тест',
  });
  t.after(() => {
    db.close();
    mailDb.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, db, mailDb, desk, command, note };
}
test('order preparation checks fresh chat before analysis, obtains participant name and permits unknown quantity', async (t) => {
  const f = fixture(t),
    sequence = [];
  const first = f.desk.ingest({
    source: 'avito',
    account: '1234',
    nativeId: 'first',
    conversationId: 'chat',
    version: '1',
    type: 'text',
    occurredAt: new Date().toISOString(),
  });
  f.command('event.link', {
    eventId: first.id,
    eventRevision: 1,
    noteId: f.note.id,
    revision: f.desk.note(f.note.id).revision,
  });
  const messages = [
    {
      id: 'first',
      createdAt: new Date().toISOString(),
      direction: 'in',
      type: 'text',
      text: 'Баннер',
    },
    {
      id: 'second',
      createdAt: new Date().toISOString(),
      direction: 'in',
      type: 'text',
      text: 'Баннер 3 на 2 метра',
    },
  ];
  const avito = {
    status: () => ({ accountId: '1234', enabled: true, configured: true }),
    conversationMessages: async () => {
      sequence.push('fresh');
      const page = { messages, hasMore: false };
      sources.observeAvito({ accountId: '1234', chatId: 'chat', page });
      return page;
    },
  };
  const sources = new SalesSources({
    desk: f.desk,
    avito,
    mail: { db: f.mailDb },
    importer: {
      view: () => ({
        chats: [
          { id: 'chat', users: [{ id: '42', name: 'Учебный покупатель' }] },
        ],
      }),
    },
    max: {
      settings: () => ({ codexEnabled: true, codexTokenFile: 'fixture' }),
    },
    ask: async (_config, payload) => {
      sequence.push('analysis');
      assert.equal(payload.context.tasks, undefined);
      assert.equal(payload.context.evidence.length, 2);
      return {
        answer: JSON.stringify({
          summary: '## Запрос\n- Баннер 3 × 2 м',
          requestTitle: 'Баннер 3 × 2 м',
          changes: 'Размер появился',
          sources: payload.context.evidence.map((e) => e.id),
          orderDraft: {
            title: 'Баннер 3 × 2 м',
            client: '',
            description: 'Размер 3 × 2 м',
            amount: null,
            desiredDate: '',
            items: [{ name: 'Баннер', description: '3 × 2 м', quantity: null }],
            sources: payload.context.evidence.map((e) => e.id),
          },
        }),
      };
    },
  });
  t.after(() => sources.close());
  const request = {
    noteId: f.note.id,
    revision: f.desk.note(f.note.id).revision,
    requestId: 'prepare-fixture-1',
  };
  const job = sources.prepareOrder(request);
  await sources.resumeAnalysis();
  assert.equal(sequence[0], 'fresh');
  assert.equal(sequence.at(-1), 'analysis');
  assert.equal(
    f.db.prepare('SELECT state FROM sales_jobs WHERE id=?').get(job.id).state,
    'done',
  );
  assert.equal(sources.prepareOrder(request).id, job.id);
  const draft = salesOrderPrefill(f.desk, f.note.id);
  assert.equal(draft.values.client, 'Учебный покупатель');
  assert.equal(draft.configDraft.items[0].data.qty, '');
  assert.equal(draft.values.amountOverride, '');
  assert.equal(f.desk.detail(f.note.id).displayTitle, 'Баннер 3 × 2 м');
  assert.equal(f.desk.tasks(f.note.id).length, 0);
  await sources.close();
});
test('unavailable AI still checks context and opens a partial, human-reviewed order without inventing a client', async (t) => {
  const f = fixture(t);
  const sources = new SalesSources({
    desk: f.desk,
    mail: { db: f.mailDb },
    avito: { status: () => ({}) },
    importer: { view: () => ({ chats: [] }) },
    max: { settings: () => null },
  });
  const request = {
    noteId: f.note.id,
    revision: f.note.revision,
    requestId: 'prepare-unavailable',
  };
  sources.prepareOrder(request);
  await sources.resumeAnalysis();
  const result = salesOrderPrefill(f.desk, f.note.id);
  assert.equal(result.values.title, f.note.title);
  assert.equal(result.values.client, '');
  assert.equal(result.configDraft.items.length, 0);
  assert.match(result.warning, /Не удалось полностью обновить/);
  assert.ok(f.desk.note(f.note.id).contextCheckedAt);
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) n FROM sqlite_master WHERE name='sales_order_transfers'",
      )
      .get().n,
    0,
  );
  await sources.close();
});
test('large upload streams to durable card storage and the common order media store, survives restart and deduplicates', async (t) => {
  const f = fixture(t),
    chunk = Buffer.alloc(1024 * 1024, 37),
    count = 65;
  const file = await stageUpload(
    Readable.from(
      (async function* () {
        for (let i = 0; i < count; i++) yield chunk;
      })(),
    ),
    f.desk.filesDirectory,
  );
  const input = {
    requestId: 'large-upload-fixture',
    noteId: f.note.id,
    revision: f.note.revision,
    name: 'Большой исходник.bin',
    mime: 'application/octet-stream',
    file,
  };
  const saved = f.desk.upload(input);
  await file.dispose();
  const stored = f.desk.storedFile(saved.id);
  assert.equal(stored.size, count * chunk.length);
  assert.ok(stored.path);
  assert.equal(
    f.db.prepare('SELECT length(bytes) n FROM sales_files').get().n,
    0,
  );
  const directory = path.join(f.directory, 'media');
  let media = new MediaStore({
    directory,
    maxFileBytes: 1,
    maxTotalBytes: 80 * 1024 * 1024,
    maxOrderBytes: 1,
  });
  const salesSource = { key: 'a'.repeat(64), noteId: f.note.id };
  const added = await media.addAttachment('123', { ...stored, salesSource });
  assert.equal(added.size, stored.size);
  assert.equal(
    (await media.addAttachment('123', { ...stored, salesSource })).id,
    added.id,
  );
  media = new MediaStore({ directory });
  const opened = await media.open('123', added.id);
  assert.equal(opened.size, stored.size);
  await media.remove('123', added.id);
  assert.equal(
    (await media.addAttachment('123', { ...stored, salesSource })).deleted,
    true,
  );
  assert.equal((await media.list('123')).items.length, 0);
  assert.equal(
    JSON.parse(
      await fsp.readFile(path.join(directory, 'attachments.json'), 'utf8'),
    ).records.length,
    1,
  );
  // Legacy index retains its schema for an old-code rollback.
  assert.equal(fs.existsSync(path.join(directory, 'index.json')), false);
});
test('file transfer requires verified order receipt and resumes after a lost result without duplicate files', async (t) => {
  const f = fixture(t),
    creationDirectory = path.join(f.directory, 'creation');
  fs.mkdirSync(creationDirectory);
  f.desk.upload({
    requestId: 'manual-fixture-1',
    noteId: f.note.id,
    revision: f.note.revision,
    name: 'Файл.pdf',
    mime: 'application/pdf',
    bytes: Buffer.from('%PDF-fixture'),
  });
  const mediaStore = new MediaStore({
    directory: path.join(f.directory, 'media'),
  });
  const options = {
    desk: f.desk,
    sources: { media: {} },
    mediaStore,
    creationDirectory,
    readOrders: async () => ({ orders: [{ id: '123' }] }),
  };
  let transfer = new SalesOrderFiles(options);
  await assert.rejects(transfer.step({ noteId: f.note.id, orderId: '123' }), {
    code: 'SALES_ORDER_UNCONFIRMED',
  });
  const requestId = salesOrderRequestId(f.note.id, {
    journalDir: creationDirectory,
  });
  fs.writeFileSync(
    path.join(creationDirectory, requestId + '.json'),
    JSON.stringify({ state: 'verified', id: 123 }),
  );
  const result = await transfer.step({ noteId: f.note.id, orderId: '123' });
  assert.equal(result.done, true);
  assert.equal(result.attached, 1);
  transfer = new SalesOrderFiles(options);
  assert.deepEqual(
    await transfer.step({ noteId: f.note.id, orderId: '123' }),
    result,
  );
  assert.equal((await mediaStore.list('123')).items.length, 1);
  assert.equal(f.desk.note(f.note.id).orderId, '123');
  await assert.rejects(transfer.step({ noteId: f.note.id, orderId: '124' }), {
    code: 'SALES_ORDER_UNCONFIRMED',
  });
});

const GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);
function confirmedTransfer(f, mediaStore, sources = { media: {} }) {
  const creationDirectory = path.join(f.directory, 'creation');
  fs.mkdirSync(creationDirectory, { recursive: true });
  const requestId = salesOrderRequestId(f.note.id, {
    journalDir: creationDirectory,
  });
  fs.writeFileSync(
    path.join(creationDirectory, requestId + '.json'),
    JSON.stringify({ state: 'verified', id: 123 }),
  );
  return new SalesOrderFiles({
    desk: f.desk,
    mediaStore,
    sources,
    creationDirectory,
    readOrders: async () => ({ orders: [{ id: '123' }] }),
  });
}
function manual(f, id) {
  return f.desk.upload({
    requestId: id,
    noteId: f.note.id,
    revision: f.desk.note(f.note.id).revision,
    name: id + '.bin',
    mime: 'application/octet-stream',
    bytes: Buffer.from('fixture'),
  });
}
function linked(f, id, extra = {}) {
  const e = f.desk.ingest({
    source: 'avito',
    account: '1234',
    nativeId: id,
    conversationId: 'chat',
    version: 'v1',
    type: 'image',
    occurredAt: new Date().toISOString(),
    ...extra,
  });
  if (!f.desk.events(f.note.id).some((x) => x.id === e.id))
    f.command('event.link', {
      eventId: e.id,
      eventRevision: 1,
      noteId: f.note.id,
      revision: f.desk.note(f.note.id).revision,
    });
  return e;
}
function sourceFixture(f) {
  const sources = new SalesSources({
    desk: f.desk,
    mail: { db: f.mailDb },
    avito: {
      status: () => ({ accountId: '1234', enabled: true, configured: true }),
    },
    importer: {
      view: () => ({
        chats: [
          { id: 'chat', users: [{ id: '42', name: 'Учебный покупатель' }] },
        ],
      }),
    },
    max: {
      settings: () => ({ codexEnabled: true, codexTokenFile: 'fixture' }),
    },
  });
  sources.media.page = async () => ({ messages: [], hasMore: false });
  sources.content = async (id) => ({
    text: id,
    at: new Date().toISOString(),
    source: 'avito',
  });
  return sources;
}
test('sales imports preserve global capacity, reject excess without poisoning normal uploads, including after restart', async (t) => {
  const f = fixture(t),
    directory = path.join(f.directory, 'media');
  let media = new MediaStore({
    directory,
    maxTotalBytes: 1000,
    maxTotalFiles: 3,
  });
  await media.add('1', {
    name: 'one.gif',
    contentType: 'image/gif',
    bytes: GIF,
  });
  await assert.rejects(
    media.addAttachment('2', {
      name: 'big.bin',
      bytes: Buffer.alloc(1001),
      salesSource: { key: '1'.repeat(64), noteId: f.note.id },
    }),
    { code: 'MEDIA_STORAGE_QUOTA' },
  );
  await media.addAttachment('2', {
    name: 'allowed.bin',
    bytes: Buffer.alloc(800),
    salesSource: { key: '2'.repeat(64), noteId: f.note.id },
  });
  media = new MediaStore({ directory, maxTotalBytes: 1000, maxTotalFiles: 3 });
  await media.add('3', {
    name: 'two.gif',
    contentType: 'image/gif',
    bytes: GIF,
  });
  await assert.rejects(
    media.addAttachment('2', {
      name: 'fourth.bin',
      bytes: Buffer.from('x'),
      salesSource: { key: '3'.repeat(64), noteId: f.note.id },
    }),
    { code: 'MEDIA_STORAGE_QUOTA' },
  );
  assert.equal((await fsp.readdir(path.join(directory, 'blobs'))).length, 3);
});
test('split during attachment commit cannot publish the old link into an order', async (t) => {
  const f = fixture(t),
    saved = manual(f, 'race-file'),
    media = new MediaStore({ directory: path.join(f.directory, 'media') });
  let release, started;
  const waiting = new Promise((r) => (started = r)),
    gate = new Promise((r) => (release = r));
  const persist = media.persistAttachments.bind(media);
  media.persistAttachments = async (...args) => {
    started();
    await gate;
    return persist(...args);
  };
  const transfer = confirmedTransfer(f, media),
    running = transfer.step({ noteId: f.note.id, orderId: '123' });
  await waiting;
  f.command('notes.split', {
    id: f.note.id,
    revision: f.desk.note(f.note.id).revision,
    newNote: { title: 'Отдельный запрос', owner: 'Тест' },
    eventIds: [],
    fileIds: [saved.id],
    taskIds: [],
  });
  release();
  const result = await running;
  assert.equal(result.done, true);
  assert.equal(result.unavailable, 1);
  assert.equal(result.attached, 0);
  assert.equal((await media.list('123')).items.length, 0);
  assert.deepEqual(await fsp.readdir(media.blobs), []);
});
test('deleted and transiently unavailable events do not block other files; a new transfer instance resumes only failed items', async (t) => {
  const f = fixture(t),
    media = new MediaStore({ directory: path.join(f.directory, 'media') });
  const removed = linked(f, 'removed', { deleted: true }),
    temporary = linked(f, 'temporary'),
    available = linked(f, 'available');
  let fail = true,
    reads = 0;
  const sources = {
    media: {
      event: async (id) => {
        assert.notEqual(id, removed.id);
        if (id === temporary.id && fail)
          throw Object.assign(new Error('Temporary'), {
            code: 'SALES_SOURCE_UNAVAILABLE',
          });
        return { media: [{ partId: 'one', available: true }] };
      },
      file: async () => {
        reads++;
        return { name: 'source.bin', bytes: Buffer.from('source') };
      },
    },
  };
  let transfer = confirmedTransfer(f, media, sources),
    result;
  do {
    result = await transfer.step({ noteId: f.note.id, orderId: '123' });
  } while (!result.done);
  assert.equal(result.unavailable, 1);
  assert.equal(result.pending, 1);
  assert.equal(result.attached, 1);
  assert.equal(reads, 1);
  assert.equal(f.desk.detail(f.note.id).orderTransfer.done, false);
  fail = false;
  transfer = confirmedTransfer(f, media, sources);
  result = await transfer.step({ noteId: f.note.id, orderId: '123' });
  assert.equal(result.done, true);
  assert.equal(result.pending, 0);
  assert.equal(result.attached, 2);
  assert.equal(reads, 2);
  assert.equal(f.desk.detail(f.note.id).orderTransfer.done, true);
  assert.equal(
    f.desk.events(f.note.id).some((e) => e.id === available.id),
    true,
  );
});
test('order preparation follows durable source retry until the latest analysis completes', async (t) => {
  const f = fixture(t);
  linked(f, 'first');
  const sources = sourceFixture(f);
  let calls = 0,
    started,
    release;
  const waiting = new Promise((r) => (started = r)),
    gate = new Promise((r) => (release = r));
  sources.ask = async (_config, payload) => {
    calls++;
    if (calls === 1) linked(f, 'new-message');
    else {
      started();
      await gate;
    }
    return {
      answer: JSON.stringify({
        summary: '## Запрос\n- Свежий запрос',
        requestTitle: calls === 1 ? 'Прежний запрос' : 'Свежий запрос',
        changes: '',
        sources: payload.context.evidence.map((e) => e.id),
        orderDraft: {
          title: calls === 1 ? 'Прежний заказ' : 'Свежий заказ',
          client: '',
          description: '',
          amount: null,
          desiredDate: '',
          items: [],
          sources: payload.context.evidence.map((e) => e.id),
        },
      }),
    };
  };
  const input = {
    noteId: f.note.id,
    revision: f.desk.note(f.note.id).revision,
    requestId: 'preparation-lineage',
  };
  sources.prepareOrder(input);
  await waiting;
  const pending = sources.orderPreparation(input);
  assert.equal(pending.state, 'running');
  assert.notEqual(pending.latestId, input.requestId);
  assert.equal(
    JSON.parse(
      f.db
        .prepare('SELECT data FROM sales_jobs WHERE id=?')
        .get(pending.latestId).data,
    ).prepareOrder,
    true,
  );
  release();
  await sources.resumeAnalysis();
  assert.equal(sources.orderPreparation(input).state, 'done');
  assert.equal(
    salesOrderPrefill(f.desk, f.note.id).values.title,
    'Свежий заказ',
  );
  await sources.close();
});
test('splitting the chat during context refresh never inherits the removed participant name', async (t) => {
  const f = fixture(t),
    event = linked(f, 'context');
  const sources = sourceFixture(f);
  let started, release;
  const waiting = new Promise((r) => (started = r)),
    gate = new Promise((r) => (release = r));
  sources.media.page = async () => {
    started();
    await gate;
    return { messages: [], hasMore: false };
  };
  const running = sources.refreshOrderContext(f.note.id);
  await waiting;
  f.command('notes.split', {
    id: f.note.id,
    revision: f.desk.note(f.note.id).revision,
    newNote: { title: 'Перенесённый чат', owner: 'Тест' },
    eventIds: [event.id],
    fileIds: [],
    taskIds: [],
  });
  release();
  await running;
  assert.equal(f.desk.events(f.note.id).length, 0);
  assert.equal(salesOrderPrefill(f.desk, f.note.id).values.client, '');
  await sources.close();
});

test('failure to persist the first transfer manifest rolls back the note link and command receipt', async (t) => {
  const f = fixture(t);
  manual(f, 'atomic-file');
  const media = new MediaStore({ directory: path.join(f.directory, 'media') }),
    transfer = confirmedTransfer(f, media);
  f.db.exec(
    "CREATE TRIGGER fail_transfer BEFORE INSERT ON sales_order_transfers BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END",
  );
  await assert.rejects(
    transfer.step({ noteId: f.note.id, orderId: '123' }),
    /fixture storage failure/,
  );
  assert.equal(Boolean(f.desk.note(f.note.id).orderId), false);
  assert.equal(f.desk.detail(f.note.id).orderTransfer, null);
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) n FROM sales_commands WHERE id LIKE 'order-link-%'",
      )
      .get().n,
    0,
  );
  f.db.exec('DROP TRIGGER fail_transfer');
  assert.equal(
    (await transfer.step({ noteId: f.note.id, orderId: '123' })).attached,
    1,
  );
});
test('one unavailable part does not block the other parts of the same message or duplicate them on retry', async (t) => {
  const f = fixture(t);
  linked(f, 'multipart');
  const media = new MediaStore({ directory: path.join(f.directory, 'media') });
  let fail = true;
  const reads = [];
  const sources = {
    media: {
      event: async () => ({
        media: [
          { partId: '1', available: true },
          { partId: '2', available: true },
        ],
      }),
      file: async (params) => {
        const id = params.get('partId');
        reads.push(id);
        if (id === '1' && fail) throw new Error('Temporary');
        return { name: id + '.bin', bytes: Buffer.from('part ' + id) };
      },
    },
  };
  let transfer = confirmedTransfer(f, media, sources),
    result = await transfer.step({ noteId: f.note.id, orderId: '123' });
  assert.equal(result.done, true);
  assert.equal(result.pending, 1);
  assert.equal(result.attached, 1);
  assert.deepEqual(reads, ['1', '2']);
  transfer = confirmedTransfer(f, media, sources);
  result = await transfer.step({ noteId: f.note.id, orderId: '123' });
  assert.equal(result.attached, 1);
  assert.deepEqual(reads, ['1', '2', '1']);
  fail = false;
  result = await transfer.step({ noteId: f.note.id, orderId: '123' });
  assert.equal(result.pending, 0);
  assert.equal(result.attached, 2);
  assert.deepEqual(reads, ['1', '2', '1', '1']);
});
