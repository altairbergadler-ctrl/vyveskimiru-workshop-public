import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OrderError, parseNumber, readBoard } from './orders.mjs';
import { readDocumentTables, documentWrite, nextDocumentRow, digest } from '../../../server/document-sheets.mjs';
import { parseRequisites, validateFields } from '../public/requisites.js';
import { renderDocumentPdfWithLayout } from './document-pdf.mjs';
import { normalizeDocumentStampProfile } from './document-stamp-profile.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const text=value=>String(value??'').trim();
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const hash=value=>digest(JSON.stringify(canonical(value??null)));
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const fail=(code,message,status=422)=>{throw new OrderError(code,message,status);};
const field=(record,id)=>record?.edit?.fields?.find(field=>field.id===id)?.value;
const cents=value=>{const number=parseNumber(value);return number!==null&&Math.abs(number*100-Math.round(number*100))<0.00001?Math.round(number*100):null;};
const idFor=(request,index)=>{const hex=hash([request,index]);return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;};
const bool=value=>value===true;
const safeJson=value=>{try{return JSON.parse(value||'{}');}catch{fail('DOCUMENT_SCHEMA','Повреждены данные справочника документов.',409);}};
const unconfirmed=()=>new OrderError('DOCUMENT_UNCONFIRMED','Сохранение пока не подтверждено. Повторите проверку с тем же запросом; новая копия не создаётся.',409);
const dateValid=value=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const date=new Date(value+'T12:00:00Z');return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;};
const unresolvedSeller=seller=>seller.source?.unresolvedFields!==undefined&&(!Array.isArray(seller.source.unresolvedFields)||seller.source.unresolvedFields.length>0);
const preparedRowHash=row=>hash(row.filter((_,index)=>![8,11,12,17].includes(index)));

function accountContent(account) {
  return Object.fromEntries(['id','sellerId','label','bank','bik','account','correspondent','active'].map(key=>[key,account[key]]));
}

function sellerContent(seller) {
  const value=Object.fromEntries(['id','label','name','inn','kpp','ogrn','address','signer','signerRole','vat','active','source'].map(key=>[key,seller[key]]));
  value.accounts=seller.accounts.map(accountContent).sort((a,b)=>a.id.localeCompare(b.id));
  return value;
}

export function decodeDocumentSellers(tables) {
  const accounts=tables['Счета продавцов'].rows.map(({values:r})=>{
    const account={id:r[0],sellerId:r[1],label:r[2],bank:r[3],bik:r[4],account:r[5],correspondent:r[6],active:bool(r[7])};
    return {...account,revision:hash(accountContent(account))};
  });
  return tables['Продавцы'].rows.map(({values:r})=>{
    const seller={id:r[0],label:r[1],name:r[2],inn:r[3],kpp:r[4],ogrn:r[5],address:r[6],signer:r[7],signerRole:r[8],vat:r[9]||null,active:bool(r[10]),source:safeJson(r[13]),accounts:accounts.filter(account=>account.sellerId===r[0])};
    // Sheet revision cells are technical receipts, not proof that a person has
    // reviewed the current legal/bank details. Include every account, archived too.
    return {...seller,revision:hash(sellerContent(seller))};
  });
}

