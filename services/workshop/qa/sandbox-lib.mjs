import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../server/db.mjs';
import { assertOwned } from './safety.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
export function createDirectory(prefix = 'run-') {
  const parent = path.join(root, 'work', 'sandbox'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, prefix));
  fs.writeFileSync(path.join(directory, '.workshop-qa'), 'workshop-qa-v1');
  return directory;
}
export function removeDirectory(directory) {
  const owned = assertOwned(directory), parent = fs.realpathSync(path.join(root, 'work', 'sandbox'));
  if (path.dirname(fs.realpathSync(owned)) !== parent) throw new Error('QA_CLEANUP_OUTSIDE_PARENT');
  fs.rmSync(owned, { recursive: true });
}
export async function launch(directory, { version = 'offline-dev', port, widgets = false, production = false, avito = false, mail = false, attribution = false, allowPending = false } = {}) {
  assertOwned(directory);
  const data = path.join(directory, 'data'); fs.mkdirSync(data, { recursive: true });
  const token = crypto.randomBytes(32).toString('base64url');
  const db = openDatabase(path.join(data, 'finance.sqlite3'));
  db.prepare('INSERT INTO sessions(token_hash,expires_at,created_at) VALUES(?,?,?)').run(crypto.createHash('sha256').update(token).digest('hex'), new Date(Date.now() + 86400000).toISOString(), new Date().toISOString()); db.close();
  port ??= await freePort();
  // Allowlist environment: never inherit live Google credentials, PIN, NODE_OPTIONS or data paths.
  const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  Object.assign(env, { HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, DATA_DIR: data, QA_DIRECTORY: directory, GOOGLE_SPREADSHEET_ID: 'offline-workshop', GOOGLE_CREDENTIALS_FILE: '', COOKIE_SECURE: 'false', APP_VERSION: version, QA_FIXTURE_PROFILE: widgets ? 'widgets' : 'default' });
  if (production) Object.assign(env, { QA_FIXTURE_PROFILE: 'production', PRODUCTION_PILOT: 'offline' });
  // Sender identity only; IMAP remains disabled and no credentials are supplied.
  if (mail) Object.assign(env, { MAIL_DESIGNER_SENDER: 'designer@example.invalid', MAIL_IMPORT_ENABLED: 'false' });
  if (avito) {
    const credentials = path.join(directory, 'avito-fictional.json');
    fs.writeFileSync(credentials, JSON.stringify({ client_id: 'offline-avito', client_secret: 'offline-avito-secret' }), { mode: 0o600 });
    Object.assign(env, { QA_AVITO_FIXTURE: 'true', AVITO_ENABLED: 'true', AVITO_CREDENTIALS_FILE: credentials, AVITO_ACCOUNT_ID: '1234' });
    if (attribution) env.AVITO_NIGHTLY_ATTRIBUTION = 'true';
  }
  const log = fs.openSync(path.join(directory, 'server.log'), 'a');
  const child = spawn(process.execPath, ['--import', './qa/offline-preload.mjs', 'server/index.mjs'], { cwd: root, env, windowsHide: true, stdio: ['ignore', log, log] }); fs.closeSync(log);
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; } };
  try {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error('SANDBOX_SERVER_EXITED');
      try {
        const r = await fetch(base + '/api/health'), health = await r.json();
        if (r.ok && (health.status === 'ok' || allowPending && health.version === version && health.sync?.pending > 0 &&
          Object.keys(health.checks ?? {}).length === 3 && Object.values(health.checks).every(check => check.ok)))
          return { base, token, stop, child };
      } catch { /* server starting */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('SANDBOX_HEALTH_FAILED');
  } catch (error) { await stop(); throw error; }
}
