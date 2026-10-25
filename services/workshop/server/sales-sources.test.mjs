import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SalesDesk } from './sales-desk.mjs';
import { SalesSources } from './sales-sources.mjs';
const NOW = Date.parse('2026-10-22T10:00:00Z');
function fixture(t) {
  const db = new Database(':memory:'),
    mailDb = new Database(':memory:');
  const desk = new SalesDesk({ db, now: () => NOW });
  let scans = 0;
  const messages = [
    {
      id: 'source-event-1',
      createdAt: '2026-10-22T11:00:00Z',
      direction: 'in',
      type: 'text',
      text: 'Вымышленный текст не должен архивироваться',
    },
  ];
  const avito = {
    status: () => ({
      enabled: true,
      configured: true,
      accountId: '1234',
      state: 'identity_verified',
    }),
    conversationMessages: async () => ({ messages, hasMore: false }),
  };
  const importer = {
    start: () => {
      scans++;
      return { jobId: 'existing-importer-job' };
    },
    view: () => ({
      chats: [{ id: 'chat-1', itemTitle: 'Учебное объявление' }],
    }),
  };
  mailDb.exec(
    'CREATE TABLE mail_messages(key TEXT,account_key TEXT,raw BLOB,state TEXT,details TEXT,updated_at TEXT)',
  );
  const mail = {
    db: mailDb,
    accountKey: 'mail-account',
    source: { configured: true },
    status: () => ({ state: 'ready', lastSuccessAt: null, lastError: null }),
  };
  const max = { settings: () => null, db: mailDb };
  const sources = new SalesSources({ desk, avito, importer, mail, max });
  t.after(async () => {
    await sources.close();
    db.close();
    mailDb.close();
  });
  return { desk, sources, messages, mailDb, scans: () => scans };
}
test('sales source policy is fail closed; new-only intake excludes historical rows and stores no text', (t) => {
  const f = fixture(t);
  f.sources.observeAvito({
    accountId: '1234',
    chatId: 'chat-1',
    page: { messages: f.messages, hasMore: false },
  });
  assert.equal(f.desk.snapshot().inbox.length, 0);
  assert.throws(
    () => f.sources.sync(),
    (e) => e.code === 'SALES_POLICY',
  );
  f.desk.setSetting('intakePolicy', 'new');
  f.sources.observeAvito({
    accountId: '1234',
    chatId: 'chat-1',
    page: {
      messages: [
        ...f.messages,
        { ...f.messages[0], id: 'old', createdAt: '2026-10-20T11:00:00Z' },
      ],
      hasMore: true,
    },
  });
  assert.equal(f.desk.snapshot().inbox.length, 1);
  const raw = f.desk.db.prepare('SELECT data FROM sales_events').get().data;
  assert.equal(raw.includes(f.messages[0].text), false);
  assert.equal(
    f.desk.snapshot().today.filter((t) => t.kind === 'inbox').length,
    1,
  );
});
test('sales source staging survives failure without losing events or blocking the existing reader', (t) => {
  const f = fixture(t);
  f.desk.setSetting('intakePolicy', 'new');
  const original = f.desk.ingest.bind(f.desk);
  f.desk.ingest = () => {
    throw new Error('isolated sales storage failure');
  };
  assert.doesNotThrow(() =>
    f.sources.observeAvito({
      accountId: '1234',
      chatId: 'chat-1',
      page: { messages: f.messages, hasMore: false },
    }),
  );
  assert.equal(
    f.mailDb.prepare('SELECT count(*) n FROM sales_intake_receipts').get().n,
    1,
  );
  assert.equal(f.sources.channels()[0].pending, 1);
  const staged = f.mailDb
    .prepare('SELECT data FROM sales_intake_receipts')
    .get().data;
  assert.equal(staged.includes(f.messages[0].text), false);
  f.desk.ingest = original;
  f.sources.drain();
  assert.equal(f.desk.snapshot().inbox.length, 1);
  assert.equal(
    f.mailDb.prepare('SELECT count(*) n FROM sales_intake_receipts').get().n,
    0,
  );
  f.sources.observeAvito({
    accountId: '1234',
    chatId: 'chat-1',
    page: { messages: f.messages, hasMore: false },
  });
  assert.equal(f.desk.snapshot().inbox.length, 1);
});
test('sales uses the existing importer, exposes unavailable channels and never sends messages', (t) => {
  const f = fixture(t);
  f.desk.setSetting('intakePolicy', 'new');
  assert.equal(f.sources.sync().jobId, 'existing-importer-job');
  assert.equal(f.scans(), 1);
  assert.equal(
    f.sources.channels().find((c) => c.id === 'telegram').connected,
    false,
  );
  assert.equal(f.sources.channels().find((c) => c.id === 'mail').partial, true);
});
test('sales on-demand history validates allowed chat, saves only selected metadata and suppresses old urgency', async (t) => {
  const f = fixture(t);
  f.desk.setSetting('intakePolicy', 'new');
  f.messages[0].createdAt = '2026-09-01T10:00:00Z';
  await assert.rejects(
    () => f.sources.history('unknown-chat'),
    (e) => e.code === 'SALES_SOURCE_SCOPE',
  );
  const preview = await f.sources.history('chat-1');
  assert.equal(preview.messages.length, 1);
  assert.equal(f.desk.snapshot().inbox.length, 0);
  const saved = await f.sources.remember({
    chatId: 'chat-1',
    messageId: f.messages[0].id,
  });
  assert.ok(saved.id);
  assert.equal(f.desk.snapshot().inbox[0].historical, true);
  assert.equal(f.desk.snapshot().today.length, 0);
  const content = await f.sources.content(saved.id);
  assert.equal(content.text, f.messages[0].text);
});
test('sales unavailable source preserves received event and ownership', async (t) => {
  const f = fixture(t);
  f.desk.setSetting('intakePolicy', 'new');
  f.sources.observeAvito({
    accountId: '1234',
    chatId: 'chat-1',
    page: { messages: f.messages, hasMore: false },
  });
  const id = f.desk.snapshot().inbox[0].id;
  f.sources.avito.conversationMessages = async () => {
    throw new Error('provider unavailable');
  };
  await assert.rejects(
    () => f.sources.content(id),
    (e) => e.code === 'SALES_SOURCE_UNAVAILABLE',
  );
  assert.equal(f.desk.snapshot().inbox[0].owner, 'Руководитель');
  assert.equal(f.sources.channels()[0].error, 'SOURCE_UNAVAILABLE');
});

