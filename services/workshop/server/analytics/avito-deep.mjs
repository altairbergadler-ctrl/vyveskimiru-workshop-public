import crypto from 'node:crypto';
import { AvitoError, validateAvitoReport } from '../avito.mjs';
import { buildAdvertisingReport } from './advertising-metrics.mjs';
import { dailyItemsView, startDailyItems, cancelDailyItems } from './daily-items.mjs';

export class AvitoDeepAnalytics {
  constructor({
    base,
    client,
    now = Date.now,
    automatic = process.env.AVITO_AUTO_IMPORT === 'true',
    scheduler = true,
  }) {
    this.base = base;
    this.client = client;
    this.now = now;
    this.automatic = automatic && client.status().enabled;
    this.scheduler = scheduler;
    this.initialized = false;
    this.flight = null;
    this.closed = false;
    if (this.automatic) this.wake(45_000);
  }
  db() {
    const db = this.base.storage();
    if (!this.initialized) {
      db.exec(`CREATE TABLE IF NOT EXISTS ad_runs(id TEXT PRIMARY KEY,account TEXT NOT NULL,date_from TEXT NOT NULL,date_to TEXT NOT NULL,created_at TEXT NOT NULL,finished_at TEXT,state TEXT NOT NULL,automatic INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ad_steps(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,kind TEXT NOT NULL,params TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',next_at INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,code TEXT,output TEXT);
        CREATE INDEX IF NOT EXISTS ad_step_queue ON ad_steps(state,next_at,id);
        CREATE TABLE IF NOT EXISTS ad_snapshots(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,account TEXT NOT NULL,kind TEXT NOT NULL,date_from TEXT NOT NULL,date_to TEXT NOT NULL,loaded_at TEXT NOT NULL,hash TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS ad_snapshot_read ON ad_snapshots(account,kind,date_from,date_to,loaded_at);
        CREATE TABLE IF NOT EXISTS ad_item_versions(id INTEGER PRIMARY KEY AUTOINCREMENT,account TEXT NOT NULL,item_id TEXT NOT NULL,kind TEXT NOT NULL,observed_at TEXT NOT NULL,previous_observed_at TEXT,run_id TEXT NOT NULL,hash TEXT NOT NULL,payload TEXT NOT NULL,changed_fields TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS ad_version_read ON ad_item_versions(account,item_id,id);
        CREATE INDEX IF NOT EXISTS ad_version_kind ON ad_item_versions(account,item_id,kind,id DESC);
        CREATE TABLE IF NOT EXISTS ad_notes(id TEXT PRIMARY KEY,account TEXT NOT NULL,item_id TEXT NOT NULL,event_date TEXT NOT NULL,created_at TEXT NOT NULL,text TEXT NOT NULL);`);
      // Bound dashboard work by the selected account/run, not the full import archive.
      // These indexes also provide rowid order for latest snapshots without sorting payloads.
      db.exec(`CREATE INDEX IF NOT EXISTS ad_runs_recent ON ad_runs(account,created_at DESC);
        CREATE INDEX IF NOT EXISTS ad_steps_run_state ON ad_steps(run_id,state);
        CREATE INDEX IF NOT EXISTS ad_snapshots_period ON ad_snapshots(account,kind,date_from,date_to);
        CREATE INDEX IF NOT EXISTS ad_snapshots_kind ON ad_snapshots(account,kind);
        CREATE INDEX IF NOT EXISTS ad_snapshots_account ON ad_snapshots(account);
        CREATE INDEX IF NOT EXISTS ad_snapshots_run ON ad_snapshots(account,run_id,kind,date_from,date_to);
        CREATE INDEX IF NOT EXISTS ad_versions_changed ON ad_item_versions(account,id DESC) WHERE changed_fields!='[]';`);
      db.prepare(
        "UPDATE ad_steps SET state='queued' WHERE state='running'",
      ).run();
      this.initialized = true;
    }
    return db;
  }
  period(input) {
    return validateAvitoReport({ ...input, grouping: 'item' }, this.now(), 270);
  }
  addStep(run, kind, params) {
    this.db()
      .prepare('INSERT INTO ad_steps(run_id,kind,params) VALUES(?,?,?)')
      .run(run, kind, JSON.stringify(params));
  }
  start(input, automatic = false) {
    const period = this.period(input);
    if (!this.client.status().enabled) throw new AvitoError('disabled', 409);
    const db = this.db(),
      account = this.base.namespace();
    const existing = db
      .prepare(
        "SELECT id FROM ad_runs WHERE account=? AND date_from=? AND date_to=? AND state IN ('queued','running') AND NOT EXISTS(SELECT 1 FROM ad_steps WHERE run_id=ad_runs.id AND kind='daily_items')",
      )
      .get(account, period.dateFrom, period.dateTo);
    if (existing) return { jobId: existing.id, existing: true };
    const active = db
      .prepare(
        "SELECT count(*) AS n FROM ad_runs WHERE account=? AND state IN ('queued','running')",
      )
      .get(account).n;
    if (active >= 3) throw new AvitoError('rate_limit', 429, 65);
    const id = crypto.randomUUID();
    db.transaction(() => {
      db.prepare(
        'INSERT INTO ad_runs(id,account,date_from,date_to,created_at,state,automatic) VALUES(?,?,?,?,?,?,?)',
      ).run(
        id,
        account,
        period.dateFrom,
        period.dateTo,
        new Date(this.now()).toISOString(),
        'queued',
        automatic ? 1 : 0,
      );
      this.addStep(id, 'inventory', { page: 1 });
    })();
    this.wake(0);
    return { jobId: id, existing: false };
  }
  snapshot(run, kind, period, data) {
    const payload = JSON.stringify(data),
      at = new Date(this.now()).toISOString(),
      db = this.db();
    db.prepare(
      'INSERT INTO ad_snapshots(id,run_id,account,kind,date_from,date_to,loaded_at,hash,payload) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(
      crypto.randomUUID(),
      run.id,
      run.account,
      kind,
      period.dateFrom || '',
      period.dateTo || '',
      at,
      crypto.createHash('sha256').update(payload).digest('hex'),
      payload,
    );
    if (['inventory', 'services', 'info', 'items', 'traffic', 'content'].includes(kind)) {
      const versionKind = ['items', 'traffic'].includes(kind)
        ? kind + ':' + period.dateFrom + ':' + period.dateTo
        : kind;
      const items =
        ['info', 'content'].includes(kind)
          ? [data]
          : kind === 'items'
            ? data.groups.map((g) => ({
                id: g.sourceGroupId,
                metrics: g.metrics,
                dateFrom: period.dateFrom,
                dateTo: period.dateTo,
              }))
            : data.items;
      for (const item of items) {
        const previous = db
          .prepare(
            'SELECT observed_at,payload,hash FROM ad_item_versions WHERE account=? AND item_id=? AND kind=? ORDER BY id DESC LIMIT 1',
          )
          .get(run.account, item.id, versionKind);
        const clean =
          ['info', 'content'].includes(kind)
            ? Object.fromEntries(
                Object.entries(item).filter(
                  ([k]) => !['accountId', 'loadedAt'].includes(k),
                ),
              )
            : item;
        const value = JSON.stringify(clean),
          hash = crypto.createHash('sha256').update(value).digest('hex');
        const old = previous ? JSON.parse(previous.payload) : null;
        const changed = old
          ? Object.keys(clean).filter(
              (k) => JSON.stringify(clean[k]) !== JSON.stringify(old[k]),
            )
          : [];
        if (old && kind === 'items' && changed.includes('metrics')) {
          changed.splice(changed.indexOf('metrics'), 1);
          changed.push(
            ...Object.keys(clean.metrics)
              .filter((k) => clean.metrics[k] !== old.metrics?.[k])
              .map((k) => 'metrics.' + k),
          );
        }
        // Every observation remains auditable, including unchanged checks; edits have an observation interval.
        db.prepare(
          'INSERT INTO ad_item_versions(account,item_id,kind,observed_at,previous_observed_at,run_id,hash,payload,changed_fields) VALUES(?,?,?,?,?,?,?,?,?)',
        ).run(
          run.account,
          item.id,
          versionKind,
          at,
          previous?.observed_at || null,
          run.id,
          hash,
          value,
          JSON.stringify(changed),
        );
      }
    }
  }
  commitStep(step, action) {
    return this.db().transaction(() => {
      // Cancellation may arrive while the provider request is in flight. Do not
      // publish its result or enqueue the next page after the run was cancelled.
      if (this.db().prepare('SELECT state FROM ad_runs WHERE id=?').get(step.run_id)?.state === 'cancelled') return null;
      const result = action();
      this.db()
        .prepare(
          "UPDATE ad_steps SET state='done',output=?,code=NULL WHERE id=?",
        )
        .run(JSON.stringify(result), step.id);
      return result;
    })();
  }
  async step(step, run) {
    const params = JSON.parse(step.params),
      db = this.db(),
      period = { dateFrom: run.date_from, dateTo: run.date_to };
    if (step.kind === 'inventory') {
      const value = await this.client.listings(params);
      return this.commitStep(step, () => {
        const previous = db
          .prepare(
            "SELECT output FROM ad_steps WHERE run_id=? AND kind='inventory' AND state='done' ORDER BY id",
          )
          .all(run.id)
          .flatMap((r) => JSON.parse(r.output).items);
        const items = [...previous, ...value.items];
        if (
          items.length > 5000 ||
          new Set(items.map((i) => i.id)).size !== items.length
        )
          throw new AvitoError('schema', 502);
        if (value.nextPage)
          this.addStep(run.id, 'inventory', { page: value.nextPage });
        else {
          this.snapshot(run, 'inventory', {}, { items, complete: true });
          const days =
            (Date.parse(period.dateTo) - Date.parse(period.dateFrom)) /
              86400000 +
            1;
          const previousPeriod = {
            dateFrom: new Date(Date.parse(period.dateFrom) - days * 86400000)
              .toISOString()
              .slice(0, 10),
            dateTo: new Date(Date.parse(period.dateFrom) - 86400000)
              .toISOString()
              .slice(0, 10),
          };
          this.addStep(run.id, 'items', { ...period, offset: 0 });
          let compare = true;
          try {
            this.period(previousPeriod);
          } catch {
            compare = false;
          }
          if (compare)
            this.addStep(run.id, 'items', { ...previousPeriod, offset: 0 });
          this.addStep(run.id, 'account_days', period);
          for (let i = 0; i < items.length; i += 200) {
            const itemIds = items.slice(i, i + 200).map((x) => x.id);
            this.addStep(run.id, 'traffic', { ...period, itemIds });
            if (compare)
              this.addStep(run.id, 'traffic', { ...previousPeriod, itemIds });
            this.addStep(run.id, 'calls', { ...period, itemIds });
          }
          for (let i = 0; i < items.length; i += 100)
            this.addStep(run.id, 'services', {
              itemIds: items.slice(i, i + 100).map((x) => x.id),
            });
          for (const item of items)
            this.addStep(run.id, 'info', { itemId: item.id });
        }
        return { items: value.items };
      });
    }
    if (['items', 'account_days', 'daily_items'].includes(step.kind)) {
      const value = await this.client.statistics(
        { ...params, grouping: step.kind === 'account_days' ? 'day' : 'item' },
        270,
      );
      return this.commitStep(step, () => {
        if (value.pagination.nextOffset !== null) {
          this.addStep(run.id, step.kind, {
            ...params,
            offset: value.pagination.nextOffset,
          });
          return value;
        }
        const pages = db
          .prepare(
            "SELECT output,params FROM ad_steps WHERE run_id=? AND kind=? AND state='done' ORDER BY id",
          )
          .all(run.id, step.kind)
          .filter((r) => {
            const p = JSON.parse(r.params);
            return p.dateFrom === params.dateFrom && p.dateTo === params.dateTo;
          })
          .map((r) => JSON.parse(r.output));
        const groups = [...pages.flatMap((p) => p.groups), ...value.groups];
        if (
          groups.length !== value.pagination.total ||
          new Set(groups.map((g) => g.sourceGroupId)).size !== groups.length
        )
          throw new AvitoError('schema', 502);
        const { accountId: _accountId, ...report } = value;
        this.snapshot(run, step.kind === 'daily_items' ? 'items' : step.kind, params, {
          ...report,
          groups,
          pagination: {
            ...value.pagination,
            offset: 0,
            complete: true,
            nextOffset: null,
          },
        });
        return value;
      });
    }
    const value = await this.client.detail(step.kind, params);
    const { accountId: _accountId, loadedAt: _loadedAt, ...data } = value;
    if (data.missingIds?.length || data.errors?.length)
      throw new AvitoError('incomplete', 502);
    return this.commitStep(step, () => {
      this.snapshot(run, step.kind, params, data);
      return { rows: value.items?.length ?? 1 };
    });
  }
  async work() {
    if (this.closed || this.flight) return;
    const db = this.db(),
      account = this.base.namespace();
    const step = db
      .prepare(
        "SELECT s.* FROM ad_steps s JOIN ad_runs r ON r.id=s.run_id WHERE r.account=? AND s.state='queued' AND r.state IN ('queued','running') AND s.next_at<=? ORDER BY CASE WHEN s.kind='daily_items' THEN 1 ELSE 0 END,s.id LIMIT 1",
      )
      .get(account, this.now());
    if (!step) {
      db.prepare(
        "UPDATE ad_runs SET state=CASE WHEN EXISTS(SELECT 1 FROM ad_steps WHERE run_id=ad_runs.id AND state='failed') THEN 'partial' ELSE 'done' END,finished_at=? WHERE account=? AND state IN ('queued','running') AND NOT EXISTS(SELECT 1 FROM ad_steps WHERE run_id=ad_runs.id AND state IN ('queued','running'))",
      ).run(new Date(this.now()).toISOString(), account);
      return;
    }
    const run = db.prepare('SELECT * FROM ad_runs WHERE id=?').get(step.run_id);
    db.prepare(
      "UPDATE ad_steps SET state='running',attempts=attempts+1 WHERE id=?",
    ).run(step.id);
    db.prepare("UPDATE ad_runs SET state='running' WHERE id=?").run(run.id);
    this.flight = (async () => {
      try {
        const result = await this.step(step, run);
        db.prepare(
          "UPDATE ad_steps SET state='done',output=?,code=NULL WHERE id=? AND state!='cancelled'",
        ).run(JSON.stringify(result), step.id);
      } catch (error) {
        const code = error instanceof AvitoError ? error.code : 'storage';
        const retry =
          (code === 'rate_limit' && step.attempts < 12) ||
          (['unavailable', 'storage'].includes(code) && step.attempts < 3);
        db.prepare(
          "UPDATE ad_steps SET state=?,next_at=?,code=? WHERE id=? AND state!='cancelled'",
        ).run(
          retry ? 'queued' : 'failed',
          this.now() +
            (code === 'rate_limit'
              ? Math.max(1, error.retryAfterSeconds || 65)
              : 65 * (step.attempts + 1)) *
              1000,
          code,
          step.id,
        );
        if (code === 'rate_limit' && ['items','account_days','daily_items'].includes(step.kind)) {
          // One shared statistics quota: do not burn every queued day's retry
          // budget probing the same cooldown. Other resource queues may proceed.
          db.prepare(`UPDATE ad_steps SET next_at=MAX(next_at,?) WHERE state='queued'
            AND kind IN ('items','account_days','daily_items') AND run_id IN (SELECT id FROM ad_runs WHERE account=?)`)
            .run(this.now()+Math.max(1,error.retryAfterSeconds||65)*1000,account);
        }
      }
      const left = db
        .prepare(
          "SELECT count(*) AS n FROM ad_steps WHERE run_id=? AND state IN ('queued','running')",
        )
        .get(run.id).n;
      if (!left) {
        const failed = db
          .prepare(
            "SELECT count(*) AS n FROM ad_steps WHERE run_id=? AND state='failed'",
          )
          .get(run.id).n;
        db.prepare("UPDATE ad_runs SET state=?,finished_at=? WHERE id=? AND state!='cancelled'").run(
          failed ? 'partial' : 'done',
          new Date(this.now()).toISOString(),
          run.id,
        );
      }
    })();
    try {
      await this.flight;
    } finally {
      this.flight = null;
    }
  }
  wake(ms) {
    if (this.closed || !this.scheduler) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      try {
        await this.tick();
      } catch {
        /* source state is isolated from the business server */
      }
      if (!this.closed) this.wake(1000);
    }, ms);
    this.timer.unref();
  }
  async tick() {
    try {
      if (this.automatic) {
        const last = this.db()
          .prepare(
            'SELECT created_at FROM ad_runs WHERE account=? AND automatic=1 ORDER BY created_at DESC LIMIT 1',
          )
          .get(this.base.namespace());
        if (!last || this.now() - Date.parse(last.created_at) >= 15 * 60_000)
          this.start(this.base.currentPeriod(), true);
      }
    } catch {
      /* A full queue must still drain before another automatic run can start. */
    }
    await this.work();
  }
  view(input) {
    const period = this.period(input);
    if (!this.client.status().enabled)
      return {
        enabled: false,
        period,
        rows: [],
        jobs: [],
        snapshots: [],
        events: [],
        notes: [],
      };
    const db = this.db(),
      account = this.base.namespace();
    const days =
      (Date.parse(period.dateTo) - Date.parse(period.dateFrom)) / 86400000 + 1;
    const previous = {
      dateFrom: new Date(Date.parse(period.dateFrom) - days * 86400000)
        .toISOString()
        .slice(0, 10),
      dateTo: new Date(Date.parse(period.dateFrom) - 86400000)
        .toISOString()
        .slice(0, 10),
    };
    const snapshots = [];
    const inventory = db
      .prepare(
        "SELECT rowid,* FROM ad_snapshots WHERE account=? AND kind='inventory' ORDER BY rowid DESC LIMIT 1",
      )
      .get(account);
    if (inventory) snapshots.push(inventory);
    for (const kind of ['items', 'account_days', 'traffic', 'calls'])
      for (const range of [period, previous]) {
        const latest = db
          .prepare(
            'SELECT rowid,* FROM ad_snapshots WHERE account=? AND kind=? AND date_from=? AND date_to=? ORDER BY rowid DESC LIMIT 1',
          )
          .get(account, kind, range.dateFrom, range.dateTo);
        if (latest) {
          if (['traffic', 'calls'].includes(kind))
            snapshots.push(
              ...db
                .prepare(
                  'SELECT rowid,* FROM ad_snapshots WHERE account=? AND run_id=? AND kind=? AND date_from=? AND date_to=? ORDER BY rowid DESC',
                )
                .all(
                  account,
                  latest.run_id,
                  kind,
                  range.dateFrom,
                  range.dateTo,
                ),
            );
          else snapshots.push(latest);
        }
      }
    const history = db
      .prepare(
        'SELECT id,kind,date_from,date_to,loaded_at,hash,run_id FROM ad_snapshots WHERE account=? ORDER BY rowid DESC LIMIT 100',
      )
      .all(account);
    const latestVersions = db
      .prepare(
        "SELECT * FROM ad_item_versions WHERE id IN (SELECT MAX(id) FROM ad_item_versions WHERE account=? AND kind IN ('inventory','services','info') GROUP BY item_id,kind)",
      )
      .all(account);
    const changes = db
      .prepare(
        "SELECT * FROM ad_item_versions WHERE account=? AND changed_fields!='[]' ORDER BY id DESC LIMIT 300",
      )
      .all(account);
    const versions = [
      ...new Map(
        [...latestVersions, ...changes].map((v) => [v.id, v]),
      ).values(),
    ].sort((a, b) => b.id - a.id);
    const jobs = db
      .prepare(
        "SELECT r.*, (SELECT count(*) FROM ad_steps s WHERE s.run_id=r.id) AS total, (SELECT count(*) FROM ad_steps s WHERE s.run_id=r.id AND s.state='done') AS done, (SELECT count(*) FROM ad_steps s WHERE s.run_id=r.id AND s.state='failed') AS failed FROM ad_runs r WHERE account=? AND NOT EXISTS(SELECT 1 FROM ad_steps WHERE run_id=r.id AND kind='daily_items') ORDER BY created_at DESC LIMIT 20",
      )
      .all(account);
    const failures = db
      .prepare(
        'SELECT s.kind,s.code,s.next_at,s.state,r.id AS run_id FROM ad_steps s JOIN ad_runs r ON r.id=s.run_id WHERE r.account=? AND s.code IS NOT NULL AND r.id IN (SELECT id FROM ad_runs WHERE account=? ORDER BY created_at DESC LIMIT 20)',
      )
      .all(account, account);
    const notes = db
      .prepare(
        'SELECT id,item_id AS itemId,event_date AS date,created_at AS createdAt,text FROM ad_notes WHERE account=? ORDER BY event_date DESC LIMIT 1000',
      )
      .all(account);
    return buildAdvertisingReport({
      period,
      snapshots,
      versions,
      jobs,
      failures,
      notes,
      history,
      now: this.now(),
      automatic: this.automatic,
    });
  }
  history(params) {
    if (
      [...params.keys()].some(
        (k) =>
          !['itemId', 'before'].includes(k) || params.getAll(k).length !== 1,
      ) ||
      !/^\d{1,16}$/.test(params.get('itemId') || '')
    )
      throw new AvitoError('invalid', 400);
    const before = params.get('before')
      ? Number(params.get('before'))
      : Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(before) || before <= 0)
      throw new AvitoError('invalid', 400);
    const rows = this.db()
      .prepare(
        'SELECT id,kind,observed_at,previous_observed_at,changed_fields,payload,hash FROM ad_item_versions WHERE account=? AND item_id=? AND id<? ORDER BY id DESC LIMIT 101',
      )
      .all(this.base.namespace(), params.get('itemId'), before);
    return {
      rows: rows.slice(0, 100).map((r) => ({
        id: r.id,
        kind: r.kind,
        observedAt: r.observed_at,
        previousObservedAt: r.previous_observed_at,
        fields: JSON.parse(r.changed_fields),
        value: JSON.parse(r.payload),
        previousValue: JSON.parse(
          this.db()
            .prepare(
              'SELECT payload FROM ad_item_versions WHERE account=? AND item_id=? AND kind=? AND id<? ORDER BY id DESC LIMIT 1',
            )
            .get(this.base.namespace(), params.get('itemId'), r.kind, r.id)
            ?.payload || 'null',
        ),
        hash: r.hash,
      })),
      nextBefore: rows.length > 100 ? rows[99].id : null,
    };
  }
  note(input) {
    if (
      !input ||
      Object.keys(input).some(
        (k) => !['id', 'itemId', 'date', 'text'].includes(k),
      ) ||
      !/^[-a-f0-9]{36}$/.test(input.id) ||
      typeof input.text !== 'string' ||
      !input.text.trim() ||
      input.text.length > 1000
    )
      throw new AvitoError('invalid', 400);
    this.period({ dateFrom: input.date, dateTo: input.date });
    const account = this.base.namespace(),
      db = this.db();
    if (
      !db
        .prepare(
          'SELECT id FROM ad_item_versions WHERE account=? AND item_id=? LIMIT 1',
        )
        .get(account, String(input.itemId))
    )
      throw new AvitoError('invalid', 400);
    const old = db.prepare('SELECT * FROM ad_notes WHERE id=?').get(input.id);
    if (old) {
      if (
        old.account !== account ||
        old.item_id !== String(input.itemId) ||
        old.event_date !== input.date ||
        old.text !== input.text.trim()
      )
        throw new AvitoError('invalid', 409);
      return { id: input.id };
    }
    db.prepare(
      'INSERT INTO ad_notes(id,account,item_id,event_date,created_at,text) VALUES(?,?,?,?,?,?)',
    ).run(
      input.id,
      account,
      String(input.itemId),
      input.date,
      new Date(this.now()).toISOString(),
      input.text.trim(),
    );
    return { id: input.id };
  }
  async handle(request, response, url, json, body) {
    try {
      if (url.pathname.endsWith('/daily/cancel')) {
        if(request.method!=='POST' || url.search) throw new AvitoError('invalid',400);
        return json(response,200,cancelDailyItems(this,await body(request,4096)));
      }
      if (url.pathname.endsWith('/daily')) {
        if(request.method==='POST' && !url.search) return json(response,202,startDailyItems(this,await body(request,4096)));
        if(request.method!=='GET' || [...url.searchParams.keys()].some(k=>!['dateFrom','dateTo','itemId'].includes(k)||url.searchParams.getAll(k).length!==1)) throw new AvitoError('invalid',400);
        const itemId=url.searchParams.get('itemId');
        if(itemId && !/^[1-9]\d{0,15}$/.test(itemId)) throw new AvitoError('invalid',400);
        return json(response,200,dailyItemsView(this,{dateFrom:url.searchParams.get('dateFrom'),dateTo:url.searchParams.get('dateTo')},itemId));
      }
      if (!this.client.status().enabled && request.method === 'POST')
        throw new AvitoError('disabled', 409);
      if (url.pathname.endsWith('/history')) {
        if (request.method !== 'GET')
          return json(response, 405, { error: 'Метод недоступен.' });
        return json(response, 200, this.history(url.searchParams));
      }
      if (request.method === 'POST') {
        if (url.search) throw new AvitoError('invalid', 400);
        const input = await body(request, 4096);
        if (url.pathname.endsWith('/notes'))
          return json(response, 200, this.note(input));
        if (
          !input ||
          Object.keys(input).some((k) => !['dateFrom', 'dateTo'].includes(k))
        )
          throw new AvitoError('invalid', 400);
        return json(response, 202, this.start(input));
      }
      if (request.method !== 'GET' || url.pathname.endsWith('/notes'))
        return json(response, 405, { error: 'Метод недоступен.' });
      if (
        [...url.searchParams.keys()].some(
          (k) =>
            !['dateFrom', 'dateTo'].includes(k) ||
            url.searchParams.getAll(k).length !== 1,
        )
      )
        throw new AvitoError('invalid', 400);
      return json(
        response,
        200,
        this.view(
          url.search
            ? Object.fromEntries(url.searchParams)
            : this.base.currentPeriod(),
        ),
      );
    } catch (error) {
      const safe =
        error instanceof AvitoError ? error : new AvitoError('storage');
      return json(response, safe.statusCode === 401 ? 502 : safe.statusCode, {
        error: safe.message,
        code: safe.code,
        retryAfterSeconds: safe.retryAfterSeconds,
      });
    }
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    await this.flight?.catch(() => {});
  }
}
