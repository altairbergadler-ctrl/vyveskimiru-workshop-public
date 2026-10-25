import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { MaxBot, maxReply, serializeMaxSend } from './max-bot.mjs';

test('shared MAX transport spaces mixed notices and retouch per recipient and a rejection does not block later sends', async () => {
  let now = 10000; const sent = [];
  const send = serializeMaxSend(async (_, id, text) => {
    sent.push({ id, text, at: now });
    if (text === 'income') throw Object.assign(new Error('MAX_API_UNAVAILABLE'), { deliveryState: 'not_sent' });
    return { message: { body: { mid: text } } };
  }, { now: () => now, wait: async ms => { now += ms; } });
  const results = await Promise.allSettled(['income', 'retouch-question', 'retouch-result', 'composition'].map(text => send({}, '-10', text, 'chat')));
  assert.equal(results[0].reason.deliveryState, 'not_sent');
  assert.ok(results.slice(1).every(item => item.status === 'fulfilled'));
  assert.deepEqual(sent.map(item => item.text), ['income', 'retouch-question', 'retouch-result', 'composition']);
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i].at - sent[i - 1].at >= 550);
  await send({}, '-20', 'other-chat', 'chat');
  assert.equal(sent.at(-1).at, sent.at(-2).at);
});

const board = { updatedAt: '2026-09-26T12:00:00Z', orders: [{ id:'12',title:'Вымышленная вывеска',client:'Тест',status:'В работе',dueDate:'2026-10-01',amount:5000,paid:null,items:[] }] };
function fixture(t) {
  const db = new Database(':memory:'); t.after(() => db.close());
  const sent = []; let reads=0;
  const bot = new MaxBot({db, config:{secret:'fictional-secret',allowedChatIds:['-10']},readBoard:async()=>{reads++;return board;},send:async(_,id,text)=>sent.push({id,text})});
  return {bot,sent,db,reads:()=>reads};
}
function event(text='/orders',mid='fictional-id',chatId=-10) {
  return {update_type:'message_created',message:{sender:{is_bot:false},recipient:{chat_type:'chat',chat_id:chatId},body:{text,mid}}};
}
test('MAX denies absent/wrong webhook secrets and unlisted chats before reading',async t=>{
  const f=fixture(t); assert.equal(f.bot.authorized(),false); assert.equal(f.bot.authorized('wrong'),false); assert.equal(f.bot.authorized('fictional-secret'),true);
  await f.bot.process(event('/orders','other',-20)); assert.equal(f.reads(),0); assert.equal(f.sent.length,0);
  f.bot.config.allowedChatIds=[]; await f.bot.process(event()); assert.equal(f.reads(),0);
});
test('MAX replay and concurrent delivery send one response; receipt survives new instance',async t=>{
  const f=fixture(t); await Promise.all([f.bot.process(event()),f.bot.process(event())]);
  assert.equal(f.sent.length,1); assert.equal(f.reads(),1);
  const restored=new MaxBot({db:f.db,config:f.bot.config,readBoard:async()=>{throw new Error('unexpected read');}});
  await restored.process(event()); assert.equal(f.sent.length,1);
});
test('MAX failed response is retried without a false receipt',async t=>{
  const f=fixture(t); const send=f.bot.send; f.bot.send=async()=>{throw new Error('fictional failure');};
  await assert.rejects(f.bot.process(event())); assert.equal(f.db.prepare('SELECT count(*) n FROM max_bot_events').get().n,0);
  f.bot.send=send; await f.bot.process(event()); assert.equal(f.sent.length,1);
});
test('MAX ignores ordinary conversation, private messages and bot messages',async t=>{
  const f=fixture(t); await f.bot.process(event('Обсудим заказ завтра'));
  const privateMessage=event();privateMessage.message.recipient.chat_type='dialog';await f.bot.process(privateMessage);
  const botMessage=event();botMessage.message.sender.is_bot=true;await f.bot.process(botMessage);
  assert.equal(f.reads(),0);assert.equal(f.sent.length,0);
  await f.bot.process({update_type:'bot_added',chat_id:-10});assert.equal(f.db.prepare('SELECT state FROM max_bot_chats').get().state,'bot_added');
});
test('MAX help has no Google read; money remains unknown and duplicate numbers are blocked',async t=>{
  const f=fixture(t);await f.bot.process(event('/help'));assert.equal(f.reads(),0);assert.match(f.sent[0].text,/\/orders/u);
  assert.match(maxReply('/order 12',board),/Внесено: не указано/u);
  assert.match(maxReply('/order 12',{...board,orders:[...board.orders,...board.orders]}),/повторяется/u);
  assert.equal(maxReply('/delete 12',board),null);
});

