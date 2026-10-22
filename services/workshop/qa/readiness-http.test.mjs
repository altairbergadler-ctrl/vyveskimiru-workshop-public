import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createDirectory, launch, removeDirectory } from './sandbox-lib.mjs';
import { seedAdvertising } from './advertising-fixture.mjs';
test('readiness endpoints enforce owner and origin, persist only manual content, preserve Google and ordinary routes', async () => {
  const directory = createDirectory('readiness-http-');
  let instance;
  try {
    const period = await seedAdvertising(directory);
    instance = await launch(directory, { avito: true });
    const before = fs.readFileSync(path.join(directory, 'sheet.json'), 'utf8');
    const headers = {
      Cookie: `finance_session=${instance.token}`,
      Origin: instance.base,
      'Content-Type': 'application/json',
    };
    const get = (route) => fetch(instance.base + route, { headers });
    const post = (route, data, extra = {}) =>
      fetch(instance.base + route, {
        method: 'POST',
        headers: { ...headers, ...extra },
        body: JSON.stringify(data),
      });
    const route = '/api/analytics/materials',
      input = {
        id: crypto.randomUUID(),
        itemId: '5678',
        text: 'Учебный текст',
        photos: [],
        expectedVersion: 0,
      };
    assert.equal(
      (await fetch(instance.base + route + '?itemId=5678')).status,
      401,
    );
    assert.equal(
      (
        await post(route + '/content', input, {
          Origin: 'https://evil.invalid',
        })
      ).status,
      403,
    );
    assert.equal((await get(route + '?itemId=5678&itemId=5679')).status, 400);
    assert.equal((await post(route + '/content', input)).status, 200);
    assert.equal((await post(route + '/content', input)).status, 200);
    assert.equal(
      (await post(route + '/content', { ...input, id: crypto.randomUUID() }))
        .status,
      409,
    );
    const response = await get(route + '?itemId=5678'),
      view = await response.json();
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(view.content.text, input.text);
    assert.equal(view.archive, false);
    const daily = '/api/analytics/avito/deep/daily';
    assert.equal(
      (await get(daily + '?' + new URLSearchParams(period))).status,
      200,
    );
    assert.equal(
      (await post(daily, period, { Origin: 'https://evil.invalid' })).status,
      403,
    );
    const job = await (await post(daily, period)).json();
    assert(job.jobId);
    assert.equal(
      (await post(daily + '/cancel', { jobId: job.jobId })).status,
      200,
    );
    const state = await (
      await get(daily + '?' + new URLSearchParams(period))
    ).json();
    assert.equal(state.job.state, 'cancelled');
    const existing = await (
      await get('/api/analytics/avito/deep?' + new URLSearchParams(period))
    ).json();
    assert.equal(existing.reportedItems, 2);
    await instance.stop();
    instance = await launch(directory, { avito: true });
    headers.Cookie = `finance_session=${instance.token}`;
    headers.Origin = instance.base;
    const after = await (await get(route + '?itemId=5678')).json();
    assert.equal(after.content.text, input.text);
    assert.equal(
      fs.readFileSync(path.join(directory, 'sheet.json'), 'utf8'),
      before,
    );
  } finally {
    await instance?.stop();
    removeDirectory(directory);
  }
});
