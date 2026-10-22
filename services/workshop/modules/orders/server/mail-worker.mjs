import crypto from 'node:crypto';
import { parseLayoutEmail, attachmentSource, matchOrders } from './mail-import.mjs';
import { MediaError } from './media.mjs';
import { DiskAttachmentSource } from './mail-links.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();

export class MailWorker {
  constructor({ db, source, mediaStore, readOrders, runCommand = action => action(), maxSpoolBytes = 512 * 1024 * 1024, assistantMode = 'none', linkSource = new DiskAttachmentSource() }) {
    Object.assign(this, { db, source, mediaStore, readOrders, runCommand, maxSpoolBytes, linkSource });
    this.preparing = new Map();
    this.downloads = Promise.resolve();
    this.assistantMode = assistantMode === 'desktop' ? 'desktop' : 'none';
    this.accountKey = hash(source.identity);
    this.state = source.configured ? 'ready' : 'awaiting_key';
    this.lastSuccessAt = null; this.lastError = null; this.pending = null; this.timer = null; this.stopped = false;
    db.exec(`CREATE TABLE IF NOT EXISTS mail_cursor (account_key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mail_messages (key TEXT PRIMARY KEY, account_key TEXT NOT NULL, raw BLOB,
      state TEXT NOT NULL, details TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL, attempted_at TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS mail_queue ON mail_messages(account_key,state,attempted_at);
      CREATE TABLE IF NOT EXISTS mail_link_files (source_key TEXT PRIMARY KEY, bytes BLOB, details TEXT NOT NULL, retry_at TEXT NOT NULL DEFAULT '');`);
    // Additive upgrade: reparse retained mail, including previously 'done' HTML-only letters.
    db.prepare("UPDATE mail_messages SET state='pending',attempted_at='' WHERE account_key=? AND raw IS NOT NULL AND state IN ('done','review') AND COALESCE(json_extract(details,'$.parserVersion'),0)<2").run(this.accountKey);
  }
  start() {
    if (this.timer || this.stopped) return;
    if (this.source.configured) void this.tick();
    this.timer = setInterval(() => { if (this.source.configured) void this.tick(); }, 60_000); this.timer.unref();
  }
  async stop() { this.stopped = true; clearInterval(this.timer); this.source.close?.(); await this.pending; await Promise.allSettled(this.preparing.values()); }
  status() {
    return { state: this.state, assistantMode: this.assistantMode, lastSuccessAt: this.lastSuccessAt, lastError: this.lastError,
      counts: Object.fromEntries(this.db.prepare('SELECT state, count(*) AS n FROM mail_messages WHERE account_key=? GROUP BY state').all(this.accountKey).map(row => [row.state, row.n])) };
  }
  queue() {
    return { ...this.status(), messages: this.db.prepare("SELECT key,state,details FROM mail_messages WHERE account_key=? ORDER BY CASE state WHEN 'review' THEN 0 WHEN 'error' THEN 1 ELSE 2 END, updated_at DESC LIMIT 50")
      .all(this.accountKey).map(row => ({ key: row.key, state: row.state, ...JSON.parse(row.details) })) };
  }
  tick() {
    if (this.stopped || !this.source.configured) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.cycle().catch(() => { this.state = 'error'; this.lastError = 'MAIL_SYNC_FAILED'; }).finally(() => { this.pending = null; });
    return this.pending;
  }
  async cycle() {
    this.state = 'syncing';
    const cursor = JSON.parse(this.db.prepare('SELECT value FROM mail_cursor WHERE account_key=?').get(this.accountKey)?.value || '{}');
    const batch = await this.source.scan(cursor);
    if (this.stopped) return;
    // Mail and cursor commit together. A crash cannot advance past an unstaged email.
    this.db.transaction(() => {
      let used = this.spoolBytes();
      for (const message of batch.messages) {
        const key = hash(`${this.accountKey}\n${batch.cursor.validity}\n${message.uid}`);
        if (this.db.prepare('SELECT key FROM mail_messages WHERE key=?').get(key)) continue;
        used += message.raw?.length || 0;
        if (used > this.maxSpoolBytes) throw new Error('MAIL_SPOOL_FULL');
        this.db.prepare('INSERT INTO mail_messages(key,account_key,raw,state,details,updated_at) VALUES(?,?,?,?,?,?)')
          .run(key, this.accountKey, message.raw || null, message.error ? 'error' : 'pending', JSON.stringify(message.error ? { error: message.error } : {}), now());
      }
      this.db.prepare('INSERT INTO mail_cursor VALUES(?,?) ON CONFLICT(account_key) DO UPDATE SET value=excluded.value').run(this.accountKey, JSON.stringify(batch.cursor));
    })();
    const rows = this.db.prepare("SELECT * FROM mail_messages WHERE account_key=? AND state IN ('pending','review') ORDER BY attempted_at, key LIMIT 3").all(this.accountKey);
    for (const row of rows) {
      if (this.stopped) return;
      await this.prepare(row);
      if (this.stopped) return;
      await this.runCommand(() => this.process(row));
    }
    this.state = 'ready'; this.lastSuccessAt = now(); this.lastError = null;
  }
  save(row, details, state) {
    this.db.prepare('UPDATE mail_messages SET state=?,details=?,updated_at=?,attempted_at=? WHERE key=?').run(state, JSON.stringify(details), now(), now(), row.key);
  }
  spoolBytes() {
    return this.db.prepare('SELECT (SELECT COALESCE(sum(length(raw)),0) FROM mail_messages) + (SELECT COALESCE(sum(length(bytes)),0) FROM mail_link_files) AS n').get().n;
  }
  prepare(row) {
    if (this.preparing.has(row.key)) return this.preparing.get(row.key);
    const pending = this.prepareLinks(row).finally(() => this.preparing.delete(row.key));
    this.preparing.set(row.key, pending);
    return pending;
  }
  async prepareLinks(row) {
    let parsed;
    try { parsed = await parseLayoutEmail(row.raw); } catch { return; }
    if (parsed.message.from !== this.source.sender) return;
    for (const item of parsed.attachments.filter(item => item.link)) {
      if (this.stopped) return;
      const key = attachmentSource(parsed.message, item.partId).key;
      const cached = this.db.prepare('SELECT bytes IS NOT NULL AS downloaded,retry_at FROM mail_link_files WHERE source_key=?').get(key);
      if (cached?.downloaded || cached?.retry_at > now()) continue;
      try {
        // Network work stays outside the shared business-command queue.
        const action = this.downloads.then(() => this.stopped ? Promise.reject(new Error('stopped')) : this.linkSource.download(item.link));
        this.downloads = action.then(() => undefined, () => undefined);
        const { bytes, ...details } = await action;
        if (this.stopped) return;
        if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 64 * 1024 * 1024 || hash(bytes) !== details.contentHash) throw new MediaError('MAIL_LINK_CHANGED', 'Файл не прошёл проверку.');
        this.db.transaction(() => {
          if (this.db.prepare('SELECT 1 FROM mail_link_files WHERE source_key=? AND bytes IS NOT NULL').get(key)) return;
          if (this.spoolBytes() + bytes.length > this.maxSpoolBytes) throw new MediaError('MAIL_SPOOL_FULL', 'Хранилище почты заполнено.');
          this.db.prepare("INSERT INTO mail_link_files VALUES(?,?,?,'') ON CONFLICT(source_key) DO UPDATE SET bytes=excluded.bytes,details=excluded.details,retry_at=''").run(key, bytes, JSON.stringify(details));
        })();
      } catch (error) {
        const code = /^(MAIL_LINK_[A-Z_]+|MEDIA_[A-Z_]+|MAIL_SPOOL_FULL)$/.test(error.code || '') ? error.code : 'MAIL_LINK_UNAVAILABLE';
        this.db.prepare('INSERT INTO mail_link_files VALUES(?,NULL,?,?) ON CONFLICT(source_key) DO UPDATE SET details=excluded.details,retry_at=excluded.retry_at WHERE bytes IS NULL')
          .run(key, JSON.stringify({ error: code }), new Date(Date.now() + 3600_000).toISOString());
      }
    }
  }
  async process(row, selection) {
    // Reread inside the shared command queue: the user may have resolved this row.
    row = this.db.prepare('SELECT * FROM mail_messages WHERE key=? AND account_key=?').get(row.key, this.accountKey);
    if (!row?.raw) throw new MediaError('MAIL_NOT_FOUND', 'Письмо не найдено.', 404);
    let parsed;
    try { parsed = await parseLayoutEmail(row.raw); }
    catch { this.save(row, { error: 'MAIL_INVALID' }, 'error'); return; }
    if (parsed.message.from !== this.source.sender) {
      this.save(row, { error: 'MAIL_SENDER_MISMATCH' }, 'ignored');
      this.db.prepare('UPDATE mail_messages SET raw=NULL WHERE key=?').run(row.key); return;
    }
    const previous = JSON.parse(row.details).attachments || [];
    const orders = await this.readOrders();
    const results = [];
    for (let attachment of parsed.attachments) {
      const prior = previous.find(value => value.partId === attachment.partId);
      if (prior?.state === 'imported') {
        if (selection?.partId === attachment.partId && selection.orderId !== prior.orderId) throw new MediaError('MAIL_IMPORT_CONFLICT', 'Вложение уже находится в другом заказе.', 409);
        results.push(prior); continue;
      }
      if (attachment.link) {
        const staged = this.db.prepare('SELECT * FROM mail_link_files WHERE source_key=?').get(attachmentSource(parsed.message, attachment.partId).key);
        const details = staged ? JSON.parse(staged.details) : {};
        if (!staged?.bytes) {
          results.push({ ...attachment, state: 'review', error: details.error || 'MAIL_LINK_PENDING', retryAt: staged?.retry_at || null });
          continue;
        }
        attachment = { ...attachment, ...details, bytes: staged.bytes };
      }
      const { bytes: _bytes, ...item } = attachment;
      if (!item.supported) { results.push({ ...item, state: 'unsupported' }); continue; }
      const candidates = matchOrders(parsed.message, item.name, orders);
      // Candidates assist the agent; keywords alone never authorize a business link.
      const orderId = selection?.partId === item.partId ? selection.orderId : null;
      if (!orderId) { results.push({ ...item, candidates, state: 'review' }); continue; }
      if (!orders.some(order => order.id === orderId)) throw new MediaError('MAIL_ORDER_MISSING', 'Заказ не найден.', 404);
      try {
        const media = await this.mediaStore.add(orderId, { ...attachment, source: { ...attachmentSource(parsed.message, item.partId), messageKey: row.key,
          ...(item.publicUrl ? { publicUrl: item.publicUrl } : {}) } });
        results.push({ ...item, state: 'imported', orderId, mediaId: media.id,
          decision: { by: 'assistant', reason: selection.reason, at: now() } });
      } catch (error) {
        if (!['MAIL_IMPORT_CONFLICT', 'MAIL_IMPORT_DELETED'].includes(error.code)) throw error;
        results.push({ ...item, candidates, state: 'review', error: error.code });
      }
    }
    this.save(row, { parserVersion: 2, message: parsed.message, attachments: results }, results.some(item => item.state === 'review') ? 'review' : 'done');
  }
  async resolve({ messageKey, partId, orderId, reason } = {}) {
    if (!/^[a-f0-9]{64}$/.test(messageKey) || !/^\d{1,2}$/.test(partId) || typeof orderId !== 'string' || !orderId || orderId.length > 200 ||
        typeof reason !== 'string' || reason.trim().length < 10 || reason.length > 2000) throw new MediaError('MAIL_SELECTION', 'Укажите письмо, вложение, заказ и обоснование привязки.');
    const row = this.db.prepare('SELECT * FROM mail_messages WHERE key=? AND account_key=?').get(messageKey, this.accountKey);
    const item = row && JSON.parse(row.details).attachments?.find(value => value.partId === partId);
    if (!item || !['review', 'imported'].includes(item.state)) throw new MediaError('MAIL_NOT_FOUND', 'Вложение для привязки не найдено.', 404);
    if (item.state === 'imported' && item.orderId !== orderId) throw new MediaError('MAIL_IMPORT_CONFLICT', 'Вложение уже находится в другом заказе.', 409);
    await this.prepare(row);
    await this.runCommand(() => this.process(row, { partId, orderId, reason: reason.trim() }));
    return this.queue();
  }
}
