/* Shared saved-result presentation and an accessible image viewer. */
(() => {
  'use strict';
  function namedObjects(objects){
    const counts={text:0,logo:0};
    return objects.map((object,index)=>({object,name:object?.type==='text'?`Текст ${++counts.text}`:object?.type==='logo'?`Лого ${++counts.logo}`:`Объект ${index+1}`}));
  }
  const cm=value=>Number.isFinite(value)?`${new Intl.NumberFormat('ru-RU',{maximumFractionDigits:3}).format(value)} см`:'не задана';
  function objectSummary(objects){
    const details=namedObjects(objects).map(({object,name})=>{
      if(object?.type==='logo')return `${name}: ширина ${cm(object.width_cm)}; исходный PNG; глубина по ТЗ ${cm(object.depth_cm??0)}`;
      if(object?.type!=='text')return `${name}: тип не поддерживается`;
      const lines=String(object.text??'').replace(/\r\n?/g,'\n').trim().split('\n').length;
      const font=object.artwork?.font_family_rendered;
      const raster=typeof font==='string'&&font.trim()?`шрифт PNG «${font}»${object.artwork.font_fallback?' (браузерная замена)':''}`:'шрифт PNG не записан';
      return `${name}: строк ${lines}; высота строки ${cm(object.letter_height_cm)}; шрифт по ТЗ «${object.font_family||'не указан'}»${object.font_bold?' Bold':''}; ${raster}; глубина по ТЗ ${cm(object.depth_cm??0)}`;
    });
    return [`Независимая композиция · объектов: ${objects.length}`, ...details].join('. ')+'. Тексты и логотипы переносятся из сохранённых PNG. Объём, тени и свечение показаны условно; свойства плёнки ORACAL и температура LED не моделируются.';
  }
  function materialSummary(project,mode){
    let product=null,family='channel_letters';
    try{product=window.SignageProducts?.activeProduct(project);family=product?window.SignageProducts.renderer(product):family;}catch{product=project.products?.[0]||null;family=product?.renderer_family||'unsupported';}
    const sign=product?.params||project.sign||{},material=sign.face_material;
    if(family==='channel_letters'&&Array.isArray(sign.objects))return objectSummary(sign.objects);
    if(family==='plaque'){
      const materials={pvc:'ПВХ',acrylic:'Акрил',metal:'Металл'},mounts={tape:'двусторонний скотч',standoffs:'дистанционные держатели',screws:'винты'};
      return `Табличка · ${materials[sign.material]||sign.material} · толщина ${sign.thickness_mm} мм · крепление: ${mounts[sign.mounting]||sign.mounting} · поля ${sign.margin_mm} мм · без собственной подсветки.`;
    }
    if(family==='neon')return `Неон · трубка ${sign.tubing_mm} мм · подложка: ${{clear:'прозрачная',black:'чёрная',none:'без подложки'}[sign.backing]||sign.backing} · подсветка ${sign.illumination==='off'?'выключена':'включена'} · точный контур из PNG.`;
    if(family==='flat_print')return `Плоская печать · поля ${sign.margin_mm} мм · непрозрачность ${Math.round(sign.opacity*100)}% · без искусственной подложки и объёма. Точный PNG сохраняется.`;
    if(family==='lightbox')return `Световой короб · глубина по ТЗ ${sign.depth_cm} см · подсветка ${sign.illumination==='off'?'выключена':'включена'} · точная лицевая графика из PNG. Объём и свечение показаны условно.`;
    if(family==='cutout')return 'Контур из загруженного PNG с прозрачностью. Сохранена исходная графика; трёхмерная и производственная геометрия не рассчитываются.';
    if(family==='unsupported')return 'Сохранённое ТЗ доступно для скачивания. Этот модуль не поддерживает редактирование в текущем выпуске.';
    if(material?.type!=='film_on_acrylic'){
      const details=[...new Set([sign.material,sign.lighting,sign.brief].filter(value=>typeof value==='string'&&value.trim()))];
      return 'Другая конструкция · по сохранённому ТЗ'+(details.length?`: ${details.join(' · ')}`:'. Материал и тип подсветки не уточнены.');
    }
    const finish={unspecified:'поверхность не уточнена',matte:'матовая плёнка',satin:'сатиновая плёнка',gloss:'глянцевая плёнка'};
    const acrylic={unspecified:'акрил не уточнён',opal:'молочный / опаловый акрил',clear:'прозрачный акрил'};
    const illuminated=mode==='night'||material.day_lighting==='on';
    const led=material.led_temperature_k==null?(illuminated?'температура LED не задана: условный нейтральный свет':'температура LED не задана'):`LED ${material.led_temperature_k} K`;
    return [`Плёнка ${material.brand||'ORACAL'} на акриле`,material.series?`серия ${material.series}`:'серия не указана',material.color_code?`код ${material.color_code}`:'код цвета не указан',finish[material.finish]||finish.unspecified,acrylic[material.acrylic]||acrylic.unspecified,led,mode==='night'?'ночью лицевая подсветка включена':`лицевая подсветка ${material.day_lighting==='on'?'включена':'выключена'}`,'борта не светятся'].join(' · ')+'.';
  }
  function colorSwatches(container,sign,type='channel_letters'){
    try{type=window.SignageProducts?.renderer(type)||type;}catch{type='unsupported';}
    if(type==='channel_letters'&&Array.isArray(sign?.objects)){
      const entries=namedObjects(sign.objects).flatMap(({object,name})=>[
        object?.type==='logo'?{name:`${name} · лицевая графика`,original:object.artwork?.data_url}:{name:`${name} · лицевая часть`,color:object?.front_color||'#fff3dc'},
        {name:`${name} · борта`,color:object?.side_color||'#292f30'}
      ]);
      container.replaceChildren(...entries.map(({name,color,original})=>{
        const item=document.createElement('div'),sample=document.createElement('i'),label=document.createElement('span');
        item.className='result-color';sample.className='color-swatch';sample.setAttribute('aria-hidden','true');
        const valid=typeof color==='string'&&/^#[0-9a-f]{6}$/i.test(color);
        if(valid)sample.style.background=color;
        if(typeof original==='string'&&/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(original)){
          sample.style.backgroundImage=`url("${original}")`;sample.style.backgroundSize='contain';sample.style.backgroundRepeat='no-repeat';sample.style.backgroundPosition='center';
        }
        label.textContent=`${name}: ${original!==undefined?'исходный PNG':valid?color.toUpperCase():'не указан'}`;item.append(sample,label);return item;
      }));
      return;
    }
    const colors=['plaque','lightbox'].includes(type)?[['Текст / оригинал',sign?.front_color],['Основание',sign?.background_color]]:type==='neon'?[['Неон',sign?.front_color]]:type==='channel_letters'?[['Лицевая часть',sign?.front_color],['Борта',sign?.side_color]]:[['Цвет по ТЗ',sign?.front_color]];
    container.replaceChildren(...colors.map(([name,color])=>{
      const item=document.createElement('div'),sample=document.createElement('i'),label=document.createElement('span');
      item.className='result-color';sample.className='color-swatch';sample.setAttribute('aria-hidden','true');
      const valid=typeof color==='string'&&/^#[0-9a-f]{6}$/i.test(color);
      if(valid)sample.style.background=color;
      label.textContent=`${name}: ${valid?color.toUpperCase():'не указан'}`;item.append(sample,label);return item;
    }));
  }
  function renderParameters(container,{project,mode,geometry,summary,audit}){
    let product;
    try{product=window.SignageProducts?.activeProduct(project);}catch{}
    const sign=product?.params||project.sign||{},generation=project.generation||{};
    const node=(tag,text,className)=>{const element=document.createElement(tag);if(text!==undefined)element.textContent=text;if(className)element.className=className;return element;};
    const facts=rows=>{const list=node('dl',undefined,'result-facts');for(const [label,value] of rows){const item=node('div');item.append(node('dt',label),node('dd',value));list.append(item);}return list;};
    const lighting=generation.photo_match==='source_noise_v1'?'Цветокоррекция как на фото':({original:'Исходное освещение',sunny:'Солнечный день',cloudy:'Облачно',night:'Ночь'}[mode]||mode);
    const content=[facts([['Освещение',lighting],['Ретушь окружения',generation.scene_retouch?.mode==='ideal_environment'?'Идеальная среда':'Как на исходном фото']])];
    if(Array.isArray(sign.objects))for(const {object,name} of namedObjects(sign.objects)){
      const card=node('section',undefined,'result-object-card');
      card.append(node('h4',object.type==='text'?`${name} · ${object.text||''}`:name));
      const rows=object.type==='logo'?[['Ширина по ТЗ',cm(object.width_cm)]]:[
        [object.height_basis==='body'?'Основная высота букв':'Максимальная высота строки',cm(object.letter_height_cm)],
        ['Шрифт',`${object.font_family||'не указан'}${object.font_bold?' · жирный':''}`]
      ];
      rows.push(['Глубина по ТЗ',cm(object.depth_cm)]);
      const layout=geometry?.sign_layout?.objects?.find(item=>item.id===object.id);
      if(Number.isFinite(layout?.width_cm)&&Number.isFinite(layout?.height_cm))rows.push(['Полный габарит',`${cm(layout.width_cm)} × ${cm(layout.height_cm)}`]);
      card.append(facts(rows));content.push(card);
    }else{
      const placement=product?.placement||project.placement;
      if(Number.isFinite(placement?.width_cm)&&Number.isFinite(placement?.height_cm))content.push(facts([['Габарит',`${cm(placement.width_cm)} × ${cm(placement.height_cm)}`]]));
    }
    if(audit?.photo_match)content.push(node('p',audit.photo_match.applied?'Зерно исходной фотографии наложено на поверхность вывески.':'Дополнительное зерно не потребовалось.'));
    const details=node('details',undefined,'result-material-details');details.append(node('summary','Материалы и пояснения'),node('p',summary));content.push(details);
    container.replaceChildren(...content);
  }
  const dialog=document.createElement('dialog');dialog.className='image-dialog';dialog.setAttribute('aria-labelledby','imageDialogTitle');
  const bar=document.createElement('div');bar.className='image-dialog-toolbar';
  const title=document.createElement('h2');title.id='imageDialogTitle';
  const zoom=document.createElement('button');zoom.type='button';zoom.textContent='Масштаб 100%';zoom.setAttribute('aria-pressed','false');
  const download=document.createElement('a');download.className='viewer-button';download.textContent='Скачать изображение';
  const close=document.createElement('button');close.type='button';close.textContent='Закрыть';close.setAttribute('aria-label','Закрыть просмотр изображения');
  const body=document.createElement('div');body.className='image-dialog-body';body.tabIndex=0;body.setAttribute('aria-label','Изображение; при масштабе 100% доступна прокрутка');
  const img=document.createElement('img');body.append(img);bar.append(title,zoom,download,close);dialog.append(bar,body);document.body.append(dialog);
  let opener=null;
  function setZoom(value){body.classList.toggle('natural-size',value);zoom.setAttribute('aria-pressed',String(value));zoom.textContent=value?'Вписать в окно':'Масштаб 100%';body.scrollTop=0;body.scrollLeft=0;}
  zoom.onclick=()=>setZoom(zoom.getAttribute('aria-pressed')!=='true');close.onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{img.removeAttribute('src');download.removeAttribute('href');if(opener?.isConnected)opener.focus();});
  dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
  function openImage({src,title:caption='Изображение',filename='signage.png'}){
    if(!src)return;opener=document.activeElement;title.textContent=caption;img.alt=caption;img.src=src;download.href=src;download.download=filename;setZoom(false);if(!dialog.open)dialog.showModal();close.focus();
  }
  window.SignagePreview={materialSummary,colorSwatches,renderParameters,openImage};
})();
