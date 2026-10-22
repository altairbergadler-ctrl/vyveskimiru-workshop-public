import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { advertisingFixture } from '../qa/advertising-fixture.mjs';
import {
  dailyItemsView,
  startDailyItems,
  cancelDailyItems,
} from './analytics/daily-items.mjs';
import {
  ResearchMaterials,
  redactEvidence,
} from './analytics/research-materials.mjs';
import { AvitoDeepAnalytics } from './analytics/avito-deep.mjs';
import { AvitoError } from './avito.mjs';
const period = { dateFrom: '2026-09-01', dateTo: '2026-09-03' };
test('a month of daily steps waits once per shared cooldown without exhausting later days', async (t) => {
  const f = fixture(t),
    original = f.client.statistics;
  let clock = Date.parse('2026-10-03T10:00:00Z'),
    next = 0,
    calls = 0;
  f.deep.now = () => clock;
  f.client.statistics = async (input) => {
    calls++;
    if (clock < next) throw new AvitoError('rate_limit', 429, 65);
    next = clock + 65000;
    return original(input);
  };
  const month = { dateFrom: '2026-09-01', dateTo: '2026-09-30' };
  startDailyItems(f.deep, month);
  for (let i = 0; i < 2000; i++) {
    await f.deep.work();
    clock += 1000;
  }
  const result = dailyItemsView(f.deep, month);
  assert.equal(result.completeDays, 30);
  assert.equal(result.job.failed, 0);
  assert(calls <= 61);
});
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-test-'));
  const f = advertisingFixture(directory, Date.parse('2026-10-03T10:00:00Z'));
  t.after(async () => {
    await f.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return f;
}
test('daily item queue reuses snapshots, never invents zero rows, and shares the ordinary import', async (t) => {
  const f = fixture(t),
    first = startDailyItems(f.deep, period);
  assert.equal(startDailyItems(f.deep, period).jobId, first.jobId);
  const ordinary = f.deep.start(period);
  assert.notEqual(ordinary.jobId, first.jobId);
  await f.drain();
  assert.equal(dailyItemsView(f.deep, period, '5678').completeDays, 3);
  assert.deepEqual(
    dailyItemsView(f.deep, period, '5678').days.map((d) => d.spend),
    [5, 5, 5],
  );
  assert(
    dailyItemsView(f.deep, period, '999').days.every((d) => d.spend === null),
  );
  assert.equal(startDailyItems(f.deep, period).cached, true);
  const second = startDailyItems(f.deep, { ...period, refresh: true });
  assert.notEqual(second.jobId, first.jobId);
  assert(f.deep.view(period).jobs.every((j) => j.id !== second.jobId));
  await f.drain();
});
test('complete empty daily reports count as received and cached without inventing per-item zeros', async (t) => {
  const f = fixture(t),
    original = f.client.statistics;
  f.client.statistics = async (input) => {
    const value = await original(input);
    return {
      ...value,
      groups: [],
      pagination: {
        ...value.pagination,
        total: 0,
        complete: true,
        nextOffset: null,
      },
    };
  };
  startDailyItems(f.deep, period);
  await f.drain();
  const view = dailyItemsView(f.deep, period, '5678');
  assert.equal(view.completeDays, 3);
  assert(
    view.days.every((d) => d.loadedAt && d.spend === null && d.views === null),
  );
  assert.equal(startDailyItems(f.deep, period).cached, true);
  const row = f.deep
    .db()
    .prepare(
      "SELECT rowid,payload FROM ad_snapshots WHERE kind='items' ORDER BY rowid LIMIT 1",
    )
    .get();
  const bad = JSON.parse(row.payload);
  bad.pagination.total = 1;
  f.deep
    .db()
    .prepare('UPDATE ad_snapshots SET payload=? WHERE rowid=?')
    .run(JSON.stringify(bad), row.rowid);
  assert.equal(dailyItemsView(f.deep, period).completeDays, 2);
});
test('cancel while provider is in flight cannot publish data or schedule another page', async (t) => {
  const f = fixture(t);
  let release;
  const original = f.client.statistics;
  f.client.statistics = async (input) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return original(input);
  };
  const run = startDailyItems(f.deep, period),
    work = f.deep.work();
  cancelDailyItems(f.deep, { jobId: run.jobId });
  release();
  await work;
  assert.equal(dailyItemsView(f.deep, period).completeDays, 0);
  assert.equal(dailyItemsView(f.deep, period).job.state, 'cancelled');
  assert.equal(
    f.deep
      .db()
      .prepare(
        "SELECT COUNT(*) n FROM ad_steps WHERE state IN ('queued','running')",
      )
      .get().n,
    0,
  );
  assert.throws(() => cancelDailyItems(f.deep, { jobId: 'not-a-run' }), {
    code: 'invalid',
  });
});
test('daily jobs retain rate-limit cooldown and resume with the same queue after reopening', async (t) => {
  const f = fixture(t),
    run = startDailyItems(f.deep, period);
  f.setFailure(new AvitoError('rate_limit', 429, 120));
  await f.deep.work();
  const next = f.deep
    .db()
    .prepare('SELECT next_at FROM ad_steps WHERE run_id=? ORDER BY id LIMIT 1')
    .get(run.jobId).next_at;
  assert(next >= Date.parse('2026-10-03T10:02:00Z'));
  f.setFailure(null);
  f.advance(120000);
  const reopened = new AvitoDeepAnalytics({
    base: f.base,
    client: f.client,
    now: () => Date.parse('2026-10-03T11:00:00Z'),
    automatic: false,
    scheduler: false,
  });
  for (let i = 0; i < 4; i++) await reopened.work();
  assert.equal(dailyItemsView(reopened, period).completeDays, 3);
  await reopened.close();
});
test('unknown or malformed daily metric does not count as complete', async (t) => {
  const f = fixture(t);
  startDailyItems(f.deep, period);
  await f.drain();
  const row = f.deep
    .db()
    .prepare(
      "SELECT rowid,payload FROM ad_snapshots WHERE date_from='2026-09-01' AND kind='items'",
    )
    .get();
  const value = JSON.parse(row.payload);
  value.groups[0].metrics.spending = null;
  f.deep
    .db()
    .prepare('UPDATE ad_snapshots SET payload=? WHERE rowid=?')
    .run(JSON.stringify(value), row.rowid);
  assert.equal(dailyItemsView(f.deep, period, '5678').completeDays, 2);
  assert.equal(dailyItemsView(f.deep, period, '5678').days[0].spend, null);
  assert.equal(startDailyItems(f.deep, period).days, 1);
});
test('manual content versions use existing history, validate photo origins and reject stale updates', async (t) => {
  const f = fixture(t);
  f.deep.start(period);
  await f.drain();
  const m = new ResearchMaterials({ deep: f.deep, client: f.client });
  const input = {
    id: crypto.randomUUID(),
    itemId: '5678',
    text: 'Вымышленное описание',
    photos: ['https://00.img.avito.st/fictional.jpg'],
    expectedVersion: 0,
  };
  m.saveContent(input);
  m.saveContent(input);
  assert.equal(m.view('5678').content.text, input.text);
  assert.equal(
    f.deep
      .history(new URLSearchParams({ itemId: '5678' }))
      .rows.filter((r) => r.kind === 'content').length,
    1,
  );
  assert.throws(() => m.saveContent({ ...input, id: crypto.randomUUID() }), {
    statusCode: 409,
  });
  for (const url of [
    'http://00.img.avito.st/x',
    'https://avito.st.evil.invalid/x',
    'https://localhost/x',
    'data:image/png;base64,a',
    'https://user@00.img.avito.st/x',
  ])
    assert.throws(() => m.saveContent({ ...input, photos: [url] }), {
      code: 'invalid',
    });
  assert.throws(() => m.saveContent({ ...input, text: 'Changed same ID' }), {
    statusCode: 409,
  });
});
test('message previews redact contacts, persist only reviewed selected excerpts and enforce account/source boundaries', async (t) => {
  const f = fixture(t);
  f.deep.start(period);
  await f.drain();
  f.deep.db()
    .exec(`CREATE TABLE response_chats(account TEXT,chat_id TEXT,item_id TEXT,first_in TEXT,state TEXT);
    INSERT INTO response_chats VALUES('1234','chat-1','5678','2026-09-01','answered');`);
  let calls = 0;
  f.deep.db()
    .exec(`CREATE TABLE inquiry_snapshots(id INTEGER PRIMARY KEY,account TEXT,chat_id TEXT,kind TEXT,payload TEXT);
    INSERT INTO inquiry_snapshots VALUES(1,'1234','chat-1','profile','{"users":[{"name":"Иван"}]}');`);
  f.client.conversationMessages = async () => {
    calls++;
    return {
      messages: [
        {
          id: 'message-1',
          createdAt: '2026-09-01T00:00:00Z',
          direction: 'in',
          type: 'text',
          text: 'Иван, дорого. +7 999 123-45-67 mail@example.test https://example.test',
        },
      ],
      hasMore: false,
    };
  };
  let clock = Date.now();
  const m = new ResearchMaterials({
    deep: f.deep,
    client: f.client,
    now: () => clock,
  });
  const p = await m.page({ itemId: '5678', chatId: 'chat-1', offset: 0 });
  const txt = p.messages[0].text;
  assert(!txt.includes('Иван'));
  assert(!txt.includes('999'));
  assert(!txt.includes('example.test'));
  assert.equal(m.view('5678').excerpts.length, 0);
  const start = txt.indexOf('дорого'),
    input = {
      token: p.token,
      messageId: 'message-1',
      start,
      end: start + 6,
      reviewed: true,
    };
  assert.throws(() => m.saveExcerpt({ ...input, reviewed: false }), {
    code: 'invalid',
  });
  m.saveExcerpt(input);
  m.saveExcerpt(input);
  assert.equal(m.view('5678').excerpts.length, 1);
  assert.equal(m.view('5678').excerpts[0].excerpt, 'дорого');
  assert.throws(() => m.saveExcerpt({ ...input, messageId: 'forged' }), {
    code: 'invalid',
  });
  await assert.rejects(
    m.page({ itemId: '5679', chatId: 'chat-1', offset: 0 }),
    { code: 'invalid' },
  );
  assert.equal(calls, 1);
  clock += 11 * 60000;
  assert.throws(() => m.saveExcerpt(input), { statusCode: 409 });
  const rows = m.db().prepare('SELECT excerpt FROM research_excerpts').all();
  assert.deepEqual(rows, [{ excerpt: 'дорого' }]);
});
test('preview reads yield to nightly work and failed reads are retryable without preserving raw input', async (t) => {
  const f = fixture(t);
  f.deep.start(period);
  await f.drain();
  f.deep
    .db()
    .exec(
      "CREATE TABLE response_chats(account TEXT,chat_id TEXT,item_id TEXT,first_in TEXT,state TEXT);INSERT INTO response_chats VALUES('1234','chat-1','5678',NULL,'waiting')",
    );
  let protectedBusy = true;
  const m = new ResearchMaterials({
    deep: f.deep,
    client: f.client,
    canRead: () => !protectedBusy,
  });
  const input = { itemId: '5678', chatId: 'chat-1', offset: 0 };
  await assert.rejects(m.page(input), { code: 'rate_limit' });
  protectedBusy = false;
  f.client.conversationMessages = async () => {
    throw new AvitoError('unavailable');
  };
  await assert.rejects(m.page(input), { code: 'unavailable' });
  assert.equal(m.flight, null);
  assert.equal(m.cache.size, 0);
  assert.equal(
    redactEvidence('иван и почта user@site.ru', ['Иван']),
    '[ИМЯ] и почта [КОНТАКТ]',
  );
  assert.equal(
    redactEvidence('Дорого. Долго. Цена не подходит. Иван', ['Иван']),
    'Дорого. Долго. Цена не подходит. [ИМЯ]',
  );
});
