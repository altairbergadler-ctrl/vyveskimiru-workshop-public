import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { MaxNotifications, incomeNotice, paidOrderNotice } from './max-notifications.mjs';
import { serializeMaxSend } from './max-bot.mjs';

const transport = send => serializeMaxSend(send, { intervalMs: 0 });

const record = (id, amount = 1000, extra = {}) => ({ id, type: 'income', amount, category: 'Аванс',
  date: '2026-10-15', orderNumber: '12', account: 'В кассе', pending: 0, deletedAt: null, ...extra });
function fixture(t) {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE max_bot_chats(chat_id TEXT PRIMARY KEY,state TEXT,at TEXT); INSERT INTO max_bot_chats VALUES('-10','bot_added','now')");
  t.after(() => db.close());
  const config = { allowedChatIds: [], notifications: { enabled: true, chatIds: ['-10'], income: true, avitoThreshold: 500 } };
  const sent = []; let now = Date.parse('2026-10-15T08:00:00Z'), reads = 0, failed = false, unavailable = false;
  let value = { accountId: '1234', real: 1000, bonus: 0, currency: 'RUB' };
  const deps = { db, settings: () => config, now: () => now,
    send: transport(async (_, id, text, kind) => {
      if (failed) throw Object.assign(new Error('fictional delivery failure'), { deliveryState: 'not_sent' });
      sent.push({ id, text, kind }); return { message: { body: { mid: `fictional-${sent.length}` } } };
    }), balance: async () => {
      reads++; if (unavailable) throw new Error('fictional network failure');
      return { ...value, loadedAt: new Date(now).toISOString() };
    } };
  return { db, config, sent, deps, notices: new MaxNotifications(deps), reads: () => reads,
    advance: () => { now += 300000; }, setBalance: v => { value = { ...value, ...v }; },
    deliveryFails: v => { failed = v; }, balanceFails: v => { unavailable = v; } };
}

const order = (id = '12', extra = {}) => ({ id, title: 'Вымышленная вывеска', client: 'Учебное кафе',
  status: 'В работе', dueDate: '2026-10-20', amount: 5000, paid: 1000, debt: 4000,
  items: [{ name: 'Световые буквы', description: 'Красный акрил; адрес учебный', quantity: 2.5, unit: 'м²', width: 2.4, height: 0.75 }],
  payments: [], ...extra });
const payment = record => ({ edit: { record: { key: record.id } }, amount: record.amount, financeAmount: record.amount, date: record.date, account: record.account });
const board = (f, orders = []) => ({ updatedAt: new Date(f.deps.now()).toISOString(), orders });

test('first paid-order snapshot stays silent; first advance includes composition once, top-ups/restart do not repeat it', async t => {
  const f = fixture(t); f.config.notifications.paidOrders = 'first';
  const old = record('old', 1000, { orderNumber: '1' });
  await f.notices.observeIncome([old]);
  await f.notices.observeOrders(board(f, [order('1', { payments: [payment(old)] }), order('12', { paid: 0 })]));
  assert.equal(f.sent.length, 0);
  const first = record('first');
  await f.notices.observeIncome([old, first]);
  await Promise.all([f.notices.observeOrders(board(f, [order('1'), order('12', { payments: [payment(first)] })])),
    f.notices.observeOrders(board(f, [order('1'), order('12', { payments: [payment(first)] })]))]);
  assert.equal(f.sent.filter(message => message.text.startsWith('📦 Заказ')).length, 1);
  const text = f.sent.find(message => message.text.startsWith('📦 Заказ')).text;
  for (const part of ['первая оплата', 'Световые буквы', 'Красный акрил', '2,5 м²', '2,4 × 0,75 м', 'Внесено: 1', 'К доплате: 4', '20 октября 2026']) assert.ok(text.includes(part), part);
  const second = record('second', 4000);
  await f.notices.observeIncome([old, first, second]);
  const restarted = new MaxNotifications(f.deps);
  await restarted.observeIncome([old, first, second]);
  await restarted.observeOrders(board(f, [order('12', { paid: 5000, debt: 0, payments: [payment(first), payment(second)] })]));
  assert.equal(f.sent.filter(message => message.text.startsWith('📦 Заказ')).length, 1);
  assert.equal(f.sent.filter(message => message.text.includes('Поступило')).length, 2);
  assert.deepEqual(f.config.allowedChatIds, []);
});

