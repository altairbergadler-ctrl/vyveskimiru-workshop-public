import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { businessToday } from './analytics/contracts.mjs';
import { downloadMaxImage, uploadMaxImage, maxMediaUrl } from './max-media.mjs';
import { RETOUCH_MAX_BYTES, imageType } from './max-retouch-provider.mjs';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const failure = code => Object.assign(new Error(code), { code });
const reply = mid => ({ link: { type: 'reply', mid } });
export function mentionsRetouchBot(message, options) {
  return (message.body?.markup || []).some(mark => mark.type === 'user_mention'
    && (String(mark.user_id) === String(options.botUserId)
      || (typeof mark.user_link === 'string' && mark.user_link.replace(/^@/u, '').toLowerCase() === options.username.toLowerCase())))
    || new RegExp(`(^|\\s)@${options.username}(?=$|[\\s,.!?:])`, 'iu').test(message.body?.text || '');
}
export function askRetouch(config, input, { signal, socketPath = '/run/workshop-codex/broker.sock' } = {}) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(input));
    const request = http.request({ socketPath, path: '/retouch', method: 'POST', signal,
      headers: { 'X-Workshop-Codex': fs.readFileSync(config.codexTokenFile, 'utf8').trim(), 'Content-Type': 'application/json', 'Content-Length': body.length } }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 20 * 1024 * 1024) response.destroy(); else chunks.push(chunk); });
      response.on('error', () => reject(failure('RETOUCH_TRANSPORT')));
      response.on('end', () => {
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject(failure('RETOUCH_TRANSPORT')); return; }
        if (response.statusCode === 429) return reject(failure('RETOUCH_BUSY'));
        if (response.statusCode !== 200) return reject(failure(typeof value.code === 'string' && value.code.startsWith('RETOUCH_') ? value.code : 'RETOUCH_TRANSPORT'));
        resolve(value);
      });
    });
    const timer = setTimeout(() => request.destroy(), 255000);
    request.on('close', () => clearTimeout(timer)); request.on('error', () => reject(failure('RETOUCH_TRANSPORT'))); request.end(body);
  });
}

