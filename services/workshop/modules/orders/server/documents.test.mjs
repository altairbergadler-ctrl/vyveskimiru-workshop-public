import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeDocumentSeller, prepareOrderDocument, OrderDocuments } from './documents.mjs';
import { DOCUMENT_TABLES, digest } from '../../../server/document-sheets.mjs';
import { MediaStore } from './media.mjs';

// All identities, bank details and orders in this file are synthetic. Nothing
// connects to Google or imports a production seller seed.
const uuid = () => crypto.randomUUID();
const errorCode = code => error => error?.code === code;
function syntheticInn(prefix) {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  return prefix + String(weights.reduce((sum, weight, index) => sum + weight * Number(prefix[index]), 0) % 11 % 10);
}
const SELLER_INN = syntheticInn('990099001');
const BUYER_INN = syntheticInn('990099002');

function sellerFixture(patch = {}) {
  return {
    label: 'Учебный продавец', name: 'ООО «Учебный продавец»', inn: SELLER_INN, kpp: '990001001', ogrn: '',
    address: 'Учебный город, ул. Вымышленная, д. 1', signer: 'Образцов Т. Т.', signerRole: 'Директор', vat: 'none',
    accounts: [{ label: 'Учебный счёт', bank: 'ВЫМЫШЛЕННЫЙ УЧЕБНЫЙ БАНК', bik: '019999999', account: '40702810000000000001', correspondent: '30101810000000000001' }],
    ...patch,
  };
}

function orderFixture(patch = {}) {
  return {
    id: 'TEST-9001', status: 'Сдан', createdDate: '2026-10-20', amount: 2750,
    contacts: [{ name: 'Учебный контакт', email: 'test@example.invalid', edit: { fields: [
      { id: 'companyName', value: 'ООО «Учебный покупатель»' },
      { id: 'requisites', value: `ООО «Учебный покупатель»\nИНН: ${BUYER_INN}\nКПП: 990002001\nЮридический адрес: Учебный город, ул. Не существует, д. 2` },
    ] } }],
    items: [{ name: 'Учебная вывеска', description: 'Вымышленный товар', unit: 'м²', width: 2.5, height: 1.1, quantity: 99, amount: 2750, edit: { fields: [
      { id: 'volume', value: 2.75 }, { id: 'unitPrice', value: 1000 }, { id: 'quantity', value: 99 },
    ] } }],
    installations: [], ...patch,
  };
}

class MemorySheets {
  constructor(events) {
    this.events = events;
    this.data = Object.fromEntries(DOCUMENT_TABLES.map(def => [def.name, [structuredClone(def.headers)]]));
    this.writes = [];
    this.failWrite = null;
  }
  async getSpreadsheet() {
    return { sheets: DOCUMENT_TABLES.map(def => ({ properties: { title: def.name, sheetId: def.id, gridProperties: { rowCount: def.capacity, columnCount: def.headers.length } } })) };
  }
  async getRanges(ranges, options) {
    assert.equal(options.valueRenderOption, 'UNFORMATTED_VALUE');
    this.events.push('sheets:read');
    return { valueRanges: ranges.map(range => {
      const name = /^'([^']+)'!/.exec(range)?.[1];
      assert.ok(Object.hasOwn(this.data, name), 'Only the three document tables may be read');
      return { range, values: structuredClone(this.data[name]) };
    }) };
  }
  async updateValues(updates, options) {
    assert.equal(options.valueInputOption, 'RAW');
    this.writes.push(structuredClone(updates));
    if (this.failWrite) await this.failWrite(updates, 'before');
    for (const entry of updates) {
      const match = /^'([^']+)'!A(\d+):([A-Z]+)(\d+)$/.exec(entry.range);
      assert.ok(match, 'Full exact rows only');
      assert.equal(match[2], match[4]);
      const def = DOCUMENT_TABLES.find(def => def.name === match[1]);
      assert.ok(def, 'No writes outside document tables');
      assert.equal(entry.values.length, 1);
      assert.equal(entry.values[0].length, def.headers.length);
      const row = Number(match[2]);
      while (this.data[def.name].length < row) this.data[def.name].push([]);
      this.data[def.name][row - 1] = structuredClone(entry.values[0]);
      this.events.push(`${def.name}:${entry.values[0][8] || 'saved'}`);
    }
    if (this.failWrite) await this.failWrite(updates, 'after');
    return { totalUpdatedRows: updates.length };
  }
  documents() { return this.data['Документы заказов'].slice(1).filter(row => row.length); }
}