test('full-payment policy waits for Google debt/paid, does not sum bonuses/payments or resend contents', async t => {
  const f = fixture(t); f.config.notifications.paidOrders = 'full'; f.config.notifications.income = false;
  await f.notices.observeIncome([]); await f.notices.observeOrders(board(f));
  const advance = record('advance');
  await f.notices.observeIncome([advance]);
  await f.notices.observeOrders(board(f, [order('12', { payments: [payment(advance)] })]));
  assert.equal(f.sent.length, 0);
  const final = record('final', 4000); await f.notices.observeIncome([advance, final]);
  for (const extra of [{ paid: null, debt: 0 }, { paid: 5000, debt: null }, { paid: 5000, debt: 1 }]) {
    await f.notices.observeOrders(board(f, [order('12', { ...extra, payments: [payment(advance), payment(final)] })]));
    assert.equal(f.sent.length, 0);
  }
  await f.notices.observeOrders(board(f, [order('12', { paid: 5000, debt: 0, payments: [payment(advance), payment(final)] })]));
  assert.equal(f.sent.length, 1); assert.equal(f.notices.status().paidOrders, 'full');
  assert.match(f.sent[0].text, /полная оплата/u); assert.ok(!f.sent[0].text.includes('первая оплата'));
  await f.notices.observeOrders(board(f, [order('12', { paid: 5500, debt: -500, payments: [payment(final)] })]));
  assert.equal(f.sent.length, 1);
});

test('old partial/full payments and amount edits alone are silent; a later new payment can finish a historical partial order', async t => {
  const f = fixture(t); f.config.notifications.paidOrders = 'full'; f.config.notifications.income = false;
  const old = record('old'); await f.notices.observeIncome([old]);
  await f.notices.observeOrders(board(f, [order('12', { payments: [payment(old)] })]));
  await f.notices.observeOrders(board(f, [order('12', { amount: 1000, debt: 0, payments: [payment(old)] })]));
  assert.equal(f.sent.length, 0);
  const final = record('final', 4000); await f.notices.observeIncome([old, final]);
  await f.notices.observeOrders(board(f, [order('12', { paid: 5000, debt: 0, payments: [payment(old), payment(final)] })]));
  assert.equal(f.sent.length, 1);
});

test('stale/partial boards, unknown/cancelled orders, mismatched or duplicate payment keys do not notify; fresh recovery retains candidate', async t => {
  const f = fixture(t); f.config.notifications.paidOrders = 'first'; f.config.notifications.income = false;
  await f.notices.observeIncome([]); await f.notices.observeOrders(board(f));
  const first = record('first'); await f.notices.observeIncome([first]);
  const valid = order('12', { payments: [payment(first)] });
  for (const b of [null, { orders: [valid] }, { ...board(f, [valid]), updatedAt: '2020-01-01' },
    board(f, [valid, valid]), board(f, [order('12', { paid: null, payments: [payment(first)] })]),
    board(f, [order('12', { status: 'Отменён', payments: [payment(first)] })]),
    board(f, [order('12', { payments: [{ ...payment(first), financeAmount: 999 }] })]),
    board(f, [order('12', { payments: [payment(first), payment(first)] })])]) {
    await f.notices.observeOrders(b); assert.equal(f.sent.length, 0);
  }
  f.advance(); await f.notices.observeOrders(board(f, [valid])); assert.equal(f.sent.length, 0, 'finance snapshot is stale');
  await f.notices.observeIncome([first]); await f.notices.observeOrders(board(f, [valid]));
  assert.equal(f.sent.length, 1);
});

test('order read may precede finance refresh at startup; pending records, measurements and replay cannot create paid orders', async t => {
  const f = fixture(t); f.config.notifications.paidOrders = 'first'; f.config.notifications.income = false;
  await f.notices.observeOrders(board(f)); await f.notices.observeIncome([]);
  assert.ok(f.notices.state('orders:-10'));
  await assert.rejects(f.notices.observeIncome([record('pending', 100, { pending: 1 })]));
  const measurement = record('measurement', 100, { category: 'Замеры', orderNumber: null });
  await f.notices.observeIncome([measurement]); await f.notices.observeOrders(board(f)); assert.equal(f.sent.length, 0);
  const first = record('first'); await f.notices.observeIncome([first]);
  await f.notices.observeOrders(board(f, [order('12', { payments: [payment(first)] })])); assert.equal(f.sent.length, 1);
  await f.notices.observeIncome([]); await f.notices.observeIncome([first]);
  await f.notices.observeOrders(board(f, [order('12', { payments: [payment(first)] })])); assert.equal(f.sent.length, 1);
});

test('paid-order receipt survives definite failures, uncertainty and disable/removal without granting group commands', async t => {
  const f = fixture(t); f.config.notifications.paidOrders = 'first'; f.config.notifications.income = false;
  await f.notices.observeIncome([]); await f.notices.observeOrders(board(f));
  const first = record('first'); await f.notices.observeIncome([first]); f.deliveryFails(true);
  await f.notices.observeOrders(board(f, [order('12', { payments: [payment(first)] })]));
  assert.equal(f.notices.status().pending, 1); f.deliveryFails(false); f.advance();
  f.config.notifications.paidOrders = null; await f.notices.drain(); assert.equal(f.sent.length, 0);
  f.config.notifications.paidOrders = 'first'; f.db.prepare("UPDATE max_bot_chats SET state='bot_removed'").run();
  await f.notices.drain(); assert.equal(f.sent.length, 0);
  f.db.prepare("UPDATE max_bot_chats SET state='bot_added'").run();
  const notices = new MaxNotifications({ ...f.deps, send: transport(async () => { throw new Error('fictional lost response'); }) });
  await notices.drain(); assert.equal(notices.status().pending, 1, 'restart has no confirmed snapshots yet');
  await notices.observeIncome([first]);
  await notices.observeOrders(board(f, [order('12', { payments: [payment(first)] })])); assert.equal(notices.status().uncertain, 1);
  await new MaxNotifications(f.deps).drain(); assert.equal(f.sent.length, 0);
});

