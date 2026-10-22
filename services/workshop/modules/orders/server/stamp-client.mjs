import { OrderError } from './orders.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HEX=/^[a-f0-9]{32}$/;
const MAX_PDF=12*1024*1024;
const fail=(code,message,status=503)=>{throw new OrderError(code,message,status);};
export class StampClient {
  constructor({fetchImpl=fetch,base='http://workshop-stamp:8080',timeout=15000}={}) {
    const url=new URL(base);
    if(url.origin!=='http://workshop-stamp:8080'||url.pathname!=='/'||url.search||url.hash)throw new Error('Invalid fixed stamp service address');
    this.base=url.origin;this.fetch=fetchImpl;this.timeout=timeout;
  }
  headers(cookie) {
    const value=String(cookie||'').split(';').map(value=>value.trim()).find(value=>value.startsWith('finance_session='));
    if(!value||!/^finance_session=[A-Za-z0-9_-]{43}$/.test(value))fail('DOCUMENT_STAMP_SESSION','Войдите в Мастерскую.',401);
    // Native fetch owns Host. Its Origin must match the fixed internal authority;
    // the public request already passed the Workshop owner/Origin guards.
    return {Cookie:value,Origin:this.base};
  }
  async request(route,{cookie,method='GET',body,json=false,csrf}={}) {
    let response;
    try{response=await this.fetch(this.base+route,{method,headers:{...this.headers(cookie),...(csrf?{'X-CSRF-Token':csrf}:{}),...(json?{'Content-Type':'application/json'}:{})},body:json?JSON.stringify(body):body,redirect:'error',signal:AbortSignal.timeout(this.timeout)});}
    catch(error){if(error instanceof OrderError)throw error;fail('DOCUMENT_STAMP_UNAVAILABLE','«Оттиски» временно недоступны. Повторите проверку того же запроса.');}
    if(!response.ok) {
      const status=response.status;
      if(status===401)fail('DOCUMENT_STAMP_SESSION','Сессия истекла. Войдите в Мастерскую.',401);
      if(status===404)return null;
      if(status===409)fail('DOCUMENT_STAMP_CONFLICT','Параметры запроса или изображения в «Оттисках» изменились. Обновите данные.',409);
      if([413,422,429,507].includes(status))fail('DOCUMENT_STAMP_REJECTED','«Оттиски» не приняли документ. Проверьте изображения, размеры PDF и доступное место.',status===413?413:422);
      fail('DOCUMENT_STAMP_UNAVAILABLE','«Оттиски» временно недоступны. Повторите проверку того же запроса.');
    }
    return response;
  }
  async json(response) {
    try {
      const parts=[];let size=0;
      for await(const part of response.body){size+=part.length;if(size>128*1024)throw new Error('Response too large');parts.push(part);}
      return JSON.parse(Buffer.concat(parts).toString('utf8'));
    }catch{fail('DOCUMENT_STAMP_RESPONSE','Не удалось проверить ответ «Оттисков».');}
  }
  async library(cookie) {
    const response=await this.request('/api/workshop/v1/library',{cookie});if(!response)fail('DOCUMENT_STAMP_SETUP','Интеграция «Оттисков» ещё не установлена.');
    const result=await this.json(response);
    if(result.version!==1||!Array.isArray(result.stamps)||!Array.isArray(result.signatures)||result.stamps.length>100||result.signatures.length>100)fail('DOCUMENT_STAMP_RESPONSE','Не удалось проверить библиотеку «Оттисков».');
    for(const asset of [...result.stamps,...result.signatures])if(!HEX.test(asset.id)||!/^[a-f0-9]{64}$/.test(asset.sha256)||!/^[a-f0-9]{64}$/.test(asset.revision)||!Number.isFinite(asset.aspect)||asset.aspect<=0||!Number.isFinite(asset.widthMm)||asset.widthMm<=0)fail('DOCUMENT_STAMP_RESPONSE','В библиотеке есть непроверенное изображение.');
    return result;
  }
  async operation(id,cookie) {if(!UUID.test(id))fail('DOCUMENT_STAMP_REQUEST','Некорректный запрос.',400);const response=await this.request('/api/workshop/v1/documents/'+id,{cookie});return response?this.json(response):null;}
  async start(id,spec,bytes,cookie) {
    if(!UUID.test(id)||!Buffer.isBuffer(bytes)||bytes.length>MAX_PDF)fail('DOCUMENT_STAMP_REQUEST','Проверьте исходный PDF.',422);
    const form=new FormData();form.set('file',new Blob([bytes],{type:'application/pdf'}),'order-document.pdf');form.set('spec',JSON.stringify(spec));
    const identity=await this.request('/api/me',{cookie});const owner=identity?await this.json(identity):null;
    if(!owner||owner.auth_mode!=='workshop'||!/^[a-f0-9]{64}$/.test(owner.csrf))fail('DOCUMENT_STAMP_SESSION','Не удалось проверить сессию «Оттисков».',401);
    const response=await this.request('/api/workshop/v1/documents/'+id,{cookie,method:'POST',body:form,csrf:owner.csrf});
    if(!response)fail('DOCUMENT_STAMP_SETUP','Интеграция «Оттисков» ещё не установлена.');return this.json(response);
  }
  async artifact(jobId,resultId,expectedSize,cookie) {
    if(!HEX.test(jobId)||!HEX.test(resultId)||!Number.isInteger(expectedSize)||expectedSize<1||expectedSize>MAX_PDF)fail('DOCUMENT_STAMP_SIZE','Результат больше 12 МБ. Выберите скан 150 DPI.',413);
    const response=await this.request(`/api/documents/${jobId}/results/${resultId}`,{cookie});if(!response)fail('DOCUMENT_STAMP_FILE_MISSING','Результат удалён из «Оттисков».',409);
    if(!(response.headers.get('content-type')||'').startsWith('application/pdf'))fail('DOCUMENT_STAMP_RESPONSE','«Оттиски» вернули неожиданный формат.');
    const length=response.headers.get('content-length');if(length!==null&&Number(length)!==expectedSize)fail('DOCUMENT_STAMP_RESPONSE','Размер результата изменился.',409);
    const parts=[];let size=0;
    try{for await(const part of response.body){size+=part.length;if(size>MAX_PDF||size>expectedSize)fail('DOCUMENT_STAMP_SIZE','Результат больше допустимого размера.',413);parts.push(part);}}
    catch(error){if(error instanceof OrderError)throw error;fail('DOCUMENT_STAMP_UNAVAILABLE','PDF получен не полностью. Повторите проверку того же запроса.');}
    if(size!==expectedSize)fail('DOCUMENT_STAMP_RESPONSE','PDF получен не полностью. Повторите проверку.');return Buffer.concat(parts);
  }
}