test('sales caches authorized intake and stages during a sales DB read outage; hook failures expose a gap', (t) => {
  const f = fixture(t);
  f.desk.setSetting('intakePolicy', 'new');
  assert.equal(f.sources.enabled(), true);
  const prepare = f.desk.db.prepare;
  f.desk.db.prepare = () => {
    throw new Error('sales disk temporarily unavailable');
  };
  assert.doesNotThrow(() =>
    f.sources.observeSafely('avito', () =>
      f.sources.observeAvito({
        accountId: '1234',
        chatId: 'chat-1',
        page: { messages: f.messages, hasMore: false },
      }),
    ),
  );
  f.desk.db.prepare = prepare;
  assert.equal(
    f.mailDb.prepare('SELECT count(*) n FROM sales_intake_receipts').get().n,
    1,
  );
  f.sources.drain();
  assert.equal(f.desk.snapshot().inbox.length, 1);
  f.sources.observeSafely('max', () => {
    throw new Error('receipt failed');
  });
  assert.ok(f.sources.channels().find((c) => c.id === 'max').gapAt);
});
test('sales analysis reports exact partial coverage and stays within shared broker UTF-8 byte limit', async (t) => {
  const f = fixture(t);
  let serial = 0;
  const command = (action, data) =>
    f.desk.command({ requestId: 'coverage-' + ++serial, action, data });
  const n = command('note.create', {
    title: 'Учебный большой разбор',
    owner: 'Тест',
    manual: 'я'.repeat(4000),
  });
  for (let i = 0; i < 13; i++) {
    const e = f.desk.ingest({
      source: 'avito',
      account: '1234',
      nativeId: 'coverage-' + i,
      version: 'v1',
      occurredAt: '2026-10-22T11:00:00Z',
    });
    command('event.link', {
      eventId: e.id,
      eventRevision: 1,
      noteId: n.id,
      revision: f.desk.note(n.id).revision,
    });
  }
  f.sources.content = async () => ({
    text: 'ю'.repeat(6000),
    at: '2026-10-22T11:00:00Z',
    source: 'avito',
  });
  let payload;
  f.sources.ask = async (_, p) => {
    payload = p;
    return {
      answer: JSON.stringify({
        summary: 'Неполный итог',
        changes: 'Часть источников не вошла',
        sources: p.context.evidence
          .filter((e) => !e.unavailable)
          .map((e) => e.id),
        proposals: [],
      }),
    };
  };
  const job = f.desk.beginAnalysis(
    n.id,
    f.desk.note(n.id).revision,
    'coverage-analysis',
  );
  await f.sources.runAnalysis(job, {
    codexEnabled: true,
    codexTokenFile: 'synthetic-token',
  });
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 48 * 1024);
  const summary = f.desk.note(n.id).summary;
  assert.equal(summary.partial, true);
  assert.ok(summary.coverage.omitted.length);
  assert.ok(summary.coverage.truncated.length);
  assert.equal(
    summary.coverage.processed.length + summary.coverage.omitted.length,
    13,
  );
  assert.ok(
    summary.coverage.processed.every(
      (e) => e.version === 'v1' && e.revision === 1,
    ),
  );
  assert.equal(f.desk.snapshot().notes[0].summaryPartial, true);
});
test('sales MAX metadata tracks attachment edits and scoped deletion; old delivery cannot resurrect it', (t) => {
  const f = fixture(t);
  f.desk.setSetting('intakePolicy', 'new');
  f.sources.max.settings = () => ({ botId: 'bot-7' });
  const message = {
    timestamp: Date.parse('2026-10-22T11:00:00Z'),
    recipient: { chat_id: -10 },
    body: { mid: 'mid-1', text: null, attachments: [{ type: 'image' }] },
  };
  f.sources.observeMax({
    message,
    kind: 'chat',
    id: '-10',
    timestamp: message.timestamp,
  });
  f.sources.observeMax({
    message: { ...message, body: { ...message.body, text: 'Правка' } },
    kind: 'chat',
    id: '-10',
    timestamp: message.timestamp + 1000,
  });
  const prepare = f.desk.db.prepare;
  f.desk.db.prepare = () => {
    throw new Error('sales read unavailable during removal');
  };
  f.sources.observeMax({
    removed: true,
    nativeId: 'mid-1',
    kind: 'chat',
    id: '-10',
    chatId: '-10',
    timestamp: message.timestamp + 2000,
  });
  f.desk.db.prepare = prepare;
  assert.equal(
    f.mailDb.prepare('SELECT count(*) n FROM sales_intake_receipts').get().n,
    1,
  );
  f.sources.drain();
  f.sources.observeMax({
    message,
    kind: 'chat',
    id: '-10',
    timestamp: message.timestamp,
  });
  const row = JSON.parse(
    f.desk.db.prepare('SELECT data FROM sales_events').get().data,
  );
  assert.equal(row.deleted, true);
  assert.equal(row.account, 'bot-7');
  assert.equal(
    f.desk.db.prepare('SELECT revision FROM sales_events').get().revision,
    3,
  );
});

