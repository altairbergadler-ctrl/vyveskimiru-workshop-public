import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { AutoServices, serviceCandidates, validateServices, adServiceCandidates } from './analytics/auto-services.mjs';
import { LiveAnalytics, orderService } from './analytics/live.mjs';
import { analyticsCatalog } from './analytics/categories.mjs';
import { CommandQueue } from './command-queue.mjs';

function fixture(t) {
  const db=new Database(':memory:'),queue=new CommandQueue();
  const board={statuses:[],orders:[{id:'1',client:'Учебный клиент',title:'Баннер ТЕСТ',status:'Сдан',items:[],contacts:[{source:'Авито'}]}]};
  const catalog={source:'production-routes',products:[{id:'banner',name:'Печать баннера'},{id:'letters',name:'Световые буквы'}],positions:[]};
  const base={storage:()=>db,namespace:()=>'test'};
  const live=new LiveAnalytics({base,readProducts:async()=>catalog,readOrders:async()=>board});
  const readInputs=async()=>({board,catalog,mappings:live.mappings(),links:[]});
  let calls=0;
  const options={base,readInputs,queue:action=>queue.run(action),save:input=>live.save(input),enabled:true,settings:()=>({codexEnabled:true,codexTokenFile:'fictional'}),now:()=>Date.parse('2026-09-26T15:00:00Z'),
    ask:async(_,input)=>{calls++;assert.equal(input.task,'analytics-service');assert.equal(input.search,false);return {answer:JSON.stringify({assignments:input.context.orders.map(o=>({orderId:o.id,productId:'banner',reason:'product'}))})};}};
  const worker=new AutoServices(options);
  t.after(async()=>{await worker.close();db.close();});
  return {db,board,catalog,live,worker,options,readInputs,calls:()=>calls};
}
test('service backfill uses the existing link operation once, preserves money and does not alter client',async t=>{
  const f=fixture(t),original=JSON.stringify(f.board);
  await Promise.all([f.worker.bootstrap(),f.worker.bootstrap()]);
  assert.equal(f.calls(),1);assert.equal(f.live.mappings()[0].productId,'banner');
  assert.equal(f.worker.view().assignments[0].revision,1);
  await f.worker.run('2026-09-27');assert.equal(f.calls(),1);
  assert.equal(JSON.stringify(f.board),original);assert.equal(f.db.prepare('SELECT count(*) n FROM analytics_service_link_history').get().n,1);
});
test('explicit manual clearing, chosen service and production positions are never overwritten',async t=>{
  const f=fixture(t);
  await f.live.save({kind:'order',entityId:'1',productId:null,expectedRevision:0});
  await f.worker.bootstrap();assert.equal(f.calls(),0);
  f.board.orders.push({...f.board.orders[0],id:'2',items:[{row:7,name:'Буквы'}]});
  f.catalog.positions.push({sourcePosition:'position:2:7',productId:'letters'});
  await f.worker.run('2026-09-27');assert.equal(f.calls(),0);
  assert.equal(f.live.mappings()[0].productId,null);
});
test('changed order or manual choice during model call wins over automatic result',async t=>{
  const f=fixture(t);
  f.worker.ask=async()=>{f.board.orders[0].title='Другой заказ';return {answer:'{"assignments":[{"orderId":"1","productId":"banner","reason":"product"}]}'};};
  await f.worker.bootstrap();assert.equal(f.live.mappings().length,0);assert.equal(f.worker.view().run.stats.skipped,1);
  f.worker.ask=async()=>{await f.live.save({kind:'order',entityId:'1',productId:'letters',expectedRevision:0});return {answer:'{"assignments":[{"orderId":"1","productId":"banner","reason":"product"}]}'};};
  await f.worker.run('2026-09-27');assert.equal(f.live.mappings()[0].productId,'letters');assert.equal(f.worker.view().assignments.length,0);
});
test('model failures are not retried after restart; changed product description unlocks a new version',async t=>{
  const f=fixture(t);let calls=0;
  const ask=async()=>{calls++;throw new Error('uncertain');};
  f.worker.ask=ask;await f.worker.bootstrap();assert.equal(f.worker.view().run.stats.failed,1);
  const restarted=new AutoServices({...f.options,ask});t.after(()=>restarted.close());
  await restarted.bootstrap();await restarted.run('2026-09-27');assert.equal(calls,1);
  f.board.orders[0].items=[{row:3,name:'Баннер',description:'Печать на баннерной ткани'}];
  await restarted.run('2026-09-28');assert.equal(calls,2);
});
test('unresolved results stay empty and are reconsidered only after meaningful changes',async t=>{
  const f=fixture(t);let calls=0;
  f.worker.ask=async()=>{calls++;return {answer:'{"assignments":[{"orderId":"1","productId":null,"reason":"insufficient"}]}'};};
  await f.worker.bootstrap();assert.equal(f.live.mappings().length,0);
  f.board.orders[0].amount=5000;
  await f.worker.run('2026-09-27');assert.equal(calls,1);
  f.catalog.products.push({id:'new',name:'Новая услуга'});
  await f.worker.run('2026-09-28');assert.equal(calls,2);
});
test('mixed production services are excluded; invented ids, duplicate or incomplete results cannot save links',async t=>{
  const f=fixture(t);
  const input=serviceCandidates(await f.readInputs());
  for(const assignments of [[],[{orderId:'unknown',productId:'banner',reason:'product'}],[{orderId:'1',productId:'fake',reason:'product'}],[{orderId:'1',productId:'banner',reason:'ambiguous'}]])
    assert.throws(()=>validateServices(JSON.stringify({assignments}),input.orders,input.products));
  f.board.orders[0].items=[{row:2},{row:3}];f.catalog.positions=[{sourcePosition:'position:1:2',productId:'banner'},{sourcePosition:'position:1:3',productId:'letters'}];
  await f.worker.bootstrap();assert.equal(f.calls(),0);assert.equal(f.worker.view().run.stats.unresolved,1);assert.equal(f.live.mappings().length,0);
});
test('daily limit leaves unprocessed orders for next night; batches amortize model cost',async t=>{
  const f=fixture(t);f.board.orders=Array.from({length:41},(_,i)=>({...f.board.orders[0],id:String(i+1)}));
  await f.worker.bootstrap();assert.equal(f.calls(),4);assert.equal(f.worker.view().run.stats.deferred,1);assert.equal(f.live.mappings().length,40);
  await f.worker.run('2026-09-27');assert.equal(f.calls(),5);assert.equal(f.live.mappings().length,41);
});

