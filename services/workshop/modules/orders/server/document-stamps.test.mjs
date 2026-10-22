import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DocumentStamps } from './document-stamps.mjs';
import { MediaStore } from './media.mjs';
import { encodeDocumentSeller, decodeDocumentSellers } from './documents.mjs';
import { normalizeDocumentStampProfile, stampPlacement } from './document-stamp-profile.mjs';

// Every identity and PDF in these tests is fictional. No network or real images.
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const uuid=()=>crypto.randomUUID();
const code=value=>error=>error.code===value;
const pdf=label=>Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Test (${label}) >>\nendobj\n%%EOF\n`);
const layout={version:1,unit:'pt',origin:'top-left',pages:[{index:0,width:600,height:850}],anchors:{sellerStamp:{page:0,x:440,y:600,width:124,height:124},sellerSignature:{page:0,x:200,y:640,width:200,height:48}}};
async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'fictional-order-stamps-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const mediaStore=new MediaStore({directory:path.join(directory,'media')});await mediaStore.init();
  const documentId=uuid(),orderId='TEST-9001',operationId=uuid();
  const stamp={id:'a'.repeat(32),sha256:'b'.repeat(64),revision:'c'.repeat(64),widthMm:35.6,aspect:1,companyInn:'9900990014'};
  const signature={id:'d'.repeat(32),sha256:'e'.repeat(64),revision:'f'.repeat(64),widthMm:50,aspect:.3,signer:'Учебная подпись'};
  const binding={version:1,stamp:{id:stamp.id,sha256:stamp.sha256,revision:stamp.revision},signature:{id:signature.id,sha256:signature.sha256,revision:signature.revision},profile:'standard',dpi:150};
  const seller={id:uuid(),label:'Учебный продавец',name:'Учебный продавец',inn:stamp.companyInn,kpp:'990001001',ogrn:'',address:'Учебный адрес',signer:'Учебный подписант',signerRole:'Директор',vat:'none',active:true,source:{documentStamps:binding},accounts:[]};
  const encoded=encodeDocumentSeller(seller);const snapshot=JSON.stringify({seller}),snapshotHash=sha(snapshot),bytes=pdf('original');
  const original=await mediaStore.addGenerated(orderId,{name:'Учебный.pdf',bytes,documentLayout:{...layout,pdfSha256:sha(bytes)},generatedDocument:{documentId,type:'invoice',number:'TEST-1',version:1,requestId:uuid(),snapshotHash,test:true}});
  const row=Array(18).fill('');Object.assign(row,{0:documentId,1:orderId,2:'invoice',3:'TEST-1',5:seller.id,7:1,8:'confirmed',9:snapshot,10:snapshotHash,11:original.id,12:original.contentHash,16:true});
  const tables={'Продавцы':{rows:[{values:encoded.seller}]},'Счета продавцов':{rows:[]},'Документы заказов':{rows:[{values:row}]}};
  const library={version:1,stamps:[stamp],signatures:[signature]};let remote=null,starts=0,downloads=0;
  const artifactBytes={stamped:pdf('stamped'),scan:pdf('scan')};
  const engine={library:async()=>structuredClone(library),operation:async()=>structuredClone(remote),start:async(id,spec,source)=>{
    starts++;assert.equal(sha(source),spec.sourceSha256);
    remote={state:'completed',operationId:id,jobId:'1'.repeat(32),requestHash:'2'.repeat(64),sourceSha256:sha(source),spec:structuredClone(spec),artifacts:['stamped','scan'].map((kind,index)=>({kind,id:String(index+3).repeat(32),sha256:sha(artifactBytes[kind]),size:artifactBytes[kind].length,url:'ignored'}))};return structuredClone(remote);
  },artifact:async(job,id)=>{downloads++;assert.equal(job,remote.jobId);const artifact=remote.artifacts.find(value=>value.id===id);return Buffer.from(artifactBytes[artifact.kind]);}};
  const make=()=>new DocumentStamps({documents:{load:async()=>tables},mediaStore,directory:path.join(directory,'receipts'),stampClient:engine});
  const input=()=>({requestId:operationId,expectedSellerRevision:decodeDocumentSellers(tables)[0].revision});
  return {make,service:make(),mediaStore,library,input,operationId,orderId,documentId,tables,row,original,binding,engine,artifactBytes,stats:()=>({starts,downloads}),remote:()=>remote};
}
const reserve=f=>f.service.reserve(f.orderId,f.documentId,f.input(),f.library);
const start=f=>f.service.start(f.orderId,f.documentId,f.operationId,'cookie');
const publish=async f=>f.service.publish(f.orderId,f.documentId,await f.service.download(f.orderId,f.documentId,f.operationId,'cookie'));

test('explicit profile validates IDs, supports one asset and fits actual proportions inside authoritative anchors',()=>{
  assert.equal(normalizeDocumentStampProfile(null),null);
  const selected={id:'a'.repeat(32),sha256:'b'.repeat(64),revision:'c'.repeat(64)};
  assert.deepEqual(normalizeDocumentStampProfile({version:1,stamp:selected,signature:null}),{version:1,stamp:selected,signature:null,profile:'standard',dpi:150});
  assert.throws(()=>normalizeDocumentStampProfile({version:1,stamp:selected,dpi:300}),code('DOCUMENT_STAMP_PROFILE_INVALID'));
  assert.throws(()=>normalizeDocumentStampProfile({version:1,stamp:{...selected,active:true}}),code('DOCUMENT_STAMP_PROFILE_INVALID'));
  const box=stampPlacement(layout,{widthMm:50,aspect:.3},'signature');assert.ok(box.x>=200&&box.y>=640&&box.width<=200&&box.height<=48);assert.ok(Math.abs(box.height/box.width-.3)<.001);
  assert.throws(()=>stampPlacement(undefined,{widthMm:30,aspect:1},'stamp'),code('DOCUMENT_STAMP_LAYOUT_MISSING'));
  assert.throws(()=>stampPlacement(layout,{widthMm:30,aspect:20},'stamp'),code('DOCUMENT_STAMP_PROFILE_INVALID'));
});

test('real raw PDF hashes survive reserve, remote proof and three durable Files entries without mutating original',async t=>{
  const f=await fixture(t);const reserved=await reserve(f);assert.equal(reserved.spec.sourceSha256,f.original.contentHash);assert.equal(reserved.spec.placement.page,0);
  await start(f);const result=await publish(f);assert.equal(result.state,'confirmed');assert.equal(result.media.items.length,3);
  const original=result.media.items.find(value=>value.id===f.original.id);assert.deepEqual(original,f.original);
  for(const kind of ['stamped','scan']){const file=result.media.items.find(value=>value.generatedDocument.decoration?.kind===kind);assert.equal(file.generatedDocument.decoration.parentDocumentId,f.documentId);assert.equal(file.contentHash,sha(f.artifactBytes[kind]));}
  f.service=f.make();assert.equal((await start(f)).state,'completed');assert.deepEqual(await publish(f),result);assert.deepEqual(f.stats(),{starts:1,downloads:2});
});

test('request IDs freeze profile and PDF; changed input conflicts while saved replay ignores later global settings',async t=>{
  const f=await fixture(t);const input=f.input();await reserve(f);
  f.tables['Продавцы'].rows[0].values[13]=JSON.stringify({documentStamps:null});
  assert.equal((await f.service.reserve(f.orderId,f.documentId,input,{stamps:[],signatures:[]})).state,'prepared');
  await assert.rejects(reserve(f),code('DOCUMENT_STAMP_REQUEST_CONFLICT'));
  await start(f);assert.ok(f.remote().spec.stamp);assert.ok(f.remote().spec.signature);
});

test('stale seller, changed library revision, foreign INN and historical missing layout stop before engine start',async t=>{
  for(const issue of ['seller','revision','inn','layout']) {
    const f=await fixture(t);const input=f.input();let expected;
    if(issue==='seller'){input.expectedSellerRevision='0'.repeat(64);expected='DOCUMENT_SELLER_CHANGED';}
    if(issue==='revision'){f.library.stamps[0].revision='0'.repeat(64);expected='DOCUMENT_STAMP_PROFILE_CHANGED';}
    if(issue==='inn'){f.library.stamps[0].companyInn='9900990022';expected='DOCUMENT_STAMP_WRONG_COMPANY';}
    if(issue==='layout'){delete f.mediaStore.state.records[0].documentLayout;expected='DOCUMENT_STAMP_LAYOUT_MISSING';}
    await assert.rejects(f.service.reserve(f.orderId,f.documentId,input,f.library),code(expected));assert.equal(f.stats().starts,0);
  }
});

test('partial Files import restarts with same derived IDs and never renders or duplicates the first PDF',async t=>{
  const f=await fixture(t);await reserve(f);await start(f);const prepared=await f.service.download(f.orderId,f.documentId,f.operationId,'cookie');
  const add=f.mediaStore.addGenerated.bind(f.mediaStore);let calls=0;f.mediaStore.addGenerated=async(...args)=>{if(++calls===2)throw new Error('synthetic interrupted write');return add(...args);};
  await assert.rejects(f.service.publish(f.orderId,f.documentId,prepared),/synthetic interrupted/);assert.equal((await f.mediaStore.list(f.orderId)).items.length,2);
  f.mediaStore.addGenerated=add;f.service=f.make();assert.equal((await f.service.status(f.orderId,f.documentId,f.operationId,'cookie')).state,'completed');
  const result=await publish(f);assert.equal(result.media.items.length,3);assert.equal(f.stats().starts,1);
});

test('deletion during a partial import terminates its receipt without restoring files or blocking future releases',async t=>{
  const f=await fixture(t);await reserve(f);await start(f);const prepared=await f.service.download(f.orderId,f.documentId,f.operationId,'cookie');
  const add=f.mediaStore.addGenerated.bind(f.mediaStore);let calls=0;f.mediaStore.addGenerated=async(...args)=>{if(++calls===2)throw new Error('synthetic interrupted write');return add(...args);};
  await assert.rejects(f.service.publish(f.orderId,f.documentId,prepared),/interrupted/);f.mediaStore.addGenerated=add;
  const output=(await f.mediaStore.list(f.orderId)).items.find(value=>value.generatedDocument.decoration);await f.mediaStore.remove(f.orderId,output.id);
  await assert.rejects(f.service.publish(f.orderId,f.documentId,prepared),code('DOCUMENT_MEDIA_DELETED'));
  const receipt=await f.service.receipt(f.operationId);assert.equal(receipt.value.state,'failed');assert.equal((await f.service.status(f.orderId,f.documentId,f.operationId,'cookie')).state,'failed');
  await assert.rejects(f.service.download(f.orderId,f.documentId,f.operationId,'cookie'),code('DOCUMENT_MEDIA_DELETED'));assert.equal((await f.mediaStore.list(f.orderId)).items.length,1);assert.equal(f.stats().starts,1);
});

test('deliberate deletion of original or output is a tombstone and replay never regenerates it',async t=>{
  const f=await fixture(t);await reserve(f);await start(f);const result=await publish(f);
  const output=result.media.items.find(value=>value.generatedDocument.decoration?.kind==='scan');await f.mediaStore.remove(f.orderId,output.id);
  await assert.rejects(publish(f),code('DOCUMENT_MEDIA_DELETED'));assert.equal((await f.mediaStore.list(f.orderId)).items.length,2);assert.equal(f.stats().starts,1);
  const g=await fixture(t);await reserve(g);await g.mediaStore.remove(g.orderId,g.original.id);await assert.rejects(start(g),code('MEDIA_NOT_FOUND'));assert.equal(g.stats().starts,0);
});

test('wrong echoed spec, changed result bytes and partial downloads cannot publish any derivative',async t=>{
  const f=await fixture(t);await reserve(f);await start(f);f.remote().spec.dpi=200;
  await assert.rejects(f.service.status(f.orderId,f.documentId,f.operationId,'cookie'),code('DOCUMENT_STAMP_RESPONSE'));
  f.remote().spec.dpi=150;f.artifactBytes.scan=pdf('altered scan');
  await assert.rejects(publish(f),code('DOCUMENT_STAMP_RESPONSE'));assert.equal((await f.mediaStore.list(f.orderId)).items.length,1);
});

test('uncertain remote acknowledgement recovers existing bytes with one engine invocation',async t=>{
  const f=await fixture(t);await reserve(f);const engineStart=f.engine.start;f.engine.start=async(...args)=>{await engineStart(...args);throw new Error('synthetic lost acknowledgement');};
  await assert.rejects(start(f),/lost acknowledgement/);f.service=f.make();await start(f);await publish(f);assert.equal(f.stats().starts,1);
});

test('durable reservation without a remote job reports prepared and safely retries the same UUID',async t=>{
  const f=await fixture(t);await reserve(f);const engineStart=f.engine.start;f.engine.start=async()=>{throw new Error('synthetic unavailable before POST');};
  await assert.rejects(start(f),/unavailable before POST/);f.service=f.make();
  assert.equal((await f.service.status(f.orderId,f.documentId,f.operationId,'cookie')).state,'prepared');
  f.engine.start=engineStart;await reserve(f);await start(f);await publish(f);assert.equal(f.stats().starts,1);
});

test('returned nested proof cannot mutate persisted MediaStore provenance',async t=>{
  const f=await fixture(t);await reserve(f);await start(f);const result=await publish(f);
  const derivative=result.media.items.find(value=>value.generatedDocument.decoration);derivative.generatedDocument.decoration.stamp.sha256='0'.repeat(64);
  const reread=(await f.mediaStore.list(f.orderId)).items.find(value=>value.id===derivative.id);assert.equal(reread.generatedDocument.decoration.stamp.sha256,f.binding.stamp.sha256);
});

test('concurrent starts, polls and imports serialize receipts while publishing exactly two derivatives',async t=>{
  const f=await fixture(t);await Promise.all([reserve(f),reserve(f)]);await Promise.all([start(f),start(f)]);
  const results=await Promise.all([publish(f),publish(f),f.service.status(f.orderId,f.documentId,f.operationId,'cookie')]);
  assert.equal(results[0].media.items.length,3);assert.equal(results[1].media.items.length,3);assert.equal(f.stats().starts,1);assert.equal((await f.mediaStore.list(f.orderId)).items.length,3);
});

test('owner route cannot inspect or publish another order operation',async t=>{
  const f=await fixture(t);await reserve(f);await assert.rejects(f.service.status('OTHER',f.documentId,f.operationId,'cookie'),code('DOCUMENT_STAMP_NOT_FOUND'));
  await assert.rejects(f.service.publish('OTHER',f.documentId,{operationId:f.operationId,files:[]}),code('DOCUMENT_STAMP_NOT_FOUND'));
});

test('a second slow network download cannot hold a ready Files publish in the shared writer',async t=>{
  const f=await fixture(t);await reserve(f);await start(f);const prepared=await f.service.download(f.orderId,f.documentId,f.operationId,'cookie');
  let release,started;const blocked=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});
  const artifact=f.engine.artifact;f.engine.artifact=async(...args)=>{started();await blocked;return artifact(...args);};
  const otherDownload=f.service.download(f.orderId,f.documentId,f.operationId,'cookie');await entered;
  let timer;
  try {
    const result=await Promise.race([f.service.publish(f.orderId,f.documentId,prepared),new Promise((resolve,reject)=>{void resolve;timer=setTimeout(()=>reject(new Error('publish waited for network lock')),2000);})]);
    assert.equal(result.media.items.length,3);
  }finally{clearTimeout(timer);release();await otherDownload;}
});

test('large base layout remains storable while the scan limit is checked separately',async t=>{
  const f=await fixture(t);const original=f.mediaStore.state.records[0];original.documentLayout.pages=Array.from({length:100},(_,index)=>({index,width:600,height:850}));
  const restarted=new MediaStore({directory:f.mediaStore.directory});await f.mediaStore.persist(f.mediaStore.state);await restarted.init();
  assert.equal((await restarted.list(f.orderId)).items[0].documentLayout.pages.length,100);
  await assert.rejects(reserve(f),code('DOCUMENT_STAMP_REJECTED'));assert.equal(f.stats().starts,0);
  assert.throws(()=>stampPlacement(layout,{widthMm:40,aspect:2.1873315888},'stamp'),code('DOCUMENT_STAMP_PROFILE_INVALID'));
});

test('new receipt directory is synced with its parent before any remote operation',async t=>{
  const f=await fixture(t);const visited=[];const sync=f.service.syncDirectory.bind(f.service);
  const parent=path.dirname(path.toNamespacedPath(f.service.directory));
  f.service.syncDirectory=async directory=>{visited.push(directory);if(directory===parent)throw new Error('synthetic parent sync failure');return sync(directory);};
  await assert.rejects(reserve(f),/parent sync failure/);assert.equal(f.stats().starts,0);assert.ok(visited.includes(parent));
  f.service.syncDirectory=sync;await reserve(f);await start(f);assert.equal(f.stats().starts,1);
});
