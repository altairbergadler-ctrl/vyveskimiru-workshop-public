import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { DiskAttachmentSource, diskLinks, publicDiskUrl, allowedDownloadUrl, publicAddress, MAX_LAYOUT_BYTES } from './mail-links.mjs';
import { parseLayoutEmail } from './mail-import.mjs';

const publicUrl = 'https://disk.yandex.ru/d/fixture123';
const href = 'https://downloader.disk.yandex.ru/disk/fixture';
const bytes = Buffer.from('%PDF-1.4\n%%EOF\n');
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
function fixture(overrides = {}, file = bytes) {
  const calls = [];
  const source = new DiskAttachmentSource({ request: async (url, options) => {
    calls.push({ url: url.href, ...options });
    if (url.hostname === 'cloud-api.yandex.net') return { bytes: Buffer.from(JSON.stringify(url.pathname.endsWith('/download')
      ? { href } : { type: 'file', name: 'Учебный.pdf', size: file.length, sha256: digest(file), ...overrides })) };
    return { bytes: file };
  } });
  return { source, calls };
}

test('HTML links are inert, decoded, deduplicated and isolated from existing MIME IDs', async () => {
  const html = `<script>fetch('https://evil.invalid')</script><img src="http://127.0.0.1/secret"><a href="https://yadi.sk/d/fixture123">Макет &amp; буквы.cdr (26429547)</a><a href="${publicUrl}">duplicate</a>`;
  assert.deepEqual(diskLinks(html), [{ provider: 'yandex-disk', url: publicUrl, name: 'Макет & буквы.cdr' }]);
  const raw = Buffer.from(`From: designer@example.invalid\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=direct.pdf\r\n\r\n${bytes}\r\n--x\r\nContent-Type: text/html; charset=utf-8\r\nContent-Disposition: attachment; filename=narod_attachment_links.html\r\n\r\n${html}\r\n--x--`);
  const parsed = await parseLayoutEmail(raw);
  assert.deepEqual(parsed.attachments.map(item => item.partId), ['1', '2', '51']);
  assert.equal(parsed.attachments[2].link.url, publicUrl);
  assert.equal(diskLinks('', `Макет ${publicUrl}.`)[0].url, publicUrl);
  assert.throws(() => diskLinks(Array.from({ length: 50 }, (_, i) => `<a href="https://yadi.sk/d/fixture${i}">file</a>`).join('')), { code: 'MAIL_LINK_LIMIT' });
});

test('public and download allowlists reject credentials, wrong schemes, local addresses and lookalike hosts', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1']) assert.equal(publicAddress({address, family: 4}), false);
  for (const address of ['::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1']) assert.equal(publicAddress({address, family: 6}), false);
  assert.equal(publicAddress({address: '213.180.204.127', family: 4}), true);
  for (const url of ['http://yadi.sk/d/fixture123', 'https://yadi.sk.evil.invalid/d/fixture123', 'https://user@yadi.sk/d/fixture123', 'https://yadi.sk:444/d/fixture123', 'https://127.0.0.1/d/fixture123', 'https://disk.yandex.ru/d/fixture123/nested']) assert.equal(publicDiskUrl(url), null);
  for (const url of ['http://downloader.disk.yandex.ru/disk/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://downloader.disk.yandex.ru.evil.invalid/x', 'https://user@downloader.disk.yandex.ru/x', 'https://evil.yandex.ru/x']) assert.equal(allowedDownloadUrl(url), false);
  assert.equal(allowedDownloadUrl('https://s123.storage.yandex.net/file'), true);
});

test('provider metadata and bounded verified bytes produce a durable source, never a signed URL', async () => {
  const { source, calls } = fixture();
  const result = await source.download({ url: publicUrl });
  assert.deepEqual(result.bytes, bytes);
  assert.equal(result.publicUrl, publicUrl);
  assert.equal(result.contentHash, digest(bytes));
  assert.equal(JSON.stringify(result).includes(href), false);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].maxBytes, bytes.length);
  assert.ok(calls.every(call => call.signal instanceof AbortSignal));
  assert.equal(new URL(calls[0].url).searchParams.get('public_key'), publicUrl);
});

test('folders, oversized files, unsupported formats, changed size/hash and invalid containers fail before import', async () => {
  for (const [override, code] of [[{ type: 'dir' }, 'MAIL_LINK_FORMAT'], [{ name: 'malware.exe' }, 'MAIL_LINK_FORMAT'], [{ size: MAX_LAYOUT_BYTES + 1 }, 'MAIL_LINK_SIZE'], [{ sha256: 'missing' }, 'MAIL_LINK_METADATA'], [{ size: bytes.length + 1 }, 'MAIL_LINK_CHANGED'], [{ sha256: 'a'.repeat(64) }, 'MAIL_LINK_CHANGED']]) {
    await assert.rejects(fixture(override).source.download({ url: publicUrl }), { code });
  }
  await assert.rejects(fixture({}, Buffer.from('MZ executable')).source.download({ url: publicUrl }), { code: 'MEDIA_INVALID_FILE' });
});

test('redirects cannot reach another service and API redirects are not followed', async () => {
  for (const apiRedirect of [false, true]) {
    const { source } = fixture();
    const original = source.request; let externalCalls = 0;
    source.request = async (url, options) => {
      if (apiRedirect || url.hostname === 'downloader.disk.yandex.ru') return { redirect: 'http://169.254.169.254/metadata' };
      if (url.hostname !== 'cloud-api.yandex.net') externalCalls++;
      return original(url, options);
    };
    await assert.rejects(source.download({ url: publicUrl }));
    assert.equal(externalCalls, 0);
  }
});

test('26 MiB CDR is accepted from provider and as a direct MIME attachment', async () => {
  const large = Buffer.alloc(26 * 1024 * 1024);
  large.write('RIFF'); large.writeUInt32LE(large.length - 8, 4); large.write('CDRFvrsn', 8);
  const downloaded = await fixture({ name: 'Большой.cdr' }, large).source.download({ url: publicUrl });
  assert.equal(downloaded.size, large.length);
  const raw = Buffer.from(`From: designer@example.invalid\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=large.cdr\r\nContent-Transfer-Encoding: base64\r\n\r\n${large.toString('base64')}\r\n--x--`);
  const parsed = await parseLayoutEmail(raw);
  assert.equal(parsed.attachments[0].supported, true);
  assert.equal(parsed.attachments[0].size, large.length);
});
