import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { SalesDesk } from './sales-desk.mjs';
import { SalesSources } from './sales-sources.mjs';
import { normalizeOrderDraft, salesOrderPrefill } from './sales-order.mjs';

function fixture(t) {
  const db = new Database(':memory:'),
    mailDb = new Database(':memory:');
  const desk = new SalesDesk({ db });
  desk.setSetting('intakePolicy', 'new');
  const messages = [
    {
      id: 'synthetic-message',
      createdAt: new Date().toISOString(),
      direction: 'in',
      type: 'text',
      text: 'Учебный запрос',
    },
  ];
  const avito = {
    status: () => ({ enabled: true, configured: true, accountId: '1234' }),
    conversationMessages: async () => ({ messages, hasMore: false }),
    sendChatMessage: async () => ({ id: 'synthetic-outgoing' }),
  };
  const sources = new SalesSources({
    desk,
    avito,
    importer: {
      view: () => ({
        chats: [{ id: 'synthetic-chat', itemTitle: 'Учебный баннер' }],
      }),
    },
    mail: { db: mailDb },
    max: { settings: () => null },
  });
  sources.observeAvito({
    accountId: '1234',
    chatId: 'synthetic-chat',
    page: { messages, hasMore: false },
  });
  const chatId = desk.readChats().items[0].id;
  t.after(async () => {
    await sources.close();
    db.close();
    mailDb.close();
  });
  const command = (action, data) =>
    desk.command({ requestId: crypto.randomUUID(), action, data });
  return { db, desk, sources, avito, chatId, command, messages };
}
const order = (id) => ({
  title: 'Учебный баннер',
  client: 'Учебный клиент',
  description: 'Баннер 3 × 2 м',
  amount: 12000,
  desiredDate: '2026-11-01',
  items: [{ name: 'Баннер', description: 'Печать 3 × 2 м', quantity: 2 }],
  sources: [id],
});
function summarize(f, extra = {}) {
  const made = f.command('chat.create', { chatId: f.chatId });
  const job = f.db
    .prepare('SELECT * FROM sales_jobs WHERE id=?')
    .get(made.jobId);
  const id = f.desk.events(made.noteId)[0].id;
  f.desk.finishAnalysis(job, {
    summary: '## Запрос\n• Учебный баннер',
    changes: '',
    sources: [id],
    proposals: [],
    orderDraft: order(id),
    ...extra,
  });
  return f.desk.note(made.noteId);
}

test('one-click manual note tolerates AI revisions but rejects another human edit; legacy chat IDs stay out of displayed titles', (t) => {
  const f = fixture(t),
    n = summarize(f);
  const initial = f.command('note.manual', {
    id: n.id,
    before: '',
    manual: 'Первый текст',
  });
  const job = f.desk.beginAnalysis(
    n.id,
    initial.revision,
    'manual-after-summary',
  );
  f.desk.finishAnalysis(job, {
    summary: 'Новый итог',
    changes: '',
    sources: [],
    proposals: [],
  });
  f.command('note.manual', {
    id: n.id,
    before: 'Первый текст',
    manual: 'Сохранено поверх нового саммари',
  });
  assert.equal(f.desk.note(n.id).summary.text, 'Новый итог');
  assert.throws(
    () =>
      f.command('note.manual', {
        id: n.id,
        before: 'Первый текст',
        manual: 'Чужая старая вкладка',
      }),
    { code: 'SALES_CONFLICT' },
  );
  const current = f.desk.note(n.id);
  f.desk.putNote({
    ...current,
    title: 'Баннер · ' + 'synthetic-chat'.slice(-12),
  });
  assert.equal(f.desk.detail(n.id).displayTitle, 'Учебный баннер');
});

