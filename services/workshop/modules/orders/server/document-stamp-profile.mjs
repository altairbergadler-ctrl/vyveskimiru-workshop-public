import { OrderError } from './orders.mjs';
import { validDocumentLayout } from './document-layout.mjs';
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const fail=(message,code='DOCUMENT_STAMP_PROFILE_INVALID')=>{throw new OrderError(code,message,422);};
export function normalizeDocumentStampProfile(input) {
  if(input===undefined||input===null)return null;
  if(!plain(input)||Object.keys(input).some(key=>!['version','stamp','signature','profile','dpi'].includes(key))||input.version!==1)fail('Проверьте привязку печати и подписи к юрлицу.');
  const result={version:1};
  for(const key of ['stamp','signature']) {
    const value=input[key];if(value===null||value===undefined){result[key]=null;continue;}
    if(!plain(value)||Object.keys(value).some(key=>!['id','sha256','revision'].includes(key))||!/^[a-f0-9]{32}$/.test(value.id)||!['sha256','revision'].every(key=>/^[a-f0-9]{64}$/.test(value[key])))fail('Выберите печать и подпись из библиотеки «Оттиски».');
    result[key]={id:value.id,sha256:value.sha256,revision:value.revision};
  }
  result.profile=input.profile??'standard';result.dpi=input.dpi??150;
  if(!['light','standard','strong'].includes(result.profile)||![150,200].includes(result.dpi))fail('Выберите профиль скана и качество 150 или 200 DPI.');
  return result;
}
export function stampPlacement(layout,asset,kind) {
  if(!validDocumentLayout(layout))fail('У этого PDF нет проверенных мест для печати и подписи. Создайте новую версию документа или разместите изображения вручную в «Оттисках».','DOCUMENT_STAMP_LAYOUT_MISSING');
  if(layout.pages.length>50)fail('Для нанесения изображений и имитации скана поддерживаются PDF до 50 страниц. Исходный PDF сохранён.','DOCUMENT_STAMP_REJECTED');
  const anchor=layout.anchors[kind==='stamp'?'sellerStamp':'sellerSignature'];
  if(!Number.isFinite(asset.widthMm)||!Number.isFinite(asset.aspect)||asset.aspect<=0)fail('Проверьте размер изображения в «Оттисках».');
  const width=asset.widthMm*72/25.4;const scale=Math.min(1,anchor.width/width,anchor.height/(width*asset.aspect));
  const w=width*scale,h=w*asset.aspect;const min=kind==='stamp'?20:10;
  const round=value=>Math.round(value*1000)/1000;
  if(round(w)*25.4/72<min)fail('Изображение не помещается в место для подписи или печати. Проверьте пропорции изображения в «Оттисках».');
  return {page:anchor.page,x:round(anchor.x+(anchor.width-w)/2),y:round(anchor.y+(anchor.height-h)/2),width:round(w),height:round(h)};
}
