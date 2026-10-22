/* Explicit photorealistic AI jobs through Codex authenticated on the editor server. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id), editor = window.SignageEditor;
  const appBase = new URL('.', location.href), pendingStorageKey = `signage-pending-job:${appBase.pathname}`;
  const initialSearch=new URLSearchParams(location.search),initialRestoreId=initialSearch.get('restoreJob'),explicitHistory=initialSearch.has('restoreJob');
  const labels = {original:'Исходное освещение',sunny:'Солнечный день',cloudy:'Облачно',night:'Ночь'};
  const hints = {original:'Материалы и тени согласуются с исходным светом.',sunny:'Тёплый дневной свет, блики и локальные тени букв. Фон получает цветовую коррекцию без перемещения объектов.',cloudy:'Мягкий рассеянный свет и спокойные отражения. Геометрия исходного фото сохраняется.',night:'Подсветка букв обязательно включена. Тип и цвет — из ТЗ, по умолчанию тёплый контражур 3000 K. Фон затемняется без перерисовки.'};
  const retouchFields={foreign_signs:'retouchForeignSigns',litter:'retouchLitter',people:'retouchPeople',visual_clutter:'retouchVisualClutter'};
  const originalFooter=$('footerNote')?.textContent||'';
  let retouchConfigured=false,twoStageConfigured=false;
  function normalizeRetouch(value){return {mode:value?.mode==='ideal_environment'?'ideal_environment':'off',removals:Object.keys(retouchFields).filter(key=>!Array.isArray(value?.removals)||value.removals.includes(key))};}
  function retouchSettings(){return normalizeRetouch({mode:$('sceneRetouch')?.value,removals:Object.entries(retouchFields).filter(([,id])=>$(id)?.checked).map(([key])=>key)});}
  function restoreRetouch(value){const saved=normalizeRetouch(value);if($('sceneRetouch'))$('sceneRetouch').value=saved.mode;Object.entries(retouchFields).forEach(([key,id])=>{if($(id))$(id).checked=saved.removals.includes(key);});}
  function retouchProblem(){const value=retouchSettings();return value.mode==='off'?'':!value.removals.length?'Выберите хотя бы одну категорию для ретуши.':!retouchConfigured?'Ретушь фото пока не подключена. Выбранные настройки сохраняются в проекте.':'';}
  restoreRetouch(null);
  let region=null, token='', configured=false, online=false, checking=false, connectionMessage='', busy=false, pendingId='', result=null, submittedRevision=-1,currentView='render',authExpired=false;
  let resultEpoch=0,restoreSequence=0,pendingResumed=false,pendingWorkspaceId='';
  const urls={};
  const productType=project=>window.SignageProducts?window.SignageProducts.activeProduct(project).type:'channel_letters';
  const productFamily=project=>window.SignageProducts?.renderer?window.SignageProducts.renderer(project):productType(project);
  const signParams=project=>window.SignageProducts?window.SignageProducts.activeProduct(project).params:project.sign;
  const hasLetterObjects=project=>productFamily(project)==='channel_letters'&&Array.isArray(signParams(project)?.objects);
  const confirmedConstruction=()=>({version:1,face:{material:'acrylic',thickness_mm:null},returns:{material:'aluminium',thickness_mm:null,finish:null},provenance:{face_material:'owner_confirmed',returns_material:'owner_confirmed'}});
  function generationEngine(){
    const engine=window.SignageProductUI?.generationEngine()||'codex',active=window.SignageProductUI?.active();
    // Do not call editor.snapshot() here: its project builder calls settings().
    const objects=Boolean(window.SignageLetterUI)||Array.isArray(active?.params?.objects);
    return twoStageConfigured&&engine==='codex'&&objects&&active&&productFamily(active)==='channel_letters'?'codex_two_stage':engine;
  }
  const needsCodex=()=>retouchSettings().mode==='ideal_environment'||window.SignageProductUI?.generationEngine()!=='composite';
  const settings=()=>({engine:generationEngine(),lighting:$('lighting').value,scene_retouch:retouchSettings(),edit_polygon_px:region||(editor.facadeEnabled?.()?null:editor.target()),...(editor.facadeEnabled?.()?{edit_region_source:region?'explicit':'placement_zone'}:{}),geometry_lock:true,background_cleanup:'inside_edit_zone_only',night_illumination_required:window.SignageProductUI?productFamily(window.SignageProductUI.active())==='channel_letters'||['neon','lightbox'].includes(productFamily(window.SignageProductUI.active()))&&window.SignageProductUI.active().params.illumination==='on':true});
  window.SignageGeneration={settings,setRegion:points=>{region=points;},restore:value=>{region=value?.edit_region_source==='placement_zone'?null:value?.edit_polygon_px||null;$('lighting').value=Object.hasOwn(labels,value?.lighting)?value.lighting:'original';restoreRetouch(value?.scene_retouch);},draftState,restoreDraft};
  function effectiveEditZone(report){return region||(editor.facadeEnabled?.()?report?.calibration?.target_boundary_px||editor.target():editor.target());}
  function insideEditZone(p,polygon){
    if(!polygon?.length)return false;if(polygon.length===4)return window.LetterGeometry.inside(p,polygon);let inside=false;
    for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
      const a=polygon[j],b=polygon[i],dx=b[0]-a[0],dy=b[1]-a[1],length=dx*dx+dy*dy,t=length?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length)):0;
      if(Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy)<1e-6)return true;
      if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
    }return inside;
  }
  function placementInsideEditZone(project,report,zone){
    const independent=project.sign?.composition_mode==='independent_signs_v1';
    if(!region&&project.facade?.enabled&&report.calibration.target_world_cm){const polygons=independent?report.sign_layout.objects.map(object=>object.bounds_cm):[report.placement.corners_cm];return polygons.every(points=>points.every(p=>window.LetterGeometry.inside(p,report.calibration.target_world_cm)));}
    const polygons=independent?report.sign_layout.objects.map(object=>object.boundary_px||object.polygon_px):[report.placement.boundary_px||report.placement.polygon_px];
    return polygons.every(points=>points.every(p=>insideEditZone(p,zone)));
  }
  function resultChanged(){const link=$('commercialProposalLink');if(link)link.href='proposals.html'+(result?.job?.id?'?job='+encodeURIComponent(result.job.id):'');document.dispatchEvent(new Event('signage:resultchange'));}
  function storedPending(){try{return sessionStorage.getItem(pendingStorageKey)||'';}catch{return '';}}
  async function checkPendingWorkspace(){
    const identity=pendingId||storedPending(),workspace=window.SignageWorkspace?.context();
    if(!identity||!workspace)return identity;
    try{const job=await api(`/api/jobs/${identity}`);if(job.project_id!==workspace.id){clearPending();return '';}pendingWorkspaceId=job.project_id;return identity;}
    catch(error){if(error.status===404){clearPending();return '';}return identity;}
  }
  function draftState(){
    const workspace=window.SignageWorkspace?.context(),ownResult=!workspace||!result||result.job.project_id===workspace.id;
    const ownPending=!workspace||pendingWorkspaceId===workspace.id;
    return {version:1,jobId:ownResult?result?.job.id||null:null,view:currentView,editRegion:region?region.map(point=>[...point]):null,
      photoMatchesResult:Boolean(ownResult&&result&&editor.snapshot().photoRevision===result.photoRevision),
      pendingJobId:ownPending?pendingId||null:null,pendingPhotoMatches:Boolean(ownPending&&pendingId&&editor.snapshot().photoRevision===submittedRevision)};
  }
  function restoreEditRegion(state){
    if(!Object.hasOwn(state,'editRegion'))return;
    const saved=state.editRegion,image=editor.snapshot().project.image;
    if(saved!==null){
      if(!Array.isArray(saved)||saved.length!==4||saved.some(point=>!Array.isArray(point)||point.length!==2||point.some(value=>!Number.isFinite(value))))return;
      if(image&&saved.some(([x,y])=>x<0||y<0||x>image.width_px||y>image.height_px))return;
      try{window.LetterGeometry.quad(saved);}catch{return;}
    }
    region=saved===null?null:saved.map(point=>[...point]);
    editor.render();
  }
  function message(text,error=false){$('generationStatus').textContent=text;$('generationStatus').classList.toggle('error',error);}
  function projectComparison(project){
    let value={...project,sign:{...project.sign,font_bold:project.sign?.font_bold??true},ruler:project.ruler??{image_points:[],same_plane:true}};
    if(window.SignageProducts){
      value=window.SignageProducts.normalizeProject(project);const product=value.products[0],params={...product.params};
      // Derived browser measurements and UI cache markers do not change saved
      // rendering specifications. The actual source PNG remains in comparison.
      ['preview_line_metrics','preview_font_status','size_basis'].forEach(key=>delete params[key]);
      value.products=[{...product,params}];delete value.products[0].artwork_signature;delete value.products[0].background_ai;
      delete value.sign;delete value.placement;delete value.product_drafts;
      value.ruler=value.ruler??{image_points:[],same_plane:true};value.measurements=value.measurements??[];value.checks=value.checks??[];value.assumptions=value.assumptions??[];value.spec_source=value.spec_source??null;
      if(value.calibration)value.calibration={plane:'Плоскость установки',...value.calibration};
      const renderer=productFamily(product),night=renderer==='channel_letters'||['neon','lightbox'].includes(renderer)&&params.illumination==='on';
      value.generation={lighting:'original',edit_polygon_px:value.target_polygon_px??null,geometry_lock:true,background_cleanup:'inside_edit_zone_only',night_illumination_required:night,...value.generation,engine:value.generation?.engine||(productFamily(product)==='channel_letters'?'codex':'composite')};
    }
    const retouch=normalizeRetouch(value.generation?.scene_retouch);
    value.generation={...value.generation,scene_retouch:{...retouch,removals:retouch.mode==='off'?[]:retouch.removals}};
    if(value.facade){value.facade={...value.facade};['grid_visible','grid_step_cm','snap_elements','snap_grid'].forEach(key=>delete value.facade[key]);}
    // Server capability changes the execution route, not the saved dimensions,
    // artwork or materials. Opening an older Codex result remains read-only.
    if(hasLetterObjects(value)){
      if(['codex','codex_two_stage'].includes(value.generation.engine))value.generation.engine='codex';
      // This exact owner-confirmed profile is added to new server snapshots.
      // Normalize only its missing counterpart for comparison, never inputs.
      const params=window.SignageProducts?value.products[0].params:value.sign;
      if(params.construction===undefined)params.construction=confirmedConstruction();
    }
    return JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
  }
  function current(){return projectComparison(editor.snapshot().project);}
  function lightingHint(project){
    const mode=$('lighting').value,material=project.sign?.face_material;
    const type=productFamily(project);
    if(type!=='channel_letters')return ['neon','lightbox'].includes(type)?`Подсветка ${project.sign?.illumination==='off'?'выключена':'включена'}. Графика берётся из точного PNG; свечение показано условно.`:'Изделие без собственной подсветки. Освещение меняет яркость фото; точный PNG сохраняет текст и форму.';
    if(twoStageConfigured&&hasLetterObjects(project)&&generationEngine()==='codex_two_stage'){
      const params=signParams(project),materials=[params.face_material,...params.objects.flatMap(object=>[object.face_material,object.materials])];
      const temperatures=[...new Set(materials.map(value=>value?.led_temperature_k).filter(Number.isFinite))];
      const led=temperatures.length?`Температура LED по ТЗ: ${temperatures.join(', ')} K.`:'Температура LED не задана; значение на ИИ-фото не является измерением.';
      if(mode==='night')return `Ночью подсветка проходит через акриловое лицо; контражур используется только по явному ТЗ. Борта не светятся. ${led}`;
      return `Свет, блики и тени согласуются с фотографией и выбранным освещением. Днём внутренняя подсветка выключена, если в ТЗ не указано включение. ${led}`;
    }
    if(material?.type!=='film_on_acrylic')return hints[mode];
    const led=material.led_temperature_k==null?'Температура LED не задана: свет условный нейтральный.':`Температура LED по ТЗ: ${material.led_temperature_k} K.`;
    if(mode==='night')return `Ночью лицевая часть светится изнутри через акрил и плёнку ORACAL. ${led} Борта не светятся. Фон затемняется без перерисовки.`;
    return `${hints[mode]} ${material.day_lighting==='on'?`Лицевая подсветка включена: свет проходит через акрил и плёнку. ${led}`:'Лицевая подсветка выключена; показан цвет плёнки при внешнем освещении.'}`;
  }
  function savedMaterialSummary(project,mode,engine,geometry){
    if(engine==='codex_two_stage'){
      const objects=signParams(project)?.objects||[];
      const cm=value=>Number.isFinite(value)?`${new Intl.NumberFormat('ru-RU',{maximumFractionDigits:3}).format(value)} см`:'не задана';
      const details=objects.map((object,index)=>{
        if(object.type==='logo')return `Логотип ${index+1}: ширина по ТЗ ${cm(object.width_cm)}; глубина по ТЗ ${cm(object.depth_cm)}`;
        const font=object.font_family||'не указан',raster=object.artwork?.font_family_rendered;
        const layout=geometry?.sign_layout?.objects?.find(item=>item.id===object.id&&item.type==='text');
        const heightLabel=object.height_basis==='body'?'основная высота по ТЗ':'максимальная высота строки по ТЗ';
        const fullBounds=Number.isFinite(layout?.width_cm)&&layout.width_cm>0&&Number.isFinite(layout?.height_cm)&&layout.height_cm>0?`; полный габарит ${cm(layout.width_cm)} × ${cm(layout.height_cm)}`:'';
        return `Текст ${index+1}: «${object.text||''}»; ${heightLabel} ${cm(object.letter_height_cm)}${fullBounds}; шрифт по ТЗ «${font}»${object.font_bold?' Bold':''}${raster?`; шрифт исходной графики «${raster}»${object.artwork.font_fallback?' (браузерная замена)':''}`:''}; глубина по ТЗ ${cm(object.depth_cm)}`;
      });
      return [`Сохранённое ТЗ · объектов: ${objects.length}`,...details].join('. ')+'. Внешний вид изделия и установки создан ИИ; написание, пропорции и положение сверяйте с разметкой. Полные исходные размеры и параметры находятся в «Исходных данных JSON». Для изготовления нужны утверждённые векторные контуры; ИИ-фото не задаёт производственную геометрию.';
    }
    return window.SignagePreview.materialSummary(project,mode);
  }
  function showSavedSpecification(project,mode,engine,geometry){
    window.SignagePreview.colorSwatches($('resultColors'),project.sign,productType(project));
    $('resultMaterial').textContent=savedMaterialSummary(project,mode,engine,geometry);
  }
  function update(){
    const {project,report,hasPhoto}=editor.snapshot(), zone=effectiveEditZone(report);
    const independent=project.sign?.composition_mode==='independent_signs_v1';
    const type=productFamily(project),codex=needsCodex(),retouch=retouchSettings(),ideal=retouch.mode==='ideal_environment',twoStage=twoStageConfigured&&hasLetterObjects(project)&&generationEngine()==='codex_two_stage';
    if($('sceneRetouchOptions'))$('sceneRetouchOptions').hidden=!ideal;
    if($('sceneRetouchAvailability'))$('sceneRetouchAvailability').hidden=!ideal||retouchConfigured;
    if($('sceneRetouchHint'))$('sceneRetouchHint').textContent=ideal?(retouch.removals.length?'Очистка всего кадра с сохранением фасада, ракурса и положения композиции. Исходное фото остаётся для сравнения.':'Выберите хотя бы одну категорию для ретуши.'):'Без дополнительной очистки окружения. Старую вывеску можно заменить в отмеченной зоне.';
    if($('geometryLockTitle'))$('geometryLockTitle').textContent=ideal?'Фасад и размещение сохраняются':'Геометрия и перспектива зафиксированы';
    if($('geometryLockHint'))$('geometryLockHint').textContent=ideal?'Размеры изделия и точки калибровки сохраняются. ИИ получает требование сохранить фасад, окна и двери; восстановленные участки сверяйте с исходником.':'Ракурс, пропорции и границы кадра сохраняются. Этот запрет нельзя отключить.';
    if($('footerNote'))$('footerNote').textContent=ideal?'В режиме «Идеальная среда» выбранные детали окружения могут изменяться по всему кадру. Исходное фото сохраняется для сравнения. Розовая зона задаёт область монтажа изделия. Восстановленный фон сверяйте с исходником, размеры и написание — с технической схемой.':window.SignageProductUI?.generationFooter?.()||originalFooter;
    if(twoStage){
      if($('geometryLockTitle'))$('geometryLockTitle').textContent='Разметка и размеры сохранены';
      if($('geometryLockHint'))$('geometryLockHint').textContent='ИИ получает сохранённые параметры и разметку. ИИ-фото сверяйте по разметке: написание, пропорции и положение могут отличаться.';
      if($('footerNote'))$('footerNote').textContent='Рабочий оверлей задаёт размещение. Готовый макет учитывает свет фотографии; написание и пропорции проверяйте на вкладке «Разметка». Исходные размеры и параметры сохраняются отдельно в JSON. Для изготовления нужны утверждённые векторные контуры; ИИ-изображение не является источником геометрии для фрезерования.'+(ideal?' Ретушь окружения может менять выбранные детали по всему кадру; восстановленный фон сверяйте с исходником.':'');
    }
    if($('twoStageNote'))$('twoStageNote').hidden=!twoStage;
    if($('subscriptionUsageHint'))$('subscriptionUsageHint').textContent=twoStage?'Два этапа выполняются автоматически. Готовая вывеска используется повторно, если её параметры не менялись. '+(ideal?'Ретушь окружения добавляет отдельную генерацию. ':'')+'Используются лимиты подключённой подписки ChatGPT; выполнение может занять несколько минут.':'Один клик — один запрос через Codex на сервере. Генерация использует лимиты подключённой подписки ChatGPT, отдельный API-счёт не используется. Запрос может выполняться несколько минут.';
    if(type!=='channel_letters'&&$('productGenerationNote'))$('productGenerationNote').textContent=ideal?'Точный макет размещается на подготовленном фото с сохранением текста и пропорций. Ретушь окружения выполняется перед размещением изделия.':'Точный макет размещается на фото с сохранением текста и пропорций. Исходный фон сохраняется; для удаления старой вывески включите подготовку фона с ИИ.';
    $('subscriptionSettings').hidden=!codex;
    if($('backgroundAiHint'))$('backgroundAiHint').hidden=type==='channel_letters'||!codex;
    $('lightingHint').textContent=ideal?lightingHint(project).replaceAll('Фон затемняется без перерисовки.','Ретушь сохраняет выбранное освещение.').replaceAll('Фон получает цветовую коррекцию без перемещения объектов.','Ретушь сохраняет выбранное освещение.') : lightingHint(project);
    $('connectionBadge').textContent=checking?'Проверка подключения…':online?(configured?'Codex подключён':'Codex пока не подключён'):'Сервер редактора недоступен';
    $('connectionMessage').textContent=checking?'Проверяю Codex на сервере.':online?(connectionMessage+(configured?'':' Выполните вход в ChatGPT через Codex на сервере и повторите проверку.')):'Проверьте подключение к интернету и доступность сервера редактора, затем повторите проверку.';
    $('checkConnection').disabled=busy||checking;
    if(authExpired){$('connectionBadge').textContent='Требуется вход';$('connectionMessage').textContent='Войдите по ссылке сверху в отдельной вкладке, затем проверьте подключение. Фото и параметры остаются здесь.';}
    let problem='';
    if(authExpired)problem='Войдите в редактор в отдельной вкладке и нажмите «Проверить подключение».';
    else if(!online)problem='Нет подключения к серверу редактора. Нажмите «Проверить подключение», когда связь восстановится.';
    else if(retouchProblem())problem=retouchProblem();
    else if(codex&&!configured)problem='Выполните вход в Codex на сервере и нажмите «Проверить подключение».';
    else if(!hasPhoto)problem='Загрузите исходное фото.';
    else if(independent&&!project.target_polygon_px)problem='Отметьте область установки для независимых вывесок.';
    else if(!report?.placement)problem=independent?'Задайте масштаб и добавьте вывески внутри области установки.':'Задайте калибровку, размер и центр вывески.';
    else if(type==='channel_letters'&&Array.isArray(project.sign.objects)&&!project.sign.objects.length)problem='Добавьте текст или логотип.';
    else if(type==='channel_letters'&&!Array.isArray(project.sign.objects)&&!project.sign.text.trim())problem='Введите текст вывески.';
    else if(type!=='channel_letters'&&!project.sign.text.trim()&&!window.SignageProductUI?.active().artwork)problem='Введите текст или загрузите точный PNG.';
    else if(type!=='channel_letters'&&(window.SignageProducts?.capabilities(project).require_uploaded===true||window.SignageProducts?.family(project).artwork_mode==='upload_only'||$('artworkSource')?.value==='uploaded')&&window.SignageProductUI?.active().artwork?.source!=='uploaded')problem='Загрузите оригинальный PNG.';
    else if(report.placement.fits_target===false)problem='Вывеска выходит за область установки.';
    else if(!zone)problem='Отметьте зону замены или область установки.';
    else try{
      if(!project.facade?.enabled||region)window.LetterGeometry.quad(zone);
      const polygon=report.placement.polygon_px;
      if(!placementInsideEditZone(project,report,zone))problem=independent?'Зона замены должна включать каждую вывеску.':'Зона замены должна включать весь габарит изделия.';
      else if(type!=='channel_letters'){
        const product=window.SignageProducts.activeProduct(project),padding=window.SignageProducts.effectPadding(product,polygon);
        if(!(report.placement.boundary_px||polygon).every(([x,y])=>[[-padding,-padding],[-padding,padding],[padding,-padding],[padding,padding]].every(([dx,dy])=>insideEditZone([x+dx,y+dy],zone))))problem='Расширьте зону замены вокруг изделия, чтобы поместились его тень и свечение.';
      }
    }catch(e){problem=e.message;}
    $('generate').disabled=busy||checking||Boolean(problem);
    $('generate').textContent=busy?'Создаётся макет…':twoStage?'Визуализировать':type==='channel_letters'?'Создать ИИ-макет':codex?'Подготовить фон и создать макет':'Создать макет на фото';
    $('generationReady').textContent=busy?(twoStage?'Выполняются два этапа. Состояние текущего этапа показано ниже.':codex?'Запрос выполняется через Codex. Обычно это занимает несколько минут.':'Точный PNG размещается на исходном фото…'):checking?'Проверяю подключение…':problem||(twoStage?'Сохраню исходные параметры, подготовлю вывеску и установлю её на фото. Оба изображения останутся в истории.':codex?'Фото и ТЗ будут обработаны через подключённую подписку ChatGPT. Результат появится справа.':'Точный макет будет размещён на фото. Подписка ChatGPT не расходуется.');
    $('editRegionState').textContent=zone?`${region?'Отдельная зона замены':'Зона совпадает с областью установки'} · розовый пунктир. ${ideal?'Здесь размещается изделие. Ретушь окружения выполняется отдельно по всему кадру.':codex?'Изменение фона разрешено только внутри.':'Размещение изделия разрешено только внутри; исходный фон сохраняется.'}`:'Укажите область размещения изделия.';
    $('useTarget').disabled=!editor.target();
    if(result)$('resultStale').hidden=current()===result.project&&editor.snapshot().photoRevision===result.photoRevision;
  }
  async function api(path,body,blob=false){
    const response=await fetch(new URL(path.replace(/^\//,''),appBase),{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{'X-Editor-Token':token,...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    if(!response.ok){let value;try{value=await response.json();}catch{}if(response.status===401&&value?.auth_required){authExpired=true;$('authExpiredNotice').hidden=false;}const error=new Error(value?.error||`Ошибка сервера редактора (${response.status}).`);error.status=response.status;throw error;}
    return blob?response.blob():response.json();
  }
  async function checkConnection(){
    checking=true;update();
    try{const config=await api('/api/config');authExpired=false;$('authExpiredNotice').hidden=true;token=config.token;configured=config.provider==='codex'&&config.configured===true;retouchConfigured=config.scene_retouch_configured===true;twoStageConfigured=config.two_stage_letters_configured===true;connectionMessage=config.connection_message||(configured?'Codex на сервере подключён к ChatGPT.':'Подключение Codex на сервере не подтверждено.');online=true;}catch{online=false;configured=false;retouchConfigured=false;twoStageConfigured=false;connectionMessage='';}
    checking=false;
    update();
  }
  $('checkConnection').onclick=checkConnection;
  $('lighting').onchange=()=>editor.render();
  ['sceneRetouch',...Object.values(retouchFields)].forEach(id=>{if($(id))$(id).onchange=()=>editor.render();});
  $('editRegion').onclick=()=>{editor.setMode('editRegion');$('stage').scrollIntoView({behavior:'smooth',block:'center'});};
  $('useTarget').onclick=()=>{region=null;editor.render();};
  function savePending(){pendingWorkspaceId=window.SignageWorkspace?.context()?.id||'';try{sessionStorage.setItem(pendingStorageKey,pendingId);}catch{}resultChanged();}
  function clearPending(){pendingId='';pendingWorkspaceId='';pendingResumed=false;try{sessionStorage.removeItem(pendingStorageKey);}catch{}$('resumeGeneration').hidden=true;resultChanged();}
  async function showResult(job,{view='render',scroll=true,photoRevision=submittedRevision,shouldApply=()=>true}={}){
    const names={render:'render.png',base:'lighting-base.png',source:'source.png'};
    if(job.audit?.scene_retouch?.enabled)names.scene='scene-base.png';
    const optional={...(job.has_product_neutral===true?{neutral:'product-neutral.png'}:{}),...(job.has_layout_guide===true?{guide:'layout-guide.png'}:{})};
    const files=await Promise.all([...Object.entries(names),...Object.entries(optional)].map(async([key,name])=>{
      try{return [key,await api(`/api/jobs/${job.id}/${name}`,undefined,true)];}
      catch(error){if(Object.hasOwn(optional,key)&&error.status===404)return null;throw error;}
    }));
    if(!shouldApply())return false;
    const project=await api(`/api/jobs/${job.id}/project.json`);
    if(!shouldApply())return false;
    Object.entries(urls).forEach(([key,url])=>{URL.revokeObjectURL(url);delete urls[key];});
    const available=files.filter(Boolean);
    available.forEach(([key,blob])=>{urls[key]=URL.createObjectURL(blob);});
    result={job,project:projectComparison(project),blobs:Object.fromEntries(available),photoRevision};
    const sign=window.SignageProducts?window.SignageProducts.activeProduct(project).params:project.sign;
    $('resultTitle').textContent=`${sign.text||window.SignageProducts?.displayLabel(project)||'Изделие'} · ${labels[job.lighting]}`;
    showSavedSpecification(project,job.lighting,job.engine,job.audit?.geometry);
    if($('showScene'))$('showScene').hidden=!urls.scene||!names.scene;
    if($('showNeutral'))$('showNeutral').hidden=!urls.neutral;
    if($('showGuide'))$('showGuide').hidden=!urls.guide;
    if($('downloadProductionSpec'))$('downloadProductionSpec').hidden=job.has_production_spec!==true;
    if($('productionSpecificationNote'))$('productionSpecificationNote').hidden=job.has_production_spec!==true;
    if($('resultGeometryLabel'))$('resultGeometryLabel').textContent=job.engine==='codex_two_stage'?'Разметка и размеры сохранены':'Геометрия защищена';
    $('aiResult').hidden=false;selectView(result.blobs[view]?view:'render',false);
    const audit=job.audit;
    $('resultVerification').textContent=`${audit.canvas_size_px.join(' × ')} px · вне зоны замены: ${audit.changed_pixels_outside_edit_zone} изменённых пикселей относительно ${audit.scene_retouch?.enabled?'основы после ретуши':'световой основы'}. ${job.engine==='codex_two_stage'?'Вывеска и её установка созданы двумя генерациями. Разметка хранит заданные размеры и положение; написание, пропорции и размещение на ИИ-фото требуют сравнения с ней.':audit.exact_artwork?'Точная графика перенесена с сохранением текста и логотипов.':'Положение и написание букв проверьте по схеме.'}${audit.scene_retouch?.enabled?' Ретушь окружения выполнена по всему кадру; восстановленный фон сверяйте с исходным фото.':''}`;
    if(scroll)$('aiResult').scrollIntoView({behavior:'smooth',block:'start'});update();resultChanged();return true;
  }
  function selectView(view,announce=true){if(!result||!['render','base','source','scene','neutral','guide'].includes(view)||!result.blobs[view])return;resultEpoch++;currentView=view;$('generatedImage').src=urls[view];$('generatedImage').alt={render:'Макет изделия на фото',base:'Исходный кадр с выбранным освещением без нового изделия',source:'Исходное фото до редактирования',scene:'Фотография после ретуши окружения без нового изделия',neutral:'Вывеска при нейтральном освещении — результат первой генерации',guide:'Точная разметка размещения по исходным параметрам'}[view];[['showRender','render'],['showBase','base'],['showOriginal','source'],['showScene','scene'],['showNeutral','neutral'],['showGuide','guide']].forEach(([id,key])=>$(id)?.classList.toggle('active',key===view));if(announce)resultChanged();}
  async function restoreDraft(state,{shouldApply=()=>true}={}){
    if(explicitHistory||!state||typeof state!=='object'||!shouldApply())return false;
    const sequence=++restoreSequence,epoch=resultEpoch;
    const applies=()=>sequence===restoreSequence&&epoch===resultEpoch&&shouldApply();
    await window.SignageGeneration.ready;
    if(!applies())return false;
    restoreEditRegion(state);
    const activePending=await checkPendingWorkspace();
    if(activePending){
      if(state.pendingJobId===activePending&&state.pendingPhotoMatches===true)submittedRevision=editor.snapshot().photoRevision;
      return false;
    }
    if(typeof state.jobId!=='string'||!/^[a-zA-Z0-9_-]{16,80}$/.test(state.jobId))return false;
    if(!online){message('Черновик открыт. Сохранённый макет пока недоступен: проверьте подключение к серверу. Фото и параметры сохранены.',true);return false;}
    try{
      const job=await api(`/api/jobs/${state.jobId}`);
      if(!applies()||pendingId||storedPending())return false;
      if(job.status!=='complete'){message('Черновик открыт. У сохранённого задания пока нет готового изображения; текущие фото и параметры сохранены.',true);return false;}
      const applied=await showResult(job,{view:['render','base','source','scene','neutral','guide'].includes(state.view)?state.view:'render',scroll:false,
        photoRevision:state.photoMatchesResult===true?editor.snapshot().photoRevision:-1,
        shouldApply:()=>applies()&&!pendingId&&!storedPending()});
      if(applied)message('Сохранённый макет восстановлен. Генерация не запускалась.');
      return applied;
    }catch(error){
      if(applies())message(error.status===404?'Сохранённое изображение больше не доступно на сервере. Черновик с текущими фото и параметрами сохранён.':`Не удалось открыть сохранённый макет: ${error.message} Текущие фото и параметры сохранены.`,true);
      return false;
    }
  }
  $('openResultImage').onclick=()=>{if(result)window.SignagePreview.openImage({src:urls[currentView],title:$('generatedImage').alt,filename:`signage-${result.job.id}-${currentView}.png`});};
  $('showRender').onclick=()=>selectView('render');$('showBase').onclick=()=>selectView('base');$('showOriginal').onclick=()=>selectView('source');
  if($('showScene'))$('showScene').onclick=()=>selectView('scene');
  if($('showNeutral'))$('showNeutral').onclick=()=>selectView('neutral');
  if($('showGuide'))$('showGuide').onclick=()=>selectView('guide');
  $('downloadRender').onclick=()=>{if(result)editor.download(result.blobs.render,`signage-${result.job.lighting}.png`,'image/png');};
  $('downloadAudit').onclick=()=>{if(result)editor.download(JSON.stringify(result.job.audit,null,2),'geometry-audit.json','application/json');};
  if($('downloadProductionSpec'))$('downloadProductionSpec').onclick=async()=>{
    if(!result||result.job.has_production_spec!==true)return;
    const id=result.job.id,button=$('downloadProductionSpec');button.disabled=true;
    try{const source=await api(`/api/jobs/${id}/production-spec.json`,undefined,true);editor.download(source,`production-spec-${id}.json`,'application/json');}
    catch(error){message(`Не удалось получить исходные данные: ${error.message}`,true);}
    finally{button.disabled=false;}
  };
  async function poll(){
    if(!pendingId)return;
    busy=true;$('resumeGeneration').hidden=true;update();
    try{
      const job=await api(`/api/jobs/${pendingId}`);
      const workspace=window.SignageWorkspace?.context();if(workspace&&job.project_id!==workspace.id){clearPending();busy=false;update();return;}pendingWorkspaceId=job.project_id||'';
      message(job.message,job.status==='failed');
      if(['queued','running'].includes(job.status)){setTimeout(poll,2500);return;}
      if(job.status==='complete')await showResult(job,{scroll:!pendingResumed});
      clearPending();busy=false;update();
    }catch(e){if(e.status===404){busy=false;clearPending();message('Сервер не хранит этот запрос. Если он перезапускался, предыдущая генерация могла израсходовать часть лимита Codex. Новый запрос автоматически не отправлен.',true);}else{busy=true;message(`${e.message} Новый запрос не отправлен. Проверьте состояние текущего запроса.`,true);$('resumeGeneration').hidden=false;}update();}
  }
  $('resumeGeneration').onclick=async()=>{if(!online||authExpired||!token)await checkConnection();if(online)return poll();message('Сервер пока недоступен. Текущий запрос сохранён; повторите проверку после восстановления связи.',true);};
  $('generate').onclick=async()=>{
    if(busy)return;
    const retouchError=retouchProblem();if(retouchError){message(retouchError,true);update();return;}
    resultEpoch++;
    busy=true;update();message('Подготовка исходника и проверка геометрии…');
    let payload;
    try{await window.SignageProductUI?.prepareArtwork();editor.render();const error=retouchProblem();if(error)throw new Error(error);if(window.SignageWorkspace&&!await window.SignageWorkspace.flush())throw new Error('Сначала сохраните проект на сервере или разрешите конфликт версий.');const state=editor.snapshot();if(!state.report?.placement)throw new Error('Исправьте параметры проекта перед генерацией.');if(state.project.sign?.composition_mode==='independent_signs_v1'){if(!state.project.target_polygon_px)throw new Error('Отметьте область установки для независимых вывесок.');const zone=effectiveEditZone(state.report);if(!zone||!placementInsideEditZone(state.project,state.report,zone))throw new Error('Зона замены должна включать каждую вывеску.');}submittedRevision=state.photoRevision;pendingId=crypto.randomUUID();payload={request_id:pendingId,project:state.project,photo:editor.photoPng(),...(window.SignageWorkspace?{project_id:window.SignageWorkspace.context()?.id,source_job_id:window.SignageWorkspace.context()?.sourceJobId||undefined}:{})};}
    catch(e){busy=false;clearPending();message(e.message,true);update();return;}
    savePending();
    try{await api('/api/jobs',payload);window.SignageWorkspace?.recordJob(pendingId);resultChanged();poll();}
    catch(e){
      // If POST delivery was interrupted, query its ID before permitting another generation.
      if(e.status){busy=false;clearPending();message(e.message+' Автоматического повтора не было.',true);update();return;}
      message('Связь с сервером редактора прервалась. Проверяю уже отправленный запрос.',true);poll();
    }
  };
  document.addEventListener('signage:change',update);
  async function restoreFromHistory(id){
    if(!/^[a-zA-Z0-9_-]{16,80}$/.test(id))throw new Error('Некорректный идентификатор проекта из истории.');
    if(!online)throw new Error('Для открытия проекта из истории нужно подключение к серверу редактора.');
    resultEpoch++;busy=true;update();message('Открываю сохранённый проект и исходное фото…');
    const workspace=window.SignageWorkspace;workspace?.beginRestore();let opened=false;
    try{
      let job;
      if(workspace){job=await api(`/api/jobs/${id}`);const record=await api(`/api/projects/${job.project_id||'legacy-'+id}`);workspace.adopt(record,id);}
      const [project,blob]=await Promise.all([api(`/api/jobs/${id}/project.json`),api(`/api/jobs/${id}/source.png`,undefined,true)]);
      const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Не удалось прочитать сохранённое фото.'));reader.readAsDataURL(blob);});
      await editor.restoreProject(project,data);
      const url=new URL(location.href);url.searchParams.delete('restoreJob');history.replaceState(null,'',url);
      job=job||await api(`/api/jobs/${id}`);
      if(job.status==='complete'){
        submittedRevision=editor.snapshot().photoRevision;
        await showResult(job);
        result.project=current();update();
      }
      message(`Проект и исходное фото${job.status==='complete'?' вместе с сохранённым макетом':''} открыты из истории. Генерация не запускалась.`);
      opened=true;
    }finally{workspace?.endRestore(opened);busy=false;update();}
  }
  window.SignageGeneration.ready=checkConnection();
  window.SignageGeneration.ready.then(async()=>{
    try{await window.SignageDraft?.ready;await window.SignageWorkspace?.ready;}catch{}
    if(explicitHistory){try{await restoreFromHistory(initialRestoreId);}catch(e){message(e.message,true);}return;}
    pendingId=await checkPendingWorkspace();
    if(pendingId){
      pendingResumed=true;busy=true;
      if(online){message('Проверка предыдущего запроса…');poll();}
      else{message('Предыдущий запрос сохранён. Восстановите соединение и нажмите «Проверить текущий запрос». Новый запрос не отправлен.',true);$('resumeGeneration').hidden=false;update();}
    }
  });
})();
