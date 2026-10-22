import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createAppServer } from './index.mjs';

const origin = 'https://kanban.test';
const board = { statuses: ['Новый', 'В работе'], orders: [{ id: '42', status: 'Новый' }] };
const authResponse = (authenticated = true, status = 200) => Response.json({ authenticated }, { status });
const mutationHeaders = { Origin: origin, 'Content-Type': 'application/json' };
const statusInput = { status: 'В работе', expectedStatus: 'Новый' };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function app(t, overrides = {}) {
  const server = createAppServer({
    client: { configured: true },
    origin,
    authUrl: 'http://auth.test/api/session',
    authOrigin: origin,
    fetchImpl: async () => authResponse(),
    readBoardImpl: async () => board,
    moveOrderImpl: async () => undefined,
    clientCreationFormImpl: async () => ({ fields: [] }),
    createClientImpl: async (_client, input) => ({ id: 'К-011', name: input.changes.companyName || 'Новый клиент' }),
    clientCreationDirectory: 'private-client-directory',
    onAudit: () => undefined,
    ...overrides,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = `http://127.0.0.1:${server.address().port}`;
  return {
    address,
    get: (suffix = '/kanban/api/board', options) => fetch(address + suffix, options),
    patch: (id = '42', input = statusInput, headers = mutationHeaders) => fetch(`${address}/kanban/api/orders/${id}/status`, {
      method: 'PATCH', headers, body: JSON.stringify(input),
    }),
  };
}

test('unauthenticated reads and status changes never reach the board source', async (t) => {
  let sourceCalls = 0;
  const server = await app(t, {
    fetchImpl: async () => authResponse(false),
    readBoardImpl: async () => { sourceCalls++; return board; },
    moveOrderImpl: async () => { sourceCalls++; },
  });
  for (const response of [await server.get(), await server.patch()]) {
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Требуется вход' });
  }
  assert.equal(sourceCalls, 0);
});

test('creation form and writes require authentication and same-origin requests', async (t) => {
  let calls = 0;
  const server = await app(t, {
    fetchImpl: async () => authResponse(false),
    orderCreationFormImpl: async () => { calls++; },
    createOrderImpl: async () => { calls++; },
    clientCreationFormImpl: async () => { calls++; },
    createClientImpl: async () => { calls++; },
  });
  assert.equal((await server.get('/kanban/api/orders/new')).status, 401);
  assert.equal((await server.get('/kanban/api/clients/new')).status, 401);
  const request = { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ requestId: '2c312c44-b0ac-4bb7-a9b5-cbde02a7ec50', changes: { title: 'Вывеска' } }) };
  assert.equal((await server.get('/kanban/api/orders', request)).status, 401);
  assert.equal((await server.get('/kanban/api/orders', { ...request, headers: { ...mutationHeaders, Origin: 'https://foreign.test' } })).status, 403);
  assert.equal((await server.get('/kanban/api/clients', request)).status, 401);
  assert.equal((await server.get('/kanban/api/clients', { ...request, headers: { ...mutationHeaders, Origin: 'https://foreign.test' } })).status, 403);
  assert.equal(calls, 0);
});

