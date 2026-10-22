import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const contentDigest = m => { const content = { ...m }; delete content.folder; delete content.uid; delete content.uidValidity; return digest(content); };
const identityOf = m => ({ messageId: m.messageId, from: m.from, subject: m.subject, sentAt: m.sentAt });
export const terminal = j => ['verified', 'duplicate', 'irrelevant'].includes(j?.outcome);
export function sameEmail(a, b) {
  return Boolean(a.messageId && a.messageId === b.messageId && String(a.from).toLowerCase() === String(b.from).toLowerCase()
    && a.subject === b.subject && Math.abs(Date.parse(a.sentAt) - Date.parse(b.sentAt)) <= 5000);
}
export function pending(snapshot, journal) {
  return snapshot.messages.filter(m => m.state !== 'done' && !(terminal(journal[m.key]) && journal[m.key].contentRevision === contentDigest(m)) && journal[m.key]?.revision !== digest([m, snapshot.boardHash]));
}
export function acknowledge(snapshot, journal, key, revision, outcome, note) {
  const m = snapshot.messages.find(x => x.key === key);
  if (!m || digest([m, snapshot.boardHash]) !== revision) throw Error('STALE_REVISION');
  if (!['asked', 'deferred', 'verified', 'duplicate', 'irrelevant'].includes(outcome)) throw Error('INVALID_OUTCOME');
  if (!note || note.length > 2000) throw Error('NOTE_REQUIRED');
  return { ...journal, [key]: { revision, contentRevision: contentDigest(m), identity: identityOf(m.message), outcome, note, asked: outcome === 'asked' || journal[key]?.asked === true, at: new Date().toISOString() } };
}
export function trimRuns(runs, now = Date.now()) {
  return runs.filter(r => Number.isFinite(Date.parse(r.at)) && Date.parse(r.at) >= now - 7 * 86400000).slice(-200);
}
export function assertLease(lease, runId, now = Date.now()) {
  if (!runId || lease?.runId !== runId || lease.expiresAt <= now) throw Error('LEASE_REQUIRED');
}
export function canDropCache(m, journal, now = Date.now()) {
  const j = journal[m.key];
  return terminal(j) && j.contentRevision === contentDigest(m) && Date.parse(j.at) < now - 30 * 86400000;
}
export function page(value, offset = 0) {
  const text = JSON.stringify(value);
  if (!Number.isInteger(offset) || offset < 0) throw Error('INVALID_OFFSET');
  return { offset, total: text.length, next: offset + 6000 < text.length ? offset + 6000 : null, data: text.slice(offset, offset + 6000) };
}