class MemoryMedia {
  constructor(state, events) { this.state = state; this.events = events; }
  async generated(orderId, documentId) {
    const record = this.state.records.find(record => record.orderId === orderId && record.generatedDocument.documentId === documentId);
    if (record?.deleted) throw Object.assign(new Error('Deleted fictional file'), { code: 'DOCUMENT_MEDIA_DELETED', status: 409 });
    return record ? structuredClone(record) : null;
  }
  async addGenerated(orderId, { name, bytes, generatedDocument }) {
    this.events.push('media:add');
    this.state.addCount += 1;
    assert.ok(Buffer.isBuffer(bytes));
    const record = { id: crypto.randomBytes(16).toString('hex'), orderId, name, contentType: 'application/pdf', contentHash: crypto.createHash('sha256').update(bytes).digest('hex'), generatedDocument: structuredClone(generatedDocument) };
    this.state.records.push(record);
    return structuredClone(record);
  }
}

async function harness(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workshop-order-documents-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const events = [];
  const client = new MemorySheets(events);
  const mediaState = { records: [], addCount: 0 };
  const renders = [];
  const board = { orders: [orderFixture()] };
  const createStore = () => new OrderDocuments({
    client, directory, mediaStore: new MemoryMedia(mediaState, events), readBoardImpl: async () => structuredClone(board),
    renderPdf: async snapshot => {
      events.push('pdf:render'); renders.push(structuredClone(snapshot));
      return Buffer.from('%PDF-1.4\n% Fictional document test only\n%%EOF');
    },
  });
  let store = createStore();
  const created = await store.saveSeller({ requestId: uuid(), seller: sellerFixture() });
  let seller = created.seller;
  return {
    client, directory, events, mediaState, renders, board,
    get store() { return store; }, get seller() { return seller; },
    reopen() { store = createStore(); return store; },
    async saveSeller(patch = {}) { const result = await store.saveSeller({ requestId: uuid(), seller: { ...seller, ...patch } }); seller = result.seller; return result; },
    async input(patch = {}) {
      const prepared = await store.prepare(board.orders[0].id);
      return { requestId: uuid(), type: 'invoice', number: 'TEST-001', date: '2026-10-21', sellerId: seller.id, accountId: seller.accounts.find(account => account.active).id, amountDue: 1250.13, test: true, expectedSourceHash: prepared.sourceHash, expectedSellerRevision: seller.revision, ...patch };
    },
  };
}

test('seller normalization uses explicit synthetic values and stable IDs without inferring VAT or identity', () => {
  const request = uuid();
  const source = sellerFixture({ vat: undefined });
  const result = normalizeDocumentSeller(source, request);
  assert.equal(result.id, request);
  assert.equal(result.vat, null, 'Tax status remains unknown until confirmed');
  assert.equal(result.accounts[0].sellerId, request);
  assert.deepEqual(normalizeDocumentSeller(source, request), result);
  assert.equal(source.accounts[0].id, undefined, 'Does not mutate input');
  assert.throws(() => normalizeDocumentSeller(sellerFixture({ inn: '123' }), uuid()), errorCode('DOCUMENT_SELLER_INVALID'));
  assert.throws(() => normalizeDocumentSeller(sellerFixture({ accounts: [{ ...source.accounts[0], sellerId: uuid() }] }), uuid()), errorCode('DOCUMENT_ACCOUNT_INVALID'));
  assert.throws(() => normalizeDocumentSeller({ ...source, unexpected: true }, uuid()), errorCode('DOCUMENT_SELLER_INVALID'));
});

test('default PDF renderer and real MediaStore confirm original with raw hash bound to layout',async t=>{
  const h=await harness(t);const mediaStore=new MediaStore({directory:path.join(h.directory,'real-media')});await mediaStore.init();
  const store=new OrderDocuments({client:h.client,mediaStore,directory:h.directory,readBoardImpl:async()=>structuredClone(h.board)});
  const result=await store.create(h.board.orders[0].id,await h.input());assert.equal(result.state,'confirmed');
  const {bytes}=await mediaStore.read(h.board.orders[0].id,result.media.id);assert.equal(result.media.contentHash,crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.media.documentLayout.pdfSha256,result.media.contentHash);assert.ok(result.media.documentLayout.anchors.sellerSignature);assert.ok(result.media.documentLayout.anchors.sellerStamp);
});

