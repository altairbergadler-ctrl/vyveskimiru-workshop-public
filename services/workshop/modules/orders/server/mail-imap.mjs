import fs from 'node:fs/promises';
import { ImapFlow } from 'imapflow';
import { MAX_EMAIL_BYTES } from './mail-import.mjs';

export class MailImapSource {
  constructor({ enabled = false, user = '', passwordFile = '', sender = '', folder = 'INBOX', since = '', clientFactory = options => new ImapFlow(options) } = {}) {
    if (since && (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !Number.isFinite(Date.parse(since)) || new Date(since).toISOString().slice(0, 10) !== since)) throw new Error('MAIL_SINCE_INVALID');
    Object.assign(this, { user, passwordFile, sender: sender.toLowerCase(), folder, since, clientFactory });
    this.configured = enabled && Boolean(user && passwordFile && sender);
    this.identity = `${user.toLowerCase()}\n${folder}\n${this.sender}`;
    this.client = null;
  }
  close() { this.client?.close(); }
  async scan(cursor = {}) {
    if (!this.configured) throw new Error('MAIL_NOT_CONFIGURED');
    const secret = await fs.readFile(this.passwordFile, 'utf8');
    if (!secret.trim() || secret.length > 4096) throw new Error('MAIL_KEY_INVALID');
    const client = this.clientFactory({ host: 'imap.mail.ru', port: 993, secure: true,
      auth: { user: this.user, pass: secret.trim() }, logger: false, emitLogs: false,
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
      tls: { rejectUnauthorized: true }, disableAutoIdle: true });
    this.client = client;
    client.on('error', () => {}); // Caller reports a fixed error code, never protocol logs.
    let lock;
    try {
      await client.connect();
      lock = await client.getMailboxLock(this.folder, { readOnly: true });
      const validity = String(client.mailbox.uidValidity);
      let lastUid = cursor.validity === validity ? Number(cursor.lastUid || 0) : 0;
      if (cursor.validity !== validity && this.since) {
        const initial = await client.search({ from: this.sender, since: new Date(this.since) }, { uid: true });
        const first = (initial || []).reduce((min, uid) => Math.min(min, uid), client.mailbox.uidNext);
        lastUid = Math.max(0, first - 1);
      }
      const high = Math.min(lastUid + 500, client.mailbox.uidNext - 1);
      if (high <= lastUid) return { cursor: { validity, lastUid }, messages: [] };
      const found = await client.search({ from: this.sender, uid: `${lastUid + 1}:${high}` }, { uid: true });
      const uids = (found || []).filter(uid => uid > lastUid && uid <= high).sort((a, b) => a - b).slice(0, 3);
      const messages = [];
      for (const uid of uids) {
        const envelope = await client.fetchOne(uid, { size: true }, { uid: true });
        if (!envelope) continue; // Message was removed externally between search and fetch.
        if (envelope.size > MAX_EMAIL_BYTES) { messages.push({ uid, error: 'MAIL_SIZE' }); continue; }
        const fetched = await client.fetchOne(uid, { source: { start: 0, maxLength: MAX_EMAIL_BYTES + 1 } }, { uid: true });
        if (!fetched) continue;
        if (!Buffer.isBuffer(fetched.source)) throw new Error('MAIL_FETCH_INCOMPLETE');
        messages.push(fetched.source.length > MAX_EMAIL_BYTES ? { uid, error: 'MAIL_SIZE' } : { uid, raw: fetched.source });
      }
      return { cursor: { validity, lastUid: uids.length === 3 ? uids.at(-1) : high }, messages };
    } finally {
      lock?.release();
      try { await client.logout(); } catch { client.close(); }
      this.client = null;
    }
  }
}
