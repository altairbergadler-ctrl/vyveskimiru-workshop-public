import { AvitoError } from '../avito.mjs';

const DAY = 86400000;
export const responseDay = time => new Date(time + 3 * 3600000).toISOString().slice(0, 10);
export function responseSlots(now) {
  const start = Date.parse(responseDay(now) + 'T00:00:00+03:00');
  const slots = [-1, 0, 1].flatMap(d => [9, 18].map(h => start + d * DAY + h * 3600000));
  return { due: Math.max(...slots.filter(t => t <= now)), next: Math.min(...slots.filter(t => t > now)) };
}

// No message text, customer identity or AI is needed for this metric.
export function firstResponse(messages, complete) {
  const rows = [...new Map(messages.map(m => [m.id, m])).values()]
    .filter(m => !['system', 'call'].includes(m.type))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  if (!complete) return { state: 'unknown', firstIn: null, firstOut: null, seconds: null };
  const incoming = rows.find(m => m.direction === 'in');
  if (!incoming) return { state: 'no_incoming', firstIn: null, firstOut: null, seconds: null };
  const outgoing = rows.find(m => m.direction === 'out' && m.createdAt >= incoming.createdAt);
  return { state: outgoing ? 'answered' : 'waiting', firstIn: incoming.createdAt,
    firstOut: outgoing?.createdAt ?? null,
    seconds: outgoing ? (Date.parse(outgoing.createdAt) - Date.parse(incoming.createdAt)) / 1000 : null };
}

const empty = () => ({ secondsTotal: 0, answered: 0, waiting: 0, unknown: 0, averageSeconds: null });
export function aggregateResponses(rows, period) {
  const summary = empty(), items = {}, daily = {};
  let undated = 0;
  for (const row of rows) {
    if (row.state === 'unknown' || !row.first_in) { if (row.state === 'unknown') undated++; continue; }
    const date = responseDay(Date.parse(row.first_in));
    if (date < period.from || date > period.to) continue;
    const targets = [summary, items[row.item_id] ??= empty(), daily[date] ??= empty()];
    for (const target of targets) {
      if (row.state === 'answered') { target.secondsTotal += row.seconds; target.answered++; }
      else if (row.state === 'waiting') target.waiting++;
      else target.unknown++;
    }
  }
  for (const row of rows.filter(r => r.state === 'unknown')) (items[row.item_id] ??= empty()).unknown++;
  for (const value of [summary, ...Object.values(items), ...Object.values(daily)])
    value.averageSeconds = value.answered ? value.secondsTotal / value.answered : null;
  return { summary, items, daily, undated };
}

