import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Database from 'better-sqlite3';
import {MaxBot} from './max-bot.mjs';
import {MaxAssistant,assistantContext,assistantChanges} from './max-assistant.mjs';
import {createBroker,runCodex} from './max-codex-broker.mjs';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';

const board={updatedAt:'2026-09-26T12:00:00Z',orders:[{id:'12',title:'Вымышленная вывеска',client:'Тест',status:'В работе',dueDate:'2026-09-27',amount:5000,paid:null,items:[],email:'private@example.test'}]};
function fixture(t){
  const db=new Database(':memory:');t.after(()=>db.close());let now=Date.parse(board.updatedAt),reads=0,calls=0;const sent=[],requests=[];
  const config={codexEnabled:true,monitorEnabled:true,allowedChatIds:[]};
  const bot=new MaxBot({db,config,readBoard:async()=>{reads++;return board;},send:async(_,id,text)=>sent.push({id,text})});
  db.prepare('INSERT INTO max_bot_users VALUES (?,?)').run('123',board.updatedAt);
  const assistant=new MaxAssistant({db,settings:()=>config,readBoard:bot.readBoard,send:bot.send,now:()=>now,ask:async(_,request)=>{calls++;requests.push(request);return {answer:'Условный ответ',usage:{input:10,output:4}};}});bot.assistant=assistant;
  return {db,bot,assistant,sent,requests,reads:()=>reads,calls:()=>calls,tick:()=>{now+=3600000;}};
}
test('personal assistant accepts approved sender, ignores other users and groups, and deduplicates',async t=>{
  const f=fixture(t);const event=id=>({update_type:'message_created',message:{sender:{user_id:id},recipient:{chat_type:'dialog'},body:{text:'Какие риски?',mid:'one'}}});
  await f.bot.process(event(456));assert.equal(f.reads(),0);
  const group=event(123);group.message.recipient={chat_type:'chat',chat_id:-10};await f.bot.process(group);assert.equal(f.calls(),0);
  await f.bot.process(event(123));await f.assistant.drain();await f.bot.process(event(123));await f.assistant.drain();assert.equal(f.calls(),1);assert.equal(f.sent.length,1);
});
test('delivery retry uses stored answer without spending another model request',async t=>{
  const f=fixture(t);f.assistant.send=async()=>{throw new Error('fictional network');};
  f.assistant.enqueue({key:'one',id:'123',text:'Вопрос'});await f.assistant.drain();assert.equal(f.calls(),1);
  f.tick();f.assistant.send=f.bot.send;await f.assistant.drain();assert.equal(f.calls(),1);assert.equal(f.sent.length,1);
  assert.equal(f.db.prepare('SELECT question FROM max_assistant_jobs').get().question,'');
});
test('explicit web search omits all private project context and avoids Google reads',async t=>{
  const f=fixture(t);f.assistant.enqueue({key:'search',id:'123',text:'/search виды пластика'});await f.assistant.drain();
  assert.equal(f.reads(),0);assert.deepEqual(f.requests[0],{question:'виды пластика',search:true});
});
test('context preserves unknown payments, excludes contact details and does not infer deletion',()=>{
  const context=assistantContext(board);assert.equal(context.orders[0].paid,null);assert.ok(!JSON.stringify(context).includes('private@example'));
  const diff=assistantChanges(context,{...context,orders:[],truncated:true},'2026-09-26');assert.equal(diff.changes.length,0);
  const risk=assistantChanges(context,context,'2026-09-26').risks[0];assert.equal(risk.fact,'Срок завтра');assert.match(risk.forecast,/загрузка/u);
});
test('monitor baseline and unchanged snapshots do not invoke model; changed orders are batched',async t=>{
  const f=fixture(t);await f.assistant.monitor();await f.assistant.monitor();assert.equal(f.calls(),0);
  f.assistant.readBoard=async()=>({...board,orders:[{...board.orders[0],status:'Монтаж'}]});f.tick();await f.assistant.monitor();await f.assistant.drain();assert.equal(f.calls(),1);
  assert.equal(f.requests[0].context.events[0].before.status,'В работе');
  await f.assistant.monitor();await f.assistant.drain();assert.equal(f.calls(),1);
});
test('broker rejects untrusted callers and search requests containing private context',async t=>{
  let called=0;const server=createBroker({token:'fictional',run:async()=>{called++;return {answer:'ok'};}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const post=(token,input)=>new Promise(resolve=>{const request=http.request({host:'127.0.0.1',port:server.address().port,path:'/answer',method:'POST',headers:{'X-Workshop-Codex':token}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});request.end(JSON.stringify(input));});
  assert.equal(await post('bad',{question:'x',search:false}),403);assert.equal(await post('fictional',{question:'x',search:true,context:board}),400);assert.equal(called,0);
  assert.equal(await post('fictional',{question:'x',search:false}),200);assert.equal(called,1);
});
test('Codex questions travel through stdin with no API credentials or execution tools',async()=>{
  let options,args,prompt;const spawnImpl=(_,a,o)=>{args=a;options=o;const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};
    child.stdin.on('data',chunk=>{prompt=chunk.toString();});child.stdin.on('finish',()=>{child.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Условный ответ'}})+'\n');child.emit('close',0);});return child;};
  const result=await runCodex({question:'$(fictional-command)',search:false},{executable:'fictional',directory:'.',spawnImpl});
  assert.equal(result.answer,'Условный ответ');assert.ok(prompt.includes('$(fictional-command)'));assert.ok(!args.join(' ').includes('fictional-command'));assert.equal(options.env.OPENAI_API_KEY,undefined);assert.ok(args.includes('shell_tool'));assert.ok(args.includes('read-only'));
});
