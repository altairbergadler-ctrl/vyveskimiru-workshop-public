import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { createDirectory, removeDirectory } from '../qa/sandbox-lib.mjs';
import { AVITO_METRICS, AvitoClient, AvitoError, avitoApi, avitoConfig, parseAvitoReport, validateAvitoReport } from './avito.mjs';

const epoch = Date.parse('2026-09-08T12:00:00Z');
const input = { dateFrom: '2026-09-01', dateTo: '2026-09-07' };
test('Avito timestamp-only empty period has no rows or metric values; half-present envelopes still fail', () => {
  const request=validateAvitoReport({...input,grouping:'item'},epoch);
  const report=parseAvitoReport({result:{timestamp:'2026-09-08 11:00:00'}},request,new Date(epoch).toISOString());
  assert.deepEqual(report.groups,[]);assert.deepEqual(report.availableMetrics,[]);
  assert.equal(report.unreturnedMetrics.length,Object.keys(AVITO_METRICS).length);
  assert.equal(report.sourceCountReturned,false);assert.equal(report.pagination.complete,true);
  assert.throws(()=>parseAvitoReport({result:{timestamp:'now',dataTotalCount:0}},request),{code:'schema'});
  assert.throws(()=>parseAvitoReport({result:{timestamp:'now',groupings:[]}},request),{code:'schema'});
});
function payload(metrics = [{ slug: 'views', value: 0 }, { slug: 'spending', value: 12345 }, { slug: 'spendingBonus', value: 500 }]) {
  return { result: { dataTotalCount: 1, timestamp: '2026-09-08 11:00:00', groupings: [{ id: 1788220800, type: 'dates', metrics }] } };
}
async function fixture(t, fetchResponse) {
  const directory = createDirectory('avito-');
  const credentialsFile = path.join(directory, 'credentials.json');
  fs.writeFileSync(credentialsFile, JSON.stringify({ client_id: 'fictional-id+&', client_secret: 'fictional-secret&=' }), { mode: 0o600 });
  const file = path.join(directory, 'technical.sqlite3');
  const db = new Database(file);
  let now = epoch;
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(new URL(url).origin, 'https://api.avito.ru');
    assert.equal(options.redirect, 'error');
    if (new URL(url).pathname === '/token') return Response.json({ access_token: 'fictional-token', expires_in: 86400, token_type: 'Bearer' });
    if (new URL(url).pathname === '/core/v1/accounts/self') return Response.json({ id: 1234, phone: 'fictional-private-phone', email: 'fictional@example.invalid', name: 'Fictional owner' });
    return fetchResponse ? fetchResponse(url, options) : Response.json(payload());
  };
  const config = { enabled: true, credentialsFile };
  const client = new AvitoClient({ db, config, fetchImpl, now: () => now });
  t.after(() => { client.close(); db.close(); removeDirectory(directory); });
  return { directory, credentialsFile, file, db, config, client, calls, fetchImpl,
    now: () => now, advance: ms => { now += ms; } };
}

test('Avito wallet uses the verified owner and shared client/quota; decimal rubles and zero are preserved', async t => {
  const f = await fixture(t, url => {
    assert.equal(new URL(url).pathname, '/core/v1/accounts/1234/balance/');
    return Response.json({ real: 499.99, bonus: 0 });
  });
  const result = await f.client.balance();
  assert.equal(result.real, 499.99); assert.equal(result.bonus, 0); assert.equal(result.currency, 'RUB');
  assert.equal(result.accountId, '1234'); assert.equal(f.client.status().capabilities.balance, 'available');
  await assert.rejects(f.client.balance(), { code: 'rate_limit' });
  f.advance(3001); await f.client.balance(); assert.equal(f.calls.filter(x => x.url.endsWith('/token')).length, 1);
});

test('Avito wallet rejects missing, invalid and forbidden balances instead of projecting zero', async t => {
  let value = {};
  const f = await fixture(t, () => Response.json(value));
  for (const real of [undefined, null, -1, '0', Number.MAX_SAFE_INTEGER]) {
    value = { real, bonus: 0 }; await assert.rejects(f.client.balance(), { code: 'schema' }); f.advance(3001);
  }
  value = { real: 0, bonus: 0 }; assert.equal((await f.client.balance()).real, 0);
  const forbidden = await fixture(t, () => new Response('', { status: 403 }));
  await assert.rejects(forbidden.client.balance(), { code: 'forbidden' });
});

