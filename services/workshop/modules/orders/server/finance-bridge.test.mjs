import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { editFinancialRecord } from './finance-bridge.mjs';

const transaction = { id: 'ledger-42', type: 'income', date: '2026-09-05', amount: 1000,
  account: 'В кассе', orderNumber: '42', counterparty: 'Клиент', comment: '',
  category: 'Предоплата', description: 'Предоплата · Клиент', cashInRegister: true, pending: 0 };
const prepared = () => ({ syncId: transaction.id, type: transaction.type, current: { ...transaction }, changes: { comment: 'Уточнение' } });
const opts = { authUrl: 'http://127.0.0.1:18100/api/session', authOrigin: 'https://example.test', cookie: 'test_session=fixture' };

test('finance edit preserves unrelated fields and uses the existing private ledger API', async () => {
  const calls = [];
  const result = await editFinancialRecord(prepared(), { ...opts, fetchImpl: async (url, input) => {
    calls.push({ url, ...input });
    return Response.json(input.method === 'GET' ? { transactions: [transaction] } : { transaction: JSON.parse(input.body), syncPending: false });
  } });
  assert.equal(result.id, transaction.id);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://127.0.0.1:18100/api/transactions');
  assert.equal(calls[1].headers.Cookie, opts.cookie);
  assert.equal(calls[1].headers.Origin, new URL(calls[1].url).origin);
  assert.equal(Object.hasOwn(calls[1].headers, 'Host'), false);
  assert.equal(calls[1].redirect, 'error');
  const patch = JSON.parse(calls[1].body);
  assert.equal(patch.comment, 'Уточнение');
  assert.equal(patch.amount, 1000);
  assert.equal('cashInRegister' in patch, false);
  assert.equal(patch.pending, undefined);
});

test('real HTTP finance writes use the internal target Origin that matches fetch Host', async (t) => {
  const seen = [];
  const server = http.createServer(async (request, response) => {
    seen.push({ method: request.method, host: request.headers.host, origin: request.headers.origin });
    response.setHeader('Content-Type', 'application/json');
    if (new URL(request.headers.origin).host !== request.headers.host) {
      response.writeHead(403);
      response.end(JSON.stringify({ error: 'Origin mismatch' }));
      return;
    }
    if (request.method === 'GET') {
      response.end(JSON.stringify({ transactions: [transaction] }));
      return;
    }
    const parts = [];
    for await (const part of request) parts.push(part);
    const input = JSON.parse(Buffer.concat(parts).toString('utf8'));
    response.end(JSON.stringify({ transaction: input, syncPending: false }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  }));
  const target = `http://127.0.0.1:${server.address().port}`;
  const result = await editFinancialRecord(prepared(), { ...opts, authUrl: `${target}/api/session` });
  assert.equal(result.comment, 'Уточнение');
  assert.equal(result.amount, transaction.amount);
  assert.deepEqual(seen, ['GET', 'PATCH'].map(method => ({ method, host: new URL(target).host, origin: target })));
});

test('stale, pending, duplicate, missing, and type-mismatched financial records never write', async () => {
  for (const transactions of [[], [transaction, transaction], [{ ...transaction, amount: 1001 }],
    [{ ...transaction, pending: 1 }], [{ ...transaction, type: 'expense' }]]) {
    let calls = 0;
    await assert.rejects(editFinancialRecord(prepared(), { ...opts, fetchImpl: async (_url, input) => {
      calls++; assert.equal(input.method, 'GET'); return Response.json({ transactions });
    } }), error => error.statusCode === 409);
    assert.equal(calls, 1);
  }
});

test('blank optional sheet text matches nullable finance fields without relaxing numeric parity', async () => {
  let writes = 0;
  await editFinancialRecord(prepared(), { ...opts, fetchImpl: async (_url, input) => {
    if (input.method === 'GET') return Response.json({ transactions: [{ ...transaction, comment: null }] });
    writes++; return Response.json({ transaction: JSON.parse(input.body), syncPending: false });
  } });
  assert.equal(writes, 1);
});

test('saved but pending sync is reported explicitly without retrying the write', async () => {
  let writes = 0;
  await assert.rejects(editFinancialRecord(prepared(), { ...opts, fetchImpl: async (_url, input) => {
    if (input.method === 'GET') return Response.json({ transactions: [transaction] });
    writes++; return Response.json({ transaction, syncPending: true });
  } }), error => error.code === 'FINANCE_PENDING' && /сохранена/.test(error.message));
  assert.equal(writes, 1);
});

test('financial service errors and redirects do not leak upstream bodies', async () => {
  for (const fetchImpl of [async () => { throw Error('secret-sentinel'); }, async () => new Response('secret-sentinel', { status: 502 }), async () => new Response('secret-sentinel')]) {
    await assert.rejects(editFinancialRecord(prepared(), { ...opts, fetchImpl }), error => !error.message.includes('secret-sentinel'));
  }
});

test('a success-shaped response with unchanged fields is not reported as a confirmed edit', async () => {
  let writes = 0;
  await assert.rejects(editFinancialRecord(prepared(), { ...opts, fetchImpl: async (_url, input) => {
    if (input.method === 'GET') return Response.json({ transactions: [transaction] });
    writes++; return Response.json({ transaction, syncPending: false });
  } }), error => error.code === 'FINANCE_UNCONFIRMED');
  assert.equal(writes, 1);
});
