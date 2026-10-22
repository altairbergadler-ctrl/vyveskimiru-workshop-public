import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { launch, createDirectory, removeDirectory } from './sandbox-lib.mjs';
import { attachmentSource, parseLayoutEmail } from '../modules/orders/server/mail-import.mjs';

test('full backend links staged large CDR without nesting the shared queue; repeated request and restart preserve one file', async t => {
  const directory = createDirectory('mail-http-');
  let instance = await launch(directory, { mail: true });
  t.after(async () => {
    const timer = setTimeout(() => instance.child.kill('SIGKILL'), 2000);
    try { await instance.stop(); } finally { clearTimeout(timer); removeDirectory(directory); }
  });
  const raw = Buffer.from('From: designer@example.invalid\r\nMessage-ID: <http@example.invalid>\r\nSubject: Order #9001\r\nMIME-Version: 1.0\r\nContent-Type: text/html\r\n\r\n<a href="https://yadi.sk/d/fixture123">large.cdr</a>');
  const parsed = await parseLayoutEmail(raw), attachment = parsed.attachments[0];
  const bytes = Buffer.alloc(13 * 1024 * 1024); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('CDRFvrsn', 8);
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const messageKey = 'c'.repeat(64), account = digest('\nINBOX\ndesigner@example.invalid');
  const file = { name: 'large.cdr', size: bytes.length, contentType: 'application/vnd.corel-draw', contentHash: digest(bytes), publicUrl: 'https://disk.yandex.ru/d/fixture123' };
  const db = new Database(path.join(directory, 'data', 'finance.sqlite3'));
  try {
    db.prepare('INSERT INTO mail_messages VALUES(?,?,?,?,?,?,?)').run(messageKey, account, raw, 'review', JSON.stringify({parserVersion: 2, message: parsed.message, attachments: [{...attachment, state: 'review'}]}), new Date().toISOString(), '');
    db.prepare("INSERT INTO mail_link_files VALUES(?,?,?,'')").run(attachmentSource(parsed.message, '51').key, bytes, JSON.stringify(file));
  } finally { db.close(); }
  const request = async (route, body) => {
    const response = await fetch(instance.base + '/kanban/api' + route, {
      method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(5000),
      headers: { Cookie: `finance_session=${instance.token}`, Origin: instance.base, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(response.status, 200); return response;
  };
  const selection = { messageKey, partId: '51', orderId: '9001', reason: 'Номер учебного заказа указан в теме письма.' };
  const first = await (await request('/mail/resolve', selection)).json();
  const result = first.messages.find(m => m.key === messageKey).attachments[0];
  assert.equal(result.state, 'imported');
  await request('/board?fresh=1'); // Other users are not left waiting behind resolve.
  await instance.stop(); instance = await launch(directory, { mail: true });
  const repeat = await (await request('/mail/resolve', selection)).json();
  assert.equal(repeat.messages.find(m => m.key === messageKey).attachments[0].mediaId, result.mediaId);
  const download = Buffer.from(await (await request(`/orders/9001/media/${result.mediaId}?download=1`)).arrayBuffer());
  assert.equal(digest(download), file.contentHash);
  const listing = await (await request('/orders/9001/media')).json();
  assert.equal(listing.items.length, 1);
  assert.equal(listing.items[0].source.publicUrl, file.publicUrl);
});
