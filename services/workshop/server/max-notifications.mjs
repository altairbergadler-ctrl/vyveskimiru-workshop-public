import { isMeasurement, isoDate } from './finance-contract.mjs';
import crypto from 'node:crypto';

const clean = value => String(value ?? '').replaceAll('\0', ' ').replace(/[\r\n\t]/gu, ' ').trim().slice(0, 120);
const money = value => `${value.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
const dateText = value => {
  const raw = clean(value), iso = isoDate(raw);
  if (!iso) return raw;
  const date = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso) return raw;
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).replace(/\s*г\.$/u, '');
};
const balanceNotice = (balance, threshold) => [
  '⚠️ Авито · пора пополнить кошелёк', '',
  `Деньги: ${money(balance.real)}`, `Бонусы: ${money(balance.bonus)}`, '',
  `Баланс денег ниже порога ${money(threshold)}.`, 'Пополните кошелёк Авито.',
].join('\n');

export function incomeNotice(record) {
  const purpose = isMeasurement(record) ? 'Замеры' : clean(record.category) || 'Оплата заказа';
  return [`💰 Поступило ${money(record.amount)}`, '',
    [record.orderNumber ? `Заказ №${clean(record.orderNumber)}` : '', purpose].filter(Boolean).join(' · '),
    `Касса / счёт: ${clean(record.account) || 'не указан'}`, `Дата: ${dateText(record.date) || 'не указана'}`, '',
    'Мастерская: https://vm-app.ru/'].join('\n');
}

const known = value => typeof value === 'number' && Number.isFinite(value);
const paymentStamp = record => crypto.createHash('sha256').update(JSON.stringify([record?.amount, record?.date, record?.account])).digest('hex');
const cancelled = order => ['отменён', 'отменен'].includes(String(order.status).trim().toLocaleLowerCase('ru-RU'));
const eligibleOrder = (order, policy) => order && !cancelled(order) && known(order.paid) && order.paid > 0
  && (policy === 'first' || (known(order.amount) && order.amount > 0 && order.paid >= order.amount && known(order.debt) && order.debt <= 0));
const linkedPayment = (order, record) => {
  if (!order || !record || record.orderNumber !== order.id || !(record.amount > 0) || isMeasurement(record)) return false;
  const payments = order.payments.filter(payment => payment.edit?.record?.key === record.id);
  return payments.length === 1 && known(payments[0].amount) && payments[0].amount > 0 && payments[0].financeAmount === record.amount
    && payments[0].account === record.account && payments[0].date === record.date;
};
const confirmedPayments = (order, records) => order.payments.length
  ? order.payments.every(payment => linkedPayment(order, records.get(payment.edit?.record?.key))) : order.paid === 0;
const stableMoney = order => known(order.amount) && order.amount > 0 && known(order.paid) && known(order.debt)
  && (order.paid >= order.amount ? order.debt <= 0 : order.debt > 0);
const amountText = (value, unknown = 'не указано') => known(value) ? money(value) : unknown;
const detail = value => {
  const text = String(value ?? '').replaceAll('\0', '').replace(/\r\n?/gu, '\n').trim();
  return text.length > 1000 ? `${text.slice(0, 950)}… Продолжение в карточке заказа.` : text;
};
export function paidOrderNotice(order, policy = 'first') {
  const lines = [`📦 Заказ №${clean(order.id)} · ${policy === 'full' ? 'полная оплата' : 'первая оплата'}`,
    ...(clean(order.title) ? [clean(order.title)] : []), '',
    `Клиент: ${clean(order.client) || 'не указан'}`, `📅 Срок: ${dateText(order.dueDate) || 'не указан'}`, '',
    'ОПЛАТА', `Стоимость заказа: ${amountText(order.amount, 'не указана')}`, `Внесено: ${amountText(order.paid)}`,
    known(order.debt) && order.debt < 0 ? `Переплата: ${money(-order.debt)}` : `К доплате: ${amountText(order.debt)}`,
    '', 'СОСТАВ ЗАКАЗА'];
  const footer = '\n\nЗаказы: https://vm-app.ru/kanban/';
  const omission = count => `Ещё позиций: ${count}. Полный состав — по ссылке ниже.`;
  const reserved = `\n\n${omission(order.items.length)}${footer}`;
  let omitted = 0;
  for (const [index, item] of order.items.entries()) {
    const dimensions = [item.width, item.height].map(value => known(value) && value > 0 ? String(value).replace('.', ',') : '?');
    const line = [`${index + 1}. ${clean(item.name) || 'Позиция без названия'}`,
      ...(dimensions.some(value => value !== '?') ? [`   Размер: ${dimensions.join(' × ')} м`] : []),
      `   Количество: ${known(item.quantity) ? String(item.quantity).replace('.', ',') : '?'}${clean(item.unit) ? ` ${clean(item.unit)}` : ''}`,
      ...detail(item.description).split('\n').filter(Boolean).map(value => `   ${value}`)].join('\n');
    // MAX accepts at most 4000 characters. Keep the link and make omissions explicit.
    if (lines.join('\n').length + 2 + line.length + reserved.length > 4000) { omitted++; continue; }
    lines.push('', line);
  }
  if (!order.items.length) lines.push('', 'Позиции ещё не указаны.');
  if (omitted) lines.push('', omission(omitted));
  return lines.join('\n') + footer;
}

// Consumes the existing confirmed finance refresh; never reads or writes Google.
// SQLite keeps observation IDs, delivery receipts and pending message text only.
// Notification recipients are separate from the bot's order-command allowlist.
export class MaxNotifications {
  constructor({ db, settings, send, balance, now = Date.now }) {
    Object.assign(this, { db, settings, send, balance, now });
    this.closed = false; this.lastError = null;
    db.exec(`CREATE TABLE IF NOT EXISTS max_notification_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS max_notification_income (chat_id TEXT NOT NULL, record_id TEXT NOT NULL,
        PRIMARY KEY(chat_id, record_id));
      CREATE TABLE IF NOT EXISTS max_notification_order_income (chat_id TEXT NOT NULL, record_id TEXT NOT NULL,
        PRIMARY KEY(chat_id, record_id));
      CREATE TABLE IF NOT EXISTS max_notification_orders (chat_id TEXT NOT NULL, order_id TEXT NOT NULL,
        PRIMARY KEY(chat_id, order_id));
      CREATE TABLE IF NOT EXISTS max_notification_order_candidates (chat_id TEXT NOT NULL, order_id TEXT NOT NULL,
        record_id TEXT NOT NULL, fingerprint TEXT NOT NULL, raw_amount REAL, PRIMARY KEY(chat_id, order_id, record_id));
      CREATE TABLE IF NOT EXISTS max_notification_order_progress (chat_id TEXT NOT NULL, order_id TEXT NOT NULL,
        paid REAL, PRIMARY KEY(chat_id, order_id));
      CREATE TABLE IF NOT EXISTS max_notification_outbox (key TEXT PRIMARY KEY, chat_id TEXT NOT NULL,
        kind TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL,
        message_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0);`);
    const columns = new Set(db.prepare('PRAGMA table_info(max_notification_outbox)').all().map(column => column.name));
    for (const column of ['order_id', 'payment_id']) if (!columns.has(column)) db.exec(`ALTER TABLE max_notification_outbox ADD COLUMN ${column} TEXT`);
    // This singleton starts once per backend process. A previous process may
    // have died after MAX accepted a send, before its acknowledgement persisted.
    db.prepare("UPDATE max_notification_outbox SET state='uncertain' WHERE state='submitting'").run();
    for (const job of db.prepare("SELECT chat_id,order_id FROM max_notification_outbox WHERE kind='paid_order' AND state IN ('sent','uncertain')").all()) {
      db.prepare('DELETE FROM max_notification_order_candidates WHERE chat_id=? AND order_id=?').run(job.chat_id, job.order_id);
    }
  }
  config() {
    if (this.closed) return null;
    let config;
    try { config = this.settings(); this.configurationError = null; }
    catch {
      // This optional integration must not reject the backend's periodic
      // module check when its secret file is missing/unreadable/malformed.
      this.configurationError = { code: 'MAX_CONFIG_UNAVAILABLE', at: new Date(this.now()).toISOString() };
      return null;
    }
    const options = config?.notifications;
    if (options?.enabled !== true || !Array.isArray(options.chatIds)) return null;
    const chatIds = [...new Set(options.chatIds.map(String))].filter(id => /^-?\d{1,16}$/u.test(id)
      && Number.isSafeInteger(Number(id))
      && this.db.prepare('SELECT state FROM max_bot_chats WHERE chat_id=?').get(id)?.state === 'bot_added');
    if (!chatIds.length) return null;
    return { config, chatIds, income: options.income === true,
      orderPolicy: ['first', 'full'].includes(options.paidOrders) ? options.paidOrders : null,
      threshold: typeof options.avitoThreshold === 'number' && Number.isFinite(options.avitoThreshold)
        && options.avitoThreshold > 0 ? options.avitoThreshold : null };
  }
  state(key) { const row = this.db.prepare('SELECT value FROM max_notification_state WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; }
  save(key, value) { this.db.prepare('INSERT OR REPLACE INTO max_notification_state VALUES (?,?)').run(key, JSON.stringify(value)); }
  enqueue(key, chatId, kind, text, orderId = null, paymentId = null) {
    this.db.prepare("INSERT OR IGNORE INTO max_notification_outbox(key,chat_id,kind,text,state,created_at,order_id,payment_id) VALUES (?,?,?,?,'pending',?,?,?)")
      .run(key, chatId, kind, text, new Date(this.now()).toISOString(), orderId, paymentId);
  }
  observeIncome(records) {
    if (this.incomeFlight) return this.incomeFlight;
    this.incomeFlight = this.observe(records).finally(() => { this.incomeFlight = null; });
    return this.incomeFlight;
  }
  invalidateFinance() { this.financeSnapshot = null; }
  async observe(records) {
    const options = this.config();
    if (!options || (!options.income && !options.orderPolicy)) return;
    this.invalidateFinance();
    if (!Array.isArray(records)) throw new Error('MAX_INCOME_SNAPSHOT');
    const incomes = records.filter(record => record.type === 'income');
    const ids = new Set();
    for (const record of incomes) {
      if (typeof record.id !== 'string' || !record.id || ids.has(record.id)
          || typeof record.amount !== 'number' || !Number.isFinite(record.amount) || record.pending
          || record.deletedAt) throw new Error('MAX_INCOME_UNCONFIRMED');
      ids.add(record.id);
    }
    this.financeSnapshot = { records: incomes, loadedAt: this.now() };
    if (options.income) this.db.transaction(() => {
      for (const chatId of options.chatIds) {
        const key = `income:${chatId}`, initialized = this.state(key);
        for (const record of incomes) {
          const inserted = this.db.prepare('INSERT OR IGNORE INTO max_notification_income VALUES (?,?)').run(chatId, record.id).changes;
          // First successful snapshot establishes the baseline, even if empty.
          // Existing IDs stay seen after edits/deletion/restart: edits are not income.
          if (initialized && inserted && record.amount > 0) this.enqueue(`${key}:${record.id}`, chatId, 'income', incomeNotice(record));
        }
        if (!initialized) this.save(key, { initializedAt: new Date(this.now()).toISOString() });
      }
    })();
    // Pair the two existing refreshes regardless of which finishes first at startup.
    if (this.boardSnapshot) await this.observeOrders(this.boardSnapshot);
    await this.drain();
  }
  observeOrders(board) {
    if (this.orderFlight) return this.orderFlight;
    this.orderFlight = this.observePaidOrders(board).catch(error => {
      // This optional consumer must not reject void checkModules or stop Workshop.
      this.invalidateOrders();
      this.lastOrderError = { code: ['SQLITE_BUSY', 'SQLITE_FULL', 'SQLITE_READONLY'].includes(error.code) ? error.code : 'ORDER_NOTIFICATION_UNAVAILABLE', at: new Date(this.now()).toISOString() };
    }).finally(() => { this.orderFlight = null; });
    return this.orderFlight;
  }
  invalidateOrders() { this.boardSnapshot = null; }
  async observePaidOrders(board) {
    const options = this.config();
    if (!options?.orderPolicy) return;
    // Consume the existing module health read, never start another Google collector.
    // A fresh finance read must confirm the exact linked payment before notifying.
    if (!Array.isArray(board?.orders) || !Number.isFinite(Date.parse(board.updatedAt))
        || this.now() - Date.parse(board.updatedAt) > 30000 || Date.parse(board.updatedAt) > this.now() + 5000) { this.boardSnapshot = null; return; }
    const byId = new Map(), paymentIds = new Set();
    for (const order of board.orders) {
      if (typeof order.id !== 'string' || !order.id || !Array.isArray(order.items) || !Array.isArray(order.payments)) { this.boardSnapshot = null; return; }
      for (const payment of order.payments) {
        const id = payment.edit?.record?.key;
        if (!id) continue;
        if (paymentIds.has(id)) { this.boardSnapshot = null; return; }
        paymentIds.add(id);
      }
      // Duplicate order numbers cannot select someone's composition safely.
      byId.set(order.id, byId.has(order.id) ? null : order);
    }
    this.boardSnapshot = board;
    const snapshot = this.financeSnapshot;
    if (!snapshot || this.now() - snapshot.loadedAt > 90000) return;
    const records = new Map(snapshot.records.map(record => [record.id, record]));
    this.db.transaction(() => {
      for (const chatId of options.chatIds) {
        const key = `orders:${chatId}`, state = this.state(key);
        const initialized = state?.policy === options.orderPolicy;
        for (const record of snapshot.records) {
          const inserted = this.db.prepare('INSERT OR IGNORE INTO max_notification_order_income VALUES (?,?)').run(chatId, record.id).changes;
          if (initialized && inserted && record.amount > 0 && record.orderNumber && !isMeasurement(record)) {
            this.db.prepare('INSERT OR IGNORE INTO max_notification_order_candidates(chat_id,order_id,record_id,fingerprint) VALUES (?,?,?,?)').run(chatId, record.orderNumber, record.id, paymentStamp(record));
          } else if (initialized) {
            for (const candidate of this.db.prepare('SELECT * FROM max_notification_order_candidates WHERE chat_id=? AND record_id=?').all(chatId, record.id)) {
              if (candidate.fingerprint !== paymentStamp(record)) {
                // Editing an observed payment's money/date/account is not a new receipt.
                this.db.prepare('DELETE FROM max_notification_order_candidates WHERE chat_id=? AND record_id=?').run(chatId, record.id);
              } else if (record.amount > 0 && record.orderNumber && !isMeasurement(record) && candidate.order_id !== record.orderNumber) {
                // Follow a corrected order link only before any delivery attempt.
                this.db.prepare('DELETE FROM max_notification_order_candidates WHERE chat_id=? AND record_id=?').run(chatId, record.id);
                this.db.prepare('INSERT OR IGNORE INTO max_notification_order_candidates VALUES (?,?,?,?,?)').run(chatId, record.orderNumber, record.id, candidate.fingerprint, candidate.raw_amount);
              }
            }
          }
        }
        if (!initialized) {
          const previousJobs = this.db.prepare("SELECT order_id FROM max_notification_outbox WHERE chat_id=? AND kind='paid_order' AND state='pending'").all(chatId);
          for (const job of previousJobs) this.db.prepare('DELETE FROM max_notification_orders WHERE chat_id=? AND order_id=?').run(chatId, job.order_id);
          this.db.prepare("UPDATE max_notification_outbox SET state='cancelled',text='' WHERE chat_id=? AND kind='paid_order' AND state='pending'").run(chatId);
          this.db.prepare('DELETE FROM max_notification_order_candidates WHERE chat_id=?').run(chatId);
          for (const order of byId.values()) if (order) {
            if (eligibleOrder(order, options.orderPolicy)) this.db.prepare('INSERT OR IGNORE INTO max_notification_orders VALUES (?,?)').run(chatId, order.id);
            this.db.prepare('INSERT OR REPLACE INTO max_notification_order_progress VALUES (?,?,?)').run(chatId, order.id, known(order.paid) ? order.paid : null);
          }
          this.save(key, { policy: options.orderPolicy, initializedAt: new Date(this.now()).toISOString() });
          continue;
        }
        for (const order of byId.values()) {
          if (!order) continue;
          const candidates = this.db.prepare('SELECT * FROM max_notification_order_candidates WHERE chat_id=? AND order_id=?').all(chatId, order.id);
          const compatible = [];
          for (const value of candidates) {
            if (value.fingerprint !== paymentStamp(records.get(value.record_id)) || !linkedPayment(order, records.get(value.record_id))) continue;
            const rawAmount = order.payments.find(payment => payment.edit?.record?.key === value.record_id).amount;
            if (known(value.raw_amount) && value.raw_amount !== rawAmount) {
              // Finance's rounded rubles can hide a manual cents correction.
              this.db.prepare('DELETE FROM max_notification_order_candidates WHERE chat_id=? AND order_id=? AND record_id=?').run(chatId, order.id, value.record_id);
              continue;
            }
            if (value.raw_amount === null) this.db.prepare('UPDATE max_notification_order_candidates SET raw_amount=? WHERE chat_id=? AND order_id=? AND record_id=?').run(rawAmount, chatId, order.id, value.record_id);
            compatible.push(value);
          }
          const candidate = compatible[0];
          const progress = this.db.prepare('SELECT paid FROM max_notification_order_progress WHERE chat_id=? AND order_id=?').get(chatId, order.id);
          const complete = confirmedPayments(order, records);
          const increased = known(order.paid) && (!progress || !known(progress.paid) || order.paid > progress.paid);
          if (candidate && eligibleOrder(order, options.orderPolicy) && (options.orderPolicy === 'first' || (complete && increased))) {
            const inserted = this.db.prepare('INSERT OR IGNORE INTO max_notification_orders VALUES (?,?)').run(chatId, order.id).changes;
            if (inserted) this.enqueue(`order:${options.orderPolicy}:${chatId}:${order.id}:${candidate.record_id}`, chatId, 'paid_order', paidOrderNotice(order, options.orderPolicy), order.id, candidate.record_id);
            if (!inserted && !this.db.prepare("SELECT 1 FROM max_notification_outbox WHERE chat_id=? AND order_id=? AND kind='paid_order' AND state IN ('pending','submitting')").get(chatId, order.id)) {
              this.db.prepare('DELETE FROM max_notification_order_candidates WHERE chat_id=? AND order_id=?').run(chatId, order.id);
            }
          }
          // Keep candidates through partial totals: several already-linked payments
          // may precede Google's paid recalculation. Price edits leave paid unchanged
          // and cannot activate them. An unknown previous paid is never assumed zero.
          if (complete && known(order.paid) && (options.orderPolicy === 'first' || stableMoney(order))) this.db.prepare('INSERT OR REPLACE INTO max_notification_order_progress VALUES (?,?,?)').run(chatId, order.id, order.paid);
        }
      }
    })();
    this.lastOrderError = null;
    await this.drain();
  }
  paidOrderDelivery(job, policy) {
    const board = this.boardSnapshot, snapshot = this.financeSnapshot;
    if (!board || this.now() - Date.parse(board.updatedAt) > 30000 || !snapshot || this.now() - snapshot.loadedAt > 90000) return null;
    const orders = board.orders.filter(order => order.id === job.order_id);
    const order = orders.length === 1 ? orders[0] : null;
    const records = new Map(snapshot.records.map(record => [record.id, record]));
    let record = records.get(job.payment_id);
    if (!record) {
      const alternatives = this.db.prepare('SELECT * FROM max_notification_order_candidates WHERE chat_id=? AND order_id=?').all(job.chat_id, job.order_id)
        .filter(candidate => candidate.fingerprint === paymentStamp(records.get(candidate.record_id)) && records.has(candidate.record_id));
      const alternative = alternatives.find(candidate => linkedPayment(order, records.get(candidate.record_id)));
      if (alternative && eligibleOrder(order, policy) && (policy === 'first' || confirmedPayments(order, records))) {
        record = records.get(alternative.record_id); job.payment_id = record.id;
        this.db.prepare("UPDATE max_notification_outbox SET payment_id=? WHERE key=? AND state='pending'").run(record.id, job.key);
      } else if (alternatives.length) return null; // Wait for the board to catch up after corrected/deleted money.
    }
    if (!record || record.orderNumber !== job.order_id || (order && cancelled(order))) {
      this.db.prepare("UPDATE max_notification_outbox SET state='cancelled',text='' WHERE key=? AND state='pending'").run(job.key);
      this.db.prepare('DELETE FROM max_notification_orders WHERE chat_id=? AND order_id=?').run(job.chat_id, job.order_id);
      if (record && record.orderNumber !== job.order_id && record.orderNumber && record.amount > 0 && !isMeasurement(record)) {
        this.db.prepare('INSERT OR IGNORE INTO max_notification_order_candidates(chat_id,order_id,record_id,fingerprint) VALUES (?,?,?,?)').run(job.chat_id, record.orderNumber, record.id, paymentStamp(record));
      }
      return null;
    }
    if (!eligibleOrder(order, policy) || !linkedPayment(order, record) || (policy === 'full' && !confirmedPayments(order, records))) return null;
    return paidOrderNotice(order, policy);
  }
  checkBalance() {
    if (this.balanceFlight) return this.balanceFlight;
    this.balanceFlight = this.check().finally(() => { this.balanceFlight = null; });
    return this.balanceFlight;
  }
  async check() {
    const options = this.config();
    if (!options?.threshold) return;
    try {
      const balance = await this.balance();
      if (balance.currency !== 'RUB' || typeof balance.real !== 'number' || !Number.isFinite(balance.real) || balance.real < 0
          || typeof balance.bonus !== 'number' || !Number.isFinite(balance.bonus) || balance.bonus < 0
          || !balance.accountId || !Number.isFinite(Date.parse(balance.loadedAt))
          || this.now() - Date.parse(balance.loadedAt) > 30000
          || Date.parse(balance.loadedAt) > this.now() + 5000) throw new Error('MAX_BALANCE_UNCONFIRMED');
      const current = this.config();
      if (!current || current.threshold !== options.threshold) return;
      this.db.transaction(() => {
        for (const chatId of options.chatIds.filter(id => current.chatIds.includes(id))) {
          const key = `balance:${chatId}`, previous = this.state(key);
          let state = previous;
          if (!state || state.accountId !== balance.accountId || state.threshold !== options.threshold) {
            // Changing recipient policy/account cannot reuse an old low-balance episode.
            this.db.prepare("UPDATE max_notification_outbox SET state='cancelled',text='' WHERE chat_id=? AND kind='avito' AND state='pending'").run(chatId);
            state = { accountId: balance.accountId, threshold: options.threshold, low: false, episode: previous?.episode || 0 };
          }
          const low = balance.real < options.threshold;
          if (low && !state.low) {
            state.episode++;
            this.enqueue(`balance:${chatId}:${state.episode}`, chatId, 'avito', balanceNotice(balance, options.threshold));
          }
          if (low) this.db.prepare("UPDATE max_notification_outbox SET text=? WHERE key=? AND state='pending'")
            .run(balanceNotice(balance, options.threshold), `balance:${chatId}:${state.episode}`);
          if (!low) this.db.prepare("UPDATE max_notification_outbox SET state='cancelled',text='' WHERE chat_id=? AND kind='avito' AND state='pending'").run(chatId);
          this.save(key, { ...state, low, checkedAt: balance.loadedAt });
        }
      })();
      this.lastError = null;
      await this.drain();
    } catch (error) {
      this.lastError = { code: error.code || 'BALANCE_UNAVAILABLE', at: new Date(this.now()).toISOString() };
      // A failed balance read keeps the episode unchanged and sends no stale warning.
    }
  }
  drain() {
    if (this.deliveryFlight) return this.deliveryFlight;
    this.deliveryFlight = this.deliver().finally(() => { this.deliveryFlight = null; });
    return this.deliveryFlight;
  }
  prepareDelivery(key) {
    // Runs inside MaxBot.send after all per-chat waiting, immediately before POST.
    const job = this.db.prepare('SELECT * FROM max_notification_outbox WHERE key=?').get(key);
    if (job?.state !== 'pending') return null;
    const options = this.config();
    if (!options?.chatIds.includes(job.chat_id)) return null;
    if (job.kind === 'income' && !options.income) return null;
    if (job.kind === 'avito' && !options.threshold) return null;
    if (job.kind === 'paid_order' && (!options.orderPolicy || !job.key.startsWith(`order:${options.orderPolicy}:`))) return null;
    if (job.kind === 'paid_order') {
      const text = this.paidOrderDelivery(job, options.orderPolicy);
      if (!text) return null;
      job.text = text;
      this.db.prepare("UPDATE max_notification_outbox SET text=? WHERE key=? AND state='pending'").run(text, job.key);
    }
    if (job.kind === 'avito') {
      const state = this.state(`balance:${job.chat_id}`);
      if (!state?.low || state.threshold !== options.threshold || this.now() - Date.parse(state.checkedAt) > 30000) return null;
    }
    this.db.prepare("UPDATE max_notification_outbox SET state='submitting' WHERE key=? AND state='pending'").run(job.key);
    return { config: options.config, text: job.text };
  }
  async deliver() {
    const jobs = this.db.prepare("SELECT * FROM max_notification_outbox WHERE state='pending' AND retry_at<=? ORDER BY created_at,key LIMIT 30").all(this.now());
    for (const selected of jobs) {
      const job = this.db.prepare('SELECT * FROM max_notification_outbox WHERE key=?').get(selected.key);
      if (job?.state !== 'pending') continue;
      const options = this.config();
      if (!options?.chatIds.includes(job.chat_id)) continue;
      try {
        const result = await this.send(options.config, job.chat_id, job.text, 'chat', {}, () => this.prepareDelivery(job.key));
        if (typeof result?.message?.body?.mid !== 'string' || !result.message.body.mid) throw new Error('MAX_MESSAGE_UNCONFIRMED');
        this.db.prepare("UPDATE max_notification_outbox SET state='sent',text='',message_id=?,attempts=attempts+1 WHERE key=? AND state='submitting'")
          .run(result.message.body.mid, job.key);
        if (job.kind === 'paid_order') this.db.prepare('DELETE FROM max_notification_order_candidates WHERE chat_id=? AND order_id=?').run(job.chat_id, job.order_id);
      } catch (error) {
        if (error.deliveryState === 'not_sent') {
          this.db.prepare("UPDATE max_notification_outbox SET state='pending',attempts=attempts+1,retry_at=? WHERE key=? AND state='submitting'").run(this.now() + 60000, job.key);
        } else {
          // No blind resend after an accepted-but-unacknowledged message.
          this.db.prepare("UPDATE max_notification_outbox SET state='uncertain',attempts=attempts+1 WHERE key=? AND state='submitting'").run(job.key);
          if (job.kind === 'paid_order') this.db.prepare('DELETE FROM max_notification_order_candidates WHERE chat_id=? AND order_id=?').run(job.chat_id, job.order_id);
        }
      }
    }
  }
  status() {
    const options = this.config();
    return { enabled: Boolean(options), chatCount: options?.chatIds.length || 0, income: Boolean(options?.income),
      paidOrders: options?.orderPolicy ?? null,
      lastOrderError: this.lastOrderError ?? null,
      avitoThreshold: options?.threshold ?? null, lastBalanceError: this.lastError,
      configurationError: this.configurationError ?? null,
      pending: this.db.prepare("SELECT count(*) n FROM max_notification_outbox WHERE state='pending'").get().n,
      uncertain: this.db.prepare("SELECT count(*) n FROM max_notification_outbox WHERE state='uncertain'").get().n,
      sent: this.db.prepare("SELECT count(*) n FROM max_notification_outbox WHERE state='sent'").get().n };
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([this.incomeFlight, this.orderFlight, this.balanceFlight, this.deliveryFlight]);
  }
}