test('pending order is cancelled after payment deletion/refund and after either cancelled status, including restart', async t => {
  for (const status of ['Отменён', 'Отменен', ' отменен ', 'В работе']) {
    const f = fixture(t); f.config.notifications.paidOrders = 'first'; f.config.notifications.income = false;
    await f.notices.observeIncome([]); await f.notices.observeOrders(board(f));
    const first = record('first'); await f.notices.observeIncome([first]); f.deliveryFails(true);
    await f.notices.observeOrders(board(f, [order('12', { payments: [payment(first)] })]));
    f.advance(); f.deliveryFails(false);
    const notices = new MaxNotifications(f.deps); await notices.drain(); assert.equal(f.sent.length, 0);
    await notices.observeIncome(status === 'В работе' ? [] : [first]);
    await notices.observeOrders(board(f, [order('12', { status, payments: [payment(first)] })]));
    assert.equal(f.sent.length, 0); assert.equal(notices.status().pending, 0);
  }
});

test('full policy observes confirmed partial paid; price edit alone cannot promote it, delayed formulas still recover', async t => {
  const f = fixture(t); f.config.notifications.paidOrders = 'full'; f.config.notifications.income = false;
  await f.notices.observeIncome([]); await f.notices.observeOrders(board(f, [order('12', { paid: 0, debt: 5000 })]));
  const first = record('first'); await f.notices.observeIncome([first]);
  await f.notices.observeOrders(board(f, [order('12', { payments: [payment(first)] })]));
  await f.notices.observeOrders(board(f, [order('12', { amount: 1000, debt: 0, payments: [payment(first)] })]));
  assert.equal(f.sent.length, 0, 'price edit is not full payment');
  const final = record('final', 4000); await f.notices.observeIncome([first, final]);
  await f.notices.observeOrders(board(f, [order('12', { payments: [payment(first), payment(final)] })]));
  await f.notices.observeOrders(board(f, [order('12', { paid: 5000, debt: 0, payments: [payment(first), payment(final)] })]));
  assert.equal(f.sent.length, 1, 'new final payment survives initially old Google paid/debt');
});

test('full policy recovers when both new payment IDs precede recalculated paid, with absent, zero or unknown prior paid', async t => {
  for (const initial of [[], [order('12', { paid: 0, debt: 5000 })], [order('12', { paid: null, debt: null })]]) {
    const f = fixture(t); f.config.notifications.paidOrders = 'full'; f.config.notifications.income = false;
    await f.notices.observeIncome([]); await f.notices.observeOrders(board(f, initial));
    const advance = record('advance'), final = record('final', 4000);
    await f.notices.observeIncome([final, advance]);
    await f.notices.observeOrders(board(f, [order('12', { payments: [payment(advance), payment(final)] })]));
    assert.equal(f.sent.length, 0);
    await f.notices.observeOrders(board(f, [order('12', { paid: 5000, debt: 0, payments: [payment(advance), payment(final)] })]));
    assert.equal(f.sent.length, 1);
  }
});

test('full policy can recover from unknown baseline paid with a new confirmed payment and known full totals', async t => {
  const f = fixture(t); f.config.notifications.paidOrders = 'full'; f.config.notifications.income = false;
  await f.notices.observeIncome([]); await f.notices.observeOrders(board(f, [order('12', { paid: null, debt: null })]));
  const final = record('final', 5000); await f.notices.observeIncome([final]);
  await f.notices.observeOrders(board(f, [order('12', { paid: 5000, debt: 0, payments: [payment(final)] })]));
  assert.equal(f.sent.length, 1);
});

test('editing an existing partial payment amount cannot create a full-payment event; a new receipt can', async t => {
  const f = fixture(t); f.config.notifications.paidOrders = 'full'; f.config.notifications.income = false;
  await f.notices.observeIncome([]); await f.notices.observeOrders(board(f, [order('12', { paid: 0, debt: 5000 })]));
  const first = record('first'); await f.notices.observeIncome([first]);
  await f.notices.observeOrders(board(f, [order('12', { payments: [payment(first)] })]));
  const edited = record('first', 5000); await f.notices.observeIncome([edited]);
  await f.notices.observeOrders(board(f, [order('12', { paid: 5000, debt: 0, payments: [payment(edited)] })]));
  assert.equal(f.sent.length, 0);
  const next = record('next', 100); await f.notices.observeIncome([edited, next]);
  await f.notices.observeOrders(board(f, [order('12', { paid: 5100, debt: -100, payments: [payment(edited), payment(next)] })]));
  assert.equal(f.sent.length, 1);
});

