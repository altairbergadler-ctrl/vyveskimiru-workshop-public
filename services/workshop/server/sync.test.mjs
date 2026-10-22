import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { makePinHash, verifyPin } from './auth.mjs';
import { createTransaction, deleteTransaction, getTransaction, openDatabase, syncStatus, upsertFromSheet } from './db.mjs';
import { SheetSynchronizer, syncInternals } from './sync.mjs';

const paymentHeaders = ['Дата', '№ заказа', 'Название заказа', 'Клиент', 'Сумма заказа',
  'Оплачено до этого', 'Сумма платежа', 'Касса / счёт', 'Вид платежа',
  'Остаток после платежа', 'Комментарий', 'Деньги в кассе',
  'sync_id', 'sync_updated_at', 'sync_deleted', 'sync_origin'];
const expenseHeaders = ['Дата', 'Категория', 'Описание', 'Сумма', 'Касса / счёт',
  '№ заказа (если есть)', 'Название заказа', 'Поставщик', 'Комментарий',
  'sync_id', 'sync_updated_at', 'sync_deleted', 'sync_origin'];

test('parses Russian dates and currency', () => {
  assert.equal(syncInternals.isoDate('31.08.2026'), '2026-08-31');
  assert.equal(syncInternals.amount('16 500 ₽'), 16500);
  assert.equal(syncInternals.amount('3 376 ₽'), 3376);
});

test('maps a payment row', () => {
  const config = { name: 'Платежи', type: 'income' };
  const layout = syncInternals.layoutFromHeaders(config, paymentHeaders);
  const row = ['29.08.2026', '3', 'Вывеска Софьи', 'Софья', '96 400 ₽', '20 000 ₽',
    '76 400 ₽', 'В кассе', 'Доплата', '', '', true, 'payment-id'];
  const record = syncInternals.fromSheet(config, row, 9, layout);
  assert.equal(record.id, 'payment-id');
  assert.equal(record.amount, 76400);
  assert.equal(record.description, 'Доплата · Софья');
  assert.equal(record.cashInRegister, true);
});

test('maps Google checkbox values and includes the flag in the sync hash', () => {
  assert.equal(syncInternals.checked(true), true);
  assert.equal(syncInternals.checked('ИСТИНА'), true);
  assert.equal(syncInternals.checked(false), false);
  assert.equal(syncInternals.checked('неизвестно'), null);
  const base = { type: 'income', date: '2026-09-05', category: 'Доплата', description: 'Доплата',
    amount: 1000, account: 'В кассе', orderNumber: '5', counterparty: 'Клиент', comment: null };
  assert.notEqual(
    syncInternals.hashRecord({ ...base, cashInRegister: true }),
    syncInternals.hashRecord({ ...base, cashInRegister: false }),
  );
});

test('requires the cash-status column before syncing payments', () => {
  const headers = paymentHeaders.filter((header) => header !== 'Деньги в кассе');
  assert.throws(
    () => syncInternals.layoutFromHeaders({ name: 'Платежи', type: 'income' }, headers),
    /cashInRegisterIndex/,
  );
});

test('ignores the cash flag when hashing expenses', () => {
  const expense = { type: 'expense', date: '2026-09-05', category: 'Прочее', description: 'Расход',
    amount: 1000, account: 'В кассе', orderNumber: null, counterparty: null, comment: null };
  assert.equal(
    syncInternals.hashRecord({ ...expense, cashInRegister: false }),
    syncInternals.hashRecord(expense),
  );
});

test('writes the independent cash flag to the payments sheet', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-pwa-cash-sync-'));
  const db = openDatabase(path.join(directory, 'test.sqlite3'));
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  createTransaction(db, {
    type: 'income', date: '2026-09-05', category: 'Предоплата', description: 'Предоплата · Клиент',
    amount: 1000, account: 'В кассе', cashInRegister: false, orderNumber: '5',
    counterparty: 'Клиент', comment: null,
  });
  const updates = [];
  const client = {
    configured: true,
    async getValues(sheetName) {
      return { values: [sheetName === 'Платежи' ? paymentHeaders : expenseHeaders] };
    },
    async updateValues(data) { updates.push(...data); },
    async batchUpdate() {},
  };
  const result = await new SheetSynchronizer({ db, client }).run();
  assert.equal(result.success, true);
  const cashUpdate = updates.find((item) => item.range === "'Платежи'!L2");
  assert.deepEqual(cashUpdate?.values, [[false]]);
});

