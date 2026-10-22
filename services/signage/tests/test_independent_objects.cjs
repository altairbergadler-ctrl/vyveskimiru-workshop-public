'use strict';
const assert = require('node:assert/strict');
const G = require('../assets/geometry.js');
const P = require('../assets/products.js');
const copy = value => JSON.parse(JSON.stringify(value));
const close = (a,b) => assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
const metric = (text,width,height=80,font='Arial',bold=true) => ({text,width,
  actualBoundingBoxLeft:4,actualBoundingBoxRight:width-4,
  actualBoundingBoxAscent:height-10,actualBoundingBoxDescent:10,
  font_family:font,font_weight:bold?700:400});
const saved = lines => ({font_size_px:100,lines});
const text = (id,changes={}) => ({id,type:'text',text:'ПЕРВАЯ\nвторая',font_family:'Arial',font_bold:true,
  letter_height_cm:20,line_gap_cm:3,text_align:'left',front_color:'#ABC123',x_cm:10,y_cm:10,rotation_deg:0,
  preview_line_metrics:saved([metric('ПЕРВАЯ',400,80),metric('вторая',160,60)]),...changes});
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMfoAAAAASUVORK5CYII=';
const artwork = {name:'logo.png',mime_type:'image/png',source:'uploaded',width_px:1,height_px:1,data_url:'data:image/png;base64,'+png};
const logo = (id,changes={}) => ({id,type:'logo',artwork,width_cm:20,x_cm:150,y_cm:20,rotation_deg:0,...changes});
const envelope = {width_cm:300,height_cm:100};

// A common font size follows the tallest visible ink line. Other glyph heights
// and inner blank rows retain their natural proportions; gaps stay physical.
const first = text('first'), firstLayout = G.independentObjectLayout(first);
close(firstLayout.font_size_cm,25);close(firstLayout.width_cm,100);close(firstLayout.height_cm,38);
close(firstLayout.lines[0].height_cm,20);close(firstLayout.lines[1].height_cm,15);
close(firstLayout.lines[1].y_cm,23);close(firstLayout.lines[0].x_cm,1);
assert.deepEqual(firstLayout.local_bounds_cm,[[0,0],[100,0],[100,38],[0,38]]);
assert.deepEqual(firstLayout.bounds_cm,[[10,10],[110,10],[110,48],[10,48]]);
const productionLayout = G.independentObjectLayout({...first,depth_cm:7,side_color:'#102030',brief:'Место крепления проверить'});
for (const key of ['width_cm','height_cm','font_size_cm','bounds_cm']) assert.deepEqual(productionLayout[key],firstLayout[key]);
assert.equal(productionLayout.depth_cm,7);assert.equal(productionLayout.side_color,'#102030');assert.equal(productionLayout.brief,'Место крепления проверить');
const blank = text('blank',{text:'A\n\nB',letter_height_cm:12,line_gap_cm:2,
  preview_line_metrics:saved([metric('A',200,80),{...metric('',0,0),actualBoundingBoxAscent:0,actualBoundingBoxDescent:0},metric('B',100,40)])});
const blankLayout = G.independentObjectLayout(blank);
close(blankLayout.height_cm,34);close(blankLayout.lines[1].height_cm,12);
assert.equal(blankLayout.lines[1].blank,true);
assert.equal((G.localCompositionSvg({objects:[blankLayout]}).match(/<tspan /g)||[]).length,2);
for (const [align,left] of [['left',0],['center',30],['right',60]]) {
  const row = G.independentObjectLayout(text('aligned',{text_align:align})).lines[1];
  close(row.bounds_cm[0][0],left);
}

