import {drawWarp,validQuad} from './photo-warp.mjs';
const $=id=>document.getElementById(id);
const clamp=(v,min,max,fallback)=>Number.isFinite(Number(v))?Math.max(min,Math.min(max,Number(v))):fallback;
let selection, font, decal, photo, points=[], drag, queued=false, photoRevision=0, model, arTask;
let scale=100, rotation=0, mode=new URLSearchParams(location.search).get('mode')==='photo'?'photo':'ar';
const status=(id,message)=>{$(id).textContent=message;};
const cm=v=>new Intl.NumberFormat('ru',{maximumFractionDigits:1}).format(v);

function readSelection() {
  if(!location.hash.startsWith('#v=') || location.hash.length>8000) throw new Error('Выберите шрифт в каталоге и нажмите кнопку примерки.');
  const s=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(location.hash.slice(3).replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))));
  if(!s || typeof s.font!=='string' || typeof s.text!=='string') throw new Error('Ссылка на вариант повреждена. Вернитесь в каталог.');
  const result={font:s.font,text:s.text.slice(0,100).split('\n').slice(0,3).join('\n'),uppercase:s.uppercase===true,
    height:clamp(s.height,5,200,30),depth:clamp(s.depth,1,30,5),faceColor:/^#[a-f0-9]{6}$/i.test(s.faceColor||'')?s.faceColor:'#f3ae45',
    material:['color','white','gold','silver'].includes(s.material)?s.material:'color',lighting:['plain','face','halo'].includes(s.lighting)?s.lighting:'plain'};
  if(!result.text.trim()) throw new Error('Сначала введите надпись в каталоге.');
  return result;
}

function createDecal() {
  const value=selection.uppercase?selection.text.toLocaleUpperCase('ru'):selection.text;
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
  ctx.font=`${font.weight} 1000px "vm_tryon"`;ctx.fontKerning='normal';
  const ref=ctx.measureText('Н'),refHeight=ref.actualBoundingBoxAscent+ref.actualBoundingBoxDescent;
  const rows=value.split('\n').map(text=>({text,m:ctx.measureText(text||' ')}));
  const width=Math.max(1,...rows.map(r=>r.m.actualBoundingBoxLeft+r.m.actualBoundingBoxRight));
  const top=Math.max(rows[0].m.actualBoundingBoxAscent,refHeight*.3);
  const height=Math.max(refHeight,top+(rows.length-1)*refHeight*1.32+rows.at(-1).m.actualBoundingBoxDescent);
  const f=Math.min(1600/width,900/height),pad=30,depth=Math.min(20,selection.depth/selection.height*refHeight*f*.25);
  canvas.width=Math.ceil(width*f+pad*2+depth);canvas.height=Math.ceil(height*f+pad*2+depth);
  ctx.font=`${font.weight} ${1000*f}px "vm_tryon"`;ctx.fontKerning='normal';ctx.textBaseline='alphabetic';
  const color={white:'#f5f4ed',gold:'#c49a42',silver:'#b8c1c5'}[selection.material]||selection.faceColor;
  const draw=(dx,dy)=>rows.forEach((r,i)=>ctx.fillText(r.text,pad+(width-r.m.actualBoundingBoxLeft-r.m.actualBoundingBoxRight)*f/2+r.m.actualBoundingBoxLeft*f+dx,pad+(top+i*refHeight*1.32)*f+dy));
  ctx.fillStyle='#ffffff';ctx.shadowColor=selection.lighting==='plain'?'#00000055':'#fff8dccc';ctx.shadowBlur=selection.lighting==='plain'?6:22;
  draw(depth,depth);ctx.shadowBlur=0;ctx.fillStyle='#454844';
  for(let d=depth;d>=1;d-=1)draw(d,d);
  ctx.fillStyle=color;draw(0,0);
  return canvas;
}