test('manual cents edits hidden by rounded finance amount cannot complete an order notification', async t => {
  const f = fixture(t); f.config.notifications.paidOrders = 'full'; f.config.notifications.income = false;
  await f.notices.observeIncome([]); await f.notices.observeOrders(board(f, [order('12', { paid: 0, debt: 5000 })]));
  const first = record('first', 5000); await f.notices.observeIncome([first]);
  await f.notices.observeOrders(board(f, [order('12', { paid: 4999.5, debt: 0.5, payments: [{ ...payment(first), amount: 4999.5 }] })]));
  await f.notices.observeIncome([first]);
  await f.notices.observeOrders(board(f, [order('12', { paid: 5000, debt: 0, payments: [payment(first)] })]));
  assert.equal(f.sent.length, 0);
  const final = record('final', 100); await f.notices.observeIncome([first, final]);
  await f.notices.observeOrders(board(f, [order('12', { paid: 5100, debt: -100, payments: [payment(first), payment(final)] })]));
  assert.equal(f.sent.length, 1);
});

test('payment keys are globally unique across board orders; a known bad board invalidates its cached predecessor', async t => {
  const f = fixture(t); f.config.notifications.paidOrders = 'first'; f.config.notifications.income = false;
  await f.notices.observeIncome([]); await f.notices.observeOrders(board(f));
  const first = record('first'); await f.notices.observeIncome([first]); f.deliveryFails(true);
  const valid = board(f, [order('12', { payments: [payment(first)] })]);
  await f.notices.observeOrders(valid); assert.equal(f.notices.status().pending, 1);
  await f.notices.observeOrders(board(f, [order('12', { payments: [payment(first)] }), order('13', { payments: [payment(first)] })]));
  assert.equal(f.notices.boardSnapshot, null);
  f.advance(); f.deliveryFails(false); await f.notices.observeIncome([first]); assert.equal(f.sent.length, 0);
  await f.notices.observeOrders(board(f, valid.orders)); assert.equal(f.sent.length, 1);
});

test('a known invalid or failed finance refresh invalidates old confirmation until a new successful read', async t => {
  const f = fixture(t); f.config.notifications.paidOrders = 'first'; f.config.notifications.income = false;
  await f.notices.observeIncome([]); await f.notices.observeOrders(board(f));
  const first = record('first'); await f.notices.observeIncome([first]); f.deliveryFails(true);
  const current = board(f, [order('12', { payments: [payment(first)] })]); await f.notices.observeOrders(current);
  await assert.rejects(f.notices.observeIncome([record('first', 1000, { pending: 1 })]));
  assert.equal(f.notices.financeSnapshot, null);
  f.advance(); f.deliveryFails(false); await f.notices.observeOrders(board(f, current.orders)); assert.equal(f.sent.length, 0);
  await f.notices.observeIncome([first]); assert.equal(f.sent.length, 1);
  f.notices.invalidateFinance(); assert.equal(f.notices.financeSnapshot, null);
});

test('optional paid-order SQL failure cannot reject module checks, exposes a safe error and resumes after recovery', async t => {
  const f = fixture(t); f.config.notifications.paidOrders = 'first'; f.config.notifications.income = false;
  await f.notices.observeIncome([]); await f.notices.observeOrders(board(f));
  const first = record('first'); await f.notices.observeIncome([first]);
  const transaction = f.db.transaction;
  f.db.transaction = () => { throw Object.assign(new Error('fictional-private-sql-payload'), { code: 'SQLITE_FULL' }); };
  await f.notices.observeOrders(board(f, [order('12', { payments: [payment(first)] })]));
  assert.equal(f.notices.boardSnapshot, null); assert.equal(f.notices.status().lastOrderError.code, 'SQLITE_FULL');
  assert.ok(!JSON.stringify(f.notices.status()).includes('fictional-private'));
  f.db.transaction = transaction;
  await f.notices.observeOrders(board(f, [order('12', { payments: [payment(first)] })]));
  assert.equal(f.sent.length, 1); assert.equal(f.notices.status().lastOrderError, null);
});