test('Avito disabled/status never read a credentials file, initialize storage or contact network', async () => {
  const client = new AvitoClient({ config: avitoConfig({ AVITO_CREDENTIALS_FILE: 'must-not-be-read' }),
    fetchImpl: () => { throw new Error('must not call'); } });
  assert.equal(client.status().state, 'disabled');
  assert.equal((await avitoApi(client, '/api/integrations/avito', 'GET')).data.automaticImport, false);
  await assert.rejects(client.checkConnection(), { code: 'disabled' });
  assert.deepEqual(Object.keys(AVITO_METRICS).includes('profit'), false);
});

test('Avito keys are form-encoded, identity is whitelisted and status contains no credentials or PII', async t => {
  const f = await fixture(t);
  const status = await f.client.checkConnection();
  assert.equal(status.accountId, '1234');
  assert.equal(status.capabilities.statistics, 'not_checked');
  assert.equal(status.state, 'identity_verified');
  const form = new URLSearchParams(f.calls[0].options.body);
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('client_id'), 'fictional-id+&');
  assert.equal(form.get('client_secret'), 'fictional-secret&=');
  assert.equal(f.calls[1].options.headers.Authorization, 'Bearer fictional-token');
  for (const secret of ['fictional-secret', 'fictional-token', 'fictional-private-phone', 'fictional@example.invalid', f.credentialsFile]) assert.ok(!JSON.stringify(status).includes(secret));
});

test('Avito missing, malformed and placeholder credentials return only safe errors', async t => {
  const f = await fixture(t);
  for (const value of ['not json fictional-secret', '{}', '{"client_id":"REPLACE_ID","client_secret":"secret"}']) {
    fs.writeFileSync(f.credentialsFile, value);
    const c = new AvitoClient({ db: f.db, config: f.config, fetchImpl: f.fetchImpl });
    await assert.rejects(c.checkConnection(), error => error.code === 'credentials' && !String(error).includes('fictional'));
    c.close();
  }
  assert.equal(f.calls.length, 0);
});

test('Avito messenger uses only fixed GET routes, accepts official array messages and rejects unsafe chat paths before network', async t => {
  const f=await fixture(t, (url,options)=>{
    assert.equal(options.method,'GET');
    if(new URL(url).pathname==='/messenger/v2/accounts/1234/chats')return Response.json({chats:[],meta:{has_more:false}});
    assert.equal(new URL(url).pathname,'/messenger/v3/accounts/1234/chats/fictional/messages/');
    return Response.json([{id:'m1',created:1788602400,direction:'in',type:'text',content:{text:'fictional'}}]);
  });
  await assert.rejects(f.client.conversationMessages({chatId:'../read'}),{code:'invalid'});assert.equal(f.calls.length,0);
  assert.equal((await f.client.conversations()).received,0);assert.equal((await f.client.conversationMessages({chatId:'fictional'})).messages.length,1);
  assert.equal(f.calls.filter(c=>c.options.method==='POST').length,1);
});

test('Avito refuses keys belonging to another expected account before querying statistics', async t => {
  const f = await fixture(t);
  const c = new AvitoClient({ db: f.db, config: { ...f.config, expectedAccountId: '9999' }, fetchImpl: f.fetchImpl, now: f.now });
  await assert.rejects(c.statistics(input), { code: 'account_mismatch' });
  assert.equal(c.status().accountId, null);
  assert.equal(f.calls.length, 2);
  c.close();
});

test('Avito report validates the whole date range, grouping and page before network access', async t => {
  const f = await fixture(t);
  for (const value of [{ ...input, dateFrom: '2026-02-30' }, { ...input, dateTo: '2026-08-01' },
    { ...input, dateFrom: '2025-01-01' }, { ...input, dateFrom: '2026-08-01' }, { ...input, dateTo: '2026-09-09' },
    { ...input, grouping: 'arbitrary' }, { ...input, accountId: '9999' }, { ...input, metrics: ['secret'] },
    { ...input, offset: 1 }, { ...input, offset: 1000 }, null]) {
    await assert.rejects(f.client.statistics(value), { code: 'invalid' });
  }
  assert.equal(f.calls.length, 0);
});