test('seller create/read/update are confirmed, request-idempotent and reject stale revisions', async t => {
  const h = await harness(t);
  assert.equal((await h.store.sellers()).items.length, 1);
  assert.equal(h.client.data['Продавцы'].length, 2);
  const requestId = uuid();
  const original = structuredClone(h.seller);
  const payload = { ...original, label: 'Учебный продавец после правки' };
  const first = await h.store.saveSeller({ requestId, seller: payload });
  assert.notEqual(first.seller.revision, original.revision);
  const writes = h.client.writes.length;
  h.reopen();
  const repeated = await h.store.saveSeller({ requestId, seller: payload });
  assert.equal(repeated.seller.revision, first.seller.revision);
  assert.equal(h.client.writes.length, writes);
  await assert.rejects(h.store.saveSeller({ requestId: uuid(), seller: { ...original, label: 'Устаревшее исправление' } }), errorCode('DOCUMENT_SELLER_CONFLICT'));
  assert.equal(h.client.data['Продавцы'].length, 2, 'Updates preserve the existing row');
});

test('removed seller accounts are archived and archived sellers cannot issue new documents', async t => {
  const h = await harness(t);
  const oldId = h.seller.accounts[0].id;
  await h.saveSeller({ accounts: [] });
  assert.equal(h.seller.accounts.length, 1, 'Historical account remains');
  assert.equal(h.seller.accounts[0].id, oldId);
  assert.equal(h.seller.accounts[0].active, false);
  const prepared = await h.store.prepare(h.board.orders[0].id);
  const input = { requestId: uuid(), type: 'invoice', number: 'TEST-001', date: '2026-10-21', sellerId: h.seller.id, accountId: oldId, amountDue: 1, expectedSourceHash: prepared.sourceHash, expectedSellerRevision: h.seller.revision };
  await assert.rejects(h.store.create(h.board.orders[0].id, input), errorCode('DOCUMENT_SELLER_INVALID'));
  await h.saveSeller({ active: false });
  assert.equal((await h.store.sellers()).items.length, 0);
  assert.equal((await h.store.sellers({ includeArchived: true })).items.length, 1);
  assert.equal(h.client.documents().length, 0);
});

test('document preparation uses Google calculated volume and rejects incomplete or contradictory sources', () => {
  const original = orderFixture();
  const prepared = prepareOrderDocument(original);
  assert.equal(prepared.ready, true, prepared.warnings.join(' '));
  assert.equal(prepared.items[0].quantity, 2.75);
  assert.notEqual(prepared.items[0].quantity, original.items[0].quantity);
  assert.equal(prepared.total, 2750);
  assert.equal(prepared.buyer.inn, BUYER_INN);
  assert.equal(prepared.completed, true);
  const missingPrice = structuredClone(original);
  missingPrice.items[0].edit.fields.find(field => field.id === 'unitPrice').value = '';
  for (const source of [missingPrice, { ...original, amount: 3000 }, { ...original, contacts: [original.contacts[0], original.contacts[0]] }, { ...original, contacts: [] }]) {
    assert.equal(prepareOrderDocument(source).ready, false);
  }
  assert.equal(original.items[0].quantity, 99, 'No source mutation');
});

test('create blocks non-kopeck amounts and stale source/seller selections before a PDF or business write', async t => {
  const h = await harness(t);
  const base = await h.input();
  const writes = h.client.writes.length;
  for (const amountDue of [null, '', 0, -1, 0.001, 1.234, 2750.01, NaN]) {
    await assert.rejects(h.store.create(h.board.orders[0].id, { ...base, requestId: uuid(), amountDue }), errorCode('DOCUMENT_AMOUNT_INVALID'));
  }
  await assert.rejects(h.store.create(h.board.orders[0].id, { ...base, requestId: uuid(), expectedSourceHash: 'stale' }), errorCode('DOCUMENT_SOURCE_CHANGED'));
  await assert.rejects(h.store.create(h.board.orders[0].id, { ...base, requestId: uuid(), expectedSellerRevision: 'stale' }), errorCode('DOCUMENT_SELLER_CHANGED'));
  assert.equal(h.client.writes.length, writes);
  assert.equal(h.renders.length, 0);
  assert.equal(h.mediaState.records.length, 0);
});

