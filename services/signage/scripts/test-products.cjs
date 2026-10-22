'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Products = require('../assets/products.js');
const G = require('../assets/geometry.js');
const clone = value => JSON.parse(JSON.stringify(value));
const image = {name:'product-fixture.png',width_px:1600,height_px:1000};
const calibration = {mode:'frontoparallel',frontoparallel_assumed:true,image_points:[[100,100],[500,100]],length_cm:100};
const legacy = {version:1,image,calibration,sign:{text:'СТАРЫЙ МАКЕТ',depth_cm:7,front_color:'#eeeeee',custom_sign:{origin:'CDR'}},
  placement:{center_px:[800,400],width_cm:120,height_cm:40,rotation_deg:0,custom_placement:true},
  measurements:[{same_plane:false,name:'unknown',image_points:[[0,0],[1,1]]}],checks:[],ruler:{same_plane:true,image_points:[[0,0],[400,0]]},
  target_polygon_px:[[500,200],[1100,200],[1100,600],[500,600]],generation:{lighting:'original',edit_polygon_px:[[450,150],[1150,150],[1150,650],[450,650]],custom_generation:42},
  custom_root:{original:true}};
const before = JSON.stringify(legacy), migrated=Products.normalizeProject(legacy);
assert.equal(JSON.stringify(legacy),before,'Migration must never mutate an original project');
assert.equal(migrated.version,2);
assert.equal(migrated.products.length,1);
assert.equal(migrated.active_product_id,migrated.products[0].id);
assert.equal(migrated.products[0].type,'channel_letters');
assert.deepEqual(migrated.sign,legacy.sign,'Original legacy fields are preserved');
for (const key of ['image','calibration','measurements','ruler','target_polygon_px','generation','custom_root']) assert.deepEqual(migrated[key],legacy[key]);
assert.deepEqual(migrated.products[0].params.custom_sign,legacy.sign.custom_sign);
assert.equal(migrated.products[0].placement.custom_placement,true);
assert.deepEqual(migrated.products[0].params.face_material,{type:'custom'},'Migration must not replace unspecified custom materials with ORACAL');
const withLegacyMaterial={...clone(legacy),sign:{text:'ТЕКСТ',material:'Акрил',lighting:'Контражур',font_family:'x'.repeat(200),brief:'Исходное ТЗ'}};
const oldMaterial=Products.activeProduct(withLegacyMaterial);
assert.equal(oldMaterial.params.material,'Акрил'); assert.equal(oldMaterial.params.lighting,'Контражур');
assert.deepEqual(oldMaterial.params.face_material,{type:'custom'}); Products.validateProduct(oldMaterial);
assert.equal(Products.activeProduct({...clone(legacy),sign:{}}).params.text,'','Migration cannot invent text in a calibration-only project');
const sparseLetters={...clone(migrated),products:[{...clone(migrated.products[0]),params:{brief:'Проект без выбранной конструкции'}}]};
const sparseProduct=Products.activeProduct(sparseLetters);
assert.deepEqual(sparseProduct.params.face_material,{type:'custom'});
assert.equal(sparseProduct.params.text,'','A sparse saved v2 snapshot also cannot invent preset text');
const withFilm={...clone(legacy),sign:{...legacy.sign,face_material:{type:'film_on_acrylic',day_lighting:'on',series:'8500',color_code:'custom'}}};
assert.deepEqual(Products.activeProduct(withFilm).params.face_material,withFilm.sign.face_material,'An explicit structured material must remain intact');
assert.notEqual(migrated.products[0].placement,legacy.placement);
assert.deepEqual(Products.normalizeProject(migrated),migrated,'Migration is idempotent');
const canonical=clone(migrated);
canonical.products[0].params.text='КАНОНИЧЕСКИЙ'; canonical.products[0].placement.width_cm=100;
assert.equal(Products.legacyProject(canonical).sign.text,'КАНОНИЧЕСКИЙ');
assert.equal(Products.legacyProject(canonical).placement.width_cm,100);
assert.equal(canonical.sign.text,'СТАРЫЙ МАКЕТ','A stale compatibility mirror cannot override canonical values');
assert.deepEqual(Products.legacyProject(legacy),legacy);
assert.equal(Products.summary(canonical).text,'КАНОНИЧЕСКИЙ');
assert.equal(Products.capabilities(canonical).corel,true);
for (const version of [0,3,'2',null,undefined]) assert.throws(()=>Products.normalizeProject({...legacy,version}),/версии/);
for (const products of [null,[],[canonical.products[0],clone(canonical.products[0])]]) assert.throws(()=>Products.normalizeProject({...canonical,products}),/одно изделие/);
assert.throws(()=>Products.normalizeProject({...canonical,active_product_id:'missing'}),/Активное/);
const unknown={...canonical.products[0],type:'future-module'};delete unknown.renderer_family;delete unknown.renderer_version;
assert.throws(()=>Products.normalizeProject({...canonical,products:[unknown]}),/семейство|не соответствует/);
assert.throws(()=>Products.normalizeProject({...canonical,products:[{...canonical.products[0],module_version:2}]}),/версия/);
for (const template_version of [0,-1,1.5,'1',null,1000001]) assert.throws(()=>Products.normalizeProject({...canonical,products:[{...canonical.products[0],template_version}]}),/Версия/);
const futurePreset={...clone(canonical),products:[{...clone(canonical.products[0]),template_id:'custom-template',template_version:2}]};
assert.deepEqual(Products.normalizeProject(futurePreset).products[0].params,canonical.products[0].params,'Future template revisions retain authoritative parameter snapshots');
assert.throws(()=>Products.normalizeProject({...canonical,products:[{...canonical.products[0],id:'../../escape'}]}),/идентификатор/);

