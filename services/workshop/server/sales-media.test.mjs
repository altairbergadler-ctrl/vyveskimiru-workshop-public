import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { SalesDesk } from './sales-desk.mjs';
import { SalesSources } from './sales-sources.mjs';
import { parseMessages } from './avito-inquiries.mjs';
import {
  avitoMediaUrl,
  mediaType,
  maxMessageMedia,
  SALES_MEDIA_LIMIT,
} from './sales-media.mjs';
import { sourceMediaRequest } from './max-media.mjs';
import { parseLayoutEmail } from '../modules/orders/server/mail-import.mjs';
import { salesHandler } from './sales-routes.mjs';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X8xQAAAAASUVORK5CYII=',
  'base64',
);
const rawMessage = {
  id: 'fictional-image',
  created: 1792666800,
  direction: 'in',
  type: 'image',
  content: {
    image: {
      sizes: {
        '140x105': 'https://10.img.avito.st/thumb?secret=one',
        '1280x960': 'https://10.img.avito.st/photo?secret=one',
      },
    },
  },
};
function fixture(t) {
  const db = new Database(':memory:'),
    mailDb = new Database(':memory:');
  mailDb.exec(
    'CREATE TABLE mail_messages(key TEXT,account_key TEXT,raw BLOB,details TEXT)',
  );
  const desk = new SalesDesk({
    db,
    now: () => Date.parse('2026-10-22T10:00:00Z'),
  });
  desk.setSetting('intakePolicy', 'new');
  let account = '1234',
    reads = 0,
    voiceReads = 0;
  const messages = parseMessages([rawMessage], { includeMedia: true }).messages;
  const sources = new SalesSources({
    desk,
    avito: {
      status: () => ({ enabled: true, configured: true, accountId: account }),
      conversationMessages: async () => {
        reads++;
        return { messages: structuredClone(messages), hasMore: false };
      },
      voiceFile: async () => {
        voiceReads++;
        return { accountId: account, url: 'https://files.avito.ru/voice' };
      },
    },
    importer: {
      view: () => ({
        chats: [{ id: 'fictional-chat', itemTitle: 'Учебный заказ' }],
      }),
    },
    mail: { db: mailDb, accountKey: 'mail-account' },
    max: { settings: () => null, db: mailDb },
  });
  sources.observeAvito({
    accountId: account,
    chatId: 'fictional-chat',
    page: { messages, hasMore: false },
  });
  const chat = desk.readChats().items[0];
  const made = desk.command({
    requestId: 'media-create',
    action: 'chat.create',
    data: { chatId: chat.id },
  });
  sources.media.request = async () => png;
  t.after(async () => {
    await sources.close();
    db.close();
    mailDb.close();
  });
  return {
    desk,
    sources,
    messages,
    chat,
    noteId: made.noteId,
    mailDb,
    reads: () => reads,
    voiceReads: () => voiceReads,
    account: (value) => {
      account = value;
    },
  };
}

test('Avito media is opt-in; signed URL rotation never revises events or AI watermarks', async (t) => {
  assert.equal(parseMessages([rawMessage]).messages[0].media, undefined);
  const f = fixture(t),
    before = f.desk.detail(f.noteId);
  f.messages[0].media[0].url += '&expires=later';
  f.sources.observeAvito({
    accountId: '1234',
    chatId: 'fictional-chat',
    page: { messages: f.messages, hasMore: false },
  });
  const after = f.desk.detail(f.noteId);
  assert.equal(before.watermark, after.watermark);
  assert.equal(before.events[0].revision, after.events[0].revision);
  assert.equal(JSON.stringify(after).includes('secret='), false);
  const gallery = await f.sources.media.note(f.noteId);
  assert.equal(gallery.items.length, 1);
  assert.equal(gallery.items[0].kind, 'image');
  assert.equal(JSON.stringify(gallery).includes('secret='), false);
  const chat = await f.sources.chatThread(f.chat.id);
  assert.equal(chat.messages[0].media[0].url, gallery.items[0].url);
  assert.equal(f.reads(), 2);
  assert.deepEqual(
    (
      await f.sources.media.file(
        new URL(gallery.items[0].url, 'https://local.invalid').searchParams,
      )
    ).bytes,
    png,
  );
  f.account('9999');
  await assert.rejects(
    f.sources.media.file(
      new URL(gallery.items[0].url, 'https://local.invalid').searchParams,
    ),
  );
  assert.equal((await f.sources.media.note(f.noteId)).unavailable.length, 1);
});

