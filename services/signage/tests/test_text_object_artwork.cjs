'use strict';
// Execute the shipped UI against a controllable FontFaceSet and canvas. The
// tests check physical ink alignment, stale-image eviction, and actual async
// races without making image-generation or browser automation requests.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const G=require('../assets/geometry.js'),P=require('../assets/products.js');
const clone=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function png(width,height,payload=''){
  const header=Buffer.alloc(45);Buffer.from([137,80,78,71,13,10,26,10]).copy(header);header.writeUInt32BE(13,8);header.write('IHDR',12);header.writeUInt32BE(width,16);header.writeUInt32BE(height,20);
  return 'data:image/png;base64,'+Buffer.concat([header,Buffer.from(payload)]).toString('base64');
}
class Element{
  constructor(){this.value='';this.checked=false;this.hidden=false;this.children=[];this.listeners=new Map();this.dataset={};this.validity={badInput:false};this.classList={toggle(){}};}
  addEventListener(name,callback){this.listeners.set(name,callback);}
  emit(name){return this.listeners.get(name)?.({target:this});}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=children;}
  setAttribute(){} removeAttribute(){} remove(){} click(){return this.emit('click');} focus(){} select(){}
}
function page(){
  const elements=new Map(),events=new Map(),fontEvents=new Map(),drawings=[],fontLoads=[];
  const element=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  let fontGate=null,readGate=null,renderer='channel_letters',failLarge=false,placementContext=null;
  const known={Arial:1,Georgia:1.2,monospace:1.5,serif:1.7,'sans-serif':1.1};
  const metrics=(font,text)=>{
    const requested=font.match(/100px\s+(?:"([^"]+)"|([^,]+))/),family=requested?.[1]||requested?.[2]?.trim();
    const fallbacks=font.split(',').map(value=>value.trim());
    const resolved=known[family]!==undefined?family:fallbacks.find(value=>known[value]!==undefined)||'Arial',scale=known[resolved];
    return {width:text.length*50*scale,actualBoundingBoxLeft:text.trim()?3:0,actualBoundingBoxRight:text.trim()?text.length*50*scale-3:0,actualBoundingBoxAscent:text.trim()?70*scale:0,actualBoundingBoxDescent:text.trim()?10*scale:0};
  };
  const document={getElementById:element,documentElement:{dataset:{}},activeElement:null,
    addEventListener:(name,callback)=>events.set(name,callback),
    fonts:{ready:Promise.resolve(),load:async(font,text)=>{fontLoads.push({font,text});if(fontGate)await fontGate.promise;return [];},addEventListener:(name,callback)=>fontEvents.set(name,callback)},
    createElement(type){
      if(type!=='canvas')return new Element();
      const canvas={width:0,height:0};let state={font:'',text:[],transform:null};
      const context={get font(){return state.font;},set font(value){state.font=value;},
        measureText:text=>metrics(state.font,text),setTransform:(...matrix)=>{state.transform=matrix;},
        fillText:(text,x,y)=>state.text.push({text,x,y,font:state.font}),clearRect(){},drawImage(){},getImageData:()=>({data:new Uint8ClampedArray([0,0,0,0,255,255,255,255])})};
      canvas.getContext=()=>context;
      canvas.toDataURL=()=>{const drawing={width:canvas.width,height:canvas.height,...clone(state)};drawings.push(drawing);return png(canvas.width,canvas.height,failLarge&&canvas.width>2300?'a'.repeat(2200000):JSON.stringify(drawing));};
      return canvas;
    }};
  class FakeImage{set src(url){const bytes=Buffer.from(url.split(',')[1],'base64');this.naturalWidth=bytes.readUInt32BE(16);this.naturalHeight=bytes.readUInt32BE(20);queueMicrotask(()=>this.onload());}}
  class FakeFileReader{readAsDataURL(file){const finish=()=>{this.result=file.data_url;this.onload();};if(readGate)readGate.promise.then(finish);else queueMicrotask(finish);}}
  element('font').value='Arial';element('text').value='';element('signWidth').value='300';element('signHeight').value='100';element('frontColor').value='#ffeeaa';element('sideColor').value='#111111';element('corelBold').checked=true;element('lineGap').value='4';element('textAlign').value='left';
  const window={SignageProducts:P,LetterGeometry:G,crypto:{randomUUID:()=>Math.random().toString(36)},SignageProductUI:{renderer:()=>renderer},SignageEditor:{render(){events.get('signage:change')?.();},placementContext:()=>placementContext}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../assets/letter-composition-ui.js'),'utf8'),{window,document,Image:FakeImage,FileReader:FakeFileReader,Intl,console,atob:input=>Buffer.from(input,'base64').toString('binary')});
  return {ui:window.SignageLetterUI,element,drawings,fontLoads,setGate:gate=>{fontGate=gate;},setReadGate:gate=>{readGate=gate;},setRenderer:value=>{renderer=value;},fontLoaded:()=>fontEvents.get('loadingdone')(),setLarge:value=>{failLarge=value;},setContext:value=>{placementContext=value;}};
}
const text=(id='title',values={})=>({id,type:'text',text:'АБВ\nгд',font_family:'Arial',font_bold:true,letter_height_cm:20,line_gap_cm:4,text_align:'right',front_color:'#ffeeaa',x_cm:10,y_cm:5,rotation_deg:0,...values});
const box=object=>{const layout=G.independentObjectLayout(object);return {left:Math.min(...layout.bounds_cm.map(point=>point[0])),right:Math.max(...layout.bounds_cm.map(point=>point[0])),top:Math.min(...layout.bounds_cm.map(point=>point[1])),bottom:Math.max(...layout.bounds_cm.map(point=>point[1])),layout};};
const overlaps=(a,b)=>a.left<b.right-1e-7&&a.right>b.left+1e-7&&a.top<b.bottom-1e-7&&a.bottom>b.top+1e-7;
function insideComposition(object,width=300,height=100){for(const [x,y]of G.independentObjectLayout(object).bounds_cm)assert.ok(x>=-1e-7&&x<=width+1e-7&&y>=-1e-7&&y<=height+1e-7,`${object.id} outside composition: ${x}, ${y}`);}
const upload=(p,data_url=png(200,100,'original'),name='actual.png')=>{p.element('letterAddLogo').emit('click');p.element('letterLogoUpload').files=[{name,type:'image/png',size:Buffer.from(data_url.split(',')[1],'base64').length,data_url}];return p.element('letterLogoUpload').emit('change');};
async function main(){
  // This fixture was prepared by the released 21f9b2f UI, before body sizing.
  // A read/restore must retain its exact PNG and legacy signature byte-for-byte.
  const historical=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/legacy-text-artwork.json'),'utf8'));
  const historicalPage=page();historicalPage.ui.restore(historical);
  assert.deepEqual(clone(historicalPage.ui.settings().objects[0].artwork),historical.objects[0].artwork);
  assert.equal(historicalPage.ui.settings().objects[0].artwork_signature,historical.objects[0].artwork_signature);
  assert.equal(historicalPage.element('letterHeightMigration').hidden,false);
  const explicitBounds={...text('explicit-bounds'),height_basis:'bounds'};
  const migratedPage=page();migratedPage.ui.restore({objects:[historical.objects[0],text('second-old',{text:'КОФЕ',letter_height_cm:50}),explicitBounds]});
  const oldPositions=clone(migratedPage.ui.settings().objects).map(object=>[object.id,object.letter_height_cm,object.x_cm,object.y_cm,object.rotation_deg]);
  migratedPage.element('letterUseBodyHeight').emit('click');const migratedObjects=clone(migratedPage.ui.settings().objects);
  assert.deepEqual(migratedObjects.map(object=>[object.id,object.letter_height_cm,object.x_cm,object.y_cm,object.rotation_deg]),oldPositions);
  assert.deepEqual(migratedObjects.map(object=>object.height_basis),['body','body','bounds']);
  assert.equal(migratedObjects[0].artwork,undefined);assert.equal(migratedPage.element('letterHeightMigration').hidden,true);
  await migratedPage.ui.prepareArtwork();const bodyConvertedSnapshot=clone(migratedPage.ui.settings());migratedPage.element('letterUseBodyHeight').emit('click');assert.deepEqual(clone(migratedPage.ui.settings()),bodyConvertedSnapshot,'Repeated conversion is inert and preserves new rasters');
  historicalPage.element('letterObjectHeightBasis').value='body';historicalPage.element('letterObjectHeightBasis').emit('input');
  assert.equal(historicalPage.ui.settings().objects[0].artwork,undefined,'Changing the height basis evicts a historical raster');
  await historicalPage.ui.prepareArtwork();const bodySaved=clone(historicalPage.ui.settings());
  assert.equal(bodySaved.objects[0].height_basis,'body');assert.equal(bodySaved.objects[0].preview_line_metrics.height_reference.text,'Н');
  historicalPage.ui.restore(bodySaved);assert.deepEqual(clone(historicalPage.ui.settings().objects[0].artwork),bodySaved.objects[0].artwork);
  historicalPage.element('letterObjectHeightReference').value='lowercase';historicalPage.element('letterObjectHeightReference').emit('input');
  assert.equal(historicalPage.ui.settings().objects[0].artwork,undefined,'Changing the reference evicts a body raster');
  const independentMode='independent_signs_v1',reference={mode:'frontoparallel',image_points:[[0,0],[200,0]],length_cm:100,frontoparallel_assumed:true},calibration=G.calibrate(reference);
  const context={calibration,target_polygon_px:[[200,300],[1300,260],[1450,850],[120,900]],image:{width_px:1600,height_px:1200}};
  const insideArea=(object,area=context)=>{for(const point of G.independentObjectLayout(object).bounds_cm){const pixel=G.apply(area.calibration.worldToImage,point);assert.ok(G.inside(pixel,area.target_polygon_px),`${object.id} outside installation region: ${pixel}`);assert.ok(pixel[0]>=-1e-7&&pixel[1]>=-1e-7&&pixel[0]<=area.image.width_px+1e-7&&pixel[1]<=area.image.height_px+1e-7);}};
  const independent=page();independent.setContext(context);independent.ui.restore({objects:[],composition_mode:independentMode});
  independent.element('signWidth').value='.1';independent.element('signHeight').value='.1';
  independent.element('letterAddText').emit('click');let signs=independent.ui.settings().objects;const independentFirst=clone(signs[0]);
  assert.equal(independent.ui.independent(),true);assert.equal(independent.ui.settings().composition_mode,independentMode);assert.equal(independentFirst.letter_height_cm,15);insideArea(independentFirst);
  await independent.ui.prepareArtwork();const firstPrepared=clone(independent.ui.settings().objects[0]);
  for(let at=0;at<3;at++)independent.element('letterAddText').emit('click');await upload(independent);signs=independent.ui.settings().objects;
  assert.equal(signs.length,5);assert.deepEqual(clone(signs[0]),firstPrepared,'Adding independent signs must preserve existing PNG and physical placement');assert.equal(signs[4].width_cm,30,'Logo width has its own physical default');
  for(let at=0;at<signs.length;at++){insideArea(signs[at]);if(signs[at].type==='text')assert.equal(signs[at].letter_height_cm,15);for(let before=0;before<at;before++)assert.equal(overlaps(box(signs[at]),box(signs[before])),false,'Independent additions find free space in the wall region');}
  const independentSaved=clone(independent.ui.settings());independent.ui.restore(independentSaved);assert.deepEqual(clone(independent.ui.settings()),independentSaved,'Draft/JSON restoration keeps absolute coordinates and mode');
  assert.equal(independent.ui.makeIndependent(reference,{center_px:[0,0],width_cm:1,height_cm:1,rotation_deg:70}),true);assert.deepEqual(clone(independent.ui.settings()),independentSaved,'Independent restoration cannot reapply an obsolete shared placement');
  // A reference can be established after adding a text or reading a PNG. Each
  // deferred sign gets a visible physical position when the wall becomes ready.
  const delayed=page();delayed.ui.restore({objects:[],composition_mode:independentMode});delayed.element('letterAddText').emit('click');await upload(delayed);assert.equal(delayed.ui.settings().objects.length,2);
  const delayedReload=page();delayedReload.ui.restore(delayed.ui.settings());delayedReload.ui.restoreDraftState(delayed.ui.draftState());delayedReload.setContext(context);delayedReload.ui.makeIndependent(calibration,null);for(const object of delayedReload.ui.settings().objects)insideArea(object);assert.equal(overlaps(...delayedReload.ui.settings().objects.map(box)),false,'Reload must preserve pending placement for signs added before calibration');
  delayed.setContext(context);assert.equal(delayed.ui.makeIndependent(calibration,null),true);const located=clone(delayed.ui.settings().objects);for(const object of located)insideArea(object);assert.equal(overlaps(box(located[0]),box(located[1])),false);
  delayed.ui.makeIndependent(calibration,null);assert.deepEqual(clone(delayed.ui.settings().objects),located,'Every delayed sign is placed only once');
  const withoutTarget=page();const fullImage={calibration,image:{width_px:1600,height_px:1200}};withoutTarget.setContext(fullImage);withoutTarget.ui.restore({objects:[],composition_mode:independentMode});withoutTarget.element('letterAddText').emit('click');insideArea(withoutTarget.ui.settings().objects[0],{...fullImage,target_polygon_px:[[0,0],[1600,0],[1600,1200],[0,1200]]});
  // Legacy visual position survives conversion from a rotated shared envelope.
  // Existing supplied PNG validation and font waits must still finish afterward.
  const migrating=page(),legacyLogo={id:'legacy-logo',type:'logo',artwork:{name:'source.png',mime_type:'image/png',source:'uploaded',data_url:png(200,100,'unmodified'),width_px:200,height_px:100},width_cm:30,x_cm:180,y_cm:35,rotation_deg:8};
  migrating.setContext(context);migrating.ui.restore({objects:[text('legacy',{text:'АБВ',letter_height_cm:15}),legacyLogo],composition_mode:'independent_objects_v1'});await new Promise(resolve=>setImmediate(resolve));await migrating.ui.prepareArtwork();
  const legacy=migrating.ui.settings(),placement={center_px:[800,650],width_cm:300,height_cm:100,rotation_deg:22};
  const oldReport=G.analyze({version:1,image:context.image,calibration:reference,placement,sign:legacy,target_polygon_px:context.target_polygon_px});
  assert.equal(migrating.ui.makeIndependent(reference,placement),true);const converted=migrating.ui.settings();assert.equal(converted.composition_mode,independentMode);assert.equal(converted.objects[0].artwork.data_url,legacy.objects[0].artwork.data_url);assert.equal(converted.objects[1].artwork.data_url,legacyLogo.artwork.data_url);
  const newReport=G.analyze({version:1,image:context.image,calibration:reference,placement:{...placement,width_cm:.1,height_cm:.1},sign:converted,target_polygon_px:context.target_polygon_px});
  for(let index=0;index<2;index++)for(let corner=0;corner<4;corner++)assert.ok(G.distance(oldReport.sign_layout.objects[index].polygon_px[corner],newReport.sign_layout.objects[index].polygon_px[corner])<1e-6,'Conversion must preserve every visual corner');
  const migrationGate=deferred();migrating.setGate(migrationGate);migrating.ui.restore(legacy);await new Promise(resolve=>setImmediate(resolve));const preparingMigration=migrating.ui.prepareArtwork();assert.equal(migrating.ui.makeIndependent(calibration,placement),true);migrationGate.resolve();await preparingMigration;
  const pendingLogo=page();pendingLogo.setContext(context);pendingLogo.ui.restore(legacy);assert.equal(pendingLogo.ui.makeIndependent(calibration,placement),true);await new Promise(resolve=>setImmediate(resolve));assert.equal(pendingLogo.ui.validationError(),null,'Pending original-PNG validation follows object identity across migration');
  const noReference=page();noReference.ui.restore(legacy);assert.equal(noReference.ui.makeIndependent(null,placement),false);assert.equal(noReference.ui.settings().composition_mode,'independent_objects_v1','Uncalibrated legacy projects retain their original coordinate contract');
  const independentUpload=page(),independentReadGate=deferred();independentUpload.setContext(context);independentUpload.ui.restore({objects:[],composition_mode:independentMode});independentUpload.setReadGate(independentReadGate);const independentReading=upload(independentUpload);independentUpload.element('letterAddText').emit('click');independentReadGate.resolve();await independentReading;const independentRace=independentUpload.ui.settings().objects;for(const object of independentRace)insideArea(object);assert.equal(overlaps(box(independentRace[0]),box(independentRace[1])),false);
  const independentLimit=page();independentLimit.setContext(context);independentLimit.ui.restore({objects:[],composition_mode:independentMode});for(let at=0;at<21;at++)independentLimit.element('letterAddText').emit('click');assert.equal(independentLimit.ui.settings().objects.length,20);for(const object of independentLimit.ui.settings().objects)insideArea(object);
  // Applying a new catalogue template owns a fresh sign; a historical restore
  // still owns its saved coordinate mode and individual physical dimensions.
  const presetPage=page();presetPage.setContext(context);presetPage.element('signWidth').value='.1';presetPage.element('signHeight').value='.1';
  const preset={text:'СТУДИЯ\nДИЗАЙНА',font_family:'Georgia',font_bold:false,front_color:'#123456',side_color:'#654321',depth_cm:7,brief:'Материал по согласованному образцу',line_gap_cm:3,text_align:'right',face_material:{type:'film_on_acrylic',brand:'ORACAL',series:'8500'},objects:[text('discarded-template-object')],composition_mode:'independent_objects_v1'};
  presetPage.ui.restoreNew(preset);const fresh=presetPage.ui.settings();assert.equal(fresh.composition_mode,independentMode);assert.equal(fresh.objects.length,1);assert.notEqual(fresh.objects[0].id,'discarded-template-object');assert.equal(fresh.objects[0].letter_height_cm,15);insideArea(fresh.objects[0]);
  for(const key of ['text','font_family','font_bold','front_color','side_color','depth_cm','brief','line_gap_cm','text_align','face_material'])assert.deepEqual(clone(fresh.objects[0][key]),preset[key],`New template retains ${key}`);
  assert.equal(presetPage.ui.selectedId(),fresh.objects[0].id);assert.equal(presetPage.element('letterObjectText').value,preset.text);await presetPage.ui.prepareArtwork();assert.equal(presetPage.ui.settings().objects[0].artwork.font_family_rendered,'Georgia');
  presetPage.ui.restoreNew({text:'  \n '});assert.equal(presetPage.ui.settings().objects.length,0);assert.equal(presetPage.ui.independent(),true);
  presetPage.ui.restore(legacy);assert.equal(presetPage.ui.settings().composition_mode,'independent_objects_v1');assert.deepEqual(clone(presetPage.ui.settings().objects),clone(legacy.objects),'Historical restore must not create a fresh preset sign');
  const delayedPreset=page();delayedPreset.ui.restoreNew(preset);assert.deepEqual(clone(delayedPreset.ui.draftState().pendingPlacementIds),[delayedPreset.ui.selectedId()]);delayedPreset.setContext(context);delayedPreset.ui.makeIndependent(calibration,null);insideArea(delayedPreset.ui.settings().objects[0]);assert.deepEqual(clone(delayedPreset.ui.draftState().pendingPlacementIds),[]);
  // Exercise the real Add buttons: new objects are centered on an empty scene
  // and find room around existing blocks without silently resizing the scene.
  const adding=page();adding.element('letterAddText').emit('click');let added=adding.ui.settings().objects;
  const first=clone(added[0]),firstBox=box(first);assert.equal(first.x_cm,(300-firstBox.layout.width_cm)/2);assert.equal(first.y_cm,(100-firstBox.layout.height_cm)/2);insideComposition(first);
  adding.element('letterAddText').emit('click');adding.element('letterAddText').emit('click');added=adding.ui.settings().objects;
  assert.equal(added.length,3);assert.deepEqual(clone(added[0]),first);assert.equal(adding.ui.selectedId(),added[2].id);
  for(let at=0;at<added.length;at++){insideComposition(added[at]);assert.equal(added[at].letter_height_cm,first.letter_height_cm);for(let before=0;before<at;before++)assert.equal(overlaps(box(added[at]),box(added[before])),false,'New text must use available space');}
  const unchanged=clone(added);adding.element('letterObjectText').value='А'.repeat(150);adding.element('letterObjectText').emit('input');const edited=adding.ui.settings().objects;
  assert.deepEqual(clone(edited.slice(0,2)),unchanged.slice(0,2));assert.equal(edited[2].letter_height_cm,unchanged[2].letter_height_cm);assert.equal(edited[2].x_cm,unchanged[2].x_cm);assert.equal(edited[2].y_cm,unchanged[2].y_cm);
  assert.throws(()=>G.objectsLayout({objects:edited},{width_cm:300,height_cm:100}),/не помещается/,'User text edits keep the specified size and report overflow');
  const rotated=page();rotated.ui.restore({objects:[text('rotated',{text:'АБВ',x_cm:120,y_cm:35,letter_height_cm:20,rotation_deg:35})]});const priorRotated=clone(rotated.ui.settings().objects[0]);rotated.element('letterAddText').emit('click');const rotatedScene=rotated.ui.settings().objects;
  assert.deepEqual(clone(rotatedScene[0]),priorRotated);insideComposition(rotatedScene[1]);assert.equal(overlaps(box(rotatedScene[0]),box(rotatedScene[1])),false,'Placement must account for rotation');
  // Actual file input decoding uses the supplied PNG bytes. A new logo finds
  // room; replacing it changes only the original, not its physical placement.
  const logos=page();await upload(logos);let logoScene=logos.ui.settings().objects,firstLogo=clone(logoScene[0]);assert.equal(firstLogo.x_cm,135);assert.equal(firstLogo.y_cm,42.5);insideComposition(firstLogo);
  await upload(logos);logoScene=logos.ui.settings().objects;assert.deepEqual(clone(logoScene[0]),firstLogo);insideComposition(logoScene[1]);assert.equal(overlaps(box(logoScene[0]),box(logoScene[1])),false);assert.equal(logoScene[1].artwork.data_url,firstLogo.artwork.data_url);
  const priorLogo=clone(logoScene[1]),replacement=png(100,100,'replacement');logos.element('letterObjectReplace').emit('click');logos.element('letterLogoUpload').files=[{name:'replacement.png',type:'image/png',size:100,data_url:replacement}];await logos.element('letterLogoUpload').emit('change');logoScene=logos.ui.settings().objects;
  assert.equal(logoScene[1].artwork.data_url,replacement);for(const key of ['x_cm','y_cm','width_cm','rotation_deg'])assert.equal(logoScene[1][key],priorLogo[key]);assert.deepEqual(clone(logoScene[0]),firstLogo);
  // The current scene, including texts added during a file read, controls the
  // final placement. A stale read cannot insert into a restored replacement.
  const uploadRace=page(),readGate=deferred();uploadRace.setReadGate(readGate);const reading=upload(uploadRace);uploadRace.element('letterAddText').emit('click');readGate.resolve();await reading;const raced=uploadRace.ui.settings().objects;assert.equal(raced.length,2);assert.equal(overlaps(box(raced[0]),box(raced[1])),false);
  const staleGate=deferred();uploadRace.setReadGate(staleGate);const stale=upload(uploadRace);uploadRace.ui.restore({objects:[]});staleGate.resolve();await stale;assert.equal(uploadRace.ui.settings().objects.length,0);
  // No free area: a small stagger remains inside the envelope and avoids
  // putting every block at the same coordinates, while old objects stay exact.
  const crowded=page(),cover={id:'cover',type:'logo',artwork:{name:'cover.png',mime_type:'image/png',source:'uploaded',data_url:png(300,100),width_px:300,height_px:100},width_cm:300,x_cm:0,y_cm:0,rotation_deg:0};crowded.ui.restore({objects:[cover]});await new Promise(resolve=>setImmediate(resolve));const originalCover=clone(crowded.ui.settings().objects[0]);
  for(let at=0;at<5;at++)crowded.element('letterAddText').emit('click');const crowdedScene=crowded.ui.settings().objects;assert.deepEqual(clone(crowdedScene[0]),originalCover);const positions=new Set(crowdedScene.slice(1).map(object=>`${object.x_cm},${object.y_cm}`));assert.equal(positions.size,5);for(const object of crowdedScene)insideComposition(object);
  const capped=page();for(let at=0;at<21;at++)capped.element('letterAddText').emit('click');assert.equal(capped.ui.settings().objects.length,20);assert.equal(capped.element('letterAddText').disabled,true);assert.equal(capped.element('letterAddLogo').disabled,true);for(const object of capped.ui.settings().objects)insideComposition(object);await upload(capped);assert.equal(capped.ui.settings().objects.length,20);
  const p=page();p.ui.restore({objects:[text()]});const prepared=await p.ui.prepareArtwork();
  const missingExact=page();missingExact.ui.restore({objects:[{...text(),font_family:'Arial Narrow'}]});
  assert.match(missingExact.ui.validationError(),/Arial Narrow.*недоступен/);
  await assert.rejects(missingExact.ui.prepareArtwork(),/Arial Narrow.*недоступен/);
  assert.equal(missingExact.ui.settings().objects[0].artwork,undefined,'The named narrow font cannot silently generate Arial');
  assert.equal(prepared.length,1);let saved=p.ui.settings().objects[0];assert.equal(saved.artwork.source,'text');assert.equal(saved.artwork.font_fallback,false);assert.equal(saved.artwork.font_family_rendered,'Arial');
  const initial=saved.artwork.data_url,layout=G.independentObjectLayout(saved),drawing=p.drawings.at(-1),unit=layout.font_size_cm/100;
  assert.ok(drawing.width<=4096&&drawing.height<=4096&&drawing.width*drawing.height<=16000000);assert.ok(P.artworkInfo(saved.artwork).size_bytes<=1048576);
  assert.equal(drawing.text.length,2);for(let i=0;i<2;i++){assert.equal(drawing.text[i].x*unit,layout.lines[i].x_cm);assert.equal(drawing.text[i].y*unit,layout.lines[i].baseline_cm);}
  assert.deepEqual(drawing.transform,[drawing.width/layout.width_cm*unit,0,0,drawing.height/layout.height_cm*unit,0,0]);
  // Moving/rotating/material edits preserve every PNG byte.
  p.ui.setObjectPosition('title',44,17);p.element('letterObjectRotation').value='27';p.element('letterObjectRotation').emit('input');p.element('letterObjectDepth').value='8';p.element('letterObjectDepth').emit('input');
  assert.equal(p.ui.settings().objects[0].artwork.data_url,initial);await p.ui.prepareArtwork();assert.equal(p.ui.settings().objects[0].artwork.data_url,initial);assert.equal(p.drawings.length,1);
  // Every drawing edit evicts the obsolete image immediately, before awaiting.
  for(const [field,value]of [['letterObjectText','ДРУГОЙ\nТЕКСТ'],['letterObjectFont','Georgia'],['letterObjectHeight','18'],['letterObjectGap','6'],['letterObjectAlign','center'],['letterObjectColor','#123456']]){
    p.element(field).value=value;p.element(field).emit('input');assert.equal(p.ui.settings().objects[0].artwork,undefined,field);await p.ui.prepareArtwork();assert.equal(p.ui.settings().objects[0].artwork.source,'text');
  }
  p.element('letterObjectBold').checked=false;p.element('letterObjectBold').emit('change');assert.equal(p.ui.settings().objects[0].artwork,undefined);await p.ui.prepareArtwork();
  // Fonts missing on this device are rendered by the same honest fallback stack
  // used in the preview, then locked as supplied pixels for the server.
  p.element('letterObjectFont').value='Definitely Missing Family';p.element('letterObjectFont').emit('input');await p.ui.prepareArtwork();saved=p.ui.settings().objects[0];
  assert.equal(saved.artwork.font_fallback,true);assert.equal(saved.artwork.font_family_rendered,'Arial');assert.match(p.element('letterObjectStatus').textContent,/недоступен/);
  const missing=saved.artwork.data_url;p.ui.restore({objects:[saved]});assert.equal(p.ui.settings().objects[0].artwork.data_url,missing);
  p.fontLoaded();assert.equal(p.ui.settings().objects[0].artwork,undefined,'A loaded font can change outlines even when ink metrics match');
  // A full-scene restore during the font wait cannot write into its replacement.
  const gate=deferred();p.setGate(gate);const expired=p.ui.prepareArtwork();p.ui.restore({objects:[text('replacement')]});gate.resolve();await assert.rejects(expired,/Композиция изменилась/);assert.equal(p.ui.settings().objects[0].artwork,undefined);
  const editingGate=deferred();p.setGate(editingGate);const editing=p.ui.prepareArtwork();p.element('letterObjectText').value='НОВОЕ';p.element('letterObjectText').emit('input');editingGate.resolve();await assert.rejects(editing,/Композиция изменилась/);assert.equal(p.ui.settings().objects[0].artwork,undefined);
  // Position edits during font loading are safe: they do not affect drawing.
  const movementGate=deferred();p.setGate(movementGate);const movement=p.ui.prepareArtwork();p.ui.setObjectPosition('replacement',30,18);movementGate.resolve();await movement;assert.equal(p.ui.settings().objects[0].x_cm,30);
  const concurrentGate=deferred();p.setGate(concurrentGate);const earlier=p.ui.prepareArtwork(),latest=p.ui.prepareArtwork();concurrentGate.resolve();await assert.rejects(earlier,/Композиция изменилась/);await latest;
  p.ui.restore({objects:[text('font-error')]});const failureGate=deferred();p.setGate(failureGate);const failure=p.ui.prepareArtwork();failureGate.reject(new Error('Font load failed'));await assert.rejects(failure,/Font load failed/);assert.equal(p.ui.settings().objects[0].artwork,undefined);
  p.setGate(null);p.setLarge(true);p.ui.restore({objects:[text('large')]});await p.ui.prepareArtwork();saved=p.ui.settings().objects[0];assert.ok(saved.artwork.width_px<=2300,'Oversize PNG must downsample instead of failing the generic 2 MiB gate');
  // Logos retain their supplied payload through every text preparation.
  const original={name:'actual.png',mime_type:'image/png',source:'uploaded',data_url:png(200,100,'original'),width_px:200,height_px:100};
  p.ui.restore({objects:[text(),{id:'logo',type:'logo',artwork:original,width_cm:30,x_cm:0,y_cm:0,rotation_deg:0}]});await new Promise(resolve=>setImmediate(resolve));await p.ui.prepareArtwork();assert.deepEqual(clone(p.ui.settings().objects[1].artwork),original);
  p.setRenderer('plaque');assert.deepEqual(clone(await p.ui.prepareArtwork()),[]);
  console.log('PASS: independent wall-region placement without shared dimensions, unchanged physical defaults and existing PNGs, mode/draft restoration, late calibration, faithful rotated-project migration and async identity; legacy placement/upload races/object cap; text PNG bounds/caps/cache, stale eviction, font fallback/races and immutable logos.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