function switchMode(value) {
  mode=value;
  for(const item of ['ar','photo']){$(`tab-${item}`).setAttribute('aria-pressed',String(value===item));$(`${item}-panel`).hidden=value!==item;}
  const url=new URL(location.href);url.searchParams.set('mode',value);history.replaceState(null,'',url);
  if(value==='ar'&&font)prepareAR();
  if(value==='photo')queueRender();
}

async function prepareAR() {
  if(arTask)return arTask;
  if(model)return;
  $('ar-retry').hidden=true;status('ar-status','Подготавливаем объёмные буквы…');
  arTask=(async()=>{
    const {createModel}=await import('./ar.bundle.js');
    const generated=await createModel(font,selection);
    const viewer=$('ar-viewer');
    model=generated;
    const ready=new Promise((resolve,reject)=>{
      const done=()=>{clearTimeout(timer);viewer.removeEventListener('load',loaded);viewer.removeEventListener('error',failed);};
      const loaded=()=>{done();resolve();},failed=()=>{done();reject(new Error('3D-просмотр недоступен на этом устройстве. Используйте примерку по фотографии.'));};
      const timer=setTimeout(failed,45000);viewer.addEventListener('load',loaded);viewer.addEventListener('error',failed);
    });
    viewer.iosSrc=generated.iosUrl;viewer.src=generated.url;
    await ready;
    status('ar-dimensions',`${cm(generated.size.width*100)} × ${cm(generated.size.height*100)} см · глубина ${cm(selection.depth)} см`);
    // AR capability selection is asynchronous inside model-viewer.
    for(let i=0;i<10&&!viewer.canActivateAR;i++)await new Promise(resolve=>setTimeout(resolve,100));
    viewer.dataset.ready='true';
    status('ar-status',viewer.canActivateAR?'Модель готова. Нажмите «Примерить на стене» под надписью.':'3D-модель готова. В этом браузере AR недоступен. Откройте ссылку в Safari на iPhone или совместимом Chrome на Android — либо выберите примерку по фото.');
  })().catch(error=>{
    if(model){URL.revokeObjectURL(model.url);URL.revokeObjectURL(model.iosUrl);model=null;}
    status('ar-status',error.message||'Не удалось подготовить AR. Попробуйте ещё раз или выберите фото.');$('ar-retry').hidden=false;
  }).finally(()=>{arTask=null;});
  return arTask;
}

$('ar-viewer').addEventListener('ar-status',e=>{
  const messages={'session-started':'Найдите стену, медленно перемещая телефон.','object-placed':'Надпись размещена. Можно посмотреть на неё с разных ракурсов.','failed':'Не удалось запустить AR. Проверьте разрешение камеры и поддержку телефона или используйте примерку по фото.'};
  if(messages[e.detail.status])status('ar-status',messages[e.detail.status]);
});

