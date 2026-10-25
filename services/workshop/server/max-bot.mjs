import fs from 'node:fs';
import https from 'node:https';
import crypto from 'node:crypto';

const HELP = 'Мастерская · VM_bot\n/orders — активные заказы\n/order 12 — заказ по номеру\n/help — команды\nДанные читаются из Мастерской. Изменение сумм и статусов пока не подключено.';
const clean = value => String(value ?? '').replace(/[\r\n\t]/gu, ' ').slice(0, 160);
const money = value => typeof value === 'number' && Number.isFinite(value) ? `${value.toLocaleString('ru-RU')} ₽` : 'не указано';

export function maxReply(input, board) {
  const command = input.trim().replace(/@\w+_bot\b/giu, '').trim();
  if (/^(?:\/help|\/start|помощь)$/iu.test(command)) return HELP;
  if (/^(?:\/orders|заказы)$/iu.test(command)) {
    const orders = board.orders.filter(order => !['Сдан', 'Отменён', 'Отменен'].includes(order.status));
    const lines = orders.slice(0, 15).map(order => `№${clean(order.id)} · ${clean(order.title)} · ${clean(order.status)} · срок ${clean(order.dueDate) || 'не указан'}`);
    return `Активных заказов: ${orders.length}\n${lines.join('\n') || 'Нет активных заказов.'}${orders.length > 15 ? '\nПоказаны первые 15. Детали: /order номер' : ''}\nАктуально: ${clean(board.updatedAt)}`;
  }
  const match = command.match(/^(?:\/order|заказ)\s+#?(\d+)$/iu);
  if (!match) return null;
  const orders = board.orders.filter(order => String(order.id) === match[1]);
  if (orders.length !== 1) return orders.length ? 'Номер заказа повторяется в таблице. Проверьте его в Мастерской.' : 'Заказ с таким номером не найден.';
  const order = orders[0];
  return [`Заказ №${clean(order.id)} · ${clean(order.title)}`, `Клиент: ${clean(order.client)}`, `Статус: ${clean(order.status)}`, `Срок: ${clean(order.dueDate) || 'не указан'}`, `Сумма заказа: ${money(order.amount)}`, `Внесено: ${money(order.paid)}`, ...order.items.slice(0, 10).map(item => `• ${clean(item.name)} · ${clean(item.quantity)} ${clean(item.unit)}`), `Актуально: ${clean(board.updatedAt)}`].join('\n');
}

export function maxApi(config, route, payload) {
  return new Promise((resolve, reject) => {
    // A delivery timeout can happen after MAX accepted the message. Consumers
    // may retry only errors that prove no message was submitted/accepted.
    const failure = (message, deliveryState = 'unknown') => Object.assign(new Error(message), { deliveryState });
    let ca, token;
    try { ca = fs.readFileSync(config.caFile); token = fs.readFileSync(config.tokenFile, 'utf8').trim(); }
    catch { reject(failure('MAX_API_UNAVAILABLE', 'not_sent')); return; }
    const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
    let request;
    try { request = https.request(`https://platform-api2.max.ru${route}`, {
      method: data ? 'POST' : 'GET', ca,
      headers: { Authorization: token, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) },
    }, response => {
      let size = 0; const chunks = [];
      response.on('data', chunk => { size += chunk.length; if (size > 256 * 1024) response.destroy(new Error('MAX_RESPONSE_SIZE')); else chunks.push(chunk); });
      response.on('error', () => reject(failure('MAX_API_UNAVAILABLE')));
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(failure('MAX_API_UNAVAILABLE', response.statusCode >= 400 && response.statusCode < 500 ? 'not_sent' : 'unknown'));
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString());
          if (result.success === false) return reject(failure('MAX_API_RESPONSE', 'not_sent'));
          resolve(result);
        } catch { reject(failure('MAX_API_RESPONSE')); }
      });
    }); } catch { reject(failure('MAX_API_UNAVAILABLE', 'not_sent')); return; }
    const timer = setTimeout(() => request.destroy(new Error('MAX_API_TIMEOUT')), 10_000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', error => reject(failure('MAX_API_UNAVAILABLE',
      ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(error.code) ? 'not_sent' : 'unknown')));
    request.end(data);
  });
}

