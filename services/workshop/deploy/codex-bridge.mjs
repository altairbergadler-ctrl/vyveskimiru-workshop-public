import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const files = ['max-codex-broker.mjs', 'max-retouch-provider.mjs'];
const fail = code => { throw new Error(code); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function regular(filename) { if (!fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink()) fail('BRIDGE_UNSAFE_FILE'); }
function atomic(filename, bytes) {
  const temporary = `${filename}.new`, fd = fs.openSync(temporary, 'w', 0o644);
  try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, 0o644); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filename);
}
function probe(route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: '/run/workshop-codex/broker.sock', path: route,
      method: body ? 'POST' : 'GET', headers: { 'X-Workshop-Codex': fs.readFileSync('/var/lib/workshop-assistant/broker-token', 'utf8').trim() } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => { try { resolve({ status: res.statusCode, value: JSON.parse(Buffer.concat(chunks).toString()) }); } catch { reject(new Error('BRIDGE_RESPONSE')); } });
    });
    req.setTimeout(3000, () => req.destroy(new Error('BRIDGE_TIMEOUT'))); req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
function brokerProcess() {
  const pid = execFileSync('systemctl', ['show', 'workshop-codex.service', '--property=MainPID', '--value'], { encoding: 'utf8' }).trim();
  if (!/^\d+$/u.test(pid)) fail('BRIDGE_NOT_RUNNING');
  let children = '';
  if (Number(pid) > 1) {
    try { children = execFileSync('ps', ['-o', 'pid=', '--ppid', pid], { encoding: 'utf8' }).trim(); }
    catch (error) { if (error.status !== 1) throw error; }
  }
  return { pid: Number(pid), children: Boolean(children) };
}
export async function waitForIdle(mode, { inspect = brokerProcess, health = () => probe('/health'), sleep = pause, attempts = 630 } = {}) {
  // The backend is stopped, so no new application requests can enter the broker.
  let empty = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const process = inspect();
    if (process.pid < 2) { if (mode === 'restore') return; fail('BRIDGE_NOT_RUNNING'); }
    if (process.children) empty = 0;
    else if (mode === 'restore') {
      // A failed version need not have a working socket. Two idle observations
      // leave time for completed-child receipts to finish without requiring HTTP.
      if (++empty >= 2) return;
    } else {
      const result = await health();
      if (result.status === 404 || (result.status === 200 && result.value.busy === false && result.value.imageBusy === false)) return;
    }
    await sleep(1000);
  }
  fail('BRIDGE_STILL_BUSY');
}
const systemControl = {
  stopped() {
    if (execFileSync('docker', ['inspect', '--format', '{{.State.Running}}', 'finance-pwa'], { encoding: 'utf8' }).trim() !== 'false') fail('BRIDGE_BACKEND_MUST_BE_STOPPED');
  },
  idle: waitForIdle,
  stop() { execFileSync('systemctl', ['stop', 'workshop-codex.service']); },
  start() { execFileSync('systemctl', ['start', 'workshop-codex.service']); },
  async healthy(mode) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const answer = await probe('/answer', { question: 1, search: false });
        if (answer.status !== 400) fail('BRIDGE_TEXT_CONTRACT');
        if (mode === 'install') {
          const health = await probe('/health');
          if (health.status !== 200 || health.value.busy !== false || health.value.imageBusy !== false) fail('BRIDGE_IMAGE_CONTRACT');
        }
        return;
      } catch { await pause(1000); }
    }
    fail('BRIDGE_UNHEALTHY');
  },
};

export function verifyBridgeSource(bridge, previous) {
  const code = filename => fs.readFileSync(filename, 'utf8').replaceAll('\r\n', '\n');
  if (code(path.join(bridge, files[0])) !== code(path.join(previous, 'server', files[0]))) fail('BRIDGE_SOURCE_DRIFT');
}

// Called only by the locked ordinary installer/rollback after the backend has drained.
// Restores code only; OAuth credentials, native receipts and generated images stay intact.
export async function switchCodexBridge({ mode, checkpoint, release, bridge = '/opt/workshop-codex-bridge', control = systemControl }) {
  if (!['install', 'restore'].includes(mode)) fail('BRIDGE_MODE');
  const backup = path.join(checkpoint, 'codex-bridge'), marker = path.join(backup, 'RECOVERY_REQUIRED');
  if (mode === 'restore' && !fs.existsSync(marker)) return false;
  control.stopped();
  if (fs.lstatSync(bridge).isSymbolicLink()) fail('BRIDGE_UNSAFE_DIRECTORY');
  if (mode === 'install') {
    for (const name of files) {
      const source = path.join(release, 'server', name); regular(source);
      execFileSync(process.execPath, ['--check', source]);
    }
  }
  await control.idle(mode);
  let previous;
  if (mode === 'install') {
    fs.mkdirSync(backup, { mode: 0o700 }); previous = [];
    for (const name of files) {
      const target = path.join(bridge, name);
      if (!fs.existsSync(target)) continue;
      regular(target); atomic(path.join(backup, name), fs.readFileSync(target)); previous.push(name);
    }
    if (!previous.includes(files[0])) fail('BRIDGE_PREVIOUS_MISSING');
    atomic(path.join(backup, 'previous.json'), JSON.stringify(previous));
    atomic(marker, 'code-only rollback required\n');
  } else {
    previous = JSON.parse(fs.readFileSync(path.join(backup, 'previous.json'), 'utf8'));
    if (!Array.isArray(previous) || !previous.includes(files[0]) || previous.some(name => !files.includes(name))) fail('BRIDGE_BACKUP_INVALID');
    for (const name of previous) regular(path.join(backup, name));
  }
  control.stop();
  for (const name of [...files].reverse()) {
    const target = path.join(bridge, name);
    if (fs.existsSync(target)) regular(target);
    if (mode === 'restore' && !previous.includes(name)) { if (fs.existsSync(target)) fs.unlinkSync(target); }
    else atomic(target, fs.readFileSync(path.join(mode === 'install' ? path.join(release, 'server') : backup, name)));
  }
  control.start(); await control.healthy(mode);
  atomic(path.join(backup, mode === 'install' ? 'INSTALLED' : 'RESTORED'), new Date().toISOString());
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [mode, checkpoint, release] = process.argv.slice(2);
  if (!/^\/opt\/workshop-backups\/releases\/[^/]+$/u.test(checkpoint || '') || fs.realpathSync(checkpoint) !== checkpoint
    || (mode === 'install' && (!/^\/opt\/finance-pwa\/releases\/[a-f0-9]{40}$/u.test(release || '') || fs.realpathSync(release) !== release))) fail('BRIDGE_RELEASE_PATH');
  if (mode === 'install') {
    const previous = fs.readFileSync(path.join(checkpoint, 'previous-release'), 'utf8').trim();
    if (!/^\/opt\/finance-pwa\/releases\/[a-f0-9]{40}$/u.test(previous) || fs.realpathSync(previous) !== previous) fail('BRIDGE_SOURCE_DRIFT');
    verifyBridgeSource('/opt/workshop-codex-bridge', previous);
  }
  await switchCodexBridge({ mode, checkpoint, release });
  console.info(`Codex bridge ${mode} verified; private state preserved.`);
}
