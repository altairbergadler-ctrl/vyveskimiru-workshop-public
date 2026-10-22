'use strict';
const assert = require('node:assert/strict');
const G = require('../assets/geometry.js');
const P = require('../assets/products.js');
const close = (a,b) => assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
const copy = value => JSON.parse(JSON.stringify(value));
const metric = (text,width,height=80,font='Arial',bold=true) => ({text,width,
  actualBoundingBoxLeft:4,actualBoundingBoxRight:width-4,
  actualBoundingBoxAscent:height-10,actualBoundingBoxDescent:10,
  font_family:font,font_weight:bold?700:400});
const saved = rows => ({font_size_px:100,font_family:'Arial',font_weight:700,lines:rows});
const style = (height_cm=null,font_family='Arial',font_bold=true) => ({height_cm,font_family,font_bold});
const basic = {text:'ПЕРВАЯ\nВТОРАЯ',font_family:'Arial',font_bold:true,line_gap_cm:5,text_align:'center',
  preview_line_metrics:saved([metric('ПЕРВАЯ',400),metric('ВТОРАЯ',200)])};
const envelope = {width_cm:300,height_cm:100};

// New automatic controls preserve the original fit for matching font metrics.
const legacy = G.textLayout(basic,envelope);
const auto = G.textLayout({...basic,line_styles:[style(),style()]},envelope);
auto.lines.forEach((row,i)=>{
  for(const key of ['x_cm','y_cm','baseline_cm','width_cm','height_cm'])close(row[key],legacy.lines[i][key]);
});
close(auto.font_size_cm,legacy.font_size_cm);

// Physical heights determine visible glyph bounds; different fonts and weights
// retain their own measured aspect ratios and font sizes without distortion.
const explicit = {...basic,line_styles:[style(24),style(12,'Georgia',false)],
  preview_line_metrics:saved([metric('ПЕРВАЯ',400),metric('ВТОРАЯ',200,60,'Georgia',false)])};
const layout = G.textLayout(explicit,envelope);
close(layout.lines[0].height_cm,24);close(layout.lines[1].height_cm,12);
close(layout.lines[0].width_cm,120);close(layout.lines[1].width_cm,40);
close(layout.lines[0].font_size_cm,30);close(layout.lines[1].font_size_cm,20);
assert.equal(layout.lines[1].font_family,'Georgia');assert.equal(layout.lines[1].font_weight,400);
close(layout.lines[1].y_cm-layout.lines[0].y_cm-layout.lines[0].height_cm,5);
close(layout.lines[0].y_cm,(100-24-12-5)/2);
const flat = G.localCompositionSvg(layout,'#eeeeee');
assert.ok(flat.includes('font-size="20" font-family="&quot;Georgia&quot;, Arial, sans-serif" font-weight="400"'));
assert.equal(G.compositionFontFamily('MissingFont, Georgia'),'"MissingFont, Georgia", Arial, sans-serif');
assert.equal(G.compositionFontFamily('serif'),'"serif", Arial, sans-serif');
assert.equal(G.compositionFontFamily('A"B\\C\nD'),'"A\\22 B\\5c C\\a D", Arial, sans-serif');
const specialFont = 'MissingFont, Georgia';
const special = G.textLayout({...basic,line_styles:[style(24,specialFont),style(12)],
  preview_line_metrics:saved([metric('ПЕРВАЯ',400,80,specialFont),metric('ВТОРАЯ',200)])},envelope);
assert.ok(G.localCompositionSvg(special).includes('font-family="&quot;MissingFont, Georgia&quot;, Arial, sans-serif"'));

// Automatic rows use only the remaining height while exact heights stay fixed.
const mixed = G.textLayout({...explicit,line_styles:[style(24),style(null,'Georgia',false)]},envelope);
close(mixed.lines[0].height_cm,24);close(mixed.lines[1].height_cm,71);
const limited = G.textLayout({...explicit,line_styles:[style(24),style(null,'Georgia',false)]},{width_cm:125,height_cm:100});
close(limited.lines[0].height_cm,24);close(limited.lines[1].width_cm,125);
assert.throws(()=>G.textLayout(explicit,{width_cm:119,height_cm:100}),/Строка 1.*ширине/);
assert.throws(()=>G.textLayout(explicit,{width_cm:300,height_cm:40}),/Высоты строк/);
assert.throws(()=>G.textLayout({...explicit,line_styles:[style(95),style(null,'Georgia',false)]},envelope),/Высоты строк/);
for(const changes of [
  {line_styles:[]},{line_styles:null},{line_styles:[null,style()]},
  {line_styles:[style(0),style()]},{line_styles:[style(-1),style()]},
  {line_styles:[style('24'),style()]},{line_styles:[style(null,''),style()]},
  {line_styles:[style(null,'Arial','true'),style()]},
])assert.throws(()=>G.textLayout({...basic,...changes},envelope));
assert.throws(()=>G.textLayout({...explicit,line_styles:[style(24,'Verdana'),style(12,'Georgia',false)]},envelope),/Метрики.*устарели/);
assert.throws(()=>G.textLayout({...explicit,preview_line_metrics:saved([metric('ПЕРВАЯ',400),metric('ИЗМЕНЕНО',200,60,'Georgia',false)])},envelope),/Метрики/);