test('definitely unsent full order keeps other new payment IDs through deleted anchor, stale board and restart', async t => {
  const f = fixture(t); f.config.notifications.paidOrders = 'full'; f.config.notifications.income = false;
  await f.notices.observeIncome([]); await f.notices.observeOrders(board(f));
  const advance = record('advance'), final = record('final', 5000);
  await f.notices.observeIncome([advance, final]); f.deliveryFails(true);
  await f.notices.observeOrders(board(f, [order('12', { paid: 6000, debt: -1000, payments: [payment(advance), payment(final)] })]));
  assert.equal(f.notices.status().pending, 1);
  f.advance(); f.deliveryFails(false);
  const restarted = new MaxNotifications(f.deps); await restarted.observeIncome([final]);
  await restarted.observeOrders(board(f, [order('12', { paid: 6000, debt: -1000, payments: [payment(advance), payment(final)] })]));
  assert.equal(f.sent.length, 0, 'old board still contains deleted money');
  await restarted.observeOrders(board(f, [order('12', { paid: 5000, debt: 0, payments: [payment(final)] })]));
  assert.equal(f.sent.length, 1); assert.equal(restarted.status().pending, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM max_notification_order_candidates').get().n, 0);
});

test('descending multiple-payment snapshot retains all candidates if one is removed or reassigned before board refresh', async t => {
  const f = fixture(t); f.config.notifications.paidOrders = 'first'; f.config.notifications.income = false;
  await f.notices.observeIncome([]); await f.notices.observeOrders(board(f));
  const older = record('older'), latest = record('latest', 5000);
  await f.notices.observeIncome([latest, older]);
  await f.notices.observeIncome([latest]);
  await f.notices.observeOrders(board(f, [order('12', { paid: 5000, debt: 0, payments: [payment(latest)] })]));
  assert.equal(f.sent.length, 1);
});

test('corrected payment linkage moves only an undelivered candidate or pending job, never sent or uncertain order contents', async t => {
  for (const stage of ['candidate', 'pending', 'sent', 'uncertain']) {
    const f = fixture(t); f.config.notifications.paidOrders = 'first'; f.config.notifications.income = false;
    await f.notices.observeIncome([]); await f.notices.observeOrders(board(f));
    const first = record('first'); await f.notices.observeIncome([first]);
    let notices = f.notices;
    if (stage === 'pending') f.deliveryFails(true);
    if (stage === 'uncertain') {
      notices = new MaxNotifications({ ...f.deps, send: transport(async () => { throw new Error('fictional lost acknowledgement'); }) });
      await notices.observeIncome([first]);
    }
    if (stage !== 'candidate') await notices.observeOrders(board(f, [order('12', { payments: [payment(first)] })]));
    const moved = { ...first, orderNumber: '13' };
    f.advance(); f.deliveryFails(false);
    await notices.observeIncome([moved]);
    const current = board(f, [order('13', { payments: [payment(moved)] })]);
    await notices.observeOrders(current); await notices.observeOrders(current);
    if (stage === 'sent') assert.equal(f.sent.length, 1);
    else if (stage === 'uncertain') assert.equal(f.sent.length, 0);
    else { assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /№13/u); }
  }
});

test('pending order waits for fresh snapshots then uses updated source composition, while full payment requires all linked money confirmed', async t => {
  const f = fixture(t); f.config.notifications.paidOrders = 'full'; f.config.notifications.income = false;
  await f.notices.observeIncome([]); await f.notices.observeOrders(board(f));
  const first = record('first'), final = record('final', 4000);
  await f.notices.observeIncome([first]);
  await f.notices.observeOrders(board(f, [order('12', { paid: 5000, debt: 0, payments: [payment(first), payment(final)] })]));
  assert.equal(f.sent.length, 0, 'board-only final payment is not confirmed finance');
  f.deliveryFails(true); await f.notices.observeIncome([first, final]);
  await f.notices.observeOrders(board(f, [order('12', { paid: 5000, debt: 0, payments: [payment(first), payment(final)] })]));
  assert.equal(f.notices.status().pending, 1);
  f.advance(); f.deliveryFails(false); await f.notices.drain(); assert.equal(f.sent.length, 0);
  await f.notices.observeIncome([first, final]);
  await f.notices.observeOrders(board(f, [order('12', { paid: 5000, debt: 0, items: [{ name: 'Исправленная позиция', quantity: 3 }], payments: [payment(first), payment(final)] })]));
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /Исправленная позиция/u);
});

test('formatted finance rubles confirm a fractional source payment without changing raw order amounts', async t => {
  const f = fixture(t); f.config.notifications.paidOrders = 'first'; f.config.notifications.income = false;
  await f.notices.observeIncome([]); await f.notices.observeOrders(board(f));
  const first = record('first', 1001); await f.notices.observeIncome([first]);
  await f.notices.observeOrders(board(f, [order('12', { paid: 1000.5, debt: 3999.5, payments: [{ ...payment(first), amount: 1000.5 }] })]));
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /1\s000,5 ₽/u);
});

test('composition shows unknowns explicitly, uses position description and bounds MAX message length with visible omissions', () => {
  const text = paidOrderNotice(order('12', { amount: null, debt: null, comment: 'Old wrong composition',
    items: Array.from({ length: 80 }, () => ({ name: 'Учебное изделие', quantity: null, width: null, height: 2, description: 'x'.repeat(1600) })) }));
  assert.ok(text.length <= 4000); assert.match(text, /Стоимость заказа: не указана/u); assert.match(text, /Размер: \? × 2 м/u);
  assert.match(text, /Ещё позиций:/u); assert.match(text, /Продолжение в карточке/u); assert.ok(!text.includes('Old wrong composition'));
  assert.match(paidOrderNotice(order('12', { items: [] })), /Позиции ещё не указаны/u);
});