test('MAX private pairing binds one sender and never uses recipient bot ID',async t=>{
  const f=fixture(t);const code='fictional-private-code-2026';
  f.bot.config.pairingHash=crypto.createHash('sha256').update(code).digest('hex');
  f.bot.config.pairingExpiresAt=new Date(Date.now()+60000).toISOString();
  f.bot.send=async(_,id,text,kind)=>f.sent.push({id,text,kind});
  const dm=(text,mid,userId=123)=>{const e=event(text,mid);e.message.sender.user_id=userId;e.message.recipient={chat_type:'dialog',user_id:999};return e;};
  await f.bot.process(dm('/orders','before'));assert.equal(f.reads(),0);
  await f.bot.process(dm('/connect wrong-private-code','bad'));assert.equal(f.sent.length,0);
  await f.bot.process(dm(`/connect ${code}`,'connect'));assert.equal(f.reads(),0);assert.equal(f.sent[0].id,'123');assert.equal(f.sent[0].kind,'user');
  await f.bot.process(dm(`/connect ${code}`,'intruder',456));assert.equal(f.sent.length,1);
  await f.bot.process(dm('/orders','orders'));assert.equal(f.reads(),1);assert.equal(f.sent[1].id,'123');assert.equal(f.sent[1].kind,'user');
  await f.bot.process(dm('/orders','intruder-orders',456));assert.equal(f.reads(),1);
  const restored=new MaxBot({db:f.db,config:f.bot.config,readBoard:async()=>board,send:f.bot.send});
  await restored.process(dm('/help','after-restart'));assert.equal(f.sent[2].id,'123');
});

test('MAX expired pairing and pairing sent to a group cannot grant private access',async t=>{
  const f=fixture(t);const code='fictional-expired-code-2026';
  f.bot.config.pairingHash=crypto.createHash('sha256').update(code).digest('hex');
  f.bot.config.pairingExpiresAt=new Date(Date.now()-1000).toISOString();
  const e=event(`/connect ${code}`);e.message.sender.user_id=123;e.message.recipient.chat_type='dialog';
  await f.bot.process(e);assert.equal(f.db.prepare('SELECT count(*) n FROM max_bot_users').get().n,0);
  f.bot.config.pairingExpiresAt=new Date(Date.now()+60000).toISOString();e.message.recipient.chat_type='chat';
  await f.bot.process(e);assert.equal(f.db.prepare('SELECT count(*) n FROM max_bot_users').get().n,0);assert.equal(f.reads(),0);
});

test('natural order clarifications go to assistant, exact order command remains deterministic',async t=>{
  const f=fixture(t);f.bot.config.codexEnabled=true;f.db.prepare('INSERT INTO max_bot_users VALUES(?,?)').run('123','fictional');const queued=[];
  f.bot.assistant={enqueue:job=>{queued.push(job);return true;}};
  const dm=(text,mid)=>{const e=event(text,mid);e.message.sender.user_id=123;e.message.recipient={chat_type:'dialog'};return e;};
  await f.bot.process(dm('Заказ 12: клиент утвердил белую подсветку','note'));assert.equal(queued.length,1);assert.equal(f.reads(),0);
  await f.bot.process(dm('заказ 12','card'));assert.equal(f.reads(),1);assert.equal(queued.length,1);
});


test('MAX sales observer accepts authorized attachments edits and removals independently of commands, and cannot break replies',async t=>{
 const f=fixture(t),seen=[];f.bot.observeMessage=value=>seen.push(value);
 const attachment=event(null,'attachment');attachment.message.body.attachments=[{type:'image'}];await f.bot.process(attachment);
 await f.bot.process({...event('изменено','attachment'),update_type:'message_edited'});
 await f.bot.process(event('я'.repeat(4000),'long-message'));
 await f.bot.process({update_type:'message_removed',message_id:'attachment',chat_id:-10,user_id:7,timestamp:123});
 await f.bot.process(event(null,'forbidden',-20));
 assert.equal(seen.length,4);assert.equal(seen.at(-1).removed,true);assert.equal(f.sent.length,0);
 f.bot.observeMessage=()=>{throw new Error('sales failure');};await f.bot.process(event('/orders','command-after-failure'));assert.equal(f.sent.length,1);
});
