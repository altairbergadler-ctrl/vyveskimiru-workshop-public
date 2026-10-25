'use strict';
const assert = require('node:assert/strict');
const G = require('../assets/geometry.js');
const close = (a,b,eps=1e-7) => assert.ok(Math.abs(a-b)<eps,`${a} != ${b}`);
const image = {name:'synthetic.png',width_px:1600,height_px:1000};
const frontal = {mode:'frontoparallel',frontoparallel_assumed:true,image_points:[[100,300],[580,300]],length_cm:120};
const cal = G.calibrate(frontal);
close(G.measure(cal,[[0,0],[240,0]]),60);
close(G.measure(cal,[[0,0],[120,160]]),50);
const rulerTriangle = [[0,0],[120,0],[120,160],[0,0]];
assert.deepEqual(G.measurePolyline(cal, rulerTriangle), {
  segment_lengths_cm:[30,40,50], total_cm:120,
  cumulative_lengths_cm:[0,30,70,120], points_cm:[[0,0],[30,0],[30,40],[0,0]]
});
assert.deepEqual(G.measurePolyline(cal, []), {segment_lengths_cm:[], total_cm:0, cumulative_lengths_cm:[], points_cm:[]});
assert.deepEqual(G.measurePolyline(cal, [[40,80]]), {segment_lengths_cm:[], total_cm:0, cumulative_lengths_cm:[0], points_cm:[[10,20]]});
assert.deepEqual(G.measurePolyline(cal, [[40,80],[40,80]]).segment_lengths_cm,[0]);
for (const invalid of [null, {}, [[NaN,0]], [[0,Infinity]], [[0]], [[0,0,0]], [null], [[0,'0']], new Array(1), [new Array(2)], Array.from({length:257}, (_,i)=>[i,0])]) {
  assert.throws(()=>G.measurePolyline(cal,invalid));
}
close(G.measurePolyline(cal,Array.from({length:256},(_,i)=>[i,0])).total_cm,255/4);
const crossingCalibration = {imageToWorld:[1,0,0,0,1,0,1,0,-50]};
assert.throws(()=>G.measurePolyline(crossingCalibration,[[0,0],[25,0],[100,0]]),/горизонт/);
assert.throws(()=>G.measurePolyline(crossingCalibration,[[50,0]]),/горизонт/);
assert.throws(()=>G.measurePolyline(crossingCalibration,[[50+1e-12,0]]),/горизонт/);
assert.throws(()=>G.measurePolyline({imageToWorld:[1,0,0,0,1,0,0,0,1]},[[1e308,0],[-1e308,0]]),/Неустойчивая/);
const p = G.placement(cal,{center_px:[800,400],width_cm:200,height_cm:40,rotation_deg:0});
assert.deepEqual(p.polygon_px,[[400,320],[1200,320],[1200,480],[400,480]]);
assert.throws(()=>G.calibrate({...frontal,frontoparallel_assumed:false}));
assert.throws(()=>G.calibrate({...frontal,length_cm:0}));
assert.throws(()=>G.calibrate({...frontal,image_points:[[0,0],[1,1]]}));
const H = [2,.18,220,.12,1.6,100,.0008,.0003,1];
const world = [[0,0],[400,0],[400,200],[0,200]], pixels = world.map(p=>G.apply(H,p));
const perspective = G.calibrate({mode:'rectangle',width_cm:400,height_cm:200,image_points:pixels});
for (let y=0;y<=400;y+=20) for (let x=0;x<=500;x+=25) {
  const original=[x,y], back=G.apply(perspective.imageToWorld,G.apply(H,original));
  close(back[0],x); close(back[1],y);
}
close(G.measure(perspective,[[30,40],[330,140]].map(p=>G.apply(H,p))),Math.hypot(300,100));
const worldRuler = [[10,10],[310,10],[310,410],[10,10]];
const projectedRuler = worldRuler.map(p=>G.apply(H,p));
const perspectiveRuler = G.measurePolyline(perspective,projectedRuler);
perspectiveRuler.segment_lengths_cm.forEach((v,i)=>close(v,[300,400,500][i]));
perspectiveRuler.cumulative_lengths_cm.forEach((v,i)=>close(v,[0,300,700,1200][i]));
perspectiveRuler.points_cm.forEach((p,i)=>p.forEach((v,j)=>close(v,worldRuler[i][j])));
close(perspectiveRuler.total_cm,1200);
// A single pixels/cm ratio would give the wrong answer for this projection.
const pixelRatio = G.distance(projectedRuler[0],projectedRuler[1])/300;
assert.ok(Math.abs(G.distance(projectedRuler[1],projectedRuler[2])/pixelRatio-400)>20);
const rotated = G.placement(perspective,{center_px:G.apply(H,[200,100]),width_cm:120,height_cm:30,rotation_deg:37});
close(G.measure(perspective,rotated.polygon_px.slice(0,2)),120);
close(G.measure(perspective,rotated.polygon_px.slice(1,3)),30);
assert.throws(()=>G.homography(world,[[0,0],[1,1],[2,2],[3,3]]));
assert.throws(()=>G.homography(world,[[0,0],[300,200],[300,0],[0,200]]));
const project={version:1,image,calibration:frontal,placement:{center_px:[800,400],width_cm:200,height_cm:40},target_polygon_px:[[600,300],[1000,300],[1000,500],[600,500]],measurements:[{name:'different plane',same_plane:false,image_points:[[0,0],[100,0]]}],checks:[{name:'known',same_plane:true,image_points:[[0,0],[400,0]],length_cm:120}],sign:{text:'КОФЕ <script> & "'}};
const report=G.analyze(project);
assert.equal(report.ruler,null);
assert.equal(G.analyze({...project,ruler:null}).ruler,null);
const rulerProject={...project,ruler:{image_points:rulerTriangle,same_plane:true}};
const rulerProjectBefore=JSON.stringify(rulerProject);
const rulerReport=G.analyze(rulerProject);
assert.equal(JSON.stringify(rulerProject),rulerProjectBefore);
assert.equal(rulerReport.ruler.total_cm,120);
assert.deepEqual(rulerReport.ruler.image_points,rulerTriangle);
assert.notEqual(rulerReport.ruler.image_points,rulerTriangle);
for (const points of [[],[[40,80]]]) assert.equal(G.analyze({...project,ruler:{image_points:points,same_plane:true}}).ruler.total_cm,0);
for (const same_plane of [false,undefined,'<script>']) {
  const unconfirmed=G.analyze({...project,ruler:{image_points:rulerTriangle,same_plane}}).ruler;
  assert.equal(unconfirmed.same_plane,false);
  for (const key of ['total_cm','segment_lengths_cm','cumulative_lengths_cm','points_cm']) assert.equal(unconfirmed[key],null);
  assert.ok(unconfirmed.reason.includes('не подтверждена'));
}
for(const points of [[[1601,0]],[[0,-1]],[[0,1001]],[[Infinity,0]],Array.from({length:257},()=>[0,0])]) {
  for (const same_plane of [true,false]) assert.throws(()=>G.analyze({...project,ruler:{image_points:points,same_plane}}));
}
// A ruler crossing the projective horizon has no physical result but cannot
// block a valid sign placement, report export, or a generation request.
const horizonProject={version:1,image:{...image,width_px:3000},calibration:{mode:'rectangle',width_cm:400,height_cm:200,image_points:pixels},
  placement:{center_px:G.apply(H,[200,100]),width_cm:120,height_cm:30},
  ruler:{image_points:[[0,0],[3000,0]],same_plane:true}};
