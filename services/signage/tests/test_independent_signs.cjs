'use strict';
const assert = require('node:assert/strict');
const G = require('../assets/geometry.js');
const P = require('../assets/products.js');
const copy = value => JSON.parse(JSON.stringify(value));
const close = (a,b,tolerance=1e-7) => assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);
const equalPoints = (a,b) => a.forEach((p,i)=>p.forEach((v,k)=>close(v,b[i][k])));
const metric = text => ({text,width:400,actualBoundingBoxLeft:4,actualBoundingBoxRight:396,
  actualBoundingBoxAscent:70,actualBoundingBoxDescent:10,font_family:'Arial',font_weight:700});
const text = (id,changes={}) => ({id,type:'text',text:'TEST',font_family:'Arial',font_bold:true,
  letter_height_cm:20,line_gap_cm:0,text_align:'left',front_color:'#ABC123',x_cm:120,y_cm:115,rotation_deg:0,
  preview_line_metrics:{font_size_px:100,lines:[metric('TEST')]},...changes});
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMfoAAAAASUVORK5CYII=';
const artwork = {name:'logo.png',mime_type:'image/png',source:'uploaded',width_px:1,height_px:1,data_url:'data:image/png;base64,'+png};
const logo = (id,changes={}) => ({id,type:'logo',artwork,width_cm:20,x_cm:600,y_cm:300,rotation_deg:0,...changes});
const frontal = {mode:'frontoparallel',frontoparallel_assumed:true,length_cm:100,image_points:[[20,20],[120,20]]};
const scene = objects => ({version:1,image:{name:'scene.jpg',width_px:1200,height_px:700},calibration:frontal,
  target_polygon_px:[[100,100],[900,100],[1100,500],[300,500]],placement:null,
  sign:{text:'',front_color:'#fff3dc',composition_mode:'independent_signs_v1',objects},measurements:[],checks:[]});

// Far-apart signs belong directly to the wall plane. Their technical union is
// not the installation boundary: both signs fit this slanted region although
// two corners of the derived union rectangle do not.
const project = scene([text('first'),text('second',{x_cm:960,y_cm:450}),logo('third')]);
const before = JSON.stringify(project), report = G.analyze(project);
assert.equal(JSON.stringify(project),before);
assert.equal(report.sign_layout.independent_signs,true);
assert.equal(report.sign_layout.composition_mode,'independent_signs_v1');
assert.equal(report.sign_layout.coordinate_space,'wall_plane');
assert.equal(report.placement.derived,true);
assert.equal(report.placement.fits_target,true);
assert.ok(report.placement.polygon_px.some(p=>!G.inside(p,project.target_polygon_px)));
assert.equal(report.sign_layout.objects.length,3);
for(const object of report.sign_layout.objects){
  assert.equal(object.fits_target,true);
  equalPoints(object.bounds_cm,object.world_bounds_cm);
  equalPoints(object.polygon_px.map(p=>G.apply(G.inverse(object.local_to_image),p)),object.local_bounds_cm);
  equalPoints(object.polygon_px.map(p=>G.apply(report.calibration.imageToWorld,p)),object.bounds_cm);
  if(object.lines)object.lines.forEach(line=>{
    equalPoints(line.polygon_px.map(p=>G.apply(G.inverse(object.local_to_image),p)),line.bounds_cm);
    equalPoints(line.polygon_px.map(p=>G.apply(report.calibration.imageToWorld,p)),line.world_bounds_cm);
  });
}
assert.ok(G.objectsLayout(project.sign,null).independent_signs);
assert.ok(G.textLayout(project.sign,null).independent_signs);

// No stale group center, dimensions or rotation can change a sign. Changing
// only one sign's position, size, font or rotation leaves the others intact.
const staleGroup = {...project,placement:{center_px:[-100,-100],width_cm:0,height_cm:0,rotation_deg:90}};
assert.deepEqual(G.analyze(staleGroup).sign_layout,report.sign_layout);
const moved = copy(project);Object.assign(moved.sign.objects[2],{x_cm:650,y_cm:280,width_cm:45,rotation_deg:25});
const movedReport = G.analyze(moved);
assert.deepEqual(movedReport.sign_layout.objects.slice(0,2),report.sign_layout.objects.slice(0,2));
const retyped = copy(project);Object.assign(retyped.sign.objects[1],{text:'A',letter_height_cm:10,
  preview_line_metrics:{font_size_px:100,lines:[{...metric('A'),width:80,actualBoundingBoxRight:76}]}});
