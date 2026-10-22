import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {NightlyAttribution,localDay,nextMidnight,attributedFacts,validateMatches} from './analytics/nightly-attribution.mjs';
import {codexArguments} from './max-codex-broker.mjs';

function fixture(t) {
  const db=new Database(':memory:');
  let now=Date.parse('2026-09-26T20:59:30Z'),calls=0,reads=0;
  const orders=[{id:'12',title:'Вымышленная вывеска',client:'Тест',createdDate:'2026-09-20',status:'В работе',amount:5000,items:[]}];
  const chat={id:'chat-1',itemId:'123',itemTitle:'Вывески',createdAt:'2026-09-18T12:00:00Z',updatedAt:'2026-09-26T12:00:00Z',lastMessageId:'m1',users:[]};
  const messages=[{id:'m1',createdAt:chat.updatedAt,direction:'in',type:'text',text:'Вымышленная вывеска, заказ 12'}];
  const options={base:{storage:()=>db,namespace:()=>'account'},client:{conversations:async()=>({chats:[chat],hasMore:false,accountId:'account'}),conversationMessages:async()=>{reads++;return {messages,hasMore:false};}},readOrders:async()=>({orders}),settings:()=>({codexEnabled:true,codexTokenFile:'fictional'}),enabled:true,now:()=>now,
    ask:async(_,input)=>{calls++;assert.equal(input.task,'avito-attribution');assert.equal(input.search,false);return {answer:JSON.stringify({matches:[{orderId:'12',evidence:['order_reference'],messageIds:['m1']}]})};}};
  const agent=new NightlyAttribution(options);agent.start();
  t.after(async()=>{await agent.close();db.close();});
  return {db,agent,chat,messages,orders,options,calls:()=>calls,reads:()=>reads,setTime:value=>{now=Date.parse(value);}};
}

test('midnight UTC+3, not UTC midnight; no immediate installation scan; one daily run',async t=>{
  const f=fixture(t);await f.agent.tick();assert.equal(f.calls(),0);
  assert.equal(localDay(Date.parse('2026-09-26T21:00:00Z')),'2026-09-27');
  assert.equal(nextMidnight(Date.parse('2026-09-26T20:00:00Z')),Date.parse('2026-09-26T21:00:00Z'));
  f.setTime('2026-09-26T21:00:00Z');await Promise.all([f.agent.tick(),f.agent.tick()]);await f.agent.tick();
  assert.equal(f.calls(),1);assert.equal(f.agent.view().pending.length,1);assert.equal(f.agent.view().links.length,0);
  f.setTime('2026-09-27T21:00:00Z');await f.agent.tick();assert.equal(f.calls(),1);assert.equal(f.reads(),1);
});

