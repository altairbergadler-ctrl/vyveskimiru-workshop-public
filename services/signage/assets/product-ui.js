/* Versioned product forms and exact artwork. Uploaded originals are immutable
   until the user explicitly replaces them; text mode renders genuine PNG pixels. */
(() => {
  'use strict';
  const P=window.SignageProducts,$=id=>document.getElementById(id),copy=value=>JSON.parse(JSON.stringify(value));
  const typeFields={plaque:{background_color:'plaqueBackground',material:'plaqueMaterial',thickness_mm:'plaqueThickness',corner_radius_mm:'plaqueRadius',mounting:'plaqueMounting',margin_mm:'plaqueMargin'},neon:{tubing_mm:'neonTubing',backing:'neonBacking',backing_margin_mm:'neonMargin',illumination:'neonIllumination'}};
    let active=P.createProduct('channel_letters'),drafts=Object.create(null),dimensions=Object.create(null),signature='',timer=null,uploadEpoch=0,restoring=false;
  const type=()=>active.type;
  const family=()=>P.renderer(active),definition=()=>P.family(active),isLetters=()=>family()==='channel_letters',uploadOnly=()=>P.capabilities(active).require_uploaded===true||definition().artwork_mode==='upload_only';
  const dynamicInputs=new Map(),commonFields=new Set(['text','font_family','font_bold','text_align','line_gap_cm','front_color','brief']);
  const legacyInputs={...typeFields.plaque,...typeFields.neon},legacyElements=Object.fromEntries(Object.entries(legacyInputs).map(([key,id])=>[key,$(id)]));
  function buildFields(){
    dynamicInputs.clear();const nodes=[];
    for(const field of P.parameterFields(active)){
      if(commonFields.has(field.key)||isLetters()&&['depth_cm','side_color','face_material'].includes(field.key))continue;
      if(!/^[a-z][a-z0-9_]{0,79}$/i.test(field.key)||['constructor','prototype','__proto__'].includes(field.key))throw new Error('Некорректное поле модуля изделия.');
      const label=document.createElement('label');label.className=field.kind==='boolean'?'check':'field';label.textContent=field.label;
      const legacy=legacyElements[field.key];
      const input=legacy&&((field.kind==='select')===(legacy.tagName==='SELECT'))?legacy:document.createElement(field.kind==='select'?'select':'input');
      if(!input.id)input.id=`productParam-${field.key}`;input.dataset.productParameter=field.key;
      if(field.kind==='select')input.replaceChildren(...field.options.map(option=>{const n=document.createElement('option');n.value=option.value;n.textContent=option.label;return n;}));
      else{input.type={number:'number',color:'color',string:'text',boolean:'checkbox'}[field.kind];if(field.kind==='number')input.step='any';}
      if(field.kind==='string'&&field.max_length!==undefined)input.maxLength=field.max_length;
      for(const attr of ['min','max']){if(field[attr]!==undefined)input.setAttribute(field.kind==='string'&&attr==='max'?'maxlength':attr,String(field[attr]));else input.removeAttribute(attr);}
      if(field.kind==='boolean')input.checked=active.params[field.key]===true;else input.value=active.params[field.key]??field.default??'';
      label.append(input);nodes.push(label);dynamicInputs.set(field.key,{field,input});
    }
    $('dynamicProductFields').replaceChildren(...nodes);$('dynamicProductFields').hidden=!nodes.length;
  }
  function selectionNote(){const t=P.catalogue().find(t=>t.id===$('productTemplate').value);$('applyProductTemplate').disabled=!t;$('catalogSelectionNote').textContent=t?[t.description,t.coverage_note].filter(Boolean).join(' '):'Сохранённый вариант использует собственные параметры.';}
  function catalogueOptions(preferred=active.template_id){
    const query=$('catalogSearch').value.trim().toLocaleLowerCase('ru'),category=$('catalogCategory').value;
    const all=P.catalogue(),matching=all.filter(t=>(!category||t.category===category)&&(!query||[t.label,t.description,t.category,t.id].filter(Boolean).join(' ').toLocaleLowerCase('ru').includes(query)));
    $('productTemplate').replaceChildren(...matching.map(t=>{const o=document.createElement('option');o.value=t.id;o.textContent=t.label+(t.category?' · '+t.category:'');return o;}));
    if(!matching.length){const o=document.createElement('option');o.value='';o.textContent='Варианты не найдены';$('productTemplate').append(o);}
    if(!all.some(t=>t.id===active.template_id)&&!query&&!category){const o=document.createElement('option');o.value=active.template_id;o.textContent=P.displayLabel(active)+' · сохранённый вариант';$('productTemplate').append(o);}
    if([...$('productTemplate').options].some(o=>o.value===preferred))$('productTemplate').value=preferred;
    $('catalogCount').textContent=`Найдено ${matching.length} из ${all.length} вариантов`;selectionNote();
  }
  const formDimensions=()=>({width_cm:Number($('signWidth').value),height_cm:Number($('signHeight').value),rotation_deg:Number($('rotation').value)});
  const currentTemplate=()=>P.catalogue().find(t=>t.type===type()&&t.id===active.template_id)||P.catalogue().find(t=>t.type===type());
  function compose(base){
    let declared=[];try{declared=P.descriptor(type()).fields;}catch{}const fields=[...new Set([...commonFields,...declared,...(isLetters()?['depth_cm','side_color','face_material']:[])])];
    active.params={...active.params,...Object.fromEntries(fields.filter(key=>Object.hasOwn(base.sign,key)).map(key=>[key,base.sign[key]]))};
    active.params.font_bold=isLetters()?base.sign.font_bold:$('productFontBold').checked;
    if(isLetters()){active.params.preview_line_metrics=base.sign.preview_line_metrics;active.params.preview_font_status=base.sign.preview_font_status;active.params.size_basis=base.sign.size_basis;active.params.objects=base.sign.objects??[];active.params.composition_mode=base.sign.composition_mode||'independent_objects_v1';delete active.params.line_styles;delete active.params.logo;}
    for(const [key,{field,input}] of dynamicInputs)active.params[key]=field.kind==='boolean'?input.checked:field.kind==='number'?Number(input.value):input.value;
    active.placement=base.placement?copy(base.placement):null;dimensions[type()]=formDimensions();
    drafts[type()]=copy(active);
    // Legacy mirrors remain available to older helpers; canonical products win.
    const result={...base,version:2,sign:copy(active.params),placement:copy(active.placement),products:[copy(active)],active_product_id:active.id};delete result.product_drafts;return result;
  }
  function setValue(id,value){if($(id)&&value!==undefined)$(id).value=value;}
  function populate(freshLetters=false){
    const params=active.params,placement=active.placement||dimensions[type()]||currentTemplate()?.default_placement||{width_cm:100,height_cm:35,rotation_deg:0};
    Object.entries({text:params.text,font:params.font_family,lineGap:params.line_gap_cm,textAlign:params.text_align,frontColor:params.front_color,sideColor:params.side_color,depth:params.depth_cm,brief:params.brief,signWidth:placement.width_cm,signHeight:placement.height_cm,rotation:placement.rotation_deg??0}).forEach(([id,value])=>setValue(id,value));
    const m=params.face_material||{};Object.entries({faceMaterialType:m.type||'custom',filmSeries:m.series||'',filmColorCode:m.color_code||'',filmFinish:m.finish||'unspecified',filmAcrylic:m.acrylic||'unspecified',filmLedTemperature:m.led_temperature_k??'',filmDayLighting:m.day_lighting||'off'}).forEach(([id,value])=>setValue(id,value));
    buildFields();
    $('productFontBold').checked=params.font_bold!==false;$('corelBold').checked=params.font_bold!==false;
    $('artworkSource').value=uploadOnly()||active.artwork?.source==='uploaded'?'uploaded':'text';$('artworkSource').disabled=uploadOnly();
    const savedCleanup=active.background_ai===true;$('productAiBackground').checked=savedCleanup;
    catalogueOptions();
    if(freshLetters&&isLetters()&&window.SignageLetterUI?.restoreNew)window.SignageLetterUI.restoreNew(params);else window.SignageLetterUI?.restore(params);updateFields();showArtwork();
  }
  const generationFooter=()=>isLetters()?'Вне зоны замены сохраняются пиксели световой основы. Внутри зоны ИИ восстанавливает фон и добавляет буквы. Размеры и начертание сверяйте с технической схемой.':'Вне зоны замены сохраняются пиксели световой основы. Точный PNG изделия переносится с сохранением текста и пропорций. Макет предназначен для согласования внешнего вида; производственная геометрия из PNG не создаётся.';
  function updateFields(){
    document.querySelectorAll('[data-product-type]').forEach(button=>{const selected=button.dataset.productType===type();button.setAttribute('aria-pressed',String(selected));});
    $('lettersFields').hidden=!isLetters();$('plaqueFields').hidden=true;$('neonFields').hidden=true;
    $('artworkFields').hidden=definition().artwork_mode==='none';$('productFontBoldLabel').hidden=isLetters()||uploadOnly();$('corelSection').hidden=!P.capabilities(active).corel;
    $('exactArtworkSection').hidden=definition().artwork_mode==='none';$('productBackgroundOption').hidden=!P.capabilities(active).background_ai;
    $('productName').textContent=P.displayLabel(active);$('text').maxLength=isLetters()?300:3000;
    $('productCoverageNote').textContent=active.catalog_snapshot?.coverage_note||currentTemplate()?.coverage_note||'';
    $('productFamilyNote').textContent=isLetters()?'Тексты и логотипы размещаются независимо. Точная графика переносится из PNG; объём, тени и свечение показаны условно.':family()==='cutout'?'Контур берётся только из загруженного PNG с прозрачностью. Объём и производственная конструкция не рассчитываются.':family()==='lightbox'?'Световой короб показан условной рамкой и свечением. Лицевая графика берётся из точного PNG.':family()==='flat_print'?'Плоская печать: точный PNG переносится на фото без придуманной подложки и объёма.':'Точный PNG сохраняет текст и пропорции; материалы и эффекты показаны условно.';
    $('placementHint').textContent=isLetters()?'Потяните жёлтую рамку или свободное место внутри неё — вся композиция переместится вместе. Текст и логотип можно перетаскивать отдельно.':'Потяните жёлтую рамку — изделие переместится вместе с графикой. Точный PNG сохраняет пропорции. Оригинал можно открыть и скачать справа.';
    $('footerNote').textContent=generationFooter();
    $('nightOption').textContent=isLetters()?'Ночь · подсветка включена':'Ночь';
    $('textHint').textContent=isLetters()?'Enter добавляет новую строку. Переносы сохраняются в проекте, схеме и задании на генерацию.':uploadOnly()?'Загрузите оригинальный PNG. Текст здесь — описание; он не заменяет точную форму.':$('artworkSource').value==='uploaded'?'На фото переносится загруженный PNG. Изменение текста и шрифта не заменяет оригинал. Для текстового макета выберите «Из текста».':'Enter добавляет строку. Браузер создаёт PNG выбранным доступным шрифтом; сохранённые пиксели переносятся на фото.';
    $('artworkUploadField').hidden=$('artworkSource').value!=='uploaded';
    $('productGenerationNote').hidden=isLetters();
    $('productGenerationNote').textContent='Точный макет размещается на фото с сохранением текста и пропорций. Исходный фон сохраняется; для удаления старой вывески включите подготовку фона с ИИ.';
  }
  function saveCurrent(){if(window.SignageEditor)compose(window.SignageEditor.snapshot().project);}
  function switchType(next){
    if(next===type())return;saveCurrent();const fallback=window.SignageEditor?.snapshot().project.placement,fresh=!drafts[next];uploadEpoch++;active=copy(drafts[next]||P.createProduct(next));
    if(!active.placement&&fallback){active.placement={...copy(fallback),...(dimensions[next]||P.templates(next)[0].default_placement)};}
    signature='';populate(fresh&&isLetters());signature=active.artwork?.source==='text'?(active.artwork_signature||drawingSignature()):'';if(active.artwork?.source==='text'&&!active.artwork_signature)active.artwork_signature=signature;window.SignageEditor?.setPlacement(active.placement);window.SignageEditor?.render();
  }
  function restore(project){
    const normalized=P.normalizeProject(project);active=P.activeProduct(normalized);dimensions=Object.create(null);if(normalized.generation?.engine==='codex_composite')active.background_ai=true;drafts=Object.create(null);
    // Inactive drafts cannot smuggle unsupported active types or artwork into state.
    for(const [key,value] of Object.entries(normalized.product_drafts||{})){try{P.descriptor(key);if(value.type!==key)continue;P.validateProduct(value);drafts[key]=copy(value);}catch{}}
    drafts[type()]=copy(active);signature='';uploadEpoch++;restoring=true;populate();signature=active.artwork?.source==='text'?(active.artwork_signature||drawingSignature()):'';if(active.artwork?.source==='text'&&!active.artwork_signature)active.artwork_signature=signature;restoring=false;return normalized;
  }
  function drawingSignature(){return JSON.stringify([type(),active.params,formDimensions().width_cm,formDimensions().height_cm]);}
  function artworkError(message){$('artworkStatus').textContent=message;$('artworkStatus').classList.toggle('product-error',Boolean(message));}
  function showArtwork(){
    const artwork=active.artwork;$('artworkImage').hidden=!artwork;if(artwork)$('artworkImage').src=artwork.data_url;else $('artworkImage').removeAttribute('src');
    $('openArtwork').disabled=!artwork;$('downloadArtwork').disabled=!artwork;$('removeArtwork').hidden=artwork?.source!=='uploaded';$('removeArtwork').textContent=uploadOnly()?'Удалить оригинал':'Удалить оригинал и использовать текст';
    $('artworkStatus').classList.remove('product-error');$('artworkStatus').textContent=artwork?`${artwork.source==='uploaded'?'Загруженный оригинал':'PNG из текста'}: ${artwork.name} · ${artwork.width_px} × ${artwork.height_px} px`:'Введите текст или загрузите оригинальный PNG.';
  }
  async function textArtwork(){
    if(uploadOnly())throw new Error('Для этого изделия нужен загруженный оригинальный PNG.');
    const rows=window.LetterGeometry.textLines(active.params.text);if(!rows.some(row=>row.trim())){delete active.artwork;showArtwork();return null;}
    const p=active.params,placement=formDimensions();
    const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
    const font=`${p.font_bold?'700':'400'} 100px "${p.font_family.replace(/["\\]/g,'')}"`;
    if(document.fonts?.ready)await document.fonts.ready;ctx.font=font;
    const metrics=rows.map(text=>{const m=ctx.measureText(text);return {text,width:m.width,ascent:m.actualBoundingBoxAscent||78,descent:m.actualBoundingBoxDescent||22,left:m.actualBoundingBoxLeft||0,right:m.actualBoundingBoxRight||m.width};});
    const maxWidth=Math.max(...metrics.map(m=>Math.max(m.width,m.left+m.right))),glyphHeight=metrics.reduce((v,m)=>v+m.ascent+m.descent,0);
    const physicalMargin=family()==='neon'?(p.backing!=='none'?p.backing_margin_mm:0):p.margin_mm||0;
    const availWidth=placement.width_cm-physicalMargin/5,availHeight=placement.height_cm-physicalMargin/5,gapTotal=(rows.length-1)*p.line_gap_cm;
    if(!(availWidth>0&&availHeight>gapTotal))throw new Error('Поля и межстрочный зазор не помещаются в габарит изделия.');
    const sizeCm=Math.min(availWidth/maxWidth*100,(availHeight-gapTotal)/glyphHeight*100),gap=p.line_gap_cm/sizeCm*100;
    const tube=family()==='neon'?Math.max(.8,p.tubing_mm/10/sizeCm*100):0;
    const pad=Math.ceil(tube/2+3),rawWidth=maxWidth+pad*2,rawHeight=glyphHeight+(rows.length-1)*gap+pad*2;
    const scale=Math.min(12,1800/Math.max(rawWidth,rawHeight));canvas.width=Math.max(1,Math.ceil(rawWidth*scale));canvas.height=Math.max(1,Math.ceil(rawHeight*scale));
    ctx.scale(scale,scale);ctx.font=font;ctx.fillStyle=p.front_color;ctx.strokeStyle=p.front_color;ctx.lineWidth=tube;ctx.lineJoin='round';ctx.lineCap='round';ctx.textBaseline='alphabetic';
    let y=pad;for(const m of metrics){y+=m.ascent;const x=pad+(p.text_align==='right'?maxWidth-m.width:p.text_align==='center'?(maxWidth-m.width)/2:0);if(family()==='neon')ctx.strokeText(m.text,x,y);else ctx.fillText(m.text,x,y);y+=m.descent+gap;}
    const artwork={name:`${type()}-text.png`,mime_type:'image/png',source:'text',data_url:canvas.toDataURL('image/png'),width_px:canvas.width,height_px:canvas.height};
    P.validateProduct({...active,artwork});return artwork;
  }
  async function prepareArtwork(attempt=0){
    if(isLetters()&&window.SignageLetterUI){await window.SignageLetterUI.prepareArtwork();saveCurrent();return null;}
    if(definition().artwork_mode==='none')return null;saveCurrent();
    if(uploadOnly()||$('artworkSource').value==='uploaded'){if(!active.artwork||active.artwork.source!=='uploaded')throw new Error('Загрузите оригинальный PNG для выбранного изделия.');return active.artwork;}
    const nextSignature=drawingSignature();if(active.artwork_signature===nextSignature&&active.artwork?.source==='text')return active.artwork;
    const id=active.id,epoch=uploadEpoch,artwork=await textArtwork();if(id!==active.id||epoch!==uploadEpoch)throw new Error('Изделие изменилось во время подготовки. Повторите действие для текущего изделия.');
    saveCurrent();if(nextSignature!==drawingSignature()){if(attempt>=2)throw new Error('Параметры изменяются во время подготовки. Завершите правки и повторите действие.');return prepareArtwork(attempt+1);}
    if(artwork)active.artwork=artwork;else delete active.artwork;signature=nextSignature;active.artwork_signature=signature;drafts[type()]=copy(active);showArtwork();return artwork;
  }
  function scheduleArtwork(){
    if(restoring||definition().artwork_mode!=='text_or_upload'||uploadOnly()||$('artworkSource').value==='uploaded')return;
    clearTimeout(timer);timer=setTimeout(async()=>{try{const before=active.artwork?.data_url;await prepareArtwork();if(before!==active.artwork?.data_url)window.SignageEditor?.render();}catch(error){artworkError(error.message);}},180);
  }
  $('productPicker').replaceChildren(...P.list().map(spec=>{const button=document.createElement('button');button.type='button';button.dataset.productType=spec.type;button.textContent=spec.label;button.setAttribute('aria-pressed',String(spec.type===type()));button.onclick=()=>switchType(spec.type);return button;}));
  $('catalogCategory').replaceChildren(...['',...new Set(P.catalogue().map(t=>t.category).filter(Boolean))].map(category=>{const option=document.createElement('option');option.value=category;option.textContent=category||'Все категории';return option;}));
  $('catalogSearch').oninput=()=>catalogueOptions();$('catalogCategory').onchange=()=>catalogueOptions();$('productTemplate').onchange=selectionNote;
  $('applyProductTemplate').onclick=()=>{const template=P.catalogue().find(t=>t.id===$('productTemplate').value);if(!template)return;saveCurrent();const oldPlacement=active.placement,oldArtwork=active.artwork?.source==='uploaded'&&P.renderer(template.type)===family()?active.artwork:null,backgroundAI=active.background_ai;uploadEpoch++;active=P.createProduct(template.type,template.id);dimensions[type()]=copy(template.default_placement);if(oldArtwork)active.artwork=oldArtwork;active.background_ai=backgroundAI;if(oldPlacement)active.placement={...oldPlacement,...template.default_placement};signature='';populate(isLetters());window.SignageEditor?.setPlacement(active.placement);window.SignageEditor?.render();};
  $('dynamicProductFields').addEventListener('input',()=>window.SignageEditor?.render());$('dynamicProductFields').addEventListener('change',()=>window.SignageEditor?.render());
  $('productFontBold').onchange=()=>window.SignageEditor?.render();
  $('artworkSource').onchange=()=>{uploadEpoch++;signature='';if($('artworkSource').value==='text'&&active.artwork?.source==='uploaded')delete active.artwork;updateFields();showArtwork();window.SignageEditor?.render();};
  $('productAiBackground').onchange=()=>{active.background_ai=$('productAiBackground').checked;window.SignageEditor?.render();};
  $('artworkUpload').onchange=async event=>{
    const file=event.target.files?.[0];if(!file)return;const epoch=++uploadEpoch,id=active.id;
    try{
      if(file.type!=='image/png'&& !/\.png$/i.test(file.name))throw new Error('Точный оригинал должен быть PNG.');if(file.size>2*1024*1024)throw new Error('Максимальный размер оригинала — 2 МиБ.');
      const url=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error('Не удалось прочитать файл.'));r.readAsDataURL(file);});
      const img=await new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('Не удалось открыть PNG.'));image.src=url;});
      if(img.naturalWidth>4096||img.naturalHeight>4096||img.naturalWidth*img.naturalHeight>16000000)throw new Error('PNG должен быть не больше 4096 px по стороне и 16 мегапикселей.');
      if(definition().requires_transparency){const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const x=c.getContext('2d');x.drawImage(img,0,0);const pixels=x.getImageData(0,0,c.width,c.height).data;let transparent=false,visible=false;for(let i=3;i<pixels.length;i+=4){if(pixels[i]<255)transparent=true;if(pixels[i]>0)visible=true;}if(!transparent||!visible)throw new Error('Нужен PNG с видимым макетом и прозрачностью вокруг контура.');}
      const artwork={name:file.name,mime_type:'image/png',source:'uploaded',data_url:url,width_px:img.naturalWidth,height_px:img.naturalHeight};P.validateProduct({...active,artwork});
      if(epoch!==uploadEpoch||id!==active.id)return;active.artwork=artwork;drafts[type()]=copy(active);showArtwork();window.SignageEditor?.render();
    }catch(error){if(epoch===uploadEpoch)artworkError(error.message);}finally{event.target.value='';}
  };
  $('removeArtwork').onclick=()=>{uploadEpoch++;delete active.artwork;signature='';$('artworkSource').value=uploadOnly()?'uploaded':'text';updateFields();showArtwork();window.SignageEditor?.render();};
  $('openArtwork').onclick=async()=>{try{await prepareArtwork();if(active.artwork)window.SignagePreview.openImage({src:active.artwork.data_url,title:`Точный макет · ${active.artwork.name}`,filename:active.artwork.name});}catch(error){artworkError(error.message);}};
  $('downloadArtwork').onclick=async()=>{try{await prepareArtwork();if(active.artwork){const a=document.createElement('a');a.href=active.artwork.data_url;a.download=active.artwork.name;a.click();}}catch(error){artworkError(error.message);}};
  document.addEventListener('signage:change',scheduleArtwork);
  window.SignageProductUI={draftState:()=>({version:1,dimensions:copy(dimensions),products:copy(Object.fromEntries(Object.entries(drafts).filter(([key])=>key!==type())))}),restoreDraftState:state=>{if(state?.version!==1)return;for(const [key,value] of Object.entries(state.dimensions||{})){try{P.descriptor(key);if(value&&Number.isFinite(value.width_cm)&&value.width_cm>0&&Number.isFinite(value.height_cm)&&value.height_cm>0)dimensions[key]=copy(value);}catch{}}for(const [key,value] of Object.entries(state.products||{})){try{P.descriptor(key);if(key===type()||value.type!==key)continue;P.validateProduct(value);drafts[key]=copy(value);}catch{}}},materialMetadata:()=>copy(active.params.face_material||{}),generationFooter,compose,restore,type,renderer:family,prepareArtwork,switchType,active:()=>copy(active),generationEngine:()=>isLetters()?'codex':P.capabilities(active).background_ai&&$('productAiBackground').checked?'codex_composite':'composite',resetPlacement:()=>{active.placement=null;Object.values(drafts).forEach(product=>product.placement=null);},draftControls:Object.values(typeFields).flatMap(Object.values).concat(['productFontBold','productAiBackground','artworkSource'])};
  populate();
})();
