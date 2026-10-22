import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDirectory, launch, removeDirectory } from './sandbox-lib.mjs';
test('live analytics requires owner session, validates period and leaves financial Sheet data intact', async () => {
  const directory = createDirectory('analytics-live-http-');
  let instance;
  try {
    instance = await launch(directory);
    const route =
      instance.base + '/api/analytics/live?from=2026-09-01&to=2026-09-08';
    assert.equal((await fetch(route)).status, 401);
    const before = fs.readFileSync(path.join(directory, 'sheet.json'), 'utf8');
    const headers = {
      Cookie: `finance_session=${instance.token}`,
      Origin: instance.base,
      'Content-Type': 'application/json',
    };
    const r = await fetch(route, { headers });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('cache-control'), /no-store/);
    const data = await r.json();
    assert.equal(data.summary.orders, 0);
    assert.equal(data.summary.spend, null);
    assert.equal(data.summary.receipts, 0);
    assert.equal(data.quality.unknownOrderSources, 0);
    assert.ok(data.products.some(p=>p.id==='category:print'));
    assert.equal(data.sources.find(s=>s.label==='Услуги').state,'ready');
    assert.equal(JSON.stringify(data).includes('luna@example.invalid'), false);
    assert.equal((await fetch(route + '&sql=foo', { headers })).status, 400);
    assert.equal(
      (
        await fetch(instance.base + '/api/analytics/live/links', {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            kind: 'ad',
            entityId: 'missing',
            productId: 'fake',
            expectedRevision: 0,
          }),
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await fetch(instance.base + '/api/analytics/live/links', {
          method: 'PUT',
          headers: { ...headers, Origin: 'https://untrusted.invalid' },
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal(
      fs.readFileSync(path.join(directory, 'sheet.json'), 'utf8'),
      before,
    );
  } finally {
    await instance?.stop();
    removeDirectory(directory);
  }
});