test('old and new linked media appear once, pagination is bounded and partial sources stay visible', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 21; i++) {
    const m = { ...f.messages[0], id: 'fictional-image-' + i };
    f.messages.push(m);
    f.sources.observeAvito({
      accountId: '1234',
      chatId: 'fictional-chat',
      page: { messages: [m], hasMore: false },
    });
  }
  const page = await f.sources.media.note(f.noteId),
    older = await f.sources.media.note(f.noteId, page.nextOffset);
  assert.equal(page.items.length, 20);
  assert.equal(older.items.length, 2);
  assert.equal(
    new Set([...page.items, ...older.items].map((i) => i.id)).size,
    22,
  );
  await assert.rejects(f.sources.media.note(f.noteId, -1));
  f.sources.media.pages.clear();
  f.messages.splice(0);
  const missing = await f.sources.media.note(f.noteId);
  assert.equal(missing.items.length, 0);
  assert.equal(missing.unavailable.length, 20);
});

test('voice URL and bytes are coalesced, unavailable Avito files stay honest', async (t) => {
  const f = fixture(t);
  f.messages[0].media = [
    {
      partId: '1',
      kind: 'audio',
      name: 'Голосовое',
      voiceId: 'fictional-voice',
    },
  ];
  const url = (await f.sources.media.note(f.noteId)).items[0].url;
  let downloads = 0;
  f.sources.media.request = async () => {
    downloads++;
    await new Promise((r) => setTimeout(r, 5));
    return Buffer.from('OggSfictional');
  };
  const params = new URL(url, 'https://local.invalid').searchParams;
  const values = await Promise.all([
    f.sources.media.file(params),
    f.sources.media.file(params),
  ]);
  assert.equal(values[0].mime, 'audio/ogg');
  assert.equal(f.voiceReads(), 1);
  assert.equal(downloads, 1);
  const unavailable = parseMessages(
    [{ ...rawMessage, type: 'file', content: {} }],
    { includeMedia: true },
  ).messages[0].media;
  assert.equal(
    f.sources.media.present(
      { source: 'avito', account: '1234', nativeId: 'test' },
      unavailable,
    )[0].available,
    false,
  );
});

const email = Buffer.from(
  [
    'From: Designer <designer@example.invalid>',
    'To: test@example.invalid',
    'Subject: Fictional proof',
    'Message-ID: <media@example.invalid>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary=fixture',
    '',
    '--fixture',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Учебное письмо',
    '--fixture',
    'Content-Type: image/png',
    'Content-Disposition: attachment; filename=proof.png',
    'Content-Transfer-Encoding: base64',
    '',
    png.toString('base64'),
    '--fixture',
    'Content-Type: text/html',
    'Content-Disposition: attachment; filename=active.html',
    '',
    '<script>alert(1)</script>',
    '--fixture--',
    '',
  ].join('\r\n'),
);
test('mail reuses the MIME parser; gallery never approves/imports layouts and active files download only', async (t) => {
  const normal = await parseLayoutEmail(email),
    expanded = await parseLayoutEmail(email, { includeMedia: true });
  assert.equal(normal.media, undefined);
  assert.equal(normal.attachments[0].supported, false);
  assert.deepEqual(normal.attachments, expanded.attachments);
  assert.equal(expanded.media.length, 2);
  const f = fixture(t);
  f.mailDb
    .prepare('INSERT INTO mail_messages VALUES(?,?,?,?)')
    .run('fictional-mail', 'mail-account', email, '{}');
  const event = f.desk.ingest({
    source: 'mail',
    account: 'mail-account',
    nativeId: 'fictional-mail',
    conversationId: 'fictional-thread',
    version: 'v1',
    occurredAt: '2026-10-22T11:00:00Z',
    type: 'mail',
    title: 'Учебное письмо',
  });
  f.desk.command({
    requestId: 'link-mail-media',
    action: 'event.link',
    data: {
      eventId: event.id,
      eventRevision: f.desk.db
        .prepare('SELECT revision FROM sales_events WHERE id=?')
        .get(event.id).revision,
      noteId: f.noteId,
      revision: f.desk.note(f.noteId).revision,
    },
  });
  const result = await f.sources.media.event(event.id);
  assert.equal(result.media.length, 2);
  assert.equal(result.media[0].kind, 'image');
  assert.equal(result.media[1].kind, 'file');
  const file = await f.sources.media.file(
    new URL(result.media[1].url, 'https://local.invalid').searchParams,
  );
  assert.equal(file.mime, 'application/octet-stream');
  assert.equal(f.desk.detail(f.noteId).files.length, 0);
  assert.equal(f.desk.note(f.noteId).approvedFile, undefined);
  f.mailDb
    .prepare('UPDATE mail_messages SET raw=NULL,details=?')
    .run(JSON.stringify({ message: expanded.message }));
  f.sources.media.mails.clear();
  assert.equal((await f.sources.media.note(f.noteId)).unavailable.length, 1);
});