export function normalizeDocumentSeller(input,requestId) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['id','label','name','inn','kpp','ogrn','address','signer','signerRole','vat','active','revision','source','accounts'].includes(key))) fail('DOCUMENT_SELLER_INVALID','Проверьте поля юрлица.');
  const seller={id:input.id||requestId};
  if(!UUID.test(seller.id)) fail('DOCUMENT_SELLER_INVALID','Некорректный ID юрлица.');
  for(const key of ['label','name','inn','kpp','ogrn','address','signer','signerRole']) {
    if(input[key]!==undefined&&typeof input[key]!=='string') fail('DOCUMENT_SELLER_INVALID','Реквизиты должны быть текстом.');
    seller[key]=text(input[key]);
    if(seller[key].length>(key==='address'?1500:400)||seller[key].includes('\0')) fail('DOCUMENT_SELLER_INVALID','Поле реквизитов слишком длинное.');
  }
  if(!seller.label||!seller.name||!seller.inn) fail('DOCUMENT_SELLER_INVALID','Заполните короткое название, наименование и ИНН.');
  if(input.active!==undefined&&typeof input.active!=='boolean') fail('DOCUMENT_SELLER_INVALID','Проверьте статус юрлица.');
  seller.active=input.active!==false;
  seller.vat=input.vat===''||input.vat===undefined?null:input.vat;
  if(seller.vat!==null&&!['none','0','5','7','10','22'].includes(seller.vat)) fail('DOCUMENT_VAT_INVALID','Выберите режим НДС.');
  seller.source=input.source&&typeof input.source==='object'&&!Array.isArray(input.source)?canonical(input.source):{};
  if(Object.hasOwn(seller.source,'documentStamps'))seller.source.documentStamps=normalizeDocumentStampProfile(seller.source.documentStamps);
  if(unresolvedSeller(seller)) fail('DOCUMENT_SELLER_INVALID','Разрешите неоднозначные реквизиты продавца вручную перед сохранением.');
  if(JSON.stringify(seller.source).length>6000) fail('DOCUMENT_SELLER_INVALID','Слишком большой источник реквизитов.');
  if(!Array.isArray(input.accounts)||input.accounts.length>20) fail('DOCUMENT_ACCOUNT_INVALID','Проверьте банковские счета юрлица.');
  seller.accounts=input.accounts.map((account,index)=>{
    if(!account||typeof account!=='object'||Object.keys(account).some(key=>!['id','sellerId','label','bank','bik','account','correspondent','active','revision'].includes(key))) fail('DOCUMENT_ACCOUNT_INVALID','Проверьте банковский счёт.');
    const result={id:account.id||idFor(requestId,index),sellerId:seller.id};
    if(!UUID.test(result.id)||account.sellerId&&account.sellerId!==seller.id) fail('DOCUMENT_ACCOUNT_INVALID','Счёт относится к другому юрлицу.');
    for(const key of ['label','bank','bik','account','correspondent']) { if(account[key]!==undefined&&typeof account[key]!=='string') fail('DOCUMENT_ACCOUNT_INVALID','Банковские реквизиты должны быть текстом.');result[key]=text(account[key]);if(result[key].length>400) fail('DOCUMENT_ACCOUNT_INVALID','Слишком длинные банковские реквизиты.'); }
    if(['bank','bik','account','correspondent'].some(key=>!result[key])) fail('DOCUMENT_ACCOUNT_INVALID','Заполните банк, БИК, расчётный и корреспондентский счета.');
    if(account.active!==undefined&&typeof account.active!=='boolean') fail('DOCUMENT_ACCOUNT_INVALID','Проверьте статус банковского счёта.');
    result.active=account.active!==false;
    const issues=validateFields(result);if(issues.length) fail('DOCUMENT_ACCOUNT_INVALID',issues.map(issue=>issue.message).join(' '));
    return result;
  });
  if(new Set(seller.accounts.map(account=>account.id)).size!==seller.accounts.length) fail('DOCUMENT_ACCOUNT_INVALID','Повторяющиеся ID банковских счетов.');
  const issues=validateFields(seller);if(issues.length) fail('DOCUMENT_SELLER_INVALID',issues.map(issue=>issue.message).join(' '));
  return seller;
}

export function encodeDocumentSeller(seller,now=new Date().toISOString()) {
  return {
    seller:[seller.id,seller.label,seller.name,seller.inn,seller.kpp,seller.ogrn,seller.address,seller.signer,seller.signerRole,seller.vat||'',seller.active,hash(sellerContent(seller)),now,JSON.stringify(seller.source)],
    accounts:seller.accounts.map(account=>[account.id,seller.id,account.label,account.bank,account.bik,account.account,account.correspondent,account.active,hash(accountContent(account)),now]),
  };
}

