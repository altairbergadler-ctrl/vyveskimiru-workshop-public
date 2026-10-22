// Explicit operator command. Writes through the running application's queue and
// Google receipt protocol; never writes business rows directly.
import crypto from 'node:crypto';
import path from 'node:path';
import {openDatabase,createSession,deleteSession} from './db.mjs';
const db=openDatabase(path.join(process.env.DATA_DIR||'/data','finance.sqlite3'));
const token=crypto.randomBytes(32).toString('base64url');
const hash=crypto.createHash('sha256').update(token).digest('hex');
const origin=process.env.PUBLIC_ORIGIN||'https://vm-app.ru';
createSession(db,hash,new Date(Date.now()+300000).toISOString());
try{
 const request=async(url,data)=>{const response=await fetch('http://127.0.0.1:3000'+url,{method:data?'POST':'GET',headers:{Cookie:`finance_session=${token}`,Origin:origin,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});const value=await response.json();if(!response.ok)throw new Error(value.code||'CATALOG_REQUEST_FAILED');return value;};
 const before=await request('/api/production-pilot');
 if(process.argv.includes('--apply'))await request('/api/production-pilot/command',{requestId:'order-catalog-seed-20260926-v1',revision:before.revision,type:'product.catalog.seed',data:{}});
 const after=await request('/api/production-pilot');
 const catalog=await request('/kanban/api/configurator');
 for(const old of before.products){const current=after.products.find(p=>p.id===old.id);if(!current||JSON.stringify(current.versions)!==JSON.stringify(old.versions))throw new Error('EXISTING_ROUTE_CHANGED');}
 if(after.tasks.length!==before.tasks.length)throw new Error('TASK_COUNT_CHANGED');
 console.log(JSON.stringify({applied:process.argv.includes('--apply'),catalogProducts:catalog.products.map(p=>({name:p.name,key:p.key})),existingRoutesPreserved:true,tasksUnchanged:true,revision:after.revision}));
 if(process.argv.includes('--apply')&&catalog.products.length!==9)throw new Error('CATALOG_INCOMPLETE');
}finally{deleteSession(db,hash);db.close();}