test('media URL validation, pinned public DNS and every redirect reject SSRF and oversized bytes', async () => {
  for (const u of [
    'http://img.avito.st/x',
    'https://avito.st.evil.invalid/x',
    'https://user:pass@img.avito.st/x',
    'https://127.0.0.1/x',
  ])
    assert.throws(() => avitoMediaUrl(u));
  for (const address of [
    '127.0.0.1',
    '::ffff:127.0.0.1',
    '10.0.0.1',
    'fe80::1',
  ])
    await assert.rejects(
      sourceMediaRequest(null, 'https://img.avito.st/x', {
        validateUrl: avitoMediaUrl,
        lookup: async () => [
          { address, family: address.includes(':') ? 6 : 4 },
        ],
      }),
    );
  const requestImpl = (_, options, cb) => {
    const request = new EventEmitter();
    request.end = () => {
      const incoming = new PassThrough();
      incoming.statusCode = 302;
      incoming.headers = { location: 'https://evil.invalid/private' };
      cb(incoming);
      incoming.end();
      queueMicrotask(() => request.emit('close'));
    };
    return request;
  };
  await assert.rejects(
    sourceMediaRequest(null, 'https://img.avito.st/x', {
      validateUrl: avitoMediaUrl,
      lookup: async () => [{ address: '185.16.150.10', family: 4 }],
      requestImpl,
    }),
  );
  assert.equal(
    mediaType(Buffer.from('<svg onload=alert(1)>')),
    'application/octet-stream',
  );
  assert.equal(mediaType(png), 'image/png');
  assert.equal(SALES_MEDIA_LIMIT, 33554432);
  assert.equal(
    maxMessageMedia({
      body: {
        attachments: [
          { type: 'image', payload: { url: 'https://i.oneme.ru/image' } },
          { type: 'inline_keyboard' },
        ],
      },
    }).length,
    1,
  );
});

test('media routes serve safe MIME, range requests, private caching and attachment disposition', async () => {
  const handler = salesHandler({
    desk: {},
    sources: {
      media: {
        file: async () => ({
          bytes: png,
          mime: 'image/png',
          name: 'Учебный макет.png',
        }),
      },
    },
    json: (res, status, value) => {
      res.status = status;
      res.value = value;
    },
  });
  const request = async (query, range) => {
    const response = {
      setHeader() {},
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(bytes) {
        this.bytes = bytes;
      },
    };
    await handler(
      {
        method: 'GET',
        headers: {
          cookie: 'sales_layout=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          ...(range ? { range } : {}),
        },
      },
      response,
      new URL('https://local.invalid/api/sales/media?' + query),
    );
    return response;
  };
  const full = await request('partId=1');
  assert.equal(full.status, 200);
  assert.equal(full.headers['X-Content-Type-Options'], 'nosniff');
  assert.match(full.headers['Cache-Control'], /no-store/);
  assert.match(full.headers['Content-Disposition'], /^inline/);
  const part = await request('partId=1', 'bytes=0-7');
  assert.equal(part.status, 206);
  assert.equal(part.bytes.length, 8);
  assert.equal((await request('partId=1', 'bytes=999999-')).status, 416);
  assert.match(
    (await request('download=1')).headers['Content-Disposition'],
    /^attachment/,
  );
});

