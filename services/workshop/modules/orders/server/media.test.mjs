import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import crypto from 'node:crypto';
import { zipSync } from 'fflate';
import { inspectMedia, MediaError, MediaStore } from './media.mjs';

function png(width = 1, height = 1) {
  function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    const result = Buffer.alloc(body.length + 8);
    result.writeUInt32BE(data.length);
    body.copy(result, 4);
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, 255]))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PNG = png();
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
// Minimal SOI/SOF/SOS/EOI envelope exercises the JPEG marker/dimension scanner.
const JPEG = Buffer.from([255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1, 0, 0, 63, 0, 0, 255, 217]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
const upload = (name = 'Макет.png', bytes = PNG, contentType = 'image/png') => ({ name, bytes, contentType });
function corel(preview = PNG) {
  const root = Buffer.alloc(24); root.write('RIFF'); root.writeUInt32LE(16, 4); root.write('CDRFvrsn', 8);
  return upload('Учебный.cdr', Buffer.from(zipSync({ 'content/root.dat': root, ...(preview ? { 'previews/thumbnail.png': preview } : {}) })), 'application/vnd.corel-draw');
}

test('CDR creates an exact derived cover once, preserves original bytes and survives restart', async t => {
  const { directory, instance } = await store(t);
  const input = corel(); const original = await instance.add('42', input);
  let listing = await instance.list('42');
  const cover = listing.items.find(item => item.id === listing.coverId);
  assert.equal(listing.items.length, 2);
  assert.equal(cover.derivedFrom.mediaId, original.id);
  assert.equal(cover.derivedFrom.contentHash, crypto.createHash('sha256').update(input.bytes).digest('hex'));
  assert.deepEqual((await instance.read('42', cover.id)).bytes, PNG);
  assert.deepEqual((await instance.read('42', original.id)).bytes, input.bytes);
  const restarted = new MediaStore({ directory });
  await restarted.backfillCdrPreviews(); await restarted.ensureCdrPreview('42', original.id);
  listing = await restarted.list('42');
  assert.equal(listing.coverId, cover.id); assert.equal(listing.items.length, 2);
});

test('CDR preview never replaces an existing cover and deleted previews are not resurrected', async t => {
  const { directory, instance } = await store(t);
  const chosen = await instance.add('42', upload());
  const input = corel();
  const original = await instance.add('42', input);
  assert.equal((await instance.list('42')).coverId, chosen.id);
  assert.equal((await instance.list('42')).items.length, 2);
  await instance.add('43', corel());
  const cover = (await instance.list('43')).coverId;
  await instance.remove('43', cover);
  const restarted = new MediaStore({ directory }); await restarted.backfillCdrPreviews();
  assert.equal((await restarted.list('43')).coverId, null);
  assert.equal((await restarted.list('43')).items.length, 1);
  assert.equal((await restarted.list('42')).coverId, chosen.id);
  assert.deepEqual((await restarted.read('42', original.id)).bytes, input.bytes);
});

test('backfill covers old CDRs; removing original removes only its derived image', async t => {
  const { directory, instance } = await store(t);
  instance.ensureCdrPreview = async () => {}; // The former deployed writer had no preview support.
  const original = await instance.add('42', corel());
  const restarted = new MediaStore({ directory }); await restarted.backfillCdrPreviews();
  assert.ok((await restarted.list('42')).coverId);
  const independent = await restarted.add('42', upload('Фото.png'));
  await restarted.remove('42', original.id);
  assert.deepEqual((await restarted.list('42')).items.map(item => item.id), [independent.id]);
});

test('missing or invalid thumbnails and preview quota never discard the original', async t => {
  const { instance } = await store(t);
  for (const [id, preview] of [['1', null], ['2', Buffer.from('<script/>')], ['3', png(3000, 1)]]) {
    const original = await instance.add(id, corel(preview));
    const listing = await instance.list(id);
    assert.equal(listing.items.length, 1); assert.equal(listing.coverId, null);
    assert.ok(['unavailable', 'error'].includes(original.previewStatus));
  }
  instance.maxFilesPerOrder = 1;
  const original = await instance.add('4', corel());
  assert.equal(original.previewStatus, 'error');
  instance.maxFilesPerOrder = 2;
  await instance.backfillCdrPreviews();
  assert.equal((await instance.list('4')).items.length, 2);
});

async function store(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orders-kanban-media-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('orders-kanban-media-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { directory, instance: new MediaStore({ directory, ...options }) };
}

function errorIs(code, statusCode) {
  return error => error instanceof MediaError && error.code === code && error.statusCode === statusCode;
}

test('supported signatures determine trusted types and bounded image dimensions', () => {
  for (const [bytes, contentType] of [[PNG, 'image/png'], [GIF, 'image/gif'], [WEBP, 'image/webp'], [JPEG, 'image/jpeg']]) {
    assert.deepEqual(inspectMedia(bytes, contentType), { contentType, kind: 'image', width: 1, height: 1 });
  }
  assert.deepEqual(inspectMedia(PDF, 'application/pdf'), { contentType: 'application/pdf', kind: 'document' });
});

test('spoofed types, truncated files, unsafe formats and oversized dimensions are rejected', () => {
  assert.throws(() => inspectMedia(PNG, 'image/jpeg'), errorIs('MEDIA_TYPE_MISMATCH', 415));
  for (const bytes of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from('<html>test</html>'), Buffer.from('MZ executable'), PNG.subarray(0, -1), JPEG.subarray(0, -2), Buffer.from('%PDF-1.4\nmissing ending')]) {
    assert.throws(() => inspectMedia(bytes, 'image/png'), errorIs('MEDIA_INVALID_FILE', 415));
  }
  const corrupt = Buffer.from(PNG);
  corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => inspectMedia(corrupt, 'image/png'), errorIs('MEDIA_INVALID_FILE', 415));
  assert.throws(() => inspectMedia(png(10_000, 10_000), 'image/png'), errorIs('MEDIA_IMAGE_DIMENSIONS', 413));
});