test('client creation form and write use the configured source, journal and PII-free audit', async (t) => {
  const client = { configured: true };
  const form = { fields: [{ id: 'companyName', label: 'Название / ФИО клиента', required: true }] };
  const audits = [];
  let formClient;
  let observed;
  const server = await app(t, {
    client,
    clientCreationDirectory: 'private-client-journal',
    clientCreationFormImpl: async (source) => { formClient = source; return form; },
    createClientImpl: async (source, input, options) => {
      observed = { source, input, options };
      return { id: 'К-011', name: input.changes.companyName, changed: true };
    },
    onAudit: (entry) => audits.push(entry),
  });

  assert.deepEqual(await (await server.get('/kanban/api/clients/new')).json(), form);
  assert.equal(formClient, client);

  const input = {
    requestId: '2c312c44-b0ac-4bb7-a9b5-cbde02a7ec50',
    changes: { companyName: 'Тестовый клиент', phone: '+7 900 000-00-00', email: 'private@example.test' },
  };
  const response = await server.get('/kanban/api/clients', {
    method: 'POST', headers: mutationHeaders, body: JSON.stringify(input),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: 'К-011', name: input.changes.companyName, created: true });
  assert.deepEqual(observed, { source: client, input, options: { journalDir: 'private-client-journal' } });
  assert.equal(audits.length, 1);
  assert.deepEqual(Object.keys(audits[0]).sort(), ['at', 'event', 'id']);
  assert.equal(audits[0].event, 'client_created');
  assert.equal(audits[0].id, 'К-011');
  assert.match(audits[0].at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(JSON.stringify(audits).includes(input.changes.companyName), false);
  assert.equal(JSON.stringify(audits).includes(input.changes.phone), false);
  assert.equal(JSON.stringify(audits).includes(input.changes.email), false);
});

test('client creation rejects malformed request envelopes before touching the source', async (t) => {
  let calls = 0;
  const server = await app(t, { createClientImpl: async () => { calls++; } });
  const requestId = '2c312c44-b0ac-4bb7-a9b5-cbde02a7ec50';
  for (const input of [{}, { requestId: 'bad', changes: {} }, { requestId, changes: [] }, { requestId, changes: {}, id: 'К-011' }]) {
    const response = await server.get('/kanban/api/clients', {
      method: 'POST', headers: mutationHeaders, body: JSON.stringify(input),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Проверьте поля нового клиента.' });
  }
  assert.equal(calls, 0);
});

test('order creation returns fresh source data and new card id through the write queue', async (t) => {
  const gate = deferred();
  const began = deferred();
  let completed = false;
  let formRead = false;
  let observed;
  const result = { fields: [{ id: 'title', required: true }], initialStatus: 'Расчёт / КП' };
  const server = await app(t, {
    creationDirectory: 'private-test-directory',
    createOrderImpl: async (_client, input, options) => { observed = { input, options }; began.resolve(); await gate.promise; completed = true; return { id: '43' }; },
    orderCreationFormImpl: async () => { formRead = true; return result; },
    readBoardImpl: async () => ({ ...board, orders: completed ? [...board.orders, { id: '43', status: 'Расчёт / КП' }] : board.orders }),
  });
  await server.get();
  const input = { requestId: '2c312c44-b0ac-4bb7-a9b5-cbde02a7ec50', changes: { title: 'Вывеска' } };
  const creation = server.get('/kanban/api/orders', { method: 'POST', headers: mutationHeaders, body: JSON.stringify(input) });
  await began.promise;
  const form = server.get('/kanban/api/orders/new');
  await delay(20);
  assert.equal(formRead, false, 'form reads wait for pending source writes');
  gate.resolve();
  const response = await creation;
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.createdOrderId, '43');
  assert.equal(value.orders.length, 2);
  assert.deepEqual(observed, { input, options: { journalDir: 'private-test-directory' } });
  assert.deepEqual(await (await form).json(), result);
  assert.equal((await (await server.get()).json()).orders.length, 2);
});

test('creation rejects malformed input and returns safe recovery codes', async (t) => {
  let calls = 0;
  const server = await app(t, { createOrderImpl: async () => { calls++; throw Object.assign(new Error('Проверьте результат создания.'), { name: 'OrderError', statusCode: 409, code: 'CREATE_UNCONFIRMED' }); } });
  for (const input of [{}, { requestId: 'bad', changes: {} }, { requestId: '2c312c44-b0ac-4bb7-a9b5-cbde02a7ec50', changes: [] }, { requestId: '2c312c44-b0ac-4bb7-a9b5-cbde02a7ec50', changes: {}, id: '1' }]) {
    assert.equal((await server.get('/kanban/api/orders', { method: 'POST', headers: mutationHeaders, body: JSON.stringify(input) })).status, 400);
  }
  assert.equal(calls, 0);
  const response = await server.get('/kanban/api/orders', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ requestId: '2c312c44-b0ac-4bb7-a9b5-cbde02a7ec50', changes: { title: 'Вывеска' } }) });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'Проверьте результат создания.', code: 'CREATE_UNCONFIRMED' });
});

