import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SalesDesk, salesHash } from './sales-desk.mjs';
import { salesOrderPrefill } from './sales-order.mjs';
const NOW = Date.parse('2026-10-22T10:00:00Z');
function fixture(t, file = ':memory:') {
  const db = new Database(file);
  const desk = new SalesDesk({ db, now: () => NOW });
  t.after(() => {
    if (db.open) db.close();
  });
  return desk;
}
// Close every connection before removing a file-backed fixture on Windows.
function diskFixture(t, prefix, name = 'sales.sqlite3') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const connections = [];
  t.after(() => {
    for (const db of connections) if (db.open) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return () => {
    const desk = fixture(t, path.join(dir, name));
    connections.push(desk.db);
    return desk;
  };
}
const command = (
  desk,
  action,
  data,
  requestId = crypto.randomUUID(),
  profile = 'owner',
) => desk.command({ requestId, action, data }, 'Руководитель', profile);
const note = (desk, title = 'Вывеска для вымышленного кафе') =>
  command(desk, 'note.create', {
    title,
    client: 'Тестовый клиент',
    owner: 'Анна',
  });
// Retired records model an upgrade. No public command can create or edit them.
const task = (desk, n, extra = {}) =>
  desk.putTask({
    id: crypto.randomUUID(),
    noteId: n.id,
    revision: 0,
    state: 'accepted',
    action: 'Рассчитать',
    object: 'Вывеску',
    owner: 'Анна',
    dueAt: '2026-10-22T12:00:00Z',
    remindAt: '2026-10-22T09:00:00Z',
    ...extra,
  });
const event = (desk, id = 'message-1', version = 'version-1', extra = {}) =>
  desk.ingest({
    source: 'avito',
    account: 'account-1',
    nativeId: id,
    version,
    conversationId: 'conversation-1',
    occurredAt: '2026-10-22T09:00:00Z',
    direction: 'in',
    title: 'Сообщение Авито',
    url: 'https://www.avito.ru/profile/messenger/channel/conversation-1',
    contentHash: salesHash('fictional'),
    ...extra,
  });
const link = (desk, n, e) =>
  command(desk, 'event.link', {
    eventId: e.id,
    eventRevision: desk.db
      .prepare('SELECT revision FROM sales_events WHERE id=?')
      .get(e.id).revision,
    noteId: n.id,
    revision: desk.note(n.id).revision,
  });
function merge(desk, source, target) {
  return command(desk, 'notes.merge', {
    sourceId: source.id,
    sourceRevision: desk.note(source.id).revision,
    targetId: target.id,
    targetRevision: desk.note(target.id).revision,
    resolution: {
      title: target.title,
      client: target.client,
      owner: target.owner,
      status: 'active',
      waitingFor: '',
      reviewAt: null,
      orderId: '',
      manual: '',
    },
  });
}

test('sales command survives response loss and process reopening; same key different input fails', (t) => {
  const reopen = diskFixture(t, 'sales-test-');
  const d = reopen(),
    id = crypto.randomUUID(),
    input = { title: 'Проверка повтора', owner: 'Анна' };
  const a = command(d, 'note.create', input, id);
  d.db.close();
  const reopened = reopen();
  assert.deepEqual(command(reopened, 'note.create', input, id), a);
  assert.equal(reopened.notes().length, 1);
  assert.throws(
    () => command(reopened, 'note.create', { ...input, title: 'Другое' }, id),
    (e) => e.code === 'SALES_ID_REUSED',
  );
});
test('sales event dedup includes source/account/native ID and version; text alone is never duplicate', (t) => {
  const d = fixture(t);
  const a = event(d);
  assert.equal(event(d).duplicate, true);
  const b = event(d, 'message-2');
  assert.notEqual(a.id, b.id);
  event(d, 'message-1', 'version-2', { observedAt: '2026-10-22T11:00:00Z' });
  assert.equal(
    event(d, 'message-1', 'version-1', { observedAt: '2026-10-22T10:00:00Z' })
      .older,
    true,
  );
  assert.equal(d.db.prepare('SELECT count(*) n FROM sales_events').get().n, 2);
  assert.equal(
    d.db.prepare('SELECT count(*) n FROM sales_event_versions').get().n,
    3,
  );
  assert.throws(() =>
    event(d, 'bad-message', 'version-1', { url: 'https://evil.invalid/' }),
  );
});
test('sales one event can belong to two independent requests; nothing merges by client or chat', (t) => {
  const d = fixture(t),
    a = note(d),
    b = note(d, 'Вторая вывеска'),
    e = event(d);
  link(d, a, e);
  link(d, b, e);
  assert.equal(d.events(a.id).length, 1);
  assert.equal(d.events(b.id).length, 1);
  assert.equal(d.notes().length, 2);
  assert.equal(d.snapshot().inbox.length, 0);
});
test('sales optimistic versions preserve manual edits during concurrent requests', (t) => {
  const d = fixture(t),
    n = note(d);
  command(d, 'note.update', {
    id: n.id,
    revision: n.revision,
    patch: { manual: 'Ручное уточнение' },
  });
  assert.throws(
    () =>
      command(d, 'note.update', {
        id: n.id,
        revision: n.revision,
        patch: { manual: 'Старая версия' },
      }),
    (e) =>
      e.code === 'SALES_CONFLICT' && e.current.manual === 'Ручное уточнение',
  );
  assert.equal(d.note(n.id).manual, 'Ручное уточнение');
});
test('sales positions are personal, pinning never changes shared status', (t) => {
  const d = fixture(t),
    n = note(d);
  command(
    d,
    'layout.save',
    {
      revision: 0,
      positions: { [n.id]: { x: 50, y: 60, pinned: true, zone: '' } },
      zones: [],
      zoom: 1,
    },
    crypto.randomUUID(),
    'profile-one',
  );
  assert.equal(d.layout('profile-one').positions[n.id].pinned, true);
  assert.deepEqual(d.layout('profile-two').positions, {});
  assert.equal(d.note(n.id).status, 'active');
  assert.throws(
    () =>
      command(
        d,
        'layout.save',
        { revision: 0, positions: {}, zones: [], zoom: 1 },
        crypto.randomUUID(),
        'profile-one',
      ),
    (e) => e.code === 'SALES_CONFLICT',
  );
});
test('retired tasks cannot be created, changed or used for reminders and archive guards', (t) => {
  const d = fixture(t),
    n = note(d),
    old = task(d, n);
  for (const action of ['task.create', 'task.update', 'task.move'])
    assert.throws(() => command(d, action, { id: old.id }), {
      code: 'SALES_REMOVED',
    });
  assert.deepEqual(d.snapshot().notifications, []);
  assert.deepEqual(d.snapshot().today, []);
  assert.equal('tasks' in d.detail(n.id), false);
  assert.equal('history' in d.detail(n.id), false);
  assert.equal('needsTriage' in d.snapshot().notes[0], false);
  const archived = command(d, 'note.update', {
    id: n.id,
    revision: d.note(n.id).revision,
    patch: { status: 'archived' },
  });
  const restored = command(d, 'note.update', {
    id: n.id,
    revision: archived.revision,
    patch: { status: 'active' },
  });
  assert.deepEqual(d.tasks(restored.id), [old]);
  assert.ok(d.db.prepare('SELECT count(*) n FROM sales_audit').get().n >= 3);
  assert.throws(() =>
    command(d, 'note.update', {
      id: n.id,
      revision: restored.revision,
      patch: { status: 'triage' },
    }),
  );
});

test('sales waiting requires owner and review moment; reading does not complete tasks', (t) => {
  const d = fixture(t),
    n = note(d),
    a = task(d, n);
  assert.throws(() =>
    command(d, 'note.update', {
      id: n.id,
      revision: d.note(n.id).revision,
      patch: { status: 'waiting' },
    }),
  );
  command(d, 'note.update', {
    id: n.id,
    revision: d.note(n.id).revision,
    patch: {
      status: 'waiting',
      waitingFor: 'Размеры витрины',
      reviewAt: '2026-10-23T10:00:00Z',
    },
  });
  command(d, 'note.read', { id: n.id, watermark: d.watermark(n.id) });
  assert.equal(d.task(a.id).state, 'accepted');
});
test('sales merge and undo preserve shared sources, task IDs, owners, files and promises', (t) => {
  const d = fixture(t),
    a = note(d),
    b = note(d, 'Основная'),
    ta = task(d, a),
    tb = task(d, b, { owner: 'Борис' }),
    e = event(d);
  link(d, a, e);
  link(d, b, e);
  const file = d.upload({
    requestId: crypto.randomUUID(),
    noteId: a.id,
    revision: d.note(a.id).revision,
    name: 'макет.pdf',
    mime: 'application/pdf',
    bytes: Buffer.from('%PDF-fixture'),
  });
  const merged = merge(d, a, b);
  assert.equal(d.note(a.id).mergedInto, b.id);
  assert.equal(d.tasks(b.id).length, 2);
  assert.equal(d.files(b.id)[0].id, file.id);
  assert.equal(d.task(ta.id).dueAt, ta.dueAt);
  assert.equal(d.task(tb.id).owner, 'Борис');
  command(d, 'notes.unmerge', { mergeId: merged.mergeId });
  assert.equal(d.tasks(a.id)[0].id, ta.id);
  assert.equal(d.events(a.id).length, 1);
  assert.equal(d.events(b.id).length, 1);
  assert.equal(d.files(a.id)[0].id, file.id);
});
test('unmerge rejects later edits and split moves selected messages while preserving retired records', (t) => {
  const d = fixture(t),
    a = note(d),
    b = note(d, 'Основная'),
    old = task(d, a),
    e = event(d);
  link(d, a, e);
  const merged = merge(d, a, b);
  command(d, 'note.manual', {
    id: b.id,
    before: '',
    manual: 'Позднее уточнение',
  });
  assert.throws(
    () => command(d, 'notes.unmerge', { mergeId: merged.mergeId }),
    { code: 'SALES_CONFLICT' },
  );
  const split = command(d, 'notes.split', {
    id: b.id,
    revision: d.note(b.id).revision,
    newNote: { title: 'Отдельный запрос', owner: 'Анна' },
    eventIds: [e.id],
    fileIds: [],
  });
  assert.equal(d.events(split.noteId)[0].id, e.id);
  assert.equal(d.events(b.id).length, 0);
  assert.equal(d.task(old.id).noteId, b.id);
  assert.throws(
    () =>
      command(d, 'notes.split', {
        id: b.id,
        revision: d.note(b.id).revision,
        newNote: { title: 'Ошибка', owner: 'Анна' },
        eventIds: [e.id],
        fileIds: [],
      }),
    { code: 'SALES_CONFLICT' },
  );
});

test('sales file bytes and receipt commit atomically, duplicates keep one version, approval explicit', (t) => {
  const d = fixture(t),
    n = note(d),
    input = {
      requestId: crypto.randomUUID(),
      noteId: n.id,
      revision: n.revision,
      name: 'Тестовый макет.pdf',
      mime: 'application/pdf',
      bytes: Buffer.from('%PDF-1.4 fiction'),
    };
  const a = d.upload(input);
  assert.deepEqual(d.upload(input), a);
  assert.equal(d.files(n.id).length, 1);
  assert.equal(d.note(n.id).approvedFile, undefined);
  command(d, 'file.approve', {
    id: a.id,
    noteId: n.id,
    revision: d.note(n.id).revision,
    reason: 'Тестовое ручное согласование',
  });
  assert.equal(d.note(n.id).approvedFile, a.id);
  const b = d.upload({
    ...input,
    requestId: crypto.randomUUID(),
    revision: d.note(n.id).revision,
    bytes: Buffer.from('%PDF-1.4 other'),
  });
  assert.notEqual(a.id, b.id);
  assert.equal(d.note(n.id).approvedFile, a.id);
});
test('sales stale analysis cannot overwrite a manual edit or newly received event', (t) => {
  const d = fixture(t),
    n = note(d),
    e = event(d);
  link(d, n, e);
  const j = d.beginAnalysis(n.id, d.note(n.id).revision, crypto.randomUUID());
  command(d, 'note.update', {
    id: n.id,
    revision: d.note(n.id).revision,
    patch: { manual: 'Свежее решение' },
  });
  assert.deepEqual(
    d.finishAnalysis(j, {
      summary: 'old',
      changes: '',
      sources: [e.id],
      proposals: [],
    }),
    { stale: true },
  );
  const k = d.beginAnalysis(n.id, d.note(n.id).revision, crypto.randomUUID());
  event(d, 'message-1', 'version-2');
  assert.equal(
    d.finishAnalysis(k, {
      summary: 'old',
      changes: '',
      sources: [e.id],
      proposals: [],
    }).stale,
    true,
  );
  assert.equal(d.note(n.id).summary, null);
  assert.equal(d.note(n.id).manual, 'Свежее решение');
});
test('analysis ignores legacy task proposals and never creates new tasks', (t) => {
  const d = fixture(t),
    n = note(d),
    e = event(d);
  link(d, n, e);
  const old = task(d, n);
  const j = d.beginAnalysis(n.id, d.note(n.id).revision, crypto.randomUUID());
  const result = {
    summary: 'Нужен макет',
    requestTitle: 'Макет вывески',
    changes: '',
    sources: [e.id],
    proposals: [{ action: 'Запросить', object: 'Макет', sources: [e.id] }],
  };
  d.finishAnalysis(j, result);
  assert.equal(d.finishAnalysis(j, result).duplicate, true);
  assert.deepEqual(d.tasks(n.id), [old]);
  assert.equal(d.detail(n.id).displayTitle, 'Макет вывески');
});

test('sales failures roll back partial commands and invalid AI source proposals', (t) => {
  const d = fixture(t),
    n = note(d),
    e = event(d);
  link(d, n, e);
  const j = d.beginAnalysis(n.id, d.note(n.id).revision, crypto.randomUUID());
  assert.throws(() =>
    d.finishAnalysis(j, {
      summary: 'Итог',
      changes: '',
      sources: ['missing'],
      proposals: [
        { action: 'Запросить', object: 'Размеры', sources: [e.id] },
        { action: 'Сделать', object: 'Неизвестное', sources: ['missing'] },
      ],
    }),
  );
  assert.equal(d.tasks(n.id).length, 0);
  assert.equal(d.note(n.id).summary, null);
});

test('sales authoritative reread A B A is a new revision; an older delivery cannot roll it back', (t) => {
  const d = fixture(t),
    n = note(d);
  const a = event(d, 'edit', 'A', { observedAt: '2026-10-22T10:00:00Z' });
  link(d, n, a);
  const first = d.watermark(n.id);
  event(d, 'edit', 'B', { observedAt: '2026-10-22T10:01:00Z' });
  event(d, 'edit', 'A', { observedAt: '2026-10-22T10:02:00Z' });
  assert.equal(d.events(n.id)[0].version, 'A');
  assert.equal(d.events(n.id)[0].revision, 3);
  assert.notEqual(d.watermark(n.id), first);
  assert.equal(
    event(d, 'edit', 'B', { observedAt: '2026-10-22T10:01:00Z' }).older,
    true,
  );
});
test('sales concurrent primary triage creates one note while explicit additional links remain allowed', (t) => {
  const d = fixture(t),
    e = event(d);
  const input = {
    eventId: e.id,
    eventRevision: 1,
    newNote: { title: 'Вымышленный запрос', owner: 'Анна' },
  };
  const a = command(d, 'event.link', input);
  assert.throws(
    () => command(d, 'event.link', input),
    (e) => e.code === 'SALES_ALREADY_LINKED',
  );
  assert.equal(d.notes().length, 1);
  const b = note(d, 'Отдельный вопрос');
  link(d, b, e);
  assert.equal(d.events(a.noteId).length, 1);
  assert.equal(d.events(b.id).length, 1);
});
test('sales approved file follows merge and split, while two approvals require an explicit choice', (t) => {
  const d = fixture(t),
    a = note(d, 'А'),
    b = note(d, 'Б');
  const upload = (n) => {
    const f = d.upload({
      requestId: crypto.randomUUID(),
      noteId: n.id,
      revision: d.note(n.id).revision,
      name: 'approved.pdf',
      mime: 'application/pdf',
      bytes: Buffer.from('pdf'),
    });
    command(d, 'file.approve', {
      id: f.id,
      noteId: n.id,
      revision: d.note(n.id).revision,
      reason: 'Подтверждено владельцем',
    });
    return f;
  };
  const fa = upload(a);
  merge(d, a, b);
  assert.equal(d.note(b.id).approvedFile, fa.id);
  const split = command(d, 'notes.split', {
    id: b.id,
    revision: d.note(b.id).revision,
    newNote: { title: 'Часть', owner: 'Анна' },
    taskIds: [],
    eventIds: [],
    fileIds: [fa.id],
  });
  assert.equal(d.note(split.noteId).approvedFile, fa.id);
  assert.equal(d.note(b.id).approvedFile, null);
  const c = note(d, 'В');
  upload(c);
  assert.throws(
    () => merge(d, c, d.note(split.noteId)),
    /Выберите согласованный файл/,
  );
});

test('sales intake needs an explicit allowed owner choice, durable receipt and atomic activation time', (t) => {
  const d = fixture(t);
  assert.equal(d.setting('intakePolicy'), null);
  assert.throws(() => command(d, 'intake.configure', { policy: '' }));
  assert.equal(d.setting('intakePolicy'), null);
  const key = crypto.randomUUID(),
    result = command(d, 'intake.configure', { policy: 'new' }, key);
  assert.equal(result.startedAt, new Date(NOW).toISOString());
  assert.deepEqual(
    command(d, 'intake.configure', { policy: 'new' }, key),
    result,
  );
  assert.throws(
    () => command(d, 'intake.configure', { policy: '30days' }),
    (e) => e.code === 'SALES_ALREADY_CONFIGURED',
  );
  assert.equal(d.setting('intakePolicy'), 'new');
});

test('inbox exposes the full queue, searches Russian text and traverses stable pages during concurrent triage', (t) => {
  const d = fixture(t),
    original = [];
  for (let i = 0; i < 1001; i++)
    original.push(
      event(d, 'inbox-' + i, 'v1', {
        historical: i !== 1000,
        title: i === 750 ? 'Особый МАКЕТ' : 'Учебное событие ' + i,
      }),
    );
  let snap = d.snapshot();
  assert.equal(snap.counts.inbox, 1001);
  assert.equal(snap.inbox.length, 100);
  assert.equal(snap.inboxPage.total, 1001);
  assert.equal(snap.today.find((v) => v.kind === 'inbox').count, 1);
  const seen = new Set(snap.inbox.map((v) => v.id));
  const linked = snap.inbox.find((v) => v.historical);
  link(d, note(d), linked);
  d.now = () => NOW + 1000;
  event(d, 'arrived-after-page', 'v1', {
    conversationId: 'new-chat-after-page',
  });
  let cursor = snap.inboxPage.nextCursor;
  while (cursor) {
    snap = d.snapshot('owner', { cursor });
    for (const value of snap.inbox) {
      assert.equal(seen.has(value.id), false);
      seen.add(value.id);
    }
    cursor = snap.inboxPage.nextCursor;
    assert.equal(snap.today.find((v) => v.kind === 'inbox').count, 2);
  }
  // A new arrival belongs to the first page; every original event stayed reachable.
  assert.equal(seen.size, original.length);
  assert.equal(
    original.every((v) => seen.has(v.id)),
    true,
  );
  assert.equal(d.snapshot().inbox[0].nativeId, 'arrived-after-page');
  const found = d.snapshot('owner', { query: 'оСОБЫЙ макет' });
  assert.equal(found.inboxPage.total, 1);
  assert.equal(found.inbox[0].title, 'Особый МАКЕТ');
  assert.equal(found.counts.inbox, 1001);
  const missing = d.snapshot('owner', { query: 'Нет такой строки' });
  assert.equal(missing.inboxPage.total, 0);
  assert.equal(missing.counts.inbox, 1001);
  for (const cursor of [
    '%%%',
    Buffer.from(JSON.stringify(['bad-date', 'arbitrary-event'])).toString(
      'base64url',
    ),
  ])
    assert.throws(() => d.snapshot('owner', { cursor }), /страница/);
  assert.throws(
    () => d.snapshot('owner', { query: 'x'.repeat(201) }),
    /заполнение/,
  );
});

test('chat cards group exact account/channel identities, persist one job and route only unambiguous new messages', (t) => {
  const d = fixture(t);
  for (let i = 0; i < 9; i++) event(d, 'chat-a-' + i, 'v1');
  event(d, 'same-id-other-account', 'v1', { account: 'other-account' });
  event(d, 'same-id-other-channel', 'v1', { source: 'max' });
  event(d, 'no-chat-a', 'v1', { conversationId: '' });
  event(d, 'no-chat-b', 'v1', { conversationId: '' });
  const chats = d.readChats();
  assert.equal(chats.items.length, 5);
  const group = chats.items.find((c) => c.messages === 9);
  const input = { chatId: group.id, title: 'Вымышленный заказ из чата' };
  const first = command(d, 'chat.create', input, 'durable-chat-1');
  assert.equal(d.events(first.noteId).length, 9);
  assert.equal(d.db.prepare('SELECT count(*) n FROM sales_jobs').get().n, 1);
  assert.deepEqual(command(d, 'chat.create', input, 'durable-chat-1'), first);
  assert.equal(command(d, 'chat.create', input).noteId, first.noteId);
  assert.equal(d.notes().length, 1);
  assert.equal(d.db.prepare('SELECT count(*) n FROM sales_jobs').get().n, 1);
  event(d, 'new-chat-a', 'v1');
  assert.equal(d.events(first.noteId).length, 10);
  assert.equal(
    d.readChats({ scope: 'all' }).items.find((c) => c.id === group.id).pending,
    0,
  );
  const second = note(d, 'Второй проект в том же чате');
  link(d, second, event(d, 'shared-project-message', 'v1'));
  const pending = event(d, 'ambiguous-new-message', 'v1');
  assert.equal(
    d.db
      .prepare('SELECT count(*) n FROM sales_links WHERE event_id=?')
      .get(pending.id).n,
    0,
  );
  assert.throws(
    () => command(d, 'chat.create', input),
    (e) => e.code === 'SALES_CHAT_AMBIGUOUS',
  );
  const routed = command(d, 'chat.create', { ...input, noteId: second.id });
  assert.equal(routed.linked, 1);
  assert.equal(
    d.events(second.id).some((e) => e.id === pending.id),
    true,
  );
  assert.equal(
    d.events(first.noteId).some((e) => e.id === pending.id),
    false,
  );
  assert.equal(d.notes().length, 2);
});

test('chat pages search every message, count channels and reject cursors from another filter', (t) => {
  const d = fixture(t);
  for (let i = 0; i < 123; i++) {
    event(d, 'group-message-' + i, 'v1', {
      conversationId: 'group-' + i,
      title: i === 1 ? 'Редкий МАКЕТ' : 'Учебный чат',
    });
    event(d, 'group-reply-' + i, 'v1', {
      conversationId: 'group-' + i,
      title: 'Ответ',
    });
  }
  let page = d.readChats({ channel: 'avito' });
  assert.equal(page.items.length, 50);
  assert.equal(page.page.total, 123);
  assert.equal(page.channels[0].messages, 246);
  const seen = new Set(page.items.map((c) => c.id));
  command(d, 'chat.create', { chatId: page.items[0].id });
  while (page.page.nextCursor) {
    page = d.readChats({ channel: 'avito', cursor: page.page.nextCursor });
    for (const c of page.items) {
      assert.equal(seen.has(c.id), false);
      seen.add(c.id);
    }
  }
  assert.equal(seen.size, 123);
  assert.equal(
    d.readChats({ query: 'рЕДКИЙ макет', scope: 'all' }).items.length,
    1,
  );
  assert.equal(
    d.readChats({ query: 'рЕДКИЙ макет', scope: 'all' }).items[0].messages,
    2,
  );
  const cursor = d.readChats({ channel: 'avito', scope: 'all' }).page
    .nextCursor;
  for (const extra of [
    { channel: 'max', scope: 'all' },
    { channel: 'avito', query: 'new', scope: 'all' },
    { channel: 'avito', scope: 'pending' },
  ])
    assert.throws(() => d.readChats({ cursor, ...extra }), /страница чатов/);
});

test('chat metadata migration preserves existing event versions, links and receipts', () => {
  const db = new Database(':memory:');
  db.exec(
    `CREATE TABLE sales_events(id TEXT PRIMARY KEY,source TEXT NOT NULL,account TEXT NOT NULL,native_id TEXT NOT NULL,version TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,received_at TEXT NOT NULL,UNIQUE(source,account,native_id))`,
  );
  const meta = {
    source: 'avito',
    account: 'migration-account',
    nativeId: 'migration-message',
    conversationId: 'migration-chat',
    title: 'Учебный чат',
    occurredAt: new Date(NOW).toISOString(),
  };
  db.prepare('INSERT INTO sales_events VALUES(?,?,?,?,?,?,?,?)').run(
    'migration-event',
    meta.source,
    meta.account,
    meta.nativeId,
    'v7',
    7,
    JSON.stringify(meta),
    meta.occurredAt,
  );
  let d = new SalesDesk({ db });
  const n = note(d);
  command(d, 'event.link', {
    eventId: 'migration-event',
    eventRevision: 7,
    noteId: n.id,
    revision: n.revision,
  });
  d = new SalesDesk({ db });
  assert.equal(d.readChats({ scope: 'all' }).items[0].notes[0].id, n.id);
  assert.equal(d.events(n.id)[0].revision, 7);
  assert.equal(
    d.db.prepare('SELECT count(*) n FROM sales_commands').get().n,
    2,
  );
  db.close();
});

test('new chat message after merge prevents undo from leaving it on the wrong restored project', (t) => {
  const d = fixture(t),
    a = note(d, 'Проект А'),
    b = note(d, 'Проект Б');
  link(d, a, event(d, 'original-a', 'v1', { conversationId: 'project-a' }));
  link(d, b, event(d, 'original-b', 'v1', { conversationId: 'project-b' }));
  const merged = merge(d, a, b);
  event(d, 'new-after-merge', 'v1', { conversationId: 'project-a' });
  assert.throws(
    () => command(d, 'notes.unmerge', { mergeId: merged.mergeId }),
    (e) => e.code === 'SALES_CONFLICT',
  );
  assert.equal(d.note(a.id).status, 'merged');
});

test('a fresh card after archive keeps whole chat context without transferring archived tasks', (t) => {
  const d = fixture(t),
    old = note(d);
  link(d, old, event(d, 'archived-discussion'));
  command(d, 'note.update', {
    id: old.id,
    revision: d.note(old.id).revision,
    patch: { status: 'archived' },
  });
  event(d, 'fresh-discussion');
  const chat = d.readChats().items[0];
  const result = command(d, 'chat.create', { chatId: chat.id });
  assert.notEqual(result.noteId, old.id);
  assert.equal(d.events(result.noteId).length, 2);
  assert.equal(d.events(old.id).length, 1);
  assert.equal(d.note(old.id).status, 'archived');
});

test('partial layout commands merge concurrent tabs and preserve receipt ordering across restart', (t) => {
  const reopen = diskFixture(t, 'sales-layout-');
  const d = reopen(),
    n = note(d);
  const a = command(
    d,
    'layout.patch',
    { positions: { [n.id]: { x: 150, y: 90 } } },
    'layout-move-1',
  );
  command(d, 'layout.patch', {
    positions: { [n.id]: { pinned: true } },
    zones: [{ id: 'zone-fictional', name: 'Кафе' }],
  });
  command(d, 'layout.patch', {
    positions: { [n.id]: { zone: 'zone-fictional' } },
    zoom: 1.2,
  });
  // A stale tab may move the same note, but cannot erase its pin, zone or zoom.
  command(d, 'layout.patch', { positions: { [n.id]: { x: 180, y: 110 } } });
  assert.deepEqual(d.layout('owner').positions[n.id], {
    x: 180,
    y: 110,
    pinned: true,
    zone: 'zone-fictional',
  });
  assert.equal(d.layout('owner').zoom, 1.2);
  assert.equal(d.layout('another-profile').revision, 0);
  const revision = d.layout('owner').revision;
  assert.throws(() =>
    command(d, 'layout.patch', { zoom: 20, positions: { [n.id]: { x: 99 } } }),
  );
  assert.equal(d.layout('owner').revision, revision);
  d.db.close();
  const reopened = reopen();
  assert.deepEqual(
    command(
      reopened,
      'layout.patch',
      { positions: { [n.id]: { x: 150, y: 90 } } },
      'layout-move-1',
    ),
    a,
  );
  assert.equal(reopened.layout('owner').positions[n.id].x, 180);
  assert.throws(() => command(reopened, 'layout.patch', { positions: [] }));
  assert.throws(() =>
    command(reopened, 'layout.patch', {
      positions: { [n.id]: { unknown: true } },
    }),
  );
});

test('trash survives restart and restores notes, open obligations, files, links and layout', (t) => {
  const reopen = diskFixture(t, 'sales-trash-');
  const d = reopen(),
    n = note(d),
    e = event(d);
  link(d, n, e);
  const obligation = task(d, n);
  command(d, 'note.manual', {
    id: n.id,
    before: '',
    manual: 'Сохранить замеры',
  });
  const attachment = d.upload({
    requestId: 'trash-file-1',
    noteId: n.id,
    revision: d.note(n.id).revision,
    name: 'test.pdf',
    mime: 'application/pdf',
    bytes: Buffer.from('fictional'),
  });
  command(d, 'layout.patch', { positions: { [n.id]: { x: 340, y: 170 } } });
  const original = d.note(n.id),
    tasks = d.tasks(n.id),
    files = d.files(n.id),
    layout = d.layout('owner');
  const removed = command(d, 'note.trash', { id: n.id }, 'trash-receipt-1');
  assert.throws(
    () => salesOrderPrefill(d, n.id),
    (e) => e.code === 'SALES_CLOSED',
  );
  assert.equal(d.snapshot().notes.length, 0);
  assert.equal('openTasks' in d.snapshot().trash[0], false);
  assert.equal(
    d.snapshot().today.some((x) => x.noteId === n.id),
    false,
  );
  assert.equal(
    d.snapshot().notifications.some((x) => x.noteId === n.id),
    false,
  );
  assert.deepEqual(d.tasks(n.id), tasks);
  assert.deepEqual(d.files(n.id), files);
  assert.ok(attachment);
  assert.equal(d.events(n.id)[0].id, e.id);
  assert.throws(
    () =>
      command(d, 'note.manual', {
        id: n.id,
        before: original.manual,
        manual: 'замена',
      }),
    (e) => e.code === 'SALES_CLOSED',
  );
  assert.throws(
    () =>
      command(d, 'note.update', {
        id: n.id,
        revision: removed.revision,
        patch: { status: 'active' },
      }),
    (e) => e.code === 'SALES_CLOSED',
  );
  assert.throws(
    () =>
      command(d, 'task.update', {
        id: obligation.id,
        revision: obligation.revision,
        patch: { state: 'done' },
      }),
    (e) => e.code === 'SALES_REMOVED',
  );
  assert.throws(
    () => d.beginAnalysis(n.id, removed.revision, 'trash-analysis-1'),
    (e) => e.code === 'SALES_CLOSED',
  );
  d.db.close();
  const reopened = reopen();
  assert.deepEqual(
    command(reopened, 'note.trash', { id: n.id }, 'trash-receipt-1'),
    removed,
  );
  assert.equal(reopened.snapshot().trash.length, 1);
  command(
    reopened,
    'note.restore',
    { id: n.id, trashId: removed.trashId },
    'restore-receipt-1',
  );
  assert.equal(reopened.note(n.id).manual, original.manual);
  assert.equal(reopened.note(n.id).status, original.status);
  assert.deepEqual(reopened.tasks(n.id), tasks);
  assert.deepEqual(reopened.files(n.id), files);
  assert.deepEqual(reopened.layout('owner'), layout);
  assert.equal(
    reopened.snapshot().today.some((x) => x.noteId === n.id),
    false,
  );
  const removedAgain = command(
    reopened,
    'note.trash',
    { id: n.id },
    'trash-receipt-2',
  );
  assert.throws(
    () =>
      command(reopened, 'note.restore', { id: n.id, trashId: removed.trashId }),
    (e) => e.code === 'SALES_CONFLICT',
  );
  // Even with the same clock tick, an older Undo cannot restore a later deletion.
  assert.equal(removedAgain.trashedAt, removed.trashedAt);
  assert.notEqual(removedAgain.trashId, removed.trashId);
});

test('trash stops automatic linking and analysis; a late model result cannot revive it', (t) => {
  const d = fixture(t),
    n = note(d),
    e = event(d);
  link(d, n, e);
  const job = d.beginAnalysis(
    n.id,
    d.note(n.id).revision,
    'trash-running-analysis',
  );
  command(d, 'note.trash', { id: n.id });
  const result = d.finishAnalysis(job, {
    summary: 'Поздний итог',
    changes: '',
    sources: [e.id],
    proposals: [],
  });
  assert.equal(result.stale, true);
  event(d, 'message-after-trash');
  assert.equal(d.events(n.id).length, 1);
  assert.equal(d.readChats().items[0].pending, 1);
  assert.equal(d.readChats().items[0].notes[0].trashedAt !== null, true);
  assert.equal(d.analysisStatus(d.note(n.id)), null);
  const restored = command(d, 'note.restore', {
    id: n.id,
    trashId: d.note(n.id).trashId,
  });
  assert.equal(restored.trashedAt, null);
});

test('first pin/zone use initial coordinates only when absent and never overwrite another tab', (t) => {
  const d = fixture(t),
    a = note(d),
    b = note(d, 'Вторая карточка');
  command(d, 'layout.patch', {
    zones: [{ id: 'initial-zone', name: 'Монтаж' }],
    positions: { [a.id]: { x: 500, y: 230, zone: 'initial-zone' } },
  });
  command(d, 'layout.patch', {
    positions: { [a.id]: { pinned: true, initial: { x: 10, y: 10 } } },
  });
  assert.deepEqual(d.layout('owner').positions[a.id], {
    x: 500,
    y: 230,
    pinned: true,
    zone: 'initial-zone',
  });
  command(d, 'layout.patch', {
    positions: { [a.id]: { zone: '', initial: { x: 20, y: 30 } } },
  });
  assert.deepEqual(d.layout('owner').positions[a.id], {
    x: 500,
    y: 230,
    pinned: true,
    zone: '',
  });
  command(d, 'layout.patch', {
    positions: { [b.id]: { pinned: true, initial: { x: 420, y: 40 } } },
  });
  assert.deepEqual(d.layout('owner').positions[b.id], {
    x: 420,
    y: 40,
    pinned: true,
    zone: '',
  });
  assert.throws(() =>
    command(d, 'layout.patch', {
      positions: { [b.id]: { initial: { x: -1, y: 0 } } },
    }),
  );
});

test('newest layout mode persists without overwriting free positions or concurrent layout fields', (t) => {
  const d = fixture(t),
    n = note(d);
  command(d, 'layout.patch', { positions: { [n.id]: { x: 950, y: 730 } } });
  const positions = structuredClone(d.layout('owner').positions);
  command(d, 'layout.patch', { mode: 'newest' }, 'mode-newest');
  command(d, 'layout.patch', { zoom: 0.8 });
  assert.equal(d.layout('owner').mode, 'newest');
  assert.equal(d.layout('owner').zoom, 0.8);
  assert.deepEqual(d.layout('owner').positions, positions);
  const reopened = new SalesDesk({ db: d.db, now: () => NOW });
  assert.equal(reopened.layout('owner').mode, 'newest');
  command(reopened, 'layout.patch', { mode: 'free' });
  assert.deepEqual(reopened.layout('owner').positions, positions);
  assert.equal(reopened.layout('owner').zoom, 0.8);
  assert.equal(reopened.layout('another-profile').mode, undefined);
  const before = reopened.layout('owner');
  assert.throws(() =>
    command(reopened, 'layout.patch', { mode: 'unknown', zoom: 1.2 }),
  );
  assert.deepEqual(reopened.layout('owner'), before);
});
