/* Product modules and versioned project migration, shared by browser and Node. */
(function (root, factory) {
  const source = typeof module === 'object' && module.exports ? require('./product-catalog.json') : root.SignageCatalog;
  const api = factory(source);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SignageProducts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildRegistry(source) {
  'use strict';
  const fail = message => { throw new Error(message); };
  const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  }
  const numeric = (value, min, max, label) => Number.isFinite(value) && value >= min && value <= max ? value : fail(`${label}: требуется число от ${min} до ${max}.`);
  const choice = (value, values, label) => values.includes(value) ? value : fail(`${label}: неизвестное значение.`);
  const color = (value, label) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fail(`${label}: нужен цвет HEX #RRGGBB.`);
  const forbidden = new Set(['__proto__','prototype','constructor']);
  const supported = new Set(['channel_letters','plaque','neon','flat_print','lightbox','cutout']);
  const commonKeys=new Set(['text','font_family','font_bold','text_align','line_gap_cm','front_color','brief']);
  const parameterKey = key => typeof key === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(key) && !forbidden.has(key);
  function checkedFields(fields) {
    if (!Array.isArray(fields)) fail('Описание полей должно быть списком.');
    const seen = new Set();
    for (const field of fields) {
      if (!object(field) || !parameterKey(field.key) || seen.has(field.key)) fail('Неверное или повторяющееся поле модуля.');
      seen.add(field.key);
      if (typeof field.label !== 'string' || !field.label.trim() || field.label.length > 240) fail('Укажите подпись поля.');
      if (!['number','color','select','string','boolean'].includes(field.kind)) fail('Неизвестный формат поля.');
      if (field.kind === 'number' && (!Number.isFinite(field.min) || !Number.isFinite(field.max) || field.min > field.max)) fail('Неверные границы числового поля.');
      if (field.kind === 'select' && (!Array.isArray(field.options) || !field.options.length || field.options.some(o=>!object(o)||typeof o.value!=='string'||typeof o.label!=='string') || new Set(field.options.map(o=>o.value)).size!==field.options.length)) fail('Неверные варианты выбора.');
      if (field.kind === 'string' && (!Number.isInteger(field.max_length) || field.max_length < 1 || field.max_length > 5000)) fail('Укажите предел длины текстового поля.');
      if (field.default !== undefined) validateField(field,field.default);
    }
    return fields;
  }
  function checkedCatalogue(value) {
    if (!object(value) || value.schema_version !== 1 || !Number.isInteger(value.revision) || value.revision < 1) fail('Не поддерживается версия каталога.');
    if (![value.families,value.modules,value.templates].every(Array.isArray)) fail('Неверный каталог изделий.');
    const families=new Set(),modules=new Set(),templates=new Set();
    for (const f of value.families) {
      if (!object(f)||!supported.has(f.id)||f.version!==1||families.has(f.id)) fail('Не поддерживается семейство или версия визуализации.');
      families.add(f.id);checkedFields(f.field_schema);
      if (!object(f.defaults)||!object(f.capabilities)||!['none','text_or_upload','upload_only'].includes(f.artwork_mode)||typeof f.requires_transparency!=='boolean') fail('Неверное описание возможностей семейства.');
      if(f.artwork_mode!==(f.id==='channel_letters'?'none':f.id==='cutout'?'upload_only':'text_or_upload')||f.requires_transparency!==['neon','cutout'].includes(f.id))fail('Правила оригинала не соответствуют версии обработчика.');
      for (const key of ['corel','composite','ai','background_ai','svg','png']) if(typeof f.capabilities[key]!=='boolean') fail('Возможность должна быть true или false.');
      if(f.id!=='channel_letters'&&(f.capabilities.ai||f.capabilities.corel)||f.id==='channel_letters'&&f.capabilities.composite)fail('Возможность не поддерживается семейством визуализации.');
    }
    for (const m of value.modules) {
      if (!object(m)||modules.has(m.type)||m.module_version!==1||m.renderer_version!==1||!families.has(m.renderer_family)||typeof m.label!=='string'||!m.label.trim()||m.label.length>240||!object(m.defaults)||!Array.isArray(m.fields)||m.fields.some(k=>!parameterKey(k))) fail('Неверное описание модуля изделия.');
      safeId(m.type,'Вид изделия');safeId(m.default_template_id,'Шаблон');modules.add(m.type);
      if(m.field_schema!==undefined)checkedFields(m.field_schema);
      if((m.field_schema||[]).some(f=>commonKeys.has(f.key)))fail('Дополнительные поля не могут заменять общие параметры.');
      const combined=[...value.families.find(f=>f.id===m.renderer_family).field_schema,...(m.field_schema||[])];checkedFields(combined);
    }
    for (const t of value.templates) {
      if(!object(t)||templates.has(t.id)||!modules.has(t.type)||!Number.isInteger(t.version)||t.version<1||t.version>1000000||typeof t.label!=='string'||!t.label.trim()||t.label.length>240||!object(t.params)||!object(t.default_placement))fail('Неверный шаблон каталога.');
      safeId(t.id,'Шаблон');templates.add(t.id);
      for(const key of ['category','description','coverage_note','source_id'])if(t[key]!==undefined&&(typeof t[key]!=='string'||t[key].length>(key==='description'?10000:2000)))fail('Неверное описание шаблона.');
      checkedPolicy(t);
      for(const key of ['width_cm','height_cm'])numeric(t.default_placement[key],.01,100000,'Габарит шаблона');
      numeric(t.default_placement.rotation_deg??0,-360000,360000,'Поворот шаблона');
    }
    for(const m of value.modules)if(!value.templates.some(t=>t.type===m.type&&t.id===m.default_template_id))fail('У модуля нет начального шаблона.');
    for(const type of ['channel_letters','plaque','neon'])if(!value.modules.some(m=>m.type===type&&m.renderer_family===type&&m.renderer_version===1))fail('Сохраните базовые модули для совместимости прежних проектов.');
    return freeze(copy(value));
  }
  const data=checkedCatalogue(source),families=data.families,catalogue=data.templates;
  const modules=freeze(data.modules.map(m=>({...m,fields:[...new Set([...commonKeys,...m.fields])],capabilities:{...families.find(f=>f.id===m.renderer_family).capabilities}})));
  function descriptor(type) { return modules.find(item => item.type === type) || fail('Неизвестный вид изделия.'); }
  const list = () => modules;
  function templates(type) { if (type !== undefined) descriptor(type); return catalogue.filter(item => type === undefined || item.type === type); }
  const catalogueList=()=>catalogue;
  function productValue(value) {return typeof value==='string'?{type:value}:object(value)&&value.type?value:activeProduct(value);}
  function family(value) {
    const product=productValue(value),spec=modules.find(m=>m.type===product.type);
    const id=product.renderer_family===undefined?spec?.renderer_family:product.renderer_family,version=product.renderer_version===undefined?spec?.renderer_version:product.renderer_version;
    const stamp=product.module_snapshot,oldBinding=object(stamp)&&stamp.renderer_family===id&&stamp.renderer_version===version&&stamp.module_version===product.module_version;
    if(object(stamp)&&((stamp.renderer_family!==undefined&&stamp.renderer_family!==id)||(stamp.renderer_version!==undefined&&stamp.renderer_version!==version)||(stamp.module_version!==undefined&&stamp.module_version!==product.module_version)))fail('Сохранённое описание модуля не соответствует изделию.');
    if (spec && ((product.renderer_family!==undefined&&id!==spec.renderer_family)||(product.renderer_version!==undefined&&version!==spec.renderer_version))&&!oldBinding) fail('Семейство изделия не соответствует модулю.');
    const found=families.find(f=>f.id===id&&f.version===version);
    return found || fail('Не поддерживается семейство или версия визуализации. Исходный проект и результат можно скачать из истории.');
  }
  const renderer=value=>family(value).id;
  function parameterFields(value) {
    const product=productValue(value),spec=modules.find(m=>m.type===product.type);
    const familyFields=family(product).field_schema,extra=object(product.module_snapshot)&&Object.hasOwn(product.module_snapshot,'field_schema')?product.module_snapshot.field_schema:spec?.field_schema||[];
    checkedFields(extra);
    if(extra.some(f=>commonKeys.has(f.key)||familyFields.some(base=>base.key===f.key)))fail('Дополнительные поля не могут заменять параметры семейства.');
    return [...familyFields,...extra];
  }
  function displayLabel(value) {
    const product=productValue(value);
    return product.catalog_snapshot?.label||product.module_snapshot?.label||modules.find(m=>m.type===product.type)?.label||family(product).label||product.type;
  }
  function safeId(value, label) { if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value)) fail(`${label}: неверный идентификатор.`); return value; }
  function normalizeProduct(value) {
    if (!object(value)) fail('Изделие должно быть объектом.');
    safeId(value.type,'Вид изделия');
    const spec = modules.find(m=>m.type===value.type), f=family(value);
    if (value.module_version !== 1) fail('Не поддерживается версия модуля изделия.');
    if (!Number.isInteger(value.template_version) || value.template_version < 1 || value.template_version > 1000000) fail('Версия шаблона должна быть целым числом от 1 до 1000000.');
    safeId(value.id, 'Изделие'); safeId(value.template_id, 'Шаблон');
    if (!object(value.params)) fail('Параметры изделия должны быть объектом.');
    if (value.placement !== null && value.placement !== undefined && !object(value.placement)) fail('Размещение изделия должно быть объектом.');
    // Presets supply visible content when explicitly created. Reading a saved
    // snapshot never invents a word or changes an omitted legacy construction.
    // Family version 1 defaults are pinned compatibility values, never a
    // mutable catalogue template. Saved parameters and artwork always win.
    const effective = {...copy(f.defaults),text:'',...(f.id==='channel_letters'?{face_material:{type:'custom'}}:{}),...copy(value.params)};
    for(const key of ['catalog_snapshot','module_snapshot'])if(value[key]!==undefined){
      if(!object(value[key]))fail('Неверное сохранённое описание изделия.');
      for(const [name,content]of Object.entries(value[key]))if(typeof content==='string'&&content.length>(name==='description'?10000:2000))fail('Сохранённое описание изделия слишком длинное.');
      if(value[key].label!==undefined&&typeof value[key].label!=='string')fail('Неверная подпись изделия.');
      if(key==='catalog_snapshot')checkedPolicy({...value[key],artwork_policy:value[key].artwork_policy==='text_or_uploaded'?'text_or_upload':value[key].artwork_policy});
    }
    parameterFields(value);
    const normalized={...copy(value), placement:f.id==='channel_letters'&&effective.composition_mode==='independent_signs_v1'?null:copy(value.placement ?? null), params:effective};
    if(normalized.catalog_snapshot?.artwork_policy==='text_or_uploaded')normalized.catalog_snapshot.artwork_policy='text_or_upload';
    return normalized;
  }
  function createProduct(type, templateId) {
    const spec = descriptor(type), id = templateId || spec.default_template_id;
    const template = catalogue.find(item => item.type === type && item.id === id) || fail('Шаблон не принадлежит выбранному виду изделия.');
    return {id:`product-${type}`,type,module_version:1,template_id:template.id,template_version:template.version,
      renderer_family:spec.renderer_family,renderer_version:spec.renderer_version,
      module_snapshot:{label:spec.label,module_version:spec.module_version,renderer_family:spec.renderer_family,renderer_version:spec.renderer_version,field_schema:copy(spec.field_schema||[])},
      catalog_snapshot:{id:template.id,version:template.version,label:template.label,category:template.category||'',description:template.description||'',coverage_note:template.coverage_note||'',source_id:template.source_id||'',artwork_policy:template.artwork_policy||'text_or_upload',requires_uploaded_artwork:template.requires_uploaded_artwork===true},
      placement:null,params:{...copy(family(type).defaults),...Object.fromEntries((spec.field_schema||[]).filter(f=>f.default!==undefined).map(f=>[f.key,copy(f.default)])),...copy(spec.defaults),...copy(template.params)}};
  }
  function normalizeProject(project) {
    if (!object(project)) fail('Проект должен быть объектом.');
    if (project.version !== 1 && project.version !== 2) fail('Поддерживаются версии проекта 1 и 2.');
    const result = copy(project);
    if (project.version === 1) {
      // Legacy mirrors remain intact, including undocumented fields. Migration
      // is additive; the original source photograph lives separately as before.
      const f=families.find(f=>f.id==='channel_letters'&&f.version===1)||fail('Нет совместимого семейства объёмных букв.');
      const product = {id:'product-channel_letters',type:'channel_letters',module_version:1,template_id:'letters-standard',template_version:1,renderer_family:'channel_letters',renderer_version:1,module_snapshot:{label:f.label,renderer_family:'channel_letters',renderer_version:1}};
      product.params = {...copy(f.defaults),text:'',face_material:{type:'custom'},...copy(project.sign || {})};
      product.placement = copy(project.placement ?? null);
      result.products = [product]; result.active_product_id = product.id;
    } else {
      if (!Array.isArray(project.products) || project.products.length !== 1) fail('В этой версии проекта поддерживается ровно одно изделие. Несколько изделий не удаляются автоматически.');
      result.products = project.products.map(normalizeProduct);
      if (typeof project.active_product_id !== 'string' || project.active_product_id !== result.products[0].id) fail('Активное изделие не найдено в проекте.');
    }
    result.version = 2;
    return result;
  }
  function activeProduct(project) { return normalizeProject(project).products[0]; }
  function legacyProject(project) {
    if (project?.version === 1) return copy(project);
    const normalized = normalizeProject(project), product = normalized.products[0];
    return {...normalized, version:1, sign:copy(product.params), placement:copy(product.placement)};
  }
  function artworkInfo(artwork) {
    if (!object(artwork)) fail('Оригинал макета должен быть объектом.');
    if (artwork.mime_type !== 'image/png') fail('Точный оригинал макета должен быть PNG.');
    if (typeof artwork.name !== 'string' || artwork.name.length > 240) fail('Некорректное имя оригинала макета.');
    choice(artwork.source, ['uploaded','text'], 'Источник оригинала');
    const prefix = 'data:image/png;base64,', url = artwork.data_url;
    if (typeof url !== 'string' || !url.startsWith(prefix)) fail('Оригинал макета должен содержать PNG data URL.');
    const encoded = url.slice(prefix.length);
    if (encoded.length > 2796204 || encoded.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail('Некорректный PNG или превышен лимит оригинала 2 МиБ.');
    const decoded = encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
    if (decoded < 45 || decoded > 2 * 1024 * 1024) fail('Некорректный PNG или превышен лимит оригинала 2 МиБ.');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', bytes = [];
    // Decode only the PNG header here. Pillow verifies the complete image on
    // submission; no browser-only dependency is needed for project migration.
    for (let offset = 0; offset < 44; offset += 4) {
      const a=alphabet.indexOf(encoded[offset]), b=alphabet.indexOf(encoded[offset+1]), c=alphabet.indexOf(encoded[offset+2]), d=alphabet.indexOf(encoded[offset+3]);
      bytes.push((a<<2)|(b>>4),((b&15)<<4)|(c>>2),((c&3)<<6)|d);
    }
    if (![137,80,78,71,13,10,26,10].every((value,i)=>bytes[i] === value) || ![0,0,0,13,73,72,68,82].every((value,i)=>bytes[i+8] === value)) fail('Оригинал макета не является PNG.');
    const integer = at => bytes.slice(at,at+4).reduce((value,byte)=>value*256+byte,0);
    const width = integer(16), height = integer(20);
    numeric(width,1,4096,'Ширина оригинала'); numeric(height,1,4096,'Высота оригинала');
    if (width*height > 16000000 || artwork.width_px !== width || artwork.height_px !== height) fail('Размеры оригинала не соответствуют PNG или слишком велики.');
    return {width_px:width,height_px:height,size_bytes:decoded};
  }
  function validateField(field,value) {
    if(field.kind==='number')numeric(value,field.min,field.max,field.label);
    else if(field.kind==='color')color(value,field.label);
    else if(field.kind==='select')choice(value,field.options.map(o=>o.value),field.label);
    else if(field.kind==='boolean'&&typeof value!=='boolean')fail(`${field.label}: требуется true или false.`);
    else if(field.kind==='string'&&(typeof value!=='string'||value.length>field.max_length))fail(`${field.label}: неверная длина текста.`);
    return value;
  }
  function checkedPolicy(value) {
    if(value.artwork_policy!==undefined&&!['text_or_upload','uploaded_required'].includes(value.artwork_policy))fail('Неизвестное правило оригинального макета.');
    if(value.requires_uploaded_artwork!==undefined&&typeof value.requires_uploaded_artwork!=='boolean')fail('Требование оригинала должно быть true или false.');
  }
  function validateProduct(value, options = {}) {
    const product = normalizeProduct(value), params = product.params;
    const f=family(product),kind=f.id,letters=kind==='channel_letters',textLimit=letters?300:3000;
    if (typeof params.text !== 'string' || params.text.length > textLimit) fail(`Текст изделия должен содержать не больше ${textLimit} символов.`);
    if (typeof params.font_family !== 'string' || (!letters && !params.font_family.trim()) || params.font_family.length > (letters?4000:160)) fail('Укажите название шрифта.');
    if (typeof params.font_bold !== 'boolean') fail('Начертание шрифта должно быть true или false.');
    choice(params.text_align,['left','center','right'],'Выравнивание');
    numeric(params.line_gap_cm,0,1000,'Межстрочный зазор'); color(params.front_color,'Лицевой цвет');
    const briefLimit = letters ? 4000 : 5000;
    if (typeof params.brief !== 'string' || params.brief.length > briefLimit) fail(`Дополнительные требования должны содержать не больше ${briefLimit} символов.`);
    if (product.artwork !== undefined && product.artwork !== null) artworkInfo(product.artwork);
    if (options.requireContent && !params.text.trim() && !product.artwork) fail('Введите текст или загрузите точный оригинал PNG.');
    for(const field of parameterFields(product))if(Object.hasOwn(params,field.key))validateField(field,params[field.key]);else if(field.default!==undefined)validateField(field,field.default);
    if(options.requireContent&&capabilities(product).require_uploaded&&(!product.artwork||product.artwork.source!=='uploaded'))fail(f.requires_transparency?'Загрузите готовый PNG изделия с прозрачным фоном.':'Для этого изделия загрузите оригинальный PNG макета.');
    if (kind === 'channel_letters') {
      numeric(params.depth_cm,0,1000,'Глубина'); color(params.side_color,'Боковой цвет');
    } else if (kind === 'plaque') {
      color(params.background_color,'Цвет таблички'); choice(params.material,['pvc','acrylic','metal'],'Материал таблички');
      choice(params.mounting,['tape','standoffs','screws'],'Крепление');
      numeric(params.thickness_mm,.1,100,'Толщина таблички'); numeric(params.corner_radius_mm,0,1000,'Радиус углов'); numeric(params.margin_mm,0,1000,'Поля таблички');
    } else if(kind==='neon') {
      numeric(params.tubing_mm,1,100,'Толщина неона'); choice(params.backing,['clear','black','none'],'Подложка');
      numeric(params.backing_margin_mm,0,1000,'Отступ подложки'); choice(params.illumination,['on','off'],'Свечение');
    }
    if (product.placement) {
      const placement = product.placement;
      if (!Array.isArray(placement.center_px) || placement.center_px.length !== 2 || !placement.center_px.every(Number.isFinite)) fail('Некорректный центр изделия.');
      numeric(placement.width_cm,.01,100000,'Ширина изделия'); numeric(placement.height_cm,.01,100000,'Высота изделия');
      numeric(placement.rotation_deg ?? 0,-360000,360000,'Поворот');
      if (kind === 'plaque' && (params.margin_mm*2 >= Math.min(placement.width_cm,placement.height_cm)*10 || params.corner_radius_mm*2 > Math.min(placement.width_cm,placement.height_cm)*10)) fail('Поля или радиус углов не помещаются в габарит таблички.');
      if (kind === 'neon' && params.backing !== 'none' && params.backing_margin_mm*2 >= Math.min(placement.width_cm,placement.height_cm)*10) fail('Отступ подложки не помещается в габарит неона.');
      if(['flat_print','lightbox','cutout'].includes(kind)&&(params.margin_mm??0)*2>=Math.min(placement.width_cm,placement.height_cm)*10)fail('Поля не помещаются в габарит изделия.');
    }
    return product;
  }
  function summary(project) {
    const product = activeProduct(project), params = product.params;
    return {id:product.id,type:product.type,label:displayLabel(product),renderer_family:renderer(product),renderer_version:family(product).version,module_version:product.module_version,
      template_id:product.template_id,template_version:product.template_version,text:params.text || '',has_artwork:!!product.artwork,
      artwork_name:product.artwork?.name || null,width_cm:product.placement?.width_cm ?? null,height_cm:product.placement?.height_cm ?? null};
  }
  function capabilities(project) {
    const product = typeof project === 'string' ? {type:project} : object(project) && project.type ? project : activeProduct(project);
    const f=family(product);
    return {...f.capabilities,exact_artwork:!!product.artwork,require_uploaded:f.artwork_mode==='upload_only'||product.catalog_snapshot?.artwork_policy==='uploaded_required'||product.catalog_snapshot?.requires_uploaded_artwork===true};
  }
  function effectPadding(value,polygon) {
    const p=productValue(value),kind=renderer(p),params=p.params;
    const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]),scale=(dist(polygon[0],polygon[1])+dist(polygon[2],polygon[3]))/(2*p.placement.width_cm);
    if(kind==='neon'&&params.illumination==='on')return Math.ceil(Math.min(30,Math.max(1,params.tubing_mm/10*scale*1.8))*3+2);
    if(kind==='flat_print'||kind==='cutout')return 0;
    if(kind==='lightbox'){const shadow=Math.min(12,Math.max(2,params.depth_cm*scale)),radius=Math.min(30,Math.max(1,params.glow_mm/10*scale*1.8));return Math.ceil(Math.max(shadow,params.illumination==='on'?radius*3:0)+5);}
    return Math.ceil(Math.min(12,Math.max(2,(kind==='plaque'?params.thickness_mm:0)/10*scale))+5);
  }
  for(const template of catalogue)validateProduct(createProduct(template.type,template.id));
  return {normalizeProject,activeProduct,legacyProject,descriptor,list,templates,catalogue:catalogueList,family,renderer,parameterFields,displayLabel,effectPadding,createProduct,validateProduct,summary,capabilities,artworkInfo,createRegistry:buildRegistry,catalogRevision:data.revision};
});