const retypedReport = G.analyze(retyped);
assert.deepEqual(retypedReport.sign_layout.objects[0],report.sign_layout.objects[0]);
assert.deepEqual(retypedReport.sign_layout.objects[2],report.sign_layout.objects[2]);

// Strict export checks each actual rotated sign; editing keeps an overflowing
// sign visible and warns without altering its physical size or its neighbours.
const overflow = copy(project);Object.assign(overflow.sign.objects[2],{x_cm:1040,y_cm:440,width_cm:80,rotation_deg:30});
assert.throws(()=>G.analyze(overflow),/Вывеска 3.*область установки/);
const overflowPreview = G.analyze(overflow,{preview:true});
assert.equal(overflowPreview.placement.fits_target,false);
assert.equal(overflowPreview.sign_layout.objects[2].fits_target,false);
assert.deepEqual(overflowPreview.sign_layout.objects.slice(0,2),report.sign_layout.objects.slice(0,2));
assert.ok(overflowPreview.warnings.some(message=>/Вывеска 3.*область установки/.test(message)));
assert.ok(G.overlaySvg(overflow,overflowPreview).includes('stroke="#f87171"'));
assert.throws(()=>G.overlaySvg(overflow),/область установки/);
const unfinished = copy(project);unfinished.sign.objects.splice(1,0,text('unfinished',{text:''}));
assert.throws(()=>G.analyze(unfinished),/Введите текст/);
const unfinishedPreview = G.analyze(unfinished,{preview:true});
assert.deepEqual(unfinishedPreview.sign_layout.objects,report.sign_layout.objects);
assert.ok(unfinishedPreview.warnings.some(message=>/Объект 2 временно не показан/.test(message)));
const duplicate = copy(unfinished);duplicate.sign.objects[1].id='first';
assert.throws(()=>G.analyze(duplicate,{preview:true}),/уникальными/);
const invalidLogo = copy(project);invalidLogo.sign.objects[2].artwork.data_url='javascript:alert(1)';
assert.throws(()=>G.analyze(invalidLogo,{preview:true}),/PNG data URL/);

// In an unfinished layout without a target, the photo is the fallback bound.
// Empty scenes need no artificial group center or positive group dimensions.
const noTarget = {...project,target_polygon_px:null};
assert.equal(G.analyze(noTarget).placement.fits_target,true);
const outsidePhoto = copy(noTarget);outsidePhoto.sign.objects[0].x_cm=-10;
assert.throws(()=>G.analyze(outsidePhoto),/границы фотографии/);
assert.equal(G.analyze(outsidePhoto,{preview:true}).sign_layout.objects[0].fits_target,false);
const empty = scene([]), emptyReport = G.analyze(empty);
assert.equal(emptyReport.placement,null);
assert.deepEqual(emptyReport.sign_layout.objects,[]);
assert.ok(!G.productPreviewSvg(empty,emptyReport));
assert.throws(()=>G.analyze({...empty,target_polygon_px:[[0,0],[1201,0],[1201,600],[0,600]]}),/размеры фото/);

// Perspective uses each sign's local source mesh, including negative wall
// coordinates. Shared group dimensions do not control the mesh or its clip.
const H=[2,.18,300,.12,1.6,180,.0008,.0003,1];
const calibration={mode:'rectangle',width_cm:400,height_cm:200,
  image_points:[[0,0],[400,0],[400,200],[0,200]].map(p=>G.apply(H,p))};
const perspective={...scene([text('perspective',{x_cm:-30,y_cm:10,rotation_deg:12}),
  logo('logo-a',{x_cm:180,y_cm:40,rotation_deg:30}),logo('logo-b',{x_cm:320,y_cm:100,rotation_deg:-10})]),
  calibration,target_polygon_px:null};