// Independent deterministic observer, sharing AvitoClient's persistent rate limits.
// It never writes attribution/inquiry tables and never calls the nightly AI agent.
export class ResponseTimes {
  constructor({ base, client, enabled = false, now = Date.now, canRun = () => true }) {
    Object.assign(this, { base, client, enabled, now, canRun });
    this.closed = false;
    this.flight = null;
    this.initialized = false;
  }
  db() {
    const db = this.base.storage();
    if (!this.initialized) {
      db.exec(`CREATE TABLE IF NOT EXISTS response_runs(
        account TEXT NOT NULL,slot INTEGER NOT NULL,state TEXT NOT NULL,started_at TEXT NOT NULL,
        finished_at TEXT,offset INTEGER NOT NULL DEFAULT 0,listed INTEGER NOT NULL DEFAULT 0,
        limited INTEGER NOT NULL DEFAULT 0,failed INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,code TEXT,PRIMARY KEY(account,slot));
        CREATE TABLE IF NOT EXISTS response_chats(
        account TEXT NOT NULL,chat_id TEXT NOT NULL,item_id TEXT NOT NULL,source_updated TEXT NOT NULL,
        last_message TEXT,first_in TEXT,first_out TEXT,seconds REAL,state TEXT NOT NULL,checked_at TEXT NOT NULL,
        slot INTEGER NOT NULL,PRIMARY KEY(account,chat_id));
        CREATE INDEX IF NOT EXISTS response_cohort ON response_chats(account,first_in);
        CREATE TABLE IF NOT EXISTS response_jobs(
        account TEXT NOT NULL,slot INTEGER NOT NULL,chat_id TEXT NOT NULL,item_id TEXT NOT NULL,
        source_updated TEXT NOT NULL,last_message TEXT,offset INTEGER NOT NULL DEFAULT 0,
        messages TEXT NOT NULL DEFAULT '[]',state TEXT NOT NULL DEFAULT 'queued',
        next_at INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(account,slot,chat_id));`);
      this.initialized = true;
    }
    return db;
  }
  start() {
    if (!this.enabled || this.timer || this.closed) return;
    const tick = async () => {
      try { await this.work(); } catch { /* Persisted jobs remain resumable; do not log private input. */ }
      if (!this.closed) { this.timer = setTimeout(tick, 1250); this.timer.unref(); }
    };
    this.timer = setTimeout(tick, 10000);
    this.timer.unref();
  }
  async work() {
    if (!this.enabled || this.closed || this.flight || !this.canRun()) return;
    this.flight = this.step();
    try { await this.flight; } finally { this.flight = null; }
  }
  async step() {
    const db = this.db(), account = this.base.namespace();
    if (!account) return;
    let run = db.prepare("SELECT * FROM response_runs WHERE account=? AND state='running' ORDER BY slot LIMIT 1").get(account);
    if (!run) {
      const slot = responseSlots(this.now()).due;
      db.prepare("INSERT OR IGNORE INTO response_runs(account,slot,state,started_at) VALUES(?,?,'running',?)")
        .run(account, slot, new Date(this.now()).toISOString());
      run = db.prepare("SELECT * FROM response_runs WHERE account=? AND slot=? AND state='running'").get(account, slot);
    }
    if (!run || run.next_at > this.now()) return;
    let job;
    try {
      if (!run.listed) {
        const page = await this.client.conversations({ offset: run.offset });
        if (page.accountId !== account) throw new AvitoError('account_mismatch', 409);
        db.transaction(() => {
          for (const chat of page.chats) {
            if (Date.parse(chat.updatedAt) < this.now() - 270 * DAY) continue;
            const old = db.prepare('SELECT * FROM response_chats WHERE account=? AND chat_id=?').get(account, chat.id);
            if (old && old.source_updated === chat.updatedAt && old.last_message === chat.lastMessageId && old.item_id === chat.itemId) {
              db.prepare('UPDATE response_chats SET slot=?,checked_at=? WHERE account=? AND chat_id=?')
                .run(run.slot, new Date(this.now()).toISOString(), account, chat.id);
            } else {
              db.prepare('INSERT OR IGNORE INTO response_jobs(account,slot,chat_id,item_id,source_updated,last_message) VALUES(?,?,?,?,?,?)')
                .run(account, run.slot, chat.id, chat.itemId, chat.updatedAt, chat.lastMessageId);
            }
          }
          db.prepare('UPDATE response_runs SET offset=?,listed=?,limited=?,attempts=0,code=NULL WHERE account=? AND slot=?')
            .run(run.offset + 100, !page.hasMore || run.offset >= 1000 ? 1 : 0, page.hasMore && run.offset >= 1000 ? 1 : 0, account, run.slot);
        })();
        return;
      }
      job = db.prepare("SELECT * FROM response_jobs WHERE account=? AND slot=? AND state='queued' AND next_at<=? ORDER BY chat_id LIMIT 1")
        .get(account, run.slot, this.now());
      if (!job) {
        if (!db.prepare("SELECT 1 FROM response_jobs WHERE account=? AND slot=? AND state='queued'").get(account, run.slot)) {
          db.prepare("UPDATE response_runs SET state=?,finished_at=? WHERE account=? AND slot=?")
            .run(run.failed || run.limited ? 'partial' : 'done', new Date(this.now()).toISOString(), account, run.slot);
          // Temporary metadata only; completed jobs no longer need page buffers.
          db.prepare('UPDATE response_jobs SET messages=\'[]\' WHERE account=? AND slot=?').run(account, run.slot);
        }
        return;
      }
      const page = await this.client.conversationMessages({ chatId: job.chat_id, offset: job.offset });
      const messages = [...JSON.parse(job.messages), ...page.messages.map(m => ({ id: m.id, createdAt: m.createdAt, direction: m.direction, type: m.type }))];
      if (page.hasMore && job.offset < 900) {
        db.prepare('UPDATE response_jobs SET messages=?,offset=offset+100,attempts=0 WHERE account=? AND slot=? AND chat_id=?')
          .run(JSON.stringify(messages), account, run.slot, job.chat_id);
        return;
      }
      const result = firstResponse(messages, !page.hasMore);
      // If the profile changed during pagination, the next scheduled sweep re-reads it.
      db.transaction(() => {
        db.prepare(`INSERT INTO response_chats VALUES(?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(account,chat_id) DO UPDATE SET item_id=excluded.item_id,source_updated=excluded.source_updated,
          last_message=excluded.last_message,first_in=excluded.first_in,first_out=excluded.first_out,
          seconds=excluded.seconds,state=excluded.state,checked_at=excluded.checked_at,slot=excluded.slot`)
          .run(account, job.chat_id, job.item_id, job.source_updated, job.last_message,
            result.firstIn, result.firstOut, result.seconds, result.state, new Date(this.now()).toISOString(), run.slot);
        db.prepare("UPDATE response_jobs SET state='done',messages='[]' WHERE account=? AND slot=? AND chat_id=?")
          .run(account, run.slot, job.chat_id);
      })();
    } catch (error) {
      const code = error instanceof AvitoError ? error.code : 'storage';
      const attempts = (job?.attempts ?? run.attempts) + 1;
      const retry = code === 'rate_limit' || (['unavailable', 'storage'].includes(code) && attempts < 4);
      const next = this.now() + Math.max(5, error.retryAfterSeconds || Math.min(300, 15 * attempts)) * 1000;
      if (code === 'rate_limit') {
        // Provider-wide cooldown: do not probe another chat while this limit is active.
        db.prepare('UPDATE response_runs SET next_at=?,code=? WHERE account=? AND slot=?').run(next, code, account, run.slot);
      }
      if (job && retry) {
        db.prepare('UPDATE response_jobs SET next_at=?,attempts=? WHERE account=? AND slot=? AND chat_id=?')
          .run(next, code === 'rate_limit' ? job.attempts : attempts, account, run.slot, job.chat_id);
      } else if (job && !['unauthorized', 'forbidden', 'account_mismatch', 'credentials', 'configuration'].includes(code)) {
        db.prepare("UPDATE response_jobs SET state='failed',messages='[]' WHERE account=? AND slot=? AND chat_id=?").run(account, run.slot, job.chat_id);
        db.prepare('UPDATE response_runs SET failed=failed+1,code=? WHERE account=? AND slot=?').run(code, account, run.slot);
      } else {
        db.prepare('UPDATE response_runs SET next_at=?,attempts=?,code=?,state=?,finished_at=? WHERE account=? AND slot=?')
          .run(next, code === 'rate_limit' ? run.attempts : attempts, code, retry ? 'running' : 'failed', retry ? null : new Date(this.now()).toISOString(), account, run.slot);
      }
    }
  }
  view(period) {
    const db = this.db(), account = this.base.namespace();
    const run = db.prepare('SELECT * FROM response_runs WHERE account=? ORDER BY slot DESC LIMIT 1').get(account);
    const rows = db.prepare('SELECT * FROM response_chats WHERE account=?').all(account);
    const result = aggregateResponses(rows, period);
    const pending = run ? db.prepare("SELECT count(*) AS n FROM response_jobs WHERE account=? AND slot=? AND state='queued'").get(account, run.slot).n : 0;
    const unverified = run ? rows.filter(r => r.slot !== run.slot).length : rows.length;
    const stale = !run?.finished_at || run.slot < responseSlots(this.now()).due;
    return { ...result, enabled: this.enabled, schedule: ['09:00', '18:00'], timezone: 'Europe/Moscow',
      nextAt: this.enabled ? responseSlots(this.now()).next : null, loadedAt: run?.finished_at ?? null,
      state: !this.enabled ? 'disabled' : run?.state ?? 'pending',
      partial: !run || run.state !== 'done' || stale || unverified > 0 || result.undated > 0,
      stale, indexedChats: rows.length, unverified, pending, failed: run?.failed ?? 0,
      indexLimited: Boolean(run?.limited), code: run?.code ?? null };
  }
  async close() { this.closed = true; clearTimeout(this.timer); await this.flight; }
}
