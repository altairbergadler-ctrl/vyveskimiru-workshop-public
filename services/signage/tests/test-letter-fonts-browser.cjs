'use strict';
// Real browser, font files, Canvas metrics, exact PNGs and Python workspace.
// The generation request is intercepted before it can consume an AI call.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createHash}=require('node:crypto');
const {startFixture,ready,flush}=require('./test-project-history-browser.cjs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const output=path.resolve(__dirname,'../output/qa-letter-fonts-20261014');
const sha=value=>createHash('sha256').update(value).digest('hex');
async function setup(page,url){
  await page.goto(url+'?newProject=1');await ready(page);await page.click('#demo');
  await page.waitForFunction(()=>SignageEditor.snapshot().report?.placement);
  await page.evaluate(async()=>{
    const snap=SignageEditor.draftSnapshot(),params={...snap.project.sign};
    params.composition_mode='independent_signs_v1';
    params.objects=[{id:'detailing-font-test',type:'text',text:'ДЕТЕЙЛИНГ',font_family:'Arial',font_bold:true,
      height_basis:'body',height_reference:'auto',letter_height_cm:50,line_gap_cm:0,text_align:'left',
      front_color:'#fff3dc',side_color:'#292f30',depth_cm:5,brief:'',x_cm:225,y_cm:260,rotation_deg:0}];
    params.text='ДЕТЕЙЛИНГ';snap.project.sign=params;snap.project.products[0].params=JSON.parse(JSON.stringify(params));
    snap.project.products[0].placement=null;snap.project.placement=null;
    snap.project.calibration={mode:'frontoparallel',frontoparallel_assumed:true,length_cm:100,image_points:[[150,500],[250,500]]};
    snap.project.target_polygon_px=[[150,235],[1050,235],[1050,425],[150,425]];
    snap.project.generation={engine:'codex',lighting:'original',edit_polygon_px:snap.project.target_polygon_px,geometry_lock:true};
    snap.photo=SignageEditor.photoPng();snap.ui={};snap.letterUi={selectedId:'detailing-font-test',pendingPlacementIds:[]};
    await SignageEditor.restoreDraft(snap);SignageInterface.setStep('3');
  });
}
async function capture(page){
  await page.waitForFunction(()=>!SignageLetterUI.validationError());
  return page.evaluate(async()=>{
    await SignageProductUI.prepareArtwork();SignageEditor.render();
    const snapshot=SignageEditor.snapshot(),object=snapshot.project.products[0].params.objects[0];
    return {object,layout:LetterGeometry.independentObjectLayout(object),project:snapshot.project,photo:SignageEditor.photoPng()};
  });
}
async function main(){
  fs.mkdirSync(output,{recursive:true});const fixture=await startFixture();
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
  const result={fonts:[],errors:[],viewports:[]},url=fixture.address+'/signs/calibrator.html';
  page.on('pageerror',e=>result.errors.push(e.message));
  try{
    await setup(page,url);
    for(const [font,bold] of [['Arial',true],['Arial Narrow',true],['PT Sans Narrow',true],['PT Sans Narrow',false]]){
      await page.selectOption('#letterFontPicker',font);await page.locator('#letterObjectBold').setChecked(bold);
      const state=await capture(page),object=state.object;
      assert.equal(object.font_family,font);assert.equal(object.font_bold,bold);assert.equal(object.letter_height_cm,50);
      assert.equal(object.artwork.font_family_rendered,font);assert.equal(object.artwork.font_fallback,false);
      assert.equal(state.layout.body_height_cm,50);
      result.fonts.push({font,bold,width_cm:state.layout.width_cm,full_height_cm:state.layout.height_cm,png_sha256:sha(object.artwork.data_url)});
      fs.writeFileSync(path.join(output,`payload-${font.replaceAll(' ','-')}-${bold?'bold':'regular'}.json`),JSON.stringify({project:state.project,photo:state.photo}));
      if(bold)await page.screenshot({path:path.join(output,`${font.replaceAll(' ','-')}.png`),fullPage:true});
    }
    assert.equal(new Set(result.fonts.map(f=>f.png_sha256)).size,4,'Font or weight changes produce different actual pixels');
    assert.ok(result.fonts[0].width_cm>400);assert.ok(result.fonts[1].width_cm<352);
    assert.ok(result.fonts[2].width_cm>310&&result.fonts[2].width_cm<325);
    await page.locator('#letterObjectBold').check();const saved=await capture(page);await flush(page);
    const id=await page.evaluate(()=>SignageWorkspace.context().id);
    const otherContext=await browser.newContext({viewport:{width:1280,height:900}}),other=await otherContext.newPage();
    await other.goto(url+'?restoreProject='+id);await ready(other);const restored=await capture(other);
    assert.deepEqual(restored.object,saved.object);result.restore_same_png=true;
    page.once('dialog',dialog=>dialog.accept());await page.reload();await ready(page);assert.deepEqual((await capture(page)).object,saved.object);
    await page.evaluate(()=>SignageInterface.setStep('4'));
    let sent;await page.route('**/api/jobs',async route=>{sent=route.request().postDataJSON();await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'QA intercepted; no AI request'})});});
    await page.click('#generate');await page.waitForFunction(()=>document.body.textContent.includes('QA intercepted'));
    assert.ok(sent);const transmitted=sent.project.products[0].params.objects[0];
    assert.deepEqual(transmitted,saved.object);fs.writeFileSync(path.join(output,'generation-payload.json'),JSON.stringify(sent));
    result.generation_payload={font:transmitted.font_family,bold:transmitted.font_bold,png_sha256:sha(transmitted.artwork.data_url)};
    await other.evaluate(()=>SignageInterface.setStep('3'));
    for(const width of [390,320]){
      await other.setViewportSize({width,height:844});
      const check=await other.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));
      assert.ok(check.scrollWidth<=width,JSON.stringify(check));result.viewports.push(check);
      await other.screenshot({path:path.join(output,`mobile-${width}.png`),fullPage:true});
    }
    // A delayed font completion cannot change a more recent choice.
    const delayedContext=await browser.newContext(),delayed=await delayedContext.newPage();let release;
    const gate=new Promise(resolve=>release=resolve);
    await delayed.route('**/fonts/*.ttf',async route=>{await gate;await route.continue();});await setup(delayed,url);
    await delayed.selectOption('#letterFontPicker','PT Sans Narrow');
    await delayed.waitForFunction(()=>SignageLetterUI.validationError()?.includes('Загружаем'));
    await delayed.selectOption('#letterFontPicker','Arial Narrow');release();
    await delayed.evaluate(()=>document.fonts.ready);const latest=await capture(delayed);assert.equal(latest.object.font_family,'Arial Narrow');result.font_loading_race=true;
    // Missing bundled font bytes may not silently generate substituted Arial.
    const failureContext=await browser.newContext(),failure=await failureContext.newPage();
    await failure.route('**/fonts/*.ttf',route=>route.abort());await setup(failure,url);
    await failure.selectOption('#letterFontPicker','PT Sans Narrow');
    await failure.waitForFunction(()=>SignageLetterUI.validationError()?.includes('Не удалось загрузить'));
    const failureMessage=await failure.evaluate(()=>SignageLetterUI.prepareArtwork().then(()=>null,e=>e.message));
    assert.match(failureMessage,/Не удалось загрузить/);result.font_load_failure_blocked=true;
    const fixtureState=await(await fetch(fixture.address+'/__qa/state')).json();assert.equal(fixtureState.render_calls,0);result.ai_calls=0;
    assert.deepEqual(result.errors,[]);result.passed=true;console.log(JSON.stringify(result,null,2));
  }finally{fs.writeFileSync(path.join(output,'browser-result.json'),JSON.stringify(result,null,2));await browser.close();fixture.stop();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