const perspectiveReport=G.analyze(perspective), svg=G.overlaySvg(perspective,perspectiveReport);
for(const id of ['perspective','logo-a','logo-b'])assert.ok(svg.includes(`data-object-id="${id}"`));
assert.ok(svg.includes('id="signage-independent-0-preview"'));
assert.ok(svg.includes('id="signage-independent-1-preview"'));
assert.ok(svg.includes('id="signage-independent-2-preview"'));
assert.ok(svg.includes('signage-independent-0-clip'));
assert.ok(!svg.includes('fill="#ffb454"'));
assert.ok(!svg.includes('вся композиция'));
assert.equal((svg.match(/data-sign-outline=/g)||[]).length,3);
const ids=[...svg.matchAll(/\sid="([^"]+)"/g)].map(match=>match[1]);
assert.equal(new Set(ids).size,ids.length);
assert.equal((svg.match(/data:image\/png;base64,/g)||[]).length,2);
assert.ok(!G.productPreviewSvg(perspective,perspectiveReport,{includeText:false}).includes('data-object-id'));
const canonical=P.normalizeProject(perspective), canonicalBefore=JSON.stringify(canonical);
assert.deepEqual(G.analyze(canonical).sign_layout,perspectiveReport.sign_layout);
assert.equal(JSON.stringify(canonical),canonicalBefore);
assert.ok(G.productPreviewSvg(canonical).includes('data-object-id="logo-b"'));
const horizon=copy(perspective);horizon.sign.objects.push(text('horizon',{x_cm:-1300,y_cm:0}));
assert.throws(()=>G.analyze(horizon),/горизонт/);
const horizonPreview=G.analyze(horizon,{preview:true});
assert.deepEqual(horizonPreview.sign_layout.objects,perspectiveReport.sign_layout.objects);
assert.ok(horizonPreview.warnings.some(message=>/временно не показана.*горизонт/.test(message)));

// Transfer a legacy composition into the wall plane without moving any
// projected corner or changing glyph size, PNG bytes, object IDs or order.
const legacy={...perspective,placement:{center_px:G.apply(H,[200,100]),width_cm:300,height_cm:100,rotation_deg:17},
  sign:{text:'',objects:[text('legacy-text',{x_cm:10,y_cm:10,rotation_deg:7}),
    logo('legacy-logo',{x_cm:150,y_cm:20,rotation_deg:30})]}};
const legacyBefore=JSON.stringify(legacy), legacyReport=G.analyze(legacy);
const transferred=G.independentSignsFromComposition(legacy.sign.objects,legacy.placement,G.calibrate(calibration));
assert.equal(JSON.stringify(legacy),legacyBefore);
const converted={...legacy,placement:null,sign:{...legacy.sign,composition_mode:'independent_signs_v1',objects:transferred}};
const convertedReport=G.analyze(converted);
convertedReport.sign_layout.objects.forEach((object,index)=>{
  const old=legacyReport.sign_layout.objects[index];
  equalPoints(object.polygon_px,old.polygon_px);
  close(object.width_cm,old.width_cm);close(object.height_cm,old.height_cm);
  assert.equal(object.rotation_deg,old.rotation_deg+17);
  assert.equal(object.id,old.id);
  if(object.lines)object.lines.forEach((line,i)=>equalPoints(line.polygon_px,old.lines[i].polygon_px));
});
assert.equal(transferred[1].artwork.data_url,legacy.sign.objects[1].artwork.data_url);
assert.deepEqual(transferred[0].preview_line_metrics,legacy.sign.objects[0].preview_line_metrics);
assert.deepEqual(G.independentSignsFromComposition([],legacy.placement,G.calibrate(calibration)),[]);
const invalidMigration=copy(legacy.sign.objects);invalidMigration[0].text='OUTDATED';
assert.throws(()=>G.independentSignsFromComposition(invalidMigration,legacy.placement,G.calibrate(calibration)),/Метрики/);

console.log('PASS: wall-plane independent signs without a shared placement/envelope, own perspective meshes and unique SVG IDs, per-sign rotated target/photo containment instead of union containment, isolated edits and opt-in preview warnings, canonical v1/v2 exports, and exact nonmutating legacy composition transfer.');
