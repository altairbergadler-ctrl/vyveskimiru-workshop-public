import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase, createTransaction } from './db.mjs';
import { FinanceSheetStore } from './finance-sheet.mjs';
import { CommandQueue } from './command-queue.mjs';
import { Diagnostics, routeLabel } from './diagnostics.mjs';

const paymentHeaders = ['Дата', '№ заказа', 'Название заказа', 'Клиент', 'Сумма заказа', 'Оплачено до этого', 'Сумма платежа', 'Касса / счёт', 'Вид платежа', 'Остаток после платежа', 'Комментарий', 'Деньги в кассе', 'sync_id', 'sync_updated_at', 'sync_deleted', 'sync_origin'];
const expenseHeaders = ['Дата', 'Категория', 'Описание', 'Сумма', 'Касса / счёт', '№ заказа (если есть)', 'Название заказа', 'Поставщик', 'Комментарий', 'sync_id', 'sync_updated_at', 'sync_deleted', 'sync_origin'];
const input = { type: 'expense', date: '2026-09-06', category: 'Прочее', description: 'Тест', amount: 100,
  account: 'В кассе', cashInRegister: false, orderNumber: null, counterparty: null, comment: null };

test('a contract/preflight rejection leaves a rejected receipt, no pending write, and can be retried after repair', async t => {
  const { store, client, db } = setup(t), write = client.batchUpdate.bind(client);
  client.batchUpdate = async () => { throw Object.assign(new Error('Preflight denied'), { code: 'SHEETS_CONTRACT_HEADER', notSubmitted: true }); };
  const payload = { ...input, requestId: crypto.randomUUID() };
  await assert.rejects(() => store.execute('create', payload), { code: 'SHEETS_CONTRACT_HEADER' });
  assert.equal(store.pending().length, 0); assert.equal(client.writes, 0);
  assert.equal(db.prepare('SELECT state FROM finance_commands WHERE request_id=?').get(payload.requestId).state, 'rejected');
  client.batchUpdate = write;
  assert.equal((await store.execute('create', payload)).transaction.amount, 100);
  assert.equal(client.writes, 1);
});
const cell = value => ({ userEnteredValue: typeof value === 'number' ? { numberValue: value } : typeof value === 'boolean' ? { boolValue: value } : { stringValue: String(value) } });

function setup(t) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const source = [{ properties: { title: 'Платежи', sheetId: 15, gridProperties: { rowCount: 999 } }, rows: [paymentHeaders.map(cell)] },
    { properties: { title: 'Расходы', sheetId: 16, gridProperties: { rowCount: 997 } }, rows: [expenseHeaders.map(cell)] }];
  const client = { configured: true, writes: 0, loseResponse: false, rejectWrite: false, failRead: false,
    async request() {
      if (this.failRead) throw Object.assign(new Error('Unavailable'), { code: 'SHEETS_UNAVAILABLE' });
      return { sheets: source.map(s => ({ properties: s.properties, data: [{ rowData: s.rows.map((row, i) => ({ values: row.map((c, j) => {
        const v = c.userEnteredValue;
        const formattedValue = j === 0 && i > 0 && v?.numberValue != null
          ? new Date(Date.UTC(1899, 11, 30) + v.numberValue * 86400000).toISOString().slice(0, 10)
          : String(v?.stringValue ?? v?.numberValue ?? v?.boolValue ?? c.formulaResult ?? '');
        return { ...c, formattedValue };
      }) })) }] })) };
    },
    async batchUpdate(requests) {
      this.writes++;
      if (this.rejectWrite) throw new Error('Connection lost before commit');
      for (const request of requests) {
        const r = Object.values(request)[0];
        const sheetId = r.start?.sheetId ?? r.range?.sheetId ?? r.destination?.sheetId;
        const table = source.find(s => s.properties.sheetId === sheetId);
        if (request.copyPaste) table.rows[r.destination.startRowIndex] = structuredClone(table.rows[r.source.startRowIndex] ?? []);
        if (request.deleteDimension) table.rows.splice(r.range.startIndex, r.range.endIndex - r.range.startIndex);
        if (request.updateCells) {
          table.rows[r.start.rowIndex] ??= [];
          table.rows[r.start.rowIndex][r.start.columnIndex] = structuredClone(r.rows[0].values[0]);
        }
      }
      if (this.loseResponse) throw new Error('Connection lost after commit');
    },
  };
  return { db, source, client, store: new FinanceSheetStore({ db, client }) };
}