test('invoice confirms Google snapshot before rendering and attaches one generated PDF before final confirmation', async t => {
  const h = await harness(t);
  const input = await h.input();
  h.events.length = 0;
  const result = await h.store.create(h.board.orders[0].id, input);
  assert.equal(result.state, 'confirmed');
  assert.equal(result.document.version, 1);
  const [row] = h.client.documents();
  assert.equal(row[8], 'confirmed');
  assert.equal(row[11], result.media.id);
  assert.equal(row[12], result.media.contentHash);
  assert.equal(row[10], digest(row[9]));
  const snapshot = JSON.parse(row[9]);
  assert.equal(snapshot.items[0].quantity, 2.75);
  assert.equal(snapshot.amountDue, 1250.13);
  assert.equal(snapshot.total, 2750);
  assert.equal(snapshot.test, true);
  assert.equal(snapshot.buyer.requisites, undefined, 'Original free text is not copied into issued PDF snapshot');
  assert.equal(h.renders.length, 1);
  assert.equal(h.mediaState.addCount, 1);
  const preparedAt = h.events.indexOf('Документы заказов:prepared');
  const renderedAt = h.events.indexOf('pdf:render');
  assert.ok(preparedAt >= 0 && preparedAt < renderedAt);
  assert.ok(h.events.slice(preparedAt + 1, renderedAt).includes('sheets:read'), 'Prepared row is read back before rendering');
  assert.ok(renderedAt < h.events.indexOf('media:add'));
  assert.ok(h.events.indexOf('media:add') < h.events.indexOf('Документы заказов:confirmed'));
  const receipt = JSON.parse(await fs.readFile(path.join(h.directory, `${input.requestId}.json`), 'utf8'));
  assert.equal(receipt.state, 'verified');
});

test('same request after store restart reuses the issued snapshot and file while changed payload conflicts', async t => {
  const h = await harness(t);
  const input = await h.input();
  const first = await h.store.create(h.board.orders[0].id, input);
  const originalSnapshot = h.client.documents()[0][9];
  const writes = h.client.writes.length;
  h.board.orders[0].contacts[0].edit.fields[1].value = 'Changed unusable buyer';
  h.reopen();
  const replay = await h.store.create(h.board.orders[0].id, input);
  assert.equal(replay.document.id, first.document.id);
  assert.equal(replay.media.id, first.media.id);
  assert.equal(h.client.documents()[0][9], originalSnapshot);
  assert.equal(h.client.writes.length, writes);
  assert.equal(h.renders.length, 1);
  assert.equal(h.mediaState.addCount, 1);
  await assert.rejects(h.store.create(h.board.orders[0].id, { ...input, amountDue: 1300 }), errorCode('DOCUMENT_REQUEST_CONFLICT'));
  assert.equal(h.client.documents().length, 1);
});

test('a new request creates the next document version without replacing a previous issued file', async t => {
  const h = await harness(t);
  const first = await h.store.create(h.board.orders[0].id, await h.input());
  const second = await h.store.create(h.board.orders[0].id, await h.input({ amountDue: 1500 }));
  assert.equal(first.document.version, 1);
  assert.equal(second.document.version, 2);
  assert.notEqual(second.document.id, first.document.id);
  assert.notEqual(second.media.id, first.media.id);
  assert.equal(h.mediaState.records.length, 2);
  assert.deepEqual(h.client.documents().map(row => row[7]), [1, 2]);
});

test('failed Google final confirmation retries from the prepared row and does not generate or attach twice', async t => {
  const h = await harness(t);
  const input = await h.input();
  let failed = false;
  h.client.failWrite = async (updates, phase) => {
    if (!failed && phase === 'before' && updates.some(write => write.values[0][8] === 'confirmed')) { failed = true; throw new Error('Synthetic network interruption before final write'); }
  };
  await assert.rejects(h.store.create(h.board.orders[0].id, input), errorCode('DOCUMENT_UNCONFIRMED'));
  assert.equal(h.client.documents()[0][8], 'prepared');
  assert.equal(h.mediaState.addCount, 1);
  assert.equal(h.renders.length, 1);
  h.client.failWrite = null;
  h.reopen();
  const result = await h.store.create(h.board.orders[0].id, input);
  assert.equal(result.state, 'confirmed');
  assert.equal(h.client.documents().length, 1);
  assert.equal(h.client.documents()[0][8], 'confirmed');
  assert.equal(h.mediaState.addCount, 1);
  assert.equal(h.renders.length, 1);
});

test('lost acknowledgement of prepared Google write recovers by request ID before generating the PDF', async t => {
  const h = await harness(t);
  const input = await h.input();
  let failed = false;
  h.client.failWrite = async (updates, phase) => {
    if (!failed && phase === 'after' && updates.some(write => write.values[0][8] === 'prepared')) { failed = true; throw new Error('Synthetic lost acknowledgement after Google accepted'); }
  };
  await assert.rejects(h.store.create(h.board.orders[0].id, input), errorCode('DOCUMENT_UNCONFIRMED'));
  assert.equal(h.client.documents().length, 1);
  assert.equal(h.renders.length, 0);
  h.client.failWrite = null;
  h.reopen();
  const result = await h.store.create(h.board.orders[0].id, input);
  assert.equal(result.state, 'confirmed');
  assert.equal(h.client.documents().length, 1);
  assert.equal(h.mediaState.addCount, 1);
  assert.equal(h.renders.length, 1);
});