test('chat creation summarizes all available small discussion with shared page reads and keeps manual data', async (t) => {
  const f = fixture(t);
  f.desk.setSetting('intakePolicy', 'new');
  let calls = 0,
    aiCalls = 0,
    captured;
  const messages = Array.from({ length: 28 }, (_, i) => ({
    id: 'thread-message-' + i,
    createdAt: '2026-10-22T11:00:00Z',
    direction: i % 2 ? 'out' : 'in',
    type: 'text',
    text: 'Вымышленная договорённость ' + i,
  }));
  f.sources.avito.conversationMessages = async ({ offset }) => {
    calls++;
    return { messages: messages.slice(offset, offset + 100), hasMore: false };
  };
  f.sources.max.settings = () => ({
    codexEnabled: true,
    codexTokenFile: 'synthetic-token',
  });
  f.sources.ask = async (_, payload) => {
    aiCalls++;
    captured = payload;
    return {
      answer: JSON.stringify({
        summary: 'Учебное саммари обсуждения',
        changes: 'Проверить размеры',
        sources: payload.context.evidence.slice(0, 2).map((e) => e.id),
        proposals: [],
      }),
    };
  };
  f.sources.observeAvito({
    accountId: '1234',
    chatId: 'chat-1',
    page: { messages, hasMore: false },
  });
  const chat = f.desk.readChats().items[0];
  const created = f.desk.command({
    requestId: 'summary-one-click',
    action: 'chat.create',
    data: { chatId: chat.id },
  });
  await f.sources.resumeAnalysis();
  assert.equal(aiCalls, 1);
  assert.equal(calls, 1);
  assert.equal(captured.search, false);
  assert.equal(captured.context.evidence.length, 28);
  assert.equal(f.desk.note(created.noteId).summary.coverage.omitted.length, 0);
  assert.equal(f.desk.note(created.noteId).summary.partial, false);
  f.desk.command({
    requestId: 'summary-second-click',
    action: 'chat.create',
    data: { chatId: chat.id },
  });
  await f.sources.resumeAnalysis();
  assert.equal(aiCalls, 1);
  assert.equal(f.desk.notes().length, 1);
  assert.equal(
    f.desk.db
      .prepare('SELECT data FROM sales_events LIMIT 1')
      .get()
      .data.includes('Вымышленная договорённость'),
    false,
  );
  await f.sources.close();
});