test('a post-create board failure is always uncertain even if the source error was a 422', async (t) => {
  const server = await app(t, {
    createOrderImpl: async () => ({ id: '43' }),
    readBoardImpl: async () => { throw Object.assign(new Error('changed headers'), { name: 'OrderError', code: 'SHEET_HEADERS', statusCode: 422 }); },
  });
  const response = await server.get('/kanban/api/orders', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ requestId: '2c312c44-b0ac-4bb7-a9b5-cbde02a7ec50', changes: { title: 'Вывеска' } }) });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'ORDER_CREATE_UNCONFIRMED');
});

test('position form and creation bind to the URL order and return a fresh board', async (t) => {
  const form = { orderId: '42', units: ['шт'], templates: [{ id: 'street', name: 'Уличная вывеска', stages: [] }] };
  const created = { itemRow: 19, routeStageCount: 8, product: 'Уличная вывеска', changed: true };
  const calls = [];
  let current = board;
  const server = await app(t, {
    positionCreationDirectory: 'private-position-directory',
    positionCreationFormImpl: async (_client, input) => { calls.push(['form', input]); return form; },
    createPositionImpl: async (_client, input, options) => {
      calls.push(['create', input, options]);
      current = { ...board, orders: [{ ...board.orders[0], positions: [{ name: created.product }] }] };
      return created;
    },
    readBoardImpl: async () => current,
  });
  assert.deepEqual(await (await server.get('/kanban/api/orders/42/positions/new')).json(), form);
  const input = { requestId: '2c312c44-b0ac-4bb7-a9b5-cbde02a7ec50', position: { template: 'street', description: 'Фасад', unit: 'шт', quantity: 1 }, orderId: '99' };
  const response = await server.get('/kanban/api/orders/42/positions', {
    method: 'POST', headers: mutationHeaders, body: JSON.stringify(input),
  });
  assert.equal(response.status, 400, 'unknown top-level fields are rejected');
  delete input.orderId;
  const saved = await server.get('/kanban/api/orders/42/positions', {
    method: 'POST', headers: mutationHeaders, body: JSON.stringify(input),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { ...current, createdPosition: created });
  assert.deepEqual(calls, [
    ['form', { orderId: '42' }],
    ['create', { ...input, orderId: '42' }, { journalDir: 'private-position-directory' }],
  ]);
});

test('position endpoints enforce authentication and same-origin writes before touching the source', async (t) => {
  let calls = 0;
  const server = await app(t, {
    fetchImpl: async () => authResponse(false),
    positionCreationFormImpl: async () => { calls++; },
    createPositionImpl: async () => { calls++; },
    deletePositionImpl: async () => { calls++; },
  });
  const input = { requestId: '2c312c44-b0ac-4bb7-a9b5-cbde02a7ec50', position: {} };
  assert.equal((await server.get('/kanban/api/orders/42/positions/new')).status, 401);
  assert.equal((await server.get('/kanban/api/orders/42/positions', { method: 'POST', headers: mutationHeaders, body: JSON.stringify(input) })).status, 401);
  assert.equal((await server.get('/kanban/api/orders/42/positions', {
    method: 'POST', headers: { ...mutationHeaders, Origin: 'https://foreign.test' }, body: JSON.stringify(input),
  })).status, 403);
  assert.equal(calls, 0);
  assert.equal((await server.get('/kanban/api/orders/42/positions',{method:'DELETE',headers:mutationHeaders,body:JSON.stringify({requestId:input.requestId,record:{}})})).status,401);
  assert.equal((await server.get('/kanban/api/orders/42/positions',{method:'DELETE',headers:{...mutationHeaders,Origin:'https://foreign.test'},body:JSON.stringify({requestId:input.requestId,record:{}})})).status,403);
  assert.equal(calls,0);
});

test('position deletion binds the URL order, passes a stable receipt and returns refreshed board',async t=>{
  const calls=[],removed={itemRow:5,product:'Баннер',changed:true};
  const server=await app(t,{deletePositionImpl:async(_client,input,options)=>{calls.push({input,options});return removed;},positionCreationDirectory:'private-position-directory'});
  const input={requestId:'2c312c44-b0ac-4bb7-a9b5-cbde02a7ec50',record:{sheet:'Позиции',rowNumber:5,key:'key',revision:'revision'}};
  const denied=await server.get('/kanban/api/orders/42/positions',{method:'DELETE',headers:mutationHeaders,body:JSON.stringify({...input,orderId:'99'})});assert.equal(denied.status,400);assert.equal(calls.length,0);
  const response=await server.get('/kanban/api/orders/42/positions',{method:'DELETE',headers:mutationHeaders,body:JSON.stringify(input)});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{...board,deletedPosition:removed});
  assert.deepEqual(calls,[{input:{...input,orderId:'42'},options:{journalDir:'private-position-directory'}}]);
});