// Moving, resizing, retyping or rotating any one object leaves every other
// object's location and physical size exactly unchanged. Overlap is allowed.
const objects = [first,text('second',{x_cm:150,y_cm:55,letter_height_cm:10}),logo('logo')];
const scene = G.objectsLayout({objects},envelope);
assert.deepEqual(G.textLayout({objects},envelope),scene);
const moved = copy(objects);Object.assign(moved[2],{x_cm:10,y_cm:10,width_cm:40,rotation_deg:20});
const afterLogo = G.objectsLayout({objects:moved},envelope);
assert.deepEqual(afterLogo.objects.slice(0,2),scene.objects.slice(0,2));
const retyped = copy(objects);Object.assign(retyped[0],{text:'Ж',letter_height_cm:40,font_family:'Georgia',font_bold:false,
  preview_line_metrics:saved([metric('Ж',90,75,'Georgia',false)])});
const afterText = G.objectsLayout({objects:retyped},envelope);
assert.deepEqual(afterText.objects.slice(1),scene.objects.slice(1));
const overlap = G.objectsLayout({objects:[logo('a',{x_cm:10,y_cm:10}),logo('b',{x_cm:10,y_cm:10})]},envelope);
assert.deepEqual(overlap.objects[0].bounds_cm,overlap.objects[1].bounds_cm);
assert.deepEqual(G.objectsLayout({objects:[]},envelope).objects,[]);
assert.deepEqual(G.textLayout({objects:[],text:'OUTDATED',logo:{invalid:true}},envelope).objects,[]);

// Logo height comes solely from its PNG ratio; rotation is around its own
// center, and containment uses the rotated rectangle rather than x/y alone.
const header = Buffer.from(png,'base64');header.writeUInt32BE(2,16);
const rectangularArtwork = {...artwork,width_px:2,data_url:'data:image/png;base64,'+header.toString('base64')};
const rotated = G.independentObjectLayout(logo('rotated',{artwork:rectangularArtwork,width_cm:40,x_cm:20,y_cm:10,rotation_deg:90}));
close(rotated.height_cm,20);
rotated.bounds_cm.forEach((p,i)=>[ [50,0],[50,40],[30,40],[30,0] ][i].forEach((v,k)=>close(p[k],v)));
assert.ok(G.objectsLayout({objects:[logo('fits',{artwork:rectangularArtwork,width_cm:40,x_cm:-5,y_cm:10,rotation_deg:90})]},envelope));
assert.throws(()=>G.objectsLayout({objects:[logo('outside',{artwork:rectangularArtwork,width_cm:40,x_cm:20,y_cm:0,rotation_deg:90})]},envelope),/не помещается/);
assert.throws(()=>G.objectsLayout({objects:[text('wide',{letter_height_cm:70})]},envelope),/не помещается/);
assert.throws(()=>G.objectsLayout({objects:[text('tall',{letter_height_cm:60})]},envelope),/не помещается/);

// Malformed or stale saved text measurements cannot silently give a plausible
// report/export. Validating objects also runs for empty and logo-only scenes.
for (const changes of [{id:''},{id:null},{type:'unknown'},{x_cm:'10'},{y_cm:NaN},{rotation_deg:'0'},{rotation_deg:null},
  {text:''},{text:'\n  \n'},{text:null},{font_family:''},{font_family:null},{font_bold:'true'},
  {letter_height_cm:0},{letter_height_cm:-1},{letter_height_cm:'20'},{line_gap_cm:-1},{line_gap_cm:'3'},{line_gap_cm:null},
  {text_align:'justify'},{text_align:null},{front_color:'#123'},{front_color:'red'},
  {depth_cm:-1},{depth_cm:'7'},{depth_cm:NaN},{side_color:'#123'},{side_color:null},{brief:null},{brief:'x'.repeat(4001)},
  {preview_line_metrics:undefined},
  {preview_line_metrics:{font_size_px:50,lines:first.preview_line_metrics.lines}},
  {preview_line_metrics:saved([metric('OUTDATED',400),metric('вторая',160,60)])},
  {preview_line_metrics:saved([metric('ПЕРВАЯ',400,80,'Georgia'),metric('вторая',160,60)])},
  {preview_line_metrics:saved([metric('ПЕРВАЯ',400,80,'Arial',false),metric('вторая',160,60)])},
  {preview_line_metrics:saved([{...metric('ПЕРВАЯ',400),actualBoundingBoxAscent:NaN},metric('вторая',160,60)])},
  {preview_line_metrics:saved([metric('ПЕРВАЯ',0,0),metric('вторая',160,60)])},
]) assert.throws(()=>G.independentObjectLayout({...first,...changes}));
for (const changes of [{width_cm:0},{width_cm:'20'},{artwork:{...artwork,data_url:'javascript:alert(1)'}},{artwork:{...artwork,width_px:2}}]) {
  assert.throws(()=>G.independentObjectLayout(logo('bad',changes)));
}
for (const value of [undefined,null,{},'objects']) assert.throws(()=>G.objectsLayout({objects:value},envelope));
assert.throws(()=>G.objectsLayout({objects:Array.from({length:21},(_,i)=>logo('logo-'+i))},envelope),/20/);
assert.throws(()=>G.objectsLayout({objects:[first,{...first}]},envelope),/уникальными/);
assert.throws(()=>G.objectsLayout({objects:[null]},envelope));
assert.throws(()=>G.objectsLayout({objects:[]},{width_cm:0,height_cm:100}));
const measured = G.independentObjectLayout({...first,preview_line_metrics:undefined},(s,i)=>first.preview_line_metrics.lines[i]);
assert.deepEqual(measured,firstLayout);

