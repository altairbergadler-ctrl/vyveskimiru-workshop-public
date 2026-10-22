/* Server projects and their immutable generation variants. Opening never generates. */
(() => {
  'use strict';
  const $=id=>document.getElementById(id),preview=window.SignagePreview;
  const appBase=new URL('.',location.href);
  const modes={original:'Исходное освещение',sunny:'Солнечный день',cloudy:'Облачно',night:'Ночь'};
  const states={complete:'Готово',running:'Создаётся',failed:'Ошибка генерации',interrupted:'Запрос прерван'};
  const names={render:'render.png',base:'lighting-base.png',source:'source.png'};
  const captions={render:'Сохранённый макет на фото',base:'Световая основа без нового изделия',source:'Исходное фото'};
  let token='',offset=0,query='',listRevision=0,detailRevision=0,viewRevision=0,configRevision=0;
  let selected=null,lastCard=null,currentProject=null,listLoading=false,mergeBusy=false;
  let listController=new AbortController(),detailController=new AbortController(),configController=null;
  const thumbs=new Set(),projectSelection=new Map();
  const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{16,80}$/.test(id);
  const jobPath=(id,file='')=>{if(!validId(id))throw new Error('Некорректный номер запроса.');return `/api/jobs/${id}${file?'/'+file:''}`;};
  const projectPath=(id,suffix='')=>{if(!validId(id))throw new Error('Некорректный номер проекта.');return `/api/projects/${id}${suffix?'/'+suffix:''}`;};
  const projectName=item=>item.name||'Без названия';
  const continueUrl=id=>`calibrator.html?restoreProject=${encodeURIComponent(id)}`;
  function status(id,text,error=false){$(id).textContent=text;$(id).classList.toggle('error',error);}
  function date(value){const time=new Date(typeof value==='number'||/^\d+(\.\d+)?$/.test(String(value))?Number(value)*1000:value);return Number.isFinite(time.getTime())?time.toLocaleString('ru-RU',{day:'2-digit',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'}):'Дата не сохранена';}
  function variants(count){const value=Number(count)||0,last=value%10,lastTwo=value%100;return `${value} ${last===1&&lastTwo!==11?'вариант':last>=2&&last<=4&&(lastTwo<12||lastTwo>14)?'варианта':'вариантов'}`;}
  async function api(path,blob=false,options={}){
    const headers={'X-Editor-Token':token};
    if(options.body!==undefined)headers['Content-Type']='application/json';
    const response=await fetch(new URL(path.replace(/^\//,''),appBase),{method:options.method||'GET',headers,signal:options.signal,body:options.body===undefined?undefined:JSON.stringify(options.body)});
    if(!response.ok){let body;try{body=await response.json();}catch{}if(response.status===401&&body?.auth_required)$('authExpiredNotice').hidden=false;throw new Error(body?.error||`Ошибка сервера редактора (${response.status}).`);}
    return blob?response.blob():response.json();
  }
  function thumbnail(thumb,id,revision,fallback){
    if(!validId(id)){thumb.textContent=fallback;return;}
    thumb.textContent='Загружаю миниатюру…';
    api(jobPath(id,'thumbnail.jpg'),true,{signal:listController.signal}).then(blob=>{
      if(revision!==listRevision)return;
      const url=URL.createObjectURL(blob);thumbs.add(url);const img=document.createElement('img');img.src=url;img.alt='';img.loading='lazy';thumb.replaceChildren(img);
    }).catch(error=>{if(error.name!=='AbortError'&&revision===listRevision)thumb.textContent=fallback;});
  }
  function projectCard(item,revision){
    const card=document.createElement('article');card.className='project-card';card.dataset.projectId=item.id;
    const selection=document.createElement('label');selection.className='project-select';
    const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.className='project-checkbox';checkbox.checked=projectSelection.has(item.id);checkbox.setAttribute('aria-label',`Выбрать проект ${projectName(item)} для объединения`);
    const selectionText=document.createElement('span');selectionText.textContent='Выбрать для объединения';selection.append(checkbox,selectionText);
    checkbox.onchange=()=>{if(checkbox.checked)projectSelection.set(item.id,item);else projectSelection.delete(item.id);card.classList.toggle('is-selected',checkbox.checked);status('mergeStatus','');renderSelection();};
    const open=document.createElement('button');open.type='button';open.className='project-open';open.setAttribute('aria-label',`Открыть проект ${projectName(item)}, ${variants(item.variant_count)}`);
    const thumb=document.createElement('div');thumb.className='history-thumb';
    const body=document.createElement('div');body.className='history-card-body';
    const title=document.createElement('h2');title.textContent=projectName(item);
    const count=document.createElement('span');count.className='variant-count';count.textContent=Number(item.variant_count)?variants(item.variant_count):'Черновик · без генераций';
    const when=document.createElement('small');when.textContent=`Изменён: ${date(item.updated_at)}`;
    body.append(title,count,when);open.append(thumb,body);open.onclick=()=>openProject(item);
    const actions=document.createElement('div');actions.className='project-actions';
    const view=document.createElement('button');view.type='button';view.className='project-variants';view.textContent='Открыть варианты';view.onclick=()=>openProject(item);
    const resume=document.createElement('a');resume.className='button primary';resume.href=continueUrl(item.id);resume.target='_blank';resume.rel='noopener';resume.textContent='Продолжить редактирование ↗';
    actions.append(view,resume);card.append(selection,open,actions);card.classList.toggle('is-selected',checkbox.checked);
    thumbnail(thumb,item.thumbnail_job_id||item.last_job_id,revision,Number(item.variant_count)?'Превью недоступно':'Сохранённый черновик');
    return card;
  }
  function generationCard(item,revision){
    const button=document.createElement('button');button.type='button';button.className='history-card';
    const thumb=document.createElement('div');thumb.className='history-thumb';
    const body=document.createElement('div');body.className='history-card-body';
    const title=document.createElement('h2');title.textContent=item.text||'Без названия';
    const product=document.createElement('small');product.textContent=item.product?.label||'Объёмные буквы';
    for(const type of [item.product?.type,item.product_type,'channel_letters']){
      if(!type||!window.SignageProducts)continue;
      try{if(!item.product?.label)product.textContent=window.SignageProducts.descriptor(type).label;break;}catch{/* Saved metadata remains visible for unsupported modules. */}
    }
    const when=document.createElement('small');when.textContent=date(item.created);
    const mode=document.createElement('small');mode.textContent=modes[item.lighting]||item.lighting||'Освещение не сохранено';
    const state=document.createElement('span');state.className=`job-state ${Object.hasOwn(states,item.status)?item.status:''}`;state.textContent=states[item.status]||'Сохранённый запрос';
    body.append(title,product,when,mode,state);button.append(thumb,body);button.setAttribute('aria-label',`Открыть вариант: ${item.text||'без названия'}, ${when.textContent}, ${mode.textContent}, ${state.textContent}`);
    button.onclick=()=>{lastCard=button;openDetail(item);};
    thumbnail(thumb,item.id,revision,item.status==='complete'?'Миниатюра недоступна':'Результат ещё не создан');
    return button;
  }
  function renderSelection(){
    const target=$('mergeTarget').value,items=[...projectSelection.values()];
    $('mergePanel').hidden=!!currentProject||!items.length;
    $('selectionCount').textContent=`Выбрано: ${items.length}`;
    const options=items.map(item=>{const option=document.createElement('option');option.value=item.id;option.textContent=projectName(item);return option;});
    $('mergeTarget').replaceChildren(...options);
    if(projectSelection.has(target))$('mergeTarget').value=target;
    updateMergeHint();
  }
  function updateMergeHint(){
    const item=projectSelection.get($('mergeTarget').value);
    $('mergeProjects').disabled=mergeBusy||projectSelection.size<2;
    $('mergeHint').textContent=projectSelection.size<2?'Выберите минимум два проекта. Все их варианты станут одной группой; файлы генераций сохранятся.':`Все варианты будут в проекте «${projectName(item||{})}». Его название и текущие правки сохранятся. Правки остальных проектов не заменят этот черновик; их сохранённые варианты останутся доступны.`;
  }
  function clearSelection(){
    projectSelection.clear();
    document.querySelectorAll('.project-checkbox').forEach(input=>{input.checked=false;input.closest('.project-card').classList.remove('is-selected');});
    status('mergeStatus','');renderSelection();
  }
  function setMergeBusy(busy){
    mergeBusy=busy;
    document.querySelectorAll('#searchForm input,#searchForm button,.project-checkbox,.project-open,.project-variants,#mergeTarget,#clearSelection').forEach(control=>control.disabled=busy);
    $('backToProjects').disabled=busy;$('loadMore').disabled=busy||listLoading;updateMergeHint();
  }
  async function mergeProjects(){
    const ids=[...projectSelection.keys()],target=$('mergeTarget').value;
    if(mergeBusy||ids.length<2||!ids.includes(target))return;
    setMergeBusy(true);status('mergeStatus','Объединяю выбранные проекты…');
    try{
      const project=await api('/api/projects/merge',false,{method:'POST',body:{project_ids:ids,target_id:target}});
      if(!validId(project.id))throw new Error('Сервер не вернул объединённый проект. Обновите историю для проверки.');
      setMergeBusy(false);clearSelection();await openProject(project);
      if(currentProject===project)status('historyStatus',`Проекты объединены. Все варианты находятся в «${projectName(project)}».`);
    }catch(error){status('mergeStatus',error.message,true);}
    finally{setMergeBusy(false);}
  }
  function projectHeading(){
    $('projectBreadcrumb').hidden=!currentProject;$('projectHeading').hidden=!currentProject;
    $('historyGrid').setAttribute('aria-label',currentProject?'Варианты выбранного проекта':'Сохранённые проекты');
    $('searchLabel').textContent=currentProject?'Найти вариант по тексту изделия или номеру запроса':'Найти проект по названию или тексту варианта';
    if(currentProject){$('breadcrumbName').textContent=projectName(currentProject);$('projectTitle').textContent=projectName(currentProject);$('projectMeta').textContent=`${variants(currentProject.variant_count)} · Изменён: ${date(currentProject.updated_at)}`;$('continueProject').href=continueUrl(currentProject.id);}
    renderSelection();
  }
  async function openProject(item){
    if(mergeBusy)return;
    currentProject=item;$('search').value='';clearSelection();closeDetail(false);projectHeading();
    await load(true);
    if(currentProject!==item)return;
    $('projectHeading').scrollIntoView({behavior:'smooth',block:'start'});$('projectTitle').focus({preventScroll:true});
  }
  async function load(reset=false){
    if(mergeBusy||(!reset&&listLoading))return;
    if(reset){listController.abort();listController=new AbortController();listRevision++;listLoading=false;offset=0;query=$('search').value.trim();thumbs.forEach(url=>URL.revokeObjectURL(url));thumbs.clear();$('historyGrid').replaceChildren();closeDetail(false);if(!currentProject)clearSelection();}
    const revision=listRevision,start=offset,project=currentProject;
    listLoading=true;$('loadMore').disabled=true;
    status('historyStatus',project?'Загружаю варианты проекта…':'Загружаю проекты…');
    try{
      const path=project?projectPath(project.id,'jobs'):'/api/projects';
      const data=await api(`${path}?limit=24&offset=${start}&q=${encodeURIComponent(query)}`,false,{signal:listController.signal});
      if(revision!==listRevision)return;
      const records=Array.isArray(data.items)?data.items:[],items=records.filter(item=>validId(item.id));
      $('historyGrid').append(...items.map(item=>project?generationCard(item,revision):projectCard(item,revision)));
      offset=start+records.length;
      const total=Number(data.total)||0;
      if(project&&!query){project.variant_count=total;projectHeading();}
      $('loadMore').hidden=offset>=total||!records.length;
      status('historyStatus',total?`Показано: ${offset} из ${total} · ${project?'варианты':'проекты'}${query?' · результаты поиска':''}.`:query?'По этому запросу ничего не найдено.':project?'В проекте пока нет генераций. Нажмите «Продолжить редактирование», чтобы открыть сохранённые правки.':'Сохранённых проектов пока нет. Начните работу в редакторе.');
    }catch(error){if(error.name!=='AbortError'&&revision===listRevision){status('historyStatus',error.message,true);$('loadMore').hidden=true;}}
    finally{if(revision===listRevision){listLoading=false;$('loadMore').disabled=mergeBusy;}}
  }
  function releaseDetail(){
    detailController.abort();detailController=new AbortController();detailRevision++;viewRevision++;
    if(selected){Object.values(selected.urls).forEach(url=>URL.revokeObjectURL(url));if(selected.projectUrl)URL.revokeObjectURL(selected.projectUrl);}
    selected=null;$('detailImage').removeAttribute('src');$('detailImage').hidden=true;$('openDetailImage').disabled=true;
    ['downloadImage','downloadProject','restoreProject','downloadOriginalArtwork'].forEach(id=>$(id).removeAttribute('href'));
  }
  function closeDetail(focus=true){releaseDetail();$('detail').hidden=true;if(focus&&lastCard?.isConnected)lastCard.focus();}
  async function selectView(view){
    if(!selected?.project)return;
    const current=selected,revision=++viewRevision;$('openDetailImage').disabled=true;$('detailImage').hidden=true;
    status('detailStatus','Загружаю изображение…');
    try{
      if(!current.urls[view]){const blob=await api(jobPath(current.id,names[view]),true,{signal:detailController.signal});if(current!==selected)return;if(!current.urls[view])current.urls[view]=URL.createObjectURL(blob);}
      if(current!==selected||revision!==viewRevision)return;
      current.view=view;$('detailImage').src=current.urls[view];$('detailImage').alt=captions[view];$('detailImage').hidden=false;$('openDetailImage').disabled=false;
      [['viewRender','render'],['viewBase','base'],['viewSource','source']].forEach(([id,key])=>{$(id).classList.toggle('active',key===view);$(id).setAttribute('aria-pressed',String(key===view));});
      if(current.urls.render){$('downloadImage').href=current.urls.render;$('downloadImage').download=`signage-${current.id}.png`;$('downloadImage').hidden=false;}
      status('detailStatus',current.job.message||states[current.job.status]||'Сохранённый запрос',current.job.status==='failed'||current.job.status==='interrupted');
    }catch(error){if(error.name!=='AbortError'&&current===selected&&revision===viewRevision)status('detailStatus',error.message,true);}
  }
  async function openDetail(item){
    releaseDetail();const revision=detailRevision;
    selected={id:item.id,urls:{},project:null,job:null,view:'render'};
    $('detail').hidden=false;$('detailTitle').textContent=item.text||'Сохранённый запрос';$('detailMeta').textContent=`${date(item.created)} · ${modes[item.lighting]||item.lighting||''}`;
    $('detailColors').replaceChildren();$('detailMaterial').textContent='';$('detailAudit').textContent='';$('downloadImage').hidden=true;$('downloadProject').hidden=true;$('restoreProject').hidden=true;$('downloadOriginalArtwork').hidden=true;
    ['viewRender','viewBase','viewSource'].forEach(id=>$(id).disabled=true);
    status('detailStatus','Загружаю сохранённые параметры…');$('detail').scrollIntoView({behavior:'smooth',block:'start'});$('detailTitle').focus({preventScroll:true});
    try{
      const options={signal:detailController.signal};
      const [job,project]=await Promise.all([api(jobPath(item.id),false,options),api(jobPath(item.id,'project.json'),false,options)]);
      if(revision!==detailRevision)return;
      selected.job=job;selected.project=project;
      let product=null,editingError='';
      try{product=window.SignageProducts?.activeProduct(project);}catch(error){product=project.products?.[0]||null;editingError=error.message;}
      const editable=job.editable!==false&&!editingError,mode=job.lighting||project.generation?.lighting||item.lighting,sign=product?.params||project.sign;
      let label=product?.catalog_snapshot?.label||product?.module_snapshot?.label||job.product?.label||item.product?.label||'Изделие';
      try{if(product)label=window.SignageProducts.displayLabel(product);}catch{}
      $('detailTitle').textContent=sign?.text||product?.artwork?.name||label;$('detailMeta').textContent=`${label} · ${date(job.created||item.created)} · ${modes[mode]||mode||''}`;
      preview.colorSwatches($('detailColors'),sign,product?.type);$('detailMaterial').textContent=preview.materialSummary(project,mode);
      selected.projectUrl=URL.createObjectURL(new Blob([JSON.stringify(project,null,2)],{type:'application/json'}));
      $('downloadProject').href=selected.projectUrl;$('downloadProject').download=`signage-project-${item.id}.json`;$('downloadProject').hidden=false;
      if(product?.artwork){try{window.SignageProducts.artworkInfo(product.artwork);$('downloadOriginalArtwork').href=product.artwork.data_url;$('downloadOriginalArtwork').download=product.artwork.name;$('downloadOriginalArtwork').hidden=false;}catch{}}
      $('restoreProject').href=`calibrator.html?restoreJob=${encodeURIComponent(item.id)}`;$('restoreProject').hidden=!editable;
      const complete=job.status==='complete';$('viewRender').disabled=!complete;$('viewBase').disabled=!complete;$('viewSource').disabled=false;
      if(job.audit?.canvas_size_px)$('detailAudit').textContent=`${job.audit.canvas_size_px.join(' × ')} px · вне зоны замены: ${job.audit.changed_pixels_outside_edit_zone} изменённых пикселей относительно световой основы.`;
      await selectView(complete?'render':'source');
      if(revision!==detailRevision)return;
      if(!editable)status('detailStatus',`Сохранённые файлы доступны. Редактирование недоступно: ${job.compatibility_error||editingError||'модуль не поддерживается текущим выпуском'}`,true);
    }catch(error){if(error.name!=='AbortError'&&revision===detailRevision)status('detailStatus',error.message,true);}
  }
  $('searchForm').onsubmit=event=>{event.preventDefault();load(true);};
  $('clearSearch').onclick=()=>{$('search').value='';load(true);};$('refreshHistory').onclick=refresh;$('loadMore').onclick=()=>load();
  $('backToProjects').onclick=()=>{if(mergeBusy)return;currentProject=null;$('search').value='';projectHeading();load(true);$('search').focus();};
  $('clearSelection').onclick=clearSelection;$('mergeTarget').onchange=updateMergeHint;$('mergeProjects').onclick=mergeProjects;
  $('closeDetail').onclick=()=>closeDetail();
  [['viewRender','render'],['viewBase','base'],['viewSource','source']].forEach(([id,view])=>$(id).onclick=()=>selectView(view));
  $('openDetailImage').onclick=()=>{if(selected?.urls[selected.view])preview.openImage({src:selected.urls[selected.view],title:`${selected.project.products?.[0]?.params?.text||selected.project.sign?.text||'Изделие'} · ${captions[selected.view]}`,filename:`signage-${selected.id}-${selected.view}.png`});};
  async function refresh(){
    if(mergeBusy)return;
    const revision=++configRevision;if(configController)configController.abort();configController=new AbortController();
    try{const config=await api('/api/config',false,{signal:configController.signal});if(revision!==configRevision)return;token=config.token;$('authExpiredNotice').hidden=true;return load(true);}
    catch(error){if(error.name!=='AbortError'&&revision===configRevision)status('historyStatus',`История недоступна: ${error.message} Проверьте подключение к серверу редактора и обновите страницу.`,true);}
  }
  window.addEventListener('pagehide',event=>{if(event.persisted)return;listController.abort();detailController.abort();configController?.abort();thumbs.forEach(url=>URL.revokeObjectURL(url));thumbs.clear();releaseDetail();});
  refresh();
})();
