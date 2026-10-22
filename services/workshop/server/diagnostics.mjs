import crypto from 'node:crypto';

// No body, cookie, PIN, query string, record ID or upstream response is logged.
export function routeLabel(url) {
  const p = String(url ?? '').split('?')[0];
  return p.replace(/(\/orders\/)[^/]+/g, '$1:id')
    .replace(/(\/(?:items|media|photos)\/)[^/]+/g, '$1:id').slice(0, 120);
}

export class Diagnostics {
  constructor(db, logger = console) {
    this.db = db; this.logger = logger; this.failures = new Map();
    db.exec(`CREATE TABLE IF NOT EXISTS diagnostic_events (
      sequence INTEGER PRIMARY KEY, at TEXT NOT NULL, request_id TEXT NOT NULL,
      method TEXT NOT NULL, route TEXT NOT NULL, status INTEGER NOT NULL, duration_ms INTEGER NOT NULL
    )`);
  }
  attach(req, res) {
    const requestId = crypto.randomUUID();
    req.requestId = requestId; res.setHeader('X-Request-Id', requestId);
    const start = Date.now();
    res.once('finish', () => {
      const event = { at: new Date().toISOString(), requestId, method: req.method,
        route: routeLabel(req.url), status: res.statusCode, durationMs: Date.now() - start };
      if (res.statusCode >= 500) this.failures.set(event.route, event);
      else if (res.statusCode < 400) this.failures.delete(event.route);
      if (res.statusCode < 400 && ['GET', 'HEAD'].includes(req.method)) return;
      this.db.prepare('INSERT INTO diagnostic_events(at,request_id,method,route,status,duration_ms) VALUES(?,?,?,?,?,?)')
        .run(event.at, requestId, event.method, event.route, event.status, event.durationMs);
      this.db.exec('DELETE FROM diagnostic_events WHERE sequence <= (SELECT coalesce(max(sequence),0)-1000 FROM diagnostic_events)');
      this.logger.info(JSON.stringify({ event: res.statusCode >= 500 ? 'request_failed' : 'request_finished', ...event }));
    });
  }
  recent() {
    return this.db.prepare('SELECT at,request_id AS requestId,method,route,status,duration_ms AS durationMs FROM diagnostic_events ORDER BY sequence DESC LIMIT 50').all();
  }
  activeFailures() { return [...this.failures.values()]; }
}