test('an auth outage or invalid auth response fails closed', async (t) => {
  const failures = [
    async () => { throw new Error('private upstream auth failure'); },
    async () => authResponse(true, 503),
    async () => new Response('not json', { status: 200 }),
  ];
  for (const fetchImpl of failures) {
    await t.test(fetchImpl === failures[0] ? 'network failure' : fetchImpl === failures[1] ? 'non-success status' : 'invalid response', async (subtest) => {
      let sourceCalls = 0;
      const server = await app(subtest, {
        fetchImpl,
        readBoardImpl: async () => { sourceCalls++; return board; },
        moveOrderImpl: async () => { sourceCalls++; },
      });
      for (const response of [await server.get(), await server.patch()]) {
        assert.equal(response.status, 503);
        assert.equal((await response.json()).error, 'Не удалось проверить вход. Повторите попытку.');
      }
      assert.equal(sourceCalls, 0);
    });
  }
});

test('status changes reject absent, foreign, or cross-site origins before auth', async (t) => {
  let authCalls = 0;
  const server = await app(t, { fetchImpl: async () => { authCalls++; return authResponse(); } });
  const forbidden = [
    { 'Content-Type': 'application/json' },
    { ...mutationHeaders, Origin: 'https://foreign.test' },
    { ...mutationHeaders, 'Sec-Fetch-Site': 'cross-site' },
  ];
  for (const headers of forbidden) {
    const response = await server.patch('42', statusInput, headers);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'Недопустимый источник запроса' });
  }
  assert.equal(authCalls, 0);
});

test('session proxy forwards only the PIN and returns a safe response shape', async (t) => {
  const forwarded = [];
  const testPin = 'integration-test-pin';
  const testCookie = 'finance_session=integration-test-session; Path=/; HttpOnly; SameSite=Strict; Secure';
  const server = await app(t, {
    fetchImpl: async (url, options) => {
      forwarded.push({ url, options });
      return Response.json({ authenticated: true, pin: testPin, internal: 'private source detail' }, {
        headers: { 'Set-Cookie': testCookie },
      });
    },
  });
  const response = await server.get('/kanban/api/session', {
    method: 'POST',
    headers: { ...mutationHeaders, Cookie: 'finance_session=old-test-session' },
    body: JSON.stringify({ pin: testPin, authenticated: true, role: 'admin' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: true });
  assert.equal(response.headers.get('set-cookie'), testCookie);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].url, 'http://auth.test/api/session');
  assert.equal(forwarded[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(forwarded[0].options.body), { pin: testPin });
  assert.equal(forwarded[0].options.headers.Cookie, 'finance_session=old-test-session');
  assert.equal(forwarded[0].options.headers.Origin, 'http://auth.test');
  assert.equal(Object.hasOwn(forwarded[0].options.headers, 'Host'), false);
  assert.equal(forwarded[0].options.redirect, 'error');
  assert.match(response.headers.get('cache-control'), /no-store/);
});

test('real HTTP login/logout match the auth target Origin while external CSRF checks remain strict', async (t) => {
  const seen = [];
  let authenticated = false;
  const upstream = http.createServer(async (request, response) => {
    seen.push({ method: request.method, host: request.headers.host, origin: request.headers.origin });
    response.setHeader('Content-Type', 'application/json');
    if (new URL(request.headers.origin).host !== request.headers.host) {
      response.writeHead(403);
      response.end(JSON.stringify({ error: 'Origin mismatch' }));
      return;
    }
    if (request.method === 'POST') {
      const parts = [];
      for await (const part of request) parts.push(part);
      const input = JSON.parse(Buffer.concat(parts).toString('utf8'));
      authenticated = input.pin === 'integration-test-pin';
    } else if (request.method === 'DELETE') authenticated = false;
    response.end(JSON.stringify({ authenticated }));
  });
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    upstream.closeAllConnections();
    upstream.close(error => error ? reject(error) : resolve());
  }));
  const target = `http://127.0.0.1:${upstream.address().port}`;
  const server = await app(t, { authUrl: `${target}/api/session`, authOrigin: origin, fetchImpl: fetch });
  const login = await server.get('/kanban/api/session', {
    method: 'POST', headers: mutationHeaders, body: JSON.stringify({ pin: 'integration-test-pin' }),
  });
  assert.equal(login.status, 200);
  assert.deepEqual(await login.json(), { authenticated: true });
  assert.deepEqual(await (await server.get('/kanban/api/session')).json(), { authenticated: true });

  const attemptsBefore = seen.length;
  for (const headers of [
    { ...mutationHeaders, Origin: target },
    { ...mutationHeaders, 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    const forbidden = await server.get('/kanban/api/session', {
      method: 'POST', headers, body: JSON.stringify({ pin: 'integration-test-pin' }),
    });
    assert.equal(forbidden.status, 403);
  }
  assert.equal(seen.length, attemptsBefore);

  const logout = await server.get('/kanban/api/session', { method: 'DELETE', headers: { Origin: origin } });
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { authenticated: false });
  assert.deepEqual(seen, ['POST', 'GET', 'DELETE'].map(method => ({ method, host: new URL(target).host, origin: target })));
});