function resetPosition() {
  if(!photo||!decal)return;
  const w=Math.min(photo.width*.72,photo.height*.65*decal.width/decal.height),h=w*decal.height/decal.width;
  const x=(photo.width-w)/2,y=(photo.height-h)/2;
  points=[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];scale=100;rotation=0;
  $('photo-scale').value='100';$('photo-rotation').value='0';$('scale-value').value='100%';$('rotation-value').value='0°';queueRender();
}
function queueRender(){if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;render();});}
function render(target=$('photo-canvas'),handles=true) {
  if(!photo||!decal)return;
  if(target.width!==photo.width)target.width=photo.width;
  if(target.height!==photo.height)target.height=photo.height;
  const ctx=target.getContext('2d');ctx.clearRect(0,0,target.width,target.height);ctx.drawImage(photo,0,0);
  drawWarp(ctx,decal,points);
  if(!handles)return;
  const screenWidth=$('photo-canvas').getBoundingClientRect().width||600,f=photo.width/screenWidth;
  ctx.strokeStyle='#ffffff';ctx.lineWidth=1.5*f;ctx.setLineDash([5*f,4*f]);ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.stroke();ctx.setLineDash([]);
  for(const p of points){ctx.fillStyle='#edab43';ctx.beginPath();ctx.arc(p.x,p.y,7*f,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#fff';ctx.lineWidth=2*f;ctx.stroke();}
}

async function loadPhoto(file) {
  if(!file||!decal)return;
  const rev=++photoRevision;
  if(!file.type.startsWith('image/')||file.size>20*1024*1024){status('photo-status','Выберите фотографию JPG, PNG или WebP до 20 МБ.');return;}
  status('photo-status','Открываем фотографию…');
  const url=URL.createObjectURL(file);
  try{
    const image=new Image();image.src=url;await image.decode();
    if(rev!==photoRevision)return;
    if(!image.naturalWidth||image.naturalWidth*image.naturalHeight>60000000)throw new Error('Фото слишком большое. Выберите снимок до 60 мегапикселей.');
    const factor=Math.min(1,2048/Math.max(image.naturalWidth,image.naturalHeight));
    const next=document.createElement('canvas');next.width=Math.max(1,Math.round(image.naturalWidth*factor));next.height=Math.max(1,Math.round(image.naturalHeight*factor));
    next.getContext('2d').drawImage(image,0,0,next.width,next.height);photo=next;
    $('photo-empty').hidden=true;$('photo-controls').disabled=false;resetPosition();
    status('photo-status','Фото открыто. Перетащите надпись и подстройте её углы. Фотография остаётся на вашем устройстве.');
  }catch(e){if(rev===photoRevision)status('photo-status',e.message.startsWith('Фото')?e.message:'Не удалось открыть фото. Попробуйте JPG, PNG или WebP.');}
  finally{URL.revokeObjectURL(url);}
}
function position(e){const r=$('photo-canvas').getBoundingClientRect();return {x:(e.clientX-r.left)*photo.width/r.width,y:(e.clientY-r.top)*photo.height/r.height};}
function inside(p){return points.every((a,i)=>{const b=points[(i+1)%4];return (b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x)>=0;});}
function translate(dx,dy){
  const minX=Math.min(...points.map(p=>p.x)),maxX=Math.max(...points.map(p=>p.x)),minY=Math.min(...points.map(p=>p.y)),maxY=Math.max(...points.map(p=>p.y));
  dx=Math.max(-maxX+photo.width*.05,Math.min(photo.width*.95-minX,dx));dy=Math.max(-maxY+photo.height*.05,Math.min(photo.height*.95-minY,dy));
  points=points.map(p=>({x:p.x+dx,y:p.y+dy}));
}
$('photo-canvas').addEventListener('pointerdown',e=>{
  if(!photo||drag)return;const p=position(e),hit=26*photo.width/e.currentTarget.getBoundingClientRect().width;
  const index=points.findIndex(v=>Math.hypot(v.x-p.x,v.y-p.y)<hit);
  if(index<0&&!inside(p))return;
  drag={id:e.pointerId,index,last:p};e.currentTarget.setPointerCapture(e.pointerId);e.preventDefault();e.currentTarget.focus();
});
$('photo-canvas').addEventListener('pointermove',e=>{
  if(!drag||e.pointerId!==drag.id)return;const p=position(e);
  if(drag.index>=0){const next=points.map(v=>({...v}));next[drag.index]={x:clamp(p.x,-photo.width*.2,photo.width*1.2,0),y:clamp(p.y,-photo.height*.2,photo.height*1.2,0)};if(validQuad(next))points=next;}
  else translate(p.x-drag.last.x,p.y-drag.last.y);
  drag.last=p;queueRender();
});
for(const event of ['pointerup','pointercancel','lostpointercapture'])$('photo-canvas').addEventListener(event,()=>{drag=null;});
$('photo-canvas').addEventListener('keydown',e=>{if(!photo)return;const step=(e.shiftKey?10:2)*photo.width/600;const delta={ArrowLeft:[-step,0],ArrowRight:[step,0],ArrowUp:[0,-step],ArrowDown:[0,step]}[e.key];if(delta){e.preventDefault();translate(...delta);queueRender();}});

function transformPoints(ratio,angle) {
  const cx=points.reduce((s,p)=>s+p.x,0)/4,cy=points.reduce((s,p)=>s+p.y,0)/4;
  points=points.map(p=>{const x=(p.x-cx)*ratio,y=(p.y-cy)*ratio;return {x:cx+x*Math.cos(angle)-y*Math.sin(angle),y:cy+x*Math.sin(angle)+y*Math.cos(angle)};});queueRender();
}
$('photo-scale').addEventListener('input',e=>{const value=Number(e.target.value);transformPoints(value/scale,0);scale=value;$('scale-value').value=`${value}%`;});
$('photo-rotation').addEventListener('input',e=>{const value=Number(e.target.value);transformPoints(1,(value-rotation)*Math.PI/180);rotation=value;$('rotation-value').value=`${value}°`;});
$('photo-reset').onclick=resetPosition;
$('photo-save').onclick=()=>{
  if(!photo)return;
  const out=document.createElement('canvas');render(out,false);
  const filename=`vyveskimiru-tryon-${font.id}.png`;
  out.toBlob(blob=>{if(!blob){status('photo-status','Не удалось сохранить изображение. Попробуйте ещё раз.');return;}const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);status('photo-status','Примерка подготовлена для скачивания. Масштаб на фото подобран вручную.');},'image/png');
};
for(const id of ['photo-upload','empty-upload'])$(id).onclick=()=>$('photo-file').click();
$('photo-camera').onclick=()=>$('camera-file').click();
for(const id of ['photo-file','camera-file'])$(id).onchange=e=>{loadPhoto(e.target.files[0]);e.target.value='';};
for(const value of ['ar','photo'])$(`tab-${value}`).onclick=()=>switchMode(value);
$('ar-to-photo').onclick=()=>switchMode('photo');$('ar-retry').onclick=()=>prepareAR();
addEventListener('resize',queueRender);
addEventListener('pagehide',e=>{if(!e.persisted&&model){URL.revokeObjectURL(model.url);URL.revokeObjectURL(model.iosUrl);}});

async function boot() {
  try{
    selection=readSelection();$('back-link').href='./'+location.hash;
    const response=await fetch('assets/font-catalog.json');if(!response.ok)throw new Error('Каталог временно недоступен. Обновите страницу.');
    const catalog=await response.json();font=catalog.fonts.find(f=>f.id===selection.font);
    if(!font||!/^assets\/fonts\/[a-z0-9_.-]+$/i.test(font.file))throw new Error('Шрифт не найден. Выберите его заново в каталоге.');
    const value=selection.uppercase?selection.text.toLocaleUpperCase('ru'):selection.text;
    const has=cp=>font.supportedCodepoints?font.supportedCodepoints.includes(cp):font.supportedRanges?.some(([a,b])=>cp>=a&&cp<=b);
    const missing=[...new Set([...value].filter(c=>!/\s/u.test(c)&&!has(c.codePointAt(0))))];
    if(missing.length)throw new Error(`В выбранном шрифте нет символов: ${missing.join(' ')}. Измените надпись в каталоге.`);
    status('selection-summary',`${value} · ${font.family} · высота «Н» ${cm(selection.height)} см · глубина ${cm(selection.depth)} см`);
    const face=await new FontFace('vm_tryon',`url("${font.file}")`,{weight:String(font.weight)}).load();document.fonts.add(face);
    decal=createDecal();switchMode(mode);
  }catch(e){status('fatal-error',e.message||'Не удалось открыть вариант. Вернитесь в каталог.');$('fatal-error').hidden=false;for(const value of ['ar','photo']){$(`${value}-panel`).hidden=true;$(`tab-${value}`).disabled=true;}font=null;status('selection-summary','Откройте примерку из карточки выбранного шрифта.');}
}
boot();