// SVG carries one group per object and unique logo IDs. Object-local glyph
// baselines and original artwork remain inside their respective transforms.
const specialId = 'a"<&', special = text(specialId,{font_family:'Missing, Font',
  preview_line_metrics:saved([metric('ПЕРВАЯ',400,80,'Missing, Font'),metric('вторая',160,60,'Missing, Font')])});
const exportLayout = G.objectsLayout({objects:[special,logo('one'),logo('two',{x_cm:200,y_cm:60})]},envelope);
const localSvg = G.localCompositionSvg(exportLayout,'#000000');
assert.ok(localSvg.includes('data-object-id="a&quot;&lt;&amp;"'));
assert.ok(localSvg.includes('font-family="&quot;Missing, Font&quot;, Arial, sans-serif"'));
assert.ok(localSvg.includes('fill="#ABC123"'));
assert.ok(localSvg.includes('translate(10 10) rotate(0 50 19)'));
const imageIds = [...localSvg.matchAll(/<image id="([^"]+)"/g)].map(m=>m[1]);
assert.equal(imageIds.length,2);assert.equal(new Set(imageIds).size,2);
assert.equal((localSvg.match(/data:image\/png;base64,/g)||[]).length,2);

// Perspective adds the whole composition placement on top of each object's
// own rotation. Both v1 and canonical v2 exports preserve all objects and data.
const H = [2,.18,220,.12,1.6,100,.0008,.0003,1];
const project = {version:1,image:{name:'test.png',width_px:1600,height_px:1000},
  calibration:{mode:'rectangle',width_cm:400,height_cm:200,image_points:[[0,0],[400,0],[400,200],[0,200]].map(p=>G.apply(H,p))},
  placement:{center_px:G.apply(H,[200,100]),width_cm:300,height_cm:100,rotation_deg:17},
  sign:{text:'OLD',font_family:'Arial',font_bold:true,line_gap_cm:3,text_align:'left',front_color:'#ABC123',
    objects:[text('a',{rotation_deg:7}),logo('b',{rotation_deg:30}),logo('c',{x_cm:250,y_cm:60})]},measurements:[],checks:[]};
