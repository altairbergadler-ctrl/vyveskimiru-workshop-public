import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createDirectory,launch,removeDirectory}from './sandbox-lib.mjs';
import {seedAdvertising}from './advertising-fixture.mjs';
test('Advertising HTTP protects owner/origin, exposes archived data without business writes, and persists idempotent notes',async()=>{
  const directory=createDirectory('advertising-http-');let instance;
  try{
    const period=await seedAdvertising(directory);instance=await launch(directory,{avito:true});
    const before=fs.readFileSync(path.join(directory,'sheet.json'),'utf8'),url=instance.base+'/api/analytics/avito/deep',headers={Cookie:`finance_session=${instance.token}`,Origin:instance.base,'Content-Type':'application/json'};
    assert.equal((await fetch(url)).status,401);
    const response=await fetch(url+'?'+new URLSearchParams(period),{headers}),report=await response.json();assert.equal(response.status,200);assert.deepEqual(response.headers.get('Cache-Control').split(',').map(v=>v.trim()).sort(),['no-store','private']);assert.equal(report.reportedItems,2);
    assert.ok(!JSON.stringify(report).includes('private-fictional-phone'));
    const input={id:crypto.randomUUID(),itemId:'5678',date:period.dateTo,text:'Fictional title test'};
    assert.equal((await fetch(url+'/notes',{method:'POST',headers:{...headers,Origin:'https://evil.invalid'},body:JSON.stringify(input)})).status,403);
    for(let i=0;i<2;i++)assert.equal((await fetch(url+'/notes',{method:'POST',headers,body:JSON.stringify(input)})).status,200);
    assert.equal((await fetch(url+'/history?itemId=5678&before=bad',{headers})).status,400);
    const history=await fetch(url+'/history?itemId=5678',{headers}).then(r=>r.json());assert.ok(history.rows.some(r=>r.fields.includes('title')&&r.previousValue.title==='Вымышленная вывеска'));
    await instance.stop();instance=await launch(directory,{avito:true});headers.Cookie=`finance_session=${instance.token}`;headers.Origin=instance.base;
    const after=await fetch(instance.base+'/api/analytics/avito/deep?'+new URLSearchParams(period),{headers}).then(r=>r.json());assert.equal(after.rows.find(r=>r.id==='5678').notes.length,1);
    assert.equal(fs.readFileSync(path.join(directory,'sheet.json'),'utf8'),before);
  }finally{await instance?.stop();removeDirectory(directory);}
});
