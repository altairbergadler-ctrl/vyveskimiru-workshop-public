import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDirectory, launch, removeDirectory } from './sandbox-lib.mjs';

test('Analytics Avito endpoint persists only validated reports, protects origin, keeps finance available and reads after restart', { timeout: 15000 }, async () => {
  const directory = createDirectory('avito-analytics-http-'); let instance, pending;
  try {
    instance = await launch(directory, { avito: true });
    const before = fs.readFileSync(path.join(directory, 'sheet.json'), 'utf8');
    const headers = { Cookie: `finance_session=${instance.token}`, Origin: instance.base, 'Content-Type': 'application/json' };
    const url = instance.base + '/api/analytics/avito';
    const date = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const input = { dateFrom: date, dateTo: date };
    const query = '?' + new URLSearchParams(input);
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://evil.invalid' }, body: JSON.stringify(input) })).status, 403);
    assert.equal((await fetch(url + query + '&dateTo=' + date, { headers })).status, 400);
    assert.equal((await fetch(url + query, { headers }).then(r => r.json())).state, 'not_loaded');
    assert.ok(!fs.existsSync(path.join(directory, 'avito-started')));
    fs.writeFileSync(path.join(directory, 'avito-hold'), 'workshop-qa-v1');
    pending = fetch(url, { method: 'POST', headers, body: JSON.stringify(input) });
    for (let i = 0; i < 100 && !fs.existsSync(path.join(directory, 'avito-started')); i++) await delay(10);
    assert.equal(await Promise.race([fetch(instance.base + '/api/transactions', { headers }).then(r => r.status), delay(1500).then(() => 'blocked')]), 200);
    fs.unlinkSync(path.join(directory, 'avito-hold'));
    const response = await pending, first = await response.json();
    assert.equal(response.status, 200); assert.equal(first.state, 'ready');
    assert.equal(first.report.groups[0].metrics.spending, 5000);
    assert.equal(first.report.groups[0].metrics.contacts, null);
    assert.equal(first.report.accountId, undefined);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify(input) })).status, 429);
    await instance.stop(); instance = await launch(directory, { avito: true });
    headers.Cookie = `finance_session=${instance.token}`; headers.Origin = instance.base;
    const readback = await fetch(instance.base + '/api/analytics/avito' + query, { headers }).then(r => r.json());
    assert.equal(readback.report.importId, first.report.importId);
    assert.equal(fs.readFileSync(path.join(directory, 'sheet.json'), 'utf8'), before);
  } finally {
    if (fs.existsSync(path.join(directory, 'avito-hold'))) fs.unlinkSync(path.join(directory, 'avito-hold'));
    await pending?.catch(() => {}); await instance?.stop(); removeDirectory(directory);
  }
});

test('Avito real HTTP routes require existing session and origin; default disabled leaves no provider state', async () => {
  const directory = createDirectory('avito-http-disabled-'); let instance;
  try {
    instance = await launch(directory);
    const route = '/api/integrations/avito';
    assert.equal((await fetch(instance.base + route)).status, 401);
    const headers = { Cookie: `finance_session=${instance.token}`, Origin: instance.base, 'Content-Type': 'application/json' };
    const status = await fetch(instance.base + route, { headers });
    assert.equal(status.headers.get('Cache-Control'), 'private, no-store');
    assert.equal((await status.json()).state, 'disabled');
    const crossOrigin = await fetch(instance.base + route + '/check', { method: 'POST', headers: { ...headers, Origin: 'https://evil.invalid' }, body: '{}' });
    assert.equal(crossOrigin.status, 403);
    const check = await fetch(instance.base + route + '/check', { method: 'POST', headers, body: '{}' });
    assert.equal(check.status, 409);
    assert.equal((await check.json()).code, 'disabled');
    assert.equal((await fetch(instance.base + '/api/health').then(r => r.json())).status, 'ok');
  } finally { await instance?.stop(); removeDirectory(directory); }
});

test('Avito real HTTP reads fictional provider, preserves business data and does not hold finance queue', { timeout: 15000 }, async () => {
  const directory = createDirectory('avito-http-'); let instance, pending;
  try {
    instance = await launch(directory, { avito: true });
    const before = fs.readFileSync(path.join(directory, 'sheet.json'), 'utf8');
    const headers = { Cookie: `finance_session=${instance.token}`, Origin: instance.base, 'Content-Type': 'application/json' };
    const call = async (suffix, body = {}) => {
      const r = await fetch(instance.base + '/api/integrations/avito/' + suffix, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: r.status, value: await r.json(), headers: r.headers };
    };
    assert.equal((await call('check')).value.state, 'identity_verified');
    assert.equal((await call('listings')).value.items[0].id, '5678');
    fs.writeFileSync(path.join(directory, 'avito-hold'), 'workshop-qa-v1');
    const date = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    pending = call('statistics', { dateFrom: date, dateTo: date });
    for (let i = 0; i < 100 && !fs.existsSync(path.join(directory, 'avito-started')); i++) await delay(10);
    assert.ok(fs.existsSync(path.join(directory, 'avito-started')));
    const finance = await Promise.race([
      fetch(instance.base + '/api/transactions', { headers }).then(r => r.status),
      delay(1500).then(() => 'blocked'),
    ]);
    assert.equal(finance, 200);
    fs.unlinkSync(path.join(directory, 'avito-hold'));
    const report = await pending;
    assert.equal(report.status, 200);
    assert.equal(report.value.groups[0].metrics.views, 0);
    assert.equal(report.value.groups[0].metrics.contacts, null);
    const limited = await call('statistics', { dateFrom: date, dateTo: date });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('Retry-After')) > 0);
    assert.equal(fs.readFileSync(path.join(directory, 'sheet.json'), 'utf8'), before);
    const log = fs.readFileSync(path.join(directory, 'server.log'), 'utf8');
    assert.ok(!log.includes('offline-avito-secret'));
    assert.ok(!log.includes('offline-avito-token'));
    assert.ok(!log.includes('private-fictional-phone'));
  } finally {
    if (fs.existsSync(path.join(directory, 'avito-hold'))) fs.unlinkSync(path.join(directory, 'avito-hold'));
    await pending?.catch(() => {}); await instance?.stop(); removeDirectory(directory);
  }
});