test('order blocks preserve position order, multiline descriptions, explicit unknowns and authoritative zero or overpayment', () => {
  const text = paidOrderNotice(order('104', { amount: null, paid: 0, debt: 0, client: '', dueDate: '',
    items: [{ name: 'Короб', width: 2, height: 0.5, quantity: 1, unit: 'шт.', description: 'Молочный акрил\r\nБез плёнки' },
      { name: 'Монтаж', quantity: null, unit: '' }] }));
  assert.match(text, /Клиент: не указан\n📅 Срок: не указан\n\nОПЛАТА\n/u);
  assert.match(text, /Стоимость заказа: не указана\nВнесено: 0 ₽\nК доплате: 0 ₽\n\nСОСТАВ ЗАКАЗА\n\n1\. Короб/u);
  assert.match(text, /   Размер: 2 × 0,5 м\n   Количество: 1 шт\.\n   Молочный акрил\n   Без плёнки\n\n2\. Монтаж\n   Количество: \?\n\nЗаказы: https:\/\/vm-app\.ru\/kanban\//u);
  const overpaid = paidOrderNotice(order('104', { debt: -500, paid: 5500 }), 'full');
  assert.match(overpaid, /Внесено: 5\s500 ₽\nПереплата: 500 ₽/u);
  assert.ok(!overpaid.includes('К доплате: -'));
});

test('income keeps measurement purpose, optional order, missing fields and civil dates without timezone shifts or guessed dates', () => {
  const income = incomeNotice(record('fictional', 20000, { category: 'Оплата заказа', orderNumber: '104', account: 'Расчётный счёт' }));
  assert.match(income, /^💰 Поступило 20\s000 ₽\n\nЗаказ №104 · Оплата заказа\nКасса \/ счёт: Расчётный счёт\nДата: 15 октября 2026\n\nМастерская:/u);
  const measurement = incomeNotice(record('measure', 700, { category: 'Замеры', orderNumber: null, date: '', account: '' }));
  assert.match(measurement, /\n\nЗамеры\nКасса \/ счёт: не указан\nДата: не указана/u);
  assert.ok(!measurement.includes('Заказ №'));
  for (const [date, expected] of [['2026-12-31', '31 декабря 2026'], ['01.01.2027', '1 января 2027'],
    ['2026-02-29', '2026-02-29'], ['2028-02-29', '29 февраля 2028'], ['не согласована', 'не согласована']]) {
    assert.ok(incomeNotice(record('date', 1000, { date })).includes(`Дата: ${expected}`));
  }
});

test('indented multiline or emoji descriptions stay inside MAX limit with a complete footer and accurate omitted count', () => {
  for (const description of ['x\n'.repeat(800), '🟢'.repeat(800)]) {
    const text = paidOrderNotice(order('104', { items: Array.from({ length: 80 }, (_, index) => ({
      name: `Изделие ${index + 1}`, quantity: 1, description })) }));
    const shown = [...text.matchAll(/^\d+\. Изделие /gmu)].length;
    assert.ok(text.length <= 4000); assert.ok(shown > 0);
    assert.ok(text.includes(`Ещё позиций: ${80 - shown}.`));
    assert.ok(text.endsWith('\n\nЗаказы: https://vm-app.ru/kanban/'));
  }
});

test('income baseline is silent; new confirmed incomes include measurements, expenses/edits/replays do not notify', async t => {
  const f = fixture(t);
  await f.notices.observeIncome([record('old')]); assert.equal(f.sent.length, 0);
  const records = [record('old', 2000), record('new'), record('measure', 700, { category: 'Замеры', orderNumber: null }),
    record('expense', 300, { type: 'expense' }), record('zero', 0)];
  await Promise.all([f.notices.observeIncome(records), f.notices.observeIncome(records)]);
  assert.equal(f.sent.length, 2); assert.match(f.sent[0].text, /Поступило/u);
  assert.ok(f.sent.some(x => x.text.includes('Замеры'))); assert.ok(f.sent.every(x => x.kind === 'chat' && x.id === '-10'));
  const restarted = new MaxNotifications(f.deps);
  await restarted.observeIncome(records); await restarted.observeIncome([]); await restarted.observeIncome(records);
  assert.equal(f.sent.length, 2); assert.deepEqual(f.config.allowedChatIds, []);
  assert.equal(f.db.prepare("SELECT count(*) n FROM max_notification_outbox WHERE text!=''").get().n, 0);
});

test('empty initial snapshot still detects first income; failed delivery survives restart and retries once confirmed', async t => {
  const f = fixture(t); await f.notices.observeIncome([]);
  f.deliveryFails(true); await f.notices.observeIncome([record('new')]);
  assert.equal(f.notices.status().pending, 1); assert.equal(f.sent.length, 0);
  f.deliveryFails(false); f.advance(); const restarted = new MaxNotifications(f.deps);
  await restarted.observeIncome([record('new')]); await restarted.observeIncome([record('new')]);
  assert.equal(f.sent.length, 1); assert.equal(restarted.status().pending, 0);
});

test('invalid/partial/unconfirmed financial snapshots do not initialize or mark observations', async t => {
  const f = fixture(t);
  for (const records of [null, [record('same'), record('same')], [record('pending', 100, { pending: 1 })],
    [record('', 100)], [record('unknown', null)], [record('bad', NaN)]]) await assert.rejects(f.notices.observeIncome(records));
  assert.equal(f.db.prepare('SELECT count(*) n FROM max_notification_income').get().n, 0);
  await f.notices.observeIncome([record('old')]); assert.equal(f.sent.length, 0);
});

test('Avito compares real rubles strictly below threshold, keeps bonus separate and rearms after observed top-up', async t => {
  const f = fixture(t); f.setBalance({ real: 500, bonus: 5000 }); await f.notices.checkBalance(); assert.equal(f.sent.length, 0);
  f.setBalance({ real: 499.99 }); f.advance();
  await Promise.all([f.notices.checkBalance(), f.notices.checkBalance()]); assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /^⚠️ Авито · пора пополнить кошелёк\n\nДеньги: 499,99 ₽\nБонусы: 5\s000 ₽\n\nБаланс денег ниже порога 500 ₽\./u);
  const restarted = new MaxNotifications(f.deps); f.setBalance({ real: 0 }); f.advance(); await restarted.checkBalance();
  assert.equal(f.sent.length, 1);
  f.setBalance({ real: 501 }); f.advance(); await restarted.checkBalance();
  f.setBalance({ real: 0 }); f.advance(); await restarted.checkBalance(); assert.equal(f.sent.length, 2);
});