const before = JSON.stringify(project), report = G.analyze(project);
assert.equal(JSON.stringify(project),before);
assert.equal(report.sign_layout.objects.length,3);
for (const object of report.sign_layout.objects) {
  assert.equal(object.polygon_px.length,4);
  object.polygon_px.forEach((point,i)=>G.apply(G.inverse(report.sign_layout.local_to_image),point).forEach((value,k)=>close(value,object.bounds_cm[i][k])));
  if (object.lines) object.lines.forEach(line=>line.polygon_px.forEach((point,i)=>G.apply(G.inverse(report.sign_layout.local_to_image),point).forEach((value,k)=>close(value,line.composition_bounds_cm[i][k]))));
}
const svg = G.overlaySvg(project,report);
for (const id of ['a','b','c']) assert.ok(svg.includes(`data-object-id="${id}"`));
assert.ok(svg.includes(artwork.data_url));assert.ok(svg.includes('signage-text-clip'));
assert.ok(!G.overlaySvg(project,report,'',{includeText:false}).includes('data-object-id'));
const v2 = P.normalizeProject(project), canonicalBefore = JSON.stringify(v2), v2Report = G.analyze(v2);
assert.equal(JSON.stringify(v2),canonicalBefore);assert.deepEqual(v2Report.sign_layout,report.sign_layout);
assert.ok(G.productPreviewSvg(v2,v2Report).includes('data-object-id="c"'));
const logoOnly = {...project,sign:{...project.sign,text:'',objects:[logo('only')]}};
assert.equal(G.analyze(logoOnly).sign_layout.objects[0].type,'logo');
assert.ok(G.overlaySvg(logoOnly).includes('data-object-id="only"'));
const empty = {...project,sign:{...project.sign,objects:[]}};
assert.deepEqual(G.analyze(empty).sign_layout.objects,[]);
assert.ok(!G.overlaySvg(empty).includes('data-object-id'));
assert.throws(()=>G.overlaySvg({...project,sign:{...project.sign,objects:[text('empty',{text:''})]}}),/Введите текст/);
const mixedArtwork = copy(v2);mixedArtwork.products[0].artwork=artwork;
assert.throws(()=>G.analyze(mixedArtwork),/общий оригинал/);
delete mixedArtwork.products[0].params.objects;
assert.equal(G.analyze(mixedArtwork).sign_layout,null,'Historical whole-product original still works without objects');
const plaque = P.createProduct('plaque');plaque.placement=copy(project.placement);plaque.params.objects=[];
assert.throws(()=>G.analyze({...v2,products:[plaque],active_product_id:plaque.id}),/только для объёмных букв/);
const customModule = copy(v2);customModule.products[0].type='saved-custom-letter-module';
assert.deepEqual(G.analyze(customModule).sign_layout,v2Report.sign_layout,'Saved modules sharing the letter renderer retain composition support');

// While editing the second text, it can become wider than the composition or
// temporarily empty. The editing preview must keep the first text visible at
// exactly the same size and position, while strict report/export still refuse
// the incomplete scene. Nothing may silently resize or rewrite saved objects.
const editingObjects = [first,text('outside',{x_cm:400,y_cm:55,letter_height_cm:10}),text('unfinished',{text:''})];
const editingBefore = JSON.stringify(editingObjects);
const editingLayout = G.objectsLayout({objects:editingObjects},envelope,undefined,{preview:true});
assert.equal(JSON.stringify(editingObjects),editingBefore);
assert.equal(editingLayout.preview,true);
assert.deepEqual(editingLayout.objects[0],firstLayout);
assert.deepEqual(editingLayout.objects.map(object=>object.id),['first','outside']);
assert.equal(editingLayout.objects[1].fits_composition,false);
assert.deepEqual(editingLayout.objects[1].bounds_cm,G.independentObjectLayout(editingObjects[1]).bounds_cm);
assert.ok(editingLayout.warnings.some(message=>/Объект 2.*не помещается/.test(message)));
assert.ok(editingLayout.warnings.some(message=>/Объект 3.*Введите текст/.test(message)));
for(const options of [undefined,{}, {preview:false},{preview:'true'}]) {
  assert.throws(()=>G.objectsLayout({objects:editingObjects},envelope,undefined,options),/не помещается/);
}
for(const changes of [{text:''},{letter_height_cm:'invalid'},{font_family:''},{x_cm:NaN},
  {preview_line_metrics:saved([metric('OUTDATED',400),metric('вторая',160,60)])}]) {
  const scene = {objects:[first,text('editing',changes),logo('kept-logo')]};
  const preview = G.objectsLayout(scene,envelope,undefined,{preview:true});
  assert.deepEqual(preview.objects.map(object=>object.id),['first','kept-logo']);
  assert.deepEqual(preview.objects[0],firstLayout);
  assert.equal(preview.warnings.length,1);
  assert.ok(preview.warnings[0].startsWith('Объект 2 временно не показан:'));
  assert.throws(()=>G.objectsLayout(scene,envelope));
}