test('pending chat analysis resumes after restart; interruption/error is visible and does not lose the card', async (t) => {
  const f = fixture(t);
  f.sources.observeMail();
  f.desk.ingest({
    source: 'mail',
    account: 'mail-account',
    nativeId: 'queued-source',
    conversationId: 'queued-chat',
    version: 'v1',
    occurredAt: '2026-10-22T11:00:00Z',
  });
  const made = f.desk.command({
    requestId: 'queued-card-job',
    action: 'chat.create',
    data: { chatId: f.desk.readChats().items[0].id },
  });
  const restarted = new SalesDesk({ db: f.desk.db, now: () => NOW });
  f.sources.desk = restarted;
  await f.sources.resumeAnalysis();
  assert.equal(restarted.detail(made.noteId).jobs[0].state, 'error');
  assert.equal(restarted.notes().length, 1);
  assert.equal(restarted.events(made.noteId).length, 1);
  f.sources.max.settings = () => ({
    codexEnabled: true,
    codexTokenFile: 'synthetic-token',
  });
  f.sources.content = async () => ({
    text: 'Учебный запрос',
    source: 'mail',
    partial: true,
  });
  f.sources.ask = async (_, p) => ({
    answer: JSON.stringify({
      summary: 'Восстановленный итог',
      changes: '',
      sources: p.context.evidence.map((e) => e.id),
      proposals: [],
    }),
  });
  f.sources.analyze({
    noteId: made.noteId,
    revision: restarted.note(made.noteId).revision,
    requestId: made.jobId,
  });
  await f.sources.close();
  assert.equal(restarted.detail(made.noteId).jobs[0].state, 'done');
  assert.equal(restarted.note(made.noteId).summary.partial, true);
});

test('mail chains use exact reply references, never subject or sender identity', async (t) => {
  const f = fixture(t);
  f.desk.setSetting('intakePolicy', '30days');
  for (const [key, message] of [
    ['a', { messageId: '<root@invalid>' }],
    ['b', { messageId: '<reply@invalid>', inReplyTo: '<root@invalid>' }],
    ['c', { messageId: '<third@invalid>', inReplyTo: '<reply@invalid>' }],
    ['d', { messageId: '<independent@invalid>' }],
    [
      'e',
      {
        messageId: '<referenced@invalid>',
        references: ['<root@invalid>', '<reply@invalid>'],
      },
    ],
  ])
    f.mailDb.prepare('INSERT INTO mail_messages VALUES(?,?,?,?,?,?)').run(
      key,
      'mail-account',
      null,
      'done',
      JSON.stringify({
        message: {
          subject: 'Одинаковая тема',
          from: 'fiction@example.invalid',
          text: 'Учебное письмо',
          sentAt: '2026-10-22T11:00:00Z',
          ...message,
        },
      }),
      '2026-10-22T11:00:00Z',
    );
  f.sources.observeMail();
  const chats = f.desk.readChats({ channel: 'mail' });
  assert.deepEqual(chats.items.map((c) => c.messages).sort(), [1, 4]);
  await f.sources.close();
});

test('one-click summary retries newly discovered chat metadata without applying a stale result', async (t) => {
  const f = fixture(t);
  f.desk.setSetting('intakePolicy', 'new');
  const first = { ...f.messages[0], text: 'Учебный запрос' };
  const second = {
    ...first,
    id: 'new-during-first-read',
    text: 'Учебное уточнение',
  };
  f.sources.observeAvito({
    accountId: '1234',
    chatId: 'chat-1',
    page: { messages: [first], hasMore: false },
  });
  let reads = 0,
    asks = 0;
  f.sources.avito.conversationMessages = async () => {
    reads++;
    const page = { messages: [first, second], hasMore: false };
    f.sources.observeAvito({ accountId: '1234', chatId: 'chat-1', page });
    return page;
  };
  f.sources.max.settings = () => ({
    codexEnabled: true,
    codexTokenFile: 'synthetic-token',
  });
  f.sources.ask = async (_, p) => {
    asks++;
    return {
      answer: JSON.stringify({
        summary: 'Итог с уточнением',
        changes: '',
        sources: p.context.evidence.map((e) => e.id),
        proposals: [],
      }),
    };
  };
  const result = f.desk.command({
    requestId: 'source-discovery',
    action: 'chat.create',
    data: { chatId: f.desk.readChats().items[0].id },
  });
  await f.sources.resumeAnalysis();
  assert.equal(reads, 2);
  assert.equal(asks, 1);
  assert.equal(f.desk.note(result.noteId).summary.coverage.processed.length, 2);
  assert.equal(f.desk.detail(result.noteId).jobs[0].state, 'done');
  await f.sources.close();
});