export function prepareOrderDocument(order) {
  const warnings=[];
  if(!order) fail('ORDER_NOT_FOUND','Заказ не найден.',404);
  if(/отмен/iu.test(order.status||'')) warnings.push('Для отменённого заказа документ не создаётся.');
  if(order.contacts?.length!==1) warnings.push('Нужен один однозначно выбранный клиент заказа.');
  const contact=order.contacts?.length===1?order.contacts[0]:null;
  const requisites=text(field(contact,'requisites'));
  const parsed=parseRequisites(requisites);
  const buyer={...parsed.fields,name:parsed.fields.name,email:parsed.fields.email||contact?.email||'',requisites};
  for(const issue of parsed.issues||[]) if(!warnings.includes(issue.message)) warnings.push(issue.message);
  if(!buyer.name||!buyer.inn||!buyer.address) warnings.push('У покупателя нужны полное наименование, ИНН и юридический адрес.');
  for(const issue of validateFields(buyer)) if(!warnings.includes(issue.message)) warnings.push(issue.message);
  const items=(order.items||[]).map(item=>({name:item.name,description:item.description||'',unit:item.unit,quantity:parseNumber(field(item,'volume')),price:parseNumber(field(item,'unitPrice')),amount:parseNumber(item.amount)}));
  if(!items.length||items.length>100) warnings.push('Нужны от 1 до 100 позиций с ценами.');
  for(const [index,item] of items.entries()) {
    if(!item.name||!item.unit||item.quantity===null||item.quantity<=0||cents(item.price)===null||item.price<0||cents(item.amount)===null||item.amount<0) warnings.push(`Позиция ${index+1}: проверьте наименование, единицу, расчётное количество, цену и сумму.`);
    else if(Math.abs(Math.round(item.quantity*item.price*100)-cents(item.amount))>1) warnings.push(`Позиция ${index+1}: сумма Google не совпадает с количеством и ценой. Дождитесь пересчёта или исправьте исходные данные.`);
  }
  const total=parseNumber(order.amount);
  if(cents(total)===null||total<=0) warnings.push('Нужна положительная сумма заказа с точностью до копейки.');
  else if(items.every(item=>cents(item.amount)!==null)&&items.reduce((sum,item)=>sum+cents(item.amount),0)!==cents(total)) warnings.push('Сумма заказа отличается от суммы позиций. Исправьте исходные данные; сумма по позициям не распределяется автоматически.');
  const installations=order.installations||[];
  // The final order state is the owner's completion confirmation. Legacy
  // production stages are historical and intentionally untouched by archiveOrder.
  const completed=order.status==='Сдан'&&installations.every(item=>['Завершён','Завершен','Выполнен','Сдан','Отменён','Отменен'].includes(item.status));
  const data={orderId:order.id,orderDate:order.createdDate||'',buyer,items,total,completed};
  return {...data,sourceHash:hash(data),warnings,ready:!warnings.length};
}