test('Avito preserves zero/missing metrics, integer kopecks, bonuses and unresolved source date keys', async t => {
  const f = await fixture(t);
  const report = await f.client.statistics(input);
  assert.equal(report.groups[0].metrics.views, 0);
  assert.equal(report.groups[0].metrics.contacts, null);
  assert.equal(report.groups[0].metrics.spending, 12345);
  assert.equal(report.groups[0].metrics.spendingBonus, 500);
  assert.equal(report.groups[0].metrics.allSpending, null);
  assert.equal(report.units.spending, 'RUB_minor');
  assert.equal(report.sourceTimezone, 'unverified');
  assert.equal(report.groups[0].sourceGroupId, '1788220800');
  assert.equal(report.pagination.complete, true);
  assert.ok(report.unreturnedMetrics.includes('contacts'));
  const outgoing = JSON.parse(f.calls[2].options.body);
  assert.deepEqual(outgoing, validateAvitoReport(input, epoch));
  assert.ok(!Object.hasOwn(report, 'leads'));
});

test('Avito rejects incomplete day responses, duplicate groups/metrics and invalid money', () => {
  const request = validateAvitoReport(input, epoch);
  const malformed = [payload([{ slug: 'spending', value: 0.5 }]), payload([{ slug: 'views', value: -1 }]),
    payload([{ slug: 'views', value: '0' }]), payload([{ slug: 'views', value: 1 }, { slug: 'views', value: 2 }])];
  const duplicate = payload(); duplicate.result.groupings.push(duplicate.result.groupings[0]); duplicate.result.dataTotalCount = 2;
  const partial = payload(); partial.result.dataTotalCount = 2;
  const emptyPartial = payload(); emptyPartial.result.groupings = [];
  for (const value of [...malformed, duplicate, partial, emptyPartial, { result: {} }, {}]) assert.throws(() => parseAvitoReport(value, request, 'now'), { code: 'schema' });
});

test('Avito empty successful report is distinct from an unsupported metric and failed response', () => {
  const empty = payload(); empty.result.groupings = []; empty.result.dataTotalCount = 0;
  const report = parseAvitoReport(empty, validateAvitoReport(input, epoch), 'now');
  assert.equal(report.pagination.complete, true);
  assert.equal(report.groups.length, 0);
  assert.deepEqual(report.availableMetrics, []);
  assert.equal(report.unreturnedMetrics.length, Object.keys(AVITO_METRICS).length);
});

test('Avito item pagination never claims that a later page is the full report', () => {
  const value = payload(); value.result.groupings[0].type = 'item'; value.result.groupings[0].id = 456;
  value.result.dataTotalCount = 1001;
  const report = parseAvitoReport(value, validateAvitoReport({ ...input, grouping: 'item', offset: 1000 }, epoch), 'now');
  assert.equal(report.pagination.complete, false);
  assert.equal(report.pagination.nextOffset, null);
  assert.equal(report.groups[0].sourceGroupId, '456');
});

test('Avito reserves rate limit before the request; restart and another connection cannot bypass it', async t => {
  const f = await fixture(t);
  await f.client.statistics(input);
  const requests = f.calls.length;
  await assert.rejects(f.client.statistics(input), error => error.code === 'rate_limit' && error.retryAfterSeconds === 65);
  assert.equal(f.calls.length, requests);
  f.advance(4000);
  const db2 = new Database(f.file);
  const c = new AvitoClient({ db: db2, config: f.config, fetchImpl: f.fetchImpl, now: f.now });
  try { await assert.rejects(c.statistics(input), { code: 'rate_limit' }); }
  finally { c.close(); db2.close(); }
  assert.equal(f.calls.filter(x => x.url.includes('/stats/')).length, 1);
  f.advance(62000);
  assert.equal((await f.client.statistics(input)).groups.length, 1);
  assert.equal(f.client.status().lastError, null);
});

test('Avito failed request also consumes quota and upstream Retry-After survives restart', async t => {
  const f = await fixture(t, () => new Response('never expose fictional-secret', { status: 429, headers: { 'Retry-After': '120' } }));
  const result = await avitoApi(f.client, '/api/integrations/avito/statistics', 'POST', input);
  assert.equal(result.status, 429);
  assert.equal(result.headers['Retry-After'], '120');
  assert.ok(!JSON.stringify(result).includes('fictional-secret'));
  f.advance(65000);
  await assert.rejects(f.client.statistics(input), error => error.code === 'rate_limit' && error.retryAfterSeconds === 55);
  assert.equal(f.calls.filter(x => x.url.includes('/stats/')).length, 1);
});