test('a write-failed analysis queue yields instead of spinning on the same durable pending job', async (t) => {
  const f = fixture(t);
  f.desk.ingest({
    source: 'mail',
    account: 'mail-account',
    nativeId: 'write-fail-source',
    conversationId: 'write-fail-chat',
    version: 'v1',
    occurredAt: '2026-10-22T11:00:00Z',
  });
  const made = f.desk.command({
    requestId: 'write-fail-job',
    action: 'chat.create',
    data: { chatId: f.desk.readChats().items[0].id },
  });
  const prepare = f.desk.db.prepare.bind(f.desk.db);
  let attempts = 0;
  f.desk.db.prepare = (sql) => {
    if (/UPDATE sales_jobs/.test(sql))
      return {
        run() {
          attempts++;
          throw new Error('synthetic disk full');
        },
      };
    return prepare(sql);
  };
  await f.sources.resumeAnalysis();
  assert.equal(attempts, 2);
  assert.equal(
    prepare('SELECT state FROM sales_jobs WHERE id=?').get(made.jobId).state,
    'pending',
  );
  await f.sources.resumeAnalysis();
  assert.equal(attempts, 2);
  f.desk.db.prepare = prepare;
  await f.sources.close();
});

test('global chat search matches displayed Avito titles before pagination and preserves account scope', async (t) => {
  const f = fixture(t);
  f.desk.setSetting('intakePolicy', 'new');
  f.sources.observeAvito({
    accountId: '1234',
    chatId: 'chat-1',
    page: { messages: f.messages, hasMore: false },
  });
  f.desk.ingest({
    source: 'avito',
    account: 'other-account',
    nativeId: 'other-msg',
    conversationId: 'chat-1',
    version: 'v1',
    occurredAt: '2026-10-22T11:00:00Z',
    title: 'Другой аккаунт',
  });
  const query = 'уЧЕБНОЕ оБЪЯВЛЕНИЕ';
  const result = f.desk.readChats({
    query,
    titleMatches: f.sources.matchingChatTitles(query),
  });
  assert.equal(result.page.total, 1);
  assert.equal(
    f.sources.describeChats(result.items)[0].title,
    'Учебное объявление',
  );
  assert.equal(
    f.sources
      .describeChats(f.desk.readChats().items)
      .find((c) => c.account === 'other-account').title,
    'Другой аккаунт',
  );
  await f.sources.close();
});

test('a queued first summary includes a source that arrived before its worker started', async (t) => {
  const f = fixture(t);
  f.desk.setSetting('intakePolicy', 'new');
  f.sources.observeAvito({
    accountId: '1234',
    chatId: 'chat-1',
    page: { messages: f.messages, hasMore: false },
  });
  const made = f.desk.command({
    requestId: 'queued-new-event',
    action: 'chat.create',
    data: { chatId: f.desk.readChats().items[0].id },
  });
  f.messages.push({
    ...f.messages[0],
    id: 'queued-arrival',
    text: 'Уточнение до начала анализа',
  });
  f.sources.observeAvito({
    accountId: '1234',
    chatId: 'chat-1',
    page: { messages: f.messages, hasMore: false },
  });
  f.sources.max.settings = () => ({
    codexEnabled: true,
    codexTokenFile: 'synthetic-token',
  });
  let calls = 0;
  f.sources.ask = async (_, p) => {
    calls++;
    return {
      answer: JSON.stringify({
        summary: 'Итог с новой репликой',
        changes: '',
        sources: p.context.evidence.map((e) => e.id),
        proposals: [],
      }),
    };
  };
  await f.sources.resumeAnalysis();
  assert.equal(calls, 1);
  assert.equal(f.desk.note(made.noteId).summary.coverage.processed.length, 2);
  await f.sources.close();
});

test('mail root remains stable when reply ancestors move outside the 500-row intake window', async (t) => {
  const f = fixture(t);
  f.desk.setSetting('intakePolicy', '30days');
  const save = (key, message, at) =>
    f.mailDb.prepare('INSERT INTO mail_messages VALUES(?,?,?,?,?,?)').run(
      key,
      'mail-account',
      null,
      'done',
      JSON.stringify({
        message: {
          subject: 'Учебная тема',
          text: 'Данные',
          sentAt: at,
          ...message,
        },
      }),
      at,
    );
  save('root', { messageId: 'root' }, '2026-10-22T10:00:00Z');
  save(
    'parent',
    { messageId: 'parent', inReplyTo: 'root' },
    '2026-10-22T10:01:00Z',
  );
  save(
    'child',
    { messageId: 'child', inReplyTo: 'parent' },
    '2026-10-22T10:02:00Z',
  );
  f.sources.observeMail();
  const id = f.desk.readChats().items[0].id;
  for (let i = 0; i < 499; i++)
    save(
      'unrelated-' + i,
      { messageId: 'unrelated-' + i },
      '2026-10-22T11:00:00Z',
    );
  f.sources.observeMail();
  assert.equal(
    f.desk.readChats({ scope: 'all', query: 'mail:' }).page.total,
    500,
  );
  assert.equal(
    f.desk.db
      .prepare('SELECT count(*) n FROM sales_event_chats WHERE chat_id=?')
      .get(id).n,
    3,
  );
  await f.sources.close();
});

