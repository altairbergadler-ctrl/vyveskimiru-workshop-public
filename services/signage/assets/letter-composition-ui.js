/* Independent, physical-size text blocks and exact supplied logos. */
(() => {
  'use strict';
  const $=id=>document.getElementById(id),P=window.SignageProducts,G=window.LetterGeometry;
  const section=$('letterComposition');if(!section||!P||!G)return;
  const copy=P.copyData;
  const maxObjects=20,maxTextBytes=1024*1024,maxArtworkSide=4096,maxArtworkPixels=16000000;
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
  const choices=new Map(),metricsCache=new Map(),logoChecks=new Map(),textArtworkChecks=new WeakMap();
  const fontLoads=new Map(),fontChoices=['PT Sans Narrow','Arial Narrow','Arial','Arial Black','Segoe UI','Georgia','Tahoma','Verdana','Times New Roman','Trebuchet MS','Impact'];
  const bundledFont=object=>object.font_family?.trim()==='PT Sans Narrow';
  const exactFont=object=>bundledFont(object)||object.font_family?.trim()==='Arial Narrow';
  let customFontOpen=false;
  let objects=[],selection=null,lastLayout=null,uploadEpoch=0,sceneEpoch=0,uploadRequest=null,uploadMessage='',uploadError=false,invalidObjects=null;
  let previousLetters=true,formObject=null,restoreIssue='',artworkEpoch=0,compositionMode='independent_objects_v1';
  const independentMode='independent_signs_v1',pendingPlacement=new Set();
  const independent=()=>compositionMode===independentMode;
  const isLetters=()=>!window.SignageProductUI||window.SignageProductUI.renderer()==='channel_letters';
  const selected=()=>objects.find(object=>object&&object.id===selection)||null;
  const newId=type=>`${type}-${window.crypto?.randomUUID?.()||`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
  const round=value=>Number.isFinite(value)?new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(value):'—';
  const coordinate=value=>Number.isFinite(value)?Math.round(value*10)/10:value;
  const numeric=input=>input.validity.badInput||!input.value.trim()?'invalid':Number.isFinite(Number(input.value))?Number(input.value):'invalid';
  const render=()=>window.SignageEditor?.render();
  const productionDefaults=sign=>({depth_cm:sign?.depth_cm??Number($('depth')?.value||5),side_color:sign?.side_color||$('sideColor')?.value||'#292f30',brief:sign?.brief??$('brief')?.value??''});
  function title(object){const at=objects.filter(item=>item&&item.type===object.type).indexOf(object)+1;return `${object.type==='text'?(independent()?'Вывеска':'Текст'):object.type==='logo'?'Лого':'Объект'} ${at}`;}
  function status(message=uploadMessage,error=uploadError){
    const issue=validationError(),fallback=objects.find(object=>object?.type==='text'&&object.artwork?.font_fallback);
    $('letterObjectStatus').textContent=message||issue||(fallback?`${title(fallback)}: шрифт «${fallback.font_family}» недоступен на этом устройстве; точный PNG использует браузерную замену «${fallback.artwork.font_family_rendered}».`:'');
    $('letterObjectStatus').classList.toggle('letter-error',Boolean(error||(!message&&issue&&!/^(Проверяем|Загружаем)/.test(issue))));
  }
  function setInput(id,value,force=false){const input=$(id);if(force||document.activeElement!==input)input.value=value??'';}
  function measureRow(text,family,bold){
    ctx.font=`${bold===false?400:700} 100px ${G.compositionFontFamily(family)}`;
    const measured=ctx.measureText(text),visible=Boolean(text.trim());
    return {text,font_family:family,font_weight:bold===false?400:700,width:measured.width,
      actualBoundingBoxAscent:measured.actualBoundingBoxAscent??(visible?78:0),actualBoundingBoxDescent:measured.actualBoundingBoxDescent??(visible?22:0),
      actualBoundingBoxLeft:measured.actualBoundingBoxLeft??0,actualBoundingBoxRight:measured.actualBoundingBoxRight??measured.width};
  }
  function metricsKey(object){return JSON.stringify([object.text,object.font_family,object.font_bold,object.height_basis==='body',object.height_basis==='body'?(object.height_reference??'auto'):null]);}
  function objectMetrics(object){
    const key=metricsKey(object);
    let result=metricsCache.get(key);
    if(!result){
      const family=typeof object.font_family==='string'?object.font_family.trim():'Arial';
      result={font_size_px:100,font_family:family,font_weight:object.font_bold===false?400:700,
        lines:G.textLines(object.text).map(text=>measureRow(text,family,object.font_bold))};
      if(object.height_basis==='body'){
        let reference='Н';try{reference=G.letterHeightReference(object).text;}catch{}
        result.height_reference=measureRow(reference,family,object.font_bold);
      }
      metricsCache.set(key,result);if(metricsCache.size>200)metricsCache.delete(metricsCache.keys().next().value);
    }
    return copy(result);
  }
  function textInputs(object){
    const inputs=[object.text,object.font_family,object.font_bold,object.letter_height_cm,object.line_gap_cm??0,object.text_align??'left',object.front_color||'#fff3dc'];
    if(object.height_basis==='body')inputs.push('body',object.height_reference??'auto');
    return JSON.stringify(inputs);
  }
  function artworkSignature(object,metrics=object.preview_line_metrics){return JSON.stringify([textInputs(object),metrics]);}
  function discardStaleArtwork(object){
    let valid=object.artwork?.source==='text'&&object.artwork_signature===artworkSignature(object);
    if(valid){
      let checked=textArtworkChecks.get(object.artwork);
      if(checked===undefined){try{checked=P.artworkInfo(object.artwork).size_bytes<=maxTextBytes;}catch{checked=false;}textArtworkChecks.set(object.artwork,checked);}
      valid=checked;
    }
    if(!valid){delete object.artwork;delete object.artwork_signature;}
  }
  function refreshMetrics(){for(const object of objects)if(object?.type==='text'){
    const loading=bundledFont(object)?loadBundledFont(object):null;
    // A saved project's exact metrics/PNG must not be replaced by a temporary
    // system fallback while its webfont is still arriving on a different PC.
    if(loading?.status!=='ready'&&bundledFont(object)&&object.preview_line_metrics)continue;
    object.preview_line_metrics=objectMetrics(object);discardStaleArtwork(object);
  }}
  function loadBundledFont(object){
    const weight=object.font_bold===false?400:700,key=String(weight);
    if(fontLoads.has(key))return fontLoads.get(key);
    const entry={status:'loading',promise:null};fontLoads.set(key,entry);
    entry.promise=Promise.resolve().then(()=>document.fonts.load(`${weight} 100px "PT Sans Narrow"`,'ДЕТЕЙЛИНГ Н')).then(faces=>{
      entry.status=faces.length&&fontAvailable('PT Sans Narrow',weight!==400)?'ready':'error';
    },()=>{entry.status='error';}).then(()=>{
      metricsCache.clear();
      if(objects.some(item=>item?.type==='text'&&bundledFont(item))){lastLayout=null;refreshMetrics();status();render();}
    });
    return entry;
  }
  function fontIssue(object){
    if(!exactFont(object))return null;
    if(bundledFont(object)){
      const state=loadBundledFont(object).status;
      if(state==='loading')return 'Загружаем шрифт PT Sans Narrow…';
      if(state==='error')return 'Не удалось загрузить PT Sans Narrow. Обновите страницу, чтобы повторить загрузку.';
    }
    if(!fontAvailable(object.font_family,object.font_bold))return `Шрифт «${object.font_family}» недоступен на этом устройстве. Установите его или выберите встроенный PT Sans Narrow.`;
    return null;
  }
  function quotedFamily(family){return G.compositionFontFamily(family).replace(/, Arial, sans-serif$/,'');}
  function fontAvailable(family,bold){
    // FontFaceSet.check() alone returns true for unknown local names. Compare
    // this one family against two distinct fallback faces before claiming it.
    family=family.trim();const probe='AaБбЖж0123456789 Wm_€',weight=bold===false?400:700;
    const metric=font=>{ctx.font=`${weight} 100px ${font}`;const m=ctx.measureText(probe);return ['width','actualBoundingBoxAscent','actualBoundingBoxDescent','actualBoundingBoxLeft','actualBoundingBoxRight'].map(key=>m[key]);};
    const different=(a,b)=>a.some((value,index)=>Number.isFinite(value)&&Number.isFinite(b[index])&&Math.abs(value-b[index])>1e-6);
    return ['monospace','serif'].some(fallback=>different(metric(`${quotedFamily(family)}, ${fallback}`),metric(fallback)));
  }
  async function prepareFonts(object){
    if(bundledFont(object))await loadBundledFont(object).promise;
    const family=object.font_family.trim(),font=`${object.font_bold===false?400:700} 100px ${G.compositionFontFamily(family)}`;
    if(document.fonts?.load)await document.fonts.load(font,(object.text||'AaБб')+(object.height_basis==='body'?G.letterHeightReference(object).text:''));
    if(document.fonts?.ready)await document.fonts.ready;
    const available=fontAvailable(family,object.font_bold);
    if(exactFont(object)){const issue=fontIssue(object);if(issue)throw new Error(issue);}
    return {available,rendered:available?family:fontAvailable('Arial',object.font_bold)?'Arial':'sans-serif'};
  }
  function rasterText(object,metrics,font){
    const layout=G.independentObjectLayout({...object,preview_line_metrics:metrics}),w=layout.width_cm,h=layout.height_cm;
    let density=Math.min(maxArtworkSide/Math.max(w,h),Math.sqrt(maxArtworkPixels/(w*h)));
    for(let attempt=0;attempt<10;attempt++){
      const raster=document.createElement('canvas');
      raster.width=Math.max(1,Math.min(maxArtworkSide,Math.floor(w*density)));raster.height=Math.max(1,Math.min(maxArtworkSide,Math.floor(h*density)));
      while(raster.width*raster.height>maxArtworkPixels){if(raster.width>=raster.height)raster.width--;else raster.height--;}
      const context=raster.getContext('2d');if(!context)throw new Error('Браузер не может подготовить точный PNG текста.');
      // Draw at the same 100 px reference used for visible ink measurements.
      // Separate pixel scales keep the physical block exact after rounding.
      const unit=layout.font_size_cm/100;
      context.setTransform(raster.width/w*unit,0,0,raster.height/h*unit,0,0);
      context.font=`${object.font_bold===false?400:700} 100px ${G.compositionFontFamily(object.font_family.trim())}`;
      context.textBaseline='alphabetic';context.textAlign='left';context.fillStyle=object.front_color||'#fff3dc';
      for(const line of layout.lines)if(!line.blank)context.fillText(line.text,line.x_cm/unit,line.baseline_cm/unit);
      const artwork={name:`text-${object.id}.png`.slice(0,240),mime_type:'image/png',source:'text',data_url:raster.toDataURL('image/png'),width_px:raster.width,height_px:raster.height,
        font_family_requested:object.font_family.trim(),font_family_rendered:font.rendered,font_fallback:!font.available,glyph_fallback:'browser_font_stack'};
      const encoded=artwork.data_url.slice('data:image/png;base64,'.length),size=encoded.length/4*3-(encoded.endsWith('==')?2:encoded.endsWith('=')?1:0);
      if(size<=maxTextBytes){
        P.artworkInfo(artwork);
        const pixels=context.getImageData(0,0,raster.width,raster.height).data;let visible=false,transparent=false;
        for(let i=3;i<pixels.length;i+=4){visible||=pixels[i]>0;transparent||=pixels[i]<255;if(visible&&transparent)break;}
        if(!visible)throw new Error('Текст слишком мелкий для точного PNG в допустимом размере. Разделите его на несколько объектов.');
        if(!transparent)throw new Error('Не удалось сохранить прозрачный фон текста.');
        return artwork;
      }
      density*=.75;
    }
    throw new Error('Точный PNG текста превышает 1 МиБ. Разделите текст на несколько объектов.');
  }
  async function prepareArtwork(){
    if(!isLetters())return [];sync();
    const issue=validationError();if(issue&&!issue.startsWith('Загружаем шрифт'))throw new Error(issue);
    const epoch=sceneEpoch,request=++artworkEpoch,scene=objects.slice(),texts=scene.filter(object=>object?.type==='text');
    for(const object of texts)G.independentObjectLayout(object);
    const inputs=new Map(texts.map(object=>[object,textInputs(object)])),prepared=[];
    const current=()=>epoch===sceneEpoch&&request===artworkEpoch&&isLetters()&&scene.length===objects.length&&scene.every((object,index)=>objects[index]===object)&&texts.every(object=>textInputs(object)===inputs.get(object));
    for(const object of texts){
      const font=await prepareFonts(object);if(!current())throw new Error('Композиция изменилась во время подготовки текста. Повторите действие для текущих объектов.');
      // Font loading can change glyphs without changing the typed family name.
      metricsCache.delete(metricsKey(object));
      const metrics=objectMetrics(object),signature=artworkSignature(object,metrics);
      const artwork=object.artwork?.source==='text'&&object.artwork_signature===signature&&object.artwork.font_family_rendered===font.rendered&&object.artwork.font_fallback===!font.available?object.artwork:rasterText(object,metrics,font);
      prepared.push({object,metrics,signature,artwork});
    }
    if(!current())throw new Error('Композиция изменилась во время подготовки текста. Повторите действие для текущих объектов.');
    // Commit together: an expired font wait cannot partly replace the scene.
    for(const item of prepared){item.object.preview_line_metrics=item.metrics;item.object.artwork=item.artwork;item.object.artwork_signature=item.signature;}
    lastLayout=null;status();return prepared.map(item=>copy(item.artwork));
  }
  function validationError(){
    if(!isLetters())return null;
    if(invalidObjects!==null)return 'Список объектов должен быть массивом.';
    if(restoreIssue)return restoreIssue;
    for(const object of objects)if(object?.type==='text'){const issue=fontIssue(object);if(issue)return issue.startsWith('Загружаем')?issue:`${title(object)}: ${issue}`;}
    for(const object of objects){const check=logoChecks.get(object?.id);if(check?.pending)return 'Проверяем PNG логотипа…';if(check?.error)return `${title(object)}: ${check.error}`;}
    return null;
  }
  function showList(){
    const current=new Set(objects);for(const [object,node]of choices)if(!current.has(object)){node.button.remove();choices.delete(object);}
    const nodes=objects.map((object,index)=>{
      const item=object&&typeof object==='object'?object:{type:'invalid',id:null};let node=choices.get(object);
      if(!node){
        const button=document.createElement('button');button.type='button';button.className='letter-object-choice';
        const icon=document.createElement('span');icon.className='letter-object-icon';icon.setAttribute('aria-hidden','true');
        const caption=document.createElement('span');caption.className='letter-object-caption';
        const name=document.createElement('b'),excerpt=document.createElement('small');caption.append(name,excerpt);button.append(icon,caption);
        button.addEventListener('click',()=>select(item.id));node={button,icon,name,excerpt,type:null,artwork:null};choices.set(object,node);
      }
      node.button.dataset.objectId=typeof item.id==='string'?item.id:'';
      node.button.setAttribute('aria-pressed',String(item.id===selection));node.name.textContent=title(item);
      node.excerpt.textContent=item.type==='text'?(String(item.text??'').replace(/\s+/g,' ').trim()||'Пустой текст'):item.artwork?.name||'Проверьте объект';
      if(node.type!==item.type||node.artwork!==item.artwork?.data_url){
        node.icon.replaceChildren();if(item.type==='logo'&&typeof item.artwork?.data_url==='string'){const img=document.createElement('img');img.src=item.artwork.data_url;img.alt='';node.icon.append(img);}else node.icon.textContent=item.type==='text'?'Т':'◇';
        node.type=item.type;node.artwork=item.artwork?.data_url;
      }
      node.button.setAttribute('aria-label',`${node.name.textContent}: ${node.excerpt.textContent}`);return node.button;
    });
    const container=$('letterObjectList');if(nodes.length!==container.children.length||nodes.some((node,index)=>container.children[index]!==node))container.replaceChildren(...nodes);
    $('letterObjectEmpty').hidden=objects.length>0;$('letterObjectCount').textContent=`${objects.length} / ${maxObjects}`;
    $('letterHeightMigration').hidden=!objects.some(object=>object?.type==='text'&&object.height_basis===undefined);
    $('letterAddText').disabled=objects.length>=maxObjects;$('letterAddLogo').disabled=objects.length>=maxObjects;
  }
  function updateSize(){
    const object=selected();if(!object){$('letterObjectSize').textContent='';return;}
    let layout=lastLayout?.objects?.find(item=>item.id===object.id);
    if(!layout){try{layout=G.independentObjectLayout(object);}catch{}}
    $('letterObjectSize').textContent=layout?(layout.height_basis==='body'?`Основная высота: ${round(layout.body_height_cm)} см · полный габарит: ${round(layout.width_cm)} × ${round(layout.height_cm)} см`:`Полный габарит: ${round(layout.width_cm)} × ${round(layout.height_cm)} см`):'Размер после корректного расчёта';
    if(object.type==='text'){
      const body=(object.height_basis??'bounds')==='body';
      $('letterObjectHeightLabel').textContent=body?'Основная высота, см':'Габарит строки, см';
      $('letterObjectReferenceField').hidden=!body;
      let reference;try{reference=G.letterHeightReference(object);}catch{}
      $('letterObjectHeightHint').textContent=body?`Размер задаётся по ${reference?.letter_case==='lowercase'?'строчным':'заглавным'} буквам${reference?` (эталон «${reference.text}»)`:''}. Верхние и нижние выступы входят в полный габарит. Пропорции шрифта сохраняются.`:'Высота задаётся по полному контуру самой высокой строки, включая все выступы. PT Sans Narrow встроен; остальные шрифты берутся с устройства.';
    }
    const artwork=object.artwork;$('letterObjectLogoSize').textContent=object.type==='logo'&&artwork?`Высота ${round(object.width_cm*artwork.height_px/artwork.width_px)} см · пропорции сохраняются`:'';
  }
  function showForm(force=false){
    const object=selected();$('letterObjectSettings').hidden=!object;if(!object){formObject=null;return;}
    if(formObject!==object)customFontOpen=false;
    force||=formObject!==object;formObject=object;$('letterObjectTitle').textContent=title(object);
    $('letterTextSettings').hidden=object.type!=='text';$('letterLogoSettings').hidden=object.type!=='logo';
    setInput('letterObjectX',coordinate(object.x_cm),force);setInput('letterObjectY',coordinate(object.y_cm),force);setInput('letterObjectRotation',object.rotation_deg,force);
    setInput('letterObjectDepth',object.depth_cm,force);setInput('letterObjectSideColor',object.side_color,force);setInput('letterObjectBrief',object.brief,force);
    if(object.type==='text'){
      for(const [id,key]of [['letterObjectText','text'],['letterObjectHeight','letter_height_cm'],['letterObjectFont','font_family'],['letterObjectGap','line_gap_cm'],['letterObjectAlign','text_align'],['letterObjectColor','front_color']])setInput(id,object[key],force);
      setInput('letterObjectHeightBasis',object.height_basis??'bounds',force);setInput('letterObjectHeightReference',object.height_reference??'auto',force);
      $('letterObjectBold').checked=object.font_bold===true;
      const custom=customFontOpen||!fontChoices.includes(object.font_family);
      setInput('letterFontPicker',custom?'__custom__':object.font_family,true);
      $('letterCustomFontField').hidden=!custom;
    }else if(object.type==='logo'){
      setInput('letterObjectWidth',object.width_cm,force);const artwork=object.artwork;
      if(artwork?.data_url)$('letterObjectThumbnail').src=artwork.data_url;else $('letterObjectThumbnail').removeAttribute('src');
      $('letterObjectThumbnail').alt=`Логотип: ${artwork?.name||title(object)}`;
      $('letterObjectLogoName').textContent=artwork?`${artwork.name??'PNG'} · ${artwork.width_px??'—'} × ${artwork.height_px??'—'} px`:'Проверьте оригинал PNG';
    }
    updateSize();
  }
  function sync(){
    const letters=isLetters();section.hidden=!letters;document.documentElement.dataset.letterObjects=String(letters);
    if(previousLetters&&!letters){uploadEpoch++;sceneEpoch++;uploadRequest=null;$('letterLogoUpload').value='';uploadMessage='';uploadError=false;}
    previousLetters=letters;if(!letters)return;refreshMetrics();showList();showForm();status();
  }
  function settings(){sync();return {objects:isLetters()?copy(invalidObjects!==null?invalidObjects:objects):[],composition_mode:compositionMode};}
  function summaryText(){return objects.filter(object=>object?.type==='text').map(object=>String(object.text??'')).filter(text=>text.trim()).join('\n');}
  function select(id){
    if(!objects.some(object=>object?.id===id))return false;
    if(selection===id){showForm();return true;}
    selection=id;showList();showForm(true);render();return true;
  }
  function setObjectPosition(id,x,y){const object=objects.find(item=>item?.id===id);if(!object)return;pendingPlacement.delete(object);object.x_cm=x;object.y_cm=y;lastLayout=null;if(selection===id){setInput('letterObjectX',coordinate(x),true);setInput('letterObjectY',coordinate(y),true);}updateSize();}
  function updateLayout(layout){lastLayout=layout;updateSize();}
  const objectBounds=layout=>({left:Math.min(...layout.bounds_cm.map(point=>point[0])),top:Math.min(...layout.bounds_cm.map(point=>point[1])),
    right:Math.max(...layout.bounds_cm.map(point=>point[0])),bottom:Math.max(...layout.bounds_cm.map(point=>point[1]))});
  function placementArea(){
    try{
      const context=window.SignageEditor?.placementContext?.(),calibration=context?.calibration,image=context?.image;
      if(!calibration?.imageToWorld||!calibration?.worldToImage)return null;
      const imagePolygon=image?.width_px>0&&image?.height_px>0?[[0,0],[image.width_px,0],[image.width_px,image.height_px],[0,image.height_px]]:null;
      const target=context.target_polygon_px||context.polygon_px||context.target||imagePolygon;
      if(!target)return null;G.quad(target);
      const polygon=calibration.target_world_cm||target.map(point=>G.apply(calibration.imageToWorld,point));G.quad(polygon);
      // Check the denominator along the whole region before using its plane.
      if(Array.isArray(calibration.imageToWorld)){const denominators=target.map(([x,y])=>calibration.imageToWorld[6]*x+calibration.imageToWorld[7]*y+calibration.imageToWorld[8]);if(!denominators.every(value=>Math.abs(value)>1e-9&&value*denominators[0]>0))return null;}
      return {polygon,target,imagePolygon,calibration};
    }catch{return null;}
  }
  function clipPositions(polygon,a,b,c){
    const result=[];
    for(let at=0;at<polygon.length;at++){
      const start=polygon[at],end=polygon[(at+1)%polygon.length],from=a*start[0]+b*start[1]+c,to=a*end[0]+b*end[1]+c;
      if(from>=-1e-8)result.push(start);
      if((from>=0)!==(to>=0)){const fraction=from/(from-to);result.push([start[0]+fraction*(end[0]-start[0]),start[1]+fraction*(end[1]-start[1])]);}
    }
    return result;
  }
  function placeIndependentObject(object){
    const area=placementArea();if(!area)return false;
    let own;try{own=objectBounds(G.independentObjectLayout(object));}catch{return true;}
    const w=own.right-own.left,h=own.bottom-own.top,polygon=area.polygon;
    const left=Math.min(...polygon.map(point=>point[0])),right=Math.max(...polygon.map(point=>point[0]))-w;
    const top=Math.min(...polygon.map(point=>point[1])),bottom=Math.max(...polygon.map(point=>point[1]))-h;
    let feasible=right>=left&&bottom>=top?[[left,top],[right,top],[right,bottom],[left,bottom]]:[];
    // Erode each convex region by this object's physical rectangle. Candidate
    // top-left positions then keep every corner inside the installation area.
    const constrain=region=>{
      const turn=(region[1][0]-region[0][0])*(region[2][1]-region[1][1])-(region[1][1]-region[0][1])*(region[2][0]-region[1][0]),direction=turn>=0?1:-1;
      for(let at=0;at<region.length&&feasible.length;at++){
        const start=region[at],end=region[(at+1)%region.length],a=-(end[1]-start[1])*direction,b=(end[0]-start[0])*direction;
        const c=-a*start[0]-b*start[1]+Math.min(0,a*w)+Math.min(0,b*h);
        feasible=clipPositions(feasible,a,b,c);
      }
    };
    constrain(polygon);
    if(area.imagePolygon&&Array.isArray(area.calibration.imageToWorld)){
      const denominators=area.imagePolygon.map(([x,y])=>area.calibration.imageToWorld[6]*x+area.calibration.imageToWorld[7]*y+area.calibration.imageToWorld[8]);
      // A photo may contain the horizon while the chosen installation zone is
      // fully on one stable plane. Only project the full image rectangle when
      // it stays on that plane; pixel bounds are still checked for candidates.
      if(denominators.every(value=>Math.abs(value)>1e-9&&value*denominators[0]>0))constrain(area.imagePolygon.map(point=>G.apply(area.calibration.imageToWorld,point)));
    }
    const occupied=[];for(const current of objects){if(current===object)continue;try{occupied.push(objectBounds(G.independentObjectLayout(current)));}catch{}}
    let position=null;
    if(feasible.length){
      const center=feasible.reduce((sum,point)=>[sum[0]+point[0]/feasible.length,sum[1]+point[1]/feasible.length],[0,0]);
      const minX=Math.min(...feasible.map(point=>point[0])),maxX=Math.max(...feasible.map(point=>point[0])),minY=Math.min(...feasible.map(point=>point[1])),maxY=Math.max(...feasible.map(point=>point[1]));
      const gap=Math.min(3,Math.max(.2,Math.min(w,h)*.1)),xs=new Set([center[0],minX,maxX]),ys=new Set([center[1],minY,maxY]);
      const candidates=[center,...feasible];
      for(const box of occupied){xs.add(box.left-w-gap);xs.add(box.right+gap);ys.add(box.top-h-gap);ys.add(box.bottom+gap);}
      for(let at=1;at<24;at++){xs.add(minX+(maxX-minX)*at/24);ys.add(minY+(maxY-minY)*at/24);}
      const fits=([x,y])=>[[x,y],[x+w,y],[x+w,y+h],[x,y+h]].every(point=>G.inside(point,polygon)&&(!area.imagePolygon||G.inside(G.apply(area.calibration.worldToImage,point),area.imagePolygon)));
      for(const x of xs)for(const y of ys)if(fits([x,y]))candidates.push([x,y]);
      candidates.sort((a,b)=>(a[0]-center[0])**2+(a[1]-center[1])**2-((b[0]-center[0])**2+(b[1]-center[1])**2));
      position=candidates.find(([x,y])=>fits([x,y])&&!occupied.some(box=>x<box.right+gap&&x+w+gap>box.left&&y<box.bottom+gap&&y+h+gap>box.top));
      // Crowding never moves or resizes an existing sign. Keep a new one within
      // the region and avoid an identical origin so it remains selectable.
      position||=candidates.find(([x,y])=>fits([x,y])&&!occupied.some(box=>Math.abs(box.left-x)<1e-7&&Math.abs(box.top-y)<1e-7));
      position||=candidates.find(fits);
    }
    if(!position){
      const center=polygon.reduce((sum,point)=>[sum[0]+point[0]/polygon.length,sum[1]+point[1]/polygon.length],[0,0]);
      position=[center[0]-w/2,center[1]-h/2];uploadMessage='Новая вывеска не помещается в область установки. Уменьшите её размер или расширьте область.';uploadError=true;
    }
    object.x_cm+=position[0]-own.left;object.y_cm+=position[1]-own.top;
    return true;
  }
  function makeIndependent(calibrationSpec,placement){
    if(invalidObjects!==null)return false;
    let changed=false;
    if(!independent()){
      if(objects.length){
        try{
          const calibration=calibrationSpec?.worldToImage?calibrationSpec:G.calibrate(calibrationSpec);
          const migrated=G.independentSignsFromComposition(objects,placement,calibration);
          // Keep object identity for any pending original-PNG validation or
          // font preparation; migration changes only physical placement.
          migrated.forEach((object,index)=>Object.assign(objects[index],object));
        }catch{return false;}
      }
      compositionMode=independentMode;changed=true;
    }
    for(const object of pendingPlacement){if(!objects.includes(object))pendingPlacement.delete(object);else if(placeIndependentObject(object)){pendingPlacement.delete(object);changed=true;}}
    if(changed){lastLayout=null;showList();showForm(true);}return true;
  }
  function placeNewObject(object){
    if(independent()){if(!placeIndependentObject(object))pendingPlacement.add(object);return;}
    const width=Number($('signWidth').value),height=Number($('signHeight').value);
    if(!Number.isFinite(width)||width<=0||!Number.isFinite(height)||height<=0)return;
    const bounds=objectBounds;
    let own;try{own=bounds(G.independentObjectLayout(object));}catch{return;}
    const w=own.right-own.left,h=own.bottom-own.top,maxX=width-w,maxY=height-h;
    if(maxX<0||maxY<0)return;
    const occupied=[];for(const current of objects){try{occupied.push(bounds(G.independentObjectLayout(current)));}catch{}}
    const clamp=(value,max)=>Math.max(0,Math.min(max,value)),centerX=maxX/2,centerY=maxY/2,gap=Math.min(3,Math.max(.2,Math.min(w,h)*.1));
    // Look beside existing physical bounds, including rotated objects. A new
    // block never changes the size or position of the rest of the composition.
    const xs=new Set([centerX,0,maxX]),ys=new Set([centerY,0,maxY]);
    for(const box of occupied){xs.add(clamp(box.left-w-gap,maxX));xs.add(clamp(box.right+gap,maxX));ys.add(clamp(box.top-h-gap,maxY));ys.add(clamp(box.bottom+gap,maxY));}
    let position=null,distance=Infinity;
    for(const x of xs)for(const y of ys){
      if(occupied.some(box=>x<box.right+gap&&x+w+gap>box.left&&y<box.bottom+gap&&y+h+gap>box.top))continue;
      const nextDistance=(x-centerX)**2+(y-centerY)**2;
      if(nextDistance<distance){position={x,y};distance=nextDistance;}
    }
    // A crowded scene still gets a selectable new block inside its envelope.
    // Stagger near the center rather than placing every new object at (0,0).
    if(!position){
      const step=Math.min(3,Math.max(.1,Math.min(w,h)*.15));
      for(let at=0;at<25;at++){
        const index=(objects.length+at)%25,x=clamp(centerX+(index%5-2)*step,maxX),y=clamp(centerY+(Math.floor(index/5)-2)*step,maxY);
        position={x,y};if(!occupied.some(box=>Math.abs(box.left-x)<1e-7&&Math.abs(box.top-y)<1e-7))break;
      }
    }
    object.x_cm+=position.x-own.left;object.y_cm+=position.y-own.top;
  }
  function newText(sign){
    const object={id:newId('text'),type:'text',text:sign?.text??'Новый текст',font_family:sign?.font_family?.trim()||$('font')?.value.trim()||'Arial',font_bold:sign?.font_bold??($('corelBold')?.checked!==false),
      height_basis:'body',height_reference:'auto',
      letter_height_cm:independent()?15:Math.min(15,Math.max(.1,Number($('signHeight').value)*.35||15)),line_gap_cm:sign?.line_gap_cm??5,text_align:sign?.text_align||'center',front_color:sign?.front_color||$('frontColor')?.value||'#fff3dc',
      x_cm:0,y_cm:0,rotation_deg:0,...productionDefaults(sign),...(sign?.face_material?{face_material:copy(sign.face_material)}:{})};
    object.preview_line_metrics=objectMetrics(object);
    if(!independent())try{const natural=G.independentObjectLayout(object),width=Number($('signWidth').value),height=Number($('signHeight').value),scale=Math.min(1,width*.8/natural.width_cm,height*.8/natural.height_cm);if(scale>0&&Number.isFinite(scale))object.letter_height_cm*=scale;}catch{}
    placeNewObject(object);
    return object;
  }
  function logoHeader(artwork){return P.logoArtworkInfo(artwork);}
  async function decodeLogo(artwork){
    const info=logoHeader(artwork);
    const image=await new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('Не удалось открыть PNG логотипа.'));img.src=artwork.data_url;});
    if(image.naturalWidth!==info.width_px||image.naturalHeight!==info.height_px)throw new Error('Размеры логотипа не соответствуют PNG.');
    // Check original pixels in tiles: a large source must not require a second
    // full-resolution canvas/readback or hit the browser's canvas edge limit.
    const canvas=document.createElement('canvas');canvas.width=Math.min(1024,info.width_px);canvas.height=Math.min(1024,info.height_px);
    const context=canvas.getContext('2d',{willReadFrequently:true});let transparent=false,visible=false;
    for(let y=0;y<info.height_px&&!(transparent&&visible);y+=canvas.height){
      for(let x=0;x<info.width_px&&!(transparent&&visible);x+=canvas.width){
        const width=Math.min(canvas.width,info.width_px-x),height=Math.min(canvas.height,info.height_px-y);
        context.clearRect(0,0,canvas.width,canvas.height);context.drawImage(image,x,y,width,height,0,0,width,height);
        const pixels=context.getImageData(0,0,width,height).data;
        for(let at=3;at<pixels.length;at+=4){transparent||=pixels[at]<255;visible||=pixels[at]>0;if(transparent&&visible)break;}
      }
    }
    if(!transparent||!visible)throw new Error('Нужен PNG с видимым логотипом и прозрачным фоном.');return info;
  }
  function verifyRestoredLogos(epoch){
    for(const object of objects)if(object?.type==='logo'){
      const check={pending:true,error:null};logoChecks.set(object.id,check);
      decodeLogo(object.artwork).then(()=>{if(epoch!==sceneEpoch||!objects.includes(object)||logoChecks.get(object.id)!==check)return;check.pending=false;status();render();},error=>{if(epoch!==sceneEpoch||!objects.includes(object)||logoChecks.get(object.id)!==check)return;check.pending=false;check.error=error.message;status();render();});
    }
  }
  function legacyObjects(sign){
    const text=typeof sign?.text==='string'?sign.text:$('text').value;
    const family=sign?.font_family||$('font')?.value.trim()||'Arial',bold=sign?.font_bold!==false;
    const source={...sign,text,font_family:family,font_bold:bold,line_gap_cm:sign?.line_gap_cm??Number($('lineGap').value),text_align:sign?.text_align||$('textAlign').value};
    const lines=G.textLines(text),styles=Array.isArray(sign?.line_styles)?sign.line_styles:null;
    source.preview_line_metrics={font_size_px:100,font_family:family,font_weight:bold?700:400,lines:lines.map((line,index)=>measureRow(line,styles?.[index]?.font_family||family,styles?.[index]?.font_bold??bold))};
    let layout=null;
    try{if(lines.length||sign?.logo)layout=G.textLayout(source,{width_cm:Number($('signWidth').value),height_cm:Number($('signHeight').value)});}catch(error){restoreIssue=`Не удалось перенести прежнюю композицию: ${error.message}`;}
    const result=[],base=productionDefaults(sign);
    if(styles){
      lines.forEach((line,index)=>{
        if(!line.trim())return;const style=styles[index]||{},row=layout?.lines?.[index];
        result.push({id:newId('text'),type:'text',text:line,font_family:style.font_family||family,font_bold:style.font_bold??bold,
          letter_height_cm:row?.height_cm??style.height_cm??15,line_gap_cm:0,text_align:'left',front_color:sign?.front_color||$('frontColor').value,
          x_cm:row?.bounds_cm?.[0]?.[0]??0,y_cm:row?.y_cm??0,rotation_deg:0,...base});
      });
    }else if(lines.some(line=>line.trim())){
      const bounds=layout?.lines?.flatMap(line=>line.bounds_cm)||[[0,0]],left=Math.min(...bounds.map(point=>point[0])),top=Math.min(...bounds.map(point=>point[1]));
      result.push({id:newId('text'),type:'text',text:lines.join('\n'),font_family:family,font_bold:bold,
        letter_height_cm:layout?Math.max(...layout.lines.map(line=>line.height_cm)):15,line_gap_cm:source.line_gap_cm,text_align:source.text_align,
        front_color:sign?.front_color||$('frontColor').value,x_cm:left,y_cm:top,rotation_deg:0,...base});
    }
    if(sign?.logo)result.push({id:newId('logo'),type:'logo',...copy(sign.logo),rotation_deg:0,...base});
    return result;
  }
  function restore(sign){
    uploadEpoch++;artworkEpoch++;const epoch=++sceneEpoch;uploadRequest=null;uploadMessage='';uploadError=false;restoreIssue='';invalidObjects=null;logoChecks.clear();metricsCache.clear();$('letterLogoUpload').value='';lastLayout=null;
    compositionMode=sign?.composition_mode||'independent_objects_v1';pendingPlacement.clear();
    if(Object.hasOwn(sign||{},'objects')){
      if(Array.isArray(sign.objects))objects=copy(sign.objects);else{objects=[];invalidObjects=copy(sign.objects)??'invalid';}
    }else objects=isLetters()?legacyObjects(sign||{}):[];
    selection=objects.find(object=>object&&typeof object.id==='string')?.id??null;formObject=null;
    refreshMetrics();verifyRestoredLogos(epoch);sync();
  }
  function restoreNew(sign){
    restore({...sign,objects:[],composition_mode:independentMode});
    if(isLetters()&&typeof sign?.text==='string'&&sign.text.trim()){
      const object=newText(sign);objects.push(object);selection=object.id;lastLayout=null;
      refreshMetrics();sync();
    }
  }
  function chooseLogo(targetId=null){
    if(!isLetters())return;if(targetId===null&&objects.length>=maxObjects)return;
    uploadRequest={epoch:++uploadEpoch,targetId};$('letterLogoUpload').value='';$('letterLogoUpload').click();
  }
  $('letterAddText').addEventListener('click',()=>{if(objects.length>=maxObjects||!isLetters())return;uploadMessage='';uploadError=false;const object=newText();objects.push(object);selection=object.id;lastLayout=null;sync();render();$('letterObjectText').focus();$('letterObjectText').select();});
  $('letterUseBodyHeight').addEventListener('click',()=>{
    if(!isLetters())return;
    let changed=false;
    for(const object of objects)if(object?.type==='text'&&object.height_basis===undefined){object.height_basis='body';object.height_reference='auto';changed=true;}
    if(!changed)return;
    lastLayout=null;uploadMessage='Высота старых надписей пересчитана по телу букв. Введённые значения в сантиметрах сохранены.';uploadError=false;
    refreshMetrics();showList();showForm(true);status();render();
  });
  $('letterAddLogo').addEventListener('click',()=>chooseLogo());
  $('letterObjectReplace').addEventListener('click',()=>{const object=selected();if(object?.type==='logo')chooseLogo(object.id);});
  $('letterObjectRemove').addEventListener('click',()=>{
    const object=selected();if(!object)return;const index=objects.indexOf(object);uploadEpoch++;uploadRequest=null;logoChecks.delete(object.id);pendingPlacement.delete(object);objects.splice(index,1);
    selection=objects[Math.min(index,objects.length-1)]?.id??null;lastLayout=null;uploadMessage='';uploadError=false;restoreIssue='';sync();render();
  });
  $('letterLogoUpload').addEventListener('change',async event=>{
    const file=event.target.files?.[0],request=uploadRequest;if(!file||!request)return;
    const {epoch,targetId}=request;uploadMessage='Проверяем PNG…';uploadError=false;status();
    try{
      if(file.type!=='image/png'&&!/\.png$/i.test(file.name))throw new Error('Логотип должен быть PNG с прозрачным фоном.');
      const raw=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Не удалось прочитать логотип.'));reader.readAsDataURL(file);});
      const encoded=String(raw).slice(String(raw).indexOf(',')+1),url=`data:image/png;base64,${encoded}`;
      let header;try{header=atob(encoded.slice(0,44));}catch{throw new Error('Не удалось прочитать PNG логотипа.');}
      const dimension=at=>[0,1,2,3].reduce((value,offset)=>value*256+header.charCodeAt(at+offset),0);
      const artwork={name:file.name,mime_type:'image/png',source:'uploaded',data_url:url,width_px:dimension(16),height_px:dimension(20)};
      logoHeader(artwork);await decodeLogo(artwork);if(epoch!==uploadEpoch||!isLetters())return;
      uploadMessage='';uploadError=false;
      if(targetId!==null){
        const object=objects.find(item=>item?.id===targetId&&item.type==='logo');if(!object)return;object.artwork=artwork;logoChecks.delete(targetId);
      }else{
        if(objects.length>=maxObjects)throw new Error('В композиции уже 20 объектов.');
        const width=Number($('signWidth').value),height=Number($('signHeight').value),preferred=Math.min(30,Number.isFinite(width)&&width>0?width/4:30),fitHeight=Number.isFinite(height)&&height>0?height*artwork.width_px/artwork.height_px:preferred;
        const object={id:newId('logo'),type:'logo',artwork,width_cm:independent()?30:Math.max(.001,Math.min(preferred,fitHeight)),x_cm:0,y_cm:0,rotation_deg:0,...productionDefaults()};placeNewObject(object);objects.push(object);selection=object.id;
      }
      lastLayout=null;sync();render();
    }catch(error){if(epoch===uploadEpoch){uploadMessage=error.message;uploadError=true;status();}}
    finally{if(epoch===uploadEpoch){event.target.value='';uploadRequest=null;}}
  });
  const fields={letterObjectText:['text','text'],letterObjectHeight:['letter_height_cm','number'],letterObjectHeightBasis:['height_basis','text'],letterObjectHeightReference:['height_reference','text'],letterObjectFont:['font_family','text'],letterObjectBold:['font_bold','boolean'],letterObjectColor:['front_color','text'],letterObjectGap:['line_gap_cm','number'],letterObjectAlign:['text_align','text'],letterObjectWidth:['width_cm','number'],letterObjectX:['x_cm','number'],letterObjectY:['y_cm','number'],letterObjectRotation:['rotation_deg','number'],letterObjectDepth:['depth_cm','number'],letterObjectSideColor:['side_color','text'],letterObjectBrief:['brief','text']};
  $('letterFontPicker').addEventListener('input',event=>{
    const object=selected();if(object?.type!=='text')return;
    customFontOpen=event.target.value==='__custom__';
    if(customFontOpen){showForm(true);$('letterObjectFont').focus();return;}
    object.font_family=event.target.value;lastLayout=null;uploadMessage='';uploadError=false;
    refreshMetrics();showForm(true);showList();status();render();
  });
  for(const [id,[key,type]]of Object.entries(fields)){
    const changed=event=>{
    const object=selected();if(!object)return;
    const value=type==='number'?numeric(event.target):type==='boolean'?event.target.checked:event.target.value;
    if(object[key]===value)return;object[key]=value;
    if(key==='x_cm'||key==='y_cm')pendingPlacement.delete(object);
    if(key==='font_family')object[key]=object[key].trim();lastLayout=null;uploadMessage='';uploadError=false;refreshMetrics();showList();updateSize();status();render();
    };
    // Commit a checkbox's input before the editor's bubbled input render can
    // restore its previous state. Keep change for imported/older integrations.
    $(id).addEventListener('input',changed);
    if(type==='boolean')$(id).addEventListener('change',changed);
  }
  document.addEventListener('signage:change',sync);
  document.fonts?.addEventListener?.('loadingdone',event=>{
    metricsCache.clear();
    const families=event?.fontfaces?.map(face=>face.family.replace(/^['"]|['"]$/g,''));
    for(const object of objects)if(object?.type==='text'&&(!families||families.includes(object.font_family))){delete object.artwork;delete object.artwork_signature;}
    refreshMetrics();if(isLetters()){lastLayout=null;status();render();}
  });
  window.SignageLetterUI={settings,restore,restoreNew,sync,prepareArtwork,updateLayout,summaryText,legacyText:summaryText,selectedId:()=>selection,select,setObjectPosition,independent,makeIndependent,
    hasOverrides:()=>isLetters(),validationError,draftState:()=>({selectedId:selection,pendingPlacementIds:[...pendingPlacement].filter(object=>objects.includes(object)).map(object=>object.id)}),restoreDraftState:state=>{
      if(!state)return;
      if(Array.isArray(state.pendingPlacementIds)&&independent())for(const object of objects)if(state.pendingPlacementIds.includes(object?.id))pendingPlacement.add(object);
      if(objects.some(object=>object?.id===state.selectedId))selection=state.selectedId;
      if(independent())makeIndependent();showList();showForm(true);
    }};
  restore({text:$('text').value,font_family:$('font')?.value||'Arial',font_bold:$('corelBold')?.checked!==false});
})();
