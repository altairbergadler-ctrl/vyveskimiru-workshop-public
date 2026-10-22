import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { MaxBot, serializeMaxSend } from './max-bot.mjs';
import { MaxRetouch, mentionsRetouchBot } from './max-retouch.mjs';
import { maxMediaUrl, publicMediaAddress, uploadMaxImage } from './max-media.mjs';
import { imageType } from './max-retouch-provider.mjs';

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXs0AAAAASUVORK5CYII=', 'base64');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-retouch-test-'));
  const db = new Database(':memory:'); const sent = [], requests = [];
  let now = Date.parse('2026-10-21T12:00:00Z'), reads = 0;
  const config = { allowedChatIds: [], retouch: { enabled: true, chatIds: ['-10'], botUserId: 99, username: 'VM_bot', dailyLimit: 5 } };
  const send = async (_, id, text, kind, extra) => { const mid = `bot-${sent.length + 1}`; sent.push({ id, text, kind, extra, mid }); return { message: { body: { mid } } }; };
  const bot = new MaxBot({ db, config, send, sendIntervalMs: 0, readBoard: async () => { reads++; throw new Error('must not read Google'); } });
  db.prepare('INSERT INTO max_bot_chats VALUES (?,?,?)').run('-10', 'bot_added', 'now');
  const deps = { db, settings: () => config, send: bot.send, directory,
    now: () => now, download: async () => image, upload: async () => 'fictional-image-token',
    ask: async (_, request) => { requests.push(request); return { imageBase64: image.toString('base64'), imageSha256: digest(image) }; }, ...overrides };
  const retouch = new MaxRetouch(deps); bot.retouch = retouch;
  t.after(async () => { await retouch.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const photo = (mid = 'photo-1', userId = 123) => ({ update_type: 'message_created', message: {
    sender: { user_id: userId, is_bot: false }, recipient: { chat_type: 'chat', chat_id: -10 },
    body: { mid, text: '@VM_bot', markup: [{ type: 'user_mention', user_id: 99, from: 0, length: 7 }],
      attachments: [{ type: 'image', payload: { url: 'https://i.oneme.ru/fictional.png' } }] } } });
  const answer = (mid = 'answer-1', userId = 123, questionMid = sent[0]?.mid) => ({ update_type: 'message_created', message: {
    sender: { user_id: userId, is_bot: false }, recipient: { chat_type: 'chat', chat_id: -10 },
    body: { mid, text: 'Уберите провод, сохраните вывеску.' }, link: { type: 'reply', message: { mid: questionMid } } } });
  return { db, config, sent, requests, bot, retouch, deps, photo, answer, reads: () => reads,
    advance: (ms = 60000) => { now += ms; } };
}

test('mentioned group photo asks for edits; its author reply renders and sends exactly once without enabling commands or reading Google', async t => {
  const f = fixture(t);
  await Promise.all([f.bot.process(f.photo()), f.bot.process(f.photo())]);
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /Что нужно изменить/u);
  assert.deepEqual(f.sent[0].extra.link, { type: 'reply', mid: 'photo-1' });
  await Promise.all([f.bot.process(f.answer()), f.bot.process(f.answer())]); await f.retouch.drain();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].instruction, 'Уберите провод, сохраните вывеску.');
  assert.equal(f.sent.filter(item => item.extra?.attachments).length, 1);
  assert.deepEqual(f.sent.at(-1).extra.attachments, [{ type: 'image', payload: { token: 'fictional-image-token' } }]);
  assert.equal(f.db.prepare('SELECT state FROM max_retouch_jobs').get().state, 'sent');
  assert.equal(f.reads(), 0); assert.deepEqual(f.config.allowedChatIds, []);
});
test('unmentioned photos, other groups, bot senders and private chats cannot start retouch', async t => {
  const f = fixture(t);
  const quiet = f.photo(); quiet.message.body.text = ''; quiet.message.body.markup = [];
  const foreign = f.photo('other'); foreign.message.recipient.chat_id = -20;
  const robot = f.photo('robot'); robot.message.sender.is_bot = true;
  const privateMessage = f.photo('private'); privateMessage.message.recipient.chat_type = 'dialog';
  for (const value of [quiet, foreign, robot, privateMessage]) await f.bot.process(value);
  assert.equal(f.sent.length, 0); assert.equal(f.requests.length, 0);
});
test('plain group chatter and another author reply do not become edit instructions; users keep separate photos', async t => {
  const f = fixture(t); await f.bot.process(f.photo()); const question1 = f.sent[0].mid;
  await f.bot.process(f.answer('foreign', 456, question1));
  const chatter = f.answer('chatter'); delete chatter.message.link; await f.bot.process(chatter);
  assert.equal(f.requests.length, 0);
  await f.bot.process(f.photo('photo-2', 456)); const question2 = f.sent.at(-1).mid;
  await f.bot.process(f.answer('answer-2', 456, question2)); await f.retouch.drain();
  assert.equal(f.requests.length, 1);
  assert.equal(f.db.prepare("SELECT state FROM max_retouch_jobs WHERE user_id='123'").get().state, 'waiting');
});
test('replying to a photo with a mention works; cancellation, expiration and multiple attachments never invoke generation', async t => {
  const f = fixture(t);
  const mention = f.photo(); mention.message.link = { type: 'reply', message: { mid: 'original', attachments: mention.message.body.attachments } }; mention.message.body.attachments = [];
  await f.bot.process(mention); assert.equal(f.sent[0].extra.link.mid, 'original');
  const cancel = f.answer(); cancel.message.body.text = 'отмена'; await f.bot.process(cancel);
  assert.equal(f.db.prepare('SELECT state FROM max_retouch_jobs').get().state, 'cancelled');
  const album = f.photo('album'); album.message.body.attachments.push(album.message.body.attachments[0]); await f.bot.process(album);
  await f.bot.process(f.photo('later')); const question = f.sent.at(-1).mid;
  f.advance(3 * 3600000); await f.bot.process(f.answer('expired', 123, question)); await f.retouch.drain();
  assert.equal(f.requests.length, 0);
});
test('daily limit uses Moscow date and prevents another author from spending more after the group limit', async t => {
  const f = fixture(t); f.config.retouch.dailyLimit = 1;
  await f.bot.process(f.photo()); await f.bot.process(f.answer()); await f.retouch.drain();
  await f.bot.process(f.photo('second', 456)); const question = f.sent.at(-1).mid;
  await f.bot.process(f.answer('second-answer', 456, question)); await f.retouch.drain();
  assert.equal(f.requests.length, 1); assert.match(f.sent.at(-1).text, /лимит ретуши/u);
  f.advance(24 * 3600000); await f.bot.process(f.photo('tomorrow', 456));
  const nextQuestion = f.sent.at(-1).mid; await f.bot.process(f.answer('tomorrow-answer', 456, nextQuestion)); await f.retouch.drain();
  assert.equal(f.requests.length, 2);
});

