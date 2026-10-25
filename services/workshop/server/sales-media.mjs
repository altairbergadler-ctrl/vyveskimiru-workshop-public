import fs from 'node:fs/promises';
import { stageFile } from './file-streams.mjs';
import { SalesError, salesChatId, salesHash } from './sales-desk.mjs';
import { sourceMediaRequest, maxMediaUrl } from './max-media.mjs';

export const SALES_MEDIA_LIMIT = 32 * 1024 * 1024;
const fail = (
  message = 'Вложение недоступно. Обновите список или откройте исходный чат.',
  status = 503,
) => {
  throw new SalesError('SALES_MEDIA_UNAVAILABLE', message, status);
};
export function avitoMediaUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail();
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !['avito.ru', 'avito.st'].some(
      (domain) =>
        url.hostname === domain || url.hostname.endsWith('.' + domain),
    )
  )
    fail();
  return url;
}
// Only inert, signature-checked formats are rendered inline. Unknown and active
// formats remain attachments, regardless of the source's filename/Content-Type.
export function mediaType(bytes) {
  const prefix = bytes.subarray(0, 16);
  if (
    prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255)
    return 'image/jpeg';
  if (/^GIF8[79]a/.test(prefix.toString('ascii'))) return 'image/gif';
  if (
    prefix.toString('ascii', 0, 4) === 'RIFF' &&
    prefix.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  if (prefix.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (
    prefix.toString('ascii', 0, 3) === 'ID3' ||
    (prefix[0] === 255 && (prefix[1] & 254) === 250)
  )
    return 'audio/mpeg';
  if (
    prefix.toString('ascii', 0, 4) === 'RIFF' &&
    prefix.toString('ascii', 8, 12) === 'WAVE'
  )
    return 'audio/wav';
  if (
    prefix.toString('ascii', 4, 8) === 'ftyp' &&
    /^(isom|iso2|mp4[12]|avc1|M4[AVB] )$/.test(prefix.toString('ascii', 8, 12))
  )
    return prefix.toString('ascii', 8, 12).startsWith('M4A')
      ? 'audio/mp4'
      : 'video/mp4';
  return 'application/octet-stream';
}
const kindOf = (a) =>
  a.bytes ? mediaType(a.bytes).split('/')[0] : a.kind || 'file';
export function maxMessageMedia(message) {
  return (
    Array.isArray(message?.body?.attachments) ? message.body.attachments : []
  )
    .slice(0, 50)
    .filter((a) => ['image', 'audio', 'video', 'file'].includes(a.type))
    .map((a, i) => ({
      partId: String(i + 1),
      kind: a.type,
      name: String(
        a.filename ||
          a.payload?.filename ||
          { image: 'Фото', audio: 'Аудио', video: 'Видео', file: 'Файл' }[
            a.type
          ],
      ).slice(0, 1000),
      url:
        typeof a.payload?.url === 'string' && a.payload.url.length <= 8192
          ? a.payload.url
          : '',
      size: Number.isSafeInteger(a.size) ? a.size : null,
    }));
}

// Transient read-through views over existing source clients; no second inbox,
// correspondence archive or background collector. Scope is checked on every read.
export class SalesMedia {
  constructor(sources, { request = sourceMediaRequest } = {}) {
    this.sources = sources;
    this.request = request;
    this.pages = new Map();
    this.sendGenerations = new Map();
    this.sendGeneration = 0;
    this.blobs = new Map();
    this.voices = new Map();
    this.mails = new Map();
    this.downloads = new Map();
    this.readTail = Promise.resolve();
    this.queued = 0;
    this.lastRead = 0;
    this.active = 0;
    this.waiters = [];
  }
  invalidateAvito(account, chat, discardReads = false) {
    if (discardReads)
      this.sendGenerations.set(
        JSON.stringify([String(account), chat]),
        ++this.sendGeneration,
      );
    for (const key of this.pages.keys()) {
      const identity = JSON.parse(key);
      if (identity[0] === String(account) && identity[1] === chat)
        this.pages.delete(key);
    }
  }
  mail(e, read) {
    this.sources.assertMediaScope(e);
    const key = JSON.stringify([e.account, e.nativeId, e.version]);
    const cached = this.mails.get(key);
    if (cached && cached.until > Date.now()) return cached.promise;
    const entry = { until: Date.now() + 20000, bytes: 0 };
    const promise = Promise.resolve()
      .then(read)
      .then((result) => {
        this.sources.assertMediaScope(e);
        entry.bytes = (result.parsed.media || []).reduce(
          (n, a) => n + (a.bytes?.length || 0),
          0,
        );
        while (
          this.mails.size &&
          [...this.mails.values()].reduce((n, v) => n + v.bytes, 0) >
            32 * 1024 * 1024
        )
          this.mails.delete(this.mails.keys().next().value);
        return result;
      });
    entry.promise = promise;
    this.mails.set(key, entry);
    while (this.mails.size > 4)
      this.mails.delete(this.mails.keys().next().value);
    promise.catch(() => {
      if (this.mails.get(key) === entry) this.mails.delete(key);
    });
    return promise;
  }
  async page(e, offset, { fresh = false } = {}) {
    this.sources.assertMediaScope(e);
    if (!this.sources.canRead())
      fail('Идёт плановый разбор Авито. Повторите чтение позже.', 409);
    const key = JSON.stringify([e.account, e.conversationId, offset]);
    const cached = this.pages.get(key);
    if (!fresh && cached && cached.until > Date.now()) return cached.promise;
    if (this.queued >= 20) fail('Источник занят. Повторите чтение позже.', 429);
    this.queued++;
    const promise = this.readTail
      .catch(() => {})
      .then(async () => {
        try {
          const pause = this.lastRead + 1100 - Date.now();
          if (pause > 0)
            await new Promise((resolve) => setTimeout(resolve, pause));
          this.sources.assertMediaScope(e);
          if (this.sources.closed || !this.sources.canRead())
            fail('Чтение источника временно приостановлено.', 409);
          this.lastRead = Date.now();
          const generationKey = JSON.stringify([e.account, e.conversationId]);
          const generation = this.sendGenerations.get(generationKey);
          const result = await this.sources.avito.conversationMessages({
            chatId: e.conversationId,
            offset,
            includeMedia: true,
          });
          this.sources.assertMediaScope(e);
          if (this.sendGenerations.get(generationKey) !== generation)
            throw new SalesError(
              'SALES_SOURCE_CHANGED',
              'Переписка изменилась во время чтения. Обновите чат.',
              409,
            );
          return result;
        } finally {
          this.queued--;
        }
      });
    this.readTail = promise.catch(() => {});
    this.pages.set(key, { until: Date.now() + 20000, promise });
    if (this.pages.size > 100)
      this.pages.delete(this.pages.keys().next().value);
    promise.catch(() => {
      if (this.pages.get(key)?.promise === promise) this.pages.delete(key);
    });
    return promise;
  }
  present(e, raw = []) {
    return raw.slice(0, 50).map((a) => {
      const params =
        e.source === 'avito'
          ? new URLSearchParams({
              chatId: salesChatId(e),
              messageId: e.nativeId,
              partId: a.partId,
            })
          : new URLSearchParams({ eventId: e.id, partId: a.partId });
      let available =
        !a.unavailable && (Boolean(a.bytes?.length) || Boolean(a.voiceId));
      if (a.url) {
        try {
          (e.source === 'avito' ? avitoMediaUrl : maxMediaUrl)(a.url);
          available = true;
        } catch {
          /* Report inaccessible media without failing the message. */
        }
      }
      const kind = kindOf(a);
      return {
        id: salesHash([e.source, e.account, e.nativeId, a.partId]),
        partId: a.partId,
        name: a.name || 'Вложение',
        kind: ['image', 'audio', 'video'].includes(kind) ? kind : 'file',
        size: a.size || null,
        at: e.occurredAt,
        source: e.source,
        origin: e.url || '',
        available,
        reason: available
          ? ''
          : a.unavailable || 'Источник не передал доступный файл.',
        url: available ? '/api/sales/media?' + params : '',
        preview:
          available && kind === 'image'
            ? '/api/sales/media?' + params + '&preview=1'
            : '',
      };
    });
  }
  async event(eventId, cache) {
    const row = this.sources.desk.db
      .prepare('SELECT data FROM sales_events WHERE id=?')
      .get(eventId);
    if (!row) fail('Событие не найдено.', 404);
    const e = { ...JSON.parse(row.data), id: eventId };
    const content = await this.sources.content(eventId, cache, {
      includeMedia: true,
    });
    return { ...content, media: this.present(e, content.media) };
  }
  async note(noteId, offset = 0) {
    this.sources.desk.note(noteId);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 100000 ||
      offset % 20
    )
      fail('Некорректная страница вложений.', 400);
    const events = this.sources.desk
      .events(noteId)
      .filter(
        (e) =>
          e.source !== 'avito' || ['image', 'voice', 'file'].includes(e.type),
      )
      .reverse();
    const items = [],
      unavailable = [];
    const cache = new Map();
    for (const e of events.slice(offset, offset + 20)) {
      try {
        const content = await this.event(e.id, cache);
        items.push(...content.media);
        if (content.mediaUnavailable)
          unavailable.push({
            eventId: e.id,
            source: e.source,
            origin: e.url || '',
          });
      } catch {
        unavailable.push({
          eventId: e.id,
          source: e.source,
          origin: e.url || '',
        });
      }
    }
    return {
      noteId,
      items,
      unavailable,
      offset,
      nextOffset: offset + 20 < events.length ? offset + 20 : null,
      totalEvents: events.length,
    };
  }
  async file(params, options = {}) {
    // Bound resolution as well as downloading: MIME parsing can allocate before
    // any binary transport starts. A queued request rechecks scope in readFile.
    if (this.active >= 3) {
      if (this.waiters.length >= 30)
        fail('Вложения загружаются. Повторите попытку.', 429);
      await new Promise((resolve) => this.waiters.push(resolve));
    } else this.active++;
    try {
      return await this.readFile(params, options);
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
  async readFile(params, { stream = false } = {}) {
    const partId = params.get('partId');
    if (!/^[1-9]\d?$/.test(partId || '')) fail('Вложение не найдено.', 404);
    let e, content;
    if (params.has('chatId')) {
      e = {
        ...this.sources.chatIdentity(params.get('chatId')),
        nativeId: params.get('messageId'),
      };
      if (
        e.source !== 'avito' ||
        typeof e.nativeId !== 'string' ||
        !e.nativeId ||
        e.nativeId.length > 200
      )
        fail('Вложение не найдено.', 404);
      // chatIdentity describes one event; its revision must not be applied to a
      // different message in that chat, including history outside intake scope.
      const current = this.sources.desk.db
        .prepare('SELECT version,data FROM sales_events WHERE id=?')
        .get(salesHash([e.source, e.account, e.nativeId]));
      e.version = current?.version;
      e.deleted = current ? Boolean(JSON.parse(current.data).deleted) : false;
      content = await this.sources.content(null, null, {
        includeMedia: true,
        event: e,
      });
    } else {
      const row = this.sources.desk.db
        .prepare('SELECT data FROM sales_events WHERE id=?')
        .get(params.get('eventId'));
      if (!row) fail('Событие не найдено.', 404);
      e = JSON.parse(row.data);
      content = await this.sources.content(params.get('eventId'), null, {
        includeMedia: true,
      });
    }
    this.sources.assertMediaScope(e);
    const a = content.media?.find((a) => a.partId === partId);
    if (!a) fail('Вложение не найдено.', 404);
    if (a.unavailable) fail(a.unavailable);
    let url = params.get('preview') === '1' && a.preview ? a.preview : a.url;
    if (a.voiceId) {
      const voiceKey = JSON.stringify([e.account, a.voiceId]);
      let entry = this.voices.get(voiceKey);
      if (!entry || entry.until <= Date.now()) {
        entry = {
          until: Date.now() + 20000,
          promise: this.sources.avito.voiceFile({ voiceId: a.voiceId }),
        };
        this.voices.set(voiceKey, entry);
        if (this.voices.size > 100)
          this.voices.delete(this.voices.keys().next().value);
        entry.promise.catch(() => {
          if (this.voices.get(voiceKey) === entry) this.voices.delete(voiceKey);
        });
      }
      const value = await entry.promise;
      if (String(value.accountId) !== e.account) fail();
      url = value.url;
    }
    if (stream) {
      let file;
      try {
        file = a.bytes
          ? {
              bytes: a.bytes,
              size: a.bytes.length,
              prefix: a.bytes.subarray(0, 32),
            }
          : await stageFile(async (target) => {
              const result = await this.request(
                e.source === 'max' ? this.sources.max.settings() : null,
                url,
                {
                  validateUrl:
                    e.source === 'avito' ? avitoMediaUrl : maxMediaUrl,
                  limit: Infinity,
                  destination: target,
                },
              );
              // Test transports and local source adapters can return a buffer.
              if (Buffer.isBuffer(result))
                await fs.writeFile(target, result, { mode: 0o600 });
            });
        this.sources.assertMediaScope(e);
        let mime = mediaType(file.prefix);
        if (mime === 'video/mp4' && a.kind === 'audio') mime = 'audio/mp4';
        const extension = {
          'image/png': 'png',
          'image/jpeg': 'jpg',
          'audio/mp4': 'm4a',
          'audio/ogg': 'ogg',
          'video/mp4': 'mp4',
        }[mime];
        let name = String(a.name || 'Вложение')
          .split('\r')
          .join('')
          .split('\n')
          .join('')
          .split('\0')
          .join('')
          .slice(0, 200);
        if (extension && !/\.[a-zA-Z0-9]{1,8}$/.test(name))
          name += '.' + extension;
        return { ...file, mime, name };
      } catch (error) {
        await file?.dispose?.();
        if (error instanceof SalesError) throw error;
        fail();
      }
    }
    const key = salesHash([
      e.source,
      e.account,
      e.nativeId,
      partId,
      url || salesHash(a.bytes || ''),
    ]);
    const cached = this.blobs.get(key);
    let bytes = cached && cached.until > Date.now() ? cached.bytes : null;
    if (!bytes) {
      if (!this.downloads.has(key)) {
        const promise = this.download(e, a, url);
        this.downloads.set(key, promise);
        void promise.finally(() => this.downloads.delete(key)).catch(() => {});
      }
      bytes = await this.downloads.get(key);
      if (bytes.length <= 4 * 1024 * 1024) {
        this.blobs.set(key, { bytes, until: Date.now() + 30000 });
        while (
          [...this.blobs.values()].reduce((n, b) => n + b.bytes.length, 0) >
            32 * 1024 * 1024 ||
          this.blobs.size > 100
        )
          this.blobs.delete(this.blobs.keys().next().value);
      }
    }
    this.sources.assertMediaScope(e);
    let mime = mediaType(bytes);
    if (mime === 'video/mp4' && a.kind === 'audio') mime = 'audio/mp4';
    const extension = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'audio/ogg': 'ogg',
      'audio/mpeg': 'mp3',
      'audio/wav': 'wav',
      'audio/mp4': 'm4a',
      'video/mp4': 'mp4',
    }[mime];
    const name = String(a.name || 'Вложение');
    return {
      bytes,
      mime,
      name: (extension && !/\.[a-zA-Z0-9]{1,8}$/.test(name)
        ? name + '.' + extension
        : name
      )
        .split('\r')
        .join('')
        .split('\n')
        .join('')
        .split('\0')
        .join('')
        .slice(0, 200),
    };
  }
  async download(e, a, url) {
    try {
      this.sources.assertMediaScope(e);
      const bytes =
        a.bytes ||
        (await this.request(
          e.source === 'max' ? this.sources.max.settings() : null,
          url,
          {
            validateUrl: e.source === 'avito' ? avitoMediaUrl : maxMediaUrl,
            limit: SALES_MEDIA_LIMIT,
            signal: AbortSignal.timeout(30000),
          },
        ));
      if (!bytes?.length || bytes.length > SALES_MEDIA_LIMIT) fail();
      return bytes;
    } catch (error) {
      if (error instanceof SalesError) throw error;
      fail();
    }
  }
}
