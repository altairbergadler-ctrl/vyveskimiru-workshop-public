import crypto from 'node:crypto';
import { askCodex } from '../max-assistant.mjs';
import { AnalyticsError } from './contracts.mjs';
import { sumMoney } from './metrics.mjs';

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const short = (v, n = 180) => String(v ?? '').slice(0, n);
export const localDay = now => new Date(now + 3 * 3600000).toISOString().slice(0, 10);
export const nextMidnight = now => Date.parse(`${localDay(now)}T21:00:00Z`);
export const chatVersion = chat => hash([chat.id, chat.updatedAt, chat.lastMessageId, chat.itemId]);
const codes = {
  order_reference: 'В переписке указан номер заказа',
  contact: 'Совпадают контактные данные',
  specification: 'Совпадает описание изделия',
  amount: 'Совпадает обсуждаемая сумма',
  date: 'Согласуются даты',
  name: 'Похоже имя клиента',
};

export function validateMatches(answer, orders, messages) {
  const value = JSON.parse(answer);
  if (!value || !Array.isArray(value.matches) || value.matches.length > 10) throw new Error('MODEL_FORMAT');
  const ids = new Set(orders.map(o => o.id)), mids = new Set(messages.map(m => m.id));
  const seen = new Set();
  return value.matches.map(match => {
    if (!ids.has(match.orderId) || seen.has(match.orderId) || !Array.isArray(match.evidence)
      || !match.evidence.length || match.evidence.length > 6 || match.evidence.some(c => !Object.hasOwn(codes, c))
      || !Array.isArray(match.messageIds) || !match.messageIds.length || match.messageIds.length > 8
      || match.messageIds.some(id => !mids.has(id))) throw new Error('MODEL_FORMAT');
    seen.add(match.orderId);
    return {orderId:match.orderId,evidence:[...new Set(match.evidence)],messageIds:[...new Set(match.messageIds)]};
  });
}