async function main(request) {
  const dir = '/data/mail-assistant-v2';
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  let lock;
  try { lock = await fs.open(dir + '/lock', 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw Error('RUN_LOCKED'); throw e; }
  const read = async (name, fallback) => {
    try { return JSON.parse(await fs.readFile(`${dir}/${name}.json`, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return fallback; throw Error('STATE_INVALID'); }
  };
  const write = async (name, value) => {
    const path = `${dir}/${name}.json`;
    await fs.writeFile(path + '.tmp', JSON.stringify(value), { mode: 0o600 });
    await fs.rename(path + '.tmp', path);
  };
  try {
    let snapshot = await read('snapshot', null);
    let journal = await read('journal', {});
    let lease = await read('lease', null);
    if (request.action === 'begin') {
      if (!/^[a-zA-Z0-9-]{8,80}$/.test(request.runId || '')) throw Error('INVALID_RUN_ID');
      if (lease && lease.expiresAt > Date.now() && lease.runId !== request.runId) throw Error('RUN_ACTIVE');
      lease = { runId: request.runId, expiresAt: Date.now() + 20 * 60000 };
      await write('lease', lease);
      console.log(JSON.stringify({ state: 'started', runId: lease.runId }));
      return;
    }
    assertLease(lease, request.runId);
    if (request.action === 'finish') {
      await write('lease', { ...lease, expiresAt: 0 });
      console.log(JSON.stringify({ state: 'finished' }));
      return;
    }
    await write('lease', { ...lease, expiresAt: Date.now() + 20 * 60000 });
    if (request.action === 'guard') { console.log(JSON.stringify({ state: 'owned' })); return; }
    if (['scan', 'pending'].includes(request.action)) {
      if (request.action === 'scan') {
        // Migrate only receipts proven against the previous exact snapshot.
        for (const m of snapshot?.messages || []) {
          const j = journal[m.key];
          if (j && !j.identity) j.identity = identityOf(m.message);
          if (terminal(j) && j.revision === digest([m, snapshot.boardHash])) j.contentRevision = contentDigest(m);
        }
        snapshot = await collect(snapshot, journal);
        // Carry questions across queue/IMAP aliases, but force a new attachment verification.
        for (const m of snapshot.messages) if (!journal[m.key]) {
          const prior = Object.values(journal).find(j => j.identity && sameEmail(j.identity, m.message));
          if (prior) journal[m.key] = { ...prior, revision: null, contentRevision: null };
        }
        await write('snapshot', snapshot);
        await write('journal', journal);
      }
      if (!snapshot) throw Error('SCAN_REQUIRED');
      const work = pending(snapshot, journal);
      if (request.action === 'scan') {
        const runs = trimRuns([...(await read('runs', [])), { at: snapshot.checkedAt, pending: work.length, inbox: snapshot.messages.filter(m => m.source !== 'queue').length }]);
        await write('runs', runs);
      }
      const offset = request.offset || 0;
      console.log(JSON.stringify({ state: work.length ? 'work' : 'idle', checkedAt: snapshot.checkedAt,
        health: snapshot.health, pending: work.length, next: offset + 5 < work.length ? offset + 5 : null,
        messages: work.slice(offset, offset + 5).map(m => ({ key: m.key, revision: digest([m, snapshot.boardHash]),
          from: String(m.message.from).slice(0, 320), subject: String(m.message.subject || '(без темы)').slice(0, 160), date: m.message.sentAt,
          attachmentCount: m.attachments?.length, names: m.attachments?.slice(0, 4).map(a => String(a.name).slice(0, 160)),
          previous: journal[m.key] ? { outcome: journal[m.key].outcome, asked: journal[m.key].asked, note: journal[m.key].note.slice(0, 240) } : null })) }));
    } else if (request.action === 'ack') {
      if (!snapshot) throw Error('SCAN_REQUIRED');
      journal = acknowledge(snapshot, journal, request.key, request.revision, request.outcome, request.note);
      await write('journal', journal);
      console.log(JSON.stringify({ acknowledged: request.key, outcome: request.outcome }));
    } else if (request.action === 'orders') {
      if (!snapshot) throw Error('SCAN_REQUIRED');
      console.log(JSON.stringify(page(snapshot.orders, request.offset || 0)));
    } else if (request.action === 'mail') {
      const m = snapshot?.messages.find(x => x.key === request.key);
      if (!m) throw Error('MAIL_NOT_FOUND');
      const detail = m.source !== 'queue' ? await selfDetail(m) : m;
      console.log(JSON.stringify(page({ revision: digest([m, snapshot.boardHash]), previous: journal[m.key], ...detail }, request.offset || 0)));
    } else throw Error('INVALID_ACTION');
  } finally { await lock.close(); await fs.unlink(dir + '/lock'); }
}

async function withMail(fn) {
  const { ImapFlow } = await import('imapflow');
  const c = new ImapFlow({ host: 'imap.mail.ru', port: 993, secure: true,
    auth: { user: process.env.MAIL_IMAP_USER, pass: (await fs.readFile(process.env.MAIL_IMAP_PASSWORD_FILE, 'utf8')).trim() },
    logger: false, emitLogs: false, tls: { rejectUnauthorized: true }, connectionTimeout: 15000, socketTimeout: 30000, disableAutoIdle: true });
  c.on('error', () => {});
  try { await c.connect(); return await fn(c); } finally { await c.logout().catch(() => c.close()); }
}
async function selfDetail(m) {
  return withMail(async c => {
    const lock = await c.getMailboxLock(m.folder, { readOnly: true });
    try {
      if (String(c.mailbox.uidValidity) !== m.uidValidity) throw Error('UIDVALIDITY_CHANGED');
      const header = await c.fetchOne(m.uid, { size: true, envelope: true }, { uid: true });
      if (!header || header.size > 96 * 1024 * 1024 || header.envelope.messageId !== m.message.messageId) throw Error('SOURCE_CHANGED');
      const raw = await c.fetchOne(m.uid, { source: true }, { uid: true });
      const { parseLayoutEmail } = await import('./modules/orders/server/mail-import.mjs');
      const p = await parseLayoutEmail(raw.source);
      return { ...m, message: p.message, attachments: p.attachments.map(({ bytes, ...a }) => ({ ...a, sha256: bytes ? createHash('sha256').update(bytes).digest('hex') : null })) };
    } finally { lock.release(); }
  });
}
async function collect(previous, journal) {
  const { default: Database } = await import('better-sqlite3');
  const { createSession, deleteSession } = await import('./server/db.mjs');
  const { sessionToken, tokenHash } = await import('./server/auth.mjs');
  const db = new Database('/data/finance.sqlite3'), token = sessionToken(), h = tokenHash(token);
  let queue, board;
  try {
    createSession(db, h, new Date(Date.now() + 240000).toISOString());
    const get = async path => {
      const r = await fetch('http://localhost:3000' + path, { headers: { Cookie: `finance_session=${token}` }, signal: AbortSignal.timeout(45000) });
      if (!r.ok) throw Error('BACKEND_HTTP_' + r.status);
      return r.json();
    };
    queue = await get('/kanban/api/mail/queue');
    // Never consume a partial sync as a completed snapshot.
    for (let i = 0; queue.state === 'syncing' && i < 3; i++) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      queue = await get('/kanban/api/mail/queue');
    }
    if (queue.state !== 'ready' || queue.lastError || !queue.lastSuccessAt || Date.now() - Date.parse(queue.lastSuccessAt) > 10 * 60000) throw Error('MAIL_NOT_READY');
    board = await get('/kanban/api/board?fresh=1');
  } finally { deleteSession(db, h); db.close(); }
  const orders = board.orders.map(o => ({ id: o.id, title: o.title, client: o.client, status: o.status,
    createdDate: o.createdDate, comment: o.comment, fields: o.edit?.fields?.map(f => ({ id: f.id, value: f.value })),
    items: o.items.map(i => ({ name: i.name, description: i.description, fields: i.edit?.fields?.map(f => ({ id: f.id, value: f.value })) })),
    media: o.media.items.map(m => ({ id: m.id, name: m.name, size: m.size, source: m.source })), coverId: o.media.coverId })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const messages = queue.messages.map(m => ({ key: m.key, source: 'queue', state: m.state, message: m.message,
    attachments: m.attachments.map(a => ({ partId: a.partId, name: a.name, size: a.size, state: a.state, error: a.error, orderId: a.orderId, mediaId: a.mediaId, supported: a.supported, link: a.link })) }));
  const folders = {};
  await withMail(async c => {
    const seen = messages.map(m => m.message);
    const listing = await c.list();
    const paths = listing.filter(f => (f.path === 'INBOX' || f.path.startsWith('INBOX/')) && !['\\Sent', '\\Trash', '\\Junk', '\\Drafts'].includes(f.specialUse) && !f.flags?.has('\\Noselect')).map(f => f.path);
    if (!paths.includes('INBOX')) throw Error('INBOX_MISSING');
    for (const folder of paths.sort()) {
      const lock = await c.getMailboxLock(folder, { readOnly: true });
      try {
        const validity = String(c.mailbox.uidValidity);
        const initialBoundary = Math.max(0, Number(c.mailbox.uidNext) - 1);
        const cache = previous?.folders?.[folder];
        const records = cache?.validity === validity ? { ...cache.records } : {};
        const present = new Set(await c.search({ uid: '1:*' }, { uid: true }));
        for (const uid of Object.keys(records)) if (!present.has(Number(uid))) delete records[uid];
        const incremental = cache?.validity === validity && cache.scope === 'all-incoming-v1';
        const ids = await c.search(incremental ? { uid: `${cache.highWater + 1}:*` } : { since: new Date('2026-09-10') }, { uid: true });
        // IMAP reversed ranges can include the last UID: filter it explicitly.
        const discovered = incremental ? ids.filter(uid => uid > cache.highWater) : ids;
        const missing = discovered.filter(uid => !records[uid]);
        if (missing.length) for await (const m of c.fetch(missing, { envelope: true, size: true }, { uid: true })) {
          const from = m.envelope.from?.map(a => a.address).join(',');
          const self = from === process.env.MAIL_IMAP_USER && m.envelope.to?.some(a => a.address === process.env.MAIL_IMAP_USER);
          records[m.uid] = { key: self ? 'self:' + digest(m.envelope.messageId || [folder, validity, m.uid]) : 'inbox:' + digest([m.envelope.messageId || [folder, validity, m.uid], from, m.envelope.date, m.envelope.subject, m.size]), source: self ? 'self' : 'inbox', state: 'review',
            folder, uid: m.uid, uidValidity: validity, size: m.size,
            message: { messageId: m.envelope.messageId, from, subject: m.envelope.subject, sentAt: m.envelope.date } };
        }
        if (discovered.some(uid => !records[uid])) throw Error('INCOMPLETE_IMAP');
        const highWater = Math.max(incremental ? cache.highWater : initialBoundary, ...discovered, 0);
        for (const [uid, m] of Object.entries(records)) if (canDropCache(m, journal)) delete records[uid];
        folders[folder] = { validity, scope: 'all-incoming-v1', highWater, records };
        for (const m of Object.values(records)) if (!seen.some(n => sameEmail(n, m.message))) { messages.push(m); seen.push(m.message); }
      } finally { lock.release(); }
    }
  });
  // Never discard unresolved mail simply because a folder vanished or UIDVALIDITY reset.
  const keys = new Set(messages.map(m => m.key));
  for (const m of previous?.messages || []) if (m.source !== 'queue' && !keys.has(m.key) && !terminal(journal[m.key]) && !messages.some(n => sameEmail(n.message, m.message))) messages.push(m);
  return { checkedAt: new Date().toISOString(), boardHash: digest(orders), orders, messages, folders,
    health: { state: queue.state, lastSuccessAt: queue.lastSuccessAt, counts: queue.counts } };
}

if (process.argv[1] === '-') {
  try { await main(JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'))); }
  catch (e) { console.log(JSON.stringify({ state: 'error', code: /^[A-Z_0-9]+$/.test(e.message) ? e.message : 'CHECK_FAILED', type: e.name })); process.exitCode = 1; }
}
