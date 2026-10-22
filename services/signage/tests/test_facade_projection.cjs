'use strict';
const assert=require('node:assert/strict');
const G=require('../assets/geometry.js'),F=require('../assets/facade-projection.js'),P=require('../assets/products.js');
const clone=v=>JSON.parse(JSON.stringify(v));
const close=(a,b,t=1e-6)=>assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);
const points=(a,b)=>a.forEach((p,i)=>p.forEach((v,k)=>close(v,b[i][k])));
const image={name:'synthetic-facade.png',width_px:1200,height_px:760};
const lens=F.createLens({image:{width:1200,height:760},k:-.7});
const H=G.homography([[0,0],[600,0],[600,220],[0,220]],[[95,190],[1110,110],[1050,530],[145,640]]);
const projectPoint=p=>lens.distort(G.apply(H,p));
const referenceWorld=[[200,60],[400,60],[400,160],[200,160]];
const calibration={mode:'rectangle',width_cm:200,height_cm:100,image_points:referenceWorld.map(projectPoint)};
const targetWorld=[[0,0],[600,0],[600,220],[0,220]];
const facade={version:1,enabled:true,lens_enabled:true,edge_points:[[300,0],[600,110],[300,220],[0,110]].map(projectPoint),grid_visible:true,grid_step_cm:50,snap_elements:true,snap_grid:false};
const scene={version:1,image,calibration,target_polygon_px:targetWorld.map(projectPoint),facade,measurements:[],checks:[],
  placement:{center_px:projectPoint([300,100]),width_cm:120,height_cm:35,rotation_deg:12},sign:{text:'TEST',front_color:'#fff3dc'}};
const before=JSON.stringify(scene),cal=G.sceneCalibration(scene);
assert.equal(JSON.stringify(scene),before,'Deriving zone dimensions must not overwrite the prior reference');
assert.ok(G.isFacadeProjection(cal.worldToImage));close(cal.lens.k,-.7,1e-7);
close(cal.zone_info.width_cm,600);close(cal.zone_info.height_cm,220);
// The reference coordinates start at its own upper left (world200,60).
for(let x=0;x<=600;x+=30)for(let y=0;y<=220;y+=20){
  const cm=[x-200,y-60],px=projectPoint([x,y]);points([G.apply(cal.worldToImage,cm)],[px]);points([G.apply(cal.imageToWorld,px)],[cm]);
}
close(G.measure(cal,calibration.image_points.slice(0,2)),200);
close(G.measure(cal,[projectPoint([250,70]),projectPoint([280,110])]),50);
const smaller=clone(scene);smaller.target_polygon_px=[[0,0],[500,0],[500,220],[0,220]].map(projectPoint);
smaller.facade.edge_points=[[250,0],[500,110],[250,220],[0,110]].map(projectPoint);
const smallerCal=G.sceneCalibration(smaller);close(smallerCal.zone_info.width_cm,500);close(smallerCal.zone_info.height_cm,220);
assert.deepEqual(smaller.calibration,scene.calibration);close(G.measure(smallerCal,calibration.image_points.slice(0,2)),200);
const report=G.analyze(scene),saved=clone(report);
assert.ok(saved.placement.boundary_px.length>4);assert.equal(saved.placement.local_to_image.type,'facade_projection_v1');
const local=[30,12];points([G.apply(saved.placement.local_to_image,local)],[G.apply(report.placement.local_to_image,local)]);
points([G.apply(G.inverse(saved.placement.local_to_image),G.apply(saved.placement.local_to_image,local))],[local]);
assert.deepEqual(G.analyze(clone(scene)),report,'Node JSON roundtrip must preserve every projection value');
// Existing documents retain the exact legacy calibration unless explicitly enabled.
const legacy=clone(scene);delete legacy.facade;
assert.deepEqual(G.sceneCalibration(legacy),G.calibrate(legacy.calibration));
assert.ok(Array.isArray(G.analyze(legacy).calibration.worldToImage));
const disabled=clone(scene);disabled.facade.enabled=false;
assert.deepEqual(G.analyze(disabled).calibration,G.analyze(legacy).calibration);
// A single segment stays supported and preserves the supplied length, with an
// explicit approximate aspect assumption rather than hidden second dimensions.
const segment=clone(scene);segment.calibration={mode:'frontoparallel',frontoparallel_assumed:true,length_cm:120,image_points:[[240,80],[360,80]].map(projectPoint)};
const segmentCal=G.sceneCalibration(segment);close(G.measure(segmentCal,segment.calibration.image_points),120);
assert.equal(segmentCal.zone_info.approximate,true);assert.match(segmentCal.warnings.join(' '),/приблизительная/);
assert.match(segmentCal.warnings.join(' '),/Длина заданного отрезка сохранена/);
// A rotated reference is not the facade direction. Zone axes rotate rigidly
// without changing metric lengths or deriving cm from informational readouts.
const rotated=clone(scene),angle=.25,c=Math.cos(angle),s=Math.sin(angle);
rotated.calibration.image_points=[[0,0],[200,0],[200,100],[0,100]].map(([x,y])=>projectPoint([180+c*x-s*y,65+s*x+c*y]));
const rotatedCal=G.sceneCalibration(rotated);
close(G.measure(rotatedCal,rotated.calibration.image_points.slice(0,2)),200);
const zoneCm=rotatedCal.target_world_cm;close(zoneCm[0][1],zoneCm[1][1]);
close(rotatedCal.zone_info.width_cm,600);close(rotatedCal.zone_info.height_cm,220);
close(G.measure(rotatedCal,[projectPoint([250,70]),projectPoint([280,110])]),50);
// Real product previews use the same descriptor, including a neon text glow.
for(const type of ['plaque','neon']){
  const product=P.createProduct(type);product.placement=clone(scene.placement);
  product.params.text='TEST';product.params.preview_line_metrics={font_size_px:100,lines:[{text:'TEST',width:400,actualBoundingBoxLeft:4,actualBoundingBoxRight:396,actualBoundingBoxAscent:70,actualBoundingBoxDescent:10}]};
  if(type==='neon')product.params.illumination='on';
  const p={...clone(scene),version:2,products:[product],active_product_id:product.id};
  const r=G.analyze(p),svg=G.overlaySvg(p,r);
  assert.ok(r.placement.local_to_image);assert.doesNotMatch(svg,/NaN|Infinity|undefined/);
  assert.match(svg,/<clipPath/,'Nonlinear art must use projected patches rather than four-corner CSS transform');
}
for(const bad of [{...facade,version:9},{...facade,edge_points:[[NaN,0]]}])assert.throws(()=>G.sceneCalibration({...scene,facade:bad}));
console.log('PASS: facade metric reference, derived readouts, nonlinear JSON descriptors, original/legacy calibration, single-segment approximation, product meshes and glow.');
