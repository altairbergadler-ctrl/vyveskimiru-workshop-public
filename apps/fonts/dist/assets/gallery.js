(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const PAGE = 18, MIN_STROKE = 1.6, STORAGE = 'vm-font-gallery-v1';
  const TAG_ORDER = ['Без засечек','С засечками','Жирные','Узкие','Широкие','Геометрические','Округлые','Рукописные','Декоративные','Моноширинные'];
  const FEATURED = ['Montserrat','Manrope','Oswald','Roboto Condensed','Golos Text','Rubik','Unbounded','Bebas Neue','Play','Russo One','Comfortaa','Nunito Sans','Exo 2','PT Sans','Jost','Raleway','Cormorant Garamond'];
  const DEFAULTS = {text:'ВывескиМиру',uppercase:false,lighting:'plain',scene:'graphite',material:'color',faceColor:'#f3ae45',height:30,depth:5,angle:15};
  const state = {...DEFAULTS, favorites:new Set(), compare:[], tags:new Set(), search:'', sort:'recommended', favoritesOnly:false, limit:PAGE, angle:15};
  let fonts=[], byId=new Map(), selected=null, observer, revision=0, inputTimer, toastTimer;
  const loaded=new Map(), fontQueue=[]; let fontBusy=0;
  const views=new Map();

  function clamp(value,min,max,fallback){const n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;}
  function settings(){return Object.fromEntries(Object.keys(DEFAULTS).map(k=>[k,state[k]]));}
  function safeSettings(data){
    const out={...DEFAULTS};
    if(!data || typeof data!=='object') return out;
    if(typeof data.text==='string') out.text=data.text.slice(0,100).split('\n').slice(0,3).join('\n');
    out.uppercase=data.uppercase===true;
    for(const [k,values] of Object.entries({lighting:['plain','face','halo'],scene:['graphite','plaster','brick','night'],material:['color','white','gold','silver']})) if(values.includes(data[k])) out[k]=data[k];
    if(/^#[a-f0-9]{6}$/i.test(data.faceColor||'')) out.faceColor=data.faceColor;
    out.height=clamp(data.height,5,200,30);out.depth=clamp(data.depth,1,30,5);out.angle=clamp(data.angle,-35,35,15);return out;
  }
  function save(){try{localStorage.setItem(STORAGE,JSON.stringify({...settings(),favorites:[...state.favorites],compare:state.compare}));}catch{}}
  function restore(){
    try{const s=JSON.parse(localStorage.getItem(STORAGE)||'null');if(s){Object.assign(state,safeSettings(s));state.favorites=new Set(Array.isArray(s.favorites)?s.favorites.filter(x=>typeof x==='string').slice(0,1000):[]);state.compare=Array.isArray(s.compare)?s.compare.filter(x=>typeof x==='string').slice(0,4):[];}}catch{}
    let sharedId=null;
    try{if(location.hash.startsWith('#v=')){const encoded=location.hash.slice(3);if(encoded.length<8000){const bytes=Uint8Array.from(atob(encoded.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));const shared=JSON.parse(new TextDecoder().decode(bytes));Object.assign(state,safeSettings(shared));if(typeof shared.font==='string')sharedId=shared.font;}}}catch{toast('Ссылка повреждена. Открыт обычный каталог.');}
    return sharedId;
  }
  function populateInputs(){
    $('lettering').value=state.text;$('uppercase').checked=state.uppercase;$('angle').value=state.angle;$('angle-value').textContent=state.angle+'°';
    for(const [id,key] of Object.entries({lighting:'lighting',scene:'scene',material:'material','face-color':'faceColor','letter-height':'height','letter-depth':'depth'}))$(id).value=state[key];
  }
  function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4000);}
  function element(tag,className,text){const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;}
  function text(){return state.uppercase?state.text.toLocaleUpperCase('ru'):state.text;}
  function fontName(font){return 'vm_'+font.id.replace(/[^a-z0-9_-]/gi,'_');}
  function ensureFont(font){
    if(loaded.has(font.id))return loaded.get(font.id);
    const promise=new Promise((resolve,reject)=>{fontQueue.push({font,resolve,reject});pump();});loaded.set(font.id,promise);return promise;
  }
  function pump(){
    while(fontBusy<4 && fontQueue.length){const item=fontQueue.shift();fontBusy++;
      const path=item.font.file;
      if(typeof path!=='string'||!/^assets\/fonts\/[a-z0-9_.-]+$/i.test(path)){item.reject(new Error('Invalid font asset'));fontBusy--;continue;}
      const face=new FontFace(fontName(item.font),`url("${path}")`,{weight:String(item.font.weight),style:'normal'});
      face.load().then(f=>{document.fonts.add(f);item.resolve(f);}).catch(e=>{loaded.delete(item.font.id);item.reject(e);}).finally(()=>{fontBusy--;pump();});
    }
  }
  const colorRGB = hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));
  function darken(hex,factor){const c=colorRGB(hex);return `rgb(${c.map(v=>Math.round(v*factor)).join(',')})`;}
  function background(ctx,w,h){
    const palettes={graphite:['#3b443f','#222c27'],plaster:['#ebe8de','#d6d4c9'],brick:['#856752','#5b4235'],night:['#101d26','#080f17']};
    const p=palettes[state.scene];const gradient=ctx.createLinearGradient(0,0,w,h);gradient.addColorStop(0,p[0]);gradient.addColorStop(1,p[1]);ctx.fillStyle=gradient;ctx.fillRect(0,0,w,h);
    if(state.scene==='brick'){ctx.strokeStyle='#342b2545';ctx.lineWidth=3;const row=h/7;for(let y=0;y<h;y+=row){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();const offset=(Math.round(y/row)%2)*w/8;for(let x=offset;x<w;x+=w/4){ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x,y+row);ctx.stroke();}}}
    else if(state.scene==='graphite'){ctx.strokeStyle='#c7d9ca0b';ctx.lineWidth=1;for(let y=h/4;y<h;y+=h/4){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}}
    const vignette=ctx.createRadialGradient(w*.5,h*.35,w*.12,w*.5,h*.5,w*.7);vignette.addColorStop(0,'#ffffff05');vignette.addColorStop(1,'#0000002b');ctx.fillStyle=vignette;ctx.fillRect(0,0,w,h);
  }
  function unsupported(font){if(!Array.isArray(font.supportedCodepoints)&&!Array.isArray(font.supportedRanges))return [];const set=Array.isArray(font.supportedCodepoints)?new Set(font.supportedCodepoints):null;const has=cp=>set?set.has(cp):font.supportedRanges.some(([start,end])=>cp>=start&&cp<=end);return [...new Set([...text()].filter(c=>!/[\s]/u.test(c)&&!has(c.codePointAt(0))))];}
  function layout(ctx,font){
    ctx.textAlign='left';ctx.textBaseline='alphabetic';ctx.font=`${font.weight} 1000px "${fontName(font)}"`;ctx.fontKerning='normal';
    const reference=ctx.measureText('Н');const refHeight=reference.actualBoundingBoxAscent+reference.actualBoundingBoxDescent;
    const lines=text().split('\n').slice(0,3);const data=lines.map(t=>{const m=ctx.measureText(t||' ');return {text:t,m,width:m.actualBoundingBoxLeft+m.actualBoundingBoxRight,advance:m.width,ascent:m.actualBoundingBoxAscent,descent:m.actualBoundingBoxDescent};});
    const widest=Math.max(...data.map(d=>d.width),1);const top=Math.max(data[0].ascent,refHeight*.3);const last=data.at(-1);const vertical=top+(data.length-1)*refHeight*1.32+last.descent;
    return {lines:data,refHeight:refHeight||700,width:widest,height:Math.max(vertical,refHeight),top,widthCm:widest/(refHeight||700)*state.height,heightCm:Math.max(vertical,refHeight)/(refHeight||700)*state.height};
  }
  function drawPreview(canvas,font,angle=15){
    const ctx=canvas.getContext('2d');const w=canvas.width,h=canvas.height;background(ctx,w,h);
    if(!text().trim()){ctx.fillStyle=state.scene==='plaster'?'#787a70':'#acb7aa';ctx.textAlign='center';ctx.font='22px Arial';ctx.fillText('Введите надпись',w/2,h/2);return null;}
    const missing=unsupported(font);
    if(missing.length){ctx.fillStyle=state.scene==='plaster'?'#787a70':'#c0c8b9';ctx.textAlign='center';ctx.font='20px Arial';ctx.fillText('В шрифте нет символов:',w/2,h/2-15);ctx.fillText(missing.slice(0,15).join(' '),w/2,h/2+18);return {missing};}
    const l=layout(ctx,font),radians=angle*Math.PI/180,projection=Math.cos(radians);
    const depthRef=state.depth/state.height*l.refHeight;const dxRef=depthRef*Math.sin(radians)*.9;const dyRef=depthRef*.24;
    const scale=Math.min((w-70)/(l.width*projection+Math.abs(dxRef)+30),(h-90)/(l.height+Math.abs(dyRef)+40));
    const pxPerCm=scale*l.refHeight/state.height;
    const layer=document.createElement('canvas');layer.width=Math.ceil(l.width*scale+24);layer.height=Math.ceil(l.height*scale+24);
    const c=layer.getContext('2d');c.textBaseline='alphabetic';c.font=`${font.weight} ${1000*scale}px "${fontName(font)}"`;c.fontKerning='normal';c.fillStyle='#fff';
    l.lines.forEach((row,index)=>c.fillText(row.text,12+(l.width-row.width)*scale/2+row.m.actualBoundingBoxLeft*scale,12+(l.top+index*l.refHeight*1.32)*scale));
    const centerX=(w-layer.width*projection)/2-dxRef*scale/2;const centerY=(h-layer.height)/2-dyRef*scale/2;
    ctx.save();ctx.translate(centerX,centerY);ctx.scale(projection,1);
    const dx=dxRef*scale/projection,dy=dyRef*scale;
    const mask=(fill)=>{const surface=document.createElement('canvas');surface.width=layer.width;surface.height=layer.height;const s=surface.getContext('2d');s.drawImage(layer,0,0);s.globalCompositeOperation='source-in';s.fillStyle=fill;s.fillRect(0,0,surface.width,surface.height);return surface;};
    const faceColor=state.material==='white'?'#f1f0e8':state.faceColor;
    let faceFill=faceColor;
    if(state.material==='gold'||state.material==='silver'){const g=c.createLinearGradient(0,0,layer.width*.35,layer.height);const stops=state.material==='gold'?['#b18d45','#f5d88d','#bf9948','#efddaa']:['#829097','#e6edf0','#98a2a6','#d8dfe1'];stops.forEach((v,i)=>g.addColorStop(i/3,v));faceFill=g;}
    const face=mask(faceFill);const side=mask(state.material==='gold'?'#796033':state.material==='silver'?'#606c70':darken(faceColor,.47));
    ctx.shadowColor='#0000007a';ctx.shadowBlur=11;ctx.shadowOffsetX=7;ctx.shadowOffsetY=12;ctx.drawImage(side,dx,dy);ctx.shadowColor='transparent';ctx.shadowBlur=0;ctx.shadowOffsetX=0;ctx.shadowOffsetY=0;
    if(state.lighting==='halo'){ctx.shadowColor=faceColor;ctx.shadowBlur=state.scene==='night'?34:23;ctx.drawImage(face,dx*1.1,dy*1.1);ctx.drawImage(face,dx*1.1,dy*1.1);ctx.shadowColor='transparent';ctx.shadowBlur=0;}
    for(let step=24;step>=1;step--)ctx.drawImage(side,dx*step/24,dy*step/24);
    if(state.lighting==='face'){ctx.shadowColor=faceColor;ctx.shadowBlur=state.scene==='night'?20:8;ctx.drawImage(face,0,0);ctx.shadowColor='transparent';ctx.shadowBlur=0;}
    ctx.drawImage(face,0,0);ctx.restore();
    return {...l,missing:[],pxPerCm};
  }
  function cm(value){return new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(value);}
  function strokeText(m){
    if(!m||m.confidence==='unknown'||!Number.isFinite(m.estimatedStrokeCm))return 'Толщина: уточняется по макету';
    const value=m.estimatedStrokeCm;
    return `Стойка «Н» ≈ ${cm(value)} см${m.meetsMinimum===false?` · для 1,6 см: высота «Н» от ${Math.ceil(m.suggestedHeightCm)} см`:' · ориентировочно'}`;
  }
  async function renderView(canvas){
    const view=views.get(canvas);if(!view||!canvas.isConnected)return;const myRevision=revision;
    try{await ensureFont(view.font);if(!canvas.isConnected||myRevision!==revision||views.get(canvas)!==view)return;
      const result=drawPreview(canvas,view.font,view.angle??15);canvas.dataset.revision=String(revision);if(view.loading)view.loading.hidden=true;
      if(view.dimensions)view.dimensions.textContent=result?.missing?.length?'Нет нужных символов':result?`Ширина ≈ ${cm(result.widthCm)} см · высота «Н» ${cm(state.height)} см`:'Введите надпись';
      if(view.glyphs){const miss=unsupported(view.font);view.glyphs.hidden=!miss.length;view.glyphs.textContent=miss.length?`Этот шрифт не содержит: ${miss.join(' ')}. Выберите другой шрифт или измените надпись.`:'';}
      if(view.stroke){const metric=window.FontStroke?await window.FontStroke.measure(fontName(view.font),view.font.weight,state.height):null;if(myRevision===revision&&canvas.isConnected&&views.get(canvas)===view)view.stroke.textContent=strokeText(metric);}
    }catch{if(views.get(canvas)!==view||!canvas.isConnected)return;if(view.loading){view.loading.hidden=false;view.loading.replaceChildren(element('span',null,'Не удалось загрузить шрифт'));const retry=element('button',null,'Повторить');retry.type='button';retry.onclick=()=>renderView(canvas);view.loading.append(retry);}else toast('Не удалось загрузить выбранный шрифт. Попробуйте ещё раз.');}
  }
  function queueVisible(){revision++;for(const [canvas] of views){const r=canvas.getBoundingClientRect();if(r.width>0&&r.bottom>=-100&&r.top<innerHeight+100)renderView(canvas);}}
  function makeCard(font,isCompare=false){
    const card=element('article','font-card');card.dataset.fontId=font.id;
    const wrap=element('div','preview-wrap');const canvas=element('canvas');canvas.width=800;canvas.height=444;canvas.setAttribute('role','img');canvas.setAttribute('aria-label',`Надпись «${text()}», шрифт ${font.family}`);wrap.append(canvas);
    const loading=element('div','canvas-loading','Загружаем начертание…');wrap.append(loading);
    const favorite=element('button','favorite-button',state.favorites.has(font.id)?'♥':'♡');favorite.type='button';favorite.dataset.favorite=font.id;favorite.setAttribute('aria-label',`${state.favorites.has(font.id)?'Удалить из избранного':'В избранное'}: ${font.family}`);favorite.setAttribute('aria-pressed',String(state.favorites.has(font.id)));favorite.onclick=()=>toggleFavorite(font.id);wrap.append(favorite);
    const info=element('div','card-info');const heading=element('div','card-heading');heading.append(element('h3',null,font.family),element('span','weight-label',String(font.weight)));info.append(heading);
    const tags=element('div','card-tags');font.tags.slice(0,3).forEach(t=>tags.append(element('span',null,t)));info.append(tags);
    const dimensions=element('p','card-metric','Размер появится после загрузки');const stroke=element('p','card-stroke','Толщина: ориентир по стойке «Н»');const glyphs=element('p','glyph-warning');glyphs.hidden=true;info.append(dimensions,stroke,glyphs);
    const actions=element('div','card-actions');const open=element('button','quiet-button','Рассмотреть');open.type='button';open.onclick=()=>openDetail(font.id);actions.append(open);
    if(!isCompare){const compare=element('button','quiet-button compare-toggle',state.compare.includes(font.id)?'✓ В сравнении':'+ Сравнить');compare.type='button';compare.dataset.compare=font.id;compare.setAttribute('aria-pressed',String(state.compare.includes(font.id)));compare.onclick=()=>toggleCompare(font.id);actions.append(compare);}
    info.append(actions);card.append(wrap,info);views.set(canvas,{font,loading,dimensions,stroke,glyphs});
    observer.observe(canvas);return card;
  }
  function filtered(){
    const query=state.search.trim().toLocaleLowerCase('ru');
    let result=fonts.filter(f=>(!state.favoritesOnly||state.favorites.has(f.id))&&[...state.tags].every(t=>f.tags.includes(t))&&(!query||`${f.family} ${f.tags.join(' ')}`.toLocaleLowerCase('ru').includes(query)));
    if(state.sort==='alphabet')result.sort((a,b)=>a.family.localeCompare(b.family,'ru'));
    else if(state.sort==='weight')result.sort((a,b)=>b.weight-a.weight||a.family.localeCompare(b.family,'ru'));
    else result.sort((a,b)=>{const ai=FEATURED.indexOf(a.family),bi=FEATURED.indexOf(b.family);return(ai<0?999:ai)-(bi<0?999:bi)||(a.catalogPopularity??9999)-(b.catalogPopularity??9999)||a.family.localeCompare(b.family,'ru');});
    return result;
  }
  function renderGrid(){
    for(const [c] of views)if(c.closest('#font-grid')){observer.unobserve(c);views.delete(c);}
    const all=filtered();$('font-grid').replaceChildren(...all.slice(0,state.limit).map(f=>makeCard(f)));
    $('result-count').textContent=`${all.length} из ${fonts.length} · высота «Н» ${cm(state.height)} см`;
    $('empty').hidden=all.length>0;$('load-more').hidden=state.limit>=all.length;$('load-more').textContent=`Показать ещё ${Math.min(PAGE,all.length-state.limit)}`;
    $('favorites-only').setAttribute('aria-pressed',String(state.favoritesOnly));$('favorite-count').textContent=state.favorites.size;
    document.querySelectorAll('#tags button').forEach(b=>b.setAttribute('aria-pressed',String(state.tags.has(b.dataset.tag))));
  }
  function buildTags(){const all=new Set(fonts.flatMap(f=>f.tags));const order=[...TAG_ORDER.filter(t=>all.has(t)),...[...all].filter(t=>!TAG_ORDER.includes(t)).sort()];$('tags').replaceChildren(...order.map(tag=>{const b=element('button','tag');b.type='button';b.dataset.tag=tag;b.setAttribute('aria-pressed','false');b.append(document.createTextNode(tag),element('small',null,String(fonts.filter(f=>f.tags.includes(tag)).length)));b.onclick=()=>{state.tags.has(tag)?state.tags.delete(tag):state.tags.add(tag);state.limit=PAGE;renderGrid();};return b;}));}
  function toggleFavorite(id){state.favorites.has(id)?state.favorites.delete(id):state.favorites.add(id);save();$('favorite-count').textContent=state.favorites.size;document.querySelectorAll('[data-favorite]').forEach(b=>{const yes=state.favorites.has(b.dataset.favorite);b.textContent=yes?'♥':'♡';b.setAttribute('aria-pressed',String(yes));const font=byId.get(b.dataset.favorite);b.setAttribute('aria-label',`${yes?'Удалить из избранного':'В избранное'}: ${font?.family||''}`);});if(state.favoritesOnly)renderGrid();syncDetailButtons();}
  function toggleCompare(id){if(state.compare.includes(id))state.compare=state.compare.filter(x=>x!==id);else if(state.compare.length<4)state.compare.push(id);else{toast('В сравнении уже 4 шрифта. Уберите один из вариантов.');return;}save();syncCompare();syncDetailButtons();}
  function syncCompare(){const chosen=state.compare.map(id=>byId.get(id)).filter(Boolean);$('comparison-bar').hidden=!chosen.length;$('compare-count').textContent=chosen.length;$('compare-names').textContent=chosen.map(f=>f.family).join(' · ');$('compare-open').disabled=chosen.length<2;document.querySelectorAll('[data-compare]').forEach(b=>{const yes=state.compare.includes(b.dataset.compare);b.textContent=yes?'✓ В сравнении':'+ Сравнить';b.setAttribute('aria-pressed',String(yes));});}
  function syncDetailButtons(){if(!selected)return;$('detail-favorite').textContent=state.favorites.has(selected.id)?'♥ В избранном':'♡ В избранное';$('detail-favorite').setAttribute('aria-pressed',String(state.favorites.has(selected.id)));$('detail-compare').textContent=state.compare.includes(selected.id)?'✓ В сравнении':'+ К сравнению';}
  async function openDetail(id){
    const font=byId.get(id);if(!font)return;selected=font;$('detail-title').textContent=font.family;$('detail-license').href=font.license.file;$('share-fallback').hidden=true;syncDetailButtons();
    const canvas=$('detail-canvas');views.set(canvas,{font,angle:state.angle,dimensions:$('detail-dimensions'),stroke:$('detail-stroke'),glyphs:$('detail-glyphs')});
    $('detail-dimensions').textContent='Загружаем начертание…';$('detail-stroke').textContent='';background(canvas.getContext('2d'),canvas.width,canvas.height);
    if(!$('detail-dialog').open)$('detail-dialog').showModal();await renderView(canvas);
  }
  function openCompare(){
    for(const [c] of views)if(c.closest('#compare-grid')){observer.unobserve(c);views.delete(c);}
    $('compare-grid').replaceChildren(...state.compare.map(id=>byId.get(id)).filter(Boolean).map(f=>makeCard(f,true)));$('compare-dialog').showModal();for(const c of $('compare-grid').querySelectorAll('canvas'))renderView(c);
  }
  async function share(){if(!selected)return;const payload={...settings(),font:selected.id};const bytes=new TextEncoder().encode(JSON.stringify(payload));let binary='';bytes.forEach(b=>binary+=String.fromCharCode(b));const hash=btoa(binary).replace(/\+/g,'-').replace(/\//g,'_');const url=location.origin+location.pathname+'#v='+hash;try{await navigator.clipboard.writeText(url);toast('Ссылка на вариант скопирована');}catch{$('share-fallback').hidden=false;$('share-url').value=url;$('share-url').select();}}
  function tryOn(mode){if(!selected)return;if(!text().trim()){toast('Введите надпись перед примеркой.');return;}const missing=unsupported(selected);if(missing.length){toast('В шрифте нет символов: '+missing.join(' '));return;}const bytes=new TextEncoder().encode(JSON.stringify({...settings(),font:selected.id}));let binary='';bytes.forEach(b=>binary+=String.fromCharCode(b));location.href='tryon.html?mode='+mode+'#v='+btoa(binary).replace(/\+/g,'-').replace(/\//g,'_');}
  async function download(){if(!selected)return;const font=selected,fingerprint=JSON.stringify(settings());try{await ensureFont(font);}catch{toast('Не удалось загрузить шрифт для сохранения');return;}if(selected!==font||JSON.stringify(settings())!==fingerprint){toast('Вариант изменился. Повторите сохранение.');return;}const canvas=document.createElement('canvas');canvas.width=1800;canvas.height=1050;const result=drawPreview(canvas,font,state.angle);if(result?.missing?.length){toast('Не все символы есть в этом шрифте. Сначала измените надпись.');return;}const ctx=canvas.getContext('2d');ctx.fillStyle=state.scene==='plaster'?'#60665a':'#c4cec2';ctx.font='19px Arial';ctx.textAlign='left';ctx.fillText(`${font.family} · ${font.weight} · высота «Н» ${cm(state.height)} см · глубина ${cm(state.depth)} см`,40,990);ctx.fillText('ВывескиМиру · визуальный ориентир · ширина штриха от 1,6 см, требуется проверка макета',40,1025);canvas.toBlob(blob=>{if(!blob){toast('Не удалось сохранить изображение');return;}const url=URL.createObjectURL(blob);const a=element('a');a.href=url;a.download=`vyveskimiru-${font.id}.png`;a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);},'image/png');}
  async function boot(){
    $('load-error').hidden=true;
    try{const response=await fetch('assets/font-catalog.json',{cache:'no-cache'});if(!response.ok)throw new Error('Catalog unavailable');const data=await response.json();if(!Array.isArray(data.fonts)||!data.fonts.length)throw new Error('Catalog invalid');
      fonts=data.fonts.filter(f=>f&&typeof f.id==='string'&&typeof f.family==='string'&&Array.isArray(f.tags)&&(Array.isArray(f.supportedRanges)||Array.isArray(f.supportedCodepoints))&&f.license&&/^assets\/licenses\/[a-z0-9_.-]+$/i.test(f.license.file||''));byId=new Map(fonts.map(f=>[f.id,f]));if(!fonts.length)throw new Error('No valid fonts');
      state.favorites=new Set([...state.favorites].filter(id=>byId.has(id)));state.compare=state.compare.filter(id=>byId.has(id));$('catalog-size').textContent=fonts.length;
      buildTags();renderGrid();syncCompare();save();
      $('license-list').replaceChildren(...[...fonts].sort((a,b)=>a.family.localeCompare(b.family)).map(f=>{const row=element('div','license-entry');row.append(element('span',null,`${f.family} · ${f.weight}`));const a=element('a',null,f.license.type||'Лицензия');a.href=f.license.file;a.target='_blank';a.rel='noopener';row.append(a);return row;}));
      if(sharedFontId&&byId.has(sharedFontId)){openDetail(sharedFontId);sharedFontId=null;}
    }catch{$('load-error').hidden=false;$('result-count').textContent='Каталог временно недоступен';}
  }
  let sharedFontId=restore();populateInputs();
  observer=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting&&e.target.dataset.revision!==String(revision))renderView(e.target);}),{rootMargin:'160px'});
  const changeSettings=()=>{state.text=$('lettering').value.slice(0,100).split('\n').slice(0,3).join('\n');state.uppercase=$('uppercase').checked;state.lighting=$('lighting').value;state.scene=$('scene').value;state.material=$('material').value;state.faceColor=$('face-color').value;state.height=clamp($('letter-height').value,5,200,30);state.depth=clamp($('letter-depth').value,1,30,5);save();queueVisible();const count=filtered().length;$('result-count').textContent=`${count} из ${fonts.length} · высота «Н» ${cm(state.height)} см`;};
  for(const id of ['lettering','uppercase','lighting','scene','material','face-color','letter-height','letter-depth'])$(id).addEventListener('input',()=>{clearTimeout(inputTimer);inputTimer=setTimeout(changeSettings,id==='lettering'?160:50);});
  for(const id of ['letter-height','letter-depth'])$(id).addEventListener('change',()=>{changeSettings();$(id).value=id==='letter-height'?state.height:state.depth;});
  $('search').addEventListener('input',()=>{state.search=$('search').value;state.limit=PAGE;renderGrid();});$('sort').onchange=()=>{state.sort=$('sort').value;state.limit=PAGE;renderGrid();};
  $('favorites-only').onclick=()=>{state.favoritesOnly=!state.favoritesOnly;state.limit=PAGE;renderGrid();};$('clear-filters').onclick=()=>{state.tags.clear();state.search='';state.favoritesOnly=false;state.limit=PAGE;$('search').value='';renderGrid();};$('load-more').onclick=()=>{state.limit+=PAGE;renderGrid();};
  $('compare-clear').onclick=()=>{state.compare=[];save();syncCompare();syncDetailButtons();};$('compare-open').onclick=openCompare;
  $('detail-favorite').onclick=()=>selected&&toggleFavorite(selected.id);$('detail-compare').onclick=()=>selected&&toggleCompare(selected.id);
  $('angle').oninput=()=>{state.angle=Number($('angle').value);save();$('angle-value').textContent=state.angle+'°';const view=views.get($('detail-canvas'));if(view){view.angle=state.angle;renderView($('detail-canvas'));}};
  $('share').onclick=share;$('download-png').onclick=download;$('retry-catalog').onclick=boot;$('licenses-open').onclick=()=>$('licenses-dialog').showModal();
  $('try-ar').onclick=()=>tryOn('ar');$('try-photo').onclick=()=>tryOn('photo');
  document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
  for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
  boot();
})();