test('uploads, stable gallery ordering and chosen cover survive a restart', async (t) => {
  const { directory, instance } = await store(t);
  const first = await instance.add('42', upload('Первый макет.png'));
  const second = await instance.add('42', upload('Согласованный макет.png'));
  const document = await instance.add('42', upload('Смета.pdf', PDF, 'application/pdf'));
  assert.match(first.id, /^[a-f0-9]{32}$/);
  assert.notEqual(first.id, second.id);
  assert.equal((await instance.list('42')).coverId, first.id);
  await instance.setCover('42', second.id);

  const restarted = new MediaStore({ directory });
  const gallery = await restarted.list('42');
  assert.deepEqual(gallery.items.map(item => item.id), [first.id, second.id, document.id]);
  assert.equal(gallery.coverId, second.id);
  assert.deepEqual(await restarted.read('42', first.id), { bytes: PNG, media: first });
  assert.equal(gallery.items[2].kind, 'document');
  assert.equal(Object.hasOwn(gallery.items[0], 'path'), false);
  assert.equal(Object.hasOwn(gallery.items[0], 'cover'), false);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['blobs', 'index.json']);
  assert.ok((await fs.readdir(path.join(directory, 'blobs'))).every(name => /^[a-f0-9]{32}\.bin$/.test(name)));
});

test('file ownership protects read, cover selection and removal across orders', async (t) => {
  const { instance } = await store(t);
  const image = await instance.add('42', upload());
  assert.deepEqual(await instance.list('other'), { items: [], coverId: null });
  for (const operation of [() => instance.read('other', image.id), () => instance.setCover('other', image.id), () => instance.remove('other', image.id)]) {
    await assert.rejects(operation, errorIs('MEDIA_NOT_FOUND', 404));
  }
  assert.equal((await instance.list('42')).items.length, 1);
});

test('logical order IDs and Unicode names never become filesystem paths', async (t) => {
  const { directory, instance } = await store(t);
  const image = await instance.add('../Заказ/42', upload('C:\\private\\Макет «вывеска»\u202e.png'));
  assert.equal(image.name, 'Макет «вывеска»_.png');
  assert.deepEqual((await instance.read('../Заказ/42', image.id)).bytes, PNG);
  for (const id of ['../index.json', '../../outside', '..\\outside', '%2e%2e%2findex.json', '0'.repeat(31)]) {
    await assert.rejects(() => instance.read('../Заказ/42', id), errorIs('MEDIA_NOT_FOUND', 404));
  }
  await assert.rejects(() => instance.add('42', upload('page.html')), errorIs('MEDIA_EXTENSION_MISMATCH', 415));
  await assert.rejects(() => instance.add('42', upload('program.exe')), errorIs('MEDIA_EXTENSION_MISMATCH', 415));
  assert.deepEqual((await fs.readdir(directory)).sort(), ['blobs', 'index.json']);
});

