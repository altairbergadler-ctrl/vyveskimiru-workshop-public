import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createRequestHandler } from './index.mjs';
import { OrderError } from './orders.mjs';

const origin = 'https://documents.example.invalid';
const headers = { Origin: origin, 'Content-Type': 'application/json' };
const requestId = '00000000-0000-4000-8000-000000000001';
const sellerInput = { requestId, seller: { id: '00000000-0000-4000-8000-000000000002', label: 'Учебная организация' } };
const documentInput = { requestId, type: 'invoice', number: 'Учебный-001', date: '2026-10-21', sellerId: sellerInput.seller.id, accountId: '00000000-0000-4000-8000-000000000003', amountDue: 1200, test: true, expectedSourceHash: 'source-hash', expectedSellerRevision: 'seller-revision' };
const result = () => ({ state: 'confirmed', document: { id: 'fictional-document', version: 1 }, media: { id: 'fictional/file ?', name: 'Учебный счёт.pdf', kind: 'document', contentType: 'application/pdf', generatedDocument: { type: 'invoice', number: 'Учебный-001', version: 1, test: true } } });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function app(t, overrides = {}) {
  const calls = [], audits = [], received = [];
  const documentsService = {
    sellers: async input => { calls.push(['sellers', input]); return { items: [{ id: sellerInput.seller.id, label: 'Учебная организация' }], ready: true }; },
    saveSeller: async input => { calls.push(['saveSeller', input]); return { state: 'confirmed', seller: input.seller }; },
    prepare: async id => { calls.push(['prepare', id]); return { orderId: id, ready: true, items: [], total: 1200 }; },
    create: async (id, input) => { calls.push(['create', id, input]); return result(); },
    ...overrides.documentsService,
  };
  const { documentsService: ignored, ...options } = overrides;
  void ignored;
  const handler = createRequestHandler({
    client: { configured: true }, origin, documentsService,
    authImpl: async () => ({ response: Response.json({}), value: { authenticated: true } }),
    onAudit: value => audits.push(value), ...options,
  });
  const server = http.createServer(handler);
  server.on('request', request => received.push(request.method + ' ' + request.url));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  return { calls, audits, received, request: (url, options) => fetch(base + url, options), post: (url, input, extraHeaders = {}) => fetch(base + url, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(input) }) };
}

test('document endpoints reject unauthenticated reads and writes before calling the service', async t => {
  const server = await app(t, { authImpl: async () => ({ response: Response.json({}), value: { authenticated: false } }) });
  for (const url of ['/kanban/api/document-sellers', '/kanban/api/orders/001/documents/prepare?type=invoice']) assert.equal((await server.request(url)).status, 401);
  for (const [url, input] of [['/kanban/api/document-sellers', sellerInput], ['/kanban/api/orders/001/documents', documentInput]]) assert.equal((await server.post(url, input)).status, 401);
  assert.deepEqual(server.calls, []);
});