test('login failures do not reflect upstream response contents or PIN', async (t) => {
  const server = await app(t, {
    fetchImpl: async () => Response.json({ authenticated: false, error: 'private source detail', pin: 'integration-test-pin' }, { status: 401 }),
  });
  const response = await server.get('/kanban/api/session', {
    method: 'POST', headers: mutationHeaders, body: JSON.stringify({ pin: 'integration-test-pin' }),
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Неверный PIN' });
});

test('board reads remain private and validate authentication even when cached', async (t) => {
  let authenticated = true;
  let reads = 0;
  const server = await app(t, {
    fetchImpl: async () => authResponse(authenticated),
    readBoardImpl: async () => { reads++; return board; },
  });
  const response = await server.get();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), board);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.match(response.headers.get('cache-control'), /private/);
  authenticated = false;
  assert.equal((await server.get()).status, 401);
  assert.equal(reads, 1);
});

test('PATCH passes only the decoded order ID and expected/status fields to one move', async (t) => {
  const client = { configured: true };
  const calls = [];
  const server = await app(t, {
    client,
    moveOrderImpl: async (...args) => { calls.push(args); },
  });
  const response = await server.patch(encodeURIComponent('Заказ 42'), {
    ...statusInput, row: 999, cell: 'A1', total: 100000, orders: ['unrequested'],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), board);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 2);
  assert.equal(calls[0][0], client);
  assert.deepEqual(calls[0][1], { id: 'Заказ 42', ...statusInput });
});

test('stale status changes return 409 and leave the write queue usable', async (t) => {
  let calls = 0;
  const server = await app(t, {
    moveOrderImpl: async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('Статус заказа изменился. Обновите доску.'), {
        name: 'OrdersError', code: 'stale', statusCode: 409,
      });
    },
  });
  const stale = await server.patch();
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: 'Статус заказа изменился. Обновите доску.', code: 'stale' });
  assert.equal((await server.patch()).status, 200);
  assert.equal(calls, 2);
});

test('concurrent status changes run serially and board GET waits for them', { timeout: 5000 }, async (t) => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const secondAuthenticated = deferred();
  const events = [];
  let authCalls = 0;
  let activeMoves = 0;
  let peakMoves = 0;
  const server = await app(t, {
    fetchImpl: async () => {
      authCalls++;
      if (authCalls === 2) secondAuthenticated.resolve();
      return authResponse();
    },
    moveOrderImpl: async (_client, input) => {
      activeMoves++;
      peakMoves = Math.max(peakMoves, activeMoves);
      events.push(`start:${input.id}`);
      if (input.id === 'first') {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      events.push(`end:${input.id}`);
      activeMoves--;
    },
    readBoardImpl: async () => {
      assert.equal(activeMoves, 0);
      events.push('read');
      return board;
    },
  });
  t.after(() => releaseFirst.resolve());
  const first = server.patch('first');
  await firstStarted.promise;
  const second = server.patch('second');
  await secondAuthenticated.promise;
  let readFinished = false;
  const read = server.get().then((response) => { readFinished = true; return response; });
  await delay(25);
  assert.deepEqual(events, ['start:first']);
  assert.equal(readFinished, false);
  releaseFirst.resolve();
  for (const response of await Promise.all([first, second, read])) assert.equal(response.status, 200);
  assert.equal(peakMoves, 1);
  assert.ok(events.indexOf('end:first') < events.indexOf('start:second'));
  assert.ok(events.lastIndexOf('read') > events.indexOf('end:second'));
});

