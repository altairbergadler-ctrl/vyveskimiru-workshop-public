import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateDiagnostics } from './diagnose-live.mjs';

function fixture(overrides = {}) {
  const health = {
    status: 200,
    body: {
      status: 'ok',
      version: 'release-1',
      sync: {
        configured: true,
        pending: 0,
        conflicts: 0,
        conflictHistory: 4,
        invalidRows: 0,
        last_success_at: '2026-09-01T20:00:00.000Z',
        last_error: '',
      },
    },
  };
  return {
    internalHealth: structuredClone(health),
    publicHealth: structuredClone(health),
    page: { status: 200, body: '<title>Финансы · Наружная реклама</title>' },
    serviceWorker: { status: 200, body: "const CACHE = 'finance-vps-v13';" },
    manifest: { status: 200, body: '{"name":"Финансы"}' },
    now: Date.parse('2026-09-01T20:01:00.000Z'),
    ...overrides,
  };
}

test('diagnostics accepts healthy sync and historical conflicts', () => {
  const result = evaluateDiagnostics(fixture());
  assert.equal(result.ok, true);
  assert.equal(result.sync.conflictHistory, 4);
  assert.deepEqual(result.issues, []);
});

test('diagnostics reports invalid sheet rows', () => {
  const input = fixture();
  input.internalHealth.body.sync.invalidRows = 1;
  input.publicHealth.body.sync.invalidRows = 1;
  const result = evaluateDiagnostics(input);
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues, ['sheet_invalid_rows_1']);
});


test('diagnostics reports an unconfirmed production command even when finance is healthy', () => {
  const input = fixture();
  input.internalHealth.body.productionPending = true;
  const result = evaluateDiagnostics(input);
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues, ['unconfirmed_production_command']);
});
