import crypto from 'node:crypto';
import { askCodex } from '../max-assistant.mjs';
import { projectOrders } from './metrics.mjs';
import { orderService } from './live.mjs';
import { localDay } from './nightly-attribution.mjs';
import { categoryId } from './categories.mjs';

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reasons = ['product', 'mixed', 'ambiguous', 'insufficient', 'no_match'];
function classifierProducts(catalog) {
  if (!['production-routes','analytics-categories'].includes(catalog?.source) || !catalog.products?.length) throw new Error('CATALOG');
  const products = catalog.products.filter(p=>p.automatic!==false).map(p => ({id:p.id, name:p.name, unit:p.unit || '',description:p.description||''})).sort((a,b)=>a.id.localeCompare(b.id));
  if (new Set(products.map(p=>p.id)).size !== products.length || Buffer.byteLength(JSON.stringify(products))>14000) throw new Error('CATALOG');
  return products;
}
export function adServiceCandidates({ads,catalog,mappings}) {
  const products=classifierProducts(catalog);
  if(new Set(ads.map(a=>a.id)).size!==ads.length)throw new Error('ADS');
  const orders=ads.filter(a=>a.inInventory!==false&&!mappings.some(m=>m.kind==='ad'&&m.entityId===a.id)).map(a=>{
    const context={id:a.id,title:a.title||'',category:a.category??null,description:a.info?.description||'',positionProducts:[]};
    return {context,version:hash([products,context])};
  });
  return {products,orders};
}
export function serviceCandidates({board, catalog, mappings, links=[]}) {
  const products=classifierProducts(catalog);
  const projected = projectOrders(board).orders;
  const orders = projected.filter(o => /^(авито|avito)$/iu.test(o.source) && !['Отменён','Отменен'].includes(o.status)
    && !mappings.some(m=>m.kind==='order'&&m.entityId===o.id) && !orderService(o,catalog,mappings)).map(o => {
    const raw = board.orders.find(r=>String(r.id)===o.id);
    const link = links.find(l=>l.orderId===o.id);
    const positionProducts = [...new Set((catalog.positions||[]).filter(p=>raw.items?.some(i=>p.sourcePosition===`position:${o.id}:${i.row}`)).map(p=>p.productId).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
    const context = {id:o.id, title:raw.title || '', client:raw.client || '',
      items:(raw.items||[]).map(i=>({name:i.name||'', description:i.description||'', quantity:i.quantity??null, unit:i.unit||''})),
      positionProducts, confirmedAd:link?{id:link.itemId,title:link.itemTitle,productId:categoryId(catalog,mappings.find(m=>m.kind==='ad'&&m.entityId===link.itemId)?.productId)??null}:null};
    return {context, version:hash([products,context])};
  });
  return {products,orders};
}

export function validateServices(answer, candidates, products, key='orderId') {
  const value = JSON.parse(answer);
  if (!value || Object.keys(value).length!==1 || !Array.isArray(value.assignments) || value.assignments.length!==candidates.length) throw new Error('MODEL_FORMAT');
  const seen=new Set(), ids=new Set(products.map(p=>p.id));
  for (const result of value.assignments) {
    const candidate = candidates.find(o=>o.context.id===result?.[key]);
    if (!candidate || seen.has(result[key]) || Object.keys(result).sort((a,b)=>a.localeCompare(b)).join()!==`${key},productId,reason`
      || !reasons.includes(result.reason) || !(result.productId===null || ids.has(result.productId))
      || (result.productId!==null)!==(result.reason==='product')
      || (result.productId!==null && candidate.context.positionProducts.some(id=>id!==result.productId))) throw new Error('MODEL_FORMAT');
    seen.add(result[key]);
  }
  return value.assignments.map(r=>({orderId:r[key],productId:r.productId,reason:r.reason}));
}

// Only analytics service links are written, through the existing owner operation.
// Raw order data and model responses are never persisted in this technical store.
export class AutoServices {
  constructor({base, readInputs, queue, save, settings, ask=askCodex, now=Date.now, enabled=false,kind='order',bootstrapKey=null}) {
    if(!['ad','order'].includes(kind))throw new Error('KIND');
    Object.assign(this,{base,readInputs,queue,save,settings,ask,now,enabled,kind,bootstrapKey});
    this.candidates=kind==='ad'?adServiceCandidates:serviceCandidates;
    this.contextKey=kind==='ad'?'ads':'orders';this.limit=kind==='ad'?60:40;
    this.initialized=false;this.closed=false;this.flight=null;
  }
  sql(value) {return this.kind==='ad'?value.replaceAll('service_auto_','ad_service_auto_').replaceAll('order_id','entity_id'):value;}
  statement(value) {return this.db().prepare(this.sql(value));}
  db() {
    const db=this.base.storage();
    if (!this.initialized) {
      db.exec(this.sql(`CREATE TABLE IF NOT EXISTS service_auto_runs(account TEXT NOT NULL,day TEXT NOT NULL,state TEXT NOT NULL,stats TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(account,day));
        CREATE TABLE IF NOT EXISTS service_auto_versions(account TEXT NOT NULL,order_id TEXT NOT NULL,version TEXT NOT NULL,state TEXT NOT NULL,product_id TEXT,reason TEXT,mapping_revision INTEGER,at TEXT NOT NULL,PRIMARY KEY(account,order_id,version));`));
      db.prepare(this.sql("UPDATE service_auto_runs SET state='interrupted' WHERE state='running'")).run();
      db.prepare(this.sql("UPDATE service_auto_versions SET state='interrupted' WHERE state='analyzing'")).run();
      this.initialized=true;
    }
    return db;
  }
  async bootstrap() {
    if(!this.enabled)return;
    if(this.bootstrapKey) {
      if(!this.statement('SELECT 1 FROM service_auto_runs WHERE account=? AND day LIKE ? LIMIT 1').get(this.base.namespace(),`%:setup:${this.bootstrapKey}`)) await this.run(`${localDay(this.now())}:setup:${this.bootstrapKey}`);
    } else if(!this.statement('SELECT 1 FROM service_auto_runs WHERE account=? LIMIT 1').get(this.base.namespace())) await this.run(localDay(this.now()));
  }
  run(day) {
    if (!this.enabled||this.closed) return Promise.resolve();
    if(this.flight)return this.flight;
    this.flight=this.work(day).finally(()=>{this.flight=null;});return this.flight;
  }
  async work(day) {
    const db=this.db(),account=this.base.namespace(),at=()=>new Date(this.now()).toISOString();
    if (!account || !this.statement("INSERT OR IGNORE INTO service_auto_runs VALUES(?,?,'running','{}',?)").run(account,day,at()).changes) return;
    const stats={analyzed:0,assigned:0,unresolved:0,unchanged:0,failed:0,deferred:0,skipped:0};
    const set=(candidate,state,productId=null,reason=null,revision=null)=>this.statement('UPDATE service_auto_versions SET state=?,product_id=?,reason=?,mapping_revision=?,at=? WHERE account=? AND order_id=? AND version=?')
      .run(state,productId,reason,revision,at(),account,candidate.context.id,candidate.version);
    try {
      const config=this.settings();
      if(!config?.codexEnabled||!config.codexTokenFile)throw new Error('CONFIG');
      const input=this.candidates(await this.queue(()=>this.readInputs()));
      const pending=input.orders.filter(o=>{
        if(this.statement('SELECT 1 FROM service_auto_versions WHERE account=? AND order_id=? AND version=?').get(account,o.context.id,o.version)){stats.unchanged++;return false;}
        return true;
      });
      const record=(o,state,reason=null)=>this.statement('INSERT OR IGNORE INTO service_auto_versions VALUES(?,?,?,?,NULL,?,NULL,?)').run(account,o.context.id,o.version,state,reason,at());
      while(pending.length && stats.analyzed<this.limit && !this.closed) {
        const batch=[];
        while(pending.length&&batch.length<10&&stats.analyzed+batch.length<this.limit) {
          const next=pending[0];
          if(next.context.positionProducts.length>1){pending.shift();record(next,'unresolved','mixed');stats.unresolved++;continue;}
          const bytes=Buffer.byteLength(JSON.stringify({products:input.products,orders:[...batch,next].map(o=>o.context)}));
          if(bytes>42000){if(batch.length)break;pending.shift();record(next,'oversize');stats.skipped++;continue;}
          batch.push(pending.shift());
        }
        if(!batch.length)continue;
        db.transaction(()=>batch.forEach(o=>record(o,'analyzing')))();
        stats.analyzed+=batch.length;
        try {
          const answer=await this.ask(config,{task:this.kind==='ad'?'analytics-ad-service':'analytics-service',search:false,question:'Подбери общую категорию из каталога. Неоднозначные случаи оставь без категории.',context:{products:input.products,[this.contextKey]:batch.map(o=>o.context)}});
          const assignments=validateServices(answer.answer,batch,input.products,this.kind==='ad'?'adId':'orderId');
          if(this.closed)throw new Error('STOPPED');
          // Refresh inside the shared queue: an edit while AI was thinking wins.
          await this.queue(async()=>{
            const current=this.candidates(await this.readInputs());
            for(const candidate of batch) {
              const fresh=current.orders.find(o=>o.context.id===candidate.context.id);
              if(!fresh||fresh.version!==candidate.version){set(candidate,'superseded');stats.skipped++;continue;}
              const match=assignments.find(m=>m.orderId===candidate.context.id);
              if(match.productId===null){set(candidate,'unresolved',null,match.reason);stats.unresolved++;continue;}
              const result=await this.save({kind:this.kind,entityId:match.orderId,productId:match.productId,expectedRevision:0});
              set(candidate,'assigned',match.productId,match.reason,result.revision);stats.assigned++;
            }
          });
        } catch {
          for(const candidate of batch) {
            const changed=this.statement("UPDATE service_auto_versions SET state='invalid',at=? WHERE account=? AND order_id=? AND version=? AND state='analyzing'").run(at(),account,candidate.context.id,candidate.version).changes;
            stats.failed+=changed;
          }
        }
        this.statement('UPDATE service_auto_runs SET stats=? WHERE account=? AND day=?').run(JSON.stringify(stats),account,day);
      }
      stats.deferred=pending.length;
      this.statement('UPDATE service_auto_runs SET state=? WHERE account=? AND day=?').run(stats.failed||stats.deferred||stats.skipped?'partial':'done',account,day);
    } catch { stats.failed++;this.statement("UPDATE service_auto_runs SET state='failed' WHERE account=? AND day=?").run(account,day); }
    finally {this.statement('UPDATE service_auto_runs SET stats=?,at=? WHERE account=? AND day=?').run(JSON.stringify(stats),at(),account,day);}
  }
  view() {
    const account=this.base.namespace();
    const run=this.statement('SELECT day,state,stats,at FROM service_auto_runs WHERE account=? ORDER BY at DESC,rowid DESC LIMIT 1').get(account);
    const assignments=this.statement("SELECT order_id AS orderId,product_id AS productId,mapping_revision AS revision FROM service_auto_versions WHERE account=? AND state='assigned'").all(account);
    return {enabled:this.enabled,run:run?{...run,day:run.day.slice(0,10),stats:JSON.parse(run.stats)}:null,
      unresolved:this.statement("SELECT order_id AS entityId,reason FROM service_auto_versions WHERE rowid IN (SELECT max(rowid) FROM service_auto_versions WHERE account=? GROUP BY order_id) AND state='unresolved'").all(account),
      assignments:this.kind==='ad'?assignments.map(({orderId,...rest})=>({adId:orderId,...rest})):assignments};
  }
  async close(){this.closed=true;await this.flight;}
}