test('order handoff is a read-only proposal with stable request IDs, unknown prices, exact sources and freshness guards', (t) => {
  const f = fixture(t),
    n = summarize(f),
    before = f.db.prepare('SELECT count(*) n FROM sales_commands').get().n;
  const draft = salesOrderPrefill(f.desk, n.id, n.summary.jobId);
  assert.equal(draft.values.amountOverride, 12000);
  assert.equal(draft.configDraft.items[0].data.qty, '2');
  assert.equal(draft.configDraft.items[0].data.unitPrice, undefined);
  assert.equal(salesOrderPrefill(f.desk, n.id).requestId, draft.requestId);
  assert.equal(
    f.db.prepare('SELECT count(*) n FROM sales_commands').get().n,
    before,
  );
  assert.equal(
    normalizeOrderDraft({ ...order('a'), amount: null }, ['a']).amount,
    null,
  );
  assert.throws(() => normalizeOrderDraft(order('unread'), ['read']), {
    code: 'SALES_ORDER_DRAFT_INVALID',
  });
  assert.throws(
    () =>
      normalizeOrderDraft({ ...order('a'), desiredDate: '2026-02-30' }, ['a']),
    { code: 'SALES_ORDER_DRAFT_INVALID' },
  );
  const current = f.desk.note(n.id);
  f.desk.putNote({
    ...current,
    summary: {
      ...current.summary,
      orderDraft: {
        ...current.summary.orderDraft,
        client: '',
        items: [{ name: 'Баннер', quantity: null }],
      },
    },
  });
  const partial = salesOrderPrefill(f.desk, n.id);
  assert.equal(partial.configDraft.items[0].data.qty, '');
  assert.ok(partial.missing.includes('изделия и количество'));
  f.desk.putNote({ ...f.desk.note(n.id), summary: n.summary });
  f.sources.observeAvito({
    accountId: '1234',
    chatId: 'synthetic-chat',
    page: {
      messages: [{ ...f.messages[0], id: 'new-message' }],
      hasMore: false,
    },
  });
  assert.match(
    salesOrderPrefill(f.desk, n.id).warning,
    /Не удалось полностью обновить/,
  );
});

test('chat history keeps exact source/account scope and returns texts on demand without archiving them', async (t) => {
  const f = fixture(t);
  const page = await f.sources.chatThread(f.chatId);
  assert.equal(page.messages[0].text, 'Учебный запрос');
  assert.equal(page.canSend, true);
  assert.equal(
    f.db
      .prepare('SELECT data FROM sales_events')
      .get()
      .data.includes('Учебный запрос'),
    false,
  );
  await assert.rejects(() => f.sources.chatThread(f.chatId, 1), {
    code: 'SALES_INPUT',
  });
  f.avito.status = () => ({ accountId: '9999' });
  await assert.rejects(() => f.sources.chatThread(f.chatId), {
    code: 'SALES_SOURCE_SCOPE',
  });
  await assert.rejects(
    () =>
      f.sources.sendChat({
        chatId: f.chatId,
        requestId: 'scoped-send',
        text: 'Не отправлять',
      }),
    { code: 'SALES_SOURCE_SCOPE' },
  );
});

test('chat double click and a lost success response reuse one durable send; resolving cannot race an in-flight send', async (t) => {
  const f = fixture(t);
  let count = 0,
    release;
  f.avito.sendChatMessage = async () => {
    count++;
    await new Promise((r) => {
      release = r;
    });
    return { id: 'sent-1' };
  };
  const input = {
    chatId: f.chatId,
    requestId: 'double-send',
    text: 'Учебный ответ',
  };
  const first = f.sources.sendChat(input),
    second = f.sources.sendChat({
      text: input.text,
      requestId: input.requestId,
      chatId: input.chatId,
    });
  assert.throws(
    () =>
      f.sources.resolveSend({ chatId: f.chatId, requestId: input.requestId }),
    { code: 'SALES_SEND_PENDING' },
  );
  await assert.rejects(
    () => f.sources.sendChat({ ...input, text: 'Подмена' }),
    { code: 'SALES_ID_REUSED' },
  );
  release();
  const result = await first;
  assert.deepEqual(await second, result);
  assert.deepEqual(await f.sources.sendChat(input), result);
  assert.equal(count, 1);
  const row = f.db.prepare('SELECT * FROM sales_outgoing').get();
  assert.equal(row.state, 'sent');
  assert.equal(JSON.stringify(row).includes(input.text), false);
});