function adsFixture(t) {
  const f=fixture(t),ads=[{id:'1',title:'Баннер, наклейки, штендер',category:'Услуги',inInventory:true}];
  const catalog=analyticsCatalog(f.catalog);f.live.readProducts=async()=>catalog;
  f.options.base.currentPeriod=()=>({});f.live.deep={view:()=>({rows:ads})};
  let calls=0;
  const options={...f.options,kind:'ad',readInputs:async()=>({ads,catalog,mappings:f.live.mappings()}),ask:async(_,input)=>{
    calls++;assert.equal(input.task,'analytics-ad-service');assert(input.context.ads);assert.equal(input.context.orders,undefined);
    return {answer:JSON.stringify({assignments:input.context.ads.map(a=>({adId:a.id,productId:'category:print',reason:'product'}))})};}};
  const worker=new AutoServices(options);t.after(()=>worker.close());
  return {...f,ads,catalog,adWorker:worker,adOptions:options,adCalls:()=>calls};
}
test('ad and order receipts cannot collide; category saves use actual ad links and preserve financial data',async t=>{
  const f=adsFixture(t);await f.worker.bootstrap();await f.adWorker.bootstrap();
  assert.equal(f.adCalls(),1);assert.equal(f.adWorker.view().assignments[0].adId,'1');
  assert.equal(f.live.mappings().find(m=>m.kind==='ad').productId,'category:print');
  assert.equal(f.live.mappings().find(m=>m.kind==='order').productId,'banner');
  await f.adWorker.run('2026-09-27');assert.equal(f.adCalls(),1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM service_auto_runs').get().n,1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM ad_service_auto_runs').get().n,2);
});
test('ad price/stats changes do not spend tokens; changed title does; manual clearing wins',async t=>{
  const f=adsFixture(t);let calls=0;
  f.adWorker.ask=async()=>{calls++;return {answer:'{"assignments":[{"adId":"1","productId":null,"reason":"insufficient"}]}'};};
  await f.adWorker.bootstrap();f.ads[0].price=4000;f.ads[0].metrics={spending:100};
  await f.adWorker.run('2026-09-27');assert.equal(calls,1);
  f.ads[0].title='Неоновая вывеска';await f.adWorker.run('2026-09-28');assert.equal(calls,2);
  assert.equal(f.adWorker.view().unresolved[0].reason,'insufficient');
  f.ads[0].title='Печать баннера';f.adWorker.ask=async()=>{
    await f.live.save({kind:'ad',entityId:'1',productId:null,expectedRevision:0});
    return {answer:'{"assignments":[{"adId":"1","productId":"category:print","reason":"product"}]}'};
  };
  await f.adWorker.run('2026-09-29');assert.equal(f.live.mappings()[0].productId,null);assert.equal(f.adWorker.view().assignments.length,0);
});
test('ad IDs and result schema are validated independently of order IDs',()=>{
  const catalog=analyticsCatalog(null),input=adServiceCandidates({ads:[{id:'ad1',title:'Баннер'}],catalog,mappings:[]});
  assert.throws(()=>validateServices('{"assignments":[{"orderId":"ad1","productId":"category:print","reason":"product"}]}',input.orders,input.products,'adId'));
  assert.throws(()=>validateServices('{"assignments":[{"adId":"unknown","productId":"category:print","reason":"product"}]}',input.orders,input.products,'adId'));
  assert.equal(validateServices('{"assignments":[{"adId":"ad1","productId":"category:print","reason":"product"}]}',input.orders,input.products,'adId')[0].productId,'category:print');
});
test('shared categories collapse known route names without deleting manual mappings or production positions',()=>{
  const production={products:[{id:'old1',name:'Уличная вывеска'},{id:'old2',name:'Уличная вывеска'},{id:'old3',name:'Неоновая вывеска'}],positions:[{sourcePosition:'position:1:2',productId:'old1'},{sourcePosition:'position:1:3',productId:'old2'}]};
  const before=JSON.stringify(production),catalog=analyticsCatalog(production);
  assert.equal(catalog.products.length,9);assert.equal(new Set(catalog.products.map(p=>p.name)).size,9);
  assert.equal(orderService({id:'1',items:[{row:2},{row:3}]},catalog,[]),'category:signs');
  const mappings=[{kind:'order',entityId:'1',productId:'old3',revision:2}];
  assert.equal(orderService({id:'1',items:[]},catalog,mappings),'category:neon');
  assert.equal(mappings[0].productId,'old3');assert.equal(JSON.stringify(production),before);
  production.products.push({id:'rack',name:'Стеллаж'});
  assert.equal(analyticsCatalog(production,[]).products.length,9);
  assert(analyticsCatalog(production,[{productId:'rack'}]).products.some(p=>p.id==='rack'&&p.automatic===false));
});
test('approved category setup reconsiders unresolved orders once with changed catalog, keeps earlier receipts',async t=>{
  const f=fixture(t);f.worker.ask=async()=>({answer:'{"assignments":[{"orderId":"1","productId":null,"reason":"no_match"}]}'});
  await f.worker.bootstrap();
  const catalog=analyticsCatalog(f.catalog);f.live.readProducts=async()=>catalog;let calls=0;
  const worker=new AutoServices({...f.options,bootstrapKey:'categories-v1',readInputs:async()=>({...await f.readInputs(),catalog}),ask:async()=>{calls++;return {answer:'{"assignments":[{"orderId":"1","productId":"category:print","reason":"product"}]}'};}});t.after(()=>worker.close());
  await worker.bootstrap();await worker.bootstrap();assert.equal(calls,1);assert.equal(worker.view().run.day,'2026-09-26');
  assert.equal(f.db.prepare('SELECT count(*) n FROM service_auto_runs').get().n,2);
  assert.equal(f.db.prepare('SELECT count(*) n FROM service_auto_versions').get().n,2);
  assert.equal(f.live.mappings()[0].productId,'category:print');
});