test('a read after an unconfirmed write does not reuse an older in-flight snapshot', { timeout: 5000 }, async (t) => {
  const oldReadStarted = deferred();
  const releaseOldRead = deferred();
  const oldBoard = { orders: [{ id: '42', status: 'Новый' }] };
  const currentBoard = { orders: [{ id: '42', status: 'В работе' }] };
  let reads = 0;
  const server = await app(t, {
    readBoardImpl: async () => {
      reads++;
      if (reads === 1) {
        oldReadStarted.resolve();
        await releaseOldRead.promise;
        return oldBoard;
      }
      return currentBoard;
    },
    moveOrderImpl: async () => {
      // A Google write can succeed even if its confirmation request fails.
      throw Object.assign(new Error('Результат переноса не удалось подтвердить.'), {
        name: 'OrderError', code: 'MOVE_UNCONFIRMED', statusCode: 409,
      });
    },
  });
  t.after(() => releaseOldRead.resolve());
  const pendingOldResponse = server.get();
  await oldReadStarted.promise;
  assert.equal((await server.patch()).status, 409);

  // Start the follow-up request while the obsolete read is still unresolved.
  const currentResponse = server.get();
  await delay(25);
  releaseOldRead.resolve();
  assert.deepEqual(await (await currentResponse).json(), currentBoard);
  assert.equal(reads, 2);
  assert.deepEqual(await (await pendingOldResponse).json(), oldBoard);

  // Its late arrival must not replace the newer cached board either.
  assert.deepEqual(await (await server.get()).json(), currentBoard);
  assert.equal(reads, 2);
});

test('static requests cannot escape the explicit public file list', async (t) => {
  const server = await app(t);
  const paths = ['/kanban/../server/index.mjs', '/kanban/%2e%2e/server/index.mjs', '/kanban/%2e%2e%2fserver%2findex.mjs', '/kanban/.env', '/kanban/server/index.mjs'];
  for (const requestPath of paths) {
    // http.request preserves the raw traversal path instead of normalizing it like fetch.
    const result = await new Promise((resolve, reject) => {
      const request = http.request(server.address, { path: requestPath }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body }));
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(result.status, 404, requestPath);
    assert.deepEqual(JSON.parse(result.body), { error: 'Страница не найдена' });
  }
});

test('unexpected source errors never expose their message or arbitrary code', async (t) => {
  for (const statusCode of [403, 502]) {
    await t.test(`source HTTP ${statusCode}`, async (subtest) => {
      const server = await app(subtest, {
        readBoardImpl: async () => { throw Object.assign(new Error('private-source-message-sentinel'), {
          statusCode, code: 'private-source-code-sentinel',
        }); },
      });
      const response = await server.get();
      const content = await response.text();
      assert.ok(response.status >= 400);
      assert.doesNotMatch(content, /private-source-(?:message|code)-sentinel/);
      assert.deepEqual(JSON.parse(content), {
        error: 'Не удалось получить данные Google-таблицы. Обновите доску и повторите попытку.',
      });
    });
  }
});

test('record edits accept only the selected record type and return a fresh board', async (t) => {
  let seen;
  const server = await app(t, { editRecordImpl: async (_client, input) => { seen = input; } });
  const payload = { record: { key: '42', revision: 'fixture' }, changes: { title: 'Правка' }, extra: 'ignored' };
  const response = await server.get('/kanban/api/records/order', { method: 'PATCH', headers: mutationHeaders, body: JSON.stringify(payload) });
  assert.equal(response.status, 200);
  assert.deepEqual(seen, { type: 'order', record: payload.record, changes: payload.changes });
  assert.deepEqual(await response.json(), board);
  assert.equal((await server.get('/kanban/api/records/settings', { method: 'PATCH', headers: mutationHeaders, body: '{}' })).status, 404);
});

