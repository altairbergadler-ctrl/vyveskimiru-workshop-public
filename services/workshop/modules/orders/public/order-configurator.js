import { product, PRODUCTS, LEGACY_PRODUCTS, schemas, swatches, unknown } from './order-config-model.js';
const productAsset=type=>`configurator-assets/${type}.${type==='custom'?'svg':'webp'}`;
const customDescriptionMarker='\nОписание товара:\n';
function customNameIssue(item){
 if(item.type!=='custom')return '';
 const name=String(item.data.name||'').trim();
 if(!name)return 'Укажите название товара.';
 const suffix=item.variants?.length?' · вариант '+item.variants.length:'';
 if((name+suffix).length>300)return suffix?'Название товара с обозначением размерного варианта должно быть не длиннее 300 символов. Сократите название.':'Название товара должно быть не длиннее 300 символов.';
 return '';
}
// Read only the labelled format emitted by this configurator. Legacy prose is
// never guessed; unrecognised lines remain visible and survive a later edit.
export function positionConfiguration(position){
 const name=String(position.name||'').replace(/ · вариант \d+$/,'');
 const description=String(position.description||'');
 const explicit=description.match(/^Тип продукции: (.+)$/m);
 const catalog=[...PRODUCTS,...LEGACY_PRODUCTS];
 let type=catalog.find(p=>p.name===explicit?.[1])?.id||catalog.find(p=>p.name===name)?.id;
 if(!type&&/^Что изготавливаем: /m.test(position.description||''))type='box';
 if(!type&&/^Вид печати: /m.test(position.description||''))type='print';
 if(!type&&name==='Объёмные буквы с логотипом')type='letters';
 if(!type)for(const id of ['box','print']){
  if(schemas[id].flatMap(s=>s.fields).find(f=>f.key==='kind').opts.filter(n=>n!==unknown).some(n=>name===n||name.startsWith(n+' на '))){type=id;break;}
 }
 if(!type||position.unit!=='шт')return null;
 const data={},parts=[],extra=[];
 // Free prose follows the structured metadata. Its contents are never parsed
 // as dimensions/options, even when the author uses the same field labels.
 const customDescriptionStart=type==='custom'?description.indexOf(customDescriptionMarker):-1;
 const structuredDescription=customDescriptionStart<0?description:description.slice(0,customDescriptionStart);
 if(!/^Количество изделий: /m.test(structuredDescription))return null;
 if(type==='custom'){data.name=String(position.name||'');data.description=customDescriptionStart<0?'':description.slice(customDescriptionStart+customDescriptionMarker.length);}
 const fields=[...schemas[type].flatMap(s=>s.fields).filter(f=>!['text','textarea'].includes(f.type)),...['width:Ширина:мм','height:Высота:мм','depth:Глубина:мм','qty:Количество изделий:шт','elements:Букв / элементов:шт'].map(v=>{const[key,label,unit]=v.split(':');return{key,label,unit};})];
 for(const line of structuredDescription.split('\n')){
  if(line==='Тип продукции: '+product(type).name)continue;
  const part=line.match(/^Часть (\d+) · (название|плёнка): (.*)$/);
  if(part&&Number(part[1])<=100){const i=Number(part[1])-1;if(i<0){extra.push(line);continue;}parts[i]||={label:'',film:''};const key=part[2]==='название'?'label':'film';if(parts[i][key])extra.push(line);else parts[i][key]=part[3];continue;}
  const field=fields.find(f=>line.startsWith(f.label+': ')||line.startsWith(f.label+' · проверьте применимость: '));
  if(field&&!Object.hasOwn(data,field.key)){
   let value=line.slice(line.indexOf(': ')+2);if(field.unit&&value.endsWith(' '+field.unit))value=value.slice(0,-field.unit.length-1);data[field.key]=value;
  }else extra.push(line);
 }
 // Table columns are the current authoritative dimensions and quantity.
 data.qty=String(position.quantity??data.qty??'');
 data.width=position.width==null||position.width===''?'':String(Number(position.width)*1000);
 data.height=position.height==null||position.height===''?'':String(Number(position.height)*1000);
 return {type,data,parts:Array.from(parts,p=>p||{label:'',film:''}),variants:[],source:'',extraLines:extra,storedName:String(position.name),originalNaming:{kind:data.kind,composition:data.composition,substrate:data.substrate}};
}
export function mountOrderConfigurator(hostRoot,{options={},initial=null,onChange=()=>{},saveOption,readOnly=false,singleItem=false}={}){
const $=id=>hostRoot.querySelector('#'+id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone=o=>JSON.parse(JSON.stringify(o));
const state=initial?clone(initial):{items:[],editor:null,editingIndex:null,showCatalog:true,source:''};
const initialSnapshot=JSON.stringify(state);
hostRoot.classList.add('order-configurator');
hostRoot.classList.toggle('config-readonly',readOnly);
hostRoot.classList.toggle('config-single',singleItem);
hostRoot.innerHTML='<fieldset class="config-lock"><section id="products-section"><div class="config-heading"><h3>Продукция</h3><span id="count-label"></span></div><div id="saved-items"></div><div id="product-flow"></div><p id="config-message" role="status"></p><div id="config-comment" class="summary-comment" hidden></div></section></fieldset>';

// Official ORAFOL 8500 European catalogue, checked 2026-09-26.
// https://www.orafol.com/en/europe/products/oracal-8500-translucent-cal
const filmColors8500={
 '041':{name:'Розовый',hex:'#b3006a'}, // sRGB 179 0 106
 '063':{name:'Липово-зелёный',hex:'#4ab600'}, // sRGB 74 182 0
 '034':{name:'Оранжевый',hex:'#e05400'} // sRGB 224 84 0
};
function filmColor(value){
 const match=String(value).trim().match(/^oracal\s+8500\s*(?:[·/#-]\s*)?(\d{3})$/i);
 if(match)return filmColors8500[match[1]]||null;
 if(value==='Чёрная плёнка')return {name:'Чёрный',hex:'#171717'};
 if(value==='Белая плёнка')return {name:'Белый',hex:'#ffffff'};
 return null;
}
function filmValueHTML(value,showName=false){
 const color=filmColor(value);
 return `<span class="film-value">${color?`<span class="film-swatch" style="background:${color.hex}" title="${esc(color.name)}" aria-hidden="true"></span>`:''}<span>${esc(value)}${showName&&color?`<small>${esc(color.name)}</small>`:''}</span></span>`;
}
function enhanceFilmSelect(select){
 select.hidden=true;select.tabIndex=-1;
 const host=document.createElement('div');host.className='film-picker';select.after(host);
 const id='film-list-'+select.dataset.part;
 host.innerHTML=`<button type="button" class="film-trigger" aria-label="Плёнка части ${Number(select.dataset.part)+1}" aria-haspopup="listbox" aria-expanded="false" aria-controls="${id}"></button><div class="film-options" id="${id}" role="listbox" aria-label="Плёнка" hidden></div>`;
 const trigger=host.querySelector('button'),list=host.querySelector('.film-options');
 const sync=()=>{trigger.innerHTML=filmValueHTML(select.value||'Выберите…',true)+'<span class="film-arrow" aria-hidden="true">⌄</span>';};
 const close=()=>{list.hidden=true;trigger.setAttribute('aria-expanded','false');};
 const open=()=>{
  hostRoot.querySelectorAll('.film-picker').forEach(other=>{if(other!==host){other.querySelector('.film-options').hidden=true;other.querySelector('.film-trigger').setAttribute('aria-expanded','false');}});
  list.innerHTML=[...select.options].map((option,i)=>`<button type="button" role="option" tabindex="-1" data-film-index="${i}" aria-selected="${option.value===select.value}">${filmValueHTML(option.textContent,true)}</button>`).join('');
  list.hidden=false;trigger.setAttribute('aria-expanded','true');
 };
 trigger.onclick=()=>{if(list.hidden)open();else close();};
 list.onclick=event=>{const option=event.target.closest('[data-film-index]');if(!option)return;select.selectedIndex=Number(option.dataset.filmIndex);select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));sync();close();trigger.focus({preventScroll:true});};
 host.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&!list.hidden){event.preventDefault();event.stopPropagation();close();trigger.focus();}
  if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();if(list.hidden)open();const options=[...list.children],i=options.indexOf(document.activeElement);const next=event.key==='Home'?0:event.key==='End'?options.length-1:i<0?(event.key==='ArrowUp'?options.length-1:0):(i+(event.key==='ArrowUp'?-1:1)+options.length)%options.length;options[next].focus();}
 });
 host.addEventListener('focusout',()=>setTimeout(()=>{if(!host.contains(document.activeElement))close();},0));select.addEventListener('input',sync);sync();
}

