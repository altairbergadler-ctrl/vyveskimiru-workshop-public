import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { advertisingFixture } from '../qa/advertising-fixture.mjs';
import { createDirectory,removeDirectory } from '../qa/sandbox-lib.mjs';
import { AvitoDeepAnalytics } from './analytics/avito-deep.mjs';
import { efficiency,sumKnown,beforeAfter } from './analytics/advertising-metrics.mjs';
import { parseCalls,parseServices,parseTraffic,listingFields } from './avito-details.mjs';
import { AvitoError, parseAvitoReport, validateAvitoReport } from './avito.mjs';
test('A timestamp-only previous period completes the job without inventing comparison values',async()=>{
  const directory=createDirectory('advertising-empty-');const f=advertisingFixture(directory,Date.parse('2026-09-08T12:00:00Z'));
  try{
    const original=f.client.statistics.bind(f.client);
    f.client.statistics=async input=>input.dateTo==='2026-08-31' ?
      {...parseAvitoReport({result:{timestamp:'2026-09-08 11:00:00'}},validateAvitoReport(input,Date.parse('2026-09-08T12:00:00Z')),new Date().toISOString()),accountId:'1234'} :
      original(input);
    f.deep.start(f.base.currentPeriod());await f.drain();const report=f.deep.view(f.base.currentPeriod());
    assert.equal(report.jobs[0].state,'done');assert.equal(report.previousSourceState,'no_rows');
    assert.equal(report.rows[0].previous,null);assert.equal(report.rows[0].change.costContact,null);
    assert.ok(report.previousLoadedAt);
  }finally{await f.close();removeDirectory(directory);}
});
test('Provider snapshot, observations, child steps and completion commit atomically',async()=>{
  const directory=createDirectory('advertising-atomic-');const f=advertisingFixture(directory,Date.parse('2026-09-08T12:00:00Z'));
  try{
    const job=f.deep.start(f.base.currentPeriod()),original=f.deep.snapshot.bind(f.deep);
    f.deep.snapshot=(...args)=>{original(...args);throw new Error('simulated crash');};
    await f.deep.work();
    assert.equal(f.deep.db().prepare('SELECT count(*) AS n FROM ad_snapshots').get().n,0);
    assert.equal(f.deep.db().prepare('SELECT count(*) AS n FROM ad_item_versions').get().n,0);
    assert.equal(f.deep.db().prepare('SELECT count(*) AS n FROM ad_steps').get().n,1);
    f.deep.snapshot=original;f.advance(200000);await f.drain();
    assert.equal(f.deep.view(f.base.currentPeriod()).jobs[0].state,'done');
    f.deep.db().prepare("UPDATE ad_runs SET state='running',finished_at=NULL WHERE id=?").run(job.jobId);
    await f.deep.work();assert.equal(f.deep.view(f.base.currentPeriod()).jobs[0].state,'done');
  }finally{await f.close();removeDirectory(directory);}
});
test('Advertising ratios use weighted denominators, unknown is not zero, totals avoid overflow',()=>{
  assert.equal(efficiency({spending:306300,contacts:7}).costContact,437.5714);
  assert.equal(efficiency({spending:100,contacts:0}).costContact,null);
  assert.equal(efficiency({spending:0,contacts:4}).costContact,0);
  assert.equal(sumKnown([0,0]),0);assert.equal(sumKnown([null,0]),null);assert.equal(sumKnown([Number.MAX_SAFE_INTEGER,1]),null);
});
test('A full manual queue cannot starve the automatic worker',async()=>{
  const directory=createDirectory('advertising-queue-');const f=advertisingFixture(directory,Date.parse('2026-09-08T12:00:00Z'));
  try{
    for(const day of ['01','02','03'])f.deep.start({dateFrom:'2026-09-'+day,dateTo:'2026-09-'+day});
    f.deep.automatic=true;
    await f.deep.tick();
    assert.equal(f.deep.db().prepare("SELECT count(*) AS n FROM ad_steps WHERE state='done'").get().n,1);
  }finally{await f.close();removeDirectory(directory);}
});
test('Before and after excludes event and current days, requires all days, never claims causality',()=>{
  const days=Array.from({length:15},(_,i)=>({date:new Date(Date.parse('2026-08-01')+i*86400000).toISOString().slice(0,10),views:10,contacts:2}));
  const full=beforeAfter(days,'2026-08-08','2026-08-17');assert.equal(full.before.contacts,14);assert.equal(full.after.contacts,14);assert.equal(full.causal,false);
  assert.equal(beforeAfter(days,'2026-08-08','2026-08-15').after.complete,false);
  assert.equal(beforeAfter(days.slice(1),'2026-08-08','2026-08-17').before.contacts,null);
});
test('Detail parsers bound identity/date coverage, omit PII, distinguish empty calls and services',()=>{
  const request={itemIds:[12],dateFrom:'2026-09-01',dateTo:'2026-09-03'};
  const traffic=parseTraffic({result:{items:[{itemId:12,stats:[{date:'2026-09-01',uniqViews:0}]}]}},request);
  assert.equal(traffic.items[0].days[0].views,0);assert.equal(traffic.items[0].days[0].contacts,null);
  assert.throws(()=>parseTraffic({result:{items:[{itemId:13,stats:[]}]}},request));
  assert.throws(()=>parseTraffic({result:{items:[{itemId:12,stats:[{date:'2026-09-04'}]}]}},request));
  assert.throws(()=>parseCalls({result:{items:[{itemId:12,employeeId:0,days:[{date:'2026-09-01',calls:1,answered:2}]}]}},request));
  assert.equal(parseCalls({result:{items:[{itemId:12,employeeId:0}]}},request).items[0].days.length,0);
  assert.equal(parseServices({items:[{itemId:12}]},request).items[0].servicesExplicit,false);
  const value=listingFields({price:0,category:{id:1,name:'Test'},url:'https://evil.invalid/steal',address:'private'});
  assert.equal(value.price,0);assert.equal(value.url,null);assert.equal(value.address,undefined);
});
test('Advertising job is durable, preserves every observation, bounds account and period, and retries notes by identity',async()=>{
  const directory=createDirectory('advertising-');const f=advertisingFixture(directory,Date.parse('2026-09-08T12:00:00Z'));
  try{
    const p=f.base.currentPeriod(),first=f.deep.start(p);assert.equal(f.deep.start(p).jobId,first.jobId);
    await f.deep.work();await f.deep.close();
    f.deep=new AvitoDeepAnalytics({base:f.base,client:f.client,now:()=>Date.parse('2026-09-08T12:01:00Z'),automatic:false,scheduler:false});
    for(let i=0;i<20;i++)await f.deep.work();
    const report=f.deep.view(p);assert.equal(report.jobs[0].state,'done');assert.equal(report.rows.length,2);assert.equal(report.reportedItems,2);
    assert.equal(report.summary.spending,9600);assert.equal(report.rates.costContact,6);assert.equal(report.noContactsSpend,1600);
    assert.equal(report.rows[1].signals.some(s=>s.code==='spend_no_contacts'),true);
    assert.equal(report.rows[0].calls.answered,24);
    assert.equal(report.events.length,0);
    const note={id:crypto.randomUUID(),itemId:'5678',date:'2026-09-04',text:'Fictional photo update'};
    f.deep.note(note);f.deep.note(note);assert.equal(f.deep.view(p).rows[0].notes.length,1);
    assert.throws(()=>f.deep.note({...note,text:'changed'}),{code:'invalid'});
    f.change();f.deep.start(p);for(let i=0;i<20;i++)await f.deep.work();
    assert.ok(f.deep.view(p).events.some(e=>e.fields.includes('title')&&e.fields.includes('price')));
    const history=f.deep.history(new URLSearchParams({itemId:'5678'}));assert.equal(history.rows.filter(r=>r.kind==='inventory').length,2);
    const other=f.deep.view({dateFrom:'2026-08-01',dateTo:'2026-08-15'});assert.equal(other.summary,null);
    f.base.account='9999';assert.equal(f.deep.view(p).rows.length,0);
  }finally{await f.deep.close();await f.close();removeDirectory(directory);}
});
test('Incomplete or rate-limited jobs keep successful snapshots and expose queued retry rather than fabricated completeness',async()=>{
  const directory=createDirectory('advertising-retry-');const f=advertisingFixture(directory,Date.parse('2026-09-08T12:00:00Z'));
  try{
    const p=f.base.currentPeriod();f.deep.start(p);await f.drain();const old=f.deep.view(p).loadedAt;
    f.setFailure(new AvitoError('rate_limit',429,120));f.deep.start(p);await f.deep.work();await f.deep.work();
    const report=f.deep.view(p);assert.equal(report.loadedAt,old);assert.ok(report.failures.some(e=>e.code==='rate_limit'&&e.state==='queued'));
    assert.equal(report.jobs[0].state,'running');
    const queued=f.deep.db().prepare("SELECT next_at FROM ad_steps WHERE code='rate_limit' ORDER BY id LIMIT 1").get();
    assert.equal(queued.next_at,Date.parse(report.generatedAt)+120000);
    f.setFailure(new AvitoError('rate_limit',429,2));await f.deep.work();
    const local=f.deep.db().prepare("SELECT next_at FROM ad_steps WHERE code='rate_limit' ORDER BY id DESC LIMIT 1").get();
    assert.equal(local.next_at,queued.next_at,'other statistics steps must respect the same existing cooldown');
    f.advance(120000);await f.deep.work();
    const retried=f.deep.db().prepare("SELECT next_at FROM ad_steps WHERE code='rate_limit' ORDER BY id DESC LIMIT 1").get();
    assert.equal(retried.next_at,Date.parse(report.generatedAt)+122000);
  }finally{await f.close();removeDirectory(directory);}
});