test('a deliberately deleted issued PDF is never silently restored by replay', async t => {
  const h = await harness(t);
  const input = await h.input();
  await h.store.create(h.board.orders[0].id, input);
  h.mediaState.records[0].deleted = true;
  const writes = h.client.writes.length;
  h.reopen();
  await assert.rejects(h.store.create(h.board.orders[0].id, input), errorCode('DOCUMENT_MEDIA_DELETED'));
  assert.equal(h.renders.length, 1);
  assert.equal(h.mediaState.addCount, 1);
  assert.equal(h.client.writes.length, writes);
  assert.equal(h.client.documents()[0][8], 'confirmed');
  h.mediaState.records.length = 0;
  await assert.rejects(h.store.create(h.board.orders[0].id, input), errorCode('DOCUMENT_FILE_MISSING'));
  assert.equal(h.renders.length, 1);
  assert.equal(h.mediaState.addCount, 1);
  assert.equal(h.client.writes.length, writes);
});

test('UPD requires completed work and installations, and unknown seller VAT blocks document issuance', async t => {
  const h = await harness(t);
  h.board.orders[0].status = 'В производстве';
  await assert.rejects(h.store.create(h.board.orders[0].id, await h.input({ type: 'upd', number: 'UPD-TEST-001' })), errorCode('DOCUMENT_WORK_NOT_FINISHED'));
  h.board.orders[0].status = 'Сдан';
  h.board.orders[0].installations = [{ status: 'Запланирован' }];
  await assert.rejects(h.store.create(h.board.orders[0].id, await h.input({ type: 'upd', number: 'UPD-TEST-001' })), errorCode('DOCUMENT_WORK_NOT_FINISHED'));
  h.board.orders[0].installations = [{ status: 'Завершён' }];
  await h.saveSeller({ vat: null });
  await assert.rejects(h.store.create(h.board.orders[0].id, await h.input({ type: 'upd', number: 'UPD-TEST-001' })), errorCode('DOCUMENT_VAT_UNSUPPORTED'));
  await h.saveSeller({ vat: 'none' });
  const result = await h.store.create(h.board.orders[0].id, await h.input({ type: 'upd', number: 'UPD-TEST-001', amountDue: 1 }));
  assert.equal(result.document.type, 'upd');
  assert.equal(h.renders[0].amountDue, 2750, 'UPD closes the full confirmed work, independent of requested invoice advance');
  assert.equal(h.client.documents().length, 1);
});

test('actual seller revision detects manual bank changes even when technical revision cells were not updated', async t => {
  const h = await harness(t);
  const input = await h.input();
  const persistedSellerRevision = h.client.data['Продавцы'][1][11];
  const persistedAccountRevision = h.client.data['Счета продавцов'][1][8];
  h.client.data['Счета продавцов'][1][3] = 'ДРУГОЙ ВЫМЫШЛЕННЫЙ БАНК';
  h.client.data['Счета продавцов'][1][5] = '40702810000000000002';
  const current = (await h.store.sellers()).items[0];
  assert.notEqual(current.revision, input.expectedSellerRevision);
  assert.equal(h.client.data['Продавцы'][1][11], persistedSellerRevision);
  assert.equal(h.client.data['Счета продавцов'][1][8], persistedAccountRevision);
  const writes = h.client.writes.length;
  await assert.rejects(h.store.create(h.board.orders[0].id, input), errorCode('DOCUMENT_SELLER_CHANGED'));
  await assert.rejects(h.store.saveSeller({ requestId: uuid(), seller: { ...h.seller, label: 'Устаревшая правка' } }), errorCode('DOCUMENT_SELLER_CONFLICT'));
  assert.equal(h.client.writes.length, writes);
  assert.equal(h.renders.length, 0);
});