const hasSpecValue=value=>value!==undefined&&value!==null&&String(value).trim()!=='';
// One complete representation feeds saved cards, live preview and exported description.
function specificationRows(item){
 const rows=[],seen=new Set(),data=item.data||{};
 const add=(key,label,value)=>{if(hasSpecValue(value)){rows.push({key,label,value:String(value)});seen.add(key);}};
 for(const field of schemas[item.type].flatMap(section=>section.fields)){
  if(item.type==='custom'&&field.key==='name'){seen.add(field.key);continue;}
  const value=data[field.key];if(!hasSpecValue(value))continue;
  const applicability=field.when&&!field.when(data)?' · проверьте применимость':'';
  add(field.key,field.label+applicability,String(value)+(field.unit?' '+field.unit:''));
 }
 for(const[key,label,unit]of [['width','Ширина','мм'],['height','Высота','мм'],['depth','Глубина','мм'],['qty','Количество изделий','шт'],['elements','Букв / элементов','шт']]){
  if(hasSpecValue(data[key]))add(key,label,`${data[key]} ${unit}`);
 }
 // Preserve any saved extension that a newer/older form did not explicitly describe.
 for(const[key,value]of Object.entries(data)){if(!seen.has(key)&&hasSpecValue(value))add(key,`Дополнительный параметр · ${key}`,value);}
 (item.parts||[]).forEach((part,index)=>{
  const prefix=`Часть ${index+1}`;
  if(hasSpecValue(part.label))add(`parts.${index}.label`,`${prefix} · название`,part.label);
  if(hasSpecValue(part.film))add(`parts.${index}.film`,`${prefix} · плёнка`,part.film);
 });
 (item.variants||[]).forEach((variant,index)=>{
  for(const[key,label,unit]of [['w','ширина','мм'],['h','высота','мм'],['depth','глубина','мм'],['steps','ступени',''],['qty','количество','шт']]){
   if(hasSpecValue(variant[key]))add(`variants.${index}.${key}`,`Вариант ${index+1} · ${label}`,`${variant[key]}${unit?' '+unit:''}`);
  }
 });
 (item.extraLines||[]).filter(Boolean).forEach((value,index)=>add('extra.'+index,'Дополнительное описание',value));
 return rows;
}
// Colour names remain literal text in summaries and exports. Only explicit names
// are illustrated: a film/RAL code alone does not establish its actual shade.
const specificationColors=[
 {name:/^теплый белый$/,ink:'#ffe5b1',surface:'#374137'},
 {name:/^нейтральный белый(?: · 4000 k)?$/,ink:'#fafaf0',surface:'#374137'},
 {name:/^бел(?:ый|ая|ое)$/,ink:'#ffffff',surface:'#374137'},
 {name:/^черн(?:ый|ая|ое)$/,ink:'#171717',surface:'#f0f1ed'},
 {name:/^красн(?:ый|ая|ое)$/,ink:'#b32626',surface:'#fff0ed'},
 {name:/^салатов(?:ый|ая|ое)$/,ink:'#c2e885',surface:'#374137'},
 {name:/^графит(?:овый|овая|овое)?$/,ink:'#51565b',surface:'#f0f1ed'},
 {name:/^розов(?:ый|ая|ое)$/,ink:'#f4b3ce',surface:'#374137'},
 {name:/^син(?:ий|яя|ее)$/,ink:'#224bb2',surface:'#eef3ff'},
 {name:/^голуб(?:ой|ая|ое)$/,ink:'#a5daff',surface:'#374137'},
 {name:/^зелен(?:ый|ая|ое)$/,ink:'#21633c',surface:'#edf6ed'},
 {name:/^желт(?:ый|ая|ое)$/,ink:'#ffe36b',surface:'#374137'},
 {name:/^оранжев(?:ый|ая|ое)$/,ink:'#ffb56b',surface:'#374137'},
 {name:/^фиолетов(?:ый|ая|ое)$/,ink:'#7335a0',surface:'#f7efff'},
 {name:/^сер(?:ый|ая|ое)$/,ink:'#565d61',surface:'#f0f1ed'}
];
function specificationValueHTML(row){
 if(/^(film|parts\.\d+\.film)$/.test(row.key)&&filmColor(row.value))return filmValueHTML(row.value);
 const colorField=/^(face|side|frameColor|backMaterial|film|vinylColor|glow|substrate|parts\.\d+\.film)$/.test(row.key);
 const name=row.value.trim().toLocaleLowerCase('ru-RU').replace(/ё/g,'е').replace(/\s+/g,' ').replace(/ (пленка|композит|пвх|акрил|поликарбонат)$/,'');
 const color=colorField&&specificationColors.find(candidate=>candidate.name.test(name));
 if(!color)return esc(row.value);
 return `<span class="spec-color" style="--spec-ink:${color.ink};--spec-surface:${color.surface}"><span class="spec-color-swatch" aria-hidden="true"></span><span>${esc(row.value)}</span></span>`;
}
function specificationHTML(item){const rows=specificationRows(item);return rows.length?`<dl class="specification-grid">${rows.map(row=>`<div class="specification-field" data-spec-key="${esc(row.key)}"><dt>${esc(row.label)}</dt><dd>${specificationValueHTML(row)}</dd></div>`).join('')}</dl>`:'<p class="specification-empty">Характеристики ещё не заполнены</p>';}
const optionIdentity=value=>String(value).normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('ru-RU');
let variantCatalog=clone(options);
function readVariantCatalog(){return variantCatalog;}
function optionScope(key,type){return ['kind','purpose','composition','shape','mount'].includes(key)?`${type}:${key}`:key;}
function mergeOptions(base,extra,selected){const result=[],seen=new Set();for(const value of [...base,...extra,...(selected?[selected]:[])]){const id=optionIdentity(value);if(!id||seen.has(id))continue;seen.add(id);result.push(value);}return result;}
function optionsFor(field,type,selected){const values=mergeOptions(field.opts.filter(o=>o!=='Уточняется'),variantCatalog[optionScope(field.key,type)]||[],selected&&selected!=='Уточняется'?selected:'');return [...values,'Уточняется'];}
function newOptionButton(key,label){return `<button type="button" class="chip new-option-button" data-new-option="${esc(key)}" aria-label="Новый вариант: ${esc(label)}">+ Новый вариант</button>`;}
function bindCustomOptions(root){
 root.querySelectorAll('[data-new-option]').forEach(button=>button.onclick=()=>{const field=schemas[state.editor.type].flatMap(s=>s.fields).find(f=>f.key===button.dataset.newOption);if(!field)return;openVariantEditor(button,{scope:optionScope(field.key,state.editor.type),label:field.label,base:field.opts,set:value=>{state.editor.data[field.key]=value;state.editor=effectiveItem(state.editor);}});});
 root.querySelectorAll('select[data-part-key="film"],select[data-v-key="steps"]').forEach(select=>{
  const isPart=select.dataset.part!==undefined;const scope=isPart?'film':'variant-steps';const idx=Number(isPart?select.dataset.part:select.dataset.variant);const selected=select.value;const base=[...select.options].map(o=>o.value).filter(Boolean);const values=mergeOptions(base,variantCatalog[scope]||[],selected);select.innerHTML=selectOptions(values,selected);
  const button=document.createElement('button');button.type='button';button.className='text-button new-option-button';button.textContent='+ Новый вариант';button.setAttribute('aria-label',isPart?'Новый вариант: плёнка части':'Новый вариант: ступени');select.after(button);button.onclick=e=>{e.preventDefault();openVariantEditor(button,{scope,label:isPart?'Плёнка части':'Ступени',base,set:value=>{if(isPart)state.editor.parts[idx].film=value;else state.editor.variants[idx].steps=value;}});};
  if(isPart)enhanceFilmSelect(select);
 });
}
function openVariantEditor(button,target){
 hostRoot.querySelectorAll('.new-option-form').forEach(el=>el.remove());
 const host=button.closest('.option-row')||button.closest('.part-row');if(!host)return;
 const panel=document.createElement('div');panel.className='new-option-form';panel.innerHTML=`<label for="new-option-value">Новый вариант · ${esc(target.label)}<input id="new-option-value" maxlength="100" autocomplete="off" placeholder="Введите название варианта"></label><div class="new-option-actions"><button type="button" class="secondary" data-option-cancel>Отмена</button><button type="button" class="primary" data-option-save>Сохранить и выбрать</button></div><p class="field-hint">Добавится в список для следующих заказов. Сохраняется в общем справочнике Google.</p><p class="form-error" role="alert" data-option-error hidden></p>`;
 host.append(panel);const input=panel.querySelector('input'),error=panel.querySelector('[data-option-error]');
 const cancel=()=>{panel.remove();button.focus({preventScroll:true});};panel.querySelector('[data-option-cancel]').onclick=cancel;
 const save=async()=>{const value=input.value.normalize('NFKC').trim().replace(/\s+/g,' ');error.hidden=true;if(!value){error.textContent='Введите название варианта.';error.hidden=false;input.focus();return;}if(value.length>100){error.textContent='Название должно быть не длиннее 100 символов.';error.hidden=false;return;}
  const current=readVariantCatalog();const existing=mergeOptions(target.base,current[target.scope]||[]).find(v=>optionIdentity(v)===optionIdentity(value));const selected=existing||value;
  if(!existing){panel.querySelector('[data-option-save]').disabled=true;try{variantCatalog=await saveOption(target.scope,value);}catch(failure){error.textContent=failure.message||'Не удалось подтвердить сохранение варианта. Повторите попытку.';error.hidden=false;panel.querySelector('[data-option-save]').disabled=false;return;}}
  else variantCatalog=current;
  target.set(selected);renderEditor();toast(existing?'Такой вариант уже есть — он выбран.':'Новый вариант сохранён и выбран.');
 };
 panel.querySelector('[data-option-save]').onclick=save;input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();void save();}if(e.key==='Escape'){e.preventDefault();e.stopPropagation();cancel();}};input.focus();panel.scrollIntoView({block:'nearest',behavior:'smooth'});
}
function makeItem(type,data={},useDefaults=true){const defaults={qty:'1'};if(useDefaults){const fields=schemas[type].flatMap(s=>s.fields);if(fields.some(f=>f.key==='frame'))defaults.frame='Нужен';if(fields.some(f=>f.key==='backing'))defaults.backing='Нужна';}return {type,data:{...defaults,...data},parts:[],variants:[],source:''};}
function applicable(item){return schemas[item.type].flatMap(s=>s.fields).filter(f=>!f.when||f.when(item.data));}
function effectiveItem(item){if(item.storedName)return clone(item);const out=clone(item),keys=new Set(applicable(item).map(f=>f.key));['width','height','qty','elements'].forEach(k=>keys.add(k));if(['rack','custom'].includes(item.type))keys.add('depth');if(item.type==='box'&&item.data.shape==='Круг'){keys.delete('width');keys.delete('height');}for(const k of Object.keys(out.data))if(!keys.has(k))delete out.data[k];return out;}
function itemName(item){const d=item.data;if(item.type==='custom')return String(d.name||'').trim()||product(item.type).name;if(item.storedName&&['kind','composition','substrate'].every(key=>d[key]===item.originalNaming?.[key]))return item.storedName;if(item.type==='box'&&d.kind&&d.kind!==unknown)return d.kind;if(item.type==='print'&&d.kind&&d.kind!==unknown&&!['Печать с накаткой','Холст на каркасе','Печать на прозрачной плёнке'].includes(d.kind))return d.kind;if(item.type==='print'&&d.kind&&d.kind!==unknown)return d.kind==='Холст на каркасе'?'Холст на каркасе':d.kind==='Печать на прозрачной плёнке'?'Печать на прозрачной плёнке':`Печать с накаткой${d.substrate&&d.substrate!==unknown?' на '+d.substrate:''}`;if(item.type==='letters'&&d.composition==='Буквы + логотип')return 'Объёмные буквы с логотипом';return product(item.type).name;}
function lines(item){
 return specificationRows(item).filter(row=>!row.key.startsWith('extra.')&&!(item.type==='custom'&&row.key==='description')).map(row=>`${row.label}: ${row.value}`).concat(item.extraLines||[]);
}