test('archive dashboard selects identical latest versions and uses indexes for recent jobs and step counts', async () => {
  const directory = createDirectory('advertising-archive-');
  const f = advertisingFixture(directory, Date.parse('2026-09-08T12:00:00Z'));
  try {
    const period = f.base.currentPeriod();
    f.deep.start(period); await f.drain();
    f.change(); f.deep.start(period); await f.drain();
    const db = f.deep.db(), account = f.base.namespace();
    const expected = db.prepare("SELECT id FROM (SELECT id,ROW_NUMBER() OVER(PARTITION BY item_id,kind ORDER BY id DESC) rank FROM ad_item_versions WHERE account=? AND kind IN ('inventory','services','info')) WHERE rank=1 ORDER BY id").all(account);
    const actual = db.prepare("SELECT MAX(id) id FROM ad_item_versions WHERE account=? AND kind IN ('inventory','services','info') GROUP BY item_id,kind ORDER BY id").all(account);
    assert.deepEqual(actual, expected);
    const jobs = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM ad_runs WHERE account=? ORDER BY created_at DESC LIMIT 20').all(account);
    const steps = db.prepare("EXPLAIN QUERY PLAN SELECT count(*) FROM ad_steps WHERE run_id=? AND state='done'").all('fictional-run');
    assert.ok(jobs.some(r => r.detail.includes('ad_runs_recent')));
    assert.ok(steps.some(r => r.detail.includes('ad_steps_run_state')));
    assert.ok(!jobs.some(r => r.detail.includes('TEMP B-TREE')));
    assert.equal(f.deep.view(period).rows.length, 2);
    assert.ok(f.deep.view(period).events.length > 0);
  } finally { await f.close(); removeDirectory(directory); }
});