test('seller save requires full bank readback and an exact same-request reconciliation after correction', async t => {
  const h = await harness(t);
  const requestId = uuid();
  const payload = { ...h.seller, label: 'Новое учебное название' };
  let correctUpdates;
  h.client.failWrite = async (updates, phase) => {
    if (phase === 'after' && updates.some(write => write.range.startsWith("'Продавцы'!"))) {
      correctUpdates = structuredClone(updates);
      h.client.data['Счета продавцов'][1][3] = 'НЕОЖИДАННЫЙ БАНК В READBACK';
    }
  };
  await assert.rejects(h.store.saveSeller({ requestId, seller: payload }), errorCode('DOCUMENT_UNCONFIRMED'));
  let receipt = JSON.parse(await fs.readFile(path.join(h.directory, `${requestId}.json`), 'utf8'));
  assert.equal(receipt.state, 'submitting');
  assert.equal(h.client.data['Продавцы'][1][11], receipt.sellerHash, 'Matching technical revision is insufficient');
  h.client.failWrite = null;
  h.reopen();
  await assert.rejects(h.store.saveSeller({ requestId, seller: payload }), errorCode('DOCUMENT_UNCONFIRMED'));
  await h.client.updateValues(correctUpdates, { valueInputOption: 'RAW' });
  const writes = h.client.writes.length;
  const recovered = await h.store.saveSeller({ requestId, seller: payload });
  assert.equal(recovered.state, 'confirmed');
  assert.equal(recovered.seller.accounts[0].bank, 'ВЫМЫШЛЕННЫЙ УЧЕБНЫЙ БАНК');
  assert.equal(h.client.writes.length, writes, 'Reconciliation does not resubmit the batch');
  receipt = JSON.parse(await fs.readFile(path.join(h.directory, `${requestId}.json`), 'utf8'));
  assert.equal(receipt.state, 'verified');
});

test('seller save readback includes archived accounts rather than only current requested accounts', async t => {
  const h = await harness(t);
  const requestId = uuid();
  h.client.failWrite = async (updates, phase) => {
    if (phase === 'after' && updates.some(write => write.range.startsWith("'Счета продавцов'!"))) h.client.data['Счета продавцов'][1][7] = true;
  };
  await assert.rejects(h.store.saveSeller({ requestId, seller: { ...h.seller, accounts: [] } }), errorCode('DOCUMENT_UNCONFIRMED'));
  const receipt = JSON.parse(await fs.readFile(path.join(h.directory, `${requestId}.json`), 'utf8'));
  assert.equal(receipt.state, 'submitting');
  assert.equal(h.client.data['Счета продавцов'][1][7], true, 'Wrong archive readback is not accepted');
});

test('an uncertain absent document row globally blocks new seller/document writes until its delayed POST is reconciled', async t => {
  const h = await harness(t);
  const input = await h.input();
  let delayed;
  h.client.failWrite = async (updates, phase) => {
    if (phase === 'before' && updates.some(write => write.values[0][8] === 'prepared')) {
      delayed = structuredClone(updates);
      throw new Error('Synthetic timed-out POST remains in flight');
    }
  };
  await assert.rejects(h.store.create(h.board.orders[0].id, input), errorCode('DOCUMENT_UNCONFIRMED'));
  assert.equal(h.client.documents().length, 0);
  h.client.failWrite = null;
  h.reopen();
  const writes = h.client.writes.length;
  await assert.rejects(h.store.create(h.board.orders[0].id, await h.input({ number: 'TEST-002' })), errorCode('DOCUMENT_PENDING'));
  await assert.rejects(h.store.saveSeller({ requestId: uuid(), seller: { ...h.seller, label: 'Do not reserve while POST may arrive' } }), errorCode('DOCUMENT_PENDING'));
  await assert.rejects(h.store.create(h.board.orders[0].id, input), errorCode('DOCUMENT_UNCONFIRMED'));
  assert.equal(h.client.writes.length, writes);
  assert.equal(h.renders.length, 0);
  await h.client.updateValues(delayed, { valueInputOption: 'RAW' });
  const recovered = await h.store.create(h.board.orders[0].id, input);
  assert.equal(recovered.state, 'confirmed');
  assert.equal(h.client.documents().length, 1);
  assert.equal(h.client.documents()[0][14], input.requestId, 'Late request retains ownership of its reserved row');
  const next = await h.store.create(h.board.orders[0].id, await h.input({ number: 'TEST-002' }));
  assert.equal(next.document.version, 2);
  assert.equal(h.client.documents()[0][0], recovered.document.id);
  assert.equal(h.mediaState.addCount, 2);
});