const horizonReport=G.analyze(horizonProject);
assert.ok(horizonReport.placement);
assert.equal(horizonReport.ruler.total_cm,null);
assert.ok(horizonReport.ruler.error.includes('горизонт'));
assert.ok(horizonReport.warnings.some(s=>s.startsWith('Линейка:')));
assert.ok(!G.analyze({...horizonProject,ruler:{...horizonProject.ruler,same_plane:false}}).ruler.error);
const outsideRuler=G.analyze({...horizonProject,ruler:{image_points:[G.apply(H,[450,210])],same_plane:true}});
assert.ok(outsideRuler.warnings.some(s=>s.includes('Линейка использует продолжение')));
assert.equal(report.placement.fits_target,false);
assert.equal(report.measurements[0].length_cm,null);
assert.ok(report.warnings.some(s=>s.includes('расхождение')));
const svg=G.overlaySvg(project,report);
assert.ok(svg.includes('id="signage-overlay-caption"'), 'Export retains its technical caption');
assert.ok(!G.overlaySvg(project,report,'',{includeCaption:false}).includes('id="signage-overlay-caption"'), 'Interactive canvas can omit its duplicate caption');
assert.ok(!svg.includes('<script>'));
assert.ok(svg.includes('&lt;script&gt;'));
const rulerSvg=G.overlaySvg(rulerProject,rulerReport,'data:image/png;base64,fixture');
assert.ok(rulerSvg.includes('id="signage-ruler"'));
assert.equal((rulerSvg.match(/class="ruler-point"/g)||[]).length,4);
assert.equal((rulerSvg.match(/class="ruler-segment-label"/g)||[]).length,3);
assert.ok(rulerSvg.includes('Всего ≈ 120.0 см'));
assert.ok(rulerSvg.includes('≈ 50.0 см'));
assert.ok(rulerSvg.includes('<image width="1600" height="1000" href="data:image/png;base64,fixture"/>'));
assert.ok(!rulerSvg.includes('<script>'));
assert.ok(!G.overlaySvg(rulerProject,rulerReport,'',{includeRuler:false}).includes('id="signage-ruler"'));
assert.ok(!G.overlaySvg({...project,ruler:{image_points:[],same_plane:true}}).includes('id="signage-ruler"'));
const unconfirmedSvg=G.overlaySvg({...project,ruler:{image_points:rulerTriangle,same_plane:false}});
assert.ok(unconfirmedSvg.includes('Плоскость не подтверждена'));
assert.ok(!unconfirmedSvg.includes('ruler-segment-label'));
assert.ok(G.overlaySvg(horizonProject,horizonReport).includes('Размер не рассчитан'));
assert.throws(()=>G.analyze({...project,image:{width_px:50,height_px:50}}));
const horizon=G.calibrate({mode:'rectangle',width_cm:400,height_cm:200,image_points:pixels});
assert.throws(()=>G.placement(horizon,{center_px:G.apply(H,[-1200,0]),width_cm:300,height_cm:30}));