test('duplicate warning writes nothing; explicit acknowledgement and lost-response retry write exactly once', async t => {
  const { store, client, db } = setup(t);
  await store.execute('create', { ...input, requestId: crypto.randomUUID() });
  const payload = { ...input, requestId: crypto.randomUUID() };
  let warning;
  await assert.rejects(() => store.execute('create', payload), error => {
    assert.equal(error.code, 'FINANCE_POSSIBLE_DUPLICATE'); warning = error.duplicateWarning; return true;
  });
  assert.equal(client.writes, 1); assert.equal(store.pending().length, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM finance_commands').get().n, 1);
  assert.equal(warning.matches[0].amount, input.amount);
  await assert.rejects(() => store.execute('create', { ...payload, duplicateConfirmation: true }), { code: 'FINANCE_POSSIBLE_DUPLICATE' });
  client.loseResponse = true;
  await assert.rejects(() => store.execute('create', { ...payload, duplicateConfirmation: warning.confirmation }), { code: 'FINANCE_UNCONFIRMED' });
  const restarted = new FinanceSheetStore({ db, client });
  await restarted.verifyPending();
  assert.equal((await restarted.execute('create', payload)).transaction.id, payload.requestId);
  assert.equal(client.writes, 2); assert.equal((await restarted.read()).length, 2);
  assert.equal(restarted.pending().length, 0);
});

test('another device changing candidates invalidates acknowledgement; historical edits and deletions remain available', async t => {
  const { store, client } = setup(t);
  const original = (await store.execute('create', { ...input, requestId: crypto.randomUUID() })).transaction;
  const payload = { ...input, requestId: crypto.randomUUID() };
  let token;
  await assert.rejects(() => store.execute('create', payload), error => { token = error.duplicateWarning.confirmation; return true; });
  const edited = (await store.execute('update', { ...original, comment: 'Изменено на другом устройстве', requestId: crypto.randomUUID() })).transaction;
  const writes = client.writes;
  await assert.rejects(() => store.execute('create', { ...payload, duplicateConfirmation: token }), { code: 'FINANCE_POSSIBLE_DUPLICATE' });
  await assert.rejects(() => store.execute('create', { ...payload, description: 'Другая покупка', duplicateConfirmation: token }), { code: 'FINANCE_POSSIBLE_DUPLICATE' });
  assert.equal(client.writes, writes);
  await store.execute('delete', { id: edited.id, requestId: crypto.randomUUID() });
  assert.equal((await store.execute('create', payload)).transaction.id, payload.requestId);
});

test('paid and overpaid orders reject new payments and reassignment, while replay and historical editing survive settlement', async t => {
  const { store, client, source } = setup(t);
  let debt = 1000;
  client.getValues = async () => ({ values: [['№ заказа', 'Название заказа', 'Клиент', 'Долг', 'Статус'],
    ['2', 'QA order', 'QA client', debt, 'Согласован'], ['3', 'Paid order', 'QA client', 0, 'Сдан']] });
  source[0].rows[1] = [];
  source[0].rows[1][3] = { userEnteredValue: { formulaValue: '=prepared_client' }, formulaResult: 'QA client' };
  source[0].rows[1][8] = { userEnteredValue: { formulaValue: '=prepared_category' }, formulaResult: 'Доплата' };
  const payload = { ...input, type: 'income', orderNumber: '2', requestId: crypto.randomUUID() };
  const created = (await store.execute('create', payload)).transaction;
  for (debt of [0, -100]) {
    const writes = client.writes;
    await assert.rejects(() => store.execute('create', { ...payload, requestId: crypto.randomUUID() }), { code: 'FINANCE_ORDER_PAID' });
    assert.equal((await store.execute('create', payload)).transaction.id, created.id);
    await assert.rejects(() => store.execute('update', { ...created, orderNumber: '3', requestId: crypto.randomUUID() }), { code: 'FINANCE_ORDER_PAID' });
    assert.equal(client.writes, writes);
  }
  const edited = await store.execute('update', { ...created, cashInRegister: false, comment: 'История', requestId: crypto.randomUUID() });
  assert.equal(edited.transaction.comment, 'История');
});

test('finance reads Google, never the retired replica, and exposes no stale success', async t => {
  const { db, store, client } = setup(t);
  createTransaction(db, input);
  assert.deepEqual(await store.read(), []);
  client.failRead = true;
  await assert.rejects(() => store.read());
  assert.equal(store.status().last_error, 'SHEETS_UNAVAILABLE');
});

test('create, update, stale rejection and delete use confirmed Google results', async t => {
  const { store, client, source } = setup(t);
  const requestId = crypto.randomUUID();
  const { transaction } = await store.execute('create', { ...input, requestId });
  assert.equal(transaction.id, requestId); assert.equal(transaction.amount, 100);
  assert.equal(source[1].rows[1][0].userEnteredValue.numberValue, 46271);
  const result = await store.execute('update', { ...input, id: requestId, requestId: crypto.randomUUID(), amount: 200, expectedHash: transaction.sheetHash });
  assert.equal(result.transaction.amount, 200);
  const writes = client.writes;
  await assert.rejects(() => store.execute('update', { ...input, id: requestId, expectedHash: transaction.sheetHash }), { code: 'FINANCE_STALE' });
  assert.equal(client.writes, writes);
  const removal = { id: requestId, requestId: crypto.randomUUID(), expectedHash: result.transaction.sheetHash };
  source[1].rows[1][6] = { userEnteredValue: { formulaValue: '=IF(F2="","",F2)' }, formulaResult: '' };
  const formula = structuredClone(source[1].rows[1][6]);
  assert.equal((await store.execute('delete', removal)).success, true);
  assert.equal((await store.execute('delete', removal)).success, true);
  assert.deepEqual(await store.read(), []);
  assert.equal(source[1].rows.length, 2);
  assert.deepEqual(source[1].rows[1][6], formula);
});

test('lost create response recovers after restart with exactly one write', async t => {
  const { store, client, db } = setup(t);
  const payload = { ...input, requestId: crypto.randomUUID() };
  client.loseResponse = true;
  await assert.rejects(() => store.execute('create', payload), { code: 'FINANCE_UNCONFIRMED' });
  assert.equal(store.pending().length, 1);
  const restarted = new FinanceSheetStore({ db, client });
  await restarted.verifyPending();
  const result = await restarted.execute('create', payload);
  assert.equal(result.transaction.amount, 100); assert.equal(client.writes, 1); assert.equal(restarted.pending().length, 0);
  await assert.rejects(() => restarted.execute('create', { ...payload, amount: 101 }), { code: 'FINANCE_REQUEST_CHANGED' });
});

test('uncertain unapplied request cannot be replayed or bypassed by another creation', async t => {
  const { store, client } = setup(t);
  const payload = { ...input, requestId: crypto.randomUUID() };
  client.rejectWrite = true;
  await assert.rejects(() => store.execute('create', payload), { code: 'FINANCE_UNCONFIRMED' });
  client.rejectWrite = false;
  await assert.rejects(() => store.execute('create', payload), { code: 'FINANCE_UNCONFIRMED' });
  await assert.rejects(() => store.execute('create', { ...input, requestId: crypto.randomUUID() }), { code: 'FINANCE_PENDING' });
  assert.equal(client.writes, 1);
});

test('formula inputs and duplicate IDs cannot be overwritten or silently omitted', async t => {
  const { store, source, client } = setup(t);
  const { transaction } = await store.execute('create', { ...input, requestId: crypto.randomUUID() });
  source[1].rows[1][3] = { userEnteredValue: { formulaValue: '=50+50' }, formulaResult: '100' };
  await assert.rejects(() => store.execute('update', { ...input, id: transaction.id, amount: 200 }), { code: 'FINANCE_FORMULA' });
  source[1].rows[2] = structuredClone(source[1].rows[1]);
  const writes = client.writes;
  await assert.rejects(() => store.read(), { code: 'FINANCE_INVALID_ROWS' });
  assert.equal(client.writes, writes);
});

test('manually entered valid row receives only technical metadata and appears once', async t => {
  const { store, source, client } = setup(t);
  source[1].rows[1] = ['2026-09-06', 'Прочее', 'Ручной расход', 123, 'В кассе'].map(cell);
  const before = structuredClone(source[1].rows[1]);
  assert.equal((await store.read()).length, 1);
  assert.deepEqual(source[1].rows[1].slice(0, 5), before);
  await store.read(); assert.equal(client.writes, 1);
});

test('common queue serializes modules and continues after an error', async () => {
  const queue = new CommandQueue(), result = [];
  await Promise.allSettled([
    queue.run(async () => { result.push('finance'); await Promise.resolve(); throw new Error(); }),
    queue.run(async () => { result.push('orders'); }),
    queue.run(async () => { result.push('warehouse'); }),
  ]);
  assert.deepEqual(result, ['finance', 'orders', 'warehouse']); assert.equal(queue.waiting, 0);
});

test('diagnostics persist no business payload and redact route IDs and query strings', t => {
  const { db } = setup(t); const diagnostics = new Diagnostics(db, { info() {} });
  assert.deepEqual(diagnostics.recent(), []);
  assert.equal(routeLabel('/kanban/api/orders/private-order/media/private-file?token=secret'), '/kanban/api/orders/:id/media/:id');
});

test('measurement create, lost-response retry, automatic cash, amount edit and delete preserve all formulas', async t => {
  const { store, source, client, db } = setup(t);
  const formulas = [2,3,4,5,8,9];
  source[0].rows[1] = [];
  for (const col of formulas) source[0].rows[1][col] = {userEnteredValue:{formulaValue:'=IF(B2="","",1)'}, formulaResult:''};
  const before = structuredClone(source[0].rows[1]);
  const payload = {...input, type:'income',category:'Замеры',description:'Замеры',cashInRegister:true,comment:'QA: замер',requestId:crypto.randomUUID()};
  client.loseResponse = true;
  await assert.rejects(() => store.execute('create',payload),{code:'FINANCE_UNCONFIRMED'});
  client.loseResponse = false;
  const restarted = new FinanceSheetStore({db,client});
  const created = (await restarted.execute('create',payload)).transaction;
  assert.equal(client.writes,1); assert.equal(created.category,'Замеры'); assert.equal(created.counterparty,null);
  assert.equal(created.comment,'QA: замер'); assert.equal(created.orderNumber,null);
  await assert.rejects(() => restarted.execute('create',{...payload,amount:101}),{code:'FINANCE_REQUEST_CHANGED'});
  await assert.rejects(() => restarted.execute('update',{...created,category:'Предоплата',orderNumber:'1',requestId:crypto.randomUUID()}),{code:'FINANCE_MEASUREMENT_TYPE'});
  await assert.rejects(() => restarted.execute('create',{...payload,orderNumber:'1',requestId:crypto.randomUUID()}),{code:'FINANCE_MEASUREMENT_ORDER'});
  const edited = (await restarted.execute('update',{...created,amount:200,cashInRegister:false,comment:null,requestId:crypto.randomUUID(),expectedHash:created.sheetHash})).transaction;
  assert.equal(edited.amount,200); assert.equal(edited.cashInRegister,true); assert.equal(edited.comment,null);
  assert.equal(source[0].rows[1][10].userEnteredValue.stringValue,'[Замеры]');
  for (const col of formulas) assert.deepEqual(source[0].rows[1][col],before[col]);
  await restarted.execute('delete',{id:created.id,requestId:crypto.randomUUID(),expectedHash:edited.sheetHash});
  assert.deepEqual(await restarted.read(),[]);
  assert.equal(source[0].rows[1][10].userEnteredValue,undefined);
  for (const col of formulas) assert.deepEqual(source[0].rows[1][col],before[col]);
});

test('an order without a client is rejected before committing an invalid payment row', async t => {
  const { store, source, client } = setup(t);
  let clientName = '';
  client.getValues = async () => ({ values: [['№ заказа', 'Название заказа', 'Клиент', 'Долг', 'Статус'],
    [2, 'QA order', clientName, 1000, 'Согласован']] });
  source[0].rows[1] = [];
  source[0].rows[1][3] = { userEnteredValue: { formulaValue: '=prepared_client' }, formulaResult: 'QA client' };
  source[0].rows[1][8] = { userEnteredValue: { formulaValue: '=prepared_category' }, formulaResult: 'Доплата' };
  const payload = { ...input, type: 'income', orderNumber: '2', requestId: crypto.randomUUID() };
  await assert.rejects(() => store.execute('create', payload), { code: 'FINANCE_ORDER_CLIENT' });
  assert.equal(client.writes, 0); assert.equal(store.pending().length, 0);
  clientName = 'QA client';
  const created = (await store.execute('create', payload)).transaction;
  clientName = '';
  const writes = client.writes;
  await assert.rejects(() => store.execute('update', { ...created, amount: 200, requestId: crypto.randomUUID() }), { code: 'FINANCE_ORDER_CLIENT' });
  assert.equal(client.writes, writes); assert.equal(store.pending().length, 0);
});

for (const rawNumber of [2, '2', '002', 'QA-2']) {
  for (const type of ['income', 'expense']) {
    test(`${type} keeps Google order key type ${JSON.stringify(rawNumber)} through create, replay and Kanban edit`, async t => {
      const { store, source, client } = setup(t);
      client.getValues = async (name, range, options) => {
        assert.equal(name, 'Заказы');
        assert.equal(options.valueRenderOption, 'UNFORMATTED_VALUE');
        return { values: [['№ заказа', 'Название заказа', 'Клиент', 'Сумма заказа', 'Оплачено', 'Долг', 'Статус'],
          [rawNumber, 'QA order', 'QA client', 35000, 20000, 15000, 'Согласован']] };
      };
      // Prepared computed cells are deliberately separate from manual inputs.
      source[0].rows[1] = [];
      for (const [col, value] of [[2, 'QA order'], [3, 'QA client'], [4, 35000], [5, 20000], [8, 'Доплата'], [9, 14900]]) {
        source[0].rows[1][col] = { userEnteredValue: { formulaValue: '=prepared_formula' }, formulaResult: value };
      }
      source[1].rows[1] = [];
      source[1].rows[1][6] = { userEnteredValue: { formulaValue: '=prepared_formula' }, formulaResult: 'QA order' };
      const table = source[type === 'income' ? 0 : 1], keyColumn = type === 'income' ? 1 : 5;
      const payload = { ...input, type, orderNumber: String(rawNumber), requestId: crypto.randomUUID() };
      const created = (await store.execute('create', payload)).transaction;
      assert.deepEqual(table.rows[1][keyColumn].userEnteredValue, cell(rawNumber).userEnteredValue);
      const writes = client.writes;
      assert.equal((await store.execute('create', payload)).transaction.id, created.id);
      assert.equal(client.writes, writes);
      const edited = (await store.editPrepared({ syncId: created.id, current: created, changes: { amount: 200 } })).transaction;
      assert.equal(edited.amount, 200);
      assert.deepEqual(table.rows[1][keyColumn].userEnteredValue, cell(rawNumber).userEnteredValue);
      assert.equal(table.rows[1][type === 'income' ? 2 : 6].userEnteredValue.formulaValue, '=prepared_formula');
      // A disappeared order must not prevent editing its existing history or
      // change the stored key's type while updating a comment.
      client.getValues = async () => ({ values: [['№ заказа', 'Название заказа', 'Долг', 'Статус']] });
      await store.execute('update', { ...edited, comment: 'History', requestId: crypto.randomUUID() });
      assert.deepEqual(table.rows[1][keyColumn].userEnteredValue, cell(rawNumber).userEnteredValue);
    });
  }
}