const blank = {text:'ПЕРВАЯ\n\nВТОРАЯ',line_gap_cm:2,line_styles:[style(20),style(9),style(10)],
  preview_line_metrics:saved([metric('ПЕРВАЯ',400),{...metric('',0,0),actualBoundingBoxAscent:0,actualBoundingBoxDescent:0},metric('ВТОРАЯ',200)])};
const blanks = G.textLayout(blank,envelope);
assert.equal(blanks.lines[1].blank,true);close(blanks.lines[1].height_cm,9);
assert.equal((G.localCompositionSvg(blanks).match(/<tspan /g)||[]).length,2);

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMfoAAAAASUVORK5CYII=';
const artwork = {name:'logo.png',mime_type:'image/png',source:'uploaded',width_px:1,height_px:1,data_url:'data:image/png;base64,'+png};
const logo = {artwork,width_cm:20,x_cm:275,y_cm:75};
const withLogo = G.textLayout({...explicit,logo},envelope);
assert.deepEqual(withLogo.lines,layout.lines,'The independently positioned logo must not alter text sizes or positions');
close(withLogo.logo.x_cm,275);close(withLogo.logo.y_cm,75);
assert.equal(withLogo.logo.data_url,artwork.data_url);
assert.ok(G.localCompositionSvg(withLogo).includes('x="275" y="75" width="20" height="20"'));
assert.ok(G.localCompositionSvg(withLogo).includes(artwork.data_url));
for(const change of [{x_cm:-1},{y_cm:-1},{x_cm:281},{y_cm:81},{width_cm:0},{width_cm:NaN},{x_cm:'1'},
  {artwork:{...artwork,data_url:'javascript:alert(1)'}},{artwork:{...artwork,width_px:2}}]) {
  assert.throws(()=>G.textLayout({...explicit,logo:{...logo,...change}},envelope));
}
const onlyLogo = {text:'',line_styles:[],logo:{...logo,x_cm:280,y_cm:80}};
const lone = G.textLayout(onlyLogo,envelope);
assert.deepEqual(lone.lines,[]);close(lone.logo.x_cm,280);close(lone.logo.y_cm,80);
assert.throws(()=>G.textLayout({text:'',line_styles:[]},envelope),/Введите текст/);

// A non-square PNG header proves logo height derives from the supplied image
// ratio. The existing browser header contract accepts it; Pillow validates the
// complete PNG before a server submission.
const header = Buffer.from(png,'base64');header.writeUInt32BE(2,16);
const rectangularArtwork = {...artwork,width_px:2,data_url:'data:image/png;base64,'+header.toString('base64')};
const rectangular = G.textLayout({...onlyLogo,logo:{artwork:rectangularArtwork,width_cm:40,x_cm:260,y_cm:80}},envelope);
close(rectangular.logo.height_cm,20);

// Perspective conversion and export retain all components and never mutate the
// input project, including compatibility mirrors and logo bytes.
const H = [2,.18,220,.12,1.6,100,.0008,.0003,1];
const project = {version:1,image:{name:'test.png',width_px:1600,height_px:1000},
  calibration:{mode:'rectangle',width_cm:400,height_cm:200,image_points:[[0,0],[400,0],[400,200],[0,200]].map(p=>G.apply(H,p))},
  placement:{center_px:G.apply(H,[200,100]),width_cm:300,height_cm:100,rotation_deg:17},
  sign:{...explicit,logo},measurements:[],checks:[]};
const before = JSON.stringify(project), report = G.analyze(project);
assert.equal(JSON.stringify(project),before);
for(const object of [...report.sign_layout.lines,report.sign_layout.logo]){
  assert.equal(object.polygon_px.length,4);
  object.polygon_px.forEach((point,i)=>G.apply(G.inverse(report.sign_layout.local_to_image),point).forEach((value,k)=>close(value,object.bounds_cm[i][k])));
}
const svg = G.overlaySvg(project,report);
assert.ok(svg.includes('font-family="&quot;Georgia&quot;, Arial, sans-serif" font-weight="400"'));
assert.ok(svg.includes('id="signage-preview-logo"'));assert.ok(svg.includes(artwork.data_url));
assert.ok(!G.overlaySvg(project,report,'',{includeText:false}).includes('signage-preview-logo'));
const v2 = P.normalizeProject(project), canonicalBefore=JSON.stringify(v2), v2Report=G.analyze(v2);
assert.equal(JSON.stringify(v2),canonicalBefore);
assert.deepEqual(v2Report.sign_layout,report.sign_layout);
assert.ok(G.productPreviewSvg(v2,v2Report).includes(artwork.data_url));
const loneProject = {...project,sign:onlyLogo};
assert.ok(G.analyze(loneProject).sign_layout.logo);
assert.ok(G.overlaySvg(loneProject).includes('signage-preview-logo'));
console.log('PASS: unchanged legacy fit, exact per-line ink heights, mixed fonts and weights, auto-row remaining fit, overflow rejection, blank rows, stale metrics, independently positioned proportional PNG logos, logo-only layouts, v1/v2 non-mutating perspective round trips and SVG export.');