// Omitting unfinished text must not conceal broken scene structure, duplicate
// IDs (even when both copies are empty), unsupported objects or invalid logos.
for(const objects of [[null],[text('')],[first,text('first',{text:''})],
  [text('same',{text:''}),text('same',{text:''})],[{...first,type:'unknown'}],
  [logo('bad',{artwork:{...artwork,data_url:'javascript:alert(1)'}})],
  Array.from({length:21},(_,index)=>text('many-'+index,{text:''}))]) {
  assert.throws(()=>G.objectsLayout({objects},envelope,undefined,{preview:true}));
}
assert.throws(()=>G.objectsLayout({objects:null},envelope,undefined,{preview:true}));
assert.throws(()=>G.objectsLayout({objects:[]},{width_cm:0,height_cm:100},undefined,{preview:true}));

const editingProject = {...project,sign:{...project.sign,objects:editingObjects}};
const editingProjectBefore = JSON.stringify(editingProject);
const strictFirst = G.analyze({...editingProject,sign:{...editingProject.sign,objects:[first]}});
const editingReport = G.analyze(editingProject,{preview:true});
assert.equal(JSON.stringify(editingProject),editingProjectBefore);
assert.equal(editingReport.preview,true);
assert.deepEqual(editingReport.calibration,strictFirst.calibration);
assert.deepEqual(editingReport.placement,strictFirst.placement);
assert.deepEqual(editingReport.sign_layout.objects[0],strictFirst.sign_layout.objects[0]);
assert.equal(editingReport.sign_layout.objects[1].polygon_px.length,4);
assert.ok(editingReport.sign_layout.warnings.every(message=>editingReport.warnings.includes(message)));
assert.ok(G.localCompositionSvg(editingReport.sign_layout).includes('data-object-id="outside"'));
assert.throws(()=>G.analyze(editingProject),/не помещается/);
assert.throws(()=>G.overlaySvg(editingProject),/не помещается/);
assert.throws(()=>G.productPreviewSvg(editingProject),/не помещается/);
const canonicalEditing = P.normalizeProject(editingProject), canonicalEditingBefore = JSON.stringify(canonicalEditing);
assert.deepEqual(G.analyze(canonicalEditing,{preview:true}).sign_layout,editingReport.sign_layout);
assert.equal(JSON.stringify(canonicalEditing),canonicalEditingBefore);
assert.throws(()=>G.analyze(canonicalEditing),/не помещается/);
for(const changes of [{image_points:[]},{image_points:[[0,0],[1,0],[1,1],[0,1]]},{width_cm:0}]) {
  assert.throws(()=>G.analyze({...editingProject,calibration:{...editingProject.calibration,...changes}},{preview:true}));
}
const corrected = copy(editingProject);
corrected.sign.objects[1].x_cm=150;
corrected.sign.objects[2]=text('unfinished',{x_cm:10,y_cm:55,letter_height_cm:10});
const correctedReport = G.analyze(corrected);
assert.equal(correctedReport.preview,undefined);
assert.equal(correctedReport.sign_layout.warnings,undefined);
assert.deepEqual(correctedReport.sign_layout.objects.map(object=>object.id),['first','outside','unfinished']);
assert.ok(G.overlaySvg(corrected).includes('data-object-id="unfinished"'));

console.log('PASS: independent text/logo objects, physical ink height and own font, natural multiline blocks and blank rows, per-object alignment/colour/rotation, overlap, rotated containment, zero/multiple objects, invalid and stale metrics rejection, unique SVG logo IDs, preserved v1/v2 perspective reports and exports; opt-in editing preview retains overflowing objects and unaffected neighbours with warnings, skips unfinished texts without weakening strict exports, IDs, logos, counts or calibration.');
