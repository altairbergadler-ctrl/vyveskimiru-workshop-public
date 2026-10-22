import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDirectory, launch, removeDirectory } from './sandbox-lib.mjs';

test('slow concurrent analytics and dashboard loads do not multiply queued reads', async () => {
  const directory = createDirectory('dashboard-analytics-');
  const pause = path.join(directory, 'pause-finance-read');
  const requests = [];
  let instance;
  try {
    instance = await launch(directory, { production: true });
    const headers = { Cookie: `finance_session=${instance.token}` };
    const get = async route => {
      const response = await fetch(instance.base + route, { headers, signal: AbortSignal.timeout(10000) });
      const data = await response.json();
      assert.equal(response.status, 200, route);
      return data;
    };
    await get('/api/transactions');
    const before = fs.readFileSync(path.join(directory, 'sheet.json'), 'utf8');
    fs.writeFileSync(pause, 'workshop-qa-v1');
    requests.push(get('/api/transactions'));
    for (let i = 0; i < 100 && !fs.existsSync(path.join(directory, 'finance-read-paused')); i++) await delay(10);
    assert.ok(fs.existsSync(path.join(directory, 'finance-read-paused')));
    const routes = ['/api/transactions', '/api/production', '/api/analytics/products', '/api/analytics/live?from=2026-09-01&to=2026-09-16'];
    for (let i = 0; i < 12; i++) for (const route of routes) requests.push(get(route));
    const abandoned = fetch(instance.base + '/api/transactions', { headers, signal: AbortSignal.timeout(50) });
    await assert.rejects(abandoned, { name: 'TimeoutError' });
    // Every request has time to enter the HTTP handler while the upstream is paused.
    await delay(250);
    const blocked = await get('/api/diagnostics');
    assert.equal(blocked.queue, 3);
    assert.equal(blocked.commandQueue.active.label, 'read:finance');
    fs.unlinkSync(pause);
    const results = await Promise.all(requests);
    assert.deepEqual(results[0].transactions, results[1].transactions);
    assert.equal((await get('/api/diagnostics')).queue, 0);
    assert.equal(fs.readFileSync(path.join(directory, 'sheet.json'), 'utf8'), before);
    assert.ok((await get('/api/transactions')).transactions.length);
  } finally {
    fs.rmSync(pause, { force: true });
    await Promise.allSettled(requests);
    await instance?.stop();
    removeDirectory(directory);
  }
});
