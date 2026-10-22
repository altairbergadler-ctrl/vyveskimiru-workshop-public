import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MediaStore } from './media.mjs';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
const OTHER_PDF = Buffer.from('%PDF-1.4\n% Different fictional PDF\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const code = expected => error => error?.code === expected;
function generated(patch = {}) {
  return { documentId: '11111111-1111-4111-8111-111111111111', type: 'invoice', number: 'TEST-001', version: 1, requestId: '22222222-2222-4222-8222-222222222222', snapshotHash: sha(Buffer.from('Fictional frozen snapshot')), test: true, ...patch };
}
function input(patch = {}) { return { name: 'Счёт_TEST-001_заказ_TEST-9001_v1.pdf', bytes: PDF, generatedDocument: generated(), ...patch }; }

async function store(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orders-generated-media-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('orders-generated-media-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { directory, instance: new MediaStore({ directory, ...options }) };
}
const blobs = async directory => (await fs.readdir(path.join(directory, 'blobs'))).filter(name => name.endsWith('.bin'));

test('generated PDF is a marked list DTO with immutable metadata, raw content hash and readable original bytes', async t => {
  const { directory, instance } = await store(t);
  const metadata = generated();
  const record = await instance.addGenerated('TEST-9001', input({ generatedDocument: metadata }));
  assert.equal(record.contentType, 'application/pdf'); assert.equal(record.kind, 'document');
  assert.equal(record.contentHash, sha(PDF)); assert.deepEqual(record.generatedDocument, metadata);
  metadata.number = 'Changed after return'; record.generatedDocument.test = false;
  const listing = await instance.list('TEST-9001');
  assert.equal(listing.coverId, null); assert.equal(listing.items.length, 1);
  assert.equal(listing.items[0].generatedDocument.number, 'TEST-001');
  assert.equal(listing.items[0].generatedDocument.test, true);
  assert.deepEqual((await instance.read('TEST-9001', record.id)).bytes, PDF);
  assert.equal((await blobs(directory)).length, 1);
});

test('same generated document replays without a second blob or replacing an explicitly chosen image cover', async t => {
  const { directory, instance } = await store(t, { maxFilesPerOrder: 2 });
  const cover = await instance.add('TEST-9001', { name: 'Учебная обложка.gif', contentType: 'image/gif', bytes: GIF });
  await instance.setCover('TEST-9001', cover.id);
  const first = await instance.addGenerated('TEST-9001', input());
  const before = { files: instance.totalFiles, bytes: instance.totalBytes };
  const replay = await instance.addGenerated('TEST-9001', input());
  assert.equal(replay.id, first.id);
  assert.deepEqual({ files: instance.totalFiles, bytes: instance.totalBytes }, before);
  assert.equal((await instance.list('TEST-9001')).coverId, cover.id);
  assert.equal((await blobs(directory)).length, 2);
  assert.equal((await instance.list('TEST-9001')).items.length, 2);
});

test('generated lookup and idempotence survive a fresh MediaStore process instance', async t => {
  const { directory, instance } = await store(t);
  const first = await instance.addGenerated('TEST-9001', input());
  const restarted = new MediaStore({ directory });
  assert.equal((await restarted.generated('TEST-9001', generated().documentId)).id, first.id);
  assert.equal(await restarted.generated('TEST-OTHER', generated().documentId), null);
  assert.equal((await restarted.addGenerated('TEST-9001', input())).id, first.id);
  assert.equal((await blobs(directory)).length, 1);
  assert.deepEqual((await restarted.read('TEST-9001', first.id)).bytes, PDF);
});

test('same document identity refuses different bytes, order, name, snapshot or metadata without adding files', async t => {
  const { directory, instance } = await store(t);
  const first = await instance.addGenerated('TEST-9001', input());
  const attempts = [
    ['TEST-9001', input({ bytes: OTHER_PDF })], ['TEST-OTHER', input()],
    ['TEST-9001', input({ name: 'Changed.pdf' })],
    ['TEST-9001', input({ generatedDocument: generated({ snapshotHash: 'b'.repeat(64) }) })],
    ['TEST-9001', input({ generatedDocument: generated({ version: 2 }) })],
    ['TEST-9001', input({ generatedDocument: generated({ test: false }) })],
    ['TEST-9001', input({ generatedDocument: generated({ requestId: crypto.randomUUID() }) })],
  ];
  for (const [orderId, value] of attempts) await assert.rejects(instance.addGenerated(orderId, value), code('DOCUMENT_MEDIA_CONFLICT'));
  assert.equal((await blobs(directory)).length, 1);
  assert.equal((await instance.list('TEST-9001')).items[0].id, first.id);
  assert.equal((await instance.list('TEST-OTHER')).items.length, 0);
});

test('soft-deleted generated PDF stays deleted on replay and restart while its recoverable blob remains', async t => {
  const { directory, instance } = await store(t);
  const first = await instance.addGenerated('TEST-9001', input());
  await instance.remove('TEST-9001', first.id);
  assert.equal((await instance.list('TEST-9001')).items.length, 0);
  await assert.rejects(instance.addGenerated('TEST-9001', input()), code('DOCUMENT_MEDIA_DELETED'));
  await assert.rejects(instance.generated('TEST-9001', generated().documentId), code('DOCUMENT_MEDIA_DELETED'));
  const restarted = new MediaStore({ directory });
  await assert.rejects(restarted.addGenerated('TEST-9001', input()), code('DOCUMENT_MEDIA_DELETED'));
  assert.equal((await blobs(directory)).length, 1);
  const index = JSON.parse(await fs.readFile(path.join(directory, 'index.json'), 'utf8'));
  assert.ok(index.records[0].deletedAt);
  assert.equal(index.records.length, 1);
});

test('ordinary manual PDF uploads keep allowing intentional repeated files without generated metadata', async t => {
  const { directory, instance } = await store(t);
  const first = await instance.add('TEST-9001', { name: 'Учебный ручной.pdf', contentType: 'application/pdf', bytes: PDF });
  const second = await instance.add('TEST-9001', { name: 'Учебный ручной.pdf', contentType: 'application/pdf', bytes: PDF });
  assert.notEqual(first.id, second.id);
  assert.equal(first.generatedDocument, undefined); assert.equal(second.generatedDocument, undefined);
  assert.equal((await instance.list('TEST-9001')).items.length, 2);
  assert.equal((await blobs(directory)).length, 2);
});

test('concurrent repeats are serialized into one generated file even at the order file quota', async t => {
  const { directory, instance } = await store(t, { maxFilesPerOrder: 1 });
  const results = await Promise.all(Array.from({ length: 8 }, () => instance.addGenerated('TEST-9001', input())));
  assert.equal(new Set(results.map(result => result.id)).size, 1);
  assert.equal((await blobs(directory)).length, 1);
  assert.equal((await instance.list('TEST-9001')).items.length, 1);
  assert.equal(instance.totalFiles, 1);
});

test('invalid generated identities or non-PDF/mixed sources never enter the media index', async t => {
  const { directory, instance } = await store(t);
  for (const patch of [{ documentId: 'bad' }, { requestId: 'bad' }, { snapshotHash: 'bad' }, { version: 0 }, { type: 'other' }, { test: 'true' }, { unexpected: true }]) {
    await assert.rejects(instance.addGenerated('TEST-9001', input({ generatedDocument: generated(patch) })), code('DOCUMENT_MEDIA_INVALID'));
  }
  await assert.rejects(instance.add('TEST-9001', { name: 'Image.gif', bytes: GIF, contentType: 'image/gif', generatedDocument: generated() }), code('DOCUMENT_MEDIA_INVALID'));
  await assert.rejects(instance.add('TEST-9001', { ...input(), contentType: 'application/pdf', source: { key: 'a'.repeat(64) } }), code('DOCUMENT_MEDIA_INVALID'));
  assert.equal((await instance.list('TEST-9001')).items.length, 0);
  assert.equal((await blobs(directory)).length, 0);
});

test('restart refuses a corrupt generated-document hash or duplicate document identities in the private index', async t => {
  const { directory, instance } = await store(t);
  await instance.addGenerated('TEST-9001', input());
  const filename = path.join(directory, 'index.json');
  const original = JSON.parse(await fs.readFile(filename, 'utf8'));
  const wrongHash = structuredClone(original); wrongHash.records[0].contentHash = 'bad';
  await fs.writeFile(filename, JSON.stringify(wrongHash));
  await assert.rejects(new MediaStore({ directory }).list('TEST-9001'), code('MEDIA_STORAGE_UNAVAILABLE'));
  const duplicate = structuredClone(original); duplicate.records.push({ ...structuredClone(original.records[0]), id: 'a'.repeat(32) });
  await fs.writeFile(filename, JSON.stringify(duplicate));
  await assert.rejects(new MediaStore({ directory }).list('TEST-9001'), code('MEDIA_STORAGE_UNAVAILABLE'));
});
