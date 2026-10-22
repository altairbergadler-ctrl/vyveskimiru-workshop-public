import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDirectory, launch, removeDirectory } from './sandbox-lib.mjs';

test('analytics HTTP requires owner session, returns real fixture totals and cannot mutate source data or call ads', async () => {
  const directory = createDirectory('analytics-http-');
  let instance;
  try {
    instance = await launch(directory);
    const endpoint = `${instance.base}/api/analytics/overview?from=2026-09-01&to=2026-09-08`;
    assert.equal((await fetch(endpoint)).status, 401);
    const headers = { Cookie: `finance_session=${instance.token}` };
    const before = fs.readFileSync(path.join(directory, 'sheet.json'), 'utf8');
    const response = await fetch(endpoint, { headers });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    const report = await response.json();
    assert.equal(report.overview.finance.income, 3000);
    assert.equal(report.overview.finance.expense, 500);
    assert.equal(report.overview.orders.count, 2);
    assert.equal(report.overview.orders.amount, 15000);
    assert.equal(report.overview.orders.profit, 7500, 'temporary 50% estimate; source amounts and payment totals stay unchanged');
    assert.equal(report.overview.current.debt, 12000);
    assert.ok(report.sources.every((s) => s.state === 'ready'));
    assert.equal(report.acquisition.advertising, null);
    assert.ok(
      report.acquisition.connections.every((c) => c.state === 'not_connected'),
    );
    assert.equal(
      JSON.stringify(report).includes('luna@example.invalid'),
      false,
    );
    const repeat = await (await fetch(endpoint, { headers })).json();
    assert.equal(repeat.snapshotId, report.snapshotId);
    for (const action of ['overview', 'connections', 'metric-definitions']) {
      const r = await fetch(`${instance.base}/api/analytics/${action}`, {
        method: 'POST',
        headers,
        body: '{}',
      });
      assert.equal(r.status, 405);
    }
    assert.equal(
      (
        await fetch(`${instance.base}/api/analytics/overview?sql=select`, {
          headers,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${instance.base}/api/analytics/imports/commit`, {
          headers,
        })
      ).status,
      404,
    );
    assert.equal(
      fs.readFileSync(path.join(directory, 'sheet.json'), 'utf8'),
      before,
    );
    assert.equal((await fetch(`${instance.base}/api/health`)).status, 200);
  } finally {
    await instance?.stop();
    removeDirectory(directory);
  }
});