test('new Avito event invalidates a cached page before automatic gallery refresh', async (t) => {
  const f = fixture(t);
  assert.equal((await f.sources.media.note(f.noteId)).items.length, 1);
  f.messages.push({ ...f.messages[0], id: 'second-real-message' });
  f.sources.observeAvito({
    accountId: '1234',
    chatId: 'fictional-chat',
    page: { messages: f.messages, hasMore: false },
  });
  f.sources.media.lastRead = 0;
  const fresh = await f.sources.media.note(f.noteId);
  assert.equal(fresh.items.length, 2);
  assert.equal(fresh.unavailable.length, 0);
  assert.equal(f.reads(), 2);
  for (const item of fresh.items)
    assert.equal(
      (
        await f.sources.media.file(
          new URL(item.url, 'https://local.invalid').searchParams,
        )
      ).mime,
      'image/png',
    );
});

test('admission bounds source resolution, queued reads recheck scope, one MIME parse is shared', async (t) => {
  const f = fixture(t);
  let active = 0,
    peak = 0,
    reads = 0;
  const resolve = f.sources.media.readFile.bind(f.sources.media);
  f.sources.media.readFile = async (params) => {
    active++;
    peak = Math.max(peak, active);
    reads++;
    try {
      await new Promise((r) => setTimeout(r, 10));
      return await resolve(params);
    } finally {
      active--;
    }
  };
  const item = (await f.sources.media.note(f.noteId)).items[0],
    params = new URL(item.url, 'https://local.invalid').searchParams;
  await Promise.all(
    Array.from({ length: 9 }, () => f.sources.media.file(params)),
  );
  assert.equal(peak, 3);
  assert.equal(reads, 9);
  const flights = Array.from({ length: 6 }, () => f.sources.media.file(params));
  f.account('9999');
  const rejected = await Promise.allSettled(flights);
  assert.ok(rejected.every((r) => r.status === 'rejected'));
  f.account('1234');
  let parsed = 0;
  const e = {
    source: 'mail',
    account: 'mail-account',
    nativeId: 'same-mail',
    version: 'v1',
  };
  const read = async () => {
    parsed++;
    await new Promise((r) => setTimeout(r, 10));
    return { parsed: { media: [{ bytes: png }] }, hasRaw: true };
  };
  await Promise.all(
    Array.from({ length: 9 }, () => f.sources.media.mail(e, read)),
  );
  assert.equal(parsed, 1);
});

test('send success and lost response force fresh chat history; pre-send in-flight pages are rejected', async (t) => {
  const f = fixture(t);
  let physical = 0,
    lose = false;
  f.sources.avito.sendChatMessage = async ({ text }) => {
    const sent = {
      id: 'sent-reply-' + ++physical,
      text,
      type: 'text',
      direction: 'out',
      createdAt: new Date().toISOString(),
    };
    f.messages.push(sent);
    if (lose)
      throw Object.assign(new Error('lost response'), { code: 'unavailable' });
    return sent;
  };
  await f.sources.chatThread(f.chat.id);
  await f.sources.sendChat({
    chatId: f.chat.id,
    requestId: 'send-media-success',
    text: 'Успешный ответ',
  });
  f.sources.media.lastRead = 0;
  assert.equal(
    (await f.sources.chatThread(f.chat.id)).messages.filter(
      (m) => m.direction === 'out',
    ).length,
    1,
  );
  lose = true;
  const input = {
    chatId: f.chat.id,
    requestId: 'send-media-unknown',
    text: 'Ответ с потерянной квитанцией',
  };
  await assert.rejects(f.sources.sendChat(input), {
    code: 'SALES_SEND_UNKNOWN',
  });
  f.sources.media.lastRead = 0;
  const fresh = await f.sources.chatThread(f.chat.id);
  assert.ok(fresh.messages.some((m) => m.text === input.text));
  await assert.rejects(f.sources.sendChat(input), {
    code: 'SALES_SEND_UNKNOWN',
  });
  assert.equal(physical, 2);
  let release, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  f.sources.avito.conversationMessages = async () => {
    const messages = structuredClone(f.messages);
    started();
    await new Promise((resolve) => {
      release = resolve;
    });
    return { messages, hasMore: false };
  };
  f.sources.media.lastRead = 0;
  const old = f.sources.chatThread(f.chat.id);
  const rejected = assert.rejects(old, { code: 'SALES_SOURCE_CHANGED' });
  await ready;
  lose = false;
  await f.sources.sendChat({
    chatId: f.chat.id,
    requestId: 'send-media-inflight',
    text: 'Ещё один ответ',
  });
  release();
  await rejected;
});
