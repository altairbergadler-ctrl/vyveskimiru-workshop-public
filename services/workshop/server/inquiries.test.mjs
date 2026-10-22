import test from 'node:test';
import assert from 'node:assert/strict';
import {parseChats,parseMessages,messageSignals,normalPhone,digest,chatId} from './avito-inquiries.mjs';
import {matchInquiries} from './analytics/inquiry-matching.mjs';
import {InquiryImport} from './analytics/inquiry-import.mjs';
import {InquiryService} from './analytics/inquiry-service.mjs';
import {AvitoError} from './avito.mjs';
import {createDirectory,removeDirectory} from '../qa/sandbox-lib.mjs';
import {inquiryChat,inquiryMessage,inquiryFixture} from '../qa/inquiry-fixture.mjs';
const key='fictional-private-key',period={from:'2026-09-01',to:'2026-09-09'};
const order=(p={})=>({id:'9001',title:'Учебная вывеска',createdDate:'2026-09-06',client:'Вымышленная мастерская Луна',status:'В работе',amount:10000,paid:3000,profit:7500,contacts:[{name:'Учебный клиент',email:'luna@example.invalid',phone:'89990000001',source:'Авито'}],...p});
const chat=(p={})=>inquiryChat({signals:messageSignals([inquiryMessage()],key),...p});
const match=(orders=[order()],chats=[chat()],options={})=>matchInquiries({board:{orders},chats,key,period,mode:'all',...options});
test('Messenger excludes buyer/support contexts; validates IDs, pagination and both message envelopes',()=>{
  const owned={id:'c1',created:1788602400,updated:1788688800,context:{type:'item',value:{id:5678,title:'Учебная вывеска',user_id:1234}},users:[{id:1234,name:'Seller'},{id:2345,name:'Buyer'}]};
  const r=parseChats({chats:[owned,{...owned,id:'buyer',context:{type:'item',value:{user_id:5555}}},{...owned,id:'support',context:{type:'support'}}],meta:{has_more:false}},'1234');
  assert.equal(r.chats.length,1);assert.equal(r.excluded,2);assert.equal(r.chats[0].users.length,1);assert.equal(r.hasMore,false);
  assert.throws(()=>parseChats({chats:[owned,owned]},'1234'));assert.throws(()=>chatId('../bad'));assert.throws(()=>chatId('c\n'));
  const message={id:'m1',created:1788602400,direction:'in',type:'text',content:{text:'hello'}};
  assert.equal(parseMessages([message]).messages[0].text,'hello');assert.equal(parseMessages({messages:[message],meta:{has_more:true}}).hasMore,true);
  assert.throws(()=>parseMessages({messages:[{...message,direction:'unknown'}]}));assert.throws(()=>parseMessages({messages:[message],meta:{has_more:'yes'}}));
});
test('Only incoming non-system contacts contribute; stored signals do not contain texts or contacts',()=>{
  const s=messageSignals([inquiryMessage(),inquiryMessage({direction:'out',text:'seller@example.invalid +7 999 000 00 02 заказ №9001'}),inquiryMessage({type:'system',text:'system@example.invalid заказ №9002'})],key,true);
  assert.deepEqual(s.phones,[digest(key,'phone','79990000001')]);assert.deepEqual(s.emails,[digest(key,'email','luna@example.invalid')]);assert.deepEqual(s.orderRefs,['9001']);assert.equal(s.incomingCount,1);assert.equal(s.hasMore,true);
  assert.ok(!JSON.stringify(s).includes('example.invalid'));assert.ok(!JSON.stringify(s).includes('79990000001'));assert.ok(!JSON.stringify(s).includes('Нужна'));assert.equal(normalPhone('9990000001'),'79990000001');
});
test('Contact/time evidence gives an explicitly unconfirmed match and one order amount',()=>{
  const r=match();assert.equal(r.summary.suggested,1);assert.equal(r.rows[0].candidates[0].level,'strong');assert.equal(r.rows[0].candidates[0].confirmed,false);assert.equal(r.summary.suggestedPaid,3000);assert.equal(r.byItem[0].amount,10000);
  const serialized=JSON.stringify(r);assert.ok(!serialized.includes(key));assert.ok(!serialized.includes('luna@example.invalid'));assert.ok(!serialized.includes('79990000001'));assert.ok(!serialized.includes('phones'));
});
test('Prepared dialogue dates keep the Moscow day boundary and candidate evidence unchanged',()=>{
  const c=chat({createdAt:'2026-09-08T21:01:00Z',signals:messageSignals([inquiryMessage({createdAt:'2026-09-08T21:02:00Z'})],key)});
  const r=match([order({createdDate:'2026-09-09'})],[c]);assert.equal(r.rows[0].candidates[0].anchorDate,'2026-09-09');assert.ok(r.rows[0].candidates[0].reasons.some(e=>e.code==='before_order'&&e.label.includes('один день')));assert.equal(r.summary.suggested,1);
});
test('Equal plausible dialogs remain ambiguous and excluded from money',()=>{
  const r=match([order()],[chat(),chat({id:'second'})]);assert.equal(r.rows[0].ambiguous,true);assert.equal(r.rows[0].suggestedChatId,null);assert.equal(r.summary.suggestedAmount,0);assert.equal(r.rows[0].candidates.length,2);
});
test('Repeat orders count separately once, cancellations never enter money, invalid IDs stop matching',()=>{
  const r=match([order(),order({id:'9002'}),order({id:'9003',status:'Отменён'})]);assert.equal(r.summary.suggested,2);assert.equal(r.summary.suggestedAmount,20000);assert.equal(r.summary.cancelled,1);assert.equal(r.byItem[0].orders,2);
  assert.throws(()=>match([order(),order()]));assert.equal(match([order({amount:null})]).summary.suggestedAmount,null);
  assert.equal(match([order({amount:Number.MAX_SAFE_INTEGER/100}),order({id:'9002',amount:1})]).summary.suggestedAmount,null);
});
test('Weak name/topic/time proposals require permissive mode; bare channel and time do not match',()=>{
  const c=chat({users:[{id:'2345',name:'Другой'}],signals:messageSignals([inquiryMessage({text:'вывеска'})],key),itemTitle:'Вывеска'});
  const o=order({title:'Вывеска',client:'Николай',contacts:[{source:'Авито'}]});assert.equal(match([o],[c]).summary.suggested,1);assert.equal(match([o],[c],{mode:'possible'}).summary.suggested,0);
  assert.equal(match([order({title:'Расчёт',contacts:[{source:'Авито'}],client:'Николай'})],[c]).summary.withCandidates,0);
});
test('Permissive mode admits explicitly weak name/time or work/time hypotheses, while stronger modes exclude them',()=>{
 const o=order({client:'Николай',title:'Расчёт',contacts:[]});const c=chat({users:[{id:'2345',name:'Николай'}],itemTitle:'Другая тема',signals:messageSignals([inquiryMessage({text:'Здравствуйте'})],key)});
 const r=match([o],[c]);assert.equal(r.summary.withCandidates,1);assert.equal(r.rows[0].candidates[0].level,'weak');assert.equal(match([o],[c],{mode:'possible'}).summary.suggested,0);
 const p=match([order({client:'Другой клиент',title:'Баннер',contacts:[]})],[chat({users:[],itemTitle:'Баннер',signals:null})]);assert.equal(p.rows[0].candidates[0].level,'weak');assert.equal(p.rows[0].candidates[0].messagesMissing,true);
});
test('Outside time window is rejected; after-order messages do not claim acquisition; explicit number survives missing date anchors',()=>{
  const old=chat({createdAt:'2025-01-01T00:00:00Z',signals:messageSignals([inquiryMessage({createdAt:'2025-01-01T00:00:00Z'})],key)});assert.equal(match([order()],[old]).summary.withCandidates,0);
  const after=chat({createdAt:'2026-09-08T00:00:00Z',signals:messageSignals([inquiryMessage({createdAt:'2026-09-08T00:00:00Z'})],key)});assert.equal(match([order()],[after]).rows[0].candidates[0].afterOrder,true);assert.equal(match([order()],[after]).rows[0].candidates[0].level,'possible');
  old.signals=messageSignals([inquiryMessage({text:'Заказ №9001',direction:'out'})],key);assert.equal(match([order()],[old]).summary.suggested,1);
  assert.ok(match([order({contacts:[{email:'luna@example.invalid',source:'Яндекс'}]})]).rows[0].candidates[0].reasons.some(r=>r.code==='source_conflict'));
});
test('Durable imports reuse unchanged messages, recover running steps, preserve hashed audit snapshots and account isolation',async()=>{
  const d=createDirectory('inquiries-unit-'),f=inquiryFixture(d);
  try{
    const job=f.importer.start();assert.equal(f.importer.start().jobId,job.jobId);await f.importer.work();
    f.importer.db().prepare("UPDATE inquiry_steps SET state='running' WHERE kind='messages'").run();
    const restarted=new InquiryImport({base:f.base,client:f.client,now:f.now,scheduler:false,automatic:false});await restarted.work();await restarted.work();await restarted.close();
    assert.equal(f.calls(),1);assert.equal(f.importer.view().jobs[0].state,'done');const raw=f.importer.db().prepare('SELECT payload FROM inquiry_snapshots').all().map(r=>r.payload).join('');assert.ok(!raw.includes('example.invalid'));assert.ok(!raw.includes('000-00-01'));
    f.advance(65000);f.importer.start();await f.drain();assert.equal(f.calls(),1);
    f.advance(65000);f.change();f.importer.start();await f.drain();assert.equal(f.calls(),2);
    const original=f.base.namespace.bind(f.base);f.base.namespace=()=> '5555';assert.equal(f.importer.view().chats.length,0);assert.notEqual(f.importer.secret(),(()=>{f.base.namespace=original;return f.importer.secret();})());
  }finally{await f.close();removeDirectory(d);}
});
test('Rate limits retain durable work until exact retry time and service rejects invalid scopes without reading Google',async()=>{
  const d=createDirectory('inquiries-retry-'),f=inquiryFixture(d);
  try{
    f.setFailure(new AvitoError('rate_limit',429,120));f.importer.start();await f.importer.work();await f.importer.work();assert.equal(f.calls(),1);f.advance(119000);await f.importer.work();assert.equal(f.calls(),1);f.advance(1000);f.setFailure(null);await f.drain();assert.equal(f.calls(),2);
    let reads=0;const service=new InquiryService({importer:f.importer,readOrders:async()=>{reads++;return{orders:[order()]};},now:f.now});
    await assert.rejects(service.view(new URLSearchParams('mode=bad')));await assert.rejects(service.view(new URLSearchParams('window=14&window=30')));assert.equal(reads,0);
    const r=await service.view(new URLSearchParams(period));assert.equal(r.source.chats,undefined);assert.equal(r.coverage.loadedDialogs,1);assert.equal(reads,1);await service.view(new URLSearchParams(period));assert.equal(reads,1);
  }finally{await f.close();removeDirectory(d);}
});