// Model output is a suggestion, never a financial fact or a business command.
export class NightlyAttribution {
  constructor({base,client,readOrders,settings,ask=askCodex,now=Date.now,enabled=false,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
    Object.assign(this,{base,client,readOrders,settings,ask,now,enabled,pause});
    this.closed=false; this.flight=null; this.initialized=false;
  }
  db() {
    const db=this.base.storage();
    if (!this.initialized) {
      db.exec(`CREATE TABLE IF NOT EXISTS attribution_schedule(account TEXT PRIMARY KEY,next_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS attribution_runs(account TEXT NOT NULL,day TEXT NOT NULL,state TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,stats TEXT NOT NULL DEFAULT '{}',PRIMARY KEY(account,day));
        CREATE TABLE IF NOT EXISTS attribution_versions(account TEXT NOT NULL,chat_id TEXT NOT NULL,version TEXT NOT NULL,content_hash TEXT,state TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(account,chat_id,version));
        CREATE INDEX IF NOT EXISTS attribution_content ON attribution_versions(account,chat_id,content_hash);
        CREATE TABLE IF NOT EXISTS attribution_suggestions(id TEXT PRIMARY KEY,account TEXT NOT NULL,chat_id TEXT NOT NULL,item_id TEXT NOT NULL,item_title TEXT NOT NULL,order_id TEXT NOT NULL,version TEXT NOT NULL,evidence TEXT NOT NULL,message_ids TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS attribution_links(account TEXT NOT NULL,order_id TEXT NOT NULL,chat_id TEXT NOT NULL,item_id TEXT NOT NULL,item_title TEXT NOT NULL,suggestion_id TEXT NOT NULL,confirmed_at TEXT NOT NULL,PRIMARY KEY(account,order_id));
        CREATE TABLE IF NOT EXISTS attribution_decisions(id INTEGER PRIMARY KEY AUTOINCREMENT,account TEXT NOT NULL,suggestion_id TEXT NOT NULL,action TEXT NOT NULL,at TEXT NOT NULL);`);
      // A lost model response is uncertain. Do not spend tokens on the same version again.
      db.prepare("UPDATE attribution_versions SET state='interrupted' WHERE state='analyzing'").run();
      db.prepare("UPDATE attribution_runs SET state='interrupted' WHERE state='running'").run();
      this.initialized=true;
    }
    return db;
  }
  start() {
    if (!this.enabled) return;
    this.db().prepare('INSERT OR IGNORE INTO attribution_schedule VALUES(?,?)').run(this.base.namespace(),nextMidnight(this.now()));
    this.timer=setInterval(()=>void this.tick().catch(()=>{}),30000); this.timer.unref();
  }
  tick() {
    if (this.closed || this.flight || !this.enabled) return Promise.resolve();
    this.flight=(async()=>{await this.services?.bootstrap();await this.run();})().finally(()=>{this.flight=null;}); return this.flight;
  }
  async providerRead(operation) {
    for(let attempt=0;;attempt++) {
      if(this.closed)throw new Error('STOPPED');
      try {return await operation();}
      catch(error) {
        // The shared connector reserves each resource for one second. Respect both
        // that local gate and provider Retry-After, without retrying model calls.
        if(error.code!=='rate_limit'||attempt>=8||error.retryAfterSeconds>60)throw error;
        await this.pause(Math.max(1000,(error.retryAfterSeconds||1)*1000)+50);
      }
    }
  }
  async run() {
    const db=this.db(), account=this.base.namespace(), now=this.now(), day=localDay(now);
    const schedule=db.prepare('SELECT next_at FROM attribution_schedule WHERE account=?').get(account);
    if (!account || !schedule || now<schedule.next_at) return;
    // A unique day receipt and the next deadline are committed before any external calls.
    const claimed=db.transaction(()=>{
      db.prepare('UPDATE attribution_schedule SET next_at=? WHERE account=?').run(nextMidnight(now),account);
      return db.prepare("INSERT OR IGNORE INTO attribution_runs(account,day,state,started_at) VALUES(?,?,'running',?)").run(account,day,new Date(now).toISOString()).changes;
    })();
    if (!claimed) return;
    const stats={seen:0,unchanged:0,read:0,analyzed:0,suggestions:0,failed:0,deferred:0,limited:false};
    try {
      await this.services?.run(day);
      const config=this.settings();
      if (!config?.codexEnabled || !config.codexTokenFile) throw new Error('CODEX_DISABLED');
      const board=await this.readOrders();
      const ids=board.orders.map(o=>String(o.id));
      if (new Set(ids).size!==ids.length) throw new Error('DUPLICATE_ORDERS');
      const orders=board.orders.filter(o=>o.status!=='Отменён').map(o=>({id:String(o.id),title:short(o.title),client:short(o.client),createdDate:o.createdDate,
        amount:o.amount??null,paid:o.paid??null,contacts:(o.contacts||[]).map(c=>({name:short(c.name),phone:short(c.phone),email:short(c.email)})),
        items:(o.items||[]).map(i=>({name:short(i.name),description:short(i.description,600),quantity:i.quantity??null}))}));
      if (!orders.length) throw new Error('NO_ORDERS');
      const chats=new Map();
      for (let offset=0;offset<=1000;offset+=100) {
        if (this.closed) throw new Error('STOPPED');
        const page=await this.providerRead(()=>this.client.conversations({offset}));
        if (page.accountId!==account) throw new Error('ACCOUNT');
        for (const chat of page.chats) chats.set(chat.id,chat);
        if (!page.hasMore) break;
        if (offset===1000) stats.limited=true;
      }
      // Newest first; a bounded initial backlog can continue on following nights.
      for (const chat of [...chats.values()].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))) {
        if (this.closed) throw new Error('STOPPED');
        stats.seen++;
        const version=chatVersion(chat);
        if (db.prepare('SELECT 1 FROM attribution_versions WHERE account=? AND chat_id=? AND version=?').get(account,chat.id,version)) {stats.unchanged++;continue;}
        const candidates=orders.filter(o=>!o.createdDate || (Date.parse(chat.updatedAt)>=Date.parse(o.createdDate)-90*86400000 && Date.parse(chat.createdAt)<=Date.parse(o.createdDate)+14*86400000));
        if (!candidates.length) {this.record(chat,version,null,'outside_orders');continue;}
        if (stats.analyzed>=60) {stats.deferred++;continue;}
        try {
          const messages=[];let more=false;
          for (let offset=0;offset<1000;offset+=100) {
            const page=await this.providerRead(()=>this.client.conversationMessages({chatId:chat.id,offset}));
            messages.push(...page.messages);more=page.hasMore;
            if (!more) break;
          }
          stats.read++;
          const unique=[...new Map(messages.map(m=>[m.id,m])).values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
          const contentHash=hash([chat.itemId,unique]);
          const previous=db.prepare("SELECT 1 FROM attribution_versions WHERE account=? AND chat_id=? AND content_hash=? AND state IN ('done','empty','interrupted','invalid','analyzing')").get(account,chat.id,contentHash);
          if(previous) {this.record(chat,version,contentHash,'unchanged_content');stats.unchanged++;continue;}
          const texts=unique.filter(m=>m.type==='text'&&m.text);
          if(!texts.some(m=>m.direction==='in')) {this.record(chat,version,contentHash,'empty');continue;}
          // Stable references retained in results; raw texts exist only during this call.
          const selected=[];let bytes=0;
          for (const m of [...texts].reverse()) {const value={...m,text:short(m.text,3000)};bytes+=Buffer.byteLength(JSON.stringify(value));if(bytes>18000)break;selected.unshift(value);}
          const selectedOrders=[];let orderBytes=0;
          for(const o of candidates) {orderBytes+=Buffer.byteLength(JSON.stringify(o));if(orderBytes>22000)break;selectedOrders.push(o);}
          if(!selected.length||!selectedOrders.length) throw new Error('CONTEXT');
          this.record(chat,version,contentHash,'analyzing');
          stats.analyzed++;
          const result=await this.ask(config,{task:'avito-attribution',question:'Сопоставь переписку с заказами. Верни JSON по указанной схеме.',search:false,
            context:{chat:{id:chat.id,itemId:chat.itemId,title:chat.itemTitle,users:chat.users},messages:selected,orders:selectedOrders,
              incomplete:more||selected.length<texts.length||selectedOrders.length<candidates.length}});
          const matches=validateMatches(result.answer,selectedOrders,selected);
          db.transaction(()=>{
            db.prepare("UPDATE attribution_suggestions SET state='superseded' WHERE account=? AND chat_id=? AND state='pending'").run(account,chat.id);
            for (const match of matches) {
              if(db.prepare('SELECT 1 FROM attribution_links WHERE account=? AND order_id=? AND chat_id=?').get(account,match.orderId,chat.id))continue;
              const id=hash([account,chat.id,version,match.orderId]);
              db.prepare("INSERT OR IGNORE INTO attribution_suggestions VALUES(?,?,?,?,?,?,?,?,?,'pending',?)").run(id,account,chat.id,chat.itemId,short(chat.itemTitle,300),match.orderId,version,JSON.stringify(match.evidence),JSON.stringify(match.messageIds),new Date(this.now()).toISOString());
              stats.suggestions++;
            }
            db.prepare("UPDATE attribution_versions SET state='done' WHERE account=? AND chat_id=? AND version=?").run(account,chat.id,version);
          })();
        } catch {
          stats.failed++;
          db.prepare("UPDATE attribution_versions SET state='invalid' WHERE account=? AND chat_id=? AND version=? AND state='analyzing'").run(account,chat.id,version);
        }
        db.prepare('UPDATE attribution_runs SET stats=? WHERE account=? AND day=?').run(JSON.stringify(stats),account,day);
      }
      db.prepare('UPDATE attribution_runs SET state=? WHERE account=? AND day=?').run(stats.failed||stats.deferred||stats.limited?'partial':'done',account,day);
    } catch(error) {
      stats.failureCode=['rate_limit','schema','forbidden','unauthorized','unavailable','account_mismatch'].includes(error.code)?error.code:'preflight_failed';
      db.prepare("UPDATE attribution_runs SET state='failed' WHERE account=? AND day=?").run(account,day);
    }
    finally {db.prepare('UPDATE attribution_runs SET finished_at=?,stats=? WHERE account=? AND day=?').run(new Date(this.now()).toISOString(),JSON.stringify(stats),account,day);}
  }
  record(chat,version,contentHash,state) {
    this.db().prepare('INSERT OR IGNORE INTO attribution_versions VALUES(?,?,?,?,?,?)').run(this.base.namespace(),chat.id,version,contentHash,state,new Date(this.now()).toISOString());
  }
  view() {
    const db=this.db(),account=this.base.namespace();
    const run=db.prepare('SELECT * FROM attribution_runs WHERE account=? ORDER BY day DESC LIMIT 1').get(account);
    return {enabled:this.enabled,model:'gpt-6-luna',effort:'max',timezone:'UTC+3',nextAt:db.prepare('SELECT next_at FROM attribution_schedule WHERE account=?').get(account)?.next_at??null,
      run:run?{day:run.day,state:run.state,stats:JSON.parse(run.stats),finishedAt:run.finished_at}:null,
      pending:db.prepare("SELECT * FROM attribution_suggestions WHERE account=? AND state='pending' ORDER BY created_at DESC").all(account).map(s=>({id:s.id,orderId:s.order_id,chatId:s.chat_id,itemId:s.item_id,itemTitle:s.item_title,reasons:JSON.parse(s.evidence).map(c=>codes[c]),messageIds:JSON.parse(s.message_ids)})),
      links:db.prepare('SELECT order_id AS orderId,chat_id AS chatId,item_id AS itemId,item_title AS itemTitle,suggestion_id AS suggestionId FROM attribution_links WHERE account=?').all(account)};
  }
  async decide(input) {
    if(!input||!['confirm','reject','unlink'].includes(input.action)||typeof input.id!=='string'||Object.keys(input).some(k=>!['id','action'].includes(k))) throw new AnalyticsError('ATTRIBUTION_INPUT','Некорректное действие.',400);
    const db=this.db(),account=this.base.namespace();
    const suggestion=db.prepare('SELECT * FROM attribution_suggestions WHERE account=? AND id=?').get(account,input.id);
    if(!suggestion) throw new AnalyticsError('ATTRIBUTION_MISSING','Предложение не найдено.',404);
    if(input.action==='confirm') {
      const board=await this.readOrders();
      if(board.orders.filter(o=>String(o.id)===suggestion.order_id && o.status!=='Отменён').length!==1) throw new AnalyticsError('ATTRIBUTION_ORDER','Заказ отсутствует или неоднозначен.',409);
    }
    return db.transaction(()=>{
      const existing=db.prepare('SELECT * FROM attribution_links WHERE account=? AND order_id=?').get(account,suggestion.order_id);
      if(input.action==='confirm') {
        if(existing?.suggestion_id===input.id)return {saved:true};
        if(suggestion.state!=='pending'||existing)throw new AnalyticsError('ATTRIBUTION_CONFLICT','Связь уже изменена. Обновите данные.',409);
        db.prepare('INSERT INTO attribution_links VALUES(?,?,?,?,?,?,?)').run(account,suggestion.order_id,suggestion.chat_id,suggestion.item_id,suggestion.item_title,input.id,new Date(this.now()).toISOString());
        db.prepare("UPDATE attribution_suggestions SET state='confirmed' WHERE id=?").run(input.id);
      } else if(input.action==='unlink') {
        if(existing && existing.suggestion_id!==input.id)throw new AnalyticsError('ATTRIBUTION_CONFLICT','Связь уже изменена.',409);
        db.prepare('DELETE FROM attribution_links WHERE account=? AND suggestion_id=?').run(account,input.id);
        db.prepare("UPDATE attribution_suggestions SET state='rejected' WHERE id=?").run(input.id);
      } else {
        if(suggestion.state==='confirmed')throw new AnalyticsError('ATTRIBUTION_CONFLICT','Сначала отмените подтверждённую связь.',409);
        db.prepare("UPDATE attribution_suggestions SET state='rejected' WHERE id=?").run(input.id);
      }
      db.prepare('INSERT INTO attribution_decisions(account,suggestion_id,action,at) VALUES(?,?,?,?)').run(account,input.id,input.action,new Date(this.now()).toISOString());
      return {saved:true};
    })();
  }
  async close() {this.closed=true;clearInterval(this.timer);await this.flight;}
}

export function attributedFacts({links,orders,records,period}) {
  const within=d=>d>=period.from&&d<=period.to;
  return [...new Set(links.map(l=>l.itemId))].map(itemId=>{
    const linked=links.filter(l=>l.itemId===itemId);
    const matched=orders.filter(o=>linked.some(l=>l.orderId===o.id)&&o.status!=='Отменён');
    const periodOrders=matched.filter(o=>within(o.createdDate));
    const income=records?.filter(p=>p.type==='income'&&within(p.date)&&matched.some(o=>o.id===p.orderNumber));
    return {itemId,title:linked[0].itemTitle,orders:periodOrders.length,orderIds:matched.map(o=>o.id),receipts:income?sumMoney(income,p=>p.amount):null,profit:sumMoney(periodOrders,o=>o.profit)};
  });
}