test('an uncertain seller batch locks document and seller reservations across restart until full recovery', async t => {
  const h = await harness(t);
  const requestId = uuid();
  const payload = { ...h.seller, label: 'Изменённый учебный продавец' };
  let delayed;
  h.client.failWrite = async (updates, phase) => {
    if (phase === 'before' && updates.some(write => write.range.startsWith("'Продавцы'!"))) {
      delayed = structuredClone(updates); throw new Error('Synthetic seller POST is still in flight');
    }
  };
  await assert.rejects(h.store.saveSeller({ requestId, seller: payload }), errorCode('DOCUMENT_UNCONFIRMED'));
  h.client.failWrite = null; h.reopen();
  const writes = h.client.writes.length;
  await assert.rejects(h.store.create(h.board.orders[0].id, await h.input()), errorCode('DOCUMENT_PENDING'));
  await assert.rejects(h.store.saveSeller({ requestId: uuid(), seller: { ...h.seller, label: 'Другой запрос' } }), errorCode('DOCUMENT_PENDING'));
  await assert.rejects(h.store.saveSeller({ requestId, seller: payload }), errorCode('DOCUMENT_UNCONFIRMED'));
  assert.equal(h.client.writes.length, writes);
  await h.client.updateValues(delayed, { valueInputOption: 'RAW' });
  const recovered = await h.store.saveSeller({ requestId, seller: payload });
  assert.equal(recovered.state, 'confirmed');
  const result = await h.store.create(h.board.orders[0].id, await h.input({ expectedSellerRevision: recovered.seller.revision }));
  assert.equal(result.state, 'confirmed');
});

test('canonical buyer without a legal name cannot borrow the contact display company after ambiguous source text', () => {
  const source = orderFixture();
  source.contacts[0].edit.fields.find(field => field.id === 'companyName').value = 'ООО «Display name is not confirmed legal identity»';
  source.contacts[0].edit.fields.find(field => field.id === 'requisites').value = `--- Реквизиты для документов ---\nИНН: ${BUYER_INN}\nЮридический адрес: Учебный адрес\n\n--- Исходный текст клиента ---\nООО «Первое учебное лицо»\nООО «Второе учебное лицо»`;
  const prepared = prepareOrderDocument(source);
  assert.equal(prepared.buyer.name, '');
  assert.equal(prepared.ready, false);
});

test('UPD completion requires final order status and canonical terminal installations while ignoring historical legacy flags', () => {
  const legacy = [{ name: 'Монтаж', done: false }];
  assert.equal(prepareOrderDocument(orderFixture({ status: 'Монтаж', installations: [], production: legacy })).completed, false);
  assert.equal(prepareOrderDocument(orderFixture({ status: 'Готов к выдаче', installations: [], production: legacy })).completed, false);
  assert.equal(prepareOrderDocument(orderFixture({ status: 'Сдан', installations: [], production: legacy })).completed, true);
  assert.equal(prepareOrderDocument(orderFixture({ status: 'Сдан', installations: [{ status: 'Запланирован' }], production: legacy })).completed, false);
  assert.equal(prepareOrderDocument(orderFixture({ status: 'Сдан', installations: [{ status: 'Завершён' }], production: legacy })).completed, true);
  assert.equal(prepareOrderDocument(orderFixture({ status: 'Сдан', installations: [{ status: '' }] })).completed, false);
});

test('unresolved seller import metadata cannot be bypassed through a direct save or issuance API call', async t => {
  for (const unresolvedFields of [['name'], ['account:11111111-1111-4111-8111-111111111111:bik'], 'name']) {
    assert.throws(() => normalizeDocumentSeller(sellerFixture({ source: { unresolvedFields } }), uuid()), errorCode('DOCUMENT_SELLER_INVALID'));
  }
  assert.deepEqual(normalizeDocumentSeller(sellerFixture({ source: { unresolvedFields: [] } }), uuid()).source.unresolvedFields, []);
  const h = await harness(t);
  await assert.rejects(h.store.saveSeller({ requestId: uuid(), seller: { ...h.seller, source: { unresolvedFields: ['inn'] } } }), errorCode('DOCUMENT_SELLER_INVALID'));
  h.client.data['Продавцы'][1][13] = JSON.stringify({ unresolvedFields: ['name'] });
  const prepared = await h.store.prepare(h.board.orders[0].id);
  await assert.rejects(h.store.create(h.board.orders[0].id, await h.input({ expectedSellerRevision: prepared.sellerItems[0].revision })), errorCode('DOCUMENT_SELLER_INVALID'));
  assert.equal(h.client.documents().length, 0);
});