test('cover removal is a durable soft deletion and never deletes a different order', async (t) => {
  const { directory, instance } = await store(t);
  const first = await instance.add('42', upload());
  const second = await instance.add('42', upload('Второй.png'));
  const other = await instance.add('43', upload());
  const document = await instance.add('42', upload('Документ.pdf', PDF, 'application/pdf'));
  await assert.rejects(() => instance.setCover('42', document.id), errorIs('MEDIA_INVALID_COVER', 422));
  assert.equal((await instance.remove('42', first.id)).coverId, null);
  assert.equal((await instance.remove('42', first.id)).items.length, 2);
  await assert.rejects(() => instance.read('42', first.id), errorIs('MEDIA_NOT_FOUND', 404));
  await assert.rejects(() => instance.setCover('42', first.id), errorIs('MEDIA_NOT_FOUND', 404));
  const restarted = new MediaStore({ directory });
  assert.deepEqual((await restarted.list('42')).items.map(item => item.id), [second.id, document.id]);
  assert.equal((await restarted.list('43')).coverId, other.id);
  assert.deepEqual(await fs.readFile(path.join(directory, 'blobs', `${first.id}.bin`)), PNG);
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'index.json'), 'utf8'));
  assert.ok(metadata.records.find(item => item.id === first.id).deletedAt);
});

test('file and active-order byte limits fail without publishing partial uploads', async (t) => {
  const tiny = await store(t, { maxFileBytes: PNG.length - 1 });
  await assert.rejects(() => tiny.instance.add('42', upload()), errorIs('MEDIA_FILE_TOO_LARGE', 413));
  assert.deepEqual(await tiny.instance.list('42'), { items: [], coverId: null });
  const order = await store(t, { maxOrderBytes: PNG.length * 2 - 1 });
  await order.instance.add('42', upload());
  await assert.rejects(() => order.instance.add('42', upload()), errorIs('MEDIA_ORDER_QUOTA', 413));
  assert.equal((await order.instance.list('42')).items.length, 1);
  assert.equal((await fs.readdir(path.join(order.directory, 'blobs'))).length, 1);
});

test('physical storage quota still counts soft deletions after restart', async (t) => {
  const { directory, instance } = await store(t, { maxTotalBytes: PNG.length * 2 - 1 });
  const image = await instance.add('42', upload());
  await instance.remove('42', image.id);
  const restarted = new MediaStore({ directory, maxTotalBytes: PNG.length * 2 - 1 });
  await assert.rejects(() => restarted.add('43', upload()), errorIs('MEDIA_STORAGE_QUOTA', 507));
  assert.deepEqual(await restarted.list('42'), { items: [], coverId: null });
});

test('concurrent uploads respect file limits and cannot lose manifest entries', async (t) => {
  const { directory, instance } = await store(t, { maxFilesPerOrder: 1 });
  const results = await Promise.allSettled([instance.add('42', upload('Первый.png')), instance.add('42', upload('Второй.png'))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.ok(errorIs('MEDIA_ORDER_FILE_LIMIT', 409)(rejected.reason));
  const restarted = new MediaStore({ directory });
  assert.equal((await restarted.list('42')).items.length, 1);
  assert.equal((await fs.readdir(path.join(directory, 'blobs'))).length, 1);
});

test('a failed atomic manifest write removes the unpublished blob and frees its quota', async (t) => {
  const { directory, instance } = await store(t, { maxTotalFiles: 1 });
  await instance.init();
  await fs.mkdir(path.join(directory, 'index.json'));
  await assert.rejects(() => instance.add('42', upload()), errorIs('MEDIA_STORAGE_UNAVAILABLE', 503));
  assert.deepEqual(await instance.list('42'), { items: [], coverId: null });
  assert.deepEqual(await fs.readdir(path.join(directory, 'blobs')), []);
  await fs.rmdir(path.join(directory, 'index.json'));
  await instance.add('42', upload());
  assert.equal((await instance.list('42')).items.length, 1);
});

test('a corrupted index fails safely instead of resetting existing storage', async (t) => {
  const { directory, instance } = await store(t);
  const image = await instance.add('42', upload());
  const corrupt = '{private-source-sentinel';
  await fs.writeFile(path.join(directory, 'index.json'), corrupt);
  const restarted = new MediaStore({ directory });
  await assert.rejects(() => restarted.list('42'), error => {
    assert.ok(errorIs('MEDIA_STORAGE_UNAVAILABLE', 503)(error));
    assert.doesNotMatch(error.message, /private-source-sentinel|orders-kanban-media-/);
    return true;
  });
  assert.equal(await fs.readFile(path.join(directory, 'index.json'), 'utf8'), corrupt);
  assert.deepEqual(await fs.readFile(path.join(directory, 'blobs', `${image.id}.bin`)), PNG);
});
