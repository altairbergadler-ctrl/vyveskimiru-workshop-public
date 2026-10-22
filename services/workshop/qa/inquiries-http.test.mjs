import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createDirectory,launch,removeDirectory} from './sandbox-lib.mjs';
import {seedInquiries} from './inquiry-fixture.mjs';
test('Inquiries HTTP enforces owner/origin, exports no private signals, keeps Google unchanged and queues read-only imports',async()=>{
 const directory=createDirectory('inquiries-http-');let instance;
 try{await seedInquiries(directory);instance=await launch(directory,{avito:true});const before=fs.readFileSync(path.join(directory,'sheet.json'),'utf8'),url=instance.base+'/api/analytics/inquiries',headers={Cookie:`finance_session=${instance.token}`,Origin:instance.base,'Content-Type':'application/json'};
 assert.equal((await fetch(url)).status,401);const response=await fetch(url+'?from=2026-09-01&to=2026-09-09',{headers}),r=await response.json();assert.equal(response.status,200);assert.match(response.headers.get('Cache-Control'),/no-store/);assert.equal(r.summary.suggested,1);assert.equal(r.rows.find(o=>o.id==='9001').suggestedChatId,'fictional-chat');assert.equal(r.summary.suggestedAmount,10000);
 for(const privateValue of ['luna@example.invalid','79990000001','phones','terms','secret','signals":'])assert.ok(!JSON.stringify(r).includes(privateValue));
 assert.equal((await fetch(url+'?mode=bad',{headers})).status,400);assert.equal((await fetch(url+'/import',{method:'POST',headers:{...headers,Origin:'https://evil.invalid'},body:'{}'})).status,403);
 assert.equal((await fetch(url+'/import',{method:'POST',headers,body:'{"itemId":"1"}'})).status,400);assert.equal((await fetch(url+'/import',{method:'POST',headers,body:'{}'})).status,202);
 assert.equal(fs.readFileSync(path.join(directory,'sheet.json'),'utf8'),before);
 }finally{await instance?.stop();removeDirectory(directory);}
});