export class OrderDocuments {
  constructor({client,mediaStore,directory,readBoardImpl=readBoard,renderPdf=renderDocumentPdfWithLayout}) {this.client=client;this.mediaStore=mediaStore;this.directory=directory;this.readBoard=readBoardImpl;this.renderPdf=renderPdf;}
  async load() {const loaded=await readDocumentTables(this.client);if(!loaded.ready) fail('DOCUMENT_SETUP_REQUIRED','Справочник документов ещё не подготовлен. Обратитесь к администратору.',503);return loaded.tables;}
  async sellers({includeArchived=false}={}) {const loaded=await readDocumentTables(this.client);return {ready:loaded.ready,items:loaded.ready?decodeDocumentSellers(loaded.tables).filter(seller=>includeArchived||seller.active):[]};}
  async receipt(requestId,inputHash,type) {
    if(!UUID.test(requestId||'')) fail('DOCUMENT_REQUEST_INVALID','Некорректный ID запроса.',400);
    await fs.mkdir(this.directory,{recursive:true,mode:0o700});
    const file=path.join(this.directory,requestId+'.json');
    let value;
    try{value=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT') fail('DOCUMENT_RECEIPT_INVALID','Не удалось прочитать квитанцию команды.',409);}
    if(value&&(value.inputHash!==inputHash||value.type!==type)) fail('DOCUMENT_REQUEST_CONFLICT','Этот запрос уже использован с другими данными.',409);
    return {file,value:value||{version:1,type,requestId,inputHash,state:'new'}};
  }
  async persist(receipt,changes) {
    receipt.value={...receipt.value,...changes,updatedAt:new Date().toISOString()};
    const temporary=receipt.file+'.tmp-'+crypto.randomBytes(6).toString('hex');
    let handle;let directory;
    try {
      handle=await fs.open(temporary,'wx',0o600);
      await handle.writeFile(JSON.stringify(receipt.value));await handle.sync();await handle.close();handle=undefined;
      await fs.rename(temporary,receipt.file);
      try{directory=await fs.open(this.directory,'r');await directory.sync();}
      catch(error){if(process.platform!=='win32'||!['EPERM','EISDIR','EINVAL'].includes(error.code)) throw error;}
    } finally {
      await handle?.close();await directory?.close();await fs.unlink(temporary).catch(()=>undefined);
    }
  }
  async assertNoOtherPending(requestId) {
    // A timed-out Google POST may still arrive at its reserved row. The shared
    // command queue serializes callers; the journal keeps this lock across restart.
    for(const filename of await fs.readdir(this.directory)) {
      if(!filename.endsWith('.json')||!UUID.test(filename.slice(0,-5))||filename===requestId+'.json') continue;
      let pending;
      try{pending=JSON.parse(await fs.readFile(path.join(this.directory,filename),'utf8'));}
      catch{fail('DOCUMENT_RECEIPT_INVALID','Не удалось проверить предыдущие операции документов.',409);}
      if(['submitting','uncertain'].includes(pending.state)) fail('DOCUMENT_PENDING','Сначала подтвердите предыдущую операцию с документами или реквизитами продавца.',409);
    }
  }
  async saveSeller({requestId,seller}={}) {
    const inputHash=hash(seller);const receipt=await this.receipt(requestId,inputHash,'seller');
    const cleaned=normalizeDocumentSeller(seller,requestId);
    const tables=await this.load();const all=decodeDocumentSellers(tables);const previous=all.find(value=>value.id===cleaned.id);
    if(receipt.value.state==='verified') {
      if(!previous) fail('DOCUMENT_SELLER_NOT_FOUND','Сохранённое юрлицо отсутствует.',409);
      if(receipt.value.sellerHash&&previous.revision!==receipt.value.sellerHash) fail('DOCUMENT_SELLER_CONFLICT','Реквизиты изменились после сохранения. Обновите справочник.',409);
      return {state:'confirmed',seller:previous};
    }
    const owner=new Map(all.flatMap(value=>value.accounts.map(account=>[account.id,value.id])));
    if(cleaned.accounts.some(account=>owner.has(account.id)&&owner.get(account.id)!==cleaned.id)) fail('DOCUMENT_ACCOUNT_INVALID','Банковский счёт связан с другим юрлицом.',409);
    const removed=(previous?.accounts||[]).filter(account=>!cleaned.accounts.some(current=>current.id===account.id)).map(account=>({...account,active:false}));
    const accounts=[...cleaned.accounts,...removed];
    const desired=sellerContent({...cleaned,accounts});const revision=hash(desired);
    if(previous&&same(sellerContent(previous),desired)&&(!receipt.value.sellerHash||receipt.value.sellerHash===previous.revision)) {await this.persist(receipt,{state:'verified',sellerId:cleaned.id,sellerHash:revision});return {state:'confirmed',seller:previous};}
    if(receipt.value.state==='submitting'||receipt.value.state==='uncertain') throw unconfirmed();
    if(previous&&seller.revision!==previous.revision) fail('DOCUMENT_SELLER_CONFLICT','Юрлицо изменилось. Обновите справочник перед сохранением.',409);
    if(!previous&&seller.revision) fail('DOCUMENT_SELLER_CONFLICT','Карточка юрлица отсутствует. Обновите справочник.',409);
    await this.assertNoOtherPending(requestId);
    const now=new Date().toISOString();const sellerTable=tables['Продавцы'];
    const sellerRow=sellerTable.rows.find(row=>row.values[0]===cleaned.id)?.row||nextDocumentRow(sellerTable);
    const updates=[documentWrite(sellerTable,sellerRow,[cleaned.id,cleaned.label,cleaned.name,cleaned.inn,cleaned.kpp,cleaned.ogrn,cleaned.address,cleaned.signer,cleaned.signerRole,cleaned.vat||'',cleaned.active,revision,now,JSON.stringify(cleaned.source)])];
    const accountTable=tables['Счета продавцов'];
    for(const account of accounts) {
      let row=accountTable.rows.find(row=>row.values[0]===account.id)?.row;
      if(!row){row=nextDocumentRow(accountTable);accountTable.rows.push({row,values:[account.id]});}
      updates.push(documentWrite(accountTable,row,[account.id,cleaned.id,account.label,account.bank,account.bik,account.account,account.correspondent,account.active,hash(accountContent(account)),now]));
    }
    await this.persist(receipt,{state:'submitting',sellerId:cleaned.id,sellerHash:revision});
    try{await this.client.updateValues(updates,{valueInputOption:'RAW'});}catch(error){await this.persist(receipt,{state:error.notSubmitted?'aborted':'uncertain'});throw error.notSubmitted?error:unconfirmed();}
    const result=decodeDocumentSellers(await this.load()).find(value=>value.id===cleaned.id);
    if(!result||!same(sellerContent(result),desired)) throw unconfirmed();
    await this.persist(receipt,{state:'verified'});
    return {state:'confirmed',seller:result};
  }
  async prepare(orderId) {
    const board=await this.readBoard(this.client);const matches=board.orders.filter(order=>order.id===orderId);
    if(matches.length!==1) fail('ORDER_NOT_FOUND','Нужен один заказ с уникальным номером.',404);
    const sellers=await this.sellers();
    const prepared=prepareOrderDocument(matches[0]);
    return {...prepared,sellerItems:sellers.items,setupReady:sellers.ready,ready:prepared.ready&&sellers.ready};
  }
  async create(orderId,input={}) {
    if(Object.keys(input).some(key=>!['requestId','type','number','date','sellerId','accountId','amountDue','test','expectedSourceHash','expectedSellerRevision'].includes(key))||!['invoice','upd'].includes(input.type)||typeof input.number!=='string'||!text(input.number)||input.number.length>40||!dateValid(input.date)||input.test!==undefined&&typeof input.test!=='boolean') fail('DOCUMENT_INPUT_INVALID','Проверьте тип, номер и дату документа.');
    const requestHash=hash({orderId,...input});const receipt=await this.receipt(input.requestId,requestHash,'document');
    let tables=await this.load();let table=tables['Документы заказов'];let existing=table.rows.find(row=>row.values[14]===input.requestId);
    if(existing&&(existing.values[1]!==orderId||existing.values[15]!==requestHash)) fail('DOCUMENT_REQUEST_CONFLICT','Запрос относится к другому документу.',409);
    if(!existing) {
      if(['submitting','uncertain'].includes(receipt.value.state)) throw unconfirmed();
      await this.assertNoOtherPending(input.requestId);
      const prepared=await this.prepare(orderId);
      if(!prepared.ready) fail('DOCUMENT_INCOMPLETE',prepared.warnings.join(' ')||'Справочник документов не подготовлен.');
      if(input.expectedSourceHash!==prepared.sourceHash) fail('DOCUMENT_SOURCE_CHANGED','Данные заказа изменились. Обновите предпросмотр перед созданием документа.',409);
      if(input.type==='upd'&&!prepared.completed) fail('DOCUMENT_WORK_NOT_FINISHED','УПД создаётся после завершения работ и монтажей.');
      const seller=decodeDocumentSellers(tables).find(value=>value.id===input.sellerId&&value.active);
      const bank=seller?.accounts.find(value=>value.id===input.accountId&&value.active);
      if(!seller||!bank) fail('DOCUMENT_SELLER_INVALID','Выберите действующее юрлицо и его банковский счёт.');
      if(unresolvedSeller(seller)) fail('DOCUMENT_SELLER_INVALID','В реквизитах продавца есть неразрешённые неоднозначности.');
      if(input.expectedSellerRevision!==seller.revision) fail('DOCUMENT_SELLER_CHANGED','Реквизиты продавца изменились. Обновите справочник и предпросмотр.',409);
      // Manual Sheet edits bypass the seller form. Reuse the same validation at
      // issuance, checking the selected account rather than unrelated archives.
      normalizeDocumentSeller({...seller,accounts:[bank]},seller.id);
      if(seller.vat!=='none') fail('DOCUMENT_VAT_UNSUPPORTED','Для текущей версии подтвердите «Без НДС». Расчёт документов с НДС требует отдельной настройки.');
      if(!seller.address||!seller.signer||!seller.signerRole) fail('DOCUMENT_SELLER_INCOMPLETE','У продавца нужны юридический адрес, подписант и должность.');
      const due=input.type==='invoice'?cents(input.amountDue):cents(prepared.total);
      if(due===null||due<=0||due>cents(prepared.total)) fail('DOCUMENT_AMOUNT_INVALID','Сумма к оплате — от 0,01 ₽ до суммы заказа с точностью до копейки.');
      if(table.rows.some(({values:r})=>r[5]===seller.id&&r[2]===input.type&&r[3]===text(input.number)&&r[1]!==orderId)) fail('DOCUMENT_NUMBER_DUPLICATE','Этот номер документа уже использован для другого заказа.',409);
      const createdAt=new Date().toISOString();const documentId=receipt.value.documentId||crypto.randomUUID();
      const version=Math.max(0,...table.rows.filter(({values:r})=>r[1]===orderId&&r[2]===input.type).map(({values:r})=>Number(r[7])))+1;
      const snapshot={version:1,type:input.type,number:text(input.number),date:input.date,orderId,orderDate:prepared.orderDate,seller,bank,buyer:{...prepared.buyer,requisites:undefined},items:prepared.items,total:prepared.total,amountDue:due/100,basis:`Заказ № ${orderId}${prepared.orderDate?' от '+String(prepared.orderDate).slice(0,10):''}`,test:input.test===true,createdAt};
      const encoded=JSON.stringify(snapshot);if(encoded.length>45000) fail('DOCUMENT_TOO_LARGE','Состав документа слишком большой для сохранения снимка. Разделите заказ.');
      const row=nextDocumentRow(table);const values=[documentId,orderId,input.type,snapshot.number,input.date,seller.id,bank.id,version,'prepared',encoded,digest(encoded),'','',createdAt,input.requestId,requestHash,snapshot.test,createdAt];
      await this.persist(receipt,{state:'submitting',documentId,snapshotHash:values[10],preparedRowHash:preparedRowHash(values)});
      try{await this.client.updateValues([documentWrite(table,row,values)],{valueInputOption:'RAW'});}catch(error){await this.persist(receipt,{state:error.notSubmitted?'aborted':'uncertain'});throw error.notSubmitted?error:unconfirmed();}
      tables=await this.load();table=tables['Документы заказов'];existing=table.rows.find(row=>row.values[0]===documentId);
      if(!existing||!same(existing.values,values)) throw unconfirmed();
    }
    const row=existing.values;
    // A retry must refer to the exact snapshot and reserved row first submitted
    // by this request, even when a manual Sheet edit bypassed the write guard.
    if(row[0]!==receipt.value.documentId||digest(row[9])!==row[10]||row[10]!==receipt.value.snapshotHash||preparedRowHash(row)!==receipt.value.preparedRowHash) fail('DOCUMENT_SNAPSHOT_CONFLICT','Снимок документа не совпадает с сохранённым запросом. Создание файла остановлено.',409);
    const snapshot=safeJson(row[9]);
    let media=await this.mediaStore.generated(orderId,row[0]);
    if(row[8]==='confirmed') {
      if(!media||media.id!==row[11]) fail('DOCUMENT_FILE_MISSING','Файл документа удалён из заказа. Повтор запроса не восстанавливает удалённый файл.',409);
      await this.persist(receipt,{state:'verified',documentId:row[0],mediaId:media.id});
      return {state:'confirmed',document:{id:row[0],type:row[2],number:row[3],date:row[4],version:row[7],test:row[16]},media};
    }
    await this.persist(receipt,{state:'prepared',documentId:row[0]});
    if(!media) {
      const rendered=await this.renderPdf(snapshot);
      const bytes=Buffer.isBuffer(rendered)?rendered:rendered.bytes;
      const documentLayout=rendered.layout?{...rendered.layout,pdfSha256:crypto.createHash('sha256').update(bytes).digest('hex')}:undefined;
      const filename=`${snapshot.type==='invoice'?'Счёт':'УПД'}_${snapshot.number.replace(/[^\p{L}\p{N}._-]/gu,'_')}_заказ_${orderId.replace(/[^\p{L}\p{N}._-]/gu,'_')}_v${row[7]}.pdf`;
      media=await this.mediaStore.addGenerated(orderId,{name:filename,bytes,documentLayout,generatedDocument:{documentId:row[0],type:row[2],number:row[3],version:row[7],requestId:row[14],snapshotHash:row[10],test:row[16]}});
    }
    const confirmed=[...row];confirmed[8]='confirmed';confirmed[11]=media.id;confirmed[12]=media.contentHash;confirmed[17]=new Date().toISOString();
    await this.assertNoOtherPending(input.requestId);
    await this.persist(receipt,{state:'submitting',documentId:row[0]});
    try{await this.client.updateValues([documentWrite(table,existing.row,confirmed)],{valueInputOption:'RAW'});}catch(error){await this.persist(receipt,{state:error.notSubmitted?'prepared':'uncertain'});throw unconfirmed();}
    const readback=(await this.load())['Документы заказов'].rows.find(value=>value.values[0]===row[0]);
    if(!readback||!same(readback.values,confirmed)) throw unconfirmed();
    await this.persist(receipt,{state:'verified',documentId:row[0],mediaId:media.id});
    return {state:'confirmed',document:{id:row[0],type:row[2],number:row[3],date:row[4],version:row[7],test:row[16]},media};
  }
}