test('maps an expense when the order name column is inserted', () => {
  const config = { name: 'Расходы', type: 'expense' };
  const layout = syncInternals.layoutFromHeaders(config, expenseHeaders);
  const row = ['31.08.2026', 'Прочее', 'Тест', '100 ₽', 'В кассе', '8',
    'Вывеска', 'Олег', '', 'expense-id'];
  const record = syncInternals.fromSheet(config, row, 15, layout);
  assert.equal(record.id, 'expense-id');
  assert.equal(record.orderNumber, '8');
  assert.equal(record.counterparty, 'Олег');
});

test('reports missing required transaction fields from sheet rows', () => {
  const paymentLayout = syncInternals.layoutFromHeaders({ name: 'Платежи', type: 'income' }, paymentHeaders);
  const payment = syncInternals.fromSheet({ name: 'Платежи', type: 'income' },
    ['01.09.2026', '', '', '', '', '', 25000, 'В кассе', '', '', '', false, 'payment-id'], 11, paymentLayout);
  assert.deepEqual(syncInternals.validationProblems(payment), ['category', 'counterparty']);

  const expenseLayout = syncInternals.layoutFromHeaders({ name: 'Расходы', type: 'expense' }, expenseHeaders);
  const expense = syncInternals.fromSheet({ name: 'Расходы', type: 'expense' },
    ['27.08.2026', 'Материалы', '', 1400, 'В кассе', '', '', 'Рынок', '', 'expense-id'], 3, expenseLayout);
  assert.deepEqual(syncInternals.validationProblems(expense), ['description']);
});

test('pending app deletion wins over the stale sheet row read in the same sync', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-pwa-sync-'));
  const db = openDatabase(path.join(directory, 'test.sqlite3'));
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  const item = {
    id: 'expense-delete-id', type: 'expense', date: '2026-08-31', category: 'Прочее',
    description: 'Удалить меня', amount: 100, account: 'В кассе', orderNumber: null,
    counterparty: 'Олег', comment: null, source: 'sheet', sheetName: 'Расходы', sheetRow: 2,
  };
  upsertFromSheet(db, item, syncInternals.hashRecord(item), 2, new Date().toISOString());
  assert.equal(deleteTransaction(db, item.id), true);

  const deletedRanges = [];
  const client = {
    configured: true,
    async getValues(sheetName) {
      if (sheetName === 'Платежи') return { values: [paymentHeaders] };
      return { values: [expenseHeaders, ['31.08.2026', 'Прочее', 'Удалить меня', 100,
        'В кассе', '', '', 'Олег', '', item.id, '', '', 'sheet']] };
    },
    async updateValues() {},
    async batchUpdate(requests) { deletedRanges.push(...requests); },
  };
  const synchronizer = new SheetSynchronizer({ db, client });
  const result = await synchronizer.run();
  const stored = getTransaction(db, item.id);
  assert.equal(result.success, true);
  assert.ok(stored.deletedAt);
  assert.equal(stored.pending, 0);
  assert.equal(deletedRanges[0].deleteDimension.range.sheetId, 1534385402);
  assert.equal(deletedRanges[0].deleteDimension.range.startIndex, 1);
});

test('an incomplete sheet row is reported without deleting the matching local record', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-pwa-invalid-row-'));
  const db = openDatabase(path.join(directory, 'test.sqlite3'));
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  const item = {
    id: 'income-incomplete-id', type: 'income', date: '2026-09-01', category: 'Доплата',
    description: 'Доплата · Азамат', amount: 25000, account: 'В кассе', orderNumber: '5',
    counterparty: 'Азамат', comment: null, source: 'sheet', sheetName: 'Платежи', sheetRow: 2,
  };
  upsertFromSheet(db, item, syncInternals.hashRecord(item), 2, new Date().toISOString());

  const client = {
    configured: true,
    async getValues(sheetName) {
      if (sheetName === 'Платежи') return { values: [paymentHeaders,
        ['01.09.2026', '', '', '', '', '', 25000, 'В кассе', '', '',
          'Остаток за Парфюмера', true, item.id, '', '', 'vps']] };
      return { values: [expenseHeaders] };
    },
    async updateValues() {},
    async batchUpdate() {},
  };
  const synchronizer = new SheetSynchronizer({ db, client });
  const first = await synchronizer.run();
  const second = await synchronizer.run();

  assert.equal(first.invalidRows, 1);
  assert.equal(second.invalidRows, 1);
  assert.equal(syncStatus(db, true).invalidRows, 1);
  assert.equal(getTransaction(db, item.id).deletedAt, null);
  assert.equal(getTransaction(db, item.id).category, 'Доплата');
});

test('PIN hashes are salted and verifiable', async () => {
  const encoded = await makePinHash('1234');
  assert.equal(await verifyPin('1234', encoded), true);
  assert.equal(await verifyPin('9999', encoded), false);
});