// All bot consumers share MAX's per-recipient send limit, including retouch and notices.
export function serializeMaxSend(send, { intervalMs = 550, now = Date.now,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const recipients = new Map();
  return (...args) => {
    const key = `${args[3] || 'chat'}:${args[1]}`;
    const recipient = recipients.get(key) || { at: -Infinity, tail: Promise.resolve() };
    recipients.set(key, recipient);
    const flight = recipient.tail.then(async () => {
      const pause = recipient.at + intervalMs - now();
      if (pause > 0) await wait(pause);
      const preparedArgs = args.slice(0, 5);
      if (typeof args[5] === 'function') {
        let prepared;
        try { prepared = await args[5](); }
        catch (error) { throw Object.assign(error, { deliveryState: 'not_sent' }); }
        if (!prepared) throw Object.assign(new Error('MAX_SEND_CANCELLED'), { deliveryState: 'not_sent' });
        if (prepared.config) preparedArgs[0] = prepared.config;
        if (typeof prepared.text === 'string') preparedArgs[2] = prepared.text;
      }
      recipient.at = now();
      return send(...preparedArgs);
    });
    recipient.tail = flight.catch(() => {});
    return flight;
  };
}

export class MaxBot {
  constructor({ db, readBoard, configFile = process.env.MAX_BOT_CONFIG_FILE, config, send, sendIntervalMs = 550 }) {
    Object.assign(this, { db, readBoard, configFile, config });
    this.send = serializeMaxSend(send || ((settings, id, text, kind = 'chat', extra = {}) => maxApi(settings, `/messages?${kind === 'user' ? 'user_id' : 'chat_id'}=${encodeURIComponent(id)}`, { text, ...extra })), { intervalMs: sendIntervalMs });
    this.flights = new Map(); this.recent = new Map();
    db.exec('CREATE TABLE IF NOT EXISTS max_bot_events (key TEXT PRIMARY KEY, at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS max_bot_chats (chat_id TEXT PRIMARY KEY, state TEXT NOT NULL, at TEXT NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS max_bot_users (user_id TEXT PRIMARY KEY, at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS max_bot_pairings (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL)');
  }
  settings() { return this.config || (this.configFile ? JSON.parse(fs.readFileSync(this.configFile, 'utf8')) : null); }
  authorized(secret) {
    const config = this.settings();
    if (!config?.secret || typeof secret !== 'string') return false;
    const actual = Buffer.from(secret), expected = Buffer.from(config.secret);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }
  observeSales(update, config) {
    if (!this.observeMessage) return;
    try {
      if (update.update_type === 'message_removed') {
        const chatId=String(update.chat_id), userId=String(update.user_id);
        if (config.allowedChatIds?.map(String).includes(chatId)) this.observeMessage({removed:true,nativeId:update.message_id,kind:'chat',id:chatId,chatId,timestamp:update.timestamp});
        else if (this.db.prepare('SELECT 1 FROM max_bot_users WHERE user_id=?').get(userId)) this.observeMessage({removed:true,nativeId:update.message_id,kind:'user',id:userId,chatId,timestamp:update.timestamp});
        return;
      }
      const message=update.message;
      if (!['message_created','message_edited'].includes(update.update_type) || message?.sender?.is_bot || !message?.body?.mid) return;
      const kind=message.recipient?.chat_type==='dialog'?'user':message.recipient?.chat_type==='chat'?'chat':null;
      const id=kind==='user'?message.sender?.user_id:message.recipient?.chat_id;
      if (!kind || !Number.isSafeInteger(id)) return;
      const allowed=kind==='chat'?config.allowedChatIds?.map(String).includes(String(id)):this.db.prepare('SELECT 1 FROM max_bot_users WHERE user_id=?').get(String(id));
      if (allowed) this.observeMessage({message,kind,id:String(id),timestamp:update.timestamp,updateType:update.update_type});
    } catch { console.error(JSON.stringify({event:'sales_observer_failed',source:'max'})); }
  }
  async process(update) {
    const config = this.settings();
    if (!config) return;
    if (['bot_added', 'bot_removed'].includes(update.update_type) && Number.isSafeInteger(update.chat_id)) {
      this.db.prepare('INSERT OR REPLACE INTO max_bot_chats VALUES (?,?,?)').run(String(update.chat_id), update.update_type, new Date().toISOString());
      return;
    }
    this.observeSales(update,config);
    const message = update.message;
    if (update.update_type !== 'message_created' || message?.sender?.is_bot) return;
    const kind = message?.recipient?.chat_type === 'dialog' ? 'user' : message?.recipient?.chat_type === 'chat' ? 'chat' : null;
    if (!kind) return;
    const id = kind === 'user' ? message.sender?.user_id : message.recipient.chat_id;
    if (!Number.isSafeInteger(id)) return;
    const chatId = String(id);
    if (kind === 'chat' && this.retouch && await this.retouch.process(message)) return;
    const input = message.body?.text;
    if (typeof input !== 'string' || input.length > 2000 || !message.body?.mid) return;
    if (kind === 'user' && /^\/connect\s/iu.test(input.trim())) return this.connect(config, chatId, input);
    if (kind === 'chat' ? !config.allowedChatIds?.map(String).includes(chatId)
      : !this.db.prepare('SELECT user_id FROM max_bot_users WHERE user_id=?').get(chatId)) return;
    const key = crypto.createHash('sha256').update(`${kind}:${chatId}:${message.body.mid}`).digest('hex');
    if (this.db.prepare('SELECT key FROM max_bot_events WHERE key=?').get(key)) return;
    if (!/^(?:\/(?:help|start|orders)(?:@\w+_bot)?|\/order(?:@\w+_bot)?\s+#?\d+|заказы|заказ\s+#?\d+|помощь)$/iu.test(input.trim())) {
      if (kind === 'user' && config.codexEnabled && this.assistant && !this.assistant.enqueue({key,id:chatId,text:input,meta:{messageId:String(message.body.mid).slice(0,160)}})) {
        await this.send(config,chatId,'Достигнут лимит запросов или очередь занята. Попробуй позже. /orders и /order доступны.','user');
        this.db.prepare('INSERT OR IGNORE INTO max_bot_events VALUES (?,?)').run(key,new Date().toISOString());
      }
      return;
    }
    if (this.flights.has(key)) return this.flights.get(key);
    const work = this.reply(config, chatId, input, key, kind);
    this.flights.set(key, work);
    try { await work; } finally { this.flights.delete(key); }
  }
  async connect(config, userId, input) {
    const code = input.trim().match(/^\/connect ([a-zA-Z0-9-]{16,64})$/u)?.[1];
    if (!code || !config.pairingHash || Date.now() > Date.parse(config.pairingExpiresAt) || !Number.isFinite(Date.parse(config.pairingExpiresAt))) return;
    const hash = crypto.createHash('sha256').update(code).digest('hex');
    const actual = Buffer.from(hash), expected = Buffer.from(config.pairingHash);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return;
    const approved = this.db.transaction(() => {
      const used = this.db.prepare('SELECT user_id FROM max_bot_pairings WHERE hash=?').get(hash);
      if (used && used.user_id !== userId) return false;
      this.db.prepare('INSERT OR IGNORE INTO max_bot_pairings VALUES (?,?)').run(hash, userId);
      this.db.prepare('INSERT OR IGNORE INTO max_bot_users VALUES (?,?)').run(userId, new Date().toISOString());
      return true;
    })();
    if (approved) await this.send(config, userId, `Личный доступ к Мастерской подключён.\n${HELP}`, 'user');
  }
  async reply(config, chatId, input, key, kind = 'chat') {
    const rateKey = `${kind}:${chatId}`;
    const last = this.recent.get(rateKey) || 0;
    if (Date.now() - last < 2000) return;
    const help = /^(?:\/(?:help|start)(?:@\w+_bot)?|помощь)$/iu.test(input.trim());
    const board = help ? null : await this.readBoard();
    const reply = maxReply(input, board);
    if (!reply) return;
    const selected=input.trim().match(/^(?:\/order|заказ)\s+#?(\d+)$/iu)?.[1];
    if(kind==='user' && selected && board.orders.filter(order=>String(order.id)===selected).length===1)this.notes?.select(chatId,selected);
    await this.send(config, chatId, reply + (help && config.codexEnabled ? '\nМожно задавать вопросы обычным текстом. /search запрос — поиск в интернете. Предупреждения о заказах приходят днём.' : '') + (help && config.notesEnabled?'\nНовые уточнения по явно указанному заказу дописываются в комментарий с пометкой «Внесено ботом». /order номер выбирает заказ на час.':''), kind);
    this.recent.set(rateKey, Date.now());
    this.db.prepare('INSERT OR IGNORE INTO max_bot_events VALUES (?,?)').run(key, new Date().toISOString());
    this.db.prepare("DELETE FROM max_bot_events WHERE at < datetime('now','-30 days')").run();
  }
}