test('installation creation binds to the URL order and does not trust an input order ID', async (t) => {
  let seen;
  const server = await app(t, { createInstallationImpl: async (_client, input) => { seen = input; } });
  const response = await server.get('/kanban/api/orders/42/installations', { method: 'POST', headers: mutationHeaders,
    body: JSON.stringify({ changes: { status: 'На согласовании' }, orderId: '99', id: '99' }) });
  assert.equal(response.status, 200);
  assert.deepEqual(seen, { orderId: '42', changes: { status: 'На согласовании' } });
});

test('archive binds URL order, passes the full revision set, and returns a fresh board', async (t) => {
  let seen; let current = board;
  const server = await app(t, {
    readBoardImpl: async () => current,
    archiveOrderImpl: async (_client, input) => { seen = input; current = { ...board, orders: [{ id: '42', status: 'Сдан' }] }; return { completedInstallations: 1 }; },
  });
  await server.get();
  const installations = [{ record: { sheet: 'Монтажи', key: 'one', rowNumber: 2, revision: 'a'.repeat(64) } }];
  const response = await server.get('/kanban/api/orders/42/archive', { method: 'POST', headers: mutationHeaders,
    body: JSON.stringify({ orderId: '999', expectedStatus: 'Готов к выдаче', installations, status: 'Отменён', extra: true }) });
  assert.equal(response.status, 200);
  assert.deepEqual(seen, { orderId: '42', expectedStatus: 'Готов к выдаче', installations });
  assert.deepEqual(await response.json(), current);
  assert.equal(current.orders[0].status, 'Сдан');
});

test('archive validates auth, origin and payload before calling the mutation', async (t) => {
  let authenticated = false; let calls = 0;
  const server = await app(t, { fetchImpl: async () => authResponse(authenticated), archiveOrderImpl: async () => { calls++; } });
  const path = '/kanban/api/orders/42/archive';
  const request = { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ expectedStatus: 'Готов к выдаче', installations: [] }) };
  assert.equal((await server.get(path, request)).status, 401);
  authenticated = true;
  assert.equal((await server.get(path, { ...request, headers: { ...mutationHeaders, Origin: 'https://foreign.test' } })).status, 403);
  for (const invalid of [{ installations: [] }, { expectedStatus: 'Готов к выдаче', installations: {} }]) {
    assert.equal((await server.get(path, { ...request, body: JSON.stringify(invalid) })).status, 400);
  }
  assert.equal(calls, 0);
});

test('archive shares the serialized mutation queue with ordinary status moves', { timeout: 5000 }, async (t) => {
  const entered = deferred(); const release = deferred(); const events = [];
  const server = await app(t, {
    archiveOrderImpl: async () => { events.push('archive'); entered.resolve(); await release.promise; },
    moveOrderImpl: async () => { events.push('move'); },
  });
  const archive = server.get('/kanban/api/orders/42/archive', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ expectedStatus: 'Готов к выдаче', installations: [] }) });
  await entered.promise;
  const move = server.patch();
  await delay(20);
  assert.deepEqual(events, ['archive']);
  release.resolve();
  const responses = await Promise.all([archive, move]);
  assert.ok(responses.every(response => response.status === 200));
  assert.deepEqual(events, ['archive', 'move']);
});

test('archive conflicts return safe409 without retry and leave the queue usable', async (t) => {
  let calls = 0;
  const server = await app(t, { archiveOrderImpl: async () => { calls++; throw Object.assign(new Error('Монтаж изменился. Обновите доску.'), { name: 'OrderError', code: 'ARCHIVE_INSTALLATIONS_CONFLICT', statusCode: 409 }); } });
  const response = await server.get('/kanban/api/orders/42/archive', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ expectedStatus: 'Готов к выдаче', installations: [] }) });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'ARCHIVE_INSTALLATIONS_CONFLICT');
  assert.equal(calls, 1);
  assert.equal((await server.patch()).status, 200);
});

