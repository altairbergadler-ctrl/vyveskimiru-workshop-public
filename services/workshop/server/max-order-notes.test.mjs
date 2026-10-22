import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {MaxOrderNotes,explicitOrderIds,verifiedNote} from './max-order-notes.mjs';
import {MaxAssistant,assistantChanges,assistantContext} from './max-assistant.mjs';
import {readBoard} from '../modules/orders/server/orders.mjs';
import {CommandQueue} from './command-queue.mjs';

class FictionalSheets {
  constructor(){this.writes=[];this.raw={
    'Заказы':[['№ заказа','Название заказа','Статус','Комментарий','Сумма заказа'],['12','Вымышленная вывеска','В работе','Комментарий человека','=5000']],
    'Настройки':[['Статус заказа'],['В работе']],
    'Позиции':[['№ заказа','Наименование работы / изделия']],
    'Клиенты':[['Название / ФИО клиента','Телефон']],
    'Производство':[['№ заказа','Изделие','Этап']],
    'Платежи':[['№ заказа','Сумма платежа']],
    'Расходы':[['Дата','Категория','Описание','№ заказа (если есть)','Сумма']]};this.spreadsheetId='fictional';}
  async getSpreadsheet(){return {sheets:Object.keys(this.raw).map((title,sheetId)=>({properties:{title,sheetId,gridProperties:{rowCount:100,columnCount:30}}}))};}
  async getRanges(ranges,{valueRenderOption}={}) {return {valueRanges:ranges.map(range=>{
    const name=range.match(/^'([^']+)'/u)[1],values=structuredClone(this.raw[name]);
    if(valueRenderOption!=='FORMULA')for(const row of values)for(let column=0;column<row.length;column++)if(row[column]==='=5000')row[column]=5000;
    return {range,values};
  })};}
  async updateValues(updates){this.writes.push(structuredClone(updates));for(const update of updates){
    const [,name,letters,row]=update.range.match(/^'([^']+)'!([A-Z]+)(\d+)$/u);let column=0;for(const letter of letters)column=column*26+letter.charCodeAt(0)-64;
    this.raw[name][Number(row)-1][column-1]=update.values[0][0];
  }this.afterWrite?.();}
}
function fixture(t) {
  const db=new Database(':memory:');t.after(()=>db.close());const client=new FictionalSheets(),queue=new CommandQueue();
  const notes=new MaxOrderNotes({db,client,readBoard:()=>readBoard(client),run:action=>queue.run(action,'fictional-note')});
  const input={key:'a'.repeat(64),orderId:'12',quote:'Клиент утвердил белую подсветку',userId:'123',messageId:'fictional-message',receivedAt:'2026-09-26T12:00:00Z'};
  return {db,client,notes,input,queue};
}
test('real edit path appends marked source quote, preserves human text/formulas, and replays once after restart',async t=>{
  const f=fixture(t);assert.deepEqual(await f.notes.append(f.input),{saved:true});
  assert.equal(f.client.writes.length,1);assert.equal(f.client.writes[0].length,1);assert.equal(f.client.writes[0][0].range,"'Заказы'!D2");
  assert.equal(f.client.raw['Заказы'][1][4],'=5000');assert.match(f.client.raw['Заказы'][1][3],/^Комментарий человека\n\n\[Внесено ботом · VM_bot/u);
  assert.match(f.client.raw['Заказы'][1][3],/автор 123; сообщение fictional-message/u);
  const restored=new MaxOrderNotes({db:f.db,client:f.client,readBoard:()=>readBoard(f.client)});
  assert.equal((await restored.append(f.input)).replayed,true);assert.equal(f.client.writes.length,1);assert.equal(restored.pending(),0);
});
test('readback failure after write recovers by marker without duplicate append',async t=>{
  const f=fixture(t);let failed=false;
  f.notes.edit=async()=>{f.client.raw['Заказы'][1][3]+=`\nУточнение из обсуждения: ${f.input.quote}\n[VM_bot:${f.input.key}]`;failed=true;throw Object.assign(new Error('fictional timeout'),{code:'EDIT_UNCONFIRMED'});};
  assert.equal((await f.notes.append(f.input)).saved,true);assert.equal(failed,true);assert.equal(f.notes.pending(),0);
});

test('legacy composition stays intact while bot note uses visible order-comment section',async t=>{
  const f=fixture(t);f.client.raw['Заказы'][1][3]='ПРОДУКЦИЯ\n1. Вымышленный лайтбокс';f.client.raw['Позиции'].push(['12','Лайтбокс']);
  const before=assistantContext(await readBoard(f.client));await f.notes.append(f.input);const after=assistantContext(await readBoard(f.client));
  assert.ok(f.client.raw['Заказы'][1][3].startsWith('ПРОДУКЦИЯ\n1. Вымышленный лайтбокс\n\nКОММЕНТАРИЙ К ЗАКАЗУ\n[Внесено ботом'));
  assert.equal(assistantChanges(before,after,'2026-09-26').changes.length,0);
});
test('uncertain write never retries blindly and remains a release-blocking receipt',async t=>{
  const f=fixture(t);let calls=0;f.notes.edit=async()=>{calls++;throw new Error('fictional timeout');};
  assert.equal((await f.notes.append(f.input)).saved,false);assert.equal(f.notes.pending(),1);
  assert.equal((await f.notes.append(f.input)).saved,false);assert.equal(calls,1);assert.equal(f.client.raw['Заказы'][1][3],'Комментарий человека');
});
test('concurrent human update is preserved by existing revision conflict check',async t=>{
  const f=fixture(t);const original=f.notes.readBoard;
  f.notes.readBoard=async()=>{const board=await original();f.client.raw['Заказы'][1][3]='Более свежий комментарий человека';return board;};
  assert.equal((await f.notes.append(f.input)).saved,false);assert.equal(f.client.writes.length,0);assert.equal(f.notes.pending(),0);assert.equal(f.client.raw['Заказы'][1][3],'Более свежий комментарий человека');
});
test('missing/duplicate order, formula comment and full comment do not write',async t=>{
  const f=fixture(t);assert.equal((await f.notes.append({...f.input,orderId:'99'})).saved,false);
  f.client.raw['Заказы'].push([...f.client.raw['Заказы'][1]]);assert.equal((await f.notes.append(f.input)).saved,false);f.client.raw['Заказы'].pop();
  f.client.raw['Заказы'][1][3]='=5000';assert.equal((await f.notes.append(f.input)).saved,false);
  f.client.raw['Заказы'][1][3]='x'.repeat(12000);assert.equal((await f.notes.append(f.input)).saved,false);assert.equal(f.client.writes.length,0);
});
test('note validation rejects invented quotes, different order, questions, speculation and refusal outside quote',()=>{
  const note={orderId:'12',quote:'Клиент утвердил белую подсветку'},target={id:'12'};
  assert.ok(verifiedNote(note,`По заказу №12: ${note.quote}`,target));
  for(const [candidate,question] of [[{...note,orderId:'99'},note.quote],[note,'Другой факт'],[{...note,quote:'Возможно белая подсветка'},'Возможно белая подсветка'],[{...note,quote:'Белая подсветка?'},'Белая подсветка?'],[note,`Не записывай: ${note.quote}`]])assert.equal(verifiedNote(candidate,question,target),null);
  assert.deepEqual(explicitOrderIds('По заказу №12 и заказу 15 уточнение'),['12','15']);
});
test('selected order expires, explicit ambiguity blocks fallback and bot does not create monitor echoes',async t=>{
  const f=fixture(t);const board=await readBoard(f.client);f.notes.select('123','12');assert.equal(f.notes.target('123','Белая подсветка',board).id,'12');
  assert.equal(f.notes.target('123','По заказам №12 и №99',board),null);f.notes.now=()=>Date.now()+3601000;assert.equal(f.notes.target('123','Белая подсветка',board),null);
  const before=assistantContext(board);await f.notes.append(f.input);const after=assistantContext(await readBoard(f.client));assert.equal(assistantChanges(before,after,'2026-09-26').changes.length,0);
});
test('assistant saves verified note before MAX response and reuses receipt on failed delivery',async t=>{
  const f=fixture(t);f.db.exec('CREATE TABLE max_bot_users(user_id TEXT PRIMARY KEY,at TEXT)');f.db.prepare('INSERT INTO max_bot_users VALUES(?,?)').run('123','fictional');
  let calls=0,now=Date.now();const sent=[];const assistant=new MaxAssistant({db:f.db,notes:f.notes,settings:()=>({codexEnabled:true,notesEnabled:true}),now:()=>now,readBoard:()=>readBoard(f.client),send:async()=>{throw new Error('fictional delivery');},ask:async(_,input)=>{calls++;assert.equal(input.captureNotes,true);return {answer:'Уточнение принято к обработке.',note:{orderId:'12',quote:f.input.quote}};}});
  assistant.enqueue({key:f.input.key,id:'123',text:`По заказу 12: ${f.input.quote}`,meta:{messageId:f.input.messageId}});await assistant.drain();assert.equal(f.client.writes.length,1);
  now+=61000;assistant.send=async(_,id,text)=>sent.push({id,text});await assistant.drain();assert.equal(calls,1);assert.equal(f.client.writes.length,1);assert.match(sent[0].text,/Внесено ботом/u);
});
