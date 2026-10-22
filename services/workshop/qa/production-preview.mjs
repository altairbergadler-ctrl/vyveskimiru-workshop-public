import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { root, createDirectory, launch } from './sandbox-lib.mjs';
import { assertOwned } from './safety.mjs';
import { openDatabase } from '../server/db.mjs';
import { tokenHash } from '../server/auth.mjs';

const baseDirectory = path.join(root, 'work', 'sandbox');
fs.mkdirSync(baseDirectory, { recursive: true });
const descriptorFile = path.join(baseDirectory, 'production-preview.json');
const controlFile = path.join(baseDirectory, 'production-control.json');
const action = process.argv[2] || 'start';
if (action === 'stop') {
  const control = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
  const response = await fetch(control.base + '/stop', {
    method: 'POST',
    headers: { authorization: control.token },
  });
  if (!response.ok) throw new Error('PRODUCTION_PREVIEW_STOP_FAILED');
  console.log('Тестовый сервер остановлен. Данные и обратная связь сохранены.');
} else if (action === 'start') {
  if (fs.existsSync(controlFile))
    throw new Error(
      'Production preview has a control file. Stop the existing instance before starting another; after a crash inspect its recorded processes.',
    );
  const directory = fs.existsSync(descriptorFile)
    ? assertOwned(JSON.parse(fs.readFileSync(descriptorFile, 'utf8')).directory)
    : createDirectory('production-feedback-');
  if (
    path.dirname(fs.realpathSync(directory)) !== fs.realpathSync(baseDirectory)
  )
    throw new Error('PREVIEW_DIRECTORY_OUTSIDE_WORKSPACE');
  fs.writeFileSync(descriptorFile, JSON.stringify({ directory }), {
    mode: 0o600,
  });
  const instance = await launch(directory, {
    production: true,
    version: 'production-pilot-v1',
  });
  const token = crypto.randomBytes(32).toString('hex');
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await instance.stop();
    server.close();
    fs.rmSync(controlFile, { force: true });
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'GET' && request.url === '/open') {
      const db = openDatabase(path.join(directory, 'data', 'finance.sqlite3'));
      db.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').run(
        new Date(Date.now() + 86400000).toISOString(),
        tokenHash(instance.token),
      );
      db.close();
      response.writeHead(302, {
        'Set-Cookie': `finance_session=${instance.token}; Path=/; HttpOnly; SameSite=Strict`,
        Location: instance.base + '/production/',
      });
      response.end();
      return;
    }
    if (request.method === 'GET' && request.url === '/status') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ running: !closing, pilot: true }));
      return;
    }
    if (
      request.method === 'POST' &&
      request.url === '/stop' &&
      request.headers.authorization === token
    ) {
      response.end('stopped');
      await stop();
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(
    controlFile,
    JSON.stringify({
      base,
      token,
      pid: process.pid,
      childPid: instance.child.pid,
      appBase: instance.base,
      directory,
    }),
    { flag: 'wx', mode: 0o600 },
  );
  console.log(
    `Тест производства: ${base}/open\nЛичный вход мастера: ${instance.base}/production/\nДанные сохраняются между остановками и запусками.`,
  );
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => void stop());
} else throw new Error('Use start or stop');