assert.deepEqual(Products.list().map(item=>item.type),['channel_letters','plaque','neon','flat_print','lightbox','cutout']);
assert.equal(Object.isFrozen(Products.descriptor('plaque').defaults),true);
assert.throws(()=>{Products.descriptor('plaque').defaults.material='changed';},TypeError);
for (const spec of Products.list()) {
  const presets=Products.templates(spec.type);
  assert.ok(presets.length>=1);
  for (const preset of presets) {
    const product=Products.createProduct(spec.type,preset.id);
    assert.equal(product.placement,null);
    assert.equal(product.module_version,1); assert.equal(product.template_version,1);
    assert.ok(preset.default_placement.width_cm>0 && preset.default_placement.height_cm>0);
    Products.validateProduct(product);
    assert.deepEqual(Products.capabilities(product).corel,spec.type==='channel_letters');
    assert.deepEqual(Products.capabilities(product).composite,spec.type!=='channel_letters');
  }
}
const separate=Products.createProduct('plaque'); separate.params.material='metal';
assert.equal(Products.createProduct('plaque').params.material,'pvc','Preset edits cannot mutate catalog defaults');
assert.throws(()=>Products.createProduct('plaque','neon-text-pink'),/Шаблон/);
const blank=Products.createProduct('neon'); blank.params.text='';
Products.validateProduct(blank);
assert.throws(()=>Products.validateProduct(blank,{requireContent:true}),/текст/);