test('balance failure or malformed/missing values cannot produce zero or reuse stale low warning', async t => {
  const f = fixture(t); f.setBalance({ real: 100 }); f.deliveryFails(true); await f.notices.checkBalance();
  assert.equal(f.notices.status().pending, 1); f.advance(); f.deliveryFails(false); f.balanceFails(true);
  await f.notices.checkBalance(); await f.notices.observeIncome([]); assert.equal(f.sent.length, 0);
  f.balanceFails(false);
  for (const real of [null, undefined, NaN, -1, '0']) { f.setBalance({ real }); f.advance(); await f.notices.checkBalance(); }
  assert.equal(f.sent.length, 0); f.setBalance({ real: 20 }); f.advance(); await f.notices.checkBalance();
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /Деньги: 20 ₽/u);
});

test('accepted message with lost response is uncertain and never resent automatically, including restart', async t => {
  const f = fixture(t); const accepted = [];
  const deps = { ...f.deps, send: transport(async (_, id, text) => { accepted.push({ id, text }); throw new Error('fictional lost acknowledgement'); }) };
  const notices = new MaxNotifications(deps); await notices.observeIncome([]); await notices.observeIncome([record('new')]);
  assert.equal(accepted.length, 1); assert.equal(notices.status().uncertain, 1);
  f.advance(); await new MaxNotifications(deps).observeIncome([record('new')]); assert.equal(accepted.length, 1);
});

test('a process interrupted during submission leaves an uncertain durable receipt on startup', async t => {
  const f = fixture(t); await f.notices.observeIncome([]); f.deliveryFails(true);
  await f.notices.observeIncome([record('new')]);
  f.db.prepare("UPDATE max_notification_outbox SET state='submitting'").run();
  f.deliveryFails(false); f.advance(); const restarted = new MaxNotifications(f.deps);
  await restarted.observeIncome([record('new')]); assert.equal(f.sent.length, 0); assert.equal(restarted.status().uncertain, 1);
});

test('shutdown finishes the in-flight acknowledgement and does not begin the rest of its batch', async t => {
  const f = fixture(t); let release, signal;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { signal = resolve; });
  const notices = new MaxNotifications({ ...f.deps, send: transport(async (_, id, text) => {
    signal(); await gate; f.sent.push({ id, text }); return { message: { body: { mid: 'fictional-shutdown' } } };
  }) });
  await notices.observeIncome([]);
  const observation = notices.observeIncome([record('a'), record('b')]); await started;
  const closed = notices.close(); release(); await Promise.all([observation, closed]);
  assert.equal(f.sent.length, 1); assert.equal(notices.status().pending, 1);
});

test('notification permission revoked while waiting behind retouch is checked inside the shared send slot', async t => {
  const f = fixture(t); let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const running = new Promise(resolve => { started = resolve; });
  const posts = [];
  const send = transport(async (_, id, text) => {
    if (text === 'fictional retouch') { started(); await gate; }
    posts.push(text); return { message: { body: { mid: `slot-${posts.length}` } } };
  });
  const notices = new MaxNotifications({ ...f.deps, send }); await notices.observeIncome([]);
  const prior = send({}, '-10', 'fictional retouch', 'chat'); await running;
  const incoming = notices.observeIncome([record('new')]); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.db.prepare('SELECT state FROM max_notification_outbox').get().state, 'pending');
  f.config.notifications.enabled = false; release(); await Promise.all([prior, incoming]);
  assert.deepEqual(posts, ['fictional retouch']);
  assert.equal(f.db.prepare('SELECT state FROM max_notification_outbox').get().state, 'pending');
});