test('an instruction accepted near the question deadline gets its own processing window and delivers the rendered image', async t => {
  const f = fixture(t, { ask: async () => {
    f.advance(3 * 60000);
    return { imageBase64: image.toString('base64'), imageSha256: digest(image) };
  } });
  await f.bot.process(f.photo()); f.advance(119 * 60000);
  await f.bot.process(f.answer()); await f.retouch.drain();
  assert.equal(f.db.prepare('SELECT state FROM max_retouch_jobs').get().state, 'sent');
  assert.equal(f.sent.filter(item => item.extra?.attachments).length, 1);
});
test('a definite delivery rejection retries the stored result and token without another generation, including restart', async t => {
  const f = fixture(t); const successful = f.retouch.send;
  f.retouch.send = async (...args) => { if (args[4]?.attachments) throw Object.assign(new Error('not submitted'), { deliveryState: 'not_sent' }); return successful(...args); };
  await f.bot.process(f.photo()); await f.bot.process(f.answer()); await f.retouch.drain();
  assert.equal(f.db.prepare('SELECT state FROM max_retouch_jobs').get().state, 'ready');
  f.advance(); await f.retouch.close(); const restarted = new MaxRetouch(f.deps);
  try { await restarted.drain(); } finally { await restarted.close(); }
  assert.equal(f.requests.length, 1); assert.equal(f.sent.filter(item => item.extra?.attachments).length, 1);
});
test('an accepted result with a lost acknowledgement becomes uncertain and is never sent again', async t => {
  const f = fixture(t); const successful = f.retouch.send; let submitted = 0;
  f.retouch.send = async (...args) => { if (args[4]?.attachments) { submitted++; throw new Error('lost response'); } return successful(...args); };
  await f.bot.process(f.photo()); await f.bot.process(f.answer()); await f.retouch.drain(); f.advance(); await f.retouch.drain();
  assert.equal(submitted, 1); assert.equal(f.db.prepare('SELECT state FROM max_retouch_jobs').get().state, 'uncertain');
});