// A real one-pixel PNG keeps the fixture small; arbitrary SVG/URLs cannot reach
// projected SVG through the exact-artwork channel.
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMfoAAAAASUVORK5CYII=';
const artwork={name:'original.png',mime_type:'image/png',data_url:'data:image/png;base64,'+png,width_px:1,height_px:1,source:'uploaded'};
assert.equal(Products.artworkInfo(artwork).size_bytes,Buffer.from(png,'base64').length);
Products.validateProduct({...blank,artwork},{requireContent:true});
for (const change of [{mime_type:'image/svg+xml'},{data_url:'javascript:alert(1)'},{data_url:'data:image/svg+xml;base64,'+png},{width_px:2},{height_px:0},{source:'svg'},{data_url:'data:image/png;base64,broken'}]) {
  assert.throws(()=>Products.artworkInfo({...artwork,...change}));
}
const oversized = {...artwork,data_url:'data:image/png;base64,'+Buffer.alloc(2*1024*1024+1).toString('base64')};
assert.throws(()=>Products.artworkInfo(oversized),/2 МиБ/);
for (const change of [{material:'wood'},{mounting:'adhesive-free'},{front_color:'red'},{background_color:'url(evil)'},{thickness_mm:0},{corner_radius_mm:-1},{margin_mm:NaN}]) {
  const product=Products.createProduct('plaque'); Object.assign(product.params,change); assert.throws(()=>Products.validateProduct(product));
}
for (const change of [{backing:'glass'},{illumination:'night-only'},{tubing_mm:0},{backing_margin_mm:-1}]) {
  const product=Products.createProduct('neon'); Object.assign(product.params,change); assert.throws(()=>Products.validateProduct(product));
}
const plaque=Products.createProduct('plaque'); plaque.placement={center_px:[800,400],width_cm:40,height_cm:30,rotation_deg:0};
plaque.artwork=artwork; plaque.params.text='';
const plaqueProject={...clone(migrated),products:[plaque],active_product_id:plaque.id,product_drafts:{channel_letters:clone(migrated.products[0])}};
assert.deepEqual(Products.normalizeProject(plaqueProject).product_drafts,plaqueProject.product_drafts);
const plaqueBefore=JSON.stringify(plaqueProject), report=G.analyze(plaqueProject);
assert.equal(JSON.stringify(plaqueProject),plaqueBefore);
assert.equal(report.version,2); assert.equal(report.product.type,'plaque'); assert.equal(report.product.has_artwork,true);
assert.equal(report.capabilities.corel,false); assert.equal(report.ruler.total_cm,100);
assert.equal(report.sign_layout,null,'Exact artwork prevents stale text metrics from re-typesetting content');
assert.ok(!JSON.stringify(report).includes(png),'Report contains metadata, never duplicate raster payload');
const plaqueSvg=G.overlaySvg(plaqueProject,report);
assert.ok(plaqueSvg.includes('id="signage-exact-artwork"'));
assert.ok(plaqueSvg.includes('preserveAspectRatio="xMidYMid meet"'));
assert.ok(plaqueSvg.includes('x="6.5" y="1.5" width="27" height="27"'),'Artwork is uniformly contained inside physical margins, not stretched');
assert.ok(plaqueSvg.includes('width="40" height="30" rx="0" fill="#ffffff"'));
assert.ok(!G.overlaySvg(plaqueProject,report,'',{includeText:false}).includes('signage-exact-artwork'));
assert.ok(G.productPreviewSvg(plaqueProject,report).includes('data:image/png;base64,'+png));
assert.deepEqual(report.placement.polygon_px,[[720,340],[880,340],[880,460],[720,460]],'Canonical plaque dimensions override stale letters mirror');
assert.throws(()=>G.analyze({...plaqueProject,products:[{...plaque,params:{...plaque.params,margin_mm:150}}]}),/габарит/);
const neon=Products.createProduct('neon'); neon.params.text=''; neon.artwork=artwork; neon.placement={center_px:[800,400],width_cm:100,height_cm:35};
const neonProject={...plaqueProject,products:[neon],active_product_id:neon.id};
assert.equal(G.analyze(neonProject).product.type,'neon');
assert.ok(G.productPreviewSvg(neonProject).includes('fill-opacity=".13"'));
assert.ok(G.productPreviewSvg(neonProject).includes('id="signage-neon-artwork-glow"'));
assert.ok(G.productPreviewSvg(neonProject).includes('in="SourceGraphic"'),'Uploaded multicolour artwork supplies its own glow hues');
assert.ok(!G.productPreviewSvg(neonProject).includes('<feFlood'),'The selected text colour cannot recolour an uploaded original halo');
assert.ok(!G.productPreviewSvg({...neonProject,products:[{...neon,params:{...neon.params,illumination:'off'}}]}).includes('id="signage-neon-artwork-glow"'));
assert.throws(()=>G.analyze({...neonProject,products:[{...neon,params:{...neon.params,backing_margin_mm:175}}]}),/габарит/);
const transform=[2,.18,220,.12,1.6,100,.0008,.0003,1];
const world=[[0,0],[400,0],[400,200],[0,200]], pixels=world.map(point=>G.apply(transform,point));
const perspectivePlaque=clone(plaqueProject);
perspectivePlaque.calibration={mode:'rectangle',width_cm:400,height_cm:200,image_points:pixels};
perspectivePlaque.target_polygon_px=null; perspectivePlaque.ruler=null;
perspectivePlaque.products[0].placement.center_px=G.apply(transform,[200,100]);
const perspectiveReport=G.analyze(perspectivePlaque), perspectivePreview=G.productPreviewSvg(perspectivePlaque,perspectiveReport);
assert.ok(perspectivePreview.includes('id="signage-product-art"'));
assert.ok((perspectivePreview.match(/<clipPath /g)||[]).length>2);
assert.equal((perspectivePreview.match(/data:image\/png;base64,/g)||[]).length,1,'Perspective mesh references one stored raster, never duplicates its payload per triangle');
assert.equal(perspectiveReport.sign_layout,null);
const plaqueText=Products.createProduct('plaque','plaque-basic');
plaqueText.placement={center_px:[800,400],width_cm:40,height_cm:30};
plaqueText.params={...plaqueText.params,text:'ТЕКСТ',preview_line_metrics:{font_size_px:100,font_family:'Arial',font_weight:700,
  lines:[{text:'ТЕКСТ',width:250,actualBoundingBoxAscent:70,actualBoundingBoxDescent:10,actualBoundingBoxLeft:0,actualBoundingBoxRight:250}]}};