function materialRefs(item){const d=effectiveItem(item).data;const refs=[];const add=(id,label)=>{if(label&&label!==unknown&&!refs.some(r=>r.catalogKey===id))refs.push({catalogKey:id,label,warehouseSku:null,stock:null,unit:null,status:'not_connected'});};if(d.film&&d.film!==unknown)add('film:'+d.film,d.film);if(d.substrate&&d.substrate!==unknown)add('sheet:'+d.substrate+':'+(d.thickness||d.polyThickness||''),[d.substrate,d.thickness||d.polyThickness].filter(Boolean).join(' '));if(d.backMaterial&&d.backMaterial!==unknown)add('sheet:backing:'+d.backMaterial,d.backMaterial);if(d.vinylColor&&d.vinylColor!==unknown)add('vinyl:'+d.vinylColor+':'+(d.finish||''),[d.vinylColor+' плёнка',d.finish===unknown?'':d.finish].filter(Boolean).join(' · '));if(d.glow&&d.glow!==unknown)add('neon:'+d.glow,'Неон · '+d.glow);if(d.side&&d.side!==unknown)add('side:'+d.side+':'+(d.sideDepth||''),'Борт · '+d.side+(d.sideDepth?' · '+d.sideDepth+' мм':''));if(item.type==='banner')add('print:banner','Баннер · плотность не задана');if(d.kind==='Холст на каркасе')add('print:canvas','Холст');if(d.kind==='Печать на прозрачной плёнке')add('print:clear-vinyl','Прозрачная плёнка');for(const p of item.parts)if(p.film&&p.film!==unknown)add('film:'+p.film,p.film);return refs;}
function fieldHTML(f,d){
 if(f.when&&!f.when(d))return '';
 if(['text','textarea'].includes(f.type)){
  const attributes=`data-field="${f.key}" maxlength="${f.maxLength}" placeholder="${esc(f.placeholder)}"${f.required?' required':''}`;
  const control=f.type==='textarea'?`<textarea ${attributes} rows="4">${esc(d[f.key]||'')}</textarea>`:`<input type="text" ${attributes} value="${esc(d[f.key]||'')}">`;
  return `<label class="option-row">${esc(f.label)}${f.required?' *':''}${control}</label>`;
 }
 if(f.type==='number')return `<label class="option-row">${esc(f.label)}, ${esc(f.unit)}<input type="number" data-field="${f.key}" value="${esc(d[f.key]||'')}" min="${f.key==='componentCount'?'1':'0.01'}" step="${f.key==='componentCount'?'1':'any'}" placeholder="Не указано"></label>`;
 return `<div class="option-row"><div class="option-label">${esc(f.label)}${d[f.key]?`<button type="button" class="option-clear" data-clear="${f.key}" aria-label="Очистить ${esc(f.label)}">Сбросить</button>`:''}</div><div class="chips" role="group" aria-label="${esc(f.label)}">${optionsFor(f,state.editor.type,d[f.key]).map(o=>`<button type="button" class="chip" data-choice="${f.key}" data-value="${esc(o)}" aria-pressed="${d[f.key]===o}">${f.key==='film'&&filmColor(o)?filmValueHTML(o,true):`${swatches[o]?`<span class="swatch" style="background:${swatches[o]}" aria-hidden="true"></span>`:''}${esc(o)}`}</button>`).join('')}${newOptionButton(f.key,f.label)}</div></div>`;
}
function selectOptions(values,value){return `<option value="">Выберите…</option>`+mergeOptions(values,[],value).map(o=>`<option${o===value?' selected':''}>${esc(o)}</option>`).join('');}
function renderParts(item){if(!['letters','logo','plotter'].includes(item.type))return '';const opts=item.type==='plotter'?['Белая плёнка','Чёрная плёнка',unknown]:['Oracal 8500 · 041','Oracal 8500 · 063','Oracal 8500 · 034','Чёрная плёнка',unknown];return `<div class="option-section"><h4>Части с разными цветами</h4><p class="film-color-note">Цвет на экране — ориентир. Для точного подбора используйте веер плёнок.</p><div class="parts">${item.parts.map((p,i)=>`<div class="part-row"><label>Часть макета<input data-part="${i}" data-part-key="label" value="${esc(p.label)}" placeholder="Например, логотип"></label><label>Плёнка<select data-part="${i}" data-part-key="film">${selectOptions(opts,p.film)}</select></label><button type="button" class="delete" data-delete-part="${i}" aria-label="Удалить часть ${i+1}">×</button></div>`).join('')}</div><button class="text-button bottom-link" type="button" id="add-part">+ Добавить часть</button></div>`;}
function renderVariants(item){if(!['rack','custom','print','plaque','banner'].includes(item.type))return '';return `<div class="option-section"><h4>Другие размеры этого изделия</h4><div class="parts">${item.variants.map((v,i)=>`<div class="part-row"><label>Ширина, мм<input type="number" min="0.01" step="any" data-variant="${i}" data-v-key="w" value="${esc(v.w||'')}" placeholder="Не указано"></label><label>Высота, мм<input type="number" min="0.01" step="any" data-variant="${i}" data-v-key="h" value="${esc(v.h||'')}" placeholder="Не указано"></label><button class="delete" type="button" data-delete-variant="${i}" aria-label="Удалить вариант ${i+1}">×</button>${['rack','custom'].includes(item.type)?`<label>Глубина, мм<input type="number" min="0.01" step="any" data-variant="${i}" data-v-key="depth" value="${esc(v.depth||'')}"></label>${item.type==='rack'?`<label>Ступени<select data-variant="${i}" data-v-key="steps">${selectOptions(['2','3'],v.steps)}</select></label>`:''}`:''}<label>Количество, шт<input type="number" min="1" step="1" data-variant="${i}" data-v-key="qty" value="${esc(v.qty||'')}"></label></div>`).join('')}</div><button type="button" class="text-button bottom-link" id="add-variant">+ Добавить размерный вариант</button></div>`;}
function renderEditor(){const item=state.editor,d=item.data,p=product(item.type);$('product-flow').innerHTML=`<div class="editor-heading"><img src="${productAsset(p.id)}" alt=""><div><small>${state.editingIndex===null?'Новое изделие':'Редактирование позиции'}</small><h3>${p.name}</h3></div><button class="text-button" type="button" id="back-catalog">← К списку</button></div><div class="source-tag">Варианты встречались в заказах: <strong>${esc(p.source)}</strong></div>${schemas[p.id].map(s=>{const fields=s.fields.map(f=>fieldHTML(f,d)).join('');return fields?`<div class="option-section"><h4>${s.title}</h4>${fields}</div>`:''}).join('')}<div class="option-section"><h4>Размеры и количество</h4><div class="dim-grid">${!(item.type==='box'&&d.shape==='Круг')?`<label>Ширина, мм<input type="number" min="0.01" step="any" data-field="width" value="${esc(d.width||'')}" placeholder="Не указана"></label><label>Высота, мм<input type="number" min="0.01" step="any" data-field="height" value="${esc(d.height||'')}" placeholder="Не указана"></label>`:''}${['rack','custom'].includes(item.type)?`<label>Глубина, мм<input type="number" min="0.01" step="any" data-field="depth" value="${esc(d.depth||'')}" placeholder="Не указана"></label>`:''}<label>Изделий, шт<input type="number" min="1" step="1" data-field="qty" value="${esc(d.qty||'')}" placeholder="Уточняется"></label>${['letters','logo'].includes(item.type)?`<label>Букв / элементов, шт<input type="number" min="1" step="1" data-field="elements" value="${esc(d.elements||'')}" placeholder="Не указано"></label>`:''}</div></div>${renderParts(item)}${singleItem?'':renderVariants(item)}<div class="stock-box"><div class="stock-heading">Материалы <span>Склад · позже</span></div><div id="stock-lines"></div></div><div id="inline-preview" class="inline-preview"></div><div id="editor-error" class="form-error" role="alert" hidden></div><div class="editor-actions"><button type="button" class="secondary" id="cancel-item">Отмена</button><button type="button" class="primary" id="add-item">${state.editingIndex===null?'Добавить в заказ':'Сохранить позицию'} →</button></div>`;bindEditor();updatePreview();}
function catalog(){return `<div class="catalog-intro"><p>Что будем изготавливать?</p><span>9 типов</span></div><div class="product-grid">${PRODUCTS.map(p=>`<button type="button" class="product-tile" data-product="${p.id}"><img src="${productAsset(p.id)}" alt=""><span class="tile-copy"><strong>${p.name}</strong><small>${p.hint}</small></span><span class="chevron" aria-hidden="true">›</span></button>`).join('')}</div>`;}
function render(){renderSavedItems();if(readOnly){$('product-flow').replaceChildren();return;}if(state.editor)renderEditor();else if(state.showCatalog){$('product-flow').innerHTML=catalog();$('product-flow').querySelectorAll('[data-product]').forEach(b=>b.onclick=()=>{state.editor=makeItem(b.dataset.product);state.editingIndex=null;render();$('product-flow').scrollIntoView({block:'start',behavior:'smooth'});$('back-catalog').focus({preventScroll:true});});}else{$('product-flow').innerHTML='<button type="button" class="add-more" id="add-more">+ Добавить ещё изделие</button>';$('add-more').onclick=()=>{state.showCatalog=true;render();};}updatePreview();}
function renderSavedItems(){$('count-label').textContent=state.items.length?`${state.items.length} поз.`:'Выберите изделие';$('saved-items').innerHTML=state.items.map((item,i)=>`<div class="saved-item"><img src="${productAsset(item.type)}" alt=""><div class="saved-item-main"><strong>${i+1}. ${esc(itemName(item))}</strong>${specificationHTML(item)}</div><div class="saved-actions"><button type="button" class="text-button" data-edit="${i}" aria-label="Изменить позицию ${i+1}">Изменить</button><button type="button" class="text-button delete" data-remove="${i}" aria-label="Удалить позицию ${i+1}">Удалить</button></div></div>`).join('');$('saved-items').querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{state.editingIndex=Number(b.dataset.edit);state.editor=clone(state.items[state.editingIndex]);render();});$('saved-items').querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{const idx=Number(b.dataset.remove);if(state.editingIndex===idx){state.editor=null;state.editingIndex=null;}else if(state.editingIndex!==null&&idx<state.editingIndex)state.editingIndex--;state.items.splice(idx,1);if(!state.items.length)state.showCatalog=true;render();});}
function bindEditor(){const root=$('product-flow');bindCustomOptions(root);root.querySelectorAll('[data-choice]').forEach(b=>b.onclick=()=>{const d=state.editor.data;d[b.dataset.choice]=b.dataset.value;state.editor=effectiveItem(state.editor);renderEditor();const found=root.querySelector(`[data-choice="${b.dataset.choice}"][aria-pressed="true"]`);found?.focus({preventScroll:true});});root.querySelectorAll('[data-clear]').forEach(b=>b.onclick=()=>{delete state.editor.data[b.dataset.clear];state.editor=effectiveItem(state.editor);renderEditor();});root.querySelectorAll('[data-field]').forEach(el=>el.oninput=()=>{state.editor.data[el.dataset.field]=el.value;updatePreview();});root.querySelectorAll('[data-part]').forEach(el=>el.oninput=()=>{state.editor.parts[Number(el.dataset.part)][el.dataset.partKey]=el.value;updatePreview();});root.querySelectorAll('[data-variant]').forEach(el=>el.oninput=()=>{state.editor.variants[Number(el.dataset.variant)][el.dataset.vKey]=el.value;updatePreview();});root.querySelectorAll('[data-delete-part]').forEach(b=>b.onclick=()=>{state.editor.parts.splice(Number(b.dataset.deletePart),1);renderEditor();});root.querySelectorAll('[data-delete-variant]').forEach(b=>b.onclick=()=>{state.editor.variants.splice(Number(b.dataset.deleteVariant),1);renderEditor();});if($('add-part'))$('add-part').onclick=()=>{state.editor.parts.push({label:'',film:''});renderEditor();};if($('add-variant'))$('add-variant').onclick=()=>{state.editor.variants.push({w:'',h:'',depth:'',steps:'',qty:'1'});renderEditor();};const back=()=>{state.editor=null;state.editingIndex=null;state.showCatalog=true;render();};$('back-catalog').onclick=back;$('cancel-item').onclick=()=>{state.editor=null;state.editingIndex=null;state.showCatalog=state.items.length===0;render();};$('add-item').onclick=()=>{const nameIssue=customNameIssue(state.editor);if(nameIssue){$('editor-error').hidden=false;$('editor-error').textContent=nameIssue;root.querySelector('[data-field=name]')?.focus();return;}const invalid=[...root.querySelectorAll('input[type=number]')].find(el=>!el.checkValidity());if(invalid){$('editor-error').hidden=false;$('editor-error').textContent='Проверьте числа: размеры должны быть больше нуля, количество — целым числом от 1.';invalid.reportValidity();return;}const item=effectiveItem(state.editor);item.parts=item.parts.filter(p=>p.label||p.film);if(state.editingIndex===null)state.items.push(item);else state.items[state.editingIndex]=item;state.editor=null;state.editingIndex=null;state.showCatalog=false;render();toast('Позиция добавлена в заказ');$('products-section').scrollIntoView({block:'start',behavior:'smooth'});};}
function updatePreview(){
 if(state.editor&&$('stock-lines')){const refs=materialRefs(state.editor);$('stock-lines').innerHTML=refs.length?refs.map(r=>`<div class="stock-line"><span>${esc(r.label)}</span><span>Остаток —</span></div>`).join('')+'<p>Остатки ещё не подключены.</p>':'<p>Выберите материал.</p>';$('inline-preview').innerHTML='<small>Полное описание позиции</small><strong>'+esc(itemName(state.editor))+'</strong>'+specificationHTML(state.editor);}
 onChange();
}

