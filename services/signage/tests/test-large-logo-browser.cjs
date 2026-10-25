'use strict';
// Real PNG upload, IndexedDB and Python project store. No image generation.
const assert=require('node:assert/strict'),path=require('node:path'),{spawn}=require('node:child_process');
let playwright;
try{playwright=require('playwright');}catch{playwright=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');}
const root=path.resolve(__dirname,'..');
const python=process.env.TEST_PYTHON||'C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const fixture=String.raw`
import hashlib,io,json,sys,tempfile,threading
from pathlib import Path
from PIL import Image
sys.path.insert(0,str(Path.cwd()/'scripts'))
import render_server as app
from test_large_logos import large_logo
temp=tempfile.TemporaryDirectory(prefix='signage-large-logo-')
fixtures=[]
def add(name,raw,width,height):
    file=Path(temp.name)/name
    file.write_bytes(raw)
    fixtures.append({'file':str(file),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'size':[width,height]})
for name,size in [('wide.png',(10000,2000)),('tall.png',(2000,10000))]:
    artwork,raw=large_logo(size)
    add(name,raw,*size)
# Transparency exists only in the last partial tile, beyond common canvas limits.
edge=Image.new('RGBA',(40000,2),'#127daa')
edge.putpixel((39999,1),(0,0,0,0))
stream=io.BytesIO();edge.save(stream,format='PNG')
add('extra-wide.png',stream.getvalue(),40000,2)
Original=app.Handler
class Handler(Original):
    def route(self,method):
        if not self.path.startswith('/signs/'):
            return self.respond(404,{'error':'Fixture requires /signs/'})
        self.path=self.path[len('/signs'):]
        return getattr(Original,'do_'+method)(self)
    def do_GET(self):return self.route('GET')
    def do_POST(self):return self.route('POST')
    def do_PUT(self):return self.route('PUT')
def renderer(*args,**kwargs):raise AssertionError('No AI in browser QA')
server=app.create_server(0,Path(temp.name)/'jobs',renderer=renderer,status_reader=lambda:{'configured':False})
server.RequestHandlerClass=Handler
threading.Thread(target=server.serve_forever,daemon=True).start()
print(json.dumps({'port':server.server_port,'fixtures':fixtures}),flush=True)
try:sys.stdin.read()
finally:
    server.shutdown()
    server.server_close()
    temp.cleanup()
`;
async function main(){
  const child=spawn(python,['-u','-c',fixture],{cwd:root,stdio:['pipe','pipe','pipe'],windowsHide:true});
  let stderr='',stdout='',browser;
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  try{
    const info=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Fixture timeout: '+stderr)),20000);
      child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Fixture exited ${code}: ${stderr}`));});
      child.stdout.on('data',chunk=>{stdout+=chunk;try{const info=JSON.parse(stdout.split('\n')[0]);clearTimeout(timer);resolve(info);}catch{}});
    });
    browser=await playwright.chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'msedge',headless:true});
    const errors=[],contexts=[];
    const ready=async page=>{await page.waitForFunction(()=>window.SignageWorkspace&&window.SignageEditor);await page.evaluate(()=>Promise.all([SignageDraft.ready,SignageWorkspace.ready,SignageGeneration.ready,SignageInterface.ready]));};
    const newPage=async()=>{const context=await browser.newContext({viewport:{width:1280,height:900}});contexts.push(context);const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));return page;};
    const page=await newPage(),url=`http://127.0.0.1:${info.port}/signs/calibrator.html`;
    await page.goto(url+'?newProject=1');await ready(page);
    await page.click('#demo');await page.waitForFunction(()=>SignageEditor.snapshot().hasPhoto);
    await page.evaluate(()=>document.getElementById('letterAddLogo').click());
    await page.setInputFiles('#letterLogoUpload',info.fixtures[0].file);
    await page.waitForFunction(()=>SignageLetterUI.settings().objects.some(o=>o.type==='logo'));
    const verify=async (page,expected=info.fixtures[0])=>{
      const result=await page.evaluate(async()=>{
        const logo=SignageLetterUI.settings().objects.find(o=>o.type==='logo');
        const binary=atob(logo.artwork.data_url.split(',')[1]),raw=new Uint8Array(binary.length);
        for(let i=0;i<binary.length;i++)raw[i]=binary.charCodeAt(i);
        const sha=await crypto.subtle.digest('SHA-256',raw);
        return {bytes:raw.byteLength,sha256:Array.from(new Uint8Array(sha),b=>b.toString(16).padStart(2,'0')).join(''),width:logo.artwork.width_px,height:logo.artwork.height_px};
      });
      assert.equal(result.sha256,expected.sha256);assert.equal(result.bytes,expected.bytes);
      assert.deepEqual([result.width,result.height],expected.size);
    };
    await verify(page);
    assert.equal(await page.evaluate(async()=>{await SignageDraft.flush();return SignageWorkspace.flush();}),true);
    const identity=await page.evaluate(()=>SignageWorkspace.context().id);
    await page.reload();await ready(page);
    await page.waitForFunction(()=>SignageLetterUI.settings().objects.some(o=>o.type==='logo'));await verify(page);
    const remote=await newPage();await remote.goto(url+'?restoreProject='+encodeURIComponent(identity));await ready(remote);
    await remote.waitForFunction(()=>SignageLetterUI.settings().objects.some(o=>o.type==='logo'));await verify(remote);
    for(const expected of info.fixtures.slice(1)){
      await remote.evaluate(()=>{const logo=SignageLetterUI.settings().objects.find(o=>o.type==='logo');SignageLetterUI.select(logo.id);document.getElementById('letterObjectReplace').click();});
      await remote.setInputFiles('#letterLogoUpload',expected.file);
      await remote.waitForFunction(size=>{const logo=SignageLetterUI.settings().objects.find(o=>o.type==='logo');return logo?.artwork.width_px===size[0]&&logo.artwork.height_px===size[1];},expected.size);
      await verify(remote,expected);
      assert.equal(await remote.evaluate(async()=>{await SignageDraft.flush();return SignageWorkspace.flush();}),true);
      await remote.reload();await ready(remote);await verify(remote,expected);
    }
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:true,fixtures:info.fixtures.map(({file,...item})=>item),upload:true,localReload:true,serverRestore:true,replace:true,errors}));
  }finally{if(browser)await browser.close();child.stdin.end();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
