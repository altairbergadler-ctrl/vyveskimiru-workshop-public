import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { AvitoError } from './avito.mjs';
import { ResponseTimes, responseSlots, firstResponse, aggregateResponses } from './analytics/response-times.mjs';

const stamp = time => Date.parse(time);
const message = (id, direction, createdAt, type = 'text') => ({ id, direction, createdAt, type, text: 'PRIVATE TEXT MUST NOT BE STORED' });
const incoming = message('i', 'in', '2026-09-30T20:59:00.000Z');
const outgoing = message('o', 'out', '2026-10-01T06:15:00.000Z');
const chat = { id: 'chat', itemId: 'ad', updatedAt: outgoing.createdAt, lastMessageId: 'o' };
const period = { from: '2026-09-01', to: '2026-10-31' };

test('09:00 and 18:00 Moscow: exact boundaries, overnight and missed-slot catchup', () => {
  for (const [now, due, next] of [
    ['2026-10-01T05:59:59Z','2026-09-30T15:00:00Z','2026-10-01T06:00:00Z'],
    ['2026-10-01T06:00:00Z','2026-10-01T06:00:00Z','2026-10-01T15:00:00Z'],
    ['2026-10-01T15:00:00Z','2026-10-01T15:00:00Z','2026-10-02T06:00:00Z'],
    ['2026-12-31T22:00:00Z','2026-12-31T15:00:00Z','2027-01-01T06:00:00Z'],
  ]) assert.deepEqual(responseSlots(stamp(now)), { due: stamp(due), next: stamp(next) });
});
test('first response uses first incoming once, includes overnight, ignores system/call and early outgoing', () => {
  const first = firstResponse([outgoing, incoming, incoming,
    message('system','out','2026-09-30T21:00:00.000Z','system'),
    message('call','out','2026-09-30T21:01:00.000Z','call'),
    message('before','out','2026-09-29T20:00:00.000Z'),
    message('again','in','2026-10-01T06:14:00.000Z'),
  ], true);
  assert.equal(first.seconds, 33360);
  assert.equal(first.firstIn, incoming.createdAt);
  assert.equal(first.state, 'answered');
  assert.equal(firstResponse([incoming],true).state,'waiting');
  assert.equal(firstResponse([outgoing],true).state,'no_incoming');
  assert.equal(firstResponse([incoming,outgoing],false).seconds,null);
  assert.equal(firstResponse([incoming,message('zero','out',incoming.createdAt)],true).seconds,0);
});
test('cohort uses Moscow first incoming day; unknown and waiting never become zero-second replies', () => {
  const rows = [
    { item_id:'a',first_in:'2026-09-30T21:30:00Z',state:'answered',seconds:60 },
    { item_id:'a',first_in:'2026-10-01T10:00:00Z',state:'answered',seconds:180 },
    { item_id:'a',first_in:'2026-10-01T11:00:00Z',state:'waiting',seconds:null },
    { item_id:'b',first_in:null,state:'unknown',seconds:null },
    { item_id:'a',first_in:'2026-09-29T10:00:00Z',state:'answered',seconds:900 },
  ];
  const report = aggregateResponses(rows,{from:'2026-10-01',to:'2026-10-01'});
  assert.equal(report.summary.averageSeconds,120);
  assert.equal(report.summary.waiting,1);
  assert.equal(report.items.b.averageSeconds,null);
  assert.equal(report.items.b.unknown,1);
  assert.equal(report.daily['2026-10-01'].answered,2);
  assert.equal(report.undated,1);
});
function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  let now = stamp('2026-10-01T06:00:00Z');
  const calls = [];
  const client = {
    conversations: async p => { calls.push(['chats',p.offset]); return { accountId:'123',chats:[chat],hasMore:false }; },
    conversationMessages: async p => { calls.push(['messages',p.offset]); return { messages:[incoming,outgoing],hasMore:false }; },
  };
  const base = { storage:()=>db,namespace:()=> '123' };
  const create = () => new ResponseTimes({base,client,enabled:true,now:()=>now});
  const service = create();
  return { db,client,service,create,calls,advance:ms=>now+=ms };
}
async function drain(service, count = 5) { for(let n=0;n<count;n++) await service.work(); }
test('background observer yields while nightly attribution is active', async t => {
  const f=fixture(t);
  f.service.canRun=()=>false;
  await f.service.work();
  assert.deepEqual(f.calls,[]);
  f.service.canRun=()=>true;
  await drain(f.service);
  assert.equal(f.service.view(period).state,'done');
});
test('runs once per slot, resumes on restart, skips unchanged, reads new and newly answered chats', async t => {
  const f = fixture(t);
  await f.service.work(); // Persist discovery, simulate restart.
  const resumed = f.create();
  await drain(resumed);
  assert.deepEqual(f.calls,[['chats',0],['messages',0]]);
  assert.equal(resumed.view(period).summary.averageSeconds,33360);
  assert.equal(resumed.view(period).state,'done');
  assert.equal(f.db.prepare('SELECT count(*) n FROM response_runs').get().n,1);
  f.advance(9*3600000);
  f.client.conversations = async () => ({accountId:'123',chats:[chat,{...chat,id:'new',lastMessageId:'i'}],hasMore:false});
  f.client.conversationMessages = async p => { f.calls.push(['messages',p.chatId]);return {messages:[incoming],hasMore:false}; };
  await drain(resumed);
  assert.equal(resumed.view(period).summary.waiting,1);
  assert.deepEqual(f.calls.at(-1),['messages','new']);
  assert.equal(f.db.prepare('SELECT count(*) n FROM response_runs').get().n,2);
  f.advance(15*3600000);
  f.client.conversations = async () => ({accountId:'123',chats:[chat,{...chat,id:'new'}],hasMore:false});
  f.client.conversationMessages = async () => ({messages:[incoming,outgoing],hasMore:false});
  await drain(resumed);
  assert.equal(resumed.view(period).summary.waiting,0);
  assert.equal(resumed.view(period).summary.answered,2);
  assert.equal(resumed.view(period).summary.averageSeconds,33360);
  assert(!JSON.stringify(f.db.prepare('SELECT * FROM response_jobs').all()).includes('PRIVATE'));
});
test('shared 429 cooldown, pagination restart and dedup; no raw text in persisted buffers', async t => {
  const f = fixture(t);
  await f.service.work();
  let limited = true;
  f.client.conversationMessages = async ({offset}) => {
    if(limited) {limited=false;throw new AvitoError('rate_limit',429,65);}
    return offset===0 ? {messages:[outgoing],hasMore:true} : {messages:[outgoing,incoming],hasMore:false};
  };
  await f.service.work();
  await f.service.work();
  assert.equal(f.db.prepare('SELECT offset FROM response_jobs').get().offset,0);
  f.advance(65000);
  await f.service.work();
  assert(!f.db.prepare('SELECT messages FROM response_jobs').get().messages.includes('PRIVATE'));
  const restarted = f.create();
  await drain(restarted);
  assert.equal(restarted.view(period).summary.answered,1);
});
test('index and message caps explicitly yield incomplete coverage, never a false first reply', async t => {
  const f = fixture(t);
  f.client.conversations = async () => ({accountId:'123',chats:[chat],hasMore:true});
  f.client.conversationMessages = async () => ({messages:[incoming,outgoing],hasMore:true});
  await drain(f.service,25);
  const view=f.service.view(period);
  assert.equal(view.state,'partial');
  assert.equal(view.indexLimited,true);
  assert.equal(view.summary.averageSeconds,null);
  assert.equal(view.undated,1);
});
test('permission failure is bounded and preserves old data with a partial warning; wrong account rejected', async t => {
  const f = fixture(t);
  await drain(f.service);
  f.advance(9*3600000);
  f.client.conversations = async () => {throw new AvitoError('forbidden',403);};
  await drain(f.service);
  assert.equal(f.service.view(period).state,'failed');
  assert.equal(f.service.view(period).partial,true);
  assert.equal(f.service.view(period).summary.averageSeconds,33360);
  f.advance(15*3600000);
  f.client.conversations = async () => ({accountId:'foreign',chats:[],hasMore:false});
  await drain(f.service);
  assert.equal(f.service.view(period).code,'account_mismatch');
});
