'use strict';
// Pure DOM/VM contract tests: no browser, server, Codex, network or disk writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Products=require('../assets/products.js'),clone=v=>JSON.parse(JSON.stringify(v)),assets=path.join(__dirname,'../assets');
const catalog=clone(require('../assets/product-catalog.json'));
catalog.modules.push({type:'fixture_extension',label:'Новый модуль из данных',module_version:1,renderer_family:'flat_print',renderer_version:1,default_template_id:'fixture-extension-one',defaults:{},fields:['text','front_color','font_family','font_bold','text_align','line_gap_cm','brief','margin_mm','opacity','material'],field_schema:[
  {key:'edge_cm',label:'Дополнительный размер',kind:'number',min:0,max:30,default:2},
  {key:'edge_style',label:'Отделка',kind:'select',options:[{value:'plain',label:'Прямая'},{value:'folded',label:'Подгиб'}],default:'plain'},
  {key:'owner_note',label:'<img src=x onerror=alert(1)>',kind:'string',max_length:50,default:''},
  {key:'is_double',label:'Две стороны',kind:'boolean',default:false},
  {key:'edge_color',label:'Цвет края',kind:'color',default:'#112233'}]});
catalog.templates.push({id:'fixture-extension-one',type:'fixture_extension',version:1,label:'Вариант из данных',category:'Тестовая категория',description:'<script>alert(1)</script>',coverage_note:'Только плоская графика',default_placement:{width_cm:120,height_cm:30,rotation_deg:0},params:{}});
const P=Products.createRegistry(catalog),nodes=new Map();
class Element{
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.hidden=false;this.checked=false;this._value='';this.listeners=new Map();this.attributes=new Map();this.classList={toggle(){},remove(){}};this.textContent='';}
  set id(value){this._id=value;nodes.set(value,this);}get id(){return this._id||'';}
  set value(value){this._value=String(value);}get value(){return this._value;}
  get options(){return this.children;}
  append(...items){for(const item of items){if(item.parent){item.parent.children=item.parent.children.filter(n=>n!==item);}item.parent=this;this.children.push(item);}}
  replaceChildren(...items){for(const child of this.children)child.parent=null;this.children=[];this.append(...items);if(this.tagName==='SELECT')this.value=this.children[0]?.value||'';}
  setAttribute(key,value){this.attributes.set(key,String(value));}removeAttribute(key){this.attributes.delete(key);}
  addEventListener(type,listener){const list=this.listeners.get(type)||[];list.push(listener);this.listeners.set(type,list);}
}
for(const match of fs.readFileSync(path.join(assets,'calibrator.html'),'utf8').matchAll(/<([a-z0-9]+)\b[^>]*\bid="([^"]+)"[^>]*>/gi)){const e=new Element(match[1]);e.id=match[2];}
const document={getElementById:id=>nodes.get(id),createElement:tag=>new Element(tag),querySelectorAll:selector=>selector==='[data-product-type]'?nodes.get('productPicker').children:[],addEventListener(){}};
const base={version:1,image:null,calibration:{image_points:[]},sign:{text:'',font_family:'Arial',font_bold:true,line_gap_cm:0,text_align:'center',front_color:'#112233',side_color:'#222222',depth_cm:5,face_material:{type:'custom'},brief:''},placement:null};
let renderCount=0;const window={SignageProducts:P,SignageEditor:{snapshot:()=>({project:base}),setPlacement:value=>{base.placement=value;},render:()=>{renderCount++;window.SignageProductUI.compose(base);}},LetterGeometry:{textLines:t=>t.split('\n')}};
vm.runInNewContext(fs.readFileSync(path.join(assets,'product-ui.js'),'utf8'),{window,document,console,setTimeout,clearTimeout},{filename:'product-ui.js'});
const UI=window.SignageProductUI,get=id=>nodes.get(id),change=(id,value)=>{const e=get(id);if(typeof value==='boolean')e.checked=value;else e.value=value;for(const callback of get('dynamicProductFields').listeners.get('input')||[])callback({target:e});};
assert.equal(get('productPicker').children.length,P.list().length);
assert.equal(get('productTemplate').options.length,P.catalogue().length);
get('catalogSearch').value='Вариант из данных';get('catalogSearch').oninput();assert.equal(get('productTemplate').options.length,1);assert.equal(UI.type(),'channel_letters','Filtering cannot apply a template');
get('applyProductTemplate').onclick();assert.equal(UI.type(),'fixture_extension');assert.equal(UI.renderer(),'flat_print');
assert.equal(get('productName').textContent,'Вариант из данных');assert.equal(get('catalogSelectionNote').textContent,'<script>alert(1)</script> Только плоская графика');
assert.equal(get('productParam-owner_note').parent.textContent,'<img src=x onerror=alert(1)>','Labels are text, never HTML');
assert.equal(get('productParam-owner_note').maxLength,50);
change('productParam-edge_cm',17);change('productParam-edge_style','folded');change('productParam-owner_note','Сохранить');change('productParam-is_double',true);change('productParam-edge_color','#abcdef');
let value=UI.active();assert.equal(value.params.edge_cm,17);assert.equal(value.params.edge_style,'folded');assert.equal(value.params.owner_note,'Сохранить');assert.equal(value.params.is_double,true);assert.equal(value.params.edge_color,'#abcdef');assert.ok(renderCount>=5);
P.validateProduct(value);
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMfoAAAAASUVORK5CYII=';
value.artwork={name:'approved.png',source:'uploaded',mime_type:'image/png',width_px:1,height_px:1,data_url:'data:image/png;base64,'+png};
const saved={version:2,products:[clone(value)],active_product_id:value.id};UI.restore(saved);
UI.switchType('plaque');change('plaqueThickness',7);UI.switchType('neon');change('neonTubing',11);UI.switchType('plaque');assert.equal(get('plaqueThickness').value,'7','Legacy IDs must survive generated form switching');
UI.switchType('fixture_extension');assert.equal(UI.active().params.owner_note,'Сохранить');assert.equal(UI.active().artwork.data_url,value.artwork.data_url);assert.equal(UI.active().catalog_snapshot.label,'Вариант из данных');
const draft=UI.draftState();assert.equal(draft.products.plaque.params.thickness_mm,7);assert.equal(draft.products.neon.params.tubing_mm,11);
UI.switchType('cutout');assert.equal(get('artworkSource').disabled,true);assert.equal(get('artworkSource').value,'uploaded');assert.equal(get('corelSection').hidden,true);
const required=P.catalogue().find(t=>t.artwork_policy==='uploaded_required'&&t.type!=='cutout');
if(required){get('catalogSearch').value='';get('catalogSearch').oninput();get('productTemplate').value=required.id;get('applyProductTemplate').onclick();assert.equal(get('artworkSource').disabled,true,'QR, supplied contours and schemes cannot be invented from text');assert.equal(get('artworkSource').value,'uploaded');}
const retired=clone(saved);retired.products[0].type='retired_print';retired.products[0].id='retired-product';retired.active_product_id='retired-product';UI.restore(retired);assert.equal(UI.compose(base).products[0].params.owner_note,'Сохранить','Retired modules with installed renderer retain saved unknown parameters');
// Applying a new letters preset initializes an independent scene; reading an
// existing saved product still uses normal restore and retains its geometry.
let freshLetters=0,restoredLetters=0;
window.SignageLetterUI={restoreNew:sign=>{freshLetters++;base.sign={...base.sign,...sign,objects:[],composition_mode:'independent_signs_v1'};},restore:()=>{restoredLetters++;}};
get('catalogSearch').value='';get('catalogSearch').oninput();get('productTemplate').value='letters-standard';
get('applyProductTemplate').onclick();assert.equal(freshLetters,1);assert.equal(UI.active().params.composition_mode,'independent_signs_v1');
assert.equal(UI.active().placement,null);const existingLetters={version:2,products:[UI.active()],active_product_id:UI.active().id};
UI.restore(existingLetters);assert.equal(freshLetters,1);assert.equal(restoredLetters,1);
console.log('PASS: generated catalog selection/filter, arbitrary module fields, safe labels, typed edits, uploaded original, legacy control IDs, per-type drafts, upload-required policies and retired renderer snapshots.');
