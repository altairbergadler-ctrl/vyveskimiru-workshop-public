// Disposable, fictional full-backend preview; no live credentials or network.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { createDirectory, launch, removeDirectory } from './sandbox-lib.mjs';
import { productionSheetFixtures } from './production-fixture.mjs';
const directory = createDirectory('analytics-live-preview-'),
  tables = productionSheetFixtures();
tables['Клиенты'][1][7] = 'Авито';
tables['Клиенты'][2][7] = 'Авито';
fs.writeFileSync(path.join(directory, 'sheet.json'), JSON.stringify(tables));
const instance = await launch(directory, { production: true, avito: true });
const headers = { Cookie: `finance_session=${instance.token}` };
await fetch(instance.base + '/api/analytics/avito/deep', { headers });
const db = new Database(path.join(directory, 'data/analytics.sqlite3'));
const to = new Date().toISOString().slice(0, 10),
  from = to.slice(0, 7) + '-01',
  at = new Date().toISOString();
const items = Array.from({ length: 26 }, (_, i) => ({
  id: String(1000 + i),
  title: `Учебное объявление ${i + 1}: вывески для мастерской`,
  status: 'active',
  url: null,
}));
const add = (kind, payload) => {
  const raw = JSON.stringify(payload);
  db.prepare('INSERT INTO ad_snapshots VALUES(?,?,?,?,?,?,?,?,?)').run(
    crypto.randomUUID(),
    'fictional-preview',
    '1234',
    kind,
    from,
    to,
    at,
    crypto.createHash('sha256').update(raw).digest('hex'),
    raw,
  );
};
add('inventory', { items });
add('items', {
  groups: items
    .slice(0, 2)
    .map((a, i) => ({
      sourceGroupId: a.id,
      metrics: {
        impressions: 1000,
        views: 100,
        contacts: i ? 3 : 9,
        spending: i ? 1000000 : 50000,
        promoSpending: 0,
        favorites: 2,
      },
    })),
});
add('account_days', {
  groups: Array.from({ length: Number(to.slice(8)) }, (_, i) => ({
    sourceGroupId: String(Date.parse(from) / 1000 + i * 86400),
    metrics: { spending: 70000, contacts: 2 },
  })),
});
db.close();
const server = http.createServer((req, res) => {
  if (req.url !== '/open') {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(302, {
    'Set-Cookie': `finance_session=${instance.token}; Path=/; HttpOnly; SameSite=Strict`,
    Location: instance.base + '/analytics/live/',
    'Cache-Control': 'no-store',
  });
  res.end();
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
console.log(
  `Fictional preview: http://127.0.0.1:${server.address().port}/open`,
);
const cleanup = async () => {
  server.close();
  await instance.stop();
  removeDirectory(directory);
  process.exit(0);
};
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => void cleanup());
