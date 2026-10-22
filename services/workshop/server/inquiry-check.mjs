// Read-only operator acceptance; output is counters only, never messages or contacts.
import crypto from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
let db,archive,hash;
try {
 if(process.argv.length!==2||!process.env.DATA_DIR)throw new Error();
 db=new Database(path.join(process.env.DATA_DIR,'finance.sqlite3'),{fileMustExist:true});const token=crypto.randomBytes(32).toString('base64url');hash=crypto.createHash('sha256').update(token).digest('hex');db.prepare('INSERT INTO sessions(token_hash,expires_at,created_at) VALUES(?,?,?)').run(hash,new Date(Date.now()+120000).toISOString(),new Date().toISOString());
 const base='http://127.0.0.1:'+Number(process.env.PORT||3000),headers={Cookie:'finance_session='+token};
 const response=await fetch(base+'/api/analytics/inquiries',{headers,signal:AbortSignal.timeout(90000)}),r=await response.json();assert.ok(response.ok&&r.source.enabled);
 assert.equal(new Set(r.rows.map(o=>o.id)).size,r.rows.length);assert.ok(r.rows.every(o=>o.candidates.every(c=>c.confirmed===false)));assert.equal(r.source.chats,undefined);
 const selected=r.rows.filter(o=>o.status!=='Отменён'&&o.suggestedChatId);assert.equal(selected.length,r.summary.suggested);assert.ok(selected.every(o=>!o.ambiguous));assert.equal(r.byItem.reduce((n,a)=>n+a.orders,0),selected.length);
 for(const metric of ['amount','paid','profit']){const sum=selected.some(o=>o[metric]==null)?null:selected.reduce((n,o)=>n+Math.round(o[metric]*100),0)/100;assert.equal(sum,r.summary['suggested'+metric[0].toUpperCase()+metric.slice(1)]);}
 archive=new Database(path.join(process.env.DATA_DIR,'analytics.sqlite3'),{readonly:true,fileMustExist:true});assert.equal(archive.pragma('integrity_check',{simple:true}),'ok');
 const snapshots=archive.prepare('SELECT hash,payload,kind FROM inquiry_snapshots WHERE account=?').all(process.env.AVITO_ACCOUNT_ID);assert.ok(snapshots.every(s=>s.hash===crypto.createHash('sha256').update(s.payload).digest('hex')));
 for(const s of snapshots.filter(s=>s.kind==='signals')){const v=JSON.parse(s.payload);assert.ok(!Object.hasOwn(v,'text'));assert.ok([...v.phones,...v.emails,...v.terms].every(x=>/^[a-f0-9]{64}$/.test(x)));}
 const encoded=JSON.stringify(r);for(const row of archive.prepare('SELECT secret FROM inquiry_keys').all())assert.ok(!encoded.includes(row.secret));
 const health=await fetch(base+'/api/health').then(r=>r.json());assert.equal(health.status,'ok');
 const result={ok:!r.ordersStale&&r.source.jobs.some(j=>['done','partial'].includes(j.state)),version:health.version,period:r.period,summary:r.summary,coverage:r.coverage,jobs:r.source.jobs.map(({state,total,done,failed,limited})=>({state,total,done,failed,limited})),errors:r.source.errors,snapshotCount:snapshots.length,persistedHashes:true,noConfirmedLinks:true,businessWrites:false};console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
}catch{console.log(JSON.stringify({ok:false,code:'INQUIRY_ACCEPTANCE_UNCONFIRMED'}));process.exitCode=1;}
finally{if(hash&&db)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash);archive?.close();db?.close();}
