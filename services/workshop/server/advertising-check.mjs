import crypto from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
let db, archive, hash;
try {
  if (process.argv.length !== 2 || !process.env.DATA_DIR) throw new Error();
  db = new Database(path.join(process.env.DATA_DIR, 'finance.sqlite3'), { fileMustExist: true });
  const token = crypto.randomBytes(32).toString('base64url');
  hash = crypto.createHash('sha256').update(token).digest('hex');
  db.prepare('INSERT INTO sessions(token_hash,expires_at,created_at) VALUES(?,?,?)').run(hash, new Date(Date.now()+120000).toISOString(), new Date().toISOString());
  const base = 'http://127.0.0.1:' + Number(process.env.PORT || 3000);
  const response = await fetch(base + '/api/analytics/avito/deep', {headers:{ Cookie:'finance_session='+token }});
  const view = await response.json();
  assert.ok(response.ok && view.enabled);
  archive = new Database(path.join(process.env.DATA_DIR, 'analytics.sqlite3'), { readonly:true, fileMustExist:true });
  const result = archive.transaction(() => {
    const account = process.env.AVITO_ACCOUNT_ID;
    assert.ok(account);
    const snapshot = archive.prepare("SELECT * FROM ad_snapshots WHERE account=? AND kind='items' AND date_from=? AND date_to=? AND loaded_at=? ORDER BY rowid DESC LIMIT 1").get(account, view.period.dateFrom, view.period.dateTo, view.loadedAt || '');
    if (!snapshot) return { ok:false, code:'awaiting_statistics', jobs:view.jobs.map(({state,total,done,failed})=>({state,total,done,failed})) };
    const data=JSON.parse(snapshot.payload);
    const versions=archive.prepare('SELECT hash,payload FROM ad_snapshots WHERE run_id=?').all(snapshot.run_id);
    const persisted=versions.every(v=>crypto.createHash('sha256').update(v.payload).digest('hex')===v.hash);
    assert.ok(persisted);
    assert.ok(data.pagination.complete);
    assert.equal(data.groups.length,view.reportedItems);
    for(const metric of ['spending','contacts','views','impressions']){
      const values=data.groups.map(g=>g.metrics[metric]);
      const sum=values.length && values.every(v=>Number.isSafeInteger(v)) ? values.reduce((a,b)=>a+b,0) : null;
      assert.equal(sum,view.summary[metric]);
    }
    const run=archive.prepare('SELECT state FROM ad_runs WHERE id=?').get(snapshot.run_id);
    const observations=archive.prepare('SELECT count(*) AS n FROM ad_item_versions WHERE run_id=?').get(snapshot.run_id).n;
    assert.equal(archive.pragma('integrity_check',{simple:true}),'ok');
    return {ok:run.state==='done',state:run.state,automatic:view.automatic,period:view.period,
      inventoryItems:view.inventoryItems,reportedItems:view.reportedItems,coverage:view.coverage,
      availableMetrics:data.availableMetrics,unreturnedMetrics:data.unreturnedMetrics,
      persisted,snapshotCount:versions.length,observations,accountPinned:true,totalsMatch:true,
      loadedAt:view.loadedAt,jobs:view.jobs.map(({state,total,done,failed})=>({state,total,done,failed})),
      failures:view.failures.map(({kind,code,state})=>({kind,code,state}))};
  })();
  const health=await fetch(base+'/api/health').then(r=>r.json());
  result.ok=result.ok && health.status==='ok';
  console.log(JSON.stringify({...result,health:health.status,version:health.version,businessWrites:false}));
  if(!result.ok)process.exitCode=1;
} catch { console.log(JSON.stringify({ok:false,code:'ADVERTISING_ACCEPTANCE_UNCONFIRMED'}));process.exitCode=1; }
finally {
  if(hash && db)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash);
  archive?.close();db?.close();
}
