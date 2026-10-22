// Disposable, fictional full-backend preview; no live credentials or network.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { responseSlots } from '../server/analytics/response-times.mjs';
import { createDirectory, launch, removeDirectory } from './sandbox-lib.mjs';
import { productionSheetFixtures } from './production-fixture.mjs';
const directory = createDirectory('analytics-compact-preview-'),
  tables = productionSheetFixtures();
tables['Клиенты'][1][7] = 'Авито';
tables['Клиенты'][2][7] = 'Авито';
fs.writeFileSync(path.join(directory, 'sheet.json'), JSON.stringify(tables));
const instance = await launch(directory, { production: true, avito: true, attribution: true, port: 18397 });
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
  ...(process.argv.includes('--complete-expenses') ? {
    dateFrom: from, dateTo: to, grouping: 'item',
    pagination: { offset: 0, total: 2, complete: true, nextOffset: null },
  } : {}),
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
    metrics: { spending: 70000, contacts: 2, impressions:100, views:10 },
  })),
});
// Match the fixture's explicit UTC dates even during the Moscow midnight gap.
const initialized = await fetch(instance.base + `/api/analytics/live?from=${from}&to=${to}`, { headers });
if (!initialized.ok) throw new Error(`FIXTURE_LIVE_HTTP_${initialized.status}`);
if (process.argv.includes('--responses')) {
  const slot = responseSlots(Date.now()).due;
  db.prepare("INSERT INTO response_runs(account,slot,state,started_at,finished_at,listed) VALUES(?,?,'done',?,?,1)")
    .run('1234',slot,at,at);
  for (const [id,item,seconds] of [['r1','1000',120],['r2','1000',240],['r3','1001',null]]) {
    const firstIn=to+'T06:00:00.000Z';
    db.prepare('INSERT INTO response_chats VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('1234',id,item,at,id,firstIn,
      seconds == null ? null : new Date(Date.parse(firstIn)+seconds*1000).toISOString(),seconds,seconds == null ? 'waiting':'answered',at,slot);
  }
}
for (const [kind,id] of [['ad','1000'],['ad','1001'],['order','9001'],['order','9002']]) {
  const response=await fetch(instance.base+'/api/analytics/live/links',{method:'PUT',headers:{...headers,Origin:instance.base,'Content-Type':'application/json'},body:JSON.stringify({kind,entityId:id,productId:'category:signs',expectedRevision:0})});
  if(!response.ok)throw new Error('PREVIEW_MAPPING_FAILED');
}
for(const [id,order,ad] of [['qa-match-a','9001','1000'],['qa-match-b','9002','1001']]) {
  db.prepare('INSERT INTO attribution_suggestions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,'1234','qa-chat-'+id,ad,'Учебное объявление',order,'qa-version','["order_reference"]','["qa-message"]','pending',at);
}
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
server.listen(18398, '127.0.0.1');
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
