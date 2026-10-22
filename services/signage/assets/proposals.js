(() => {
  'use strict';
  const $=id=>document.getElementById(id),base=new URL('.',location.href),form=$('proposalForm');
  let token='',model=null,epoch=0,busy=false,photoURL=null;
  const number=n=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(n);
  const money=n=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(n/100)+' ₽';
  const descriptions={presentation:'Крупный макет фасада, преимущества, схемы и подробное предложение.',technical:'Точная комплектация, размерные схемы, материалы и расчёт стоимости.',compact:'Краткая подача проекта со схемами, материалами и условиями заказа.'};
  function status(id,message,error=false){$(id).textContent=message;$(id).classList.toggle('error',error);}
  async function api(path,{body,blob=false}={}){
    const response=await fetch(new URL(path,base),{method:body?'POST':'GET',credentials:'same-origin',headers:{'X-Editor-Token':token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    if(!response.ok){let error;try{error=await response.json();}catch{}if(response.status===401)throw new Error('Сеанс истёк. Откройте страницу входа в новой вкладке и войдите в визуализатор.');throw new Error(error?.error||'Не удалось получить данные. Повторите после проверки подключения.');}
    return blob?response.blob():response.json();
  }
  function price(){
    if(!model)return;
    const extras=['prototype','installation','delivery'].map(key=>{const v=form.elements[key].value;return v===''?null:Number(v);});
    const addition=extras.reduce((sum,n)=>sum+(Number.isFinite(n)?Math.round(n*100):0),0);
    $('price').textContent=model.pricing.rows.some(Boolean)?money(model.pricing.min+addition)+' – '+money(model.pricing.max+addition):'По согласованию';
    $('priceLabel').textContent=extras.some(n=>n===null)||!model.pricing.complete?'Рассчитанная часть · есть несогласованные работы':'Предварительно · с дополнительными работами';
  }
  function showDownloads(result){
    $('downloadCards').replaceChildren();
    for(const file of result.files){const card=document.createElement('article');card.className='download';const title=document.createElement('h3'),description=document.createElement('p'),download=document.createElement('a'),copy=document.createElement('button');title.textContent=file.title;description.textContent=descriptions[file.style];download.textContent='Скачать PDF · '+Math.round(file.bytes/1024)+' КБ';download.href=new URL(file.url,base);copy.type='button';copy.textContent='Скопировать ссылку';copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(download.href);copy.textContent='Ссылка скопирована';}catch{copy.textContent='Скопируйте адрес кнопки скачивания';}});card.append(title,description,download,copy);$('downloadCards').append(card);}
    $('results').hidden=false;$('resultTitle').textContent=result.files.length===3?'Сравните три подхода':'Ваш PDF готов';
  }
  async function select(){
    const current=++epoch,id=$('job').value;model=null;$('generate').disabled=true;$('objectList').replaceChildren();$('openSource').hidden=true;$('renderPreview').hidden=true;
    status('sourceStatus','Проверяем размеры, макеты и спецификацию…');
    try{
      const result=await api('api/proposal-source?job_id='+encodeURIComponent(id));if(current!==epoch)return;model=result;
      $('count').textContent=result.objects.length+' изделия';$('previewTitle').textContent=result.objects.map(o=>o.text).join(' / ');
      for(const o of result.objects){const row=document.createElement('div');row.className='object';const label=document.createElement('strong'),detail=document.createElement('small');label.textContent=o.text;detail.textContent=number(o.width)+' × '+number(o.height)+' см · тело '+(o.letter_height?number(o.letter_height)+' см':'уточнить');row.append(label,detail);$('objectList').append(row);}
      $('openSource').href=new URL('calibrator.html?restoreJob='+encodeURIComponent(id),base);$('openSource').hidden=false;
      status('sourceStatus','Размеры и исходные изображения проверены. КП будет сформировано по этому сохранённому варианту.');$('generate').disabled=false;price();
      const photo=await api('api/jobs/'+id+'/render.png',{blob:true});if(current!==epoch)return;if(photoURL)URL.revokeObjectURL(photoURL);photoURL=URL.createObjectURL(photo);$('renderPreview').src=photoURL;$('renderPreview').hidden=false;
    }catch(error){if(current===epoch){status('sourceStatus',error.message,true);$('price').textContent='—';}}
  }
  form.addEventListener('input',()=>{price();if(!$('results').hidden)$('stale').hidden=false;});
  $('job').addEventListener('change',select);
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!model)return;busy=true;$('generate').disabled=true;status('buildStatus','Формируем документы по выбранному варианту…');
    const options={};for(const key of ['client','contact','deadline','warranty','payment','validity','tax','benefits'])options[key]=form.elements[key].value;
    for(const key of ['prototype','installation','delivery'])options[key]=form.elements[key].value===''?null:Number(form.elements[key].value);
    options.demo_terms=!$('confirmed').checked;
    const before=new FormData(form),fingerprint=JSON.stringify([...before]),job=$('job').value;
    try{
      const result=await api('api/proposals',{body:{job_id:job,style:form.elements.style.value,options}});showDownloads(result);
      const permalink=new URL(location.href);permalink.searchParams.set('offer',result.id);permalink.searchParams.set('job',job);history.replaceState(null,'',permalink);
      $('stale').hidden=JSON.stringify([...new FormData(form)])===fingerprint;status('buildStatus','Готово. PDF доступны для скачивания ниже.');$('results').scrollIntoView({behavior:'smooth',block:'start'});
    }catch(error){status('buildStatus',error.message,true);}finally{busy=false;$('generate').disabled=!model;}
  });
  (async()=>{try{
    const config=await api('api/config');token=config.token;const history=await api('api/history?limit=100');const ready=history.items.filter(item=>item.status==='complete'&&item.has_production_spec);$('job').replaceChildren();
    for(const item of ready){const option=document.createElement('option');option.value=item.id;option.textContent=(item.text||'Готовый проект').replace(/\n/g,' / ')+' · '+new Date(item.created*1000).toLocaleDateString('ru-RU')+' · '+item.id.slice(0,8);$('job').append(option);}
    if(!ready.length){status('sourceStatus','Пока нет готовых вариантов со спецификацией. Создайте вариант в визуализаторе.',true);return;}
    const query=new URL(location.href).searchParams,offer=query.get('offer');let saved=null;
    if(offer&&/^[a-f0-9]{32}$/.test(offer))saved=await api('api/proposals/'+offer);
    const requested=saved?.source?.job_id||query.get('job');if(ready.some(item=>item.id===requested))$('job').value=requested;
    if(saved){for(const [key,value] of Object.entries(saved.options)){if(key==='demo_terms')$('confirmed').checked=!value;else if(form.elements[key])form.elements[key].value=value===null?'':(['prototype','installation','delivery'].includes(key)?value/100:value);}showDownloads(saved);}
    $('job').disabled=false;await select();
  }catch(error){status('sourceStatus',error.message,true);}})();
})();