// This is a separate, explicit group capability. It never grants order commands or reads Google.
export class MaxRetouch {
  constructor({ db, settings, send, directory, ask = askRetouch, download = downloadMaxImage,
    upload = uploadMaxImage, now = Date.now }) {
    Object.assign(this, { db, settings, send, directory, ask, download, upload, now });
    this.closed = false; this.flights = new Map();
    db.exec(`CREATE TABLE IF NOT EXISTS max_retouch_events (key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS max_retouch_jobs (key TEXT PRIMARY KEY, chat_id TEXT NOT NULL, user_id TEXT NOT NULL,
        photo_mid TEXT NOT NULL, question_mid TEXT, source_url TEXT NOT NULL, instruction TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, charged_day TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, image_token TEXT, result_mid TEXT, error_code TEXT);`);
    db.prepare("UPDATE max_retouch_jobs SET state='question_uncertain' WHERE state='asking'").run();
    db.prepare("UPDATE max_retouch_jobs SET state='queued' WHERE state='rendering'").run();
    db.prepare("UPDATE max_retouch_jobs SET state='uncertain' WHERE state='sending'").run();
  }
  config() {
    if (this.closed) return null;
    try {
      const config = this.settings(), options = config?.retouch;
      if (options?.enabled !== true || !Array.isArray(options.chatIds) || !Number.isSafeInteger(options.botUserId)
        || !/^[a-zA-Z0-9_]{1,64}$/u.test(options.username || '') || !Object.hasOwn(options, 'dailyLimit')
        || !(options.dailyLimit === null || (Number.isInteger(options.dailyLimit) && options.dailyLimit > 0 && options.dailyLimit <= 100))) return null;
      const chatIds = options.chatIds.map(String).filter(id => /^-?\d{1,16}$/u.test(id) && Number.isSafeInteger(Number(id))
        && this.db.prepare('SELECT state FROM max_bot_chats WHERE chat_id=?').get(id)?.state === 'bot_added');
      return chatIds.length ? { ...options, config, chatIds } : null;
    } catch { return null; }
  }
  process(message) {
    const options = this.config(), chatId = String(message?.recipient?.chat_id), userId = String(message?.sender?.user_id);
    if (!options?.chatIds.includes(chatId) || message?.sender?.is_bot || message?.recipient?.chat_type !== 'chat'
      || !Number.isSafeInteger(message?.sender?.user_id) || typeof message.body?.mid !== 'string' || message.body.mid.length > 200) return Promise.resolve(false);
    const eventKey = digest(`${chatId}:${userId}:${message.body.mid}`);
    if (this.flights.has(eventKey)) return this.flights.get(eventKey);
    const flight = this.receive(message, options, { chatId, userId, eventKey }).finally(() => this.flights.delete(eventKey));
    this.flights.set(eventKey, flight); return flight;
  }
  async receive(message, options, { chatId, userId, eventKey }) {
    const mentioned = mentionsRetouchBot(message, options), linked = message.link?.type === 'reply' ? message.link.message : null;
    const linkedMid = linked?.mid;
    let job = linkedMid ? this.db.prepare('SELECT * FROM max_retouch_jobs WHERE chat_id=? AND user_id=? AND (question_mid=? OR photo_mid=?) ORDER BY created_at DESC LIMIT 1').get(chatId, userId, linkedMid, linkedMid) : null;
    if (!mentioned && !job) return false;
    if (this.db.prepare('SELECT 1 FROM max_retouch_events WHERE key=?').get(eventKey)) return true;
    this.db.prepare('INSERT INTO max_retouch_events VALUES (?)').run(eventKey);
    const active = this.db.prepare("SELECT * FROM max_retouch_jobs WHERE chat_id=? AND user_id=? AND state IN ('asking','waiting','question_uncertain','queued','rendering','ready','sending') AND expires_at>? ORDER BY created_at DESC LIMIT 1").get(chatId, userId, this.now());
    const attachments = message.body.attachments?.filter(item => item.type === 'image') || [];
    const photos = attachments.length ? attachments : mentioned && linked ? linked.attachments?.filter(item => item.type === 'image') || [] : [];
    // A reply to our question describes edits; it must not silently switch to another attached image.
    if (job && (!mentioned || linkedMid === job.question_mid || ['waiting','question_uncertain'].includes(job.state))) {
      if (!['waiting','question_uncertain'].includes(job.state) || job.expires_at <= this.now()) {
        await this.notice(options, chatId, message.body.mid, 'Этот запрос уже обработан или истёк. Для новой ретуши отметьте меня на фотографии.'); return true;
      }
      const instruction = String(message.body.text || '').replace(new RegExp(`@${options.username}\\b`, 'giu'), '').trim();
      if (/^\/?отмена[.!]?$/iu.test(instruction)) {
        this.db.prepare("UPDATE max_retouch_jobs SET state='cancelled',source_url='',instruction='' WHERE key=?").run(job.key);
        await this.notice(options, chatId, message.body.mid, 'Ретушь отменена.'); return true;
      }
      if (!instruction || instruction.length > 2000 || attachments.length) {
        await this.notice(options, chatId, message.body.mid, 'Опишите правки текстом до 2000 символов в ответ на мой вопрос. Например: убрать провода, выровнять свет, сохранить надпись.'); return true;
      }
      const day = businessToday(new Date(this.now()));
      const used = this.db.prepare('SELECT count(*) n FROM max_retouch_jobs WHERE chat_id=? AND charged_day=?').get(chatId, day).n;
      if (options.dailyLimit !== null && used >= options.dailyLimit) {
        await this.notice(options, chatId, message.body.mid, `На сегодня лимит ретуши группы исчерпан (${options.dailyLimit}). Новые запросы — завтра.`); return true;
      }
      // The question's waiting window must not expire an accepted edit while it is rendering.
      this.db.prepare("UPDATE max_retouch_jobs SET instruction=?,charged_day=?,state='queued',expires_at=? WHERE key=? AND state IN ('waiting','question_uncertain')")
        .run(instruction, day, this.now() + 2 * 3600000, job.key);
      await this.notice(options, chatId, message.body.mid, '🖌 Принял правки. Обрабатываю фото — это может занять несколько минут.');
      void this.drain(); return true;
    }
    if (!mentioned) return false;
    if (active && !['waiting','question_uncertain'].includes(active.state)) {
      await this.notice(options, chatId, message.body.mid, 'Ваше предыдущее фото ещё обрабатывается. Дождитесь результата.'); return true;
    }
    if (photos.length !== 1 || typeof photos[0].payload?.url !== 'string') {
      await this.notice(options, chatId, message.body.mid, 'Пришлите одно фото с упоминанием бота или ответьте на фото, отметив меня. Затем я спрошу, что изменить.'); return true;
    }
    try { maxMediaUrl(photos[0].payload.url); } catch {
      await this.notice(options, chatId, message.body.mid, 'Не удалось принять ссылку на фото MAX. Прикрепите изображение заново.'); return true;
    }
    if (active) this.db.prepare("UPDATE max_retouch_jobs SET state='superseded',source_url='',instruction='' WHERE key=?").run(active.key);
    const sourceMid = attachments.length ? message.body.mid : linked.mid;
    this.db.prepare("INSERT INTO max_retouch_jobs(key,chat_id,user_id,photo_mid,source_url,state,created_at,expires_at) VALUES (?,?,?,?,?,'asking',?,?)")
      .run(eventKey, chatId, userId, sourceMid, photos[0].payload.url, this.now(), this.now() + 2 * 3600000);
    job = this.db.prepare('SELECT * FROM max_retouch_jobs WHERE key=?').get(eventKey);
    try {
      const result = await this.send(options.config, chatId, '🖼 Фото получил. Что нужно изменить?\n\nОтветьте на это сообщение: например, убрать лишнее, заменить фон или улучшить свет.\nДля отмены ответьте «отмена».', 'chat', reply(sourceMid),
        () => this.config()?.chatIds.includes(chatId));
      const mid = result?.message?.body?.mid;
      if (!mid) throw failure('MAX_QUESTION_UNCONFIRMED');
      this.db.prepare("UPDATE max_retouch_jobs SET state='waiting',question_mid=? WHERE key=?").run(mid, job.key);
    } catch {
      this.db.prepare("UPDATE max_retouch_jobs SET state='question_uncertain' WHERE key=?").run(job.key);
    }
    return true;
  }
  async notice(options, chatId, mid, text) {
    try { await this.send(options.config, chatId, text, 'chat', reply(mid), () => this.config()?.chatIds.includes(chatId)); } catch { /* Informational notices are never blindly repeated. */ }
  }
  start() { this.timer = setInterval(() => { void this.drain(); }, 10000); this.timer.unref(); void this.drain(); }
  drain() {
    if (this.flight) return this.flight;
    this.flight = this.work().catch(() => { this.lastError = 'RETOUCH_WORKER'; }).finally(() => { this.flight = null; });
    return this.flight;
  }
  async work() {
    const options = this.config(); if (!options) return;
    const job = this.db.prepare("SELECT * FROM max_retouch_jobs WHERE state IN ('queued','ready') AND retry_at<=? ORDER BY created_at,key LIMIT 1").get(this.now());
    if (!job || !options.chatIds.includes(job.chat_id)) return;
    if (job.expires_at <= this.now()) { this.db.prepare("UPDATE max_retouch_jobs SET state='expired',source_url='',instruction='' WHERE key=?").run(job.key); return; }
    this.controller = new AbortController();
    const output = path.join(this.directory, `${job.key}.image`);
    try {
      if (job.state === 'queued') {
        this.db.prepare("UPDATE max_retouch_jobs SET state='rendering',attempts=attempts+1 WHERE key=?").run(job.key);
        const bytes = await this.download(options.config, job.source_url, { signal: this.controller.signal });
        const result = await this.ask(options.config, { key: job.key, instruction: job.instruction,
          imageBase64: bytes.toString('base64'), imageSha256: digest(bytes) }, { signal: this.controller.signal });
        const image = Buffer.from(result.imageBase64 || '', 'base64');
        if (!image.length || image.length > RETOUCH_MAX_BYTES || digest(image) !== result.imageSha256) throw failure('RETOUCH_RESPONSE');
        imageType(image); fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const temporary = `${output}.new`, fd = fs.openSync(temporary, 'w', 0o600);
        try { fs.writeFileSync(fd, image); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temporary, output);
        this.db.prepare("UPDATE max_retouch_jobs SET state='ready',error_code=NULL WHERE key=?").run(job.key);
      }
      if (this.closed || !this.config()?.chatIds.includes(job.chat_id)) return;
      if (job.expires_at <= this.now()) { this.db.prepare("UPDATE max_retouch_jobs SET state='expired',source_url='',instruction='' WHERE key=?").run(job.key); return; }
      let token = this.db.prepare('SELECT image_token FROM max_retouch_jobs WHERE key=?').get(job.key).image_token;
      if (!token) {
        token = await this.upload(options.config, fs.readFileSync(output));
        this.db.prepare('UPDATE max_retouch_jobs SET image_token=? WHERE key=?').run(token, job.key);
      }
      if (this.closed || !this.config()?.chatIds.includes(job.chat_id)) return;
      try {
        const sent = await this.send(options.config, job.chat_id, '🖌 Готово. Результат ретуши — во вложении.', 'chat',
          { ...reply(job.photo_mid), attachments: [{ type: 'image', payload: { token } }] }, () => {
            if (!this.config()?.chatIds.includes(job.chat_id) || job.expires_at <= this.now()) return false;
            // Mark only inside the shared send slot, immediately before the actual POST.
            return this.db.prepare("UPDATE max_retouch_jobs SET state='sending' WHERE key=? AND state='ready'").run(job.key).changes > 0;
          });
        if (!sent?.message?.body?.mid) throw failure('MAX_RESULT_UNCONFIRMED');
        this.db.prepare("UPDATE max_retouch_jobs SET state='sent',result_mid=?,source_url='',instruction='' WHERE key=?").run(sent.message.body.mid, job.key);
        this.lastError = null;
      } catch (error) {
        this.db.prepare('UPDATE max_retouch_jobs SET state=?,retry_at=?,error_code=? WHERE key=?')
          .run(error.deliveryState === 'not_sent' ? 'ready' : 'uncertain', this.now() + 60000, 'MAX_RESULT_UNCONFIRMED', job.key);
      }
    } catch (error) {
      const current = this.db.prepare('SELECT state,attempts FROM max_retouch_jobs WHERE key=?').get(job.key);
      const transient = this.closed || ['RETOUCH_BUSY','RETOUCH_TRANSPORT','MAX_MEDIA_READ','MAX_MEDIA_UPLOAD','MAX_MEDIA_TIMEOUT'].includes(error.code);
      const retry = transient && current.attempts < 10;
      this.db.prepare('UPDATE max_retouch_jobs SET state=?,retry_at=?,error_code=? WHERE key=?')
        .run(retry ? (current.state === 'ready' ? 'ready' : 'queued') : 'failed', this.now() + 30000, error.code || 'RETOUCH_FAILED', job.key);
      this.lastError = error.code || 'RETOUCH_FAILED';
      if (!retry && !this.closed) await this.notice(options, job.chat_id, job.question_mid || job.photo_mid,
        'Не удалось подтвердить результат ретуши. Автоматически повторять генерацию не буду. Для новой попытки снова отметьте меня на фото.');
    } finally { this.controller = null; }
  }
  status() {
    const config = this.config();
    return { enabled: Boolean(config), chatCount: config?.chatIds.length || 0, dailyLimit: config?.dailyLimit ?? null,
      lastError: this.lastError || null, states: this.db.prepare('SELECT state,count(*) count FROM max_retouch_jobs GROUP BY state').all() };
  }
  async close() { this.closed = true; clearInterval(this.timer); this.controller?.abort(); await this.flight; }
}
