const {chromium}=require('C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const base=process.argv[2]||'http://127.0.0.1:18894/';
const out=path.join(__dirname,base.startsWith('https:')?'tryon-live':'tryon-local');fs.mkdirSync(out,{recursive:true});
(async()=>{
  const browser=await chromium.launch({headless:true,channel:'msedge'});
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});const page=await context.newPage();
    const errors=[],failed=[],external=[],uploads=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    page.on('response',r=>{if(r.status()>=400)failed.push({url:r.url(),status:r.status()});});
    page.on('request',r=>{if(!r.url().startsWith('blob:')&&!r.url().startsWith('data:')&&new URL(r.url()).origin!==new URL(base).origin)external.push(r.url());if(r.method()==='POST'||r.method()==='PUT')uploads.push(r.url());});
    await page.goto(base,{waitUntil:'networkidle'});await page.locator('#search').fill('Montserrat');await page.locator('#lettering').fill('КОФЕЙНЯ ЁЖ');await page.waitForTimeout(350);
    await page.getByRole('button',{name:'Рассмотреть',exact:true}).first().click();await page.locator('#try-photo').click();
    await page.waitForURL('**/tryon.html?mode=photo*');await page.waitForFunction(()=>document.querySelector('#photo-panel').hidden===false);
    assert((await page.locator('#selection-summary').innerText()).includes('Montserrat'));
    assert((await page.locator('#selection-summary').innerText()).includes('КОФЕЙНЯ ЁЖ'));
    assert.equal(await page.locator('#camera-file').getAttribute('capture'),'environment');
    const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=1200;c.height=800;const x=c.getContext('2d');x.fillStyle='#d5cdbd';x.fillRect(0,0,1200,800);x.fillStyle='#73828a';x.fillRect(80,400,330,400);x.fillRect(780,400,330,400);x.strokeStyle='#b8ad99';x.lineWidth=2;for(let y=0;y<800;y+=70){x.beginPath();x.moveTo(0,y);x.lineTo(1200,y);x.stroke();}return c.toDataURL().split(',')[1];});
    const fixture=path.join(out,'test-wall.png');fs.writeFileSync(fixture,Buffer.from(image,'base64'));
    await page.locator('#photo-file').setInputFiles(fixture);await page.waitForFunction(()=>document.querySelector('#photo-controls').disabled===false);await page.waitForTimeout(150);
    const snapshot=()=>page.locator('#photo-canvas').evaluate(c=>c.toDataURL());const first=await snapshot();
    await page.locator('#photo-scale').fill('130');await page.locator('#photo-rotation').fill('-10');await page.waitForTimeout(150);assert.notEqual(await snapshot(),first);
    const box=await page.locator('#photo-canvas').boundingBox();await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.6,box.y+box.height*.4,{steps:6});await page.mouse.up();
    const moved=await snapshot();await page.locator('#photo-canvas').press('ArrowRight');await page.waitForTimeout(100);assert.notEqual(await snapshot(),moved,'keyboard reposition');
    await page.locator('#photo-reset').click();await page.waitForTimeout(100);assert.equal(await snapshot(),first,'reset');
    // Pull a known top-left handle to alter perspective.
    const handle=await page.locator('#photo-canvas').evaluate(c=>{const x=c.getContext('2d'),d=x.getImageData(0,0,c.width,c.height).data;for(let y=0;y<c.height;y++)for(let px=0;px<c.width;px++){const i=(y*c.width+px)*4;if(d[i]===237&&d[i+1]===171&&d[i+2]===67)return {x:px/c.width,y:y/c.height};}});
    assert(handle,'editable corner visible');await page.mouse.move(box.x+handle.x*box.width,box.y+handle.y*box.height+3);await page.mouse.down();await page.mouse.move(box.x+handle.x*box.width+30,box.y+handle.y*box.height+40,{steps:5});await page.mouse.up();await page.waitForTimeout(100);assert.notEqual(await snapshot(),first,'perspective corner drag');
    await page.screenshot({path:path.join(out,'photo-desktop.png'),fullPage:true});
    const download=page.waitForEvent('download');await page.locator('#photo-save').click();const saved=await download;await saved.saveAs(path.join(out,'photo-export.png'));assert(fs.statSync(path.join(out,'photo-export.png')).size>15000);
    const beforeInvalid=await snapshot();await page.locator('#photo-file').setInputFiles({name:'broken.png',mimeType:'image/png',buffer:Buffer.from('not an image')});await page.waitForFunction(()=>document.querySelector('#photo-status').textContent.includes('Не удалось'));assert.equal(await snapshot(),beforeInvalid,'invalid file preserves current photo');
    await page.locator('#tab-ar').click();await page.waitForFunction(()=>document.querySelector('#ar-viewer').dataset.ready==='true',{},{timeout:60000});
    assert((await page.locator('#ar-status').innerText()).includes('AR недоступен'));
    const dimensions=await page.locator('#ar-viewer').evaluate(v=>({size:v.getDimensions(),wall:v.arPlacement,scale:v.arScale,modes:v.arModes,iosSrc:v.iosSrc}));
    assert.equal(dimensions.wall,'wall');assert.equal(dimensions.scale,'fixed');assert(dimensions.size.x>1);assert(Math.abs(dimensions.size.z-.05)<.0001);assert(dimensions.iosSrc.startsWith('blob:'));
    const iosBytes=await page.locator('#ar-viewer').evaluate(async v=>Array.from(new Uint8Array(await(await fetch(v.iosSrc)).arrayBuffer())));fs.writeFileSync(path.join(out,'selected-wall.usdz'),Buffer.from(iosBytes));
    await page.screenshot({path:path.join(out,'ar-desktop.png'),fullPage:true});
    for(const width of [390,320]){
      await page.setViewportSize({width,height:844});await page.screenshot({path:path.join(out,`ar-${width}.png`),fullPage:true});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${width}px AR no overflow`);
      await page.locator('#tab-photo').click();await page.waitForTimeout(150);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${width}px photo no overflow`);
      await page.screenshot({path:path.join(out,`photo-${width}.png`),fullPage:true});await page.locator('#tab-ar').click();
    }
    await page.locator('#back-link').click();await page.waitForFunction(()=>document.querySelector('#detail-dialog').open);assert.equal(await page.locator('#detail-title').innerText(),'Montserrat');assert.equal(await page.locator('#lettering').inputValue(),'КОФЕЙНЯ ЁЖ');
    await page.locator('#try-ar').click();await page.waitForFunction(()=>document.querySelector('#ar-viewer').dataset.ready==='true',{},{timeout:60000});
    await page.goto(new URL('tryon.html',base).href);await page.waitForFunction(()=>!document.querySelector('#fatal-error').hidden);assert.equal(await page.locator('#tab-ar').isDisabled(),true);
    assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);assert.deepEqual(external,[]);assert.deepEqual(uploads,[]);
    const result={base,date:new Date().toISOString(),errors,failed,external,uploads,dimensions,checks:['selected text and font','photo local only','photo scale rotation drag perspective reset','PNG download','invalid image preserves photo','AR GLB renders','wall placement and fixed scale','USDZ generated','desktop unsupported fallback','390 and 320 responsive','catalog return preserves selection','missing selection handled'],physicalPhoneAR:'not tested'};
    fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