test('media stays authenticated, is scoped to existing orders, and receives private safe headers', async (t) => {
  const item = { id: 'a'.repeat(32), name: 'Превью.png', contentType: 'image/png', kind: 'image', size: 3 };
  let authenticated = true;
  const mediaStore = {
    list: async () => ({ items: [item], coverId: item.id }),
    read: async () => ({ bytes: Buffer.from('png'), media: item }),
  };
  const server = await app(t, { mediaStore, fetchImpl: async () => authResponse(authenticated) });
  const filePath = `/kanban/api/orders/42/media/${item.id}`;
  const response = await server.get(filePath);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-disposition'), /^inline;/);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.match((await server.get(filePath + '?download=1')).headers.get('content-disposition'), /^attachment;/);
  assert.equal((await server.get(`/kanban/api/orders/missing/media/${item.id}`)).status, 404);
  authenticated = false;
  assert.equal((await server.get(filePath)).status, 401);
  assert.equal((await server.get('/kanban/api/orders/42/media', { method: 'POST', headers: { Origin: origin }, body: 'png' })).status, 401);
});

test('media upload passes exact file bytes and decoded filename, then invalidates covers on the board', async (t) => {
  let upload;
  let items = [];
  const mediaStore = {
    list: async () => ({ items, coverId: items[0]?.id ?? null }),
    add: async (id, input) => { upload = { id, ...input }; items = [{ id: 'a'.repeat(32), name: input.name, contentType: input.contentType, kind: 'image' }]; },
  };
  const server = await app(t, { mediaStore });
  assert.deepEqual((await (await server.get()).json()).orders[0].media.items, []);
  const response = await server.get('/kanban/api/orders/42/media', { method: 'POST', headers: {
    Origin: origin, 'Content-Type': 'image/png', 'X-File-Name': encodeURIComponent('Превью заказа.png'),
  }, body: Buffer.from([1, 2, 3]) });
  assert.equal(response.status, 201);
  assert.equal(upload.id, '42');
  assert.equal(upload.name, 'Превью заказа.png');
  assert.deepEqual(upload.bytes, Buffer.from([1, 2, 3]));
  const updated = await (await server.get()).json();
  assert.equal(updated.orders[0].media.items.length, 1);
  assert.match(updated.orders[0].media.items[0].url, /^\/kanban\/api\/orders\/42\/media\//);
});

test('workspace navigation exposes active sections without paused CRM or finance shortcuts', async (t) => {
  const server = await app(t);
  const html = await (await server.get('/kanban/')).text();
  for (const href of ['/', '/#production', '/#warehouse', '/kanban/', '/signs/']) {
    assert.match(html, new RegExp(`href="${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  }
  assert.doesNotMatch(html, /href="\/#(?:operations|cashflow)"/);
  assert.match(html, />Заказы</);
  assert.doesNotMatch(html, /href="\/crm\/"/);
  const workspace = await (await server.get('/kanban/workspace.js?v=test')).text();
  const styles = await (await server.get('/kanban/styles.css?v=test')).text();
  assert.match(workspace, /record-section-heading/);
  assert.match(styles, /Shared workshop visual language/);
});

test('shared configurator catalog requires session and same origin before accessing Google',async t=>{
 let calls=0;
 const protectedServer=await app(t,{fetchImpl:async()=>authResponse(false),orderCatalog:async()=>{calls++;return {options:{}};}});
 assert.equal((await protectedServer.get('/kanban/api/configurator')).status,401);
 assert.equal((await protectedServer.get('/kanban/api/configurator',{method:'POST',headers:mutationHeaders,body:'{}'})).status,401);
 const server=await app(t,{orderCatalog:async input=>{calls++;return {options:{face:input?[input.value]:[]}};}});
 assert.equal((await server.get('/kanban/api/configurator',{method:'POST',headers:{...mutationHeaders,Origin:'https://foreign.test'},body:'{}'})).status,403);
 assert.equal(calls,0);
 assert.deepEqual(await (await server.get('/kanban/api/configurator')).json(),{options:{face:[]}});
 assert.deepEqual(await (await server.get('/kanban/api/configurator',{method:'POST',headers:mutationHeaders,body:JSON.stringify({value:'Бордовый'})})).json(),{options:{face:['Бордовый']}});
});