async function automaticFixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const f = fixture(t);
  f.desk.now = Date.now;
  f.desk.setSetting('intakePolicy', 'new');
  f.calls = [];
  f.sources.max.settings = () => ({
    codexEnabled: true,
    codexTokenFile: 'synthetic',
  });
  f.answer = (_, p) => {
    f.calls.push(p);
    return {
      answer: JSON.stringify({
        summary: 'Учебный итог: ' + p.context.evidence.length,
        changes: '',
        sources: p.context.evidence
          .filter((e) => !e.unavailable)
          .slice(-6)
          .map((e) => e.id),
        proposals: [],
      }),
    };
  };
  f.sources.ask = async (...args) => f.answer(...args);
  f.observe = () =>
    f.sources.observeAvito({
      accountId: '1234',
      chatId: 'chat-1',
      page: { messages: f.messages, hasMore: false },
    });
  f.receive = (id) => {
    f.messages.push({ ...f.messages[0], id, text: 'Учебное уточнение ' + id });
    f.observe();
  };
  f.advance = async (ms) => {
    t.mock.timers.tick(ms);
    await new Promise((resolve) => setImmediate(resolve));
    if (f.sources.analysisFlight) await f.sources.analysisFlight;
  };
  f.observe();
  f.made = f.desk.command({
    requestId: 'auto-initial',
    action: 'chat.create',
    data: { chatId: f.desk.readChats().items[0].id },
  });
  await f.sources.resumeAnalysis();
  assert.equal(f.calls.length, 1);
  return f;
}

test('new chat messages debounce automatically, duplicate events cost no model calls, and the queue wakes itself', async (t) => {
  const f = await automaticFixture(t);
  f.receive('second');
  await f.sources.resumeAnalysis();
  assert.equal(f.desk.detail(f.made.noteId).analysis.state, 'pending');
  await f.advance(6000);
  f.receive('third');
  await f.sources.resumeAnalysis();
  await f.advance(6000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.desk.note(f.made.noteId).summary.text, 'Учебный итог: 1');
  await f.advance(4000);
  assert.equal(f.calls.length, 2);
  assert.equal(f.desk.note(f.made.noteId).summary.text, 'Учебный итог: 3');
  assert.equal(f.desk.detail(f.made.noteId).analysis, null);
  f.observe();
  await f.advance(60000);
  assert.equal(f.calls.length, 2);
  assert.equal(f.desk.snapshot().notes[0].summaryStale, false);
});

test('continuous arrivals have a bounded debounce and edits refresh without merging another account or ambiguous project', async (t) => {
  const f = await automaticFixture(t);
  f.receive('start');
  await f.sources.resumeAnalysis();
  for (let i = 0; i < 5; i++) {
    await f.advance(5000);
    f.receive('burst-' + i);
    await f.sources.resumeAnalysis();
  }
  await f.advance(5000);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].context.evidence.length, 7);
  f.messages[0].text = 'Исправленные учебные размеры';
  f.observe();
  await f.sources.resumeAnalysis();
  await f.advance(10000);
  assert.equal(f.calls.length, 3);
  const event = f.desk.events(f.made.noteId)[0];
  const n = f.desk.command({
    requestId: 'second-project',
    action: 'note.create',
    data: { title: 'Второй проект', owner: 'Тест' },
  });
  f.desk.command({
    requestId: 'project-link',
    action: 'event.link',
    data: {
      noteId: n.id,
      revision: n.revision,
      eventId: event.id,
      eventRevision: event.revision,
    },
  });
  f.receive('ambiguous');
  f.sources.observeAvito({
    accountId: 'another-account',
    chatId: 'chat-1',
    page: { messages: [{ ...f.messages[0], id: 'foreign' }], hasMore: false },
  });
  await f.sources.resumeAnalysis();
  await f.advance(60000);
  assert.equal(f.calls.length, 3);
  assert.equal(f.desk.events(f.made.noteId).length, 7);
  assert.equal(f.desk.events(n.id).length, 1);
});

