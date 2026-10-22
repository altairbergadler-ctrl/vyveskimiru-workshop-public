import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertOwned } from './safety.mjs';

export async function avitoFixture(directory, url, options) {
  assertOwned(directory);
  const parsed = new URL(url);
  if (parsed.origin !== 'https://api.avito.ru' || options.redirect !== 'error') throw new Error('OFFLINE_AVITO_REQUEST_DENIED');
  if (parsed.pathname === '/token' && options.method === 'POST') {
    const form = new URLSearchParams(options.body);
    if (form.get('client_id') !== 'offline-avito' || form.get('client_secret') !== 'offline-avito-secret') throw new Error('OFFLINE_AVITO_CREDENTIALS_REQUIRED');
    return Response.json({ access_token: 'offline-avito-token', token_type: 'Bearer', expires_in: 86400 });
  }
  if (options.headers.Authorization !== 'Bearer offline-avito-token') throw new Error('OFFLINE_AVITO_TOKEN_REQUIRED');
  if (parsed.pathname === '/core/v1/accounts/self' && options.method === 'GET') return Response.json({ id: 1234, phone: 'private-fictional-phone' });
  if (parsed.pathname === '/messenger/v2/accounts/1234/chats' && options.method === 'GET') return Response.json({chats:[],meta:{has_more:false}});
  if (parsed.pathname === '/core/v1/items' && options.method === 'GET') return Response.json({
    meta: { page: Number(parsed.searchParams.get('page')), per_page: 50 }, resources: [{ id: 5678, title: 'Вымышленная вывеска', status: 'active' }],
  });
  if (parsed.pathname === '/stats/v2/accounts/1234/items' && options.method === 'POST') {
    fs.writeFileSync(path.join(directory, 'avito-started'), 'workshop-qa-v1');
    const started = Date.now();
    while (fs.existsSync(path.join(directory, 'avito-hold'))) {
      if (Date.now() - started > 5000) throw new Error('OFFLINE_AVITO_HOLD_TIMEOUT');
      await delay(10, undefined, { signal: options.signal });
    }
    const request = JSON.parse(options.body);
    const total = request.grouping === 'totals' ? (Date.parse(request.dateTo)-Date.parse(request.dateFrom))/86400000+1 : 1;
    return Response.json({ result: { timestamp: '2026-09-08 12:00:00', dataTotalCount: total, groupings: [
      { id: 1788825600, type: 'dates', metrics: [{ slug: 'views', value: 0 }, { slug: 'spending', value: 5000 }] },
    ] } });
  }
  throw new Error('OFFLINE_AVITO_REQUEST_DENIED');
}
