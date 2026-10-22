import assert from 'node:assert/strict';
import test from 'node:test';
import { validTransaction } from './finance-input.mjs';
import { SHEETS, layoutFromHeaders, fromSheet, validationProblems, recordValueUpdates } from './finance-contract.mjs';
import { SHEETS_SCHEMA } from './sheets-guard.mjs';
const input = { type: 'income', category: 'Замеры', amount: 123, date: '2026-09-08', account: 'В кассе' };
const layout = layoutFromHeaders(SHEETS[0], SHEETS_SCHEMA.sheets['Платежи'].headers);

test('measurement input needs no order/client but retains money, cash and date validation', () => {
  const record = validTransaction(input);
  assert.equal(record.orderNumber, null); assert.equal(record.counterparty, null);
  assert.equal(record.description, 'Замеры'); assert.equal(record.cashInRegister, true);
  for (const patch of [{orderNumber:'1'}, {counterparty:'QA'}, {amount:0}, {amount:-1}, {amount:1.5}, {account:''}, {date:'invalid'}]) assert.equal(validTransaction({...input,...patch}), null);
  assert.equal(validTransaction({...input,cashInRegister:false}).cashInRegister, true);
  assert.equal(validTransaction({...input,account:'Карта'}).cashInRegister, true);
  assert.equal(validTransaction({...input,category:'Предоплата'}), null);
  assert.equal(validTransaction({...input,category:'Предоплата',id:crypto.randomUUID()}), null);
  assert.equal(validTransaction({...input,category:'Замеры ',orderNumber:'1'}), null);
  assert.equal(validTransaction({...input,category:'Предоплата',orderNumber:'1',comment:'[Замеры]\nQA'}), null);
  assert.ok(validTransaction({...input,category:'Предоплата',orderNumber:'1'}));
});

test('measurement roundtrip uses only existing input columns and never writes payment formulas', () => {
  for (const comment of [null, 'QA: адрес', '[Замеры]\nвложенный комментарий']) {
    const record = {...validTransaction({...input,comment}),id:crypto.randomUUID()};
    const updates = recordValueUpdates(record, 2, '2026-09-08T12:00:00Z', layout);
    const row = [];
    for (const u of updates) {
      const letter = u.range.match(/!([A-Z]+)/)[1];
      assert.ok(['A','B','G','H','K','L','M','N','O','P'].includes(letter));
      row[letter.charCodeAt(0)-65] = u.values[0][0];
    }
    assert.equal(row[1], ''); assert.ok(row[10].startsWith('[Замеры]'));
    const result = fromSheet(SHEETS[0],row,2,layout);
    assert.equal(result.category,'Замеры'); assert.equal(result.description,'Замеры');
    assert.equal(result.comment, comment); assert.equal(result.orderNumber,null); assert.equal(result.counterparty,null);
    assert.deepEqual(validationProblems(result),[]);
    row[1] = '1'; assert.ok(validationProblems(fromSheet(SHEETS[0],row,2,layout)).includes('measurementOrder'));
  }
});

test('an unmarked orphan is still invalid and an ordinary payment keeps its original category', () => {
  const row = ['2026-09-08','','','','','',123,'В кассе','','','QA',true,crypto.randomUUID()];
  assert.ok(validationProblems(fromSheet(SHEETS[0],row,2,layout)).includes('category'));
  row[8]='Замеры'; assert.ok(validationProblems(fromSheet(SHEETS[0],row,2,layout)).includes('category'));
  row[1]='1'; row[3]='QA клиент'; row[8]='Предоплата';
  const ordinary=fromSheet(SHEETS[0],row,2,layout);
  assert.equal(ordinary.category,'Предоплата'); assert.deepEqual(validationProblems(ordinary),[]);
});
