// Aggregate-only acceptance check. Never prints sessions or individual business records.
import crypto from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
const db = new Database(path.join(process.env.DATA_DIR, 'finance.sqlite3'), {
  fileMustExist: true,
});
const token = crypto.randomBytes(32).toString('base64url'),
  hash = crypto.createHash('sha256').update(token).digest('hex');
try {
  db.prepare(
    'INSERT INTO sessions(token_hash,expires_at,created_at) VALUES(?,?,?)',
  ).run(
    hash,
    new Date(Date.now() + 120000).toISOString(),
    new Date().toISOString(),
  );
  const base = `http://127.0.0.1:${process.env.PORT || 3000}`;
  const get = async (route) => {
    const r = await fetch(base + route, {
      headers: { Cookie: `finance_session=${token}` },
    });
    if (!r.ok) throw new Error(`HTTP_${r.status}_${route.split('?')[0]}`);
    return r.json();
  };
  const [ads, business, catalog] = await Promise.all(
    [
      '/api/analytics/avito/deep',
      '/api/analytics/overview',
      '/api/analytics/products',
    ].map(get),
  );
  let liveCheck;
  if (process.argv.includes('--live')) {
    const live = await get(
      `/api/analytics/live?from=${ads.period.dateFrom}&to=${ads.period.dateTo}`,
    );
    const health = await get('/api/health');
    const unauthorized = await fetch(base + '/api/analytics/live');
    const conserved =
      live.summary.receipts === null ||
      Math.round((live.summary.allocated + live.summary.unallocated) * 100) ===
        Math.round(live.summary.receipts * 100);
    const validNumbers = live.rows.every((row) =>
      ['receipts', 'orders', 'result', 'romi'].every(
        (key) => row[key] === null || Number.isFinite(row[key]),
      ),
    );
    const ok =
      conserved &&
      validNumbers &&
      unauthorized.status === 401 &&
      health.status === 'ok' &&
      live.sources.every((s) => s.state === 'ready');
    liveCheck = {
      ok,
      conserved,
      validNumbers,
      ownerOnly: unauthorized.status === 401,
      version: health.version,
      ads: live.rows.length,
      orders: live.orders.length,
      products: live.products.length,
      newClients: live.summary.newClients,
      unassignedOrders: live.summary.unassignedOrders,
      links:
        live.rows.filter((r) => r.mapping).length +
        live.orders.filter((r) => r.mapping).length,
      sources: live.sources,
      businessWrites: false,
    };
    if (!ok) process.exitCode = 1;
  }
  console.log(
    JSON.stringify({
      ...(liveCheck ? { live: liveCheck } : {}),
      ads: {
        enabled: ads.enabled,
        loadedAt: ads.loadedAt,
        period: ads.period,
        rows: ads.rows.length,
        reported: ads.reportedItems,
        stale: ads.stale,
        spendKnown: ads.summary?.spending != null,
        contactsKnown: ads.summary?.contacts != null,
        jobs: ads.jobs.slice(0, 1).map((j) => ({
          state: j.state,
          done: j.done,
          failed: j.failed,
          total: j.total,
        })),
        failures: ads.failures?.map((f) => ({ kind: f.kind, code: f.code })),
      },
      business: {
        sources: business.sources,
        orders: business.orders.rows.length,
        avitoOrders: business.orders.rows.filter((o) =>
          /^авито$/iu.test(o.source),
        ).length,
      },
      catalog: {
        products: catalog.products.length,
        positions: catalog.positions.length,
        assigned: catalog.positions.filter((p) => p.productId).length,
        positionKeyPatterns: [
          ...new Set(
            catalog.positions.map((p) => p.sourcePosition.replace(/\d/g, '#')),
          ),
        ].slice(0, 3),
      },
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      type: error.name,
      code: error.message.startsWith('HTTP_')
        ? error.message
        : 'LIVE_READ_FAILED',
    }),
  );
  process.exitCode = 1;
} finally {
  db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash);
  db.close();
}
