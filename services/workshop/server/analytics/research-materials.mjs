import crypto from 'node:crypto';
import { AvitoError } from '../avito.mjs';
import { chatId as validChatId } from '../avito-inquiries.mjs';

const invalid = () => {
  throw new AvitoError('invalid', 400);
};
export function redactEvidence(text, names = []) {
  let result = String(text).normalize('NFC');
  for (const name of names
    .flatMap((n) => String(n).split(/\s+/u))
    .filter((n) => n.length > 2)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(
      new RegExp(`(?<![\\p{L}])${escaped}(?![\\p{L}])`, 'giu'),
      '[ИМЯ]',
    );
  }
  return result
    .replace(/[\w.+%-]+@[\w.-]+\.[a-z]{2,}/giu, '[КОНТАКТ]')
    .replace(/(?:https?:\/\/|www\.)\S+|@[\p{L}\d_]{3,}/giu, '[КОНТАКТ]')
    .replace(/(?<!\d)\+?\d[\d\s().-]{7,}\d(?!\d)/gu, '[КОНТАКТ]');
  // Unknown names need human review; masking every capitalized word would
  // destroy evidence such as «Дорого» or «Долго».
}

export class ResearchMaterials {
  constructor({ deep, client, canRead = () => true, now = Date.now }) {
    Object.assign(this, { deep, client, canRead, now });
    this.cache = new Map();
    this.flight = null;
    this.initialized = false;
  }
  db() {
    const db = this.deep.db();
    if (!this.initialized) {
      db.exec(`CREATE TABLE IF NOT EXISTS research_excerpts(
        id TEXT PRIMARY KEY,account TEXT NOT NULL,item_id TEXT NOT NULL,chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,message_at TEXT NOT NULL,direction TEXT NOT NULL,
        excerpt TEXT NOT NULL,source_hash TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS research_excerpts_item ON research_excerpts(account,item_id,created_at);`);
      this.initialized = true;
    }
    return db;
  }
  item(id) {
    if (typeof id !== 'string' || !/^[1-9]\d{0,15}$/.test(id)) invalid();
    const db = this.db(),
      account = this.deep.base.namespace();
    if (
      !db
        .prepare(
          'SELECT 1 FROM ad_item_versions WHERE account=? AND item_id=? LIMIT 1',
        )
        .get(account, id)
    )
      invalid();
    return id;
  }
  view(id, period = null) {
    this.item(id);
    const db = this.db(),
      account = this.deep.base.namespace();
    const content = db
      .prepare(
        "SELECT observed_at,payload FROM ad_item_versions WHERE account=? AND item_id=? AND kind='content' ORDER BY id DESC LIMIT 1",
      )
      .get(account, id);
    // IDs and dates only. Reading the list does not fetch or persist messages.
    const chats = db
      .prepare("SELECT 1 FROM sqlite_master WHERE name='response_chats'")
      .get()
      ? db
          .prepare(
            'SELECT chat_id AS id,first_in AS firstIn,state FROM response_chats WHERE account=? AND item_id=? ORDER BY first_in DESC LIMIT 100',
          )
          .all(account, id)
      : [];
    const excerpts = db
      .prepare(`SELECT id,chat_id AS chatId,message_id AS messageId,message_at AS messageAt,direction,
      excerpt,created_at AS createdAt FROM research_excerpts WHERE account=? AND item_id=? ORDER BY created_at DESC LIMIT 100`)
      .all(account, id);
    const notes = period
      ? this.deep.view(period).rows.find((row) => row.id === id)?.notes || []
      : db
          .prepare(
            'SELECT id,event_date AS date,text FROM ad_notes WHERE account=? AND item_id=? ORDER BY event_date DESC LIMIT 100',
          )
          .all(account, id);
    return {
      content: content
        ? { ...JSON.parse(content.payload), observedAt: content.observed_at }
        : null,
      chats,
      excerpts,
      notes,
      chatLimit: 100,
      archive: false,
      contentAutomatic: false,
      sourceUrl: 'https://www.avito.ru/profile/messenger',
    };
  }
  saveContent(input) {
    if (
      !input ||
      Object.keys(input).some(
        (k) =>
          !['id', 'itemId', 'text', 'photos', 'expectedVersion'].includes(k),
      ) ||
      typeof input.id !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(input.id) ||
      typeof input.text !== 'string' ||
      input.text.length > 20000 ||
      !Array.isArray(input.photos) ||
      input.photos.length > 10 ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 0
    )
      invalid();
    this.item(input.itemId);
    const photos = input.photos.map((value) => {
      if (typeof value !== 'string' || value.length > 2000) invalid();
      let u;
      try {
        u = new URL(value);
      } catch {
        invalid();
      }
      if (
        u.protocol !== 'https:' ||
        !u.hostname.endsWith('.avito.st') ||
        u.username ||
        u.password ||
        u.port
      )
        invalid();
      return u.href;
    });
    if (!input.text.trim() && !photos.length) invalid();
    const db = this.db(),
      account = this.deep.base.namespace();
    return db.transaction(() => {
      const existing = db
        .prepare(
          "SELECT id,payload FROM ad_item_versions WHERE account=? AND item_id=? AND kind='content' AND run_id=?",
        )
        .get(account, input.itemId, input.id);
      const value = {
        id: input.itemId,
        text: input.text.trim(),
        photos,
        source: 'manual',
        photosStored: 'source_links',
      };
      if (existing) {
        if (JSON.stringify(value) !== existing.payload)
          throw new AvitoError('invalid', 409);
        return { saved: true, version: existing.id };
      }
      const latest = db
        .prepare(
          "SELECT id FROM ad_item_versions WHERE account=? AND item_id=? AND kind='content' ORDER BY id DESC LIMIT 1",
        )
        .get(account, input.itemId);
      if ((latest?.id ?? 0) !== input.expectedVersion)
        throw new AvitoError('invalid', 409);
      this.deep.snapshot({ id: input.id, account }, 'content', {}, value);
      const saved = db
        .prepare(
          "SELECT id FROM ad_item_versions WHERE account=? AND item_id=? AND kind='content' ORDER BY id DESC LIMIT 1",
        )
        .get(account, input.itemId);
      return { saved: true, version: saved.id };
    })();
  }
  async page(input) {
    if (
      !input ||
      Object.keys(input).some(
        (k) => !['itemId', 'chatId', 'offset'].includes(k),
      ) ||
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      input.offset > 900 ||
      input.offset % 100
    )
      invalid();
    this.item(input.itemId);
    try {
      validChatId(input.chatId);
    } catch {
      invalid();
    }
    const account = this.deep.base.namespace(),
      db = this.db();
    if (
      !db
        .prepare(
          'SELECT 1 FROM response_chats WHERE account=? AND item_id=? AND chat_id=?',
        )
        .get(account, input.itemId, input.chatId)
    )
      invalid();
    // Share the existing provider quotas; yield to protected attribution work.
    if (!this.canRead() || this.flight)
      throw new AvitoError('rate_limit', 429, 10);
    this.flight = this.client.conversationMessages({
      chatId: input.chatId,
      offset: input.offset,
    });
    try {
      const page = await this.flight;
      const profile = db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='inquiry_snapshots'")
        .get()
        ? db
            .prepare(
              "SELECT payload FROM inquiry_snapshots WHERE account=? AND chat_id=? AND kind='profile' ORDER BY id DESC LIMIT 1",
            )
            .get(account, input.chatId)
        : null;
      const names = profile
        ? JSON.parse(profile.payload).users?.map((u) => u.name) || []
        : [];
      const messages = page.messages
        .filter((m) => m.type === 'text' && m.text)
        .map((m) => ({
          id: m.id,
          createdAt: m.createdAt,
          direction: m.direction,
          text: redactEvidence(m.text, names),
        }));
      for (const [key, value] of this.cache)
        if (value.expires < this.now()) this.cache.delete(key);
      while (this.cache.size >= 10)
        this.cache.delete(this.cache.keys().next().value);
      const token = crypto.randomUUID();
      // Only redacted, short-lived previews in memory. No raw text, model call,
      // automatic archive, new importer or change to response/nightly schedules.
      this.cache.set(token, {
        account,
        itemId: input.itemId,
        chatId: input.chatId,
        messages,
        expires: this.now() + 10 * 60000,
      });
      const expiry = setTimeout(() => this.cache.delete(token), 10 * 60000);
      expiry.unref();
      return {
        token,
        messages,
        hasMore: page.hasMore,
        nextOffset:
          page.hasMore && input.offset < 900 ? input.offset + 100 : null,
        historyLimited: page.hasMore && input.offset === 900,
        reviewRequired: true,
        sourceUrl: 'https://www.avito.ru/profile/messenger',
      };
    } finally {
      this.flight = null;
    }
  }
  saveExcerpt(input) {
    if (
      !input ||
      Object.keys(input).some(
        (k) => !['token', 'messageId', 'start', 'end', 'reviewed'].includes(k),
      ) ||
      input.reviewed !== true
    )
      invalid();
    const source = this.cache.get(input.token);
    if (
      !source ||
      source.expires < this.now() ||
      source.account !== this.deep.base.namespace()
    )
      throw new AvitoError('invalid', 409);
    const message = source.messages.find((m) => m.id === input.messageId);
    if (
      !message ||
      !Number.isSafeInteger(input.start) ||
      !Number.isSafeInteger(input.end) ||
      input.start < 0 ||
      input.end > message.text.length ||
      input.end <= input.start ||
      input.end - input.start > 2000
    )
      invalid();
    const excerpt = message.text.slice(input.start, input.end);
    if (!excerpt.trim()) invalid();
    const sourceHash = crypto
      .createHash('sha256')
      .update(message.text)
      .digest('hex');
    const id = crypto
      .createHash('sha256')
      .update(
        JSON.stringify([
          source.account,
          source.chatId,
          message.id,
          sourceHash,
          input.start,
          input.end,
        ]),
      )
      .digest('hex');
    this.db()
      .prepare(
        'INSERT OR IGNORE INTO research_excerpts VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        source.account,
        source.itemId,
        source.chatId,
        message.id,
        message.createdAt,
        message.direction,
        excerpt,
        sourceHash,
        new Date(this.now()).toISOString(),
      );
    return { saved: true, id };
  }
  async handle(request, response, url, json, body) {
    try {
      if (
        request.method === 'GET' &&
        url.pathname.endsWith('/materials') &&
        [...url.searchParams.keys()].every(
          (k) =>
            ['itemId', 'dateFrom', 'dateTo'].includes(k) &&
            url.searchParams.getAll(k).length === 1,
        ) &&
        url.searchParams.getAll('itemId').length === 1
      ) {
        const period =
          url.searchParams.has('dateFrom') || url.searchParams.has('dateTo')
            ? {
                dateFrom: url.searchParams.get('dateFrom'),
                dateTo: url.searchParams.get('dateTo'),
              }
            : null;
        const result = this.view(url.searchParams.get('itemId'), period);
        const version = this.db()
          .prepare(
            "SELECT id FROM ad_item_versions WHERE account=? AND item_id=? AND kind='content' ORDER BY id DESC LIMIT 1",
          )
          .get(this.deep.base.namespace(), url.searchParams.get('itemId'));
        return json(response, 200, {
          ...result,
          contentVersion: version?.id ?? 0,
        });
      }
      if (request.method !== 'POST' || url.search) invalid();
      const input = await body(request, 50000);
      if (url.pathname.endsWith('/content'))
        return json(response, 200, this.saveContent(input));
      if (url.pathname.endsWith('/page'))
        return json(response, 200, await this.page(input));
      if (url.pathname.endsWith('/excerpt'))
        return json(response, 200, this.saveExcerpt(input));
      invalid();
    } catch (error) {
      const safe =
        error instanceof AvitoError ? error : new AvitoError('storage');
      return json(response, safe.statusCode, {
        error: safe.message,
        code: safe.code,
        retryAfterSeconds: safe.retryAfterSeconds,
      });
    }
  }
}
