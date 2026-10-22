const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const production = true;
const base = production ? 'https://vm-app.ru' : 'http://127.0.0.1:18130';
const directory = path.resolve(__dirname, '../work/acceptance'); fs.mkdirSync(directory, { recursive: true });
const token = crypto.randomBytes(32).toString('base64url');
const hash = crypto.createHash('sha256').update(token).digest('hex');
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
const database = production ? '/opt/finance-pwa/shared/data/finance.sqlite3' : '/opt/workshop-staging/20260906/data/finance.sqlite3';
function session(insert) {
  const script = `import sys,json,sqlite3\np=json.load(sys.stdin)\nc=sqlite3.connect('${database}')\n${insert ? "c.execute('INSERT INTO sessions(token_hash,expires_at,created_at) VALUES(?,?,?)',(p['hash'],p['expires'],p['now']))" : "c.execute('DELETE FROM sessions WHERE token_hash=?',(p['hash'],))"}\nc.commit()\n`;
  const r = spawnSync('ssh', ['openclaw-vps', 'python3 -c ' + quote(script)], {
    input: JSON.stringify({ hash, now: new Date().toISOString(), expires: new Date(Date.now() + 2 * 3600000).toISOString() }), encoding: 'utf8', windowsHide: true,
  });
  if (r.status !== 0) throw new Error('QA session operation failed');
}
const report = { checks: [], pageErrors: [] };
const projection = row => ['id','type','date','category','description','amount','account','cashInRegister','orderNumber','counterparty','comment'].map(k => row[k] ?? null);
(async () => {
  let browser; session(true);
  try {
    browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU' });
    await context.addCookies([{ name:'finance_session',value:token,domain:'vm-app.ru',path:'/',secure:true,httpOnly:true,sameSite:'Strict' }]);
    const page = await context.newPage(); const orders = await context.newPage();
    for (const p of [page,orders]) p.on('pageerror', e => report.pageErrors.push(e.message));
    await page.goto(base+'/',{waitUntil:'networkidle'}); await page.getByRole('button',{name:'Добавить доход',exact:true}).waitFor();
    await orders.goto(base+'/kanban/',{waitUntil:'networkidle'}); await orders.locator('#board:not([hidden])').waitFor();
    const before = (await (await context.request.get(base+'/api/transactions')).json()).transactions.map(projection).sort((a,b)=>a[0].localeCompare(b[0]));
    const oldVersion=(await (await context.request.get(base+'/api/health')).json()).version;
    console.log(JSON.stringify({ready:true,version:oldVersion,records:before.length}));
    const expected = process.argv[2]; assert.match(expected,/^[a-f0-9]{40}$/);
    let ready=false;
    for(let i=0;i<240;i++){
      await new Promise(resolve=>setTimeout(resolve,5000));
      try { const r=await context.request.get(base+'/api/health',{timeout:10000}); const h=await r.json(); if(h.version===expected&&h.status==='ok'){ready=true;break;} } catch {}
    }
    assert.ok(ready,'Release did not become ready within the observation window');
    const after=(await (await context.request.get(base+'/api/transactions')).json()).transactions.map(projection).sort((a,b)=>a[0].localeCompare(b[0]));
    assert.deepEqual(after,before); report.checks.push('Open finance client receives identical business records after cutover');
    await orders.locator('#refresh').click(); await orders.locator('#refresh').waitFor();
    await orders.waitForFunction(()=>!document.querySelector('#refresh').disabled);
    await orders.locator('#board:not([hidden])').waitFor(); report.checks.push('Already-open Kanban refreshes through the common backend with its existing session');
    await page.evaluate(async()=>{const registration=await navigator.serviceWorker.getRegistration();if(registration)await registration.update();});
    await page.reload({waitUntil:'networkidle'});
    await page.locator('a[href="/status.html"]').waitFor();
    await page.waitForFunction(async()=>(await caches.keys()).includes('finance-vps-v34'));
    report.checks.push('Existing PWA session and service worker update to the new release');
    assert.deepEqual(report.pageErrors,[]);
    fs.writeFileSync(path.join(directory,'open-clients-report.json'),JSON.stringify({...report,oldVersion,newVersion:expected},null,2));
    console.log(JSON.stringify(report));
  } finally {if(browser)await browser.close();session(false);}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