function toast(message){$('config-message').textContent=message;}

render();
return {
 state:()=>clone(state),
 hasChanges:()=>JSON.stringify(state)!==initialSnapshot,
 setDisabled:value=>{hostRoot.querySelector('fieldset').disabled=value;},
 setComment:value=>{const node=$('config-comment');node.hidden=!String(value||'').trim();node.innerHTML='<strong>Комментарий к заказу</strong><p>'+esc(value)+'</p>';},
 positions:()=>{
  if(state.editor)throw Object.assign(new Error('Добавьте настраиваемое изделие в заказ или отмените его редактирование.'),{creationSafeFailure:true,status:422});
  const result=[];
  for(const item of state.items){
   const nameIssue=customNameIssue(item);if(nameIssue)throw Object.assign(new Error(nameIssue),{creationSafeFailure:true,status:422});
   const rows=[{w:item.data.width,h:item.data.height,qty:item.data.qty},...item.variants];
   for(const [i,row] of rows.entries()){
    const quantity=Number(row.qty);if(!Number.isInteger(quantity)||quantity<1)throw Object.assign(new Error('Укажите целое количество изделий от 1.'),{creationSafeFailure:true,status:422});
    const actual=clone(item);actual.variants=[];actual.data={...actual.data,width:row.w||'',height:row.h||'',qty:String(quantity)};if(i){if(row.depth)actual.data.depth=row.depth;if(row.steps)actual.data.steps=row.steps;}
    result.push({template:'custom',name:itemName(item)+(i?' · вариант '+i:''),description:['Тип продукции: '+product(item.type).name,...lines(actual),...(i?['Размерный вариант: '+i]:[]),...(item.type==='custom'&&hasSpecValue(item.data.description)?['Описание товара:',item.data.description]:[])].join('\n')||itemName(item),unit:'шт',width:row.w?Number(row.w)/1000:'',height:row.h?Number(row.h)/1000:'',quantity,unitPrice:'',unitCost:''});
   }
  }
  return result;
 }
};
}