// Metrics are measured fixture values at 100 px. Width is based on actual ink
// bounds, not character counts or horizontal distortion to fill the envelope.
const lineMetric = (text, inkWidth, ascent = 70, descent = 10, left = 0) => ({
  text, width: inkWidth + 12, actualBoundingBoxLeft: left,
  actualBoundingBoxRight: inkWidth - left,
  actualBoundingBoxAscent: ascent, actualBoundingBoxDescent: descent
});
const sign = {text:'ЦВЕТЫ\n24 ЧАСА', line_gap_cm:10, text_align:'center',
  preview_line_metrics:{font_size_px:100,font_family:'Arial',font_weight:700,
    lines:[lineMetric('ЦВЕТЫ',450,70,10,5),lineMetric('24 ЧАСА',200,75,15,2)]}};
const envelope = {width_cm:300,height_cm:100};
const layout = G.textLayout(sign,envelope);
close(layout.font_size_cm,90/1.7);
close(layout.content_height_cm,100);
close(layout.lines[1].y_cm - layout.lines[0].y_cm - layout.lines[0].height_cm,10);
layout.lines.forEach(line => {
  close(line.bounds_cm[0][0],(300-line.width_cm)/2);
  close(line.bounds_cm[0][1],line.y_cm);
  assert.ok(line.bounds_cm.every(([x,y]) => x>=-1e-8&&x<=300+1e-8&&y>=-1e-8&&y<=100+1e-8));
});
close(layout.lines[0].x_cm-layout.lines[0].bounds_cm[0][0],.05*layout.font_size_cm);
close(layout.lines[1].baseline_cm-layout.lines[1].y_cm,.75*layout.font_size_cm);
const wide = G.textLayout(sign,{width_cm:90,height_cm:100});
close(wide.font_size_cm,20);
close(wide.content_height_cm,44);
close(wide.lines[0].y_cm,28);
close(wide.lines[1].y_cm-wide.lines[0].y_cm-wide.lines[0].height_cm,10);
for(const align of ['left','center','right']) {
  const aligned = G.textLayout({...sign,text_align:align},envelope);
  aligned.lines.forEach(line => close(line.bounds_cm[0][0],align==='left'?0:align==='right'?300-line.width_cm:(300-line.width_cm)/2));
  close(aligned.font_size_cm,layout.font_size_cm);
}
const defaults=G.textLayout({...sign,line_gap_cm:undefined,text_align:undefined},envelope);
assert.equal(defaults.line_gap_cm,5); assert.equal(defaults.text_align,'center');
const measured=G.textLayout({text:sign.text,line_gap_cm:10},envelope,text=>sign.preview_line_metrics.lines.find(line=>line.text===text));
close(measured.font_size_cm,layout.font_size_cm);
assert.deepEqual(G.textLines('\r\nЦВЕТЫ\r\n\r\n24 ЧАСА\r\n'),['ЦВЕТЫ','','24 ЧАСА']);
const blankSign={...sign,text:'ЦВЕТЫ\n\n24 ЧАСА',preview_line_metrics:{...sign.preview_line_metrics,
  lines:[sign.preview_line_metrics.lines[0],lineMetric('',0,0,0),sign.preview_line_metrics.lines[1]]}};