test('ambiguous send never retries automatically, including a new ID, until explicit human verification', async (t) => {
  const f = fixture(t);
  let count = 0;
  f.avito.sendChatMessage = async () => {
    count++;
    throw Object.assign(new Error('timeout'), { code: 'unavailable' });
  };
  const input = {
    chatId: f.chatId,
    requestId: 'unknown-send',
    text: 'Учебный ответ',
  };
  await assert.rejects(() => f.sources.sendChat(input), {
    code: 'SALES_SEND_UNKNOWN',
  });
  await assert.rejects(() => f.sources.sendChat(input), {
    code: 'SALES_SEND_UNKNOWN',
  });
  await assert.rejects(
    () => f.sources.sendChat({ ...input, requestId: 'another-send' }),
    { code: 'SALES_SEND_UNKNOWN', current: { requestId: input.requestId } },
  );
  assert.equal(count, 1);
  f.sources.resolveSend(input);
  f.avito.sendChatMessage = async () => {
    count++;
    return { id: 'retry-sent' };
  };
  assert.equal(
    (await f.sources.sendChat({ ...input, requestId: 'human-retry' })).state,
    'sent',
  );
  assert.equal(count, 2);
});

test('explicit cancellation before a receipt leaves a tombstone that blocks a delayed original send', async (t) => {
  const f = fixture(t);
  let count = 0;
  f.avito.sendChatMessage = async () => {
    count++;
    return { id: 'after-cancel' };
  };
  const input = {
    chatId: f.chatId,
    requestId: 'pre-receipt-request',
    text: 'Учебный ответ',
  };
  assert.deepEqual(f.sources.resolveSend(input), { state: 'resolved' });
  await assert.rejects(() => f.sources.sendChat(input), {
    code: 'SALES_ID_REUSED',
  });
  assert.equal(count, 0);
  assert.equal(
    (await f.sources.sendChat({ ...input, requestId: 'new-human-request' }))
      .state,
    'sent',
  );
  assert.equal(count, 1);
});

test('durable observed chats remain readable and sendable beyond the recent importer page', async (t) => {
  const f = fixture(t);
  f.sources.importer.view = () => ({ chats: [] });
  const page = await f.sources.chatThread(f.chatId);
  assert.equal(page.messages[0].text, 'Учебный запрос');
  assert.equal(page.canSend, true);
  let sends = 0;
  f.avito.sendChatMessage = async () => {
    sends++;
    return { id: 'synthetic-outgoing' };
  };
  await f.sources.sendChat({
    chatId: f.chatId,
    requestId: 'outside-recent-page',
    text: 'Учебный ответ',
  });
  assert.equal(sends, 1);
  await assert.rejects(() => f.sources.chatThread('a'.repeat(64)), {
    code: 'SALES_NOT_FOUND',
  });
  await assert.rejects(
    () =>
      f.sources.sendChat({
        chatId: 'a'.repeat(64),
        requestId: 'unobserved-chat',
        text: 'Не отправлять',
      }),
    { code: 'SALES_NOT_FOUND' },
  );
  f.avito.status = () => ({
    enabled: false,
    configured: true,
    accountId: '1234',
  });
  await assert.rejects(() => f.sources.chatThread(f.chatId), {
    code: 'SALES_SOURCE_UNAVAILABLE',
  });
  await assert.rejects(
    () =>
      f.sources.sendChat({
        chatId: f.chatId,
        requestId: 'disabled-chat',
        text: 'Не отправлять',
      }),
    { code: 'SALES_SOURCE_UNAVAILABLE' },
  );
  assert.equal(sends, 1);
});
