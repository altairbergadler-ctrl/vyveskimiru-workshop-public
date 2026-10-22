// Isolated reproductions for the architecture audit of 2026-09-06.
// Uses only an in-memory database and a fake Sheets client. No network or live data.
// Regression checks for the two defects documented on the audited revision.
import assert from 'node:assert/strict';
import { openDatabase, createTransaction, updateTransaction, getTransaction } from '../../server/db.mjs';
import { SheetSynchronizer } from '../../server/sync.mjs';

const paymentHeaders = ['Дата', '№ заказа', 'Клиент', 'Вид платежа', 'Сумма платежа',
  'Касса / счёт', 'Деньги в кассе', 'sync_id', 'sync_updated_at', 'sync_deleted', 'sync_origin'];
const expenseHeaders = ['Дата', 'Категория', 'Описание', 'Сумма', 'Касса / счёт',
  'sync_id', 'sync_updated_at', 'sync_deleted', 'sync_origin'];
const input = { type: 'expense', date: '2026-09-06', category: 'Synthetic',
  description: 'Architecture audit synthetic record', amount: 100, account: 'Synthetic',
  cashInRegister: false, orderNumber: null, counterparty: null, comment: null };

function fakeClient(afterWrite = () => {}) {
  return {
    configured: true,
    expenseRow: null,
    async getValues(name) {
      return { values: name === 'Платежи' ? [paymentHeaders]
        : [expenseHeaders, ...(this.expenseRow ? [this.expenseRow] : [])] };
    },
    async batchUpdate() {},
    async updateValues(data) {
      this.expenseRow = [];
      for (const cell of data) {
        const letter = cell.range.match(/!([A-Z]+)/)[1];
        assert.equal(letter.length, 1);
        this.expenseRow[letter.charCodeAt(0) - 65] = cell.values[0][0];
      }
      afterWrite();
    },
  };
}

{
  const db = openDatabase(':memory:');
  try {
    const tx = createTransaction(db, input);
    let edited = false;
    const client = fakeClient(() => {
      if (!edited) { edited = true; updateTransaction(db, tx.id, { ...input, amount: 200 }); }
    });
    const sync = new SheetSynchronizer({ db, client });
    const result = await sync.run();
    const row = getTransaction(db, tx.id);
    assert.equal(result.success, true);
    assert.equal(client.expenseRow[3], 100);
    assert.equal(row.amount, 200);
    assert.equal(row.pending, 1);
    await sync.run();
    assert.equal(client.expenseRow[3], 200);
    assert.equal(getTransaction(db, tx.id).pending, 0);
    console.log(JSON.stringify({ finding: 'A01', fixed: true,
      simulatedSheetAmount: client.expenseRow[3], localAmount: row.amount, pending: row.pending }));
  } finally { db.close(); }
}

{
  const db = openDatabase(':memory:');
  try {
    const tx = createTransaction(db, input);
    const client = fakeClient();
    const sync = new SheetSynchronizer({ db, client });
    await sync.run(); // Push the new expense.
    await sync.run(); // Read it back without changing its content.
    assert.equal(getTransaction(db, tx.id).sheetName, 'Расходы');
    client.expenseRow = null; // Simulate manual deletion in Sheets.
    await sync.run();
    await sync.run(); // Two successful reads without the row.
    const row = getTransaction(db, tx.id);
    assert.ok(row.deletedAt);
    assert.equal(row.pending, 0);
    assert.equal(row.missingCount, 2);
    console.log(JSON.stringify({ finding: 'A02', fixed: true,
      sheetName: row.sheetName, deletedAt: row.deletedAt, pending: row.pending }));
  } finally { db.close(); }
}