test('Avito 403, network errors and HTML bodies are sanitized and never retried automatically', async t => {
  const f = await fixture(t, () => new Response('fictional-sensitive-upstream-body', { status: 403 }));
  const result = await avitoApi(f.client, '/api/integrations/avito/statistics', 'POST', input);
  assert.equal(result.data.code, 'forbidden');
  assert.ok(!JSON.stringify(result).includes('fictional-sensitive'));
  f.advance(65000);
  const c = new AvitoClient({ db: f.db, config: f.config, now: f.now, fetchImpl: () => { throw new Error('fictional-secret in network error'); } });
  await assert.rejects(c.checkConnection(), error => error instanceof AvitoError && !String(error).includes('fictional-secret'));
  c.close();
});

test('Avito has a bounded response reader and no raw exception payload', async t => {
  const f = await fixture(t, () => new Response('x'.repeat(2 * 1024 * 1024 + 1)));
  await assert.rejects(f.client.statistics(input), { code: 'response_size' });
  assert.ok(JSON.stringify(f.client.status()).length < 2000);
});

test('Avito lists all declared statuses with bounded pages and excludes address/profile data', async t => {
  const f = await fixture(t, () => Response.json({ meta: { page: 1, per_page: 50 }, resources: [
    { id: 456, title: 'Fictional sign', status: 'old', address: 'fictional private address', url: 'javascript:bad' },
  ] }));
  const result = await f.client.listings();
  assert.deepEqual(result.items, [{ id: '456', title: 'Fictional sign', status: 'old', price:null, category:null, url:null }]);
  assert.equal(result.complete, true);
  assert.ok(f.calls.at(-1).url.includes('status=active,removed,old,blocked,rejected'));
  assert.ok(!JSON.stringify(result).includes('javascript:'));
});

test('Avito does not expose paid methods, arbitrary routes, credentials submission or separate spending units', async t => {
  const f = await fixture(t);
  for (const route of ['/api/integrations/avito/spendings', '/api/integrations/avito/token', '/api/integrations/avito/update_price']) {
    assert.equal((await avitoApi(f.client, route, 'POST')).status, 404);
  }
  assert.equal((await avitoApi(f.client, '/api/integrations/avito/check', 'POST', { client_secret: 'secret' })).status, 400);
  assert.equal(f.client.status().capabilities.separateSpendings, 'blocked_unit_contract');
  assert.equal(f.calls.length, 0);
});

test('Avito parallel identity checks share one token request; expiry obtains a fresh token', async t => {
  const f = await fixture(t);
  const checks = await Promise.allSettled([f.client.checkConnection(), f.client.checkConnection()]);
  assert.equal(checks.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.calls.filter(call => new URL(call.url).pathname === '/token').length, 1);
  f.advance(86400000);
  const status = await f.client.checkConnection();
  assert.equal(status.lastError, null);
  assert.equal(status.capabilities.identity, 'available');
  assert.equal(f.calls.filter(call => new URL(call.url).pathname === '/token').length, 2);
});

test('Avito provider 401 invalidates identity/token without retry; a later check recovers', async t => {
  const f = await fixture(t, () => new Response('secret response', { status: 401 }));
  const result = await avitoApi(f.client, '/api/integrations/avito/statistics', 'POST', input);
  assert.equal(result.status, 502);
  assert.equal(result.data.code, 'unauthorized');
  assert.equal(f.client.status().accountId, null);
  assert.equal(f.calls.length, 3);
  f.advance(65000);
  await f.client.checkConnection();
  assert.equal(f.calls.filter(call => new URL(call.url).pathname === '/token').length, 2);
  assert.equal(f.client.status().capabilities.statistics, 'unauthorized');
  assert.equal(f.client.status().state, 'attention_required');
});

test('Avito invalid JSON does not publish a report and close prevents any later call', async t => {
  const f = await fixture(t, () => new Response('<html>fictional-sensitive-data</html>'));
  await assert.rejects(f.client.statistics(input), { code: 'schema' });
  assert.ok(!JSON.stringify(f.client.status()).includes('fictional-sensitive-data'));
  const count = f.calls.length;
  f.client.close();
  await assert.rejects(f.client.checkConnection(), { code: 'closed' });
  assert.equal(f.calls.length, count);
});

test('Avito operator command defaults to disabled with safe output and no new database', () => {
  const result = spawnSync(process.execPath, ['server/avito-check.mjs'], {
    env: { AVITO_ENABLED: 'false' }, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, code: 'disabled', error: 'Подключение Авито выключено.', retryAfterSeconds: null });
});