test('arrival and manager edits during analysis discard its stale result and automatically use the latest context', async (t) => {
  const f = await automaticFixture(t);
  let release, started;
  const began = new Promise((resolve) => {
    started = resolve;
  });
  f.sources.ask = async (...args) => {
    const result = f.answer(...args);
    started();
    await new Promise((resolve) => {
      release = resolve;
    });
    return result;
  };
  f.receive('second');
  await f.sources.resumeAnalysis();
  t.mock.timers.tick(10000);
  await began;
  f.receive('third');
  f.desk.command({
    requestId: 'manager-note',
    action: 'note.update',
    data: {
      id: f.made.noteId,
      revision: f.desk.note(f.made.noteId).revision,
      patch: { manual: 'Ручное уточнение менеджера' },
    },
  });
  f.sources.ask = async (...args) => f.answer(...args);
  release();
  await f.sources.analysisFlight;
  assert.equal(f.desk.note(f.made.noteId).summary.text, 'Учебный итог: 1');
  await f.advance(10000);
  const updated = f.desk.detail(f.made.noteId);
  assert.equal(updated.summary.text, 'Учебный итог: 3');
  assert.equal(updated.manual, 'Ручное уточнение менеджера');
  assert.equal('tasks' in updated, false);
  assert.equal('tasks' in f.calls.at(-1).context, false);
  assert.equal(f.calls.at(-1).context.manual, updated.manual);
  assert.equal(
    updated.jobs.filter((j) => j.state === 'pending' || j.state === 'running')
      .length,
    0,
  );
});

test('automatic source and provider failures retain the last summary, back off, and recover with a bounded retry budget', async (t) => {
  const f = await automaticFixture(t);
  f.sources.content = async () => {
    throw new Error('synthetic source outage');
  };
  f.receive('second');
  await f.sources.resumeAnalysis();
  await f.advance(10000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.desk.note(f.made.noteId).summary.text, 'Учебный итог: 1');
  assert.equal(f.desk.detail(f.made.noteId).analysis.retrying, true);
  f.sources.content = async () => ({
    text: 'Источник восстановлен',
    source: 'avito',
    partial: true,
  });
  let failures = 0;
  f.sources.ask = async () => {
    failures++;
    throw new Error('synthetic provider busy');
  };
  await f.advance(60000);
  assert.equal(failures, 1);
  await f.advance(300000);
  assert.equal(failures, 2);
  await f.advance(1800000);
  assert.equal(failures, 3);
  assert.equal(f.desk.detail(f.made.noteId).analysis.state, 'error');
  await f.advance(3600000);
  assert.equal(failures, 3);
  f.sources.ask = async (...args) => f.answer(...args);
  f.receive('third');
  await f.sources.resumeAnalysis();
  await f.advance(10000);
  assert.equal(f.desk.note(f.made.noteId).summary.text, 'Учебный итог: 3');
});

test('automatic queue survives process restart and recovers a running job without losing source changes', async (t) => {
  const f = await automaticFixture(t);
  f.receive('second');
  await f.sources.resumeAnalysis();
  const job = f.desk.detail(f.made.noteId).jobs[0];
  f.desk.db
    .prepare("UPDATE sales_jobs SET state='running' WHERE id=?")
    .run(job.id);
  await f.sources.close();
  const restarted = new SalesDesk({ db: f.desk.db, now: Date.now });
  const sources = new SalesSources({
    desk: restarted,
    avito: f.sources.avito,
    importer: f.sources.importer,
    mail: f.sources.mail,
    max: f.sources.max,
    ask: async (...args) => f.answer(...args),
  });
  t.after(() => sources.close());
  f.sources = sources;
  await sources.resumeAnalysis();
  assert.equal(restarted.detail(f.made.noteId).analysis.state, 'pending');
  await f.advance(10000);
  assert.equal(restarted.note(f.made.noteId).summary.text, 'Учебный итог: 2');
  assert.equal(f.calls.length, 2);
  await sources.close();
});

test('archiving before an automatic refresh prevents model work and preserves the previous summary', async (t) => {
  const f = await automaticFixture(t);
  f.receive('second');
  await f.sources.resumeAnalysis();
  f.desk.command({
    requestId: 'archive-auto',
    action: 'note.update',
    data: {
      id: f.made.noteId,
      revision: f.desk.note(f.made.noteId).revision,
      patch: { status: 'archived' },
    },
  });
  await f.advance(10000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.desk.detail(f.made.noteId).analysis, null);
  f.receive('after-archive');
  await f.advance(60000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.desk.events(f.made.noteId).length, 2);
});

