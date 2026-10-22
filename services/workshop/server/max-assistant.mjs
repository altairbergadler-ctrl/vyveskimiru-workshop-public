import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import {verifiedNote} from './max-order-notes.mjs';

const short = (value, length=160) => String(value ?? '').slice(0,length);
const humanComment=value=>String(value??'').replace(/\[Внесено ботом · VM_bot · [^\]]+\][\s\S]*?\[VM_bot:[a-f0-9]{64}\]/gu,'').replace(/\n\nКОММЕНТАРИЙ К ЗАКАЗУ\n\s*$/u,'').trim();
const signature=value=>JSON.stringify(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)));
export function assistantContext(board) {
  const context={ source:'Мастерская / Google Таблица', observedAt:board.updatedAt, orders:[], totalOrders:board.orders.length, truncated:false };
  for (const order of board.orders) {
    const item={id:short(order.id),title:short(order.title),client:short(order.client),status:short(order.status),dueDate:short(order.dueDate),comment:short(order.comment,500),amount:order.amount??null,paid:order.paid??null,debt:order.debt??null,
      items:order.items.slice(0,8).map(item=>({name:short(item.name),quantity:item.quantity??null,unit:short(item.unit),description:short(item.description)}))};
    context.orders.push(item);
    if (Buffer.byteLength(JSON.stringify(context)) > 28000) {context.orders.pop();context.truncated=true;break;}
  }
  return context;
}

export function assistantChanges(before, after, today) {
  const changes=[]; const old=new Map(before.orders.map(order=>[order.id,order]));
  const current=new Set(after.orders.map(order=>order.id));
  for (const order of after.orders) {
    const previous=old.get(order.id);
    const oldComparable=previous?{...previous,comment:humanComment(previous.comment)}:null;
    const newComparable={...order,comment:humanComment(previous && !Object.hasOwn(previous,'comment')?previous.comment:order.comment)};
    if (!previous || signature(oldComparable)!==signature(newComparable)) changes.push({id:order.id,before:previous||null,after:order});
  }
  if (!after.truncated && !before.truncated) for (const order of before.orders) if (!current.has(order.id)) changes.push({id:order.id,before:order,after:null,meaning:'Перестал отображаться; причина не установлена'});
  const tomorrow=new Date(Date.parse(`${today}T00:00:00Z`)+86400000).toISOString().slice(0,10);
  const risks=after.orders.filter(order=>!['Сдан','Отменён','Отменен'].includes(order.status)
    && /^\d{4}-\d{2}-\d{2}$/u.test(order.dueDate) && order.dueDate<=tomorrow)
    .map(order=>({id:order.id,dueDate:order.dueDate,status:order.status,fact:order.dueDate<today?'Срок по таблице уже прошёл':order.dueDate===today?'Срок сегодня':'Срок завтра',forecast:'Для оценки выполнимости нужны актуальная готовность, загрузка и материалы'}));
  return {changes,risks};
}

export function askCodex(config, payload) {
  return new Promise((resolve,reject)=>{
    const data=Buffer.from(JSON.stringify(payload));
    const request=http.request({socketPath:'/run/workshop-codex/broker.sock',path:'/answer',method:'POST',headers:{'X-Workshop-Codex':fs.readFileSync(config.codexTokenFile,'utf8').trim(),'Content-Type':'application/json','Content-Length':data.length}},response=>{
      const chunks=[];let size=0;
      response.on('data',chunk=>{size+=chunk.length;if(size>20000)response.destroy();else chunks.push(chunk);});
      response.on('error',()=>reject(new Error('ASSISTANT_UNAVAILABLE')));
      response.on('end',()=>{try{if(response.statusCode!==200)throw new Error();const result=JSON.parse(Buffer.concat(chunks).toString());if(typeof result.answer!=='string')throw new Error();resolve(result);}catch{reject(new Error('ASSISTANT_UNAVAILABLE'));}});
    });
    const timer=setTimeout(()=>request.destroy(),['avito-attribution','analytics-service','analytics-ad-service'].includes(payload.task)?620000:170000);
    request.on('close',()=>clearTimeout(timer));request.on('error',()=>reject(new Error('ASSISTANT_UNAVAILABLE')));request.end(data);
  });
}