const plaqueTextReport=G.analyze({...plaqueProject,products:[plaqueText],active_product_id:plaqueText.id});
assert.equal(plaqueTextReport.sign_layout.width_cm,40);
assert.equal(plaqueTextReport.sign_layout.height_cm,30);
assert.ok(plaqueTextReport.sign_layout.lines.every(line=>line.bounds_cm.every(([x,y])=>x>=1.5&&x<=38.5&&y>=1.5&&y<=28.5)),'Text fallback uses the same physical margins as saved artwork');

// Browser UMD and Node share the same migration and calculation contract.
const browser={console,SignageCatalog:clone(require('../assets/product-catalog.json'))}; vm.createContext(browser);
for (const script of ['products.js','geometry.js']) vm.runInContext(fs.readFileSync(path.join(__dirname,'../assets',script),'utf8'),browser,{filename:script});
assert.equal(browser.SignageProducts.summary(plaqueProject).type,'plaque');
assert.deepEqual(clone(browser.LetterGeometry.analyze(plaqueProject)),report);

// A new product construction using an installed renderer is data, not a core
// edit. Old snapshots remain independent from catalogue defaults and labels.
const extensionData=clone(require('../assets/product-catalog.json'));
extensionData.modules.push({type:'custom_banner',label:'Баннер по ТЗ',module_version:1,renderer_family:'flat_print',renderer_version:1,default_template_id:'custom-banner-one',defaults:{opacity:.8},fields:['text','opacity','material','margin_mm'],field_schema:[{key:'edge_note',label:'Обработка края','kind':'string',max_length:160,default:''}]});
extensionData.templates.push({id:'custom-banner-one',type:'custom_banner',version:1,label:'Новый баннер',category:'Печать',description:'Макет пользователя',default_placement:{width_cm:150,height_cm:60,rotation_deg:0},params:{material:'Баннер',edge_note:'Подгиб'}});
const Extended=Products.createRegistry(extensionData),custom=Extended.createProduct('custom_banner');
custom.placement={center_px:[300,300],width_cm:150,height_cm:60,rotation_deg:0};
assert.equal(Extended.renderer(custom),'flat_print');assert.equal(Extended.displayLabel(custom),'Новый баннер');
assert.equal(Extended.capabilities(custom).ai,false);assert.equal(Extended.capabilities(custom).corel,false);
assert.equal(Extended.parameterFields(custom).find(f=>f.key==='edge_note').label,'Обработка края');
Extended.validateProduct(custom);assert.equal(custom.params.opacity,.8);assert.equal(custom.params.edge_note,'Подгиб');
const savedCustom=clone(custom),changedData=clone(extensionData);
changedData.modules.find(m=>m.type==='custom_banner').defaults.opacity=.2;
changedData.templates.find(t=>t.id==='custom-banner-one').label='Переименованный';
changedData.templates.find(t=>t.id==='custom-banner-one').params.edge_note='Да';
changedData.modules.find(m=>m.type==='custom_banner').field_schema[0].max_length=2;
const Changed=Products.createRegistry(changedData);
assert.deepEqual(Changed.activeProduct({version:2,products:[savedCustom],active_product_id:savedCustom.id}).params,savedCustom.params);
assert.equal(Changed.displayLabel(savedCustom),'Новый баннер');
Changed.validateProduct(savedCustom);
const retired=clone(extensionData);retired.modules=retired.modules.filter(m=>m.type!=='custom_banner');retired.templates=retired.templates.filter(t=>t.type!=='custom_banner');
const Retired=Products.createRegistry(retired);
assert.equal(Retired.activeProduct({version:2,products:[savedCustom],active_product_id:savedCustom.id}).params.edge_note,'Подгиб');
assert.equal(Retired.renderer(savedCustom),'flat_print');
assert.equal(Retired.parameterFields(savedCustom).find(f=>f.key==='edge_note').max_length,160);
const remapped=clone(extensionData);remapped.modules.find(m=>m.type==='custom_banner').renderer_family='neon';
remapped.modules.find(m=>m.type==='custom_banner').defaults={};remapped.templates.find(t=>t.id==='custom-banner-one').params={};
assert.equal(Products.createRegistry(remapped).renderer(savedCustom),'flat_print','A coherent saved binding is not reinterpreted by catalogue remapping');
assert.throws(()=>Extended.validateProduct({...savedCustom,renderer_family:'neon'}),/не соответствует/);
assert.throws(()=>Extended.validateProduct({...savedCustom,renderer_version:99}),/не соответствует|версия/);
assert.throws(()=>Extended.validateProduct({...savedCustom,params:{...savedCustom.params,opacity:2}}),/Непрозрачность/);
const malicious=clone(extensionData);malicious.modules.at(-1).field_schema[0].key='__proto__';
assert.throws(()=>Products.createRegistry(malicious),/поле/);
const duplicate=clone(extensionData);duplicate.templates.push(clone(duplicate.templates[0]));
assert.throws(()=>Products.createRegistry(duplicate),/шаблон/);
for(const renderer_family of ['',0,null])assert.throws(()=>Products.validateProduct({...Products.createProduct('plaque'),renderer_family}),/семейство|Семейство|не соответствует/);
for(const change of [{renderer_family:'neon'},{renderer_version:99},{module_version:99}]){
  const p=Products.createProduct('plaque');Object.assign(p.module_snapshot,change);assert.throws(()=>Products.validateProduct(p),/не соответствует/);
}
for(const brokenPolicy of [{artwork_policy:'upload_required_typo'},{requires_uploaded_artwork:'true'}]){
  const bad=clone(extensionData);Object.assign(bad.templates[0],brokenPolicy);assert.throws(()=>Products.createRegistry(bad),/правило|Требование/);
}
const newDefault=clone(extensionData);newDefault.modules.at(-1).field_schema.push({key:'edge_cm',label:'Поле края, см',kind:'number',min:0,max:10,default:4});
assert.equal(Products.createRegistry(newDefault).createProduct('custom_banner').params.edge_cm,4);
const changedLetters=clone(extensionData);changedLetters.modules.find(m=>m.type==='channel_letters').defaults.depth_cm=99;
changedLetters.templates.find(t=>t.id==='letters-standard').params.depth_cm=87;
const Independent=Products.createRegistry(changedLetters);
assert.equal(Independent.activeProduct({...clone(legacy),sign:{text:'Прежний проект'}}).params.depth_cm,5,'v1 imports use pinned family defaults, never mutable presets');
const cutout=Products.createProduct('cutout');cutout.params.text='Это не заменяет исходное изображение';
assert.throws(()=>Products.validateProduct(cutout,{requireContent:true}),/PNG/);
const qr=Products.createProduct('plaque','assortment-05-12');qr.params.text='Надпись не является QR-кодом';
assert.equal(Products.capabilities(qr).require_uploaded,true);
assert.throws(()=>Products.validateProduct(qr,{requireContent:true}),/оригинальный PNG/);
Products.validateProduct({...qr,artwork},{requireContent:true});
assert.equal(Products.capabilities(Products.createProduct('plaque','plaque-basic')).require_uploaded,false);
assert.equal(Products.effectPadding({...custom,params:{...custom.params,opacity:.5}},[[0,0],[300,0],[280,100],[0,100]]),0);
console.log('PASS: declarative new module/fields, immutable saved catalogue identity/parameters, retired definitions, authoritative renderer/capabilities, unknown versions, malicious field keys, upload-only object mode.');
console.log('PASS: versioned product modules and immutable presets, non-mutating v1 migration/canonical v2 precedence, unknown-field/draft preservation, explicit single-product rejection, content and PNG validation, product capabilities, exact artwork perspective preview/report isolation, shared browser/Node geometry.');
