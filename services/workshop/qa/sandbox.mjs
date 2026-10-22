import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { root, createDirectory, removeDirectory, launch } from './sandbox-lib.mjs';

const action = process.argv[2];
const controlFile = path.join(root, 'work', 'sandbox', 'control.json');
if (['stop', 'reset'].includes(action)) {
  const control = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
  const response = await fetch(control.base + '/' + action, { method: 'POST', headers: { authorization: control.token } });
  if (!response.ok) throw new Error('SANDBOX_CONTROL_FAILED');
  console.log(`Sandbox ${action} complete.`);
} else if (action === 'start') {
  if (fs.existsSync(controlFile)) throw new Error('Sandbox control file exists; stop the running sandbox first. After a crash, inspect the recorded process before removing its control file.');
  const directory = createDirectory('manual-');
  const token = crypto.randomBytes(32).toString('hex');
  let instance, server, busy = false;
  const cleanup = async () => { await instance?.stop(); server?.close(); fs.rmSync(controlFile, { force: true }); removeDirectory(directory); };
  try {
    instance = await launch(directory, { widgets: process.argv.includes('--widgets'), production: process.argv.includes('--production') });
    server = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/open') {
        res.writeHead(302, { 'Set-Cookie': `finance_session=${instance.token}; Path=/; HttpOnly; SameSite=Strict`, Location: instance.base + (process.argv.includes('--production') ? '/production/' : ''), 'Cache-Control': 'no-store' }); return res.end();
      }
      if (req.method !== 'POST' || req.headers.authorization !== token || busy || !['/stop', '/reset'].includes(req.url)) { res.writeHead(403); return res.end(); }
      busy = true;
      try {
        await instance.stop();
        if (req.url === '/reset') {
          // Delete only the known mock business file and this sandbox's technical data.
          fs.rmSync(path.join(directory, 'sheet.json'), { force: true });
          fs.rmSync(path.join(directory, 'production.json'), { force: true });
          fs.rmSync(path.join(directory, 'data'), { recursive: true });
          instance = await launch(directory, { widgets: process.argv.includes('--widgets'), production: process.argv.includes('--production') });
          res.end('reset'); busy = false;
        } else { res.end('stopped'); await cleanup(); }
      } catch { res.writeHead(500); res.end('failed'); await cleanup(); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    fs.writeFileSync(controlFile, JSON.stringify({ base, token, pid: process.pid, directory }), { flag: 'wx', mode: 0o600 });
    console.log(`Fictional offline workshop: ${base}/open\nReset: npm run sandbox:reset\nStop and remove temporary data: npm run sandbox:stop`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup(); });
  } catch (error) { await cleanup(); throw error; }
} else throw new Error('Use start, reset or stop');
