import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import { AvitoAnalytics } from './analytics/avito.mjs';
import { AvitoError, parseAvitoReport, validateAvitoReport } from './avito.mjs';
import { createDirectory, removeDirectory } from '../qa/sandbox-lib.mjs';

const input = { dateFrom: '2026-09-01', dateTo: '2026-09-08' };
const epoch = Date.parse('2026-09-08T12:00:00Z');
function raw() { return { result: { timestamp: '2026-09-08 12:00:00', dataTotalCount: 8,
  groupings: [{ id: 1788220800, type: 'dates', metrics: [{ slug: 'views', value: 0 }, { slug: 'spending', value: 12345 }] }] } }; }
test('Avito live totals shape has one aggregate; underlying day count is not pagination', () => {
  const request = validateAvitoReport({ ...input, grouping: 'totals' }, epoch);
  const report = parseAvitoReport(raw(), request, new Date(epoch).toISOString());
  assert.equal(report.pagination.complete, true);
  assert.equal(report.pagination.nextOffset, null);
  assert.equal(report.pagination.total, 8);
  assert.equal(report.groups[0].metrics.spending, 12345);
  assert.equal(report.groups[0].metrics.views, 0);
  assert.equal(report.groups[0].metrics.contacts, null);
  const double = raw(); double.result.groupings.push({ ...double.result.groupings[0], id: 123 });
  assert.throws(() => parseAvitoReport(double, request, ''), { code: 'schema' });
  const missing = raw(); missing.result.groupings = [];
  assert.throws(() => parseAvitoReport(missing, request, ''), { code: 'schema' });
});

test('Avito imports survive restart, separate periods/accounts, retain failed-refresh data and append revisions', async () => {
  const directory = createDirectory('analytics-avito-');
  let now = epoch, calls = 0, failure = false, service;
  const client = { status: () => ({ enabled: true, configured: true, accountId: '1234', capabilities: {} }),
    statistics: async range => { calls++; if (failure) throw new AvitoError('forbidden', 403);
      return { ...parseAvitoReport(raw(), validateAvitoReport(range, now), new Date(now).toISOString()), accountId: '1234' }; } };
  try {
    service = new AvitoAnalytics({ client, directory, now: () => now, automatic: false });
    assert.equal(service.view(input).state, 'not_loaded'); assert.equal(calls, 0);
    await assert.rejects(service.sync({ ...input, dateFrom: '2026-01-01' }), { code: 'invalid' }); assert.equal(calls, 0);
    const first = await service.sync(input);
    assert.equal(first.state, 'ready'); assert.equal(first.report.groups[0].metrics.spending, 12345);
    assert.equal(first.report.accountId, undefined);
    assert.equal(service.view({ ...input, dateTo: '2026-09-07' }).report, null);
    await assert.rejects(service.sync(input), { code: 'rate_limit' }); assert.equal(calls, 1);
    service.close(); service = new AvitoAnalytics({ client, directory, now: () => now, automatic: false });
    assert.equal(service.view(input).report.importId, first.report.importId); assert.equal(calls, 1);
    now += 66_000; failure = true;
    await assert.rejects(service.sync(input), { code: 'forbidden' });
    const stale = service.view(input); assert.equal(stale.state, 'stale');
    assert.equal(stale.report.loadedAt, first.report.loadedAt); assert.equal(stale.lastAttempt.code, 'forbidden');
    now += 66_000; failure = false;
    const newer = await service.sync(input); assert.notEqual(newer.report.importId, first.report.importId);
    const db = new Database(path.join(directory, 'analytics.sqlite3'), { readonly: true });
    assert.equal(db.prepare('SELECT count(*) AS n FROM provider_imports').get().n, 2); db.close();
    now += 6 * 60 * 60_000; assert.equal(service.view(input).state, 'stale');
    service.account = '5678'; assert.equal(service.view(input).report, null);
  } finally { service?.close(); removeDirectory(directory); }
});

test('Avito rejects overlapping imports while cached reports stay readable', async () => {
  const directory = createDirectory('analytics-avito-flight-'); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const service = new AvitoAnalytics({ directory, now: () => epoch, automatic: false,
    client: { status: () => ({ enabled: true, accountId: '1234' }), statistics: async () => {
      await gate; throw new AvitoError('unavailable', 502);
    } } });
  try {
    const first = service.sync(input); const rejected = assert.rejects(first, { code: 'unavailable' });
    assert.equal(service.view(input).busy, true);
    await assert.rejects(service.sync({ ...input, dateTo: '2026-09-07' }), { code: 'rate_limit' });
    release(); await rejected;
    assert.equal(service.view(input).state, 'unavailable');
  } finally { release(); service.close(); removeDirectory(directory); }
});
