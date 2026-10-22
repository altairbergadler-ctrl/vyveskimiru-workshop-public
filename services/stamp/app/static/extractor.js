"use strict";
window.StampExtractor = {
  create(deps, options = {}) {
    const signature = options.kind === "signature";
    const noun = signature ? "Подпись" : "Оттиск";
    const mapId = id => !signature ? id : id.startsWith("extract-") ? "signature-"+id : id.replace("stamp-mode-","signature-mode-").replace("stamp-library-layout","signature-library-layout").replace("ready-stamp-panel","ready-signature-panel").replace("extractor-panel","signature-extractor-panel");
    const $ = id => document.getElementById(mapId(id));
    const cropFields = ['x', 'y', 'width', 'height'];
    const metadataFields = signature ? ['extract-name','extract-signer','extract-width'] : ['extract-name','extract-company','extract-inn','extract-width'];
    const s = {sources: [], source: null, page: 0, crop: {x:.25,y:.5,width:.5,height:.35}, pageReady:false, pageLoading:false, pageURL:null, previewURL:null, previewKey:null, revision:0, loadVersion:0, mode:'ready', drag:null};
    function message(text,kind='') { $('extract-message').textContent=text; $('extract-message').className=`extract-message ${kind}`; }
    function params() { return {page:s.page,crop:{...s.crop},color:$('extract-color').value,strength:Number($('extract-strength').value),rotation:Number($('extract-rotation').value)}; }
    function fingerprint() { return s.source ? JSON.stringify({source_id:s.source.id,...params()}) : ''; }
    function cropInputsValid() { return cropFields.every(key => { const input=$(`extract-crop-${key}`); return input.value!==''&&input.checkValidity(); }); }
    function optionsValid() { return cropInputsValid()&&$('extract-rotation').value!==''&&$('extract-rotation').checkValidity(); }
    function updateControls() {
      const busy=deps.isBusy()||s.pageLoading, hasPage=!!s.source&&s.pageReady, fresh=!!s.previewURL&&s.previewKey===fingerprint()&&optionsValid();
      $('extract-form').querySelectorAll('input,select').forEach(input=>{input.disabled=busy||(!hasPage&&!metadataFields.some(id => $(id)===input));});
      $('extract-source-file').disabled=busy; $('extract-source-select').disabled=busy||!s.sources.length; $('extract-page-select').disabled=busy||!s.source;
      $('stamp-mode-ready').disabled=busy; $('stamp-mode-extract').disabled=busy;
      $('extract-preview-button').disabled=busy||!hasPage||!optionsValid(); $('extract-save-button').disabled=busy||!fresh||s.savedKey===fingerprint(); $('extract-preview-download').disabled=busy||!fresh;
      $('extract-stage').classList.toggle('is-disabled',busy);
      $('extract-page-retry').disabled=busy||!s.source;
    }
    function invalidate() {
      s.revision++; s.previewKey=null;
      $('extract-output-image').closest('.extract-output').classList.toggle('stale',!!s.previewURL);
      $('extract-preview-status').textContent=s.previewURL?'Настройки изменились. Создайте новый предпросмотр перед сохранением.':'Сначала создайте и проверьте предпросмотр.';
      updateControls();
    }
    function clampCrop(crop) {
      const x=Math.max(0,Math.min(.999,Number(crop.x))),y=Math.max(0,Math.min(.999,Number(crop.y)));
      return {x,y,width:Math.max(.001,Math.min(1-x,Number(crop.width))),height:Math.max(.001,Math.min(1-y,Number(crop.height)))};
    }
    function renderCrop(syncInputs=true) {
      const box=$('extract-crop'), crop=s.crop;
      box.style.left=`${crop.x*100}%`;box.style.top=`${crop.y*100}%`;box.style.width=`${crop.width*100}%`;box.style.height=`${crop.height*100}%`;
      $('extract-crop-size').textContent=`${(crop.width*100).toFixed(1).replace('.',',')} × ${(crop.height*100).toFixed(1).replace('.',',')} %`;
      if(syncInputs)cropFields.forEach(key=>$(`extract-crop-${key}`).value=String(Math.round(crop[key]*1000)/10));
    }
    function setCrop(crop) { s.crop=clampCrop(crop);renderCrop();invalidate(); }
    function releasePage() { $('extract-page-image').removeAttribute('src');if(s.pageURL)URL.revokeObjectURL(s.pageURL);s.pageURL=null;s.pageReady=false; }
    function releasePreview() { $('extract-output-image').removeAttribute('src');if(s.previewURL)URL.revokeObjectURL(s.previewURL);s.previewURL=null;s.previewKey=null;$('extract-output-image').hidden=true;$('extract-output-empty').hidden=false;$('extract-output-image').closest('.extract-output').classList.remove('stale'); }
    function setDefaults(config) { if(signature){$('extract-width').value=config?.signature_width_mm||70;return;}$('extract-company').value=config?.company_name||'';$('extract-inn').value=config?.company_inn||'';$('extract-width').value=config?.width_mm||40; }
    function renderSources() {
      $('extract-source-select').replaceChildren();
      const empty=document.createElement('option');empty.value='';empty.textContent='Выберите или загрузите исходник';$('extract-source-select').append(empty);
      s.sources.forEach(source=>{const option=document.createElement('option');option.value=source.id;option.textContent=source.filename||'Скан';$('extract-source-select').append(option);});
      $('extract-source-select').value=s.source?.id||'';updateControls();
    }
    async function refreshSources() { const data=await deps.jsonRequest('api/stamp-sources');s.sources=data.items||[];renderSources(); }
    async function showMode(mode) {
      if(deps.isBusy())return;s.mode=mode;
      $('extractor-panel').hidden=mode!=='extract';$('ready-stamp-panel').hidden=mode==='extract';$('stamp-library-layout').classList.toggle('extract-mode',mode==='extract');
      ['ready','extract'].forEach(name=>{const button=$(`stamp-mode-${name}`);button.classList.toggle('active',name===mode);button.setAttribute('aria-pressed',String(name===mode));});
      if(mode==='extract') {
        if(!signature&&!$('extract-company').value)setDefaults(deps.getConfig());
        try {await refreshSources();}catch(error){message(error.message,'error');}
      }
    }
    async function loadPage(pageIndex) {
      if(!s.source)return;const page=s.source.pages?.find(item=>item.page===pageIndex);if(!page){message('Страница исходника не найдена.','error');return;}
      const sourceId=s.source.id,version=++s.loadVersion;s.page=pageIndex;s.pageLoading=true;releasePage();invalidate();$('extract-page-retry').hidden=true;
      $('extract-stage').hidden=true;$('extract-source-empty').hidden=true;$('extract-page-loading').hidden=false;$('extract-page-select').value=String(pageIndex);
      $('extract-page-caption').textContent=`Страница ${pageIndex+1} из ${s.source.page_count||s.source.pages.length}`;
      let url=null;
      try {
        const response=await deps.request(`api/stamp-sources/${encodeURIComponent(sourceId)}/pages/${pageIndex}.png`),blob=await response.blob();
        if(version!==s.loadVersion||sourceId!==s.source?.id)return;
        url=URL.createObjectURL(blob);const img=new Image();
        await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('Не удалось открыть страницу исходника.'));img.src=url;});
        if(version!==s.loadVersion||sourceId!==s.source?.id){URL.revokeObjectURL(url);return;}
        s.pageURL=url;s.pageReady=true;$('extract-page-image').src=url;$('extract-stage').style.aspectRatio=`${page.width} / ${page.height}`;$('extract-stage').style.maxWidth=`${Math.max(160,Math.round(560*page.width/page.height))}px`;
        $('extract-stage').hidden=false;renderCrop();message('Выделите нужные линии рамкой, выберите цвет и создайте предпросмотр.');
      }catch(error){if(url)URL.revokeObjectURL(url);if(version===s.loadVersion){message(error.message,'error');$('extract-page-retry').hidden=false;}}
      finally{if(version===s.loadVersion){s.pageLoading=false;$('extract-page-loading').hidden=true;updateControls();}}
    }
    async function selectSource(sourceId) {
      s.source=s.sources.find(source=>source.id===sourceId)||null;s.loadVersion++;s.pageLoading=false;releasePage();releasePreview();invalidate();$('extract-page-select').replaceChildren();$('extract-page-retry').hidden=true;
      $('extract-original-link').hidden=!s.source;
      if(!s.source){$('extract-stage').hidden=true;$('extract-source-empty').hidden=false;$('extract-page-caption').textContent=signature?'Выделите только область подписи':'Выделите только область печати';return;}
      $('extract-original-link').href=s.source.original_url||`api/stamp-sources/${encodeURIComponent(s.source.id)}/original`;
      $('extract-original-link').download=s.source.filename||'source';
      (s.source.pages||[]).forEach(page=>{const option=document.createElement('option');option.value=String(page.page);option.textContent=`Страница ${page.page+1}`;$('extract-page-select').append(option);});
      if(!$('extract-name').value)$('extract-name').value=`${noun} — ${(s.source.filename||'скан').replace(/\.(pdf|jpe?g|png)$/i,'')}`.slice(0,120);
      s.crop={x:.25,y:.5,width:.5,height:.35};renderCrop();await loadPage(s.source.pages?.[0]?.page??0);updateControls();
    }
    async function uploadSource(file) {
      if(!file||deps.isBusy())return;
      if(!/\.(pdf|jpe?g|png)$/i.test(file.name)&&!['application/pdf','image/jpeg','image/png'].includes(file.type)){message('Выберите PDF или изображение JPG/PNG.','error');return;}
      deps.setBusy(true);message('Сохраняем исходник и открываем страницу…');
      try{const form=new FormData();form.append('file',file);const source=await(await deps.request('api/stamp-sources',{method:'POST',body:form})).json();await refreshSources();if(!s.sources.some(item=>item.id===source.id))s.sources.unshift(source);renderSources();await selectSource(source.id);$('extract-source-select').value=source.id;}
      catch(error){message(error.message,'error');}
      finally{$('extract-source-file').value='';deps.setBusy(false);updateControls();}
    }
    async function createPreview() {
      if(deps.isBusy()||!s.source||!s.pageReady||!optionsValid())return;
      invalidate();const key=fingerprint(),revision=s.revision,sourceId=s.source.id,body=params();deps.setBusy(true);message('Выделяем существующие линии и убираем фон…');
      let url=null;
      try {
        const response=await deps.request(`api/stamp-sources/${encodeURIComponent(sourceId)}/extract`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        if(!response.headers.get('Content-Type')?.includes('image/png'))throw new Error('Сервер не вернул PNG предпросмотра. Повторите действие.');
        const blob=await response.blob();if(!blob.size)throw new Error('Предпросмотр пустой. Измените область или очистку.');
        url=URL.createObjectURL(blob);const img=new Image();await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('Не удалось показать извлечённое изображение.'));img.src=url;});
        if(key!==fingerprint()||revision!==s.revision){URL.revokeObjectURL(url);message('Настройки изменились. Создайте новый предпросмотр.');return;}
        releasePreview();s.previewURL=url;s.previewKey=key;s.savedKey=null;
        $('extract-output-image').src=url;$('extract-output-image').hidden=false;$('extract-output-empty').hidden=true;$('extract-preview-status').textContent='Свежий предпросмотр. Проверьте линии и текст перед сохранением.';
        let warnings=[];try{const raw=JSON.parse(response.headers.get('X-Extraction-Warnings')||'[]');if(Array.isArray(raw))warnings=raw.filter(item=>typeof item==='string');}catch(_){}
        if(body.color==='dark'&&!warnings.length)warnings.push('Чёрный текст в выделенной области тоже может остаться. Проверьте результат.');
        message(warnings.length?`Предпросмотр создан. ${warnings.join(' ')}`:'Предпросмотр создан. Проверьте линии на прозрачном фоне.','success');
      }catch(error){if(url&&url!==s.previewURL)URL.revokeObjectURL(url);message(error.message,'error');$('extract-preview-status').textContent='Предпросмотр не создан. Проверьте область и параметры; сохранение недоступно.';}
      finally{deps.setBusy(false);updateControls();}
    }
    async function saveStamp(event) {
      event.preventDefault();if(deps.isBusy()||!s.source||!s.previewURL||s.previewKey!==fingerprint()||!optionsValid()||!$('extract-form').checkValidity())return;
      const key=fingerprint(),sourceId=s.source.id,body={...params(),name:$('extract-name').value.trim(),...(signature ? {signer:$('extract-signer').value.trim()||null} : {company_name:$('extract-company').value.trim(),company_inn:$('extract-inn').value.trim()}),width_mm:Number($('extract-width').value)};
      deps.setBusy(true);message('Сохраняем изображение, исходник и настройки извлечения…');let saved=false;
      try{const library=await deps.jsonRequest(`api/stamp-sources/${encodeURIComponent(sourceId)}/${signature?"save-signature":"save"}`,body);saved=true;s.savedKey=key;await deps.onSaved(library);$('extract-preview-status').textContent='Изображение сохранено в библиотеке. Исходник и настройки доступны в карточке.';message(signature?'Подпись сохранена. Для открытого документа выберите её в рабочем месте.':'Оттиск сохранён и выбран для новых документов.','success');deps.notify(`${noun} из документа добавлен${signature?'а':''} в хранилище. Исходный скан сохранён.`,'success');}
      catch(error){message(saved?`Изображение сохранено, но обновить настройки не удалось: ${error.message}`:error.message,'error');}
      finally{deps.setBusy(false);updateControls();}
    }
    function point(event) {const box=$('extract-stage').getBoundingClientRect();return{x:Math.max(0,Math.min(1,(event.clientX-box.left)/box.width)),y:Math.max(0,Math.min(1,(event.clientY-box.top)/box.height))};}
    $('extract-stage').addEventListener('pointerdown',event=>{
      if(deps.isBusy()||!s.pageReady)return;event.preventDefault();
      const start=point(event),handle=event.target.closest('[data-crop-handle]')?.dataset.cropHandle,inside=event.target.closest('#'+mapId('extract-crop'));
      s.drag={pointerId:event.pointerId,start,original:{...s.crop},mode:handle|| (inside?'move':'draw')};
      $('extract-stage').setPointerCapture(event.pointerId);if(inside&&!handle)$('extract-crop').focus({preventScroll:true});
      if(!inside)setCrop({x:start.x,y:start.y,width:.001,height:.001});
    });
    $('extract-stage').addEventListener('pointermove',event=>{
      const drag=s.drag;if(!drag||drag.pointerId!==event.pointerId)return;event.preventDefault();const now=point(event),old=drag.original;
      if(drag.mode==='move'){setCrop({...old,x:Math.max(0,Math.min(1-old.width,old.x+now.x-drag.start.x)),y:Math.max(0,Math.min(1-old.height,old.y+now.y-drag.start.y))});return;}
      let x1,y1,x2,y2;
      if(drag.mode==='draw'){x1=drag.start.x;y1=drag.start.y;x2=now.x;y2=now.y;}
      else{x1=drag.mode.includes('w')?old.x+old.width:old.x;x2=now.x;y1=drag.mode.includes('n')?old.y+old.height:old.y;y2=now.y;}
      setCrop({x:Math.min(x1,x2),y:Math.min(y1,y2),width:Math.abs(x2-x1),height:Math.abs(y2-y1)});
    });
    for(const eventName of ['pointerup','pointercancel','lostpointercapture'])$('extract-stage').addEventListener(eventName,()=>{s.drag=null;});
    $('extract-crop').addEventListener('keydown',event=>{
      if(deps.isBusy()||!s.pageReady)return;const dirs={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};if(!dirs[event.key])return;
      event.preventDefault();const [dx,dy]=dirs[event.key],step=event.shiftKey ? .01 : .001;
      setCrop({...s.crop,x:Math.max(0,Math.min(1-s.crop.width,s.crop.x+dx*step)),y:Math.max(0,Math.min(1-s.crop.height,s.crop.y+dy*step))});
    });
    cropFields.forEach(key=>{
      const input=$(`extract-crop-${key}`);input.required=true;
      input.addEventListener('input',()=>{invalidate();if(!cropInputsValid())return;const crop=Object.fromEntries(cropFields.map(name=>[name,Number($(`extract-crop-${name}`).value)/100]));s.crop=clampCrop(crop);renderCrop(false);});
      input.addEventListener('change',()=>{if(cropInputsValid())renderCrop();updateControls();});
    });
    for(const id of ['extract-color','extract-strength','extract-rotation'])$(id).addEventListener('input',()=>{$('extract-strength-value').textContent=$('extract-strength').value;invalidate();});
    for(const id of metadataFields)$(id).addEventListener('input',()=>{s.savedKey=null;updateControls();});
    $('stamp-mode-ready').addEventListener('click',()=>showMode('ready'));$('stamp-mode-extract').addEventListener('click',()=>showMode('extract'));
    $('extract-source-file').addEventListener('change',event=>uploadSource(event.target.files[0]));
    $('extract-source-select').addEventListener('change',event=>selectSource(event.target.value));$('extract-page-select').addEventListener('change',event=>loadPage(Number(event.target.value)));
    $('extract-preview-button').addEventListener('click',createPreview);$('extract-form').addEventListener('submit',saveStamp);
    $('extract-page-retry').addEventListener('click',()=>{if(!deps.isBusy()&&!s.pageLoading&&s.source)loadPage(s.page);});
    $('extract-preview-download').addEventListener('click',()=>{if(deps.isBusy()||!s.previewURL||s.previewKey!==fingerprint()||!optionsValid())return;const link=document.createElement('a');link.href=s.previewURL;link.download=($('extract-name').value.trim()||(signature?'подпись':'оттиск'))+'.png';document.body.append(link);link.click();link.remove();});
    renderCrop();updateControls();
    return {updateControls,setDefaults,refreshSources,reset(){s.loadVersion++;s.source=null;s.sources=[];s.pageLoading=false;releasePage();releasePreview();invalidate();renderSources();$('extract-stage').hidden=true;$('extract-source-empty').hidden=false;$('extract-page-loading').hidden=true;$('extract-page-retry').hidden=true;$('extract-original-link').hidden=true;$('extract-page-select').replaceChildren();}};
  }
};
