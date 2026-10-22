// One fictional payment on the allowlisted QA copy. No live workbook or formula writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertTestSheet, assertOwned } from './safety.mjs';
import { GoogleSheetsClient } from '../server/sheets-client.mjs';
import { installSheetsGuard, SHEETS_SCHEMA } from '../server/sheets-guard.mjs';
import { FinanceSheetStore } from '../server/finance-sheet.mjs';
import { openDatabase } from '../server/db.mjs';
import { validTransaction } from '../server/finance-input.mjs';
const sheet=assertTestSheet(process.env.GOOGLE_SPREADSHEET_ID,process.env.QA_CONFIRM_SHEET);
const directory=assertOwned(process.env.QA_DIRECTORY);
assert.equal(process.env.DATA_DIR,path.join(directory,'data'));
const client=new GoogleSheetsClient({spreadsheetId:sheet,credentialsFile:process.env.GOOGLE_CREDENTIALS_FILE});
const db=openDatabase(path.join(directory,'data','finance.sqlite3'));
const store=new FinanceSheetStore({db,client});
const file=path.join(directory,'measurement-state.json');
const state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{create:crypto.randomUUID(),edit:crypto.randomUUID(),remove:crypto.randomUUID(),phase:'initial'};
assert.equal(state.phase,'initial','Resolve the saved test receipt before resuming a mutation');
const save=()=>fs.writeFileSync(file,JSON.stringify(state));save();
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const checks=[];
let created,baseline;
async function proof() {
  const ranges=["'Заказы'!P2:Q301","'Клиенты'!M2:N201","'Дашборд'!C18","'Дашборд'!B5:D14","'По месяцам'!C6:N6"];
  const data=(await client.getRanges(ranges,{valueRenderOption:'UNFORMATTED_VALUE'})).valueRanges.map(r=>r.values??[]);
  const cash=data[3].find(r=>r[0]==='В кассе');assert.ok(cash);
  return {orders:hash(data[0]),clients:hash(data[1]),income:Number(data[2][0][0]),cash:Number(cash[2]),monthly:data[4][0].reduce((n,v)=>n+Number(v||0),0)};
}
async function assertDelta(amount) {
  const p=await proof();
  assert.equal(p.orders,baseline.orders,'order payment/debt must be unchanged');
  assert.equal(p.clients,baseline.clients,'client payment/debt must be unchanged');
  for(const k of ['income','cash','monthly'])assert.equal(p[k]-baseline[k],amount,`${k} delta`);
}
async function formulas(row) {
  const ranges=[`'Платежи'!C${row}:F${row}`,`'Платежи'!I${row}:J${row}`];
  return (await client.getRanges(ranges,{valueRenderOption:'FORMULA'})).valueRanges.map(r=>r.values);
}
try {
  const metadata=await client.getSpreadsheet();
  for(const name of ['Платежи','Заказы','Клиенты','Дашборд','По месяцам'])assert.ok(metadata.sheets.some(s=>s.properties.title===name));
  // The old QA fixture has a 497 expense boundary. Adapt only the in-memory
  // expected fixture formula; the Google formula and production schema stay intact.
  const anchor=(await client.getValues('Заказы','M2',{valueRenderOption:'FORMULA'})).values[0][0];
  const expected=SHEETS_SCHEMA.sheets['Заказы'].formulas.M;
  assert.ok(anchor===expected||anchor===expected.replaceAll('$498','$497'));
  SHEETS_SCHEMA.sheets['Заказы'].formulas.M=anchor;
  installSheetsGuard(client);
  const initial=await store.snapshot();assert.equal(initial.missingIds.length,0,'No implicit metadata writes permitted');
  const table=initial.tables.get('income');
  const last=table.rows.reduce((n,r,i)=>i>0&&(r[0]||r[6])?i+1:n,1);state.row=last+1;save();
  const beforeFormulas=await formulas(state.row);baseline=await proof();
  const serial=(await client.getValues('Дашборд','C1',{valueRenderOption:'UNFORMATTED_VALUE'})).values[0][0];
  assert.equal(typeof serial,'number');const date=new Date(Date.UTC(1899,11,30)+serial*86400000).toISOString().slice(0,10);
  const payload={...validTransaction({type:'income',category:'Замеры',date,amount:123,account:'В кассе',cashInRegister:true,comment:'QA: вымышленный замер'}),requestId:state.create};
  state.phase='creating';save();
  created=(await store.execute('create',payload)).transaction;
  assert.equal(created.sheetRow,state.row);assert.equal(created.category,'Замеры');assert.equal(created.orderNumber,null);assert.equal(created.counterparty,null);
  await store.execute('create',payload);
  assert.equal((await store.read()).filter(r=>r.id===state.create).length,1);
  await assertDelta(123);assert.deepEqual(await formulas(state.row),beforeFormulas);
  checks.push('one confirmed measurement; real account/dashboard/monthly deltas +123; orders/clients unchanged');
  state.phase='editing';save();
  created=(await store.execute('update',{...created,amount:234,cashInRegister:false,comment:null,requestId:state.edit,expectedHash:created.sheetHash})).transaction;
  assert.equal(created.amount,234);assert.equal(created.cashInRegister,true);assert.equal(created.category,'Замеры');
  await assertDelta(234);assert.deepEqual(await formulas(state.row),beforeFormulas);
  checks.push('amount edit to 234; independent cash flag; formulas preserved');
  state.phase='deleting';save();
  await store.execute('delete',{id:created.id,requestId:state.remove,expectedHash:created.sheetHash});
  await store.execute('delete',{id:created.id,requestId:state.remove,expectedHash:created.sheetHash});
  assert.equal((await store.read()).filter(r=>r.id===state.create).length,0);
  await assertDelta(0);assert.deepEqual(await formulas(state.row),beforeFormulas);
  checks.push('only own row inputs cleared; original totals and formulas restored');
  state.phase='completed';save();
  const report={ok:true,checks,pending:store.pending().length};fs.writeFileSync(path.join(directory,'measurement-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} catch(error) {
  // Keep stable IDs and receipts for review; never guess/replay an uncertain write.
  console.error(JSON.stringify({ok:false,phase:state.phase,code:error.code??error.name,message:error.name==='AssertionError'?error.message:'Operation rejected'}));process.exitCode=1;
} finally {db.close();}