export class MaxAssistant {
  constructor({db,settings,readBoard,send,notes,ask=askCodex,now=()=>Date.now()}) {
    Object.assign(this,{db,settings,readBoard,send,notes,ask,now});
    db.exec(`CREATE TABLE IF NOT EXISTS max_assistant_jobs (key TEXT PRIMARY KEY,user_id TEXT NOT NULL,question TEXT NOT NULL,search INTEGER NOT NULL,context TEXT,state TEXT NOT NULL,answer TEXT,created_at TEXT NOT NULL,retry_at INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,input_tokens INTEGER,output_tokens INTEGER);
      CREATE TABLE IF NOT EXISTS max_assistant_state (key TEXT PRIMARY KEY,value TEXT NOT NULL)`);
    const columns=new Set(db.prepare('PRAGMA table_info(max_assistant_jobs)').all().map(column=>column.name));
    for(const name of ['meta','note'])if(!columns.has(name))db.exec(`ALTER TABLE max_assistant_jobs ADD COLUMN ${name} TEXT`);
    // A terminated ephemeral worker is rerun only for unfinished read-only analysis.
    db.prepare("UPDATE max_assistant_jobs SET state='pending' WHERE state='running'").run();
  }
  enqueue({key,id,text,context=null,meta=null}) {
    if (!this.settings()?.codexEnabled) return false;
    const existing=this.db.prepare('SELECT key FROM max_assistant_jobs WHERE key=?').get(key);if(existing)return true;
    const date=new Date(this.now()).toISOString().slice(0,10);
    const used=this.db.prepare('SELECT count(*) n FROM max_assistant_jobs WHERE created_at>=?').get(date).n;
    const dailyLimit=40;
    if (used>=dailyLimit) return false;
    const pending=this.db.prepare("SELECT count(*) n FROM max_assistant_jobs WHERE user_id=? AND state IN ('pending','running','ready')").get(String(id)).n;
    if(pending>=3)return false;
    const match=text.match(/^(?:\/search|найди в интернете|поищи в интернете)\s+([\s\S]+)$/iu);
    this.db.prepare("INSERT INTO max_assistant_jobs(key,user_id,question,search,context,state,created_at,meta) VALUES(?,?,?,?,?,'pending',?,?)")
      .run(key,String(id),short(match?match[1]:text,2000),match?1:0,context?JSON.stringify(context):null,new Date(this.now()).toISOString(),meta?JSON.stringify(meta):null);
    void this.drain();return true;
  }
  drain() {
    if(this.flight)return this.flight;
    this.flight=this.work().catch(()=>{}).finally(()=>{this.flight=null;});return this.flight;
  }
  async work() {
    const config=this.settings();if(!config?.codexEnabled)return;
    const job=this.db.prepare("SELECT * FROM max_assistant_jobs WHERE state IN ('pending','ready') AND retry_at<=? ORDER BY created_at LIMIT 1").get(this.now());
    if(!job)return;
    if(!this.db.prepare('SELECT user_id FROM max_bot_users WHERE user_id=?').get(job.user_id)) {
      this.db.prepare("UPDATE max_assistant_jobs SET state='cancelled' WHERE key=?").run(job.key);return;
    }
    try {
      let answer=job.answer;
      if(!answer) {
        this.db.prepare("UPDATE max_assistant_jobs SET state='running',attempts=attempts+1 WHERE key=?").run(job.key);
        const board=!job.search && !job.context?await this.readBoard():null;
        const context=job.search?null:job.context?JSON.parse(job.context):assistantContext(board);
        const captureNotes=Boolean(config.notesEnabled && this.notes && job.meta && !job.search && !job.context);
        const target=captureNotes?this.notes.target(job.user_id,job.question,board):null;
        if(captureNotes)context.noteTarget=target?{...target,comment:short(target.comment,4000)}:null;
        const result=await this.ask(config,{question:job.question,search:Boolean(job.search),...(context?{context}:{}),...(captureNotes?{captureNotes:true}:{})});
        answer=result.answer;
        const note=captureNotes?verifiedNote(result.note,job.question,target):null;
        this.db.prepare("UPDATE max_assistant_jobs SET state='ready',answer=?,note=?,input_tokens=?,output_tokens=? WHERE key=?").run(answer,note?JSON.stringify(note):null,result.usage?.input??null,result.usage?.output??null,job.key);
      }
      const pending=this.db.prepare('SELECT note,meta FROM max_assistant_jobs WHERE key=?').get(job.key);
      if(pending.note && this.notes && config.notesEnabled) {
        const note=JSON.parse(pending.note),meta=JSON.parse(pending.meta||'{}');
        const result=await this.notes.append({key:job.key,...note,userId:job.user_id,messageId:meta.messageId,receivedAt:job.created_at});
        const status=result.saved?`Заказ №${note.orderId}: уточнение ${result.replayed?'уже есть':'добавлено'} в комментарии с пометкой «Внесено ботом».`:`Пометка не подтверждена: ${result.reason}`;
        answer=`${status}\n\n${answer}`.slice(0,4000);
        this.db.prepare('UPDATE max_assistant_jobs SET answer=?,note=NULL WHERE key=?').run(answer,job.key);
      }
      await this.send(config,job.user_id,answer,'user');
      this.db.prepare("UPDATE max_assistant_jobs SET state='done',question='',context=NULL,answer=NULL,note=NULL,meta=NULL WHERE key=?").run(job.key);
      this.db.prepare("DELETE FROM max_assistant_jobs WHERE state IN ('done','failed','cancelled') AND created_at<?").run(new Date(this.now()-30*86400000).toISOString());
    } catch {
      const attempts=this.db.prepare('SELECT attempts FROM max_assistant_jobs WHERE key=?').get(job.key).attempts;
      this.db.prepare("UPDATE max_assistant_jobs SET state=CASE WHEN answer IS NOT NULL THEN 'ready' WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,retry_at=? WHERE key=?").run(this.now()+60000,job.key);
      if(attempts>=3 && !this.db.prepare('SELECT answer FROM max_assistant_jobs WHERE key=?').get(job.key).answer) {
        this.db.prepare("UPDATE max_assistant_jobs SET question='',context=NULL WHERE key=?").run(job.key);
        try{await this.send(config,job.user_id,'Сейчас Codex не ответил. Команды /orders и /order работают; попробуй задать вопрос позже.','user');}catch{}
      }
    }
  }
  async monitor() {
    const config=this.settings();if(!config?.codexEnabled || !config.monitorEnabled)return;
    const users=this.db.prepare('SELECT user_id FROM max_bot_users').all();if(!users.length)return;
    const localDate=new Date(this.now()+180*60000),hour=localDate.getUTCHours();if(hour<8 || hour>=22)return;
    const snapshot=assistantContext(await this.readBoard());
    const previous=this.db.prepare("SELECT value FROM max_assistant_state WHERE key='monitor'").get();
    if(!previous){this.saveState({snapshot,pending:[],seenRisks:assistantChanges(snapshot,snapshot,localDate.toISOString().slice(0,10)).risks.map(risk=>JSON.stringify(risk)),lastNoticeAt:0});return;}
    const state=JSON.parse(previous.value);
    const {changes,risks}=assistantChanges(state.snapshot,snapshot,localDate.toISOString().slice(0,10));
    const freshRisks=risks.filter(risk=>!state.seenRisks.includes(JSON.stringify(risk)));
    state.pending=[...state.pending,...changes.map(change=>({type:'change',...change})),...freshRisks.map(risk=>({type:'deadline',...risk}))].slice(-60);
    state.snapshot=snapshot;state.seenRisks=risks.map(risk=>JSON.stringify(risk));
    if(state.pending.length && this.now()-state.lastNoticeAt>=3600000) {
      const batch=state.pending.slice(-20);const key=crypto.createHash('sha256').update(JSON.stringify(batch)).digest('hex');
      let accepted=false;
      for(const user of users) accepted=this.enqueue({key:`monitor:${user.user_id}:${key}`,id:user.user_id,text:'Объясни наблюдаемые изменения и сроки. Дай короткое предупреждение только по этим фактам: что изменилось, возможные последствия, что владельцу проверить. Не утверждай причинность или точный прогноз без данных.',context:{source:snapshot.source,observedAt:snapshot.observedAt,events:batch}})||accepted;
      if(accepted){state.pending=[];state.lastNoticeAt=this.now();}
    }
    this.saveState(state);
  }
  saveState(state){this.db.prepare("INSERT OR REPLACE INTO max_assistant_state VALUES('monitor',?)").run(JSON.stringify(state));}
  start() {
    this.timer=setInterval(()=>void this.drain(),3000);this.timer.unref();
    this.monitorTimer=setInterval(()=>void (this.monitorFlight??=this.monitor().catch(()=>{}).finally(()=>{this.monitorFlight=null;})),300000);this.monitorTimer.unref();
    void this.drain();
  }
  async close(){clearInterval(this.timer);clearInterval(this.monitorTimer);await this.flight;await this.monitorFlight;}
}
