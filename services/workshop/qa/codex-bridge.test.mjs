import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { switchCodexBridge, verifyBridgeSource, waitForIdle } from '../deploy/codex-bridge.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bridge = path.join(root, 'bridge'), checkpoint = path.join(root, 'checkpoint'), release = path.join(root, 'release');
  for (const directory of [bridge, checkpoint, path.join(release, 'server')]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(bridge, 'max-codex-broker.mjs'), 'export const version = "old";');
  fs.writeFileSync(path.join(bridge, 'private-unrelated'), 'private state must survive');
  for (const name of ['max-codex-broker.mjs', 'max-retouch-provider.mjs']) fs.writeFileSync(path.join(release, 'server', name), 'export const version = "new";');
  const events = [];
  const control = Object.fromEntries(['stopped', 'idle', 'stop', 'start', 'healthy'].map(name => [name, () => events.push(name)]));
  return { bridge, checkpoint, release, control, events };
}

test('broker upgrade waits for drained backend and idle tasks, preserves old code and rolls back code without private state', async t => {
  const f = fixture(t);
  const previousMask = process.umask(0o077);
  try { await switchCodexBridge({ ...f, mode: 'install' }); } finally { process.umask(previousMask); }
  assert.deepEqual(f.events, ['stopped', 'idle', 'stop', 'start', 'healthy']);
  assert.match(fs.readFileSync(path.join(f.bridge, 'max-codex-broker.mjs'), 'utf8'), /new/u);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(f.bridge, 'max-codex-broker.mjs')).mode & 0o777, 0o644);
  f.events.length = 0; await switchCodexBridge({ ...f, mode: 'restore' });
  assert.deepEqual(f.events, ['stopped', 'idle', 'stop', 'start', 'healthy']);
  assert.match(fs.readFileSync(path.join(f.bridge, 'max-codex-broker.mjs'), 'utf8'), /old/u);
  assert.equal(fs.existsSync(path.join(f.bridge, 'max-retouch-provider.mjs')), false);
  assert.equal(fs.readFileSync(path.join(f.bridge, 'private-unrelated'), 'utf8'), 'private state must survive');
});

test('an active backend or busy broker blocks upgrade before code changes; failed new health remains recoverable', async t => {
  for (const boundary of ['stopped', 'idle']) {
    const f = fixture(t); f.control[boundary] = () => { throw new Error('busy'); };
    await assert.rejects(switchCodexBridge({ ...f, mode: 'install' }), /busy/u);
    assert.match(fs.readFileSync(path.join(f.bridge, 'max-codex-broker.mjs'), 'utf8'), /old/u);
    assert.equal(fs.existsSync(path.join(f.checkpoint, 'codex-bridge', 'RECOVERY_REQUIRED')), false);
  }
  const f = fixture(t); f.control.healthy = () => { throw new Error('new version failed'); };
  await assert.rejects(switchCodexBridge({ ...f, mode: 'install' }), /new version failed/u);
  f.control.healthy = () => {};
  await switchCodexBridge({ ...f, mode: 'restore' });
  assert.match(fs.readFileSync(path.join(f.bridge, 'max-codex-broker.mjs'), 'utf8'), /old/u);
});

test('bridge source verification tolerates historical CRLF but rejects independently changed code', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.bridge, 'max-codex-broker.mjs'), 'export const version = "new";\r\n');
  fs.writeFileSync(path.join(f.release, 'server', 'max-codex-broker.mjs'), 'export const version = "new";\n');
  verifyBridgeSource(f.bridge, f.release);
  fs.appendFileSync(path.join(f.bridge, 'max-codex-broker.mjs'), 'export const drift = true;');
  assert.throws(() => verifyBridgeSource(f.bridge, f.release), /BRIDGE_SOURCE_DRIFT/u);
});

test('restore can replace a live unhealthy broker with no children, but still waits for real native tasks', async () => {
  let checks = 0, probes = 0;
  await waitForIdle('restore', { inspect: () => ({ pid: 123, children: ++checks === 1 }), sleep: async () => {},
    health: async () => { probes++; throw new Error('ENOENT'); }, attempts: 4 });
  assert.equal(checks, 3); assert.equal(probes, 0);
  await assert.rejects(waitForIdle('restore', { inspect: () => ({ pid: 123, children: true }), sleep: async () => {}, attempts: 2 }), /BRIDGE_STILL_BUSY/u);
  await waitForIdle('restore', { inspect: () => ({ pid: 0, children: false }) });
  await assert.rejects(waitForIdle('install', { inspect: () => ({ pid: 0, children: false }) }), /BRIDGE_NOT_RUNNING/u);
});
