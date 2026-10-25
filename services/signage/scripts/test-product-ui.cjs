'use strict';
// Real browser regression for product forms, exact originals, local type drafts,
// fast reload, legacy imports and composite generation without Codex. Server is
// isolated and image jobs are fixtures; no real subscription request is made.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {packArtworkMetadata,hydrateArtworkMetadata}=require('../assets/draft.js');
let playwright;
try{playwright=require('playwright');}catch{playwright=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');}
const assets=path.resolve(__dirname,'../assets'),requests=[],projects=new Map();let savedProject,jobId,legacyProject,savedProjectId;
const legacyId='legacy-result-0000000001';
const tinyPNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=','base64');
const server=http.createServer(async(req,res)=>{
  try{
  const url=new URL(req.url,'http://localhost'),endpoint=url.pathname.replace(/^\/signs\//,'');
  const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(endpoint==='catalog.js'){res.writeHead(200,{'Content-Type':'application/javascript'});return res.end('globalThis.SignageCatalog='+fs.readFileSync(path.join(assets,'product-catalog.json'),'utf8')+';');}
  if(endpoint==='api/config')return json({token:'test-token',configured:false,provider:'codex',composite_configured:true});
  if(endpoint==='api/projects')return json({items:[],total:0});
  const projectMatch=/^api\/projects\/([a-zA-Z0-9_-]{16,96})$/.exec(endpoint);
  if(projectMatch){
    const id=projectMatch[1],previous=projects.get(id);
    if(req.method==='POST'){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const payload=JSON.parse(Buffer.concat(chunks));
      if(payload.base_revision!==(previous?.revision||0))return json({error:'Project revision conflict'},409);
      const record={id,name:payload.name,revision:(previous?.revision||0)+1,snapshot:payload.snapshot,generation:payload.generation};projects.set(id,record);return json(record);
    }
    return previous?json(previous):json({error:'Project not found'},404);
  }
  if(endpoint==='api/jobs'&&req.method==='POST'){
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const payload=JSON.parse(Buffer.concat(chunks));requests.push(payload);savedProject=payload.project;savedProjectId=payload.project_id;jobId=payload.request_id;return json({id:jobId,project_id:savedProjectId,status:'complete'});
  }
  if(endpoint===`api/jobs/${jobId}/project.json`)return json(savedProject);
  if(endpoint===`api/jobs/${legacyId}/project.json`)return json(legacyProject);
  if(endpoint.startsWith('api/jobs/')&&endpoint.endsWith('.png')){res.writeHead(200,{'Content-Type':'image/png'});return res.end(tinyPNG);}
  if(endpoint===`api/jobs/${jobId}`||endpoint===`api/jobs/${legacyId}`)return json({id:endpoint.endsWith(legacyId)?legacyId:jobId,project_id:savedProjectId,status:'complete',created:1,lighting:'original',audit:{canvas_size_px:[1200,780],changed_pixels_outside_edit_zone:0,exact_artwork:!endpoint.endsWith(legacyId)}});
  const target=path.resolve(assets,endpoint);if(!target.startsWith(assets+path.sep)||!fs.existsSync(target)||!fs.statSync(target).isFile())return json({error:'not found'},404);
  res.writeHead(200,{'Content-Type':target.endsWith('.html')?'text/html; charset=utf-8':target.endsWith('.css')?'text/css':target.endsWith('.js')?'application/javascript':'application/octet-stream'});fs.createReadStream(target).pipe(res);
  }catch(error){if(req.aborted||error.code==='ECONNRESET')return;res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
});
async function main(){
  // PNGs stay in IDB while tiny references allow the latest form metadata to be
  // journaled. Uncommitted uploads cannot be substituted by a different source.
  const artwork={name:'original.png',mime_type:'image/png',source:'uploaded',data_url:'data:image/png;base64,'+'A'.repeat(900000)},record={project:{products:[{artwork}]}};
  const packed=packArtworkMetadata(record);assert.ok(JSON.stringify(packed).length<500);assert.deepEqual(hydrateArtworkMetadata(packed,record),record);
  assert.throws(()=>hydrateArtworkMetadata(packed,{}),/оригинал/);
  const textPacked=packArtworkMetadata({artwork:{...artwork,source:'text'}});assert.deepEqual(hydrateArtworkMetadata(textPacked,{}),{});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await playwright.chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'msedge',headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    const address=`http://127.0.0.1:${server.address().port}/signs/calibrator.html`;
    const step = async (target, number) => {await target.evaluate(()=>SignageInterface.ready);await target.click('#interfaceSteps [data-interface-step-button="'+number+'"]');};
    const edit = async target => {await step(target,3);if(await target.locator('#interfaceProductionToggle').isVisible() && await target.locator('#interfaceProductionToggle').getAttribute('aria-expanded')==='false')await target.click('#interfaceProductionToggle');};
    await page.goto(address);await page.evaluate(()=>SignageInterface.ready);
    await page.click('#demo');await page.waitForFunction(()=>SignageEditor.snapshot().report?.placement);
    const legacy=await page.evaluate(()=>{const p=SignageEditor.snapshot().project;return {...p,version:1,products:undefined,active_product_id:undefined};});
    delete legacy.generation.engine;legacy.calibration.custom_provenance='retain-calibration';legacy.ruler.custom_provenance='retain-ruler';legacy.generation.custom_provenance='retain-generation';legacy.sign.face_material.custom_provenance='retain-material';legacyProject=legacy;
    assert.equal((await page.evaluate(()=>SignageEditor.snapshot().project)).products[0].type,'channel_letters');
    await edit(page);
    await page.click('[data-product-type="plaque"]');await edit(page);await page.fill('#text','РЕЖИМ РАБОТЫ\n10:00–19:00');await page.fill('#plaqueThickness','4');
    await page.evaluate(()=>{SignageEditor.setPlacement({center_px:[594,294],width_cm:120,height_cm:30,rotation_deg:0});SignageEditor.render();});
    await page.waitForFunction(()=>SignageEditor.snapshot().project.products[0].artwork?.source==='text');
    await page.click('[data-product-type="neon"]');await page.fill('#text','НЕОН МОЙ');await page.fill('#neonTubing','10');await page.waitForTimeout(250);
    await page.click('[data-product-type="plaque"]');assert.equal(await page.inputValue('#text'),'РЕЖИМ РАБОТЫ\n10:00–19:00');assert.equal(await page.inputValue('#plaqueThickness'),'4');
    const originalURL=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=500;c.height=400;const x=c.getContext('2d'),data=x.createImageData(c.width,c.height);let seed=123456789;for(let i=0;i<data.data.length;i+=4){seed=(Math.imul(seed,1664525)+1013904223)>>>0;data.data[i]=seed&255;data.data[i+1]=(seed>>>8)&255;data.data[i+2]=(seed>>>16)&255;data.data[i+3]=255;}x.putImageData(data,0,0);return c.toDataURL('image/png');});
    await page.selectOption('#artworkSource','uploaded');await page.setInputFiles('#artworkUpload',{name:'actual-original.png',mimeType:'image/png',buffer:Buffer.from(originalURL.split(',')[1],'base64')});
    await page.waitForFunction(()=>SignageEditor.snapshot().project.products[0].artwork?.source==='uploaded');
    await page.fill('#text','ИЗМЕНЕНИЕ НЕ ЗАМЕНЯЕТ ОРИГИНАЛ');await page.fill('#font','Georgia');await page.waitForTimeout(300);
    let snapshot=await page.evaluate(()=>SignageEditor.snapshot());assert.equal(snapshot.project.products[0].artwork.data_url,originalURL);assert.equal(snapshot.project.products.length,1);assert.equal(snapshot.project.product_drafts,undefined);
    await page.selectOption('#plaqueMaterial','metal');snapshot=await page.evaluate(()=>SignageEditor.snapshot());assert.equal(snapshot.project.products[0].params.material,'metal');assert.equal(snapshot.project.products[0].artwork.data_url,originalURL);
    await page.evaluate(()=>SignageDraft.flush());
    // Flush the original first, then reload immediately after a parameter edit.
    // The journal must restore the new text without repeating the PNG payload.
    await page.evaluate(()=>{document.getElementById('text').value='БЫСТРОЕ ОБНОВЛЕНИЕ';document.getElementById('text').dispatchEvent(new Event('input',{bubbles:true}));});
    await page.reload();await page.evaluate(()=>SignageDraft.ready);assert.equal(await page.inputValue('#text'),'БЫСТРОЕ ОБНОВЛЕНИЕ');assert.equal(await page.inputValue('#artworkSource'),'uploaded');
    snapshot=await page.evaluate(()=>SignageEditor.snapshot());assert.equal(snapshot.project.products[0].artwork.data_url,originalURL);
    const journalSize=await page.evaluate(()=>localStorage.getItem('signage-draft-journal:/signs/').length);assert.ok(journalSize<512*1024,`Artwork leaked into journal: ${journalSize}`);
    // An immediate reload can interrupt the server-save acknowledgement. The
    // journal assertions above verify the local edits; retain them in a copy
    // before testing generation, just as the conflict recovery UI offers.
    await page.evaluate(async()=>{await SignageWorkspace.ready;if(SignageWorkspace.state().conflict && !await SignageWorkspace.copy())throw new Error('Fixture conflict recovery failed');});
    await edit(page);
    await page.click('[data-product-type="neon"]');assert.equal(await page.inputValue('#text'),'НЕОН МОЙ');assert.equal(await page.inputValue('#neonTubing'),'10');
    await page.click('[data-product-type="plaque"]');assert.equal(await page.inputValue('#text'),'БЫСТРОЕ ОБНОВЛЕНИЕ');assert.equal((await page.evaluate(()=>SignageEditor.snapshot().project)).products[0].artwork.data_url,originalURL);
    await page.selectOption('#artworkSource','text');await page.waitForFunction(()=>SignageEditor.snapshot().project.products[0].artwork?.source==='text');assert.notEqual((await page.evaluate(()=>SignageEditor.snapshot().project)).products[0].artwork.data_url,originalURL);
    // A text edit immediately followed by type switching must retain the dirty
    // signature and rebuild the PNG when that product is selected again.
    const beforeFastSwitch=await page.evaluate(()=>SignageEditor.snapshot().project.products[0].artwork.data_url);
    await page.evaluate(()=>{const t=document.getElementById('text');t.value='НОВЫЙ ТЕКСТ ПОСЛЕ БЫСТРОГО ПЕРЕКЛЮЧЕНИЯ';t.dispatchEvent(new Event('input',{bubbles:true}));SignageProductUI.switchType('neon');SignageProductUI.switchType('plaque');return SignageProductUI.prepareArtwork();});
    assert.notEqual((await page.evaluate(()=>SignageEditor.snapshot().project)).products[0].artwork.data_url,beforeFastSwitch);
    const downloadPromise=page.waitForEvent('download');
    await page.evaluate(()=>{const t=document.getElementById('text');t.value='ЭКСПОРТ СРАЗУ ПОСЛЕ ПРАВКИ';t.dispatchEvent(new Event('input',{bubbles:true}));return document.getElementById('exportProject').onclick();});
    const exported=JSON.parse(fs.readFileSync(await (await downloadPromise).path(),'utf8'));
    assert.equal(exported.products[0].params.text,'ЭКСПОРТ СРАЗУ ПОСЛЕ ПРАВКИ');assert.equal(exported.products[0].artwork.data_url,(await page.evaluate(()=>SignageEditor.snapshot().project)).products[0].artwork.data_url);
    let extraDownloads=0;page.on('download',()=>extraDownloads++);
    await page.evaluate(async()=>{document.getElementById('lineGap').value='2000';document.getElementById('lineGap').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('text').value='СТРОКА\nЕЩЁ СТРОКА';document.getElementById('text').dispatchEvent(new Event('input',{bubbles:true}));await document.getElementById('exportProject').onclick();await document.getElementById('downloadArtwork').onclick();});
    assert.equal(extraDownloads,0,'Invalid layout exported an obsolete text PNG');
    await page.fill('#lineGap','2');await page.fill('#text','ГОТОВЫЙ МАКЕТ');await page.waitForTimeout(250);
    await step(page,4);
    await page.waitForFunction(()=>!document.getElementById('generate').disabled);assert.equal(await page.locator('#subscriptionSettings').count(),0);
    await page.click('#generate');await page.waitForFunction(()=>!document.getElementById('aiResult').hidden);assert.equal(requests.length,1);assert.equal(requests[0].project.generation.engine,'composite');assert.equal(requests[0].project.products[0].type,'plaque');assert.equal(requests[0].project.products[0].artwork.source,'text');
    // Unsupported imports fail before replacing the currently open product.
    await page.setInputFiles('#import',{name:'invalid.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({version:3}))});await page.waitForFunction(()=>document.getElementById('warnings').textContent.includes('Не удалось открыть проект'));assert.equal((await page.evaluate(()=>SignageEditor.snapshot().project)).products[0].type,'plaque');
    await page.setInputFiles('#import',{name:'legacy.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(legacy))});await page.waitForFunction(()=>SignageEditor.snapshot().project.products[0].type==='channel_letters');assert.equal(await page.inputValue('#text'),'КОФЕ');assert.equal(await page.locator('#corelSection').isVisible(),true);
    snapshot=await page.evaluate(()=>SignageEditor.snapshot());assert.equal(snapshot.project.calibration.custom_provenance,'retain-calibration');assert.equal(snapshot.project.ruler.custom_provenance,'retain-ruler');assert.equal(snapshot.project.generation.custom_provenance,'retain-generation');assert.equal(snapshot.project.products[0].params.face_material.custom_provenance,'retain-material');
    await page.evaluate(id=>SignageGeneration.restoreDraft({version:1,jobId:id,view:'render',photoMatchesResult:true,pendingJobId:null,pendingPhotoMatches:false}),legacyId);
    assert.equal(await page.locator('#resultStale').isVisible(),false,'Unchanged migrated v1 history result was incorrectly marked stale');
    await edit(page);await page.fill(await page.locator('#letterObjectText').isVisible()?'#letterObjectText':'#text','ТЕКСТ ИЗМЕНЁН');await step(page,4);assert.equal(await page.locator('#resultStale').isVisible(),true,'Changed migrated result was incorrectly marked current');
    for(const width of [390,320]){await page.setViewportSize({width,height:844});await page.waitForTimeout(60);const sizes=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(sizes.scroll<=sizes.width,`Overflow at ${width}: ${sizes.scroll}`);}
    const unplacedContext=await browser.newContext(),unplaced=await unplacedContext.newPage();await unplaced.goto(address);await unplaced.evaluate(()=>SignageDraft.ready);
    await edit(unplaced);
    await unplaced.click('[data-product-type="plaque"]');await unplaced.fill('#signWidth','55');await unplaced.fill('#signHeight','34');await unplaced.click('[data-product-type="neon"]');
    await unplaced.evaluate(()=>{SignageEditor.setPlacement({center_px:[100,100],width_cm:100,height_cm:35,rotation_deg:0});SignageEditor.render();});
    await unplaced.click('[data-product-type="plaque"]');assert.equal(await unplaced.inputValue('#signWidth'),'55');assert.equal(await unplaced.inputValue('#signHeight'),'34');await unplacedContext.close();
    assert.deepEqual(errors,[]);await context.close();
    console.log('PASS: real product UI — original PNG immutable, type switching/reload, compact journal, stale-text signatures and immediate exports, rejected invalid layout exports, legacy history comparison/provenance, malformed import, composite without Codex, one request, 320/390px and no errors.');
  }finally{await browser.close();server.close();}
}
main().catch(error=>{console.error(error);server.close();process.exitCode=1;});
