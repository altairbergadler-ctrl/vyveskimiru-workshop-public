import {editRecord} from '../modules/orders/server/editing.mjs';

export function explicitOrderIds(text) {
  return [...new Set([...text.matchAll(/(?:заказ(?:у|а|е|ом)?\s*№?\s*|№\s*)(\d+)(?!\d)/giu)].map(match=>match[1]))];
}

export function verifiedNote(note, question, target) {
  if (!target || !note || String(note.orderId)!==String(target.id) || typeof note.quote!=='string') return null;
  const quote=note.quote.trim();
  if (!quote || quote.length>1000 || !question.includes(quote) || quote.includes('\0') || /[?？]/u.test(quote)
    || /(?:не (?:записывай|сохраняй|добавляй)|не нужно (?:записывать|сохранять)|без (?:записи|сохранения))/iu.test(question)
    || /(?:если|возможно|может быть|кажется|наверное|предполож|не уверен|не записывай|не сохраняй|не добавляй)/iu.test(quote)) return null;
  return {orderId:String(target.id),quote};
}

const safe=value=>String(value??'').replace(/[\r\n]/gu,' ').replaceAll('\0',' ').slice(0,160);
export class MaxOrderNotes {
  constructor({db,readBoard,client,run=action=>action(),edit=editRecord,now=()=>Date.now()}) {
    Object.assign(this,{db,readBoard,client,run,edit,now});
    db.exec(`CREATE TABLE IF NOT EXISTS max_order_notes (key TEXT PRIMARY KEY,order_id TEXT NOT NULL,state TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS max_order_context (user_id TEXT PRIMARY KEY,order_id TEXT NOT NULL,at INTEGER NOT NULL)`);
  }
  select(userId,orderId){this.db.prepare('INSERT OR REPLACE INTO max_order_context VALUES(?,?,?)').run(String(userId),String(orderId),this.now());}
  target(userId,question,board) {
    const ids=explicitOrderIds(question);
    const selected=this.db.prepare('SELECT * FROM max_order_context WHERE user_id=?').get(String(userId));
    const id=ids.length===1?ids[0]:!ids.length && selected && this.now()-selected.at<3600000?selected.order_id:null;
    if(!id)return null;
    const matches=board.orders.filter(order=>String(order.id)===id);
    if(matches.length!==1)return null;
    return {id,title:matches[0].title,comment:matches[0].comment||''};
  }
  pending(){return this.db.prepare("SELECT count(*) n FROM max_order_notes WHERE state IN ('writing','uncertain')").get().n;}
  append(input){return this.run(()=>this.write(input));}
  async write({key,orderId,quote,userId,messageId,receivedAt}) {
    const old=this.db.prepare('SELECT * FROM max_order_notes WHERE key=?').get(key);
    if(old?.state==='confirmed')return {saved:true,replayed:true};
    if(old?.state==='rejected')return {saved:false,reason:'Запись не выполнена. Уточни заказ и повтори сообщение.'};
    const marker=`[VM_bot:${key}]`;
    const board=await this.readBoard();
    const matches=board.orders.filter(order=>String(order.id)===String(orderId));
    if(matches.length!==1)return {saved:false,reason:'Заказ не найден однозначно. Укажи его номер.'};
    const order=matches[0],comment=order.comment||'';
    if(comment.includes(marker)) {
      if(!comment.includes(`Уточнение из обсуждения: ${quote}`))return {saved:false,reason:'Содержимое пометки изменилось. Проверь комментарий заказа.'};
      this.receipt(key,orderId,'confirmed');return {saved:true,replayed:true};
    }
    if(old && ['writing','uncertain'].includes(old.state))return {saved:false,reason:'Результат предыдущей записи не подтверждён. Проверь комментарий заказа; повторную запись бот не делает.'};
    const field=order.edit?.fields.find(field=>field.id==='comment');
    if(!field?.editable)return {saved:false,reason:'Комментарий этого заказа недоступен для записи.'};
    const stamp=new Date(receivedAt||this.now()).toLocaleString('ru-RU',{timeZone:'Asia/Riyadh',hour12:false});
    const addition=`[Внесено ботом · VM_bot · ${stamp} UTC+3]\nУточнение из обсуждения: ${quote}\nИсточник: личный чат MAX; автор ${safe(userId)}; сообщение ${safe(messageId)}\n${marker}`;
    const legacy=order.items?.length && comment.startsWith('ПРОДУКЦИЯ\n1. ') && !comment.includes('\n\nКОММЕНТАРИЙ К ЗАКАЗУ\n');
    const next=comment?`${comment}${legacy?'\n\nКОММЕНТАРИЙ К ЗАКАЗУ\n':'\n\n'}${addition}`:addition;
    if(next.length>12000)return {saved:false,reason:'Комментарий заполнен. Старый текст сохранён; новую пометку нужно перенести вручную.'};
    this.receipt(key,orderId,'writing');
    try {
      await this.edit(this.client,{type:'order',record:order.edit.record,changes:{comment:next}});
      this.receipt(key,orderId,'confirmed');return {saved:true};
    } catch(error) {
      const rejected=['RECORD_CONFLICT','FIELD_READ_ONLY','INVALID_FIELD','INVALID_RECORD','DUPLICATE_ORDER_ID','SHEET_READ_CHANGED'].includes(error.code);
      this.receipt(key,orderId,rejected?'rejected':'uncertain');
      if(!rejected)try {
        const refreshed=await this.readBoard();
        const current=refreshed.orders.filter(order=>String(order.id)===String(orderId));
        if(current.length===1 && current[0].comment?.includes(marker) && current[0].comment.includes(`Уточнение из обсуждения: ${quote}`)) {
          this.receipt(key,orderId,'confirmed');return {saved:true};
        }
      }catch{}
      return {saved:false,reason:rejected?'Карточка изменилась во время записи. Существующий комментарий не заменён; повтори уточнение.':'Не удалось подтвердить запись. Проверь комментарий заказа; повторную запись бот не делает.'};
    }
  }
  receipt(key,id,state){this.db.prepare('INSERT OR REPLACE INTO max_order_notes VALUES(?,?,?,?)').run(key,String(id),state,new Date(this.now()).toISOString());}
}