const blank=G.textLayout(blankSign,{width_cm:300,height_cm:140});
assert.equal(blank.lines.length,3); assert.equal(blank.lines[1].blank,true);
close(blank.lines[1].height_cm,.9*blank.font_size_cm);
close(blank.lines[2].y_cm-blank.lines[1].y_cm-blank.lines[1].height_cm,10);
for(const invalid of [{line_gap_cm:-1},{line_gap_cm:NaN},{line_gap_cm:100},{text_align:'justify'}]) {
  assert.throws(()=>G.textLayout({...sign,...invalid},envelope));
}
assert.throws(()=>G.textLayout({...sign,text:'Changed\n24 ЧАСА'},envelope),/Метрики/);
assert.throws(()=>G.textLayout({text:'\n'},envelope),/Введите/);
assert.throws(()=>G.analyze({...project,sign:{...sign,line_gap_cm:40}}),/зазоры/);

const multilineProject={...project,sign,placement:{center_px:G.apply(H,[200,100]),width_cm:120,height_cm:60,rotation_deg:17},
  calibration:{mode:'rectangle',width_cm:400,height_cm:200,image_points:pixels},target_polygon_px:null,checks:[]};
const before=JSON.stringify(multilineProject);
const multilineReport=G.analyze(multilineProject);
assert.equal(JSON.stringify(multilineProject),before);
const signResult=multilineReport.sign_layout;
assert.ok(signResult);
const rad=17*Math.PI/180;
for(const row of signResult.lines) for(let i=0;i<4;i++) {
  const [lx,ly]=row.bounds_cm[i], x=lx-60,y=ly-30;
  const worldPoint=[200+x*Math.cos(rad)-y*Math.sin(rad),100+x*Math.sin(rad)+y*Math.cos(rad)];
  const expected=G.apply(H,worldPoint);
  close(row.polygon_px[i][0],expected[0]); close(row.polygon_px[i][1],expected[1]);
  const recovered=G.apply(G.inverse(signResult.local_to_image),row.polygon_px[i]);
  close(recovered[0],lx); close(recovered[1],ly);
}
const multilineSvg=G.overlaySvg(multilineProject,multilineReport,'data:image/png;base64,fixture');
assert.ok(multilineSvg.includes('id="signage-preview-text"'));
assert.ok(multilineSvg.includes('id="signage-preview-art"'));
assert.ok((multilineSvg.match(/<clipPath /g)||[]).length>2);
assert.ok(multilineSvg.includes('>ЦВЕТЫ</tspan>'));
assert.ok(multilineSvg.includes('>24 ЧАСА</tspan>'));
assert.ok(multilineSvg.includes('<image width="1600" height="1000" href="data:image/png;base64,fixture"/>'));
assert.ok(!G.overlaySvg(multilineProject,multilineReport,'',{includeText:false}).includes('id="signage-preview-text"'));
const escapedSign={text:'<script>&"\n</script>',preview_line_metrics:{font_size_px:100,
  lines:[lineMetric('<script>&"',400),lineMetric('</script>',300)]}};
const escapedProject={...project,sign:escapedSign};
const escapedSvg=G.overlaySvg(escapedProject);
assert.ok(!escapedSvg.includes('<script>'));
assert.ok(escapedSvg.includes('&lt;script&gt;&amp;&quot;</tspan>'));
assert.ok(escapedSvg.includes('&lt;/script&gt;</tspan>'));
assert.ok(escapedSvg.includes('id="signage-preview-text" transform="matrix('));
assert.equal(G.analyze({...multilineProject,sign:{text:sign.text}}).sign_layout,null);
console.log('PASS: calibration, perspective round trips (441 points), rotated placements, independent controls, ruler chain world lengths, 256-point limit, horizon safety/nonblocking report, plane confirmation and ruler SVG, multiline measured layout/alignment/cm gaps, blank lines, per-line projective round trips, SVG mesh and escaping.');
