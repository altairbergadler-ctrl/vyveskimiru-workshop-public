/* Calibration is local. Explicit AI generation is handled by generation.js. */
'use strict';
const G = window.LetterGeometry, $ = id => document.getElementById(id);
let imageMeta=null, photoData='', projectPoints=[], center=null, target=null, measurements=[], checks=[], action='', pending=[], report=null, imported=null;
let photoRevision=0, photoKey=null;
const newPhotoKey=()=>typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random().toString(36).slice(2)}`;
let photoViewport=null, resetViewport=false;
let objectDrag=null;
let compositionDrag=null;
let facade=null, facadeDrag=null, facadeAlignments=[];
let dragChangePending=false;
const dragging=()=>Boolean(facadeDrag||compositionDrag||objectDrag);
const F=window.SignageFacadeUI;
// Editing can show recoverable object errors; export/generation still use report.
let previewReport=null;
let rulerPoints=[], rulerHover=null, rulerCalibration=null, rulerCalibrationError='';
const controls=['referenceLength','referenceWidth','referenceHeight','text','signWidth','signHeight','lineGap','textAlign','depth','rotation','frontColor','sideColor','font','brief','faceMaterialType','filmSeries','filmColorCode','filmFinish','filmAcrylic','filmLedTemperature','filmDayLighting'];
const numeric = id => Number($(id).value);
const independentSigns=()=>window.SignageProductUI?.renderer()==='channel_letters'&&window.SignageLetterUI?.independent?.()===true;
const signText = () => G.textLines($('text').value).join('\n');
function faceMaterial(){
  const extra=window.SignageProductUI?.materialMetadata()||imported?.sign?.face_material||{};
  if($('faceMaterialType').value==='custom')return {...extra,type:'custom'};
  return {...extra,type:'film_on_acrylic',brand:'ORACAL',series:$('filmSeries').value.trim(),color_code:$('filmColorCode').value.trim(),finish:$('filmFinish').value,acrylic:$('filmAcrylic').value,led_temperature_k:$('filmLedTemperature').value.trim()===''?null:numeric('filmLedTemperature'),day_lighting:$('filmDayLighting').value};
}
function updateMaterialFields(){
  const film=$('faceMaterialType').value==='film_on_acrylic';
  ['filmMaterialFields','filmColorHint','materialPriorityHint'].forEach(id=>$(id).hidden=!film);
}
let metricCache=null;
function previewLineMetrics(text){
  if(metricCache?.text===text)return metricCache.metrics;
  const ctx=document.createElement('canvas').getContext('2d');ctx.font='700 100px Arial';
  const metrics={font_size_px:100,font_family:'Arial',font_weight:700,lines:text.split('\n').map(line=>{
    const m=ctx.measureText(line);
    return {text:line,width:m.width,actualBoundingBoxAscent:m.actualBoundingBoxAscent,actualBoundingBoxDescent:m.actualBoundingBoxDescent,actualBoundingBoxLeft:m.actualBoundingBoxLeft,actualBoundingBoxRight:m.actualBoundingBoxRight};
  })};
  metricCache={text,metrics};return metrics;
}
function project() {
  const rectangle=$('calibrationMode').value==='rectangle',text=window.SignageProductUI?.renderer()==='channel_letters'&&window.SignageLetterUI?.summaryText?window.SignageLetterUI.summaryText().slice(0,300):signText();
  const base={...(imported||{}),version:1,image:imageMeta,calibration:{...(imported?.calibration||{}),mode:rectangle?'rectangle':'frontoparallel',plane:imported?.calibration?.plane||'Плоскость установки',image_points:projectPoints,...(rectangle?{width_cm:numeric('referenceWidth'),height_cm:numeric('referenceHeight')}:{length_cm:numeric('referenceLength'),frontoparallel_assumed:true})},placement:center?{...(imported?.placement||{}),center_px:center,width_cm:numeric('signWidth'),height_cm:numeric('signHeight'),rotation_deg:numeric('rotation')}:null,sign:{...(imported?.sign||{}),text,line_gap_cm:numeric('lineGap'),text_align:$('textAlign').value,font_family:$('font').value,font_bold:window.SignageCorel?.settings().font_bold??imported?.sign?.font_bold??true,preview_line_metrics:previewLineMetrics(text),preview_font_status:'Эскиз Arial; точное начертание сверить с ТЗ или векторным оригиналом',front_color:$('frontColor').value,side_color:$('sideColor').value,face_material:faceMaterial(),depth_cm:numeric('depth'),brief:$('brief').value,size_basis:'Габарит всей композиции с учётом строк и межстрочных зазоров, не высота каждой буквы'},target_polygon_px:target,measurements,ruler:{...(imported?.ruler||{}),image_points:rulerPoints.map(p=>[...p]),same_plane:$('rulerSamePlane').checked},checks,assumptions:imported?.assumptions||[],spec_source:imported?.spec_source||null,generation:{...(imported?.generation||{}),...(window.SignageGeneration?.settings()||{})}};
  if(window.SignageProductUI?.renderer()==='channel_letters'&&window.SignageLetterUI){
    Object.assign(base.sign,window.SignageLetterUI.settings());
    delete base.sign.line_styles;delete base.sign.logo;
    base.sign.composition_mode=independentSigns()?'independent_signs_v1':'independent_objects_v1';
    base.sign.size_basis=independentSigns()?'Каждая вывеска имеет собственные размер, положение и поворот в плоскости установки':'Габарит всей композиции; каждый объект имеет собственные размер, положение и поворот';
    if(independentSigns())base.placement=null;
    if(window.SignageLetterUI.hasOverrides())base.sign.preview_font_status='Эскиз доступными на этом устройстве шрифтами; начертание сверить с оригиналом';
  }
  if(facade)base.facade=F.normalize(facade);else delete base.facade;
  return window.SignageProductUI?.compose(base)||base;
}
function resetGeometry(){cancelDrag();facade=null;window.SignageProductUI?.resetPlacement();projectPoints=[];center=null;target=null;measurements=[];checks=[];rulerPoints=[];rulerHover=null;$('rulerSamePlane').checked=true;action='';pending=[];imported=null;window.SignageGeneration?.restore(null);window.SignageCorel?.restore(null);}
function setMode(mode) {
  if(!imageMeta){$('instruction').textContent='Сначала загрузите фотографию или откройте пример.';return;}
  cancelDrag();
  photoViewport?.cancelPan();
  action=mode;pending=[];rulerHover=null;
  $('instruction').textContent={reference:$('calibrationMode').value==='rectangle'?'Отметьте 4 угла: левый верхний → правый верхний → правый нижний → левый нижний.':'Нажмите на два конца отрезка с известной длиной.',place:'Нажмите на центр будущей вывески.',target:'Отметьте прямоугольный участок фасада: левый верхний → правый верхний → правый нижний → левый нижний. Противоположные края параллельны в реальности.',facadeEdges:'Отметьте по точке между углами прямых краёв: верхний → правый → нижний → левый. Точки показывают изгиб объектива.',editRegion:'Отметьте 4 угла зоны замены по периметру. В ней ИИ может убрать старую вывеску, восстановить фон и разместить новое изделие.',measure:'Линейка: левый клик добавляет точку, правый клик по точке удаляет её. Esc — выйти; Delete / Backspace — убрать последнюю точку.'}[mode]||'Точки сохранены. Можно изменить ТЗ или сделать замер.';
  render();
}
function calibrationSignature(){return JSON.stringify({mode:$('calibrationMode').value,points:projectPoints,length:numeric('referenceLength'),width:numeric('referenceWidth'),height:numeric('referenceHeight'),facade,target});}
function updateMode(){const rect=$('calibrationMode').value==='rectangle';$('frontFields').hidden=rect;$('rectangleFields').hidden=!rect;}
function renderFacadeControls(){
  const enabled=facade?.enabled===true,calibration=previewReport?.calibration||rulerCalibration;
  $('facadeEnabled').checked=enabled;$('facadeEnabled').disabled=!imageMeta;$('facadeOptions').hidden=!enabled;
  $('facadeLens').checked=facade?.lens_enabled===true;$('facadeGrid').checked=facade?.grid_visible!==false;
  $('facadeGridStep').value=facade?.grid_step_cm||50;$('facadeSnapElements').checked=facade?.snap_elements!==false;$('facadeSnapGrid').checked=facade?.snap_grid!==false;
  $('facadeEdges').disabled=!enabled||!facade.lens_enabled||target?.length!==4;
  const format=number=>Number.isFinite(number)?`${new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(number)} см`:'—';
  $('facadeZoneWidth').value=enabled?format(calibration?.zone_info?.width_cm):'—';$('facadeZoneHeight').value=enabled?format(calibration?.zone_info?.height_cm):'—';
  $('facadeStatus').textContent=!enabled?'':target?.length!==4?'Отметьте область установки на фото.':!calibration?`Размеры не рассчитаны. ${rulerCalibrationError}`:(calibration.warnings||[]).join(' ')||'Масштаб сохранён. Элементы вписываются в плоскость фасада; ракурс фото не меняется.';
}
function changeFacade(){
  cancelDrag();facade=facade||F.defaults();facade.enabled=$('facadeEnabled').checked;
  facade.lens_enabled=$('facadeLens').checked;facade.grid_visible=$('facadeGrid').checked;facade.snap_elements=$('facadeSnapElements').checked;facade.snap_grid=$('facadeSnapGrid').checked;
  render();
}
['facadeEnabled','facadeLens','facadeGrid','facadeSnapElements','facadeSnapGrid'].forEach(id=>$(id).addEventListener('change',changeFacade));
$('facadeGridStep').addEventListener('change',()=>{const step=numeric('facadeGridStep');if(!Number.isFinite(step)||step<5){$('facadeStatus').textContent='Шаг сетки должен быть от 5 см.';return;}cancelDrag();facade=facade||F.defaults();facade.grid_step_cm=step;render();});
$('facadeEdges').onclick=()=>setMode('facadeEdges');
function makeSvg(tag,attrs){const n=document.createElementNS('http://www.w3.org/2000/svg',tag);Object.entries(attrs).forEach(([k,v])=>n.setAttribute(k,v));return n;}
function drawPoints(){
  const overlay=$('overlay');
  if (!imageMeta || !photoData) {overlay.replaceChildren();return;}
  overlay.setAttribute('viewBox',`0 0 ${imageMeta.width_px} ${imageMeta.height_px}`);
  if(previewReport){const parsed=new DOMParser().parseFromString(G.overlaySvg(project(),previewReport,'',{includeText:false,includeRuler:false,includeReference:false,includeCaption:false}),'image/svg+xml');overlay.replaceChildren(...Array.from(parsed.documentElement.childNodes).map(n=>document.importNode(n,true)));}
  else overlay.replaceChildren();
  const zone=overlay.querySelector('polygon[fill="#ffb454"]');
  if(zone)zone.setAttribute('data-composition-zone','true');
  // Editing handles keep their CSS-pixel size even when a large photo is fitted.
  const scale=$('image').getBoundingClientRect().width/imageMeta.width_px;
  const unit=Number.isFinite(scale)&&scale>0?1/scale:1;
  if(projectPoints.length){const line=projectPoints.length===4?[...projectPoints,projectPoints[0]]:projectPoints;overlay.append(makeSvg('polyline',{points:line.map(p=>p.join(',')).join(' '),stroke:'#2dd4bf','stroke-width':2.5*unit,fill:'none'}));}
  const editZone=window.SignageGeneration?.settings().edit_polygon_px;
  if(editZone?.length===4)overlay.append(makeSvg('polygon',{points:editZone.map(p=>p.join(',')).join(' '),stroke:'#ea5b95','stroke-width':2,'stroke-dasharray':'9 5',fill:'none'}));
  function handles(points,kind){points.forEach((p,i)=>{overlay.append(makeSvg('circle',{'data-handle':kind,cx:p[0],cy:p[1],r:6*unit,fill:kind==='pending'?'#ffffff':'#2dd4bf',stroke:'#006e60','stroke-width':2*unit}));const t=makeSvg('text',{x:p[0]+10*unit,y:p[1]-10*unit,fill:'#ffffff',stroke:'#172c32','stroke-width':3*unit,'paint-order':'stroke','font-size':14*unit,'font-weight':'700','font-family':'Arial'});t.textContent=i+1;overlay.append(t);});}
  F.draw(overlay,{G,calibration:previewReport?.calibration||rulerCalibration,facade,unit,guides:facadeAlignments});
  handles(projectPoints,'reference');handles(pending,'pending');
  if(facade?.enabled){handles(target||[],'facade');if(facade.lens_enabled)handles(facade.edge_points.flatMap(p=>p?[p]:[]),'facadeEdge');}
  const selected=previewReport?.sign_layout?.objects?.find(o=>o.id===window.SignageLetterUI?.selectedId());
  if(selected?.polygon_px){
    const points=selected.boundary_px||selected.polygon_px;
    overlay.append(makeSvg('polygon',{points:points.map(p=>p.join(',')).join(' '),fill:'#ffffff','fill-opacity':'.12',stroke:'#ffb454','stroke-width':2*unit,'stroke-dasharray':`${5*unit} ${3*unit}`}));
  }
}
function drawRuler(announce=false){
  const bounds=$('image').getBoundingClientRect();
  const result=window.SignageRuler.draw($('rulerOverlay'),{image:photoData?imageMeta:null,points:rulerPoints,hover:rulerHover,calibration:rulerCalibration,calibrationError:rulerCalibrationError,samePlane:$('rulerSamePlane').checked,active:action==='measure',width:bounds.width,height:bounds.height});
  // The ruler's total stays in the visible part of the photo while it is enlarged.
  const summary=$('rulerOverlay').lastElementChild,viewportBounds=$('imageViewport').getBoundingClientRect();
  if(summary&&photoData){const left=Math.max(0,viewportBounds.left-bounds.left),right=Math.min(bounds.width,viewportBounds.right-bounds.left),top=Math.max(0,viewportBounds.top-bounds.top);summary.setAttribute('transform',`translate(${(left+right-bounds.width)/2} ${top})`);}
  if(announce)$('rulerReadout').textContent=result.error?`Размеры пока не рассчитаны. ${result.error}`:result.measurement&&rulerPoints.length>1?`Точек: ${rulerPoints.length}. Общая длина: ${window.SignageRuler.formatCm(result.measurement.total_cm)}.`:rulerPoints.length?'Добавьте ещё одну точку, чтобы измерить расстояние.':'Нажимайте на фото, чтобы добавить точки.';
}
function drawText(){
  const container=$('textArt');container.replaceChildren();
  if(!photoData||!previewReport?.placement)return;
  if(facade?.enabled||window.SignageProductUI&&(window.SignageProductUI.renderer()!=='channel_letters'||previewReport.sign_layout?.independent_signs)){
    const p=project(),svg=makeSvg('svg',{width:imageMeta.width_px,height:imageMeta.height_px,viewBox:`0 0 ${imageMeta.width_px} ${imageMeta.height_px}`});
    const parsed=new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${G.productPreviewSvg(p,previewReport)}</svg>`,'image/svg+xml');
    svg.append(...Array.from(parsed.documentElement.childNodes).map(node=>document.importNode(node,true)));container.append(svg);
    container.style.width=`${imageMeta.width_px}px`;container.style.height=`${imageMeta.height_px}px`;container.style.transform='';$('textScale').style.transform=`scale(${$('stage').clientWidth/imageMeta.width_px})`;return;
  }
  if(!previewReport?.sign_layout)return;
  const width=500,height=width*numeric('signHeight')/numeric('signWidth');
  if(!Number.isFinite(height)||height<.1||height>10000)return;
  const family='Arial, sans-serif'; // Deliberately labelled schematic; no silent font claim.
  const p=project(),layout=previewReport.sign_layout,scale=width/p.placement.width_cm;
  const svg=makeSvg('svg',{width,height,viewBox:`0 0 ${width} ${height}`});
  svg.style.overflow='visible';
  if(G.localCompositionSvg&&Array.isArray(layout.objects)){
    const group=makeSvg('g',{transform:`scale(${scale})`});
    const parsed=new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${G.localCompositionSvg(layout,$('frontColor').value)}</svg>`,'image/svg+xml');
    group.append(...Array.from(parsed.documentElement.childNodes).map(n=>document.importNode(n,true)));svg.append(group);
  }else layout.lines.forEach(line=>{const t=makeSvg('text',{x:line.x_cm*scale,y:line.baseline_cm*scale,'text-anchor':'start','font-family':family,'font-weight':700,'font-size':layout.font_size_cm*scale,'xml:space':'preserve',fill:$('frontColor').value,stroke:$('sideColor').value,'stroke-width':.6,'paint-order':'stroke'});t.textContent=line.text;svg.append(t);});container.append(svg);
  const h=G.homography([[0,0],[width,0],[width,height],[0,height]],previewReport.placement.polygon_px);
  container.style.width=`${width}px`;container.style.height=`${height}px`;container.style.transform=`matrix3d(${[h[0],h[3],0,h[6],h[1],h[4],0,h[7],0,0,1,0,h[2],h[5],0,h[8]].join(',')})`;
  $('textScale').style.transform=`scale(${$('stage').clientWidth/imageMeta.width_px})`;
}
function showWarnings(messages){$('warnings').replaceChildren(...messages.map(message=>{const li=document.createElement('li');li.textContent=message;return li;}));}
function fitStage(){
  photoViewport?.configure(photoData?imageMeta:null,{reset:resetViewport});
  resetViewport=false;
}
function render(){
  report=null;previewReport=null;let error='';
  updateMaterialFields();
  // The photo viewport does not change when an object moves. Reconfiguring it
  // would redraw again and emit a second autosave event for every pointer move.
  if(!dragging())fitStage();
  $('openPhotoImage').disabled=!photoData;
  rulerCalibration=null;rulerCalibrationError='Сначала загрузите фото и отметьте эталон.';
  if(imageMeta)try{rulerCalibration=G.sceneCalibration(project());rulerCalibrationError='';}catch(e){rulerCalibrationError=e.message;}
  if(rulerCalibration&&window.SignageProductUI?.renderer()==='channel_letters'){
    const previous=center?{center_px:center,width_cm:numeric('signWidth'),height_cm:numeric('signHeight'),rotation_deg:numeric('rotation')}:null;
    window.SignageLetterUI?.makeIndependent?.(rulerCalibration,previous);
  }
  document.documentElement.dataset.independentSigns=String(independentSigns());
  if(imageMeta)try{
    const p=project(),material=p.sign.face_material;
    const objectError=window.SignageProductUI?.renderer()==='channel_letters'?window.SignageLetterUI?.validationError?.():null;
    if(objectError)throw new Error(objectError);
    if(material?.type==='film_on_acrylic'&&(material.led_temperature_k!==null&&(!Number.isFinite(material.led_temperature_k)||material.led_temperature_k<1000||material.led_temperature_k>20000)||$('filmLedTemperature').validity.badInput))throw new Error('Введите температуру LED от 1000 до 20000 K или оставьте поле пустым.');
    report=G.analyze(p);
  }catch(e){error=e.message;}
  previewReport=report;
  if(!previewReport&&imageMeta&&window.SignageProductUI?.renderer()==='channel_letters'){
    try{previewReport=G.analyze(project(),{preview:true});}catch{ /* Calibration and global errors still require correction. */ }
  }
  ['reference','place','target','measure'].forEach(id=>$(id)?.classList.toggle('active',id===action));
  ['target','measure'].forEach(id=>$(id).setAttribute('aria-pressed',String(action===id)));
  $('rulerInfo').hidden=action!=='measure'&&!rulerPoints.length;
  $('clearRuler').hidden=action!=='measure'&&!rulerPoints.length;
  $('clearRuler').disabled=!rulerPoints.length;
  $('status').classList.toggle('error',Boolean(error));
  $('referenceState').textContent=action==='reference'?`Отмечено ${pending.length} из ${$('calibrationMode').value==='rectangle'?4:2}. Нажимайте левой кнопкой по рабочему фото справа.`:projectPoints.length?`Сохранено точек: ${projectPoints.length}. Координаты в исходном фото.`:'Эталон ещё не отмечен.';
  $('clearTarget').hidden=!target;
  renderFacadeControls();
  $('resultLine').textContent=previewReport?.placement?`${Number(numeric('signWidth').toFixed(1))} × ${Number(numeric('signHeight').toFixed(1))} см · ${error?'исправьте параметры объектов':previewReport.placement.fits_target===false?'выходит за область':'габарит размещён'}`:previewReport?'Масштаб рассчитан · укажите центр вывески':'Ожидается калибровка';
  if(independentSigns())$('resultLine').textContent=!rulerCalibration?'Ожидается калибровка':error?'Исправьте параметры отдельных вывесок':`${previewReport?.sign_layout?.objects?.length||0} независимых вывесок · ${target?'область установки отмечена':'отметьте область установки'}`;
  showWarnings(error?[...new Set([error,...(previewReport?.warnings||[])])]:report?report.warnings:['По одному фото нельзя восстановить размеры объектов на произвольной глубине.']);
  $('measurements').replaceChildren(...(report?.measurements||[]).map((m,i)=>{const row=document.createElement('div');row.className='measurement';const label=document.createElement('span');label.textContent=`${m.name}: ${m.length_cm===null?'плоскость не подтверждена':`≈ ${m.length_cm.toFixed(1)} см`}`;const remove=document.createElement('button');remove.textContent='×';remove.setAttribute('aria-label',`Удалить ${m.name}`);remove.onclick=()=>{measurements.splice(i,1);render();};row.append(label,remove);return row;}));
  ['exportProject','exportSvg','exportPng'].forEach(id=>$(id).disabled=!report);
  $('exportPng').disabled=!report||!photoData;
  window.SignageLetterUI?.updateLayout(previewReport?.sign_layout);
  drawPoints();drawText();drawRuler(true);
  if(dragging())dragChangePending=true;
  else document.dispatchEvent(new Event('signage:change'));
}
function loadPhoto(data,name,preserve=false){
  return new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>{
    if(!preserve)resetGeometry();
    if(preserve&&imageMeta&&(img.naturalWidth!==imageMeta.width_px||img.naturalHeight!==imageMeta.height_px)){reject(new Error('Фото не совпадает по размерам с проектом. Используйте исходник с той же ориентацией.'));return;}
    imageMeta={name,width_px:img.naturalWidth,height_px:img.naturalHeight};photoData=data;photoRevision++;photoKey=newPhotoKey();resetViewport=true;
    $('image').src=data;$('image').hidden=false;$('empty').hidden=true;$('imageName').textContent=`${name} · ${img.naturalWidth} × ${img.naturalHeight}`;
    $('instruction').textContent=preserve?'Исходное фото загружено. Точки и параметры проекта сохранены.':'Фото загружено. Выберите способ калибровки и отметьте эталон.';render();resolve();};img.onerror=()=>reject(new Error('Не удалось прочитать изображение.'));img.src=data;});
}
$('photo').addEventListener('change',async e=>{
  const file=e.target.files[0];if(!file)return;
  try{const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file);});await loadPhoto(data,file.name,Boolean(imported&&!photoData));}catch(err){showWarnings([err.message]);}
});
$('calibrationMode').onchange=()=>{cancelDrag();projectPoints=[];pending=[];rulerHover=null;action='';updateMode();render();};
controls.forEach(id=>$(id).addEventListener('input',()=>{cancelDrag();render();}));
['reference','place'].forEach(id=>$(id).onclick=()=>setMode(id));
$('target').onclick=()=>setMode(action==='target'?'':'target');
$('measure').onclick=()=>setMode(action==='measure'?'':'measure');
$('rulerSamePlane').addEventListener('change',render);
$('clearRuler').onclick=()=>{rulerPoints=[];rulerHover=null;render();};
$('undo').onclick=()=>{if(action==='measure'){rulerPoints.pop();rulerHover=null;}else if(pending.length)pending.pop();else if(action==='reference'&&projectPoints.length){pending=projectPoints.slice(0,-1);projectPoints=[];}render();};
$('clearTarget').onclick=()=>{cancelDrag();target=null;if(facade)facade.edge_points=[null,null,null,null];render();};
$('openPhotoImage').onclick=()=>{if(photoData){const extension=photoData.startsWith('data:image/jpeg')?'jpg':photoData.startsWith('data:image/webp')?'webp':photoData.startsWith('data:image/svg+xml')?'svg':'png';window.SignagePreview.openImage({src:photoData,title:`Исходное фото · ${imageMeta.name}`,filename:`source-photo.${extension}`});}};
function imagePoint(event){
  if(!imageMeta||!photoData)return null;
  const viewportBounds=$('imageViewport').getBoundingClientRect();
  if(event.clientX<viewportBounds.left||event.clientX>viewportBounds.right||event.clientY<viewportBounds.top||event.clientY>viewportBounds.bottom)return null;
  const bounds=$('image').getBoundingClientRect();if(!bounds.width||!bounds.height)return;
  const p=[(event.clientX-bounds.left)*imageMeta.width_px/bounds.width,(event.clientY-bounds.top)*imageMeta.height_px/bounds.height];
  return p.every(Number.isFinite)&&p.every(v=>v>=0)&&p[0]<=imageMeta.width_px&&p[1]<=imageMeta.height_px?p:null;
}
function compositionPoint(event){
  const p=imagePoint(event),layout=previewReport?.sign_layout;
  if(!p||!Array.isArray(layout?.objects)||!previewReport?.placement)return null;
  if(layout.independent_signs)return G.apply(previewReport.calibration.imageToWorld,p);
  if(facade?.enabled)return worldCompositionLocal(G.apply(previewReport.calibration.imageToWorld,p),layout);
  const h=G.homography([[0,0],[layout.width_cm,0],[layout.width_cm,layout.height_cm],[0,layout.height_cm]],previewReport.placement.polygon_px);return G.apply(G.inverse(h),p);
}
function localCompositionWorld(p,layout=previewReport.sign_layout){const c=previewReport.placement.center_cm,angle=numeric('rotation')*Math.PI/180,x=p[0]-layout.width_cm/2,y=p[1]-layout.height_cm/2;return [c[0]+Math.cos(angle)*x-Math.sin(angle)*y,c[1]+Math.sin(angle)*x+Math.cos(angle)*y];}
function worldCompositionLocal(p,layout=previewReport.sign_layout){const c=previewReport.placement.center_cm,angle=numeric('rotation')*Math.PI/180,x=p[0]-c[0],y=p[1]-c[1];return [Math.cos(angle)*x+Math.sin(angle)*y+layout.width_cm/2,-Math.sin(angle)*x+Math.cos(angle)*y+layout.height_cm/2];}
function snapObject(layout,moving,x,y,bypass){
  facadeAlignments=[];if(!facade?.enabled)return {x,y};
  const calibration=previewReport.calibration,independent=layout.independent_signs;
  const group=independent?null:[[0,0],[layout.width_cm,0],[layout.width_cm,layout.height_cm],[0,layout.height_cm]].map(p=>localCompositionWorld(p,layout));
  const region=independent?calibration.target_world_cm:calibration.target_world_cm?F.intersectRegions(group,calibration.target_world_cm):group;
  const result=F.snapInWorld({moving,objects:layout.objects,x,y,toWorld:independent?undefined:p=>localCompositionWorld(p,layout),fromWorld:independent?undefined:p=>worldCompositionLocal(p,layout),project:p=>G.apply(calibration.worldToImage,p),region,screenScale:imageMeta.width_px/$('image').getBoundingClientRect().width,thresholdPx:8,snapElements:facade.snap_elements,snapGrid:facade.snap_grid,gridStep:facade.grid_step_cm,bypass});
  facadeAlignments=result.guides;
  return result;
}
function facadeHandle(image){
  if(!facade?.enabled||!image)return null;
  const scale=$('image').getBoundingClientRect().width/imageMeta.width_px;
  const candidates=[...(target||[]).map((p,index)=>({kind:'target',index,p})),...(facade.lens_enabled?facade.edge_points.flatMap((p,index)=>p?[{kind:'edge',index,p}]:[]):[])];
  return candidates.map(handle=>({...handle,distance:G.distance(image,handle.p)*scale})).filter(handle=>handle.distance<=12).sort((a,b)=>a.distance-b.distance)[0]||null;
}
function rawImagePoint(event){
  if(!imageMeta||!photoData)return null;
  const bounds=$('image').getBoundingClientRect();if(!bounds.width||!bounds.height)return null;
  const p=[(event.clientX-bounds.left)*imageMeta.width_px/bounds.width,(event.clientY-bounds.top)*imageMeta.height_px/bounds.height];
  return p.every(Number.isFinite)?p:null;
}
function compositionHit(event){
  if(action||!previewReport?.placement||photoViewport?.isPanning())return null;
  const image=imagePoint(event);if(!image)return null;
  if(previewReport.sign_layout?.independent_signs){
    const p=G.apply(previewReport.calibration.imageToWorld,image),objects=previewReport.sign_layout.objects;
    const selected=objects.find(o=>o.id===window.SignageLetterUI.selectedId());
    const object=[...(selected?[selected]:[]),...objects.slice().reverse().filter(o=>o!==selected)].find(o=>G.inside(p,o.bounds_cm));
    return object?{kind:'object',object,p}:null;
  }
  const polygon=facade?.enabled?(previewReport.placement.boundary_px||previewReport.placement.polygon_px):previewReport.placement.polygon_px;
  const scale=$('image').getBoundingClientRect().width/imageMeta.width_px;
  const nearBorder=polygon.some((a,index)=>{
    const b=polygon[(index+1)%polygon.length],dx=b[0]-a[0],dy=b[1]-a[1];
    const t=Math.max(0,Math.min(1,((image[0]-a[0])*dx+(image[1]-a[1])*dy)/(dx*dx+dy*dy)));
    return Math.hypot(image[0]-a[0]-t*dx,image[1]-a[1]-t*dy)*scale<=8;
  });
  if(nearBorder)return {kind:'composition',image};
  const layout=previewReport.sign_layout;
  if(Array.isArray(layout?.objects)){
    const p=compositionPoint(event);
    const selected=layout.objects.find(o=>o.id===window.SignageLetterUI.selectedId());
    const candidates=[...(selected?[selected]:[]),...layout.objects.slice().reverse().filter(o=>o!==selected)];
    const object=candidates.find(o=>G.inside(p,o.bounds_cm));
    if(object)return {kind:'object',object,p};
  }
  if(facade?.enabled){const world=G.apply(previewReport.calibration.imageToWorld,image);return G.inside(world,previewReport.placement.corners_cm)?{kind:'composition',image}:null;}
  return G.inside(image,polygon)?{kind:'composition',image}:null;
}
$('imageViewport').addEventListener('pointerdown',event=>{
  if(action||event.button!==0)return;
  const handle=facadeHandle(imagePoint(event));if(handle){cancelDrag();facadeDrag={...handle,pointer:event.pointerId};$('imageViewport').setPointerCapture(event.pointerId);event.preventDefault();event.stopImmediatePropagation();return;}
  let hit;try{hit=compositionHit(event);}catch{return;}if(!hit)return;
  if(hit.kind==='composition'){
    const calibration=previewReport.calibration;let world;
    try{world=G.apply(calibration.imageToWorld,hit.image);}catch{return;}
    compositionDrag={pointer:event.pointerId,calibration,offset:previewReport.placement.center_cm.map((value,index)=>value-world[index]),photoRevision,
      originCenter:[...previewReport.placement.center_cm],bounds:previewReport.placement.corners_cm.map(p=>[...p]),width:numeric('signWidth'),height:numeric('signHeight'),rotation:numeric('rotation'),renderer:window.SignageProductUI?.renderer(),calibrationSignature:calibrationSignature(),moved:false};
    $('instruction').textContent='Перемещаем всю жёлтую зону вместе с объектами. Их взаимное расположение сохраняется.';
  }else{
    const {object,p}=hit;window.SignageLetterUI.select(object.id);
    objectDrag={pointer:event.pointerId,id:object.id,start:p,x:object.x_cm,y:object.y_cm,
      minX:Math.min(...object.bounds_cm.map(p=>p[0])),maxX:Math.max(...object.bounds_cm.map(p=>p[0])),
      minY:Math.min(...object.bounds_cm.map(p=>p[1])),maxY:Math.max(...object.bounds_cm.map(p=>p[1]))};
  }
  $('stage').style.cursor='grabbing';
  $('imageViewport').setPointerCapture(event.pointerId);event.preventDefault();event.stopImmediatePropagation();
},true);
$('imageViewport').addEventListener('pointermove',event=>{
  if(facadeDrag&&facadeDrag.pointer===event.pointerId){if(!(event.buttons&1)){cancelDrag();return;}const raw=rawImagePoint(event);if(raw){const p=raw.map((v,i)=>Math.max(0,Math.min(i?imageMeta.height_px:imageMeta.width_px,v)));if(facadeDrag.kind==='target')target[facadeDrag.index]=p;else facade.edge_points[facadeDrag.index]=p;render();}event.preventDefault();event.stopImmediatePropagation();return;}
  if(compositionDrag&&compositionDrag.pointer===event.pointerId){
    const d=compositionDrag;
    if(!(event.buttons&1)||action||photoRevision!==d.photoRevision||numeric('signWidth')!==d.width||numeric('signHeight')!==d.height||numeric('rotation')!==d.rotation||window.SignageProductUI?.renderer()!==d.renderer||calibrationSignature()!==d.calibrationSignature){cancelDrag();return;}
    const p=rawImagePoint(event);
    if(p)try{
      let world=G.apply(d.calibration.imageToWorld,p).map((value,index)=>value+d.offset[index]);
      if(facade?.enabled){
        const moving={id:'__whole_composition__',x_cm:d.originCenter[0],y_cm:d.originCenter[1],bounds_cm:d.bounds},region=d.calibration.target_world_cm;
        const snapped=F.snap({moving,objects:[],x:world[0],y:world[1],project:point=>G.apply(d.calibration.worldToImage,point),region,screenScale:imageMeta.width_px/$('image').getBoundingClientRect().width,thresholdPx:8,snapElements:false,snapGrid:facade.snap_grid,gridStep:facade.grid_step_cm,bypass:event.altKey});
        world=[snapped.x,snapped.y];facadeAlignments=snapped.guides;
        const fits=position=>!region||F.translated(moving,...position).every(point=>G.inside(point,region));
        if(!fits(world)&&fits(d.originCenter)){const requested=[...world];let low=0,high=1;for(let i=0;i<24;i++){const t=(low+high)/2;if(fits(d.originCenter.map((v,index)=>v+(requested[index]-v)*t)))low=t;else high=t;}world=d.originCenter.map((v,index)=>v+(requested[index]-v)*low);facadeAlignments=[];}
      }
      const next=G.apply(d.calibration.worldToImage,world).map((value,index)=>Math.max(0,Math.min(index?imageMeta.height_px:imageMeta.width_px,value)));
      G.placement(d.calibration,{center_px:next,width_cm:d.width,height_cm:d.height,rotation_deg:d.rotation});
      if(!center||Math.hypot(next[0]-center[0],next[1]-center[1])>1e-7){center=next;d.moved=true;render();}
    }catch{ /* Ignore a pointer location on the projection horizon. */ }
    event.preventDefault();event.stopImmediatePropagation();return;
  }
  if(!objectDrag){
    let hit;try{hit=compositionHit(event);}catch{hit=null;}
    $('stage').style.cursor=hit?.kind==='composition'?'grab':hit?.kind==='object'?'move':'';
    return;
  }
  if(!objectDrag||objectDrag.pointer!==event.pointerId)return;
  if(!(event.buttons&1)||action||window.SignageLetterUI.selectedId()!==objectDrag.id){cancelDrag();return;}
  const p=compositionPoint(event),layout=previewReport?.sign_layout;
  if(p&&layout){
    const d=objectDrag;
    const nextX=Math.round((d.x+p[0]-d.start[0])*10)/10,nextY=Math.round((d.y+p[1]-d.start[1])*10)/10;
    if(layout.independent_signs){
      const polygon=target||[[0,0],[imageMeta.width_px,0],[imageMeta.width_px,imageMeta.height_px],[0,imageMeta.height_px]];
      const moving=layout.objects.find(o=>o.id===d.id),region=facade?.enabled?previewReport.calibration.target_world_cm:null;
      const fits=(x,y)=>moving.bounds_cm.every(point=>{const p=[point[0]+x-moving.x_cm,point[1]+y-moving.y_cm];return region?G.inside(p,region):G.inside(G.apply(previewReport.calibration.worldToImage,p),polygon);});
      let {x,y}=snapObject(layout,moving,nextX,nextY,event.altKey);
      // Stop at the actual installation boundary, independent of other signs.
      if(!fits(x,y)&&fits(d.x,d.y)){
        let low=0,high=1;
        for(let i=0;i<24;i++){const middle=(low+high)/2;if(fits(d.x+(nextX-d.x)*middle,d.y+(nextY-d.y)*middle))low=middle;else high=middle;}
        x=d.x+(nextX-d.x)*low;y=d.y+(nextY-d.y)*low;facadeAlignments=[];
      }
      window.SignageLetterUI.setObjectPosition(d.id,x,y);render();event.preventDefault();event.stopImmediatePropagation();return;
    }
    // An overflowing preview has no valid clamp range. Keep its drag continuous
    // while the owner corrects it; objects that start inside stay constrained.
    const x=d.minX>=0&&d.maxX<=layout.width_cm?Math.max(d.x-d.minX,Math.min(d.x+layout.width_cm-d.maxX,nextX)):nextX;
    const y=d.minY>=0&&d.maxY<=layout.height_cm?Math.max(d.y-d.minY,Math.min(d.y+layout.height_cm-d.maxY,nextY)):nextY;
    const snapped=snapObject(layout,layout.objects.find(o=>o.id===d.id),x,y,event.altKey);
    window.SignageLetterUI.setObjectPosition(d.id,snapped.x,snapped.y);render();
  }
  event.preventDefault();event.stopImmediatePropagation();
},true);
function cancelDrag(){
  const drag=facadeDrag||compositionDrag||objectDrag,hadGuides=facadeAlignments.length,changed=dragChangePending;
  dragChangePending=false;
  compositionDrag=null;objectDrag=null;facadeDrag=null;facadeAlignments=[];$('stage').style.cursor='';
  if(drag&&$('imageViewport').hasPointerCapture(drag.pointer))$('imageViewport').releasePointerCapture(drag.pointer);
  if(hadGuides)drawPoints();
  // Commit once on release, cancel, blur or leaving the page. The small local
  // recovery journal is updated synchronously before pagehide flushes IndexedDB.
  if(changed)document.dispatchEvent(new Event('signage:change'));
}
$('imageViewport').addEventListener('lostpointercapture',cancelDrag);
window.addEventListener('blur',cancelDrag);
window.addEventListener('pagehide',cancelDrag);
document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelDrag();});
$('imageViewport').addEventListener('pointerleave',()=>{if(!objectDrag&&!compositionDrag)$('stage').style.cursor='';});
for(const type of ['pointerup','pointercancel'])$('imageViewport').addEventListener(type,event=>{
  const drag=facadeDrag||compositionDrag||objectDrag;if(!drag||drag.pointer!==event.pointerId)return;
  const moved=compositionDrag?.moved;cancelDrag();
  if(moved)$('instruction').textContent='Композиция перемещена. Потяните жёлтую рамку или свободное место внутри неё, чтобы переместить всё вместе.';
  event.preventDefault();event.stopImmediatePropagation();
},true);
$('stage').addEventListener('click',event=>{
  if(!action||event.button!==0||photoViewport?.isPanning())return;
  const p=imagePoint(event);if(!p)return;
  if(action==='measure'){
    if(rulerPoints.length>=256){$('instruction').textContent='В линейке уже 256 точек. Удалите точку или очистите линейку.';return;}
    rulerPoints.push(p);rulerHover=null;render();return;
  }
  if(action==='place'){center=p;setMode('');return;}
  pending.push(p);const count=action==='target'||action==='facadeEdges'||action==='editRegion'||action==='reference'&&$('calibrationMode').value==='rectangle'?4:2;
  if(pending.length===count){
    if(action==='reference')projectPoints=[...pending];
    else if(action==='target'){target=[...pending];facade={...F.defaults(),...(facade||{}),enabled:true,edge_points:[null,null,null,null]};}
    else if(action==='facadeEdges'){facade=facade||F.defaults();facade.enabled=true;facade.lens_enabled=true;facade.edge_points=pending.map(p=>[...p]);}
    else if(action==='editRegion')window.SignageGeneration?.setRegion([...pending]);
    setMode('');
  }else{render();$('instruction').textContent=`Отмечено ${pending.length} из ${count}. ${action==='reference'&&count===4?'Порядок: левый верхний → правый верхний → правый нижний → левый нижний.':''}`;}
});
$('stage').addEventListener('mousemove',event=>{if(action!=='measure'||photoViewport?.isPanning())return;rulerHover=imagePoint(event);drawRuler();});
$('stage').addEventListener('mouseleave',()=>{if(rulerHover){rulerHover=null;drawRuler();}});
$('stage').addEventListener('contextmenu',event=>{
  if(action!=='measure'||photoViewport?.isPanning())return;
  const p=imagePoint(event);if(!p)return;
  event.preventDefault();
  const bounds=$('image').getBoundingClientRect();let nearest=-1,nearestDistance=16;
  rulerPoints.forEach((point,index)=>{const distance=Math.hypot((point[0]-p[0])*bounds.width/imageMeta.width_px,(point[1]-p[1])*bounds.height/imageMeta.height_px);if(distance<=nearestDistance){nearest=index;nearestDistance=distance;}});
  if(nearest!==-1){rulerPoints.splice(nearest,1);rulerHover=null;render();}
});
document.addEventListener('keydown',event=>{
  if((facadeDrag||objectDrag||compositionDrag)&&event.key==='Escape'){event.preventDefault();cancelDrag();return;}
  if(action==='facadeEdges'&&event.key==='Escape'){event.preventDefault();setMode('');return;}
  if(action!=='measure'||event.defaultPrevented||event.ctrlKey||event.metaKey||event.altKey)return;
  const editing=event.target?.isContentEditable||event.target?.closest?.('input,textarea,select,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"]');
  if(editing)return;
  if(event.key==='Escape'){event.preventDefault();setMode('');}
  else if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();rulerPoints.pop();rulerHover=null;render();}
});
function download(data,name,type){const url=URL.createObjectURL(new Blob([data],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);}
$('exportProject').onclick=async()=>{try{await window.SignageProductUI?.prepareArtwork();render();if(!report)throw new Error('Исправьте параметры проекта перед сохранением.');download(JSON.stringify(project(),null,2),'signage-project.json','application/json');}catch(error){showWarnings([error.message]);}};
$('exportSvg').onclick=async()=>{try{await window.SignageProductUI?.prepareArtwork();render();if(!report)throw new Error('Исправьте параметры проекта перед экспортом.');download(G.overlaySvg(project(),report,photoData),'signage-geometry.svg','image/svg+xml');}catch(error){showWarnings([error.message]);}};
$('exportPng').onclick=async()=>{
  if(!photoData){showWarnings(['Для PNG загрузите исходное фото.']);return;}
  try{await window.SignageProductUI?.prepareArtwork();render();if(!report)throw new Error('Исправьте параметры проекта перед экспортом.');const canvas=document.createElement('canvas');canvas.width=imageMeta.width_px;canvas.height=imageMeta.height_px;const context=canvas.getContext('2d');context.drawImage($('image'),0,0);const svg=G.overlaySvg(project(),report);const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));try{const overlayImage=await new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('Не удалось экспортировать схему.'));img.src=url;});context.drawImage(overlayImage,0,0);canvas.toBlob(blob=>{if(blob)download(blob,'signage-geometry.png','image/png');else showWarnings(['Экспорт PNG не удался.']);},'image/png');}finally{URL.revokeObjectURL(url);}}catch(e){showWarnings([e.message]);}
};
function applyProject(p,{allowIncomplete=false}={}){
  cancelDrag();
  if(window.SignageProducts){p=window.SignageProducts.normalizeProject(p);const legacy=window.SignageProducts.legacyProject(p);p={...p,sign:legacy.sign,placement:legacy.placement};}
  if(!p.image||!p.calibration)throw new Error('Проект не содержит фотографию и калибровку.');
  // Segment calibration always uses the approximate frontal-view assumption.
  if(p.calibration.mode==='frontoparallel')p={...p,calibration:{...p.calibration,frontoparallel_assumed:true}};
  if(!allowIncomplete)G.analyze(p);
  const nextRuler=window.SignageRuler.validate(p.ruler?.image_points||[],p.image);
  const mismatched=imageMeta&&(imageMeta.width_px!==p.image.width_px||imageMeta.height_px!==p.image.height_px||imageMeta.name!==p.image.name);
  if(mismatched){photoData='';$('image').hidden=true;$('empty').hidden=false;$('empty').textContent='Загрузите исходное фото этого проекта. Размеры и точки сохранены.';}
  window.SignageProductUI?.restore(p);imported=p;facade=F.normalize(p.facade);imageMeta=p.image;projectPoints=p.calibration.image_points;center=p.placement?.center_px||null;target=p.target_polygon_px||null;measurements=p.measurements||[];checks=p.checks||[];
  rulerPoints=nextRuler;rulerHover=null;$('rulerSamePlane').checked=p.ruler?p.ruler.same_plane===true:true;
  $('calibrationMode').value=p.calibration.mode;
  const material=p.sign?.face_material;
  const pairs={referenceLength:p.calibration.length_cm,referenceWidth:p.calibration.width_cm,referenceHeight:p.calibration.height_cm,signWidth:p.placement?.width_cm,signHeight:p.placement?.height_cm,lineGap:p.sign?.line_gap_cm??5,textAlign:p.sign?.text_align??'center',rotation:p.placement?.rotation_deg??0,text:p.sign?.text??'',font:p.sign?.font_family??'Arial',depth:p.sign?.depth_cm??0,frontColor:p.sign?.front_color??'#fff3dc',sideColor:p.sign?.side_color??'#292f30',faceMaterialType:material?.type??'custom',filmSeries:material?.series??'',filmColorCode:material?.color_code??'',filmFinish:material?.finish??'unspecified',filmAcrylic:material?.acrylic??'unspecified',filmLedTemperature:material?.led_temperature_k??'',filmDayLighting:material?.day_lighting??'off',brief:p.sign?.brief??[p.sign?.material,p.sign?.lighting].filter(Boolean).join('. ')};
  Object.entries(pairs).forEach(([key,val])=>{if(val!==undefined)$(key).value=val;});window.SignageCorel?.restore(p.sign);window.SignageGeneration?.restore(p.generation);action='';pending=[];updateMode();render();$('instruction').textContent=photoData?'Проект открыт.':'Проект открыт. Загрузите его исходное фото; точки останутся на месте.';
}
$('importButton').onclick=()=>$('import').click();
$('import').onchange=async e=>{const f=e.target.files[0];if(!f)return;try{applyProject(JSON.parse((await f.text()).replace(/^\uFEFF/,'')));}catch(err){showWarnings([`Не удалось открыть проект: ${err.message}`]);}};
$('demo').onclick=async()=>{
  const demoSvg=`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="780"><defs><linearGradient id="wall" x2="0" y2="1"><stop stop-color="#b7c4ba"/><stop offset="1" stop-color="#84988a"/></linearGradient></defs><rect width="1200" height="780" fill="#cddbd9"/><path d="M0 655L1200 570V780H0Z" fill="#a3aca5"/><path d="M120 130L1050 190V627L120 710Z" fill="url(#wall)"/><path d="M1050 190L1150 140V575L1050 627Z" fill="#72887a"/><path d="M120 130L220 85L1150 140L1050 190Z" fill="#e4e8dc"/><g fill="#263e3b" stroke="#dce6d6" stroke-width="13"><path d="M230 425L500 423V643L230 665Z"/><path d="M620 425L920 423V607L620 633Z"/></g><path d="M365 424V654M770 424V620" stroke="#b0bdb2" stroke-width="7"/><path d="M230 471L500 469M620 466L920 464" stroke="#93aaa0" stroke-width="4"/><path d="M475 534V584" stroke="#d9dfcf" stroke-width="6"/><path d="M206 181L982 224L982 390L206 390Z" fill="#4a675b" opacity=".65"/><path d="M206 181L982 224L982 390L206 390Z" fill="none" stroke="#adc4b1" stroke-width="2"/><text x="34" y="48" font-family="Arial" font-size="18" fill="#355750">УЧЕБНЫЙ ФАСАД · эталонная панель 400 × 100 см</text><path d="M155 694L1030 617" stroke="#e3e6da" stroke-width="8"/></svg>`;
  await loadPhoto('data:image/svg+xml;charset=utf-8,'+encodeURIComponent(demoSvg),'Учебный фасад');
  applyProject({version:1,image:imageMeta,calibration:{mode:'rectangle',width_cm:400,height_cm:100,image_points:[[206,181],[982,224],[982,390],[206,390]]},placement:{center_px:[594,294],width_cm:220,height_cm:45,rotation_deg:0},sign:{text:'КОФЕ',font_family:'Arial',depth_cm:5,front_color:'#fff3dc',side_color:'#292f30',brief:'Учебный пример. Молочный акрил, тёплый контражур.'},target_polygon_px:[[206,181],[982,224],[982,390],[206,390]],measurements:[],checks:[]});
  $('instruction').textContent='Учебный пример: размеры панели заданы для демонстрации. Загрузите своё фото для реального макета.';
};
photoViewport=window.SignageViewport.mount({viewport:$('imageViewport'),stage:$('stage'),controls:{zoomFit:$('zoomFit')},onChange:()=>{rulerHover=null;drawPoints();if(previewReport)drawText();drawRuler();document.dispatchEvent(new Event('signage:viewchange'));}});
new ResizeObserver(()=>{if(previewReport)drawText();drawRuler();}).observe($('stage'));
new ResizeObserver(fitStage).observe($('imageViewport'));
window.addEventListener('resize',fitStage);
window.SignageEditor={placementContext:()=>{if(!imageMeta)return null;try{return {calibration:G.sceneCalibration(project()),target_polygon_px:target||[[0,0],[imageMeta.width_px,0],[imageMeta.width_px,imageMeta.height_px],[0,imageMeta.height_px]],image:imageMeta};}catch{return null;}},setPlacement:value=>{cancelDrag();center=value?.center_px||null;if(value){$('signWidth').value=value.width_cm;$('signHeight').value=value.height_cm;$('rotation').value=value.rotation_deg??0;}},snapshot:()=>({project:project(),report,hasPhoto:Boolean(photoData),photoRevision}),facadeEnabled:()=>facade?.enabled===true,target:()=>target,setMode,render,download,photoPng:()=>{if(!photoData)throw new Error('Загрузите исходное фото.');if(imageMeta.width_px*imageMeta.height_px>20000000)throw new Error('Фото слишком большое: максимум 20 мегапикселей.');const canvas=document.createElement('canvas');canvas.width=imageMeta.width_px;canvas.height=imageMeta.height_px;canvas.getContext('2d').drawImage($('image'),0,0);return canvas.toDataURL('image/png');}};
window.SignageLetterUI?.restore({objects:[],composition_mode:'independent_signs_v1'});
updateMode();render();
window.SignageEditor.restoreProject=async(p,data)=>{applyProject(p);await loadPhoto(data,p.image.name||'Исходное фото',true);};
const draftControls=[...controls,'calibrationMode','rulerSamePlane','corelBold',...(window.SignageProductUI?.draftControls||[])];
window.SignageEditor.draftSnapshot=()=>({project:project(),workspace:window.SignageWorkspace?.context()||null,productUi:window.SignageProductUI?.draftState(),letterUi:window.SignageLetterUI?.draftState?.(),photo:photoData,photoKey:photoData?photoKey:null,
  ui:Object.fromEntries(draftControls.filter(id=>$(id)).map(id=>[id,{value:$(id).value,checked:$(id).checked}])),
  view:photoViewport.snapshot(),interaction:{action,pending:pending.map(point=>[...point])}});
window.SignageEditor.restoreDraft=async(saved,{shouldApply=()=>true}={})=>{
  if(!saved||!saved.project||typeof saved.photo!=='string')throw new Error('Черновик имеет неподдерживаемый формат.');
  const p=window.SignageProducts?window.SignageProducts.normalizeProject(saved.project):saved.project;if(window.SignageProducts){const legacy=window.SignageProducts.legacyProject(p);p.sign=legacy.sign;p.placement=legacy.placement;}let decoded=null;
  if(saved.photo){
    if(!/^data:image\/(?:png|jpeg|webp|svg\+xml)(?:;|,)/i.test(saved.photo)||!p.image||!p.calibration||!p.sign)throw new Error('Черновик не содержит корректное исходное фото.');
    decoded=await new Promise((resolve,reject)=>{const photo=new Image();photo.onload=()=>resolve(photo);photo.onerror=()=>reject(new Error('Не удалось открыть фото из черновика.'));photo.src=saved.photo;});
    if(decoded.naturalWidth!==p.image.width_px||decoded.naturalHeight!==p.image.height_px)throw new Error('Фото и координаты черновика не совпадают.');
    [p.calibration.image_points,p.target_polygon_px||[],p.facade?.edge_points?.filter(Boolean)||[],p.ruler?.image_points||[],saved.interaction?.pending||[]].forEach(points=>window.SignageRuler.validate(points,p.image));
    if(p.placement?.center_px)window.SignageRuler.validate([p.placement.center_px],p.image);
  }
  if(!shouldApply())return false;
  window.SignageWorkspace?.restoreLocal(saved.workspace);
  if(decoded){
    imageMeta=p.image;photoData=saved.photo;photoKey=typeof saved.photoKey==='string'?saved.photoKey:newPhotoKey();photoRevision++;resetViewport=true;
    $('image').src=photoData;$('image').hidden=false;$('empty').hidden=true;$('imageName').textContent=`${p.image.name} · ${p.image.width_px} × ${p.image.height_px}`;
    applyProject(p,{allowIncomplete:true});
  }else{resetGeometry();window.SignageProductUI?.restore(p);imported=p;facade=F.normalize(p.facade);imageMeta=null;photoData='';photoKey=null;$('image').hidden=true;$('empty').hidden=false;window.SignageGeneration?.restore(p.generation);window.SignageCorel?.restore(p.sign);}
  window.SignageProductUI?.restoreDraftState(saved.productUi);
  window.SignageLetterUI?.restoreDraftState?.(saved.letterUi);
  draftControls.forEach(id=>{const field=$(id),value=saved.ui?.[id];if(field&&value){if(typeof value.value==='string')field.value=value.value;if(typeof value.checked==='boolean')field.checked=value.checked;}});
  action=decoded&&['reference','place','target','facadeEdges','measure'].includes(saved.interaction?.action)&&!(independentSigns()&&saved.interaction.action==='place')?saved.interaction.action:'';
  pending=decoded&&saved.interaction?.action!=='editRegion'?(saved.interaction?.pending||[]).map(point=>[...point]):[];
  updateMode();render();photoViewport.restore(saved.view);
  $('instruction').textContent=action==='measure'?'Линейка восстановлена. Левый клик — новая точка, правый клик по точке — удалить.':action?'Черновик восстановлен. Продолжайте отмечать точки выбранного инструмента.':'Черновик восстановлен. Можно продолжать работу.';
  return true;
};