test('cross-origin and cross-site document mutations are rejected before authentication or service access', async t => {
  let authenticated = 0;
  const server = await app(t, { authImpl: async () => { authenticated++; return { response: Response.json({}), value: { authenticated: true } }; } });
  for (const url of ['/kanban/api/document-sellers', '/kanban/api/orders/001/documents']) {
    assert.equal((await server.post(url, documentInput, { Origin: 'https://foreign.example.invalid' })).status, 403);
    assert.equal((await server.post(url, documentInput, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await server.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  }
  assert.equal(authenticated, 0);
  assert.deepEqual(server.calls, []);
});

test('seller archive option and URL-decoded order ID preserve their exact route values', async t => {
  const server = await app(t);
  assert.equal((await server.request('/kanban/api/document-sellers')).status, 200);
  assert.equal((await server.request('/kanban/api/document-sellers?includeArchived=1')).status, 200);
  const prepared = await server.request('/kanban/api/orders/%30%30%31/documents/prepare?type=invoice');
  assert.equal(prepared.status, 200);
  assert.equal((await prepared.json()).orderId, '001');
  assert.deepEqual(server.calls, [['sellers', { includeArchived: false }], ['sellers', { includeArchived: true }], ['prepare', '001']]);
});

test('seller and document writes share the existing serialized mutation path and reads wait for them', async t => {
  const sellerStarted = deferred(), releaseSeller = deferred();
  let active = 0, maximum = 0, documentStarted = false, readStarted = false;
  const server = await app(t, { documentsService: {
    saveSeller: async input => { active++; maximum = Math.max(maximum, active); sellerStarted.resolve(); await releaseSeller.promise; active--; return { state: 'confirmed', seller: input.seller }; },
    create: async () => { documentStarted = true; active++; maximum = Math.max(maximum, active); await delay(5); active--; return result(); },
    sellers: async () => { readStarted = true; return { items: [], ready: true }; },
  } });
  const writeSeller = server.post('/kanban/api/document-sellers', sellerInput);
  await sellerStarted.promise;
  const writeDocument = server.post('/kanban/api/orders/001/documents', documentInput);
  const read = server.request('/kanban/api/document-sellers');
  for (let attempt = 0; server.received.length < 3 && attempt < 100; attempt++) await delay(2);
  await delay(0);
  assert.equal(server.received.length, 3);
  assert.equal(documentStarted, false);
  assert.equal(readStarted, false);
  releaseSeller.resolve();
  for (const response of await Promise.all([writeSeller, writeDocument, read])) assert.equal(response.status, 200);
  assert.equal(documentStarted, true);
  assert.equal(readStarted, true);
  assert.equal(maximum, 1);
});

test('stamp render and download stay outside the writer while reservation and Files publish use it',async t=>{
  let inside=false;const started=deferred(),release=deferred(),downloaded=deferred(),releaseDownload=deferred();let wrote=0;
  const documentId='00000000-0000-4000-8000-000000000009';const route=`/kanban/api/orders/001/documents/${documentId}/stamps`;
  const stamps={
    library:async()=>{assert.equal(inside,false);return {version:1,stamps:[],signatures:[]};},
    reserve:async()=>{assert.equal(inside,true);},
    start:async()=>{assert.equal(inside,false);started.resolve();await release.promise;return {state:'processing'};},
    status:async()=>({state:'completed'}),
    download:async()=>{assert.equal(inside,false);downloaded.resolve();await releaseDownload.promise;return {operationId:requestId,files:[]};},
    publish:async()=>{assert.equal(inside,true);return {state:'confirmed',media:{items:[{id:'private-pdf'}]}};},
  };
  const server=await app(t,{documentStampsService:stamps,documentStampCommand:async action=>{assert.equal(inside,false);inside=true;try{return await action();}finally{inside=false;}},documentsService:{create:async()=>{wrote++;return result();}}});
  const processing=server.post(route,{requestId,expectedSellerRevision:'a'.repeat(64)});await started.promise;
  assert.equal((await server.post('/kanban/api/orders/001/documents',documentInput)).status,200);assert.equal(wrote,1);release.resolve();assert.equal((await processing).status,200);
  const importing=server.post(route+'/'+requestId+'/files',{});await downloaded.promise;
  assert.equal((await server.post('/kanban/api/orders/001/documents',documentInput)).status,200);assert.equal(wrote,2);releaseDownload.resolve();
  const published=await importing;assert.equal(published.status,200);assert.equal((await published.json()).media.items[0].url,'/kanban/api/orders/001/media/private-pdf');
});

test('stamp library, request status and mutations keep common owner auth and origin protection',async t=>{
  const documentId='00000000-0000-4000-8000-000000000009',route=`/kanban/api/orders/001/documents/${documentId}/stamps`;
  const stamps=new Proxy({},{get:()=>()=>{throw new Error('must not call without owner');}});
  const server=await app(t,{documentStampsService:stamps,authImpl:async()=>({response:Response.json({}),value:{authenticated:false}})});
  for(const url of ['/kanban/api/document-stamp-library',route+'/'+requestId])assert.equal((await server.request(url)).status,401);
  for(const url of [route,route+'/'+requestId+'/files']){assert.equal((await server.post(url,{})).status,401);assert.equal((await server.post(url,{}, {Origin:'https://foreign.invalid'})).status,403);}
});

test('repeated request IDs reach service unchanged and returned PDF links stay in the private order route', async t => {
  const saved = new Map(), inputs = [];
  const server = await app(t, { documentsService: { create: async (id, input) => { inputs.push({ id, input }); if (!saved.has(input.requestId)) saved.set(input.requestId, result()); return saved.get(input.requestId); } } });
  const first = await server.post('/kanban/api/orders/%30%30%31/documents', documentInput);
  const second = await server.post('/kanban/api/orders/001/documents', documentInput);
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  const value = await first.json(); assert.deepEqual(await second.json(), value);
  assert.deepEqual(inputs, [{ id: '001', input: documentInput }, { id: '001', input: documentInput }]);
  assert.equal(saved.size, 1);
  assert.equal(value.media.url, '/kanban/api/orders/001/media/fictional%2Ffile%20%3F');
  assert.equal(value.media.downloadUrl, value.media.url + '?download=1');
  assert.match(first.headers.get('cache-control'), /no-store/);
  assert.equal(value.media.generatedDocument.test, true);
  assert.equal(server.audits.length, 2);
  for (const audit of server.audits) assert.deepEqual(Object.keys(audit).sort(), ['at', 'event']);
});

test('invalid JSON shape never reaches service and domain errors do not expose unexpected exception details', async t => {
  let rejected = 0;
  const server = await app(t, { documentsService: { saveSeller: async input => {
    rejected++;
    if (input.unknown) throw new OrderError('DOCUMENT_SELLER_INVALID', 'Проверьте поля юрлица.', 422);
    throw new Error('PRIVATE_FAKE_TOKEN_AND_INTERNAL_DETAILS');
  } } });
  for (const body of ['null', '[]', '123', '{invalid']) {
    const response = await server.request('/kanban/api/document-sellers', { method: 'POST', headers, body });
    assert.equal(response.status, 400);
  }
  assert.equal((await server.request('/kanban/api/orders/001/documents', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal(rejected, 0);
  const unknown = await server.post('/kanban/api/document-sellers', { unknown: true });
  assert.equal(unknown.status, 422); assert.equal((await unknown.json()).code, 'DOCUMENT_SELLER_INVALID');
  const unexpected = await server.post('/kanban/api/document-sellers', sellerInput);
  assert.equal(unexpected.status, 502); assert.ok(!(await unexpected.text()).includes('PRIVATE_FAKE'));
  assert.equal(rejected, 2);
  assert.deepEqual(server.audits, []);
});

test('document JS assets are public static code with correct MIME and no API authentication', async t => {
  let authenticationCalls = 0;
  const server = await app(t, { authImpl: async () => { authenticationCalls++; return { response: Response.json({}), value: { authenticated: false } }; } });
  for (const name of ['documents', 'requisites']) {
    const response = await server.request('/kanban/' + name + '.js?v=fictional-release');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.ok((await response.text()).includes('export '));
    const head = await server.request('/kanban/' + name + '.js', { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
  }
  assert.equal(authenticationCalls, 0);
  assert.deepEqual(server.calls, []);
});
