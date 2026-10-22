import crypto from 'node:crypto';
import { AvitoError } from '../avito.mjs';
import { messageSignals } from '../avito-inquiries.mjs';
const DAY = 86400000;
export class InquiryImport {
  constructor({
    base,
    client,
    now = Date.now,
    scheduler = true,
    automatic = process.env.AVITO_AUTO_IMPORT === 'true',
  }) {
    Object.assign(this, { base, client, now, scheduler });
    this.automatic = automatic && client.status().enabled;
    this.closed = false;
    this.flight = null;
    this.initialized = false;
    if (client.status().enabled) this.wake(this.automatic ? 60000 : 1100);
  }
  db() {
    const db = this.base.storage();
    if (!this.initialized) {
      db.exec(`CREATE TABLE IF NOT EXISTS inquiry_keys(account TEXT PRIMARY KEY,secret TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS inquiry_runs(id TEXT PRIMARY KEY,account TEXT NOT NULL,created_at TEXT NOT NULL,finished_at TEXT,state TEXT NOT NULL,automatic INTEGER NOT NULL,limited INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS inquiry_steps(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,kind TEXT NOT NULL,params TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,code TEXT,output TEXT);
        CREATE INDEX IF NOT EXISTS inquiry_queue ON inquiry_steps(state,next_at,id);
        CREATE TABLE IF NOT EXISTS inquiry_snapshots(id INTEGER PRIMARY KEY AUTOINCREMENT,account TEXT NOT NULL,run_id TEXT NOT NULL,chat_id TEXT NOT NULL,kind TEXT NOT NULL,observed_at TEXT NOT NULL,hash TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS inquiry_latest ON inquiry_snapshots(account,chat_id,kind,id DESC);`);
      db.prepare(
        "UPDATE inquiry_steps SET state='queued' WHERE state='running'",
      ).run();
      this.initialized = true;
    }
    return db;
  }
  secret() {
    const db = this.db(),
      account = this.base.namespace();
    if (!account) throw new AvitoError('configuration', 409);
    db.prepare(
      'INSERT OR IGNORE INTO inquiry_keys(account,secret) VALUES(?,?)',
    ).run(account, crypto.randomBytes(32).toString('hex'));
    return db
      .prepare('SELECT secret FROM inquiry_keys WHERE account=?')
      .get(account).secret;
  }
  add(run, kind, params) {
    this.db()
      .prepare('INSERT INTO inquiry_steps(run_id,kind,params) VALUES(?,?,?)')
      .run(run, kind, JSON.stringify(params));
  }
  start(automatic = false) {
    if (!this.client.status().enabled) throw new AvitoError('disabled', 409);
    const db = this.db(),
      account = this.base.namespace();
    if (!account) throw new AvitoError('configuration', 409);
    const active = db
      .prepare(
        "SELECT id FROM inquiry_runs WHERE account=? AND state IN ('queued','running') ORDER BY created_at DESC LIMIT 1",
      )
      .get(account);
    if (active) return { jobId: active.id, existing: true };
    const recent = db
      .prepare(
        'SELECT created_at FROM inquiry_runs WHERE account=? ORDER BY created_at DESC LIMIT 1',
      )
      .get(account);
    if (recent && this.now() - Date.parse(recent.created_at) < 60000)
      throw new AvitoError('rate_limit', 429, 60);
    const id = crypto.randomUUID();
    db.transaction(() => {
      db.prepare(
        'INSERT INTO inquiry_runs(id,account,created_at,state,automatic) VALUES(?,?,?,?,?)',
      ).run(
        id,
        account,
        new Date(this.now()).toISOString(),
        'queued',
        automatic ? 1 : 0,
      );
      this.add(id, 'chats', { offset: 0 });
    })();
    this.wake(0);
    return { jobId: id, existing: false };
  }
  snapshot(run, chat, kind, data) {
    const payload = JSON.stringify(data);
    this.db()
      .prepare(
        'INSERT INTO inquiry_snapshots(account,run_id,chat_id,kind,observed_at,hash,payload) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        run.account,
        run.id,
        chat,
        kind,
        new Date(this.now()).toISOString(),
        crypto.createHash('sha256').update(payload).digest('hex'),
        payload,
      );
  }
  latest(chat, kind) {
    return this.db()
      .prepare(
        'SELECT * FROM inquiry_snapshots WHERE account=? AND chat_id=? AND kind=? ORDER BY id DESC LIMIT 1',
      )
      .get(this.base.namespace(), chat, kind);
  }
  async step(row, run) {
    const p = JSON.parse(row.params),
      db = this.db();
    if (row.kind === 'chats') {
      const value = await this.client.conversations(p);
      if (value.accountId !== run.account)
        throw new AvitoError('account_mismatch', 409);
      return db.transaction(() => {
        for (const chat of value.chats)
          if (Date.parse(chat.updatedAt) >= this.now() - 270 * DAY) {
            this.snapshot(run, chat.id, 'profile', chat);
          }
        const output = {
          received: value.received,
          excluded: value.excluded,
          owned: value.chats.length,
        };
        if (value.hasMore && p.offset < 1000)
          this.add(run.id, 'chats', { offset: p.offset + 100 });
        else {
          if (value.hasMore)
            db.prepare('UPDATE inquiry_runs SET limited=1 WHERE id=?').run(
              run.id,
            );
          const profiles = db
            .prepare(
              "SELECT * FROM inquiry_snapshots WHERE run_id=? AND kind='profile' ORDER BY id ASC",
            )
            .all(run.id);
          const unique = [
            ...new Map(
              profiles.map((v) => [v.chat_id, JSON.parse(v.payload)]),
            ).values(),
          ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          let requested = 0;
          for (const chat of unique) {
            const prior = this.latest(chat.id, 'signals'),
              old = prior ? JSON.parse(prior.payload) : null;
            if (
              old &&
              old.sourceUpdatedAt === chat.updatedAt &&
              old.lastMessageId === chat.lastMessageId
            )
              continue;
            if (requested++ >= 250) {
              db.prepare('UPDATE inquiry_runs SET limited=1 WHERE id=?').run(
                run.id,
              );
              continue;
            }
            this.add(run.id, 'messages', {
              chatId: chat.id,
              sourceUpdatedAt: chat.updatedAt,
              lastMessageId: chat.lastMessageId,
            });
          }
        }
        db.prepare(
          "UPDATE inquiry_steps SET state='done',code=NULL,output=? WHERE id=?",
        ).run(JSON.stringify(output), row.id);
        return output;
      })();
    }
    const value = await this.client.conversationMessages({ chatId: p.chatId });
    const signals = {
      ...messageSignals(value.messages, this.secret(), value.hasMore),
      sourceUpdatedAt: p.sourceUpdatedAt,
      lastMessageId: p.lastMessageId,
    };
    return db.transaction(() => {
      this.snapshot(run, p.chatId, 'signals', signals);
      const output = {
        messages: value.messages.length,
        incoming: signals.incomingCount,
        limited: value.hasMore,
      };
      db.prepare(
        "UPDATE inquiry_steps SET state='done',code=NULL,output=? WHERE id=?",
      ).run(JSON.stringify(output), row.id);
      return output;
    })();
  }
  async work() {
    if (this.closed || this.flight) return;
    const db = this.db(),
      account = this.base.namespace();
    const row = db
      .prepare(
        "SELECT s.* FROM inquiry_steps s JOIN inquiry_runs r ON r.id=s.run_id WHERE r.account=? AND s.state='queued' AND s.next_at<=? ORDER BY s.id LIMIT 1",
      )
      .get(account, this.now());
    if (!row) {
      db.prepare(
        "UPDATE inquiry_runs SET state=CASE WHEN limited=1 OR EXISTS(SELECT 1 FROM inquiry_steps WHERE run_id=inquiry_runs.id AND state='failed') THEN 'partial' ELSE 'done' END,finished_at=? WHERE account=? AND state IN ('queued','running') AND NOT EXISTS(SELECT 1 FROM inquiry_steps WHERE run_id=inquiry_runs.id AND state IN ('queued','running'))",
      ).run(new Date(this.now()).toISOString(), account);
      return;
    }
    const run = db
      .prepare('SELECT * FROM inquiry_runs WHERE id=?')
      .get(row.run_id);
    db.prepare("UPDATE inquiry_runs SET state='running' WHERE id=?").run(
      run.id,
    );
    db.prepare(
      "UPDATE inquiry_steps SET state='running',attempts=attempts+1 WHERE id=?",
    ).run(row.id);
    this.flight = (async () => {
      try {
        await this.step(row, run);
      } catch (error) {
        const code = error instanceof AvitoError ? error.code : 'storage';
        const retry =
          (code === 'rate_limit' && row.attempts < 12) ||
          (['unavailable', 'storage', 'closed'].includes(code) &&
            row.attempts < 3);
        db.prepare(
          'UPDATE inquiry_steps SET state=?,code=?,next_at=? WHERE id=?',
        ).run(
          retry ? 'queued' : 'failed',
          code,
          this.now() +
            (code === 'rate_limit'
              ? Math.max(1, error.retryAfterSeconds || 65)
              : 65 * (row.attempts + 1)) *
              1000,
          row.id,
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
    if (!this.scheduler || this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      try {
        if (this.automatic) {
          const last = this.db()
            .prepare(
              'SELECT created_at FROM inquiry_runs WHERE account=? ORDER BY created_at DESC LIMIT 1',
            )
            .get(this.base.namespace());
          if (!last || this.now() - Date.parse(last.created_at) >= 30 * 60000) {
            try {
              this.start(true);
            } catch {
              /* Existing work still drains. */
            }
          }
        }
        await this.work();
      } catch {
        /* Import failures do not block business operations. */
      }
      if (!this.closed) this.wake(1100);
    }, ms);
    this.timer.unref();
  }
  view() {
    if (!this.client.status().enabled)
      return { enabled: false, chats: [], jobs: [], automatic: false };
    const db = this.db(),
      account = this.base.namespace();
    const versions = db
      .prepare(
        'SELECT * FROM (SELECT *,ROW_NUMBER() OVER(PARTITION BY chat_id,kind ORDER BY id DESC) AS rank FROM inquiry_snapshots WHERE account=?) WHERE rank=1',
      )
      .all(account);
    const chats = versions
      .filter((v) => v.kind === 'profile')
      .map((row) => {
        const profile = JSON.parse(row.payload),
          signals = versions.find(
            (v) => v.chat_id === row.chat_id && v.kind === 'signals',
          );
        return {
          ...profile,
          observedAt: row.observed_at,
          signals: signals ? JSON.parse(signals.payload) : null,
          signalsAt: signals?.observed_at || null,
        };
      });
    const jobs = db
      .prepare(
        "SELECT r.id,r.created_at AS createdAt,r.finished_at AS finishedAt,r.state,r.limited,r.automatic,(SELECT count(*) FROM inquiry_steps s WHERE s.run_id=r.id) AS total,(SELECT count(*) FROM inquiry_steps s WHERE s.run_id=r.id AND s.state='done') AS done,(SELECT count(*) FROM inquiry_steps s WHERE s.run_id=r.id AND s.state='failed') AS failed FROM inquiry_runs r WHERE account=? ORDER BY created_at DESC LIMIT 10",
      )
      .all(account);
    const newest = jobs[0];
    const errors = newest
      ? db
          .prepare(
            'SELECT kind,state,code,next_at AS nextAt FROM inquiry_steps WHERE run_id=? AND code IS NOT NULL',
          )
          .all(newest.id)
      : [];
    return {
      enabled: true,
      chats,
      jobs,
      errors,
      automatic: this.automatic,
      intervalMinutes: 30,
      limits: {
        chatOffset: 1000,
        changedChatsPerRun: 250,
        messagesPerChat: 100,
        historyDays: 270,
      },
    };
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    await this.flight?.catch(() => {});
  }
}
