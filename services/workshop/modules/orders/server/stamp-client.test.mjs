import test from 'node:test';
import assert from 'node:assert/strict';
import { StampClient } from './stamp-client.mjs';
const cookie='unrelated=private; finance_session='+'x'.repeat(43)+'; other=private';
const id='00000000-0000-4000-8000-000000000001';
const code=value=>error=>error.code===value;
test('owner auth, fixed host, CSRF, multipart body and redirect refusal survive bridge start',async()=>{
  const calls=[];const client=new StampClient({fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('/api/me')?{auth_mode:'workshop',csrf:'a'.repeat(64)}:{state:'processing'});}});
  assert.equal((await client.start(id,{fictional:true},Buffer.from('%PDF-1.4\n%%EOF'),cookie)).state,'processing');assert.equal(calls.length,2);
  for(const {url,options} of calls){assert.ok(url.startsWith('http://workshop-stamp:8080/'));assert.equal(options.redirect,'error');assert.equal(options.headers.Cookie,'finance_session='+'x'.repeat(43));assert.equal(Object.hasOwn(options.headers,'Host'),false);assert.equal(options.headers.Origin,new URL(url).origin);}
  assert.equal(calls[1].options.headers['X-CSRF-Token'],'a'.repeat(64));assert.equal(calls[1].options.body.get('spec'),JSON.stringify({fictional:true}));
  assert.throws(()=>new StampClient({base:'http://external.invalid/'}));
  await assert.rejects(client.operation(id,'other=private'),code('DOCUMENT_STAMP_SESSION'));
});

test('missing bridge, remote errors, invalid JSON and oversized JSON produce bounded safe errors',async()=>{
  const setup=new StampClient({fetchImpl:async()=>new Response(null,{status:404})});assert.equal(await setup.operation(id,cookie),null);await assert.rejects(setup.library(cookie),code('DOCUMENT_STAMP_SETUP'));
  const unavailable=new StampClient({fetchImpl:async()=>{throw new Error('private host diagnostic');}});await assert.rejects(unavailable.operation(id,cookie),error=>error.code==='DOCUMENT_STAMP_UNAVAILABLE'&&!error.message.includes('private'));
  const malformed=new StampClient({fetchImpl:async()=>new Response('not JSON')});await assert.rejects(malformed.operation(id,cookie),code('DOCUMENT_STAMP_RESPONSE'));
  const large=new StampClient({fetchImpl:async()=>new Response('x'.repeat(129*1024))});await assert.rejects(large.operation(id,cookie),code('DOCUMENT_STAMP_RESPONSE'));
  const native=new StampClient({fetchImpl:async()=>Response.json({auth_mode:'native',csrf:'a'.repeat(64)})});await assert.rejects(native.start(id,{},Buffer.from('%PDF'),cookie),code('DOCUMENT_STAMP_SESSION'));
});

test('PDF download enforces media type, declared and streamed size without leaking partial bytes',async()=>{
  const client=response=>new StampClient({fetchImpl:async()=>response});const args=['1'.repeat(32),'2'.repeat(32),4,cookie];
  assert.deepEqual(await client(new Response('PDF!',{headers:{'Content-Type':'application/pdf','Content-Length':'4'}})).artifact(...args),Buffer.from('PDF!'));
  await assert.rejects(client(new Response('PDF!',{headers:{'Content-Type':'text/html'}})).artifact(...args),code('DOCUMENT_STAMP_RESPONSE'));
  await assert.rejects(client(new Response('PDF!',{headers:{'Content-Type':'application/pdf','Content-Length':'5'}})).artifact(...args),code('DOCUMENT_STAMP_RESPONSE'));
  await assert.rejects(client(new Response('TOO LONG',{headers:{'Content-Type':'application/pdf'}})).artifact(...args),code('DOCUMENT_STAMP_SIZE'));
  await assert.rejects(client(new Response('PDF',{headers:{'Content-Type':'application/pdf'}})).artifact(...args),code('DOCUMENT_STAMP_RESPONSE'));
});