test('fresh fingerprints do not authorize invalid seller or selected bank formats manually entered in Google', async t => {
  for (const [table, column, value, expected] of [
    ['Продавцы', 3, '123', 'DOCUMENT_SELLER_INVALID'],
    ['Счета продавцов', 4, '123', 'DOCUMENT_ACCOUNT_INVALID'],
    ['Счета продавцов', 5, '123', 'DOCUMENT_ACCOUNT_INVALID'],
    ['Счета продавцов', 6, '', 'DOCUMENT_ACCOUNT_INVALID'],
    ['Счета продавцов', 3, 123, 'DOCUMENT_ACCOUNT_INVALID'],
  ]) {
    const h = await harness(t);
    h.client.data[table][1][column] = value;
    const prepared = await h.store.prepare(h.board.orders[0].id);
    const writes = h.client.writes.length;
    await assert.rejects(h.store.create(h.board.orders[0].id, await h.input({ expectedSellerRevision: prepared.sellerItems[0].revision })), errorCode(expected));
    assert.equal(h.client.writes.length, writes);
    assert.equal(h.client.documents().length, 0);
    assert.equal(h.renders.length, 0);
  }
});

test('receipt file sync failure prevents the remote reservation and removes the incomplete temporary file', async t => {
  const h = await harness(t);
  const input = await h.input();
  const writes = h.client.writes.length;
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', async (filename, flags, ...options) => {
    const handle = await originalOpen.call(fs, filename, flags, ...options);
    if (String(filename).includes(`${input.requestId}.json.tmp-`)) handle.sync = async () => { throw Object.assign(new Error('Synthetic receipt sync failure'), { code: 'EIO' }); };
    return handle;
  });
  await assert.rejects(h.store.create(h.board.orders[0].id, input), { code: 'EIO' });
  assert.equal(h.client.writes.length, writes);
  assert.equal(h.client.documents().length, 0);
  assert.equal(h.renders.length, 0);
  assert.ok(!(await fs.readdir(h.directory)).some(filename => filename.startsWith(input.requestId)), 'No incomplete receipt is published');
});

test('receipt directory sync failure is not ignored before submitting a remote write', async t => {
  const h = await harness(t);
  const input = await h.input();
  const writes = h.client.writes.length;
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', async (filename, flags, ...options) => {
    if (filename === h.directory && flags === 'r') throw Object.assign(new Error('Synthetic directory durability failure'), { code: 'EIO' });
    return originalOpen.call(fs, filename, flags, ...options);
  });
  await assert.rejects(h.store.create(h.board.orders[0].id, input), { code: 'EIO' });
  assert.equal(h.client.writes.length, writes);
  assert.equal(h.client.documents().length, 0);
  assert.equal(h.renders.length, 0);
  const receipt = JSON.parse(await fs.readFile(path.join(h.directory, `${input.requestId}.json`), 'utf8'));
  assert.equal(receipt.state, 'submitting', 'Any published reservation remains conservative until reconciled');
});

test('prepared document recovery refuses a changed snapshot or reservation before rendering or attaching any file', async t => {
  for (const corrupt of [
    row => { const snapshot = JSON.parse(row[9]); snapshot.buyer.name = 'Unexpected fictional buyer'; row[9] = JSON.stringify(snapshot); },
    row => { const snapshot = JSON.parse(row[9]); snapshot.bank.bank = 'Unexpected fictional bank'; row[9] = JSON.stringify(snapshot); row[10] = digest(row[9]); },
    row => { row[0] = uuid(); },
    row => { row[7] = 99; },
  ]) {
    const h = await harness(t);
    const input = await h.input();
    h.client.failWrite = async (updates, phase) => {
      if (phase === 'after' && updates.some(write => write.values[0][8] === 'prepared')) corrupt(h.client.documents()[0]);
    };
    await assert.rejects(h.store.create(h.board.orders[0].id, input), errorCode('DOCUMENT_UNCONFIRMED'));
    const receipt = JSON.parse(await fs.readFile(path.join(h.directory, `${input.requestId}.json`), 'utf8'));
    assert.match(receipt.snapshotHash, /^[a-f0-9]{64}$/);
    assert.match(receipt.preparedRowHash, /^[a-f0-9]{64}$/);
    h.client.failWrite = null; h.reopen();
    const writes = h.client.writes.length;
    await assert.rejects(h.store.create(h.board.orders[0].id, input), errorCode('DOCUMENT_SNAPSHOT_CONFLICT'));
    assert.equal(h.client.writes.length, writes);
    assert.equal(h.renders.length, 0);
    assert.equal(h.mediaState.addCount, 0);
    assert.equal(h.client.documents().length, 1);
  }
});
