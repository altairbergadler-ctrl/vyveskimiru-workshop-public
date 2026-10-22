import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OrderError } from './orders.mjs';
import { decodeDocumentSellers } from './documents.mjs';
import { digest } from '../../../server/document-sheets.mjs';
import { normalizeDocumentStampProfile, stampPlacement } from './document-stamp-profile.mjs';
import { StampClient } from './stamp-client.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX=/^[a-f0-9]{32}$/;
const SHA=/^[a-f0-9]{64}$/;
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const hash=value=>digest(JSON.stringify(canonical(value)));
const bytesHash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fail=(code,message,status=409)=>{throw new OrderError(code,message,status);};
const derivedId=(operationId,kind)=>{const value=hash([operationId,kind]);return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20,32)}`;};

export class DocumentStamps {
  constructor({documents,mediaStore,directory,stampClient=new StampClient()}){Object.assign(this,{documents,mediaStore,directory,stampClient});this.locks=new Map();}
  async serial(id,action){const previous=this.locks.get(id)||Promise.resolve();const next=previous.catch(()=>{}).then(action);this.locks.set(id,next);try{return await next;}finally{if(this.locks.get(id)===next)this.locks.delete(id);}}
  async library(cookie){return this.stampClient.library(cookie);}
  async syncDirectory(target) {
    let directory;try{directory=await fs.open(target,'r');await directory.sync();}catch(error){if(process.platform!=='win32'||!['EPERM','EISDIR','EINVAL'].includes(error.code))throw error;}finally{await directory?.close();}
  }
  async ready() {
    this.directoryReady??=(async()=>{
      const created=await fs.mkdir(this.directory,{recursive:true,mode:0o700});
      const stop=path.dirname(path.toNamespacedPath(path.resolve(created||this.directory)));let current=path.toNamespacedPath(path.resolve(this.directory));
      while(true){await this.syncDirectory(current);if(current===stop)break;const parent=path.dirname(current);if(parent===current)throw new Error('Receipt directory parent could not be verified');current=parent;}
    })();
    try{await this.directoryReady;}catch(error){this.directoryReady=null;throw error;}
  }
  async receipt(id){
    if(!UUID.test(id||''))fail('DOCUMENT_STAMP_REQUEST','Некорректный ID запроса.',400);
    await this.ready();const file=path.join(this.directory,id+'.json');
    try{return {file,value:JSON.parse(await fs.readFile(file,'utf8'))};}catch(error){if(error.code==='ENOENT')return {file,value:null};fail('DOCUMENT_STAMP_RECEIPT','Не удалось прочитать квитанцию обработки.');}
  }
  async persist(receipt,changes){
    const value={...receipt.value,...changes,updatedAt:new Date().toISOString()};const temporary=receipt.file+'.tmp-'+crypto.randomBytes(6).toString('hex');const file=await fs.open(temporary,'wx',0o600);
    try{await file.writeFile(JSON.stringify(value));await file.sync();}finally{await file.close();}
    await fs.rename(temporary,receipt.file);await this.syncDirectory(this.directory);
    receipt.value=value;
  }
  async base(orderId,documentId){
    const tables=await this.documents.load();const row=tables['Документы заказов'].rows.find(row=>row.values[0]===documentId)?.values;
    if(!row||row[1]!==orderId)fail('DOCUMENT_NOT_FOUND','Документ заказа не найден.',404);
    if(row[8]!=='confirmed'||digest(row[9])!==row[10])fail('DOCUMENT_STAMP_SOURCE','Исходный документ ещё не подтверждён или его снимок изменён.');
    const media=await this.mediaStore.generated(orderId,documentId);
    if(!media||media.id!==row[11]||media.contentHash!==row[12]||media.generatedDocument.snapshotHash!==row[10])fail('DOCUMENT_STAMP_SOURCE','Исходный файл удалён или изменён.');
    const {bytes}=await this.mediaStore.read(orderId,media.id);if(bytesHash(bytes)!==row[12])fail('DOCUMENT_STAMP_SOURCE','Не совпадает контрольная сумма исходного PDF.');
    let snapshot;try{snapshot=JSON.parse(row[9]);}catch{fail('DOCUMENT_STAMP_SOURCE','Не удалось проверить снимок документа.');}
    return {tables,row,media,bytes,snapshot};
  }
  async reserve(orderId,documentId,input,library){
    if(!input||Object.keys(input).some(key=>!['requestId','expectedSellerRevision'].includes(key))||!SHA.test(input.expectedSellerRevision||''))fail('DOCUMENT_STAMP_REQUEST','Обновите реквизиты продавца перед обработкой.',400);
    return this.serial(input.requestId,async()=>{
      const receipt=await this.receipt(input.requestId);const inputHash=hash({orderId,documentId,input});
      if(receipt.value){if(receipt.value.inputHash!==inputHash||receipt.value.orderId!==orderId||receipt.value.documentId!==documentId)fail('DOCUMENT_STAMP_REQUEST_CONFLICT','Этот запрос уже использован с другими данными.');return receipt.value;}
      const base=await this.base(orderId,documentId);const seller=decodeDocumentSellers(base.tables).find(seller=>seller.id===base.row[5]&&seller.active);
      if(!seller||seller.revision!==input.expectedSellerRevision||['id','name','inn','kpp','ogrn','address','signer','signerRole','vat'].some(key=>seller[key]!==base.snapshot.seller?.[key]))fail('DOCUMENT_SELLER_CHANGED','Юрлицо или подписант изменились. Создайте новую версию документа с актуальными реквизитами.');
      const binding=normalizeDocumentStampProfile(seller.source.documentStamps);
      if(!binding||!binding.stamp&&!binding.signature)fail('DOCUMENT_STAMP_PROFILE_MISSING','Выберите печать и подпись в карточке юрлица.');
      const selected={};for(const [kind,list] of [['stamp',library.stamps],['signature',library.signatures]]) {
        const wanted=binding[kind];if(!wanted){selected[kind]=null;continue;}
        const asset=list.find(asset=>asset.id===wanted.id);
        if(!asset||asset.sha256!==wanted.sha256||asset.revision!==wanted.revision)fail('DOCUMENT_STAMP_PROFILE_CHANGED','Изображение или его настройки изменились в «Оттисках». Выберите его заново в карточке юрлица.');
        if(kind==='stamp'&&asset.companyInn!==seller.inn)fail('DOCUMENT_STAMP_WRONG_COMPANY','Печать относится к другому ИНН. Проверьте привязку юрлица.');selected[kind]=asset;
      }
      const layout=base.media.documentLayout;
      if(layout?.pdfSha256!==base.media.contentHash)fail('DOCUMENT_STAMP_LAYOUT_MISSING','У старого PDF нет проверенных мест для изображений. Создайте новую версию или используйте ручной инструмент «Оттиски».',422);
      const spec={version:1,sourceSha256:base.media.contentHash,documentId,orderId,stamp:selected.stamp?{id:selected.stamp.id,sha256:selected.stamp.sha256}:null,signature:selected.signature?{id:selected.signature.id,sha256:selected.signature.sha256}:null,placement:selected.stamp?stampPlacement(layout,selected.stamp,'stamp'):null,signaturePlacement:selected.signature?stampPlacement(layout,selected.signature,'signature'):null,profile:binding.profile,dpi:binding.dpi};
      await this.persist(receipt,{version:1,operationId:input.requestId,inputHash,orderId,documentId,sourceMediaId:base.media.id,sourceHash:base.media.contentHash,snapshotHash:base.row[10],document:{type:base.row[2],number:base.row[3],version:base.row[7],test:base.row[16]},spec,specHash:hash(spec),state:'prepared',createdAt:new Date().toISOString()});return receipt.value;
    });
  }
  checkOwner(receipt,orderId,documentId){if(!receipt.value||receipt.value.orderId!==orderId||receipt.value.documentId!==documentId)fail('DOCUMENT_STAMP_NOT_FOUND','Обработка документа не найдена.',404);}
  validateEngine(receipt,result){
    if(!result||result.operationId!==receipt.value.operationId||!HEX.test(result.jobId||'')||!SHA.test(result.requestHash||'')||!result.spec||hash(result.spec)!==receipt.value.specHash||result.sourceSha256!==receipt.value.sourceHash||!['processing','completed','failed'].includes(result.state))fail('DOCUMENT_STAMP_RESPONSE','Ответ «Оттисков» не соответствует исходному документу.');
    if(receipt.value.jobId&&receipt.value.jobId!==result.jobId||receipt.value.engineRequestHash&&receipt.value.engineRequestHash!==result.requestHash)fail('DOCUMENT_STAMP_RESPONSE','Изменился идентификатор обработки в «Оттисках».');
    if(result.state==='completed') {
      if(!Array.isArray(result.artifacts)||result.artifacts.length!==2||new Set(result.artifacts.map(value=>value.kind)).size!==2||!result.artifacts.every(value=>['stamped','scan'].includes(value.kind)&&HEX.test(value.id)&&SHA.test(value.sha256)&&Number.isInteger(value.size)&&value.size>0&&value.size<=12*1024*1024)||new Set(result.artifacts.map(value=>value.id)).size!==2)fail('DOCUMENT_STAMP_RESPONSE','Не удалось проверить оба результата обработки.');
      if(receipt.value.artifacts&&hash(receipt.value.artifacts)!==hash(result.artifacts.map(({id,kind,sha256,size})=>({id,kind,sha256,size}))))fail('DOCUMENT_STAMP_RESPONSE','Готовые файлы изменились после обработки.');
    }
    return result;
  }
  public(value){return {state:['verified','publishing'].includes(value.state)?'completed':value.state,operationId:value.operationId,jobId:value.jobId||null,...value.state==='failed'?{error:'Не удалось закончить обработку. Исходный PDF сохранён; проверьте «Оттиски».',code:value.errorCode||'DOCUMENT_STAMP_FAILED'}:{}};}
  async start(orderId,documentId,id,cookie){return this.serial('remote:'+id,async()=>{
    const receipt=await this.receipt(id);this.checkOwner(receipt,orderId,documentId);if(['verified','failed','publishing'].includes(receipt.value.state))return this.public(receipt.value);
    let remote=await this.stampClient.operation(id,cookie);
    if(!remote){if(receipt.value.jobId)fail('DOCUMENT_STAMP_FILE_MISSING','Обработка удалена из «Оттисков». Повтор не создаёт её заново.');const source=await this.mediaStore.read(orderId,receipt.value.sourceMediaId);if(bytesHash(source.bytes)!==receipt.value.sourceHash)fail('DOCUMENT_STAMP_SOURCE','Исходный PDF изменён.');remote=await this.stampClient.start(id,receipt.value.spec,source.bytes,cookie);}
    this.validateEngine(receipt,remote);await this.saveRemote(receipt,remote);return this.public(receipt.value);
  });}
  async saveRemote(receipt,remote){return this.serial(receipt.value.operationId,async()=>{
    const fresh=await this.receipt(receipt.value.operationId);this.validateEngine(fresh,remote);
    if(!['verified','publishing','failed'].includes(fresh.value.state))await this.persist(fresh,{state:remote.state,jobId:remote.jobId,engineRequestHash:remote.requestHash,...remote.state==='completed'?{artifacts:remote.artifacts.map(({id,kind,sha256,size})=>({id,kind,sha256,size}))}:{},...remote.state==='failed'?{errorCode:'DOCUMENT_STAMP_FAILED'}:{}});
    receipt.value=fresh.value;
  });}
  async status(orderId,documentId,id,cookie){return this.serial('remote:'+id,async()=>{
    const receipt=await this.receipt(id);this.checkOwner(receipt,orderId,documentId);if(['verified','failed','publishing'].includes(receipt.value.state))return this.public(receipt.value);
    const remote=await this.stampClient.operation(id,cookie);if(!remote){if(receipt.value.state!=='prepared')fail('DOCUMENT_STAMP_FILE_MISSING','Обработка удалена из «Оттисков». Исходный PDF сохранён.');return this.public(receipt.value);}this.validateEngine(receipt,remote);await this.saveRemote(receipt,remote);return this.public(receipt.value);
  });}
  async download(orderId,documentId,id,cookie){return this.serial('remote:'+id,async()=>{
    const receipt=await this.receipt(id);this.checkOwner(receipt,orderId,documentId);
    if(receipt.value.state==='verified')return {operationId:id,files:[]};
    if(receipt.value.state==='failed')fail(receipt.value.errorCode||'DOCUMENT_STAMP_FAILED','Обработка остановлена. Исходный PDF и ранее сохранённые файлы остаются в заказе.');
    const remote=await this.stampClient.operation(id,cookie);this.validateEngine(receipt,remote);
    if(remote.state!=='completed')fail('DOCUMENT_STAMP_NOT_READY','Обработка ещё не завершена. Повторите проверку.');
    await this.saveRemote(receipt,remote);if(receipt.value.state==='verified')return {operationId:id,files:[]};const files=[];
    for(const artifact of receipt.value.artifacts){const bytes=await this.stampClient.artifact(remote.jobId,artifact.id,artifact.size,cookie);if(bytesHash(bytes)!==artifact.sha256)fail('DOCUMENT_STAMP_RESPONSE','Контрольная сумма полученного PDF не совпадает.');files.push({...artifact,bytes});}
    return {operationId:id,files};
  });}
  async publish(orderId,documentId,prepared){return this.serial(prepared.operationId,async()=>{
    const receipt=await this.receipt(prepared.operationId);this.checkOwner(receipt,orderId,documentId);
    try {
    const base=await this.base(orderId,documentId);if(base.media.id!==receipt.value.sourceMediaId||base.media.contentHash!==receipt.value.sourceHash||base.row[10]!==receipt.value.snapshotHash)fail('DOCUMENT_STAMP_SOURCE','Исходный документ изменился.');
    if(receipt.value.state==='verified') {
      for(const kind of ['stamped','scan']){const media=await this.mediaStore.generated(orderId,derivedId(prepared.operationId,kind));if(!media||media.id!==receipt.value.mediaIds?.[kind])fail('DOCUMENT_STAMP_FILE_MISSING','Один из созданных файлов удалён. Повтор не восстанавливает его.');}
      return {state:'confirmed',media:await this.mediaStore.list(orderId)};
    }
    if(!['completed','publishing'].includes(receipt.value.state)||prepared.files.length!==2)fail('DOCUMENT_STAMP_NOT_READY','Обработка ещё не готова для сохранения.');
    for(const file of prepared.files){const expected=receipt.value.artifacts.find(value=>value.id===file.id&&value.kind===file.kind);if(!expected||bytesHash(file.bytes)!==expected.sha256||file.bytes.length!==expected.size)fail('DOCUMENT_STAMP_RESPONSE','Результат изменён до сохранения.');}
    await this.persist(receipt,{state:'publishing'});const mediaIds={};
    for(const kind of ['stamped','scan']) {
      const file=prepared.files.find(value=>value.kind===kind);const decoration={version:1,kind,parentDocumentId:documentId,operationId:prepared.operationId,jobId:receipt.value.jobId,resultId:file.id,sourceHash:receipt.value.sourceHash,engineRequestHash:receipt.value.engineRequestHash,stamp:receipt.value.spec.stamp,signature:receipt.value.spec.signature,placement:receipt.value.spec.placement,signaturePlacement:receipt.value.spec.signaturePlacement,profile:receipt.value.spec.profile,dpi:receipt.value.spec.dpi};
      const generatedDocument={documentId:derivedId(prepared.operationId,kind),type:receipt.value.document.type,number:receipt.value.document.number,version:receipt.value.document.version,requestId:prepared.operationId,snapshotHash:receipt.value.snapshotHash,test:receipt.value.document.test,decoration};
      const suffix=kind==='scan'?'скан':'печать_подпись';const name=base.media.name.replace(/\.pdf$/i,'')+'_'+suffix+'.pdf';
      const media=await this.mediaStore.addGenerated(orderId,{name,bytes:file.bytes,generatedDocument});mediaIds[kind]=media.id;
    }
    await this.persist(receipt,{state:'verified',mediaIds});return {state:'confirmed',media:await this.mediaStore.list(orderId)};
    }catch(error){
      if(receipt.value.state==='publishing'&&['DOCUMENT_MEDIA_DELETED','DOCUMENT_MEDIA_CONFLICT','DOCUMENT_STAMP_SOURCE','DOCUMENT_STAMP_FILE_MISSING','DOCUMENT_NOT_FOUND','MEDIA_NOT_FOUND'].includes(error.code))await this.persist(receipt,{state:'failed',errorCode:error.code});
      throw error;
    }
  });}
}