test('manual-only notes still use the shared analysis queue without external evidence', async (t) => {
  const f = fixture(t);
  const n = f.desk.command({
    requestId: 'manual-only-note',
    action: 'note.create',
    data: {
      title: 'Ручная записка',
      owner: 'Тест',
      manual: 'Уточнить размеры перед расчётом',
    },
  });
  f.sources.max.settings = () => ({
    codexEnabled: true,
    codexTokenFile: 'synthetic',
  });
  let calls = 0;
  f.sources.ask = async () => {
    calls++;
    return {
      answer: JSON.stringify({
        summary: 'Нужно уточнить размеры.',
        changes: '',
        sources: [],
        proposals: [],
      }),
    };
  };
  f.sources.analyze({
    noteId: n.id,
    revision: n.revision,
    requestId: 'manual-only-job',
  });
  await f.sources.resumeAnalysis();
  assert.equal(calls, 1);
  assert.equal(f.desk.note(n.id).summary.text, 'Нужно уточнить размеры.');
});

test('an after-provider reschedule write failure preserves a durable automatic retry', async (t) => {
  const f = await automaticFixture(t);
  const prepare = f.desk.db.prepare.bind(f.desk.db);
  let failed = false;
  f.sources.ask = async (...args) => {
    const result = f.answer(...args),
      note = f.desk.note(f.made.noteId);
    f.desk.command({
      requestId: 'race-manual-reschedule',
      action: 'note.manual',
      data: {
        id: note.id,
        before: note.manual,
        manual: 'Новое ручное уточнение',
      },
    });
    f.desk.db.prepare = (sql) => {
      if (!failed && sql.includes('INSERT INTO sales_jobs')) {
        failed = true;
        throw new Error('synthetic one-shot write failure');
      }
      return prepare(sql);
    };
    return result;
  };
  f.receive('second');
  await f.sources.resumeAnalysis();
  await f.advance(10000);
  assert.equal(failed, true);
  assert.equal(f.desk.detail(f.made.noteId).analysis.state, 'pending');
  assert.equal(f.desk.note(f.made.noteId).summary.text, 'Учебный итог: 1');
  f.desk.db.prepare = prepare;
  f.sources.ask = async (...args) => f.answer(...args);
  await f.advance(60000);
  await f.advance(10000);
  assert.equal(f.desk.note(f.made.noteId).summary.text, 'Учебный итог: 2');
});

test('a new message arriving during provider failure inherits its backoff and retry budget', async (t) => {
  const f = await automaticFixture(t);
  let calls = 0;
  f.sources.ask = async () => {
    calls++;
    f.receive('during-failure');
    throw new Error('synthetic provider unavailable');
  };
  f.receive('second');
  await f.sources.resumeAnalysis();
  await f.advance(10000);
  const pending = f.desk
    .detail(f.made.noteId)
    .jobs.find((j) => j.state === 'pending');
  assert.equal(pending.data.failures, 1);
  assert.equal(pending.data.dueAt, Date.now() + 60000);
  f.sources.ask = async (...args) => {
    calls++;
    return f.answer(...args);
  };
  await f.advance(10000);
  assert.equal(calls, 1);
  await f.advance(50000);
  assert.equal(calls, 2);
  assert.equal(f.desk.note(f.made.noteId).summary.text, 'Учебный итог: 3');
});

test('a transiently unreadable new message retries even when old messages can be read', async (t) => {
  const f = await automaticFixture(t),
    content = f.sources.content.bind(f.sources);
  f.receive('temporarily-unreadable');
  const unread = f.desk
    .events(f.made.noteId)
    .find((e) => e.nativeId === 'temporarily-unreadable').id;
  f.sources.content = async (id, cache) => {
    if (id === unread) throw new Error('temporary');
    return content(id, cache);
  };
  await f.sources.resumeAnalysis();
  await f.advance(10000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.desk.detail(f.made.noteId).analysis.state, 'pending');
  f.sources.content = content;
  await f.advance(60000);
  assert.equal(f.calls.length, 2);
  assert.equal(f.desk.note(f.made.noteId).summary.coverage.omitted.length, 0);
});

test('failed source construction cannot start an orphan queue against a closed sales database', async () => {
  const db = new Database(':memory:'),
    desk = new SalesDesk({ db });
  let reads = 0;
  const prepare = db.prepare.bind(db);
  db.prepare = (...args) => {
    reads++;
    return prepare(...args);
  };
  assert.throws(
    () =>
      new SalesSources({
        desk,
        mail: {
          db: {
            exec() {
              throw new Error('failed receipts init');
            },
          },
        },
        max: { settings: () => null },
      }),
  );
  db.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 0);
});