test('a low-balance observation that expires while waiting behind retouch cannot be sent stale', async t => {
  const f = fixture(t); f.setBalance({ real: 100 }); let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const running = new Promise(resolve => { started = resolve; }); const posts = [];
  const send = transport(async (_, id, text) => {
    if (text === 'fictional retouch') { started(); await gate; }
    posts.push(text); return { message: { body: { mid: `slot-${posts.length}` } } };
  });
  const notices = new MaxNotifications({ ...f.deps, send });
  const prior = send({}, '-10', 'fictional retouch', 'chat'); await running;
  const balance = notices.checkBalance(); await new Promise(resolve => setImmediate(resolve));
  f.advance(); release(); await Promise.all([prior, balance]);
  assert.deepEqual(posts, ['fictional retouch']);
  assert.equal(f.db.prepare('SELECT state FROM max_notification_outbox').get().state, 'pending');
});

test('a balance job cancelled while another send awaits is not sent under its old policy', async t => {
  const f = fixture(t); await f.notices.observeIncome([]);
  f.deliveryFails(true); f.setBalance({ real: 100 }); await f.notices.checkBalance();
  f.advance(); let release, signal;
  const started = new Promise(resolve => { signal = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.db.prepare("UPDATE max_notification_outbox SET created_at='9999'").run();
  const deps = { ...f.deps, send: transport(async (_, id, text) => {
    if (text.includes('Поступило')) { signal(); await gate; }
    f.sent.push({ id, text }); return { message: { body: { mid: 'fictional-delayed' } } };
  }) };
  const notices = new MaxNotifications(deps);
  const observation = notices.observeIncome([record('new')]); await started;
  f.config.notifications.avitoThreshold = 400;
  const balance = notices.checkBalance();
  // check() updates the queue before joining the existing delivery flight.
  await new Promise(resolve => setImmediate(resolve)); release();
  await Promise.all([observation, balance]);
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /Поступило/u);
  await notices.checkBalance(); assert.equal(f.sent.length, 2); assert.match(f.sent[1].text, /400 ₽/u);
});

test('top-up cancels an undelivered low warning; a later low episode gets a fresh receipt', async t => {
  const f = fixture(t); f.deliveryFails(true); f.setBalance({ real: 100 }); await f.notices.checkBalance();
  f.deliveryFails(false); f.setBalance({ real: 1000 }); f.advance(); await f.notices.checkBalance();
  assert.equal(f.sent.length, 0); assert.equal(f.notices.status().pending, 0);
  f.setBalance({ real: 10 }); f.advance(); await f.notices.checkBalance(); assert.equal(f.sent.length, 1);
});

test('disabled, unknown and removed recipients get no reads or delivery, and order-command access stays unchanged', async t => {
  const f = fixture(t);
  for (const chatIds of [[], ['-20'], ['invalid']]) {
    f.config.notifications.chatIds = chatIds; await f.notices.observeIncome([record('old')]); await f.notices.checkBalance();
  }
  f.config.notifications.chatIds = ['-10']; f.config.notifications.enabled = false;
  await f.notices.checkBalance(); assert.equal(f.reads(), 0);
  f.config.notifications.enabled = true; await f.notices.observeIncome([]); f.deliveryFails(true);
  await f.notices.observeIncome([record('new')]); f.deliveryFails(false); f.advance();
  f.db.prepare("UPDATE max_bot_chats SET state='bot_removed'").run();
  await f.notices.observeIncome([record('new')]); await f.notices.checkBalance(); assert.equal(f.sent.length, 0);
  assert.deepEqual(f.config.allowedChatIds, []);
});

test('unreadable or malformed optional config cannot reject periodic finance/balance checks; restoring it resumes notifications', async t => {
  const f = fixture(t); let unavailable = true;
  const notices = new MaxNotifications({ ...f.deps, settings: () => {
    if (unavailable) throw new Error('fictional-secret-file-error');
    return f.config;
  } });
  await Promise.all([notices.observeIncome([record('old')]), notices.checkBalance()]);
  const status = notices.status(); assert.equal(status.enabled, false);
  assert.equal(status.configurationError.code, 'MAX_CONFIG_UNAVAILABLE');
  assert.ok(!JSON.stringify(status).includes('fictional-secret')); assert.equal(f.reads(), 0); assert.equal(f.sent.length, 0);
  unavailable = false; await notices.observeIncome([record('old')]);
  await notices.observeIncome([record('old'), record('new')]);
  assert.equal(f.sent.length, 1); assert.equal(notices.status().configurationError, null);
});

test('changing threshold/account cancels old policy messages; revoked config during balance request prevents send', async t => {
  const f = fixture(t); f.setBalance({ real: 100 }); f.deliveryFails(true); await f.notices.checkBalance();
  f.deliveryFails(false); f.config.notifications.avitoThreshold = 50; f.advance(); await f.notices.checkBalance();
  assert.equal(f.sent.length, 0); assert.equal(f.notices.status().pending, 0);
  f.setBalance({ accountId: '5678', real: 0 }); f.advance(); await f.notices.checkBalance(); assert.equal(f.sent.length, 1);
  const revoked = new MaxNotifications({ ...f.deps, balance: async () => {
    f.config.notifications.enabled = false;
    return { accountId: '1111', real: 0, bonus: 0, currency: 'RUB', loadedAt: new Date().toISOString() };
  } });
  await revoked.checkBalance(); assert.equal(f.sent.length, 1);
});