test('MAX upload-session API failure retries the completed image without another generation', async t => {
  let sessions = 0;
  const f = fixture(t, { upload: (config, bytes) => uploadMaxImage(config, bytes, {
    api: async () => {
      if (++sessions === 1) throw Object.assign(new Error('MAX_API_UNAVAILABLE'), { deliveryState: 'not_sent' });
      return { url: 'https://iu.oneme.ru/uploadImage?fictional=1' };
    },
    request: async () => Buffer.from(JSON.stringify({ photos: { '1': { token: 'fictional-image-token' } } })),
  }) });
  await f.bot.process(f.photo()); await f.bot.process(f.answer()); await f.retouch.drain();
  assert.equal(f.db.prepare('SELECT state,error_code FROM max_retouch_jobs').get().state, 'ready');
  f.advance(); await f.retouch.drain();
  assert.equal(sessions, 2); assert.equal(f.requests.length, 1);
  assert.equal(f.db.prepare('SELECT state FROM max_retouch_jobs').get().state, 'sent');
});
test('revoked recipient while image processing waits prevents upload and result delivery', async t => {
  const f = fixture(t, { ask: async () => { f.config.retouch.enabled = false; return { imageBase64: image.toString('base64'), imageSha256: digest(image) }; } });
  await f.bot.process(f.photo()); await f.bot.process(f.answer()); await f.retouch.drain();
  assert.equal(f.sent.filter(item => item.extra?.attachments).length, 0);
});

test('revocation while a ready retouch waits behind another MAX send prevents the physical image POST', async t => {
  let finishImage, imageStarted, releaseSend, sendStarted;
  const imageWait = new Promise(resolve => { finishImage = resolve; });
  const imageRunning = new Promise(resolve => { imageStarted = resolve; });
  const sendWait = new Promise(resolve => { releaseSend = resolve; });
  const sendRunning = new Promise(resolve => { sendStarted = resolve; });
  const f = fixture(t, { ask: async () => { imageStarted(); return imageWait; } });
  f.retouch.send = serializeMaxSend(async (_, id, text, kind, extra) => {
    if (text === 'fictional preceding notice') { sendStarted(); await sendWait; }
    const mid = `slot-${f.sent.length + 1}`; f.sent.push({ id, text, kind, extra, mid });
    return { message: { body: { mid } } };
  }, { intervalMs: 0 });
  await f.bot.process(f.photo()); await f.bot.process(f.answer()); await imageRunning;
  const prior = f.retouch.send({}, '-10', 'fictional preceding notice', 'chat'); await sendRunning;
  finishImage({ imageBase64: image.toString('base64'), imageSha256: digest(image) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.db.prepare('SELECT state FROM max_retouch_jobs').get().state, 'ready');
  f.config.retouch.enabled = false; releaseSend(); await prior; await f.retouch.drain();
  assert.equal(f.sent.filter(item => item.extra?.attachments).length, 0);
  assert.equal(f.db.prepare('SELECT state FROM max_retouch_jobs').get().state, 'ready');
});
test('mention matching rejects lookalike handles and accepts the actual numeric bot identity', () => {
  const options = { username: 'VM_bot', botUserId: 99 };
  assert.equal(mentionsRetouchBot({ body: { text: '@VM_bot_evil' } }, options), false);
  assert.equal(mentionsRetouchBot({ body: { text: 'hello @VM_bot!' } }, options), true);
  assert.equal(mentionsRetouchBot({ body: { markup: [{ type: 'user_mention', user_id: 99 }] } }, options), true);
});
test('MAX media rejects private URLs, foreign domains and malformed formats; upload keeps the verified MAX token', async () => {
  for (const url of ['http://i.oneme.ru/a', 'https://127.0.0.1/a', 'https://i.oneme.ru.evil.test/a', 'https://user:secret@i.oneme.ru/a', 'https://i.oneme.ru:8443/a']) assert.throws(() => maxMediaUrl(url));
  for (const address of ['127.0.0.1','10.0.0.1','100.64.0.1','169.254.169.254','192.168.1.1','::1','fc00::1','fe80::1']) assert.equal(publicMediaAddress(address), false, address);
  assert.equal(publicMediaAddress('185.16.150.10'), true); assert.equal(imageType(image), 'image/png');
  assert.throws(() => imageType(Buffer.from('<html>not a photo')));
  let body;
  const token = await uploadMaxImage({}, image, { api: async () => ({ url: 'https://iu.oneme.ru/uploadImage?fictional=1' }),
    request: async (_, url, options) => { assert.ok(url.startsWith('https://iu.oneme.ru/')); body = options.bytes; return Buffer.from(JSON.stringify({ photos: { '1': { token: 'fictional' } } })); } });
  assert.equal(token, 'fictional'); assert.ok(body.includes(image));
});