test('service backfill and nightly service check share the chat worker flight',async t=>{
  const f=fixture(t),events=[];
  f.agent.services={bootstrap:async()=>{events.push('bootstrap');},run:async day=>{events.push(day);}};
  await f.agent.tick();assert.deepEqual(events,['bootstrap']);assert.equal(f.reads(),0);
  f.setTime('2026-09-26T21:00:00Z');await f.agent.tick();
  assert.deepEqual(events,['bootstrap','bootstrap','2026-09-27']);assert.equal(f.calls(),1);
});
test('metadata-only update skips model; new message triggers one analysis after restart',async t=>{
  const f=fixture(t);f.setTime('2026-09-26T21:00:00Z');await f.agent.tick();
  f.chat.updatedAt='2026-09-27T12:00:00Z';f.setTime('2026-09-27T21:00:00Z');await f.agent.tick();assert.equal(f.calls(),1);
  await f.agent.close();
  const resumed=new NightlyAttribution(f.options);resumed.start();t.after(()=>resumed.close());
  f.messages.push({id:'m2',createdAt:'2026-09-28T12:00:00Z',direction:'in',type:'text',text:'Добавьте монтаж'});f.chat.lastMessageId='m2';
  f.setTime('2026-09-28T21:00:00Z');await resumed.tick();assert.equal(f.calls(),2);assert.equal(resumed.view().pending.length,1);
});
test('uncertain model failure is not silently rescanned; financial facts require explicit confirmation',async t=>{
  const f=fixture(t);f.agent.ask=async()=>{throw new Error('timeout');};
  f.setTime('2026-09-26T21:00:00Z');await f.agent.tick();assert.equal(f.agent.view().run.stats.failed,1);
  const reads=f.reads();f.setTime('2026-09-27T21:00:00Z');await f.agent.tick();assert.equal(f.reads(),reads);assert.equal(f.agent.view().links.length,0);
});
test('confirmation is idempotent and one order cannot be counted under two ads; unlink preserves audit',async t=>{
  const f=fixture(t);f.setTime('2026-09-26T21:00:00Z');await f.agent.tick();const id=f.agent.view().pending[0].id;
  await f.agent.decide({id,action:'confirm'});await f.agent.decide({id,action:'confirm'});assert.equal(f.agent.view().links.length,1);
  f.chat.id='chat-2';f.chat.itemId='456';f.setTime('2026-09-27T21:00:00Z');await f.agent.tick();const second=f.agent.view().pending[0].id;
  await assert.rejects(()=>f.agent.decide({id:second,action:'confirm'}),/Связь уже/u);
  await f.agent.decide({id,action:'unlink'});assert.equal(f.agent.view().links.length,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM attribution_decisions').get().n,2);
});
test('advance and balance follow same order without duplicating orders; receipts use payment dates',()=>{
  const data={links:[{orderId:'12',itemId:'123',itemTitle:'Тест'}],orders:[{id:'12',createdDate:'2026-08-30',status:'В работе',profit:2000}],records:[{type:'income',orderNumber:'12',date:'2026-08-30',amount:3000},{type:'income',orderNumber:'12',date:'2026-09-02',amount:2000},{type:'income',orderNumber:'13',date:'2026-09-02',amount:7000}],period:{from:'2026-09-01',to:'2026-09-30'}};
  assert.deepEqual(attributedFacts(data)[0],{itemId:'123',title:'Тест',orders:0,orderIds:['12'],receipts:2000,profit:0});
  assert.equal(attributedFacts({...data,records:undefined})[0].receipts,null);
});
test('model cannot invent order/message IDs or persist freeform private text; Luna max has no tools',()=>{
  assert.throws(()=>validateMatches('{"matches":[{"orderId":"made-up","evidence":["name"],"messageIds":["m1"]}]}',[{id:'12'}],[{id:'m1'}]));
  assert.throws(()=>validateMatches('{"matches":[{"orderId":"12","evidence":["secret text"],"messageIds":["m1"]}]}',[{id:'12'}],[{id:'m1'}]));
  const args=codexArguments(false,true);assert.ok(args.includes('gpt-6-luna'));assert.ok(args.includes('model_reasoning_effort="max"'));assert.ok(args.includes('web_search="disabled"'));assert.ok(args.includes('read-only'));
});

test('nightly pagination waits for Avito gates on both chat and message pages without duplicating AI',async t=>{
  const f=fixture(t);let gate=false,indexCalls=0,messageCalls=0;const waits=[];
  f.agent.pause=async ms=>{waits.push(ms);gate=false;};
  const limited=()=>Object.assign(new Error('fictional throttle'),{code:'rate_limit',retryAfterSeconds:1});
  f.agent.client.conversations=async({offset})=>{indexCalls++;if(gate)throw limited();gate=true;return {accountId:'account',chats:offset===0?[f.chat]:[],hasMore:offset===0};};
  f.agent.client.conversationMessages=async({offset})=>{messageCalls++;if(gate)throw limited();gate=true;return {messages:offset===0?f.messages:[],hasMore:offset===0};};
  f.setTime('2026-09-26T21:00:00Z');await f.agent.tick();
  assert.equal(f.agent.view().run.state,'done');assert.equal(f.calls(),1);assert.equal(indexCalls,3);assert.equal(messageCalls,4);
  assert.deepEqual(waits,[1050,1050,1050]);
  f.setTime('2026-09-27T21:00:00Z');await f.agent.tick();assert.equal(f.calls(),1);assert.equal(messageCalls,4);
});

test('permanent provider errors are recorded without blind retries or model calls',async t=>{
  const f=fixture(t);let reads=0;f.agent.client.conversations=async()=>{reads++;throw Object.assign(new Error('private body must not persist'),{code:'forbidden'});};
  f.setTime('2026-09-26T21:00:00Z');await f.agent.tick();
  assert.equal(f.calls(),0);assert.equal(reads,1);assert.equal(f.agent.view().run.stats.failureCode,'forbidden');
  assert.ok(!JSON.stringify(f.agent.view()).includes('private body'));
});
