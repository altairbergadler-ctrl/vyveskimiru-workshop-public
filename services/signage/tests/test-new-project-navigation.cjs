'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const Products = require('../assets/products.js');
const source = fs.readFileSync(path.join(__dirname, '../assets/project-workspace.js'), 'utf8');
const tick = async () => {for (let n=0;n<5;n++) await new Promise(resolve=>setImmediate(resolve));};
const deferred = () => {let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
class Events {
  constructor(){this.listeners=new Map();}
  addEventListener(type,fn){const all=this.listeners.get(type)||[];all.push(fn);this.listeners.set(type,all);}
  dispatchEvent(event){for(const fn of this.listeners.get(event.type)||[])fn(event);}
  async trigger(type){const results=await Promise.all((this.listeners.get(type)||[]).map(fn=>fn(new Event(type))));return results.at(-1);}
}
class Element extends Events {
  constructor(label=''){super();this.value='';this.textContent=label;this.classList={toggle(){}};}
}
async function run({early=true,failSave=false}={}){
  const document=new Events(),window=new Events(),elements=new Map(),gate=deferred(),navigations=[],posts=[],order=[];
  const element=id=>{if(!elements.has(id))elements.set(id,new Element(id==='newServerProject'?'Новый проект':''));return elements.get(id);};
  document.getElementById=element;document.querySelector=()=>null;
  window.document=document;window.SignageProducts=Products;window.location={href:'https://example.test/signs/?restoreProject=previous-project-0001',search:'?restoreProject=previous-project-0001',assign:url=>{order.push('navigate');navigations.push(String(url));}};
  window.history={replaceState(){}};window.crypto={randomUUID:()=> 'new-project-00000001'};
  let saved={photo:'data:image/png;base64,original',project:{text:'Previous'},workspace:{id:'previous-project-0001'}},photo=false;
  window.SignageEditor={snapshot:()=>({hasPhoto:photo}),draftSnapshot:()=>saved,restoreDraft:async value=>{saved=value;photo=true;}};
  window.SignageGeneration={ready:Promise.resolve(),draftState:()=>null,restoreDraft:async()=>{}};
  window.SignageDraft={ready:gate.promise,flush:async()=>{order.push('local-save');}};
  const fetch=async (_url,options={})=>{
    const url=String(_url);
    if(url.endsWith('api/config'))return {ok:true,json:async()=>({token:'fixture'})};
    if(options.method==='POST'){posts.push(JSON.parse(options.body));if(failSave)return {ok:false,status:503,json:async()=>({error:'Offline fixture'})};}
    return {ok:true,json:async()=>({id:'previous-project-0001',revision:1,name:'Previous',snapshot:saved,generation:null})};
  };
  vm.runInNewContext(source,{window,URL,URLSearchParams,Event,setTimeout,clearTimeout,fetch});
  const button=element('newServerProject');
  if(!early){
    gate.resolve({record:null});await window.SignageWorkspace.ready;
    if(failSave){saved.project.text='Unsaved edit';document.dispatchEvent(new Event('input'));}
  }
  const clicked=button.onclick();
  assert.equal(button.disabled,true,'Show that the click is being processed');
  await button.onclick(); // Rapid repeat must not create a second navigation.
  if(early){
    await tick();assert.equal(navigations.length,0,'Do not leave before previous project restoration finishes');
    gate.resolve({record:null});await window.SignageWorkspace.ready;
  }
  await clicked;await tick();
  if(failSave){assert.equal(navigations.length,0,'Failed save must retain current work');assert.equal(button.disabled,false);assert.match(element('serverProjectStatus').textContent,/только на этом устройстве/);}
  else{assert.equal(navigations.length,1,'A New project click during startup must not be silently dropped');assert.equal(navigations[0],'https://example.test/signs/calibrator.html?newProject=1');assert.deepEqual(order,['local-save','navigate']);assert.equal(posts.length,0,'Opening an unchanged project must not rewrite it');}
  return {window,document,button,navigations,saved};
}
async function copyButton(){
  const document=new Events(),window=new Events(),elements=new Map(),startup=deferred(),save=deferred(),posts=[],localSaves=[];
  const element=id=>{if(!elements.has(id))elements.set(id,new Element(id==='copyServerProject'?'Создать копию':''));return elements.get(id);};
  document.getElementById=element;document.querySelector=()=>null;
  const url=new URL('https://example.test/signs/calibrator.html?restoreProject=previous-project-0001');
  window.document=document;window.SignageProducts=Products;window.location=url;
  window.history={replaceState(_a,_b,next){url.href=String(next);}};window.crypto={randomUUID:()=> 'copied-project-00000001'};
  let saved={photo:'data:image/png;base64,original',project:{text:'Previous'}},photo=false;
  window.SignageEditor={snapshot:()=>({hasPhoto:photo}),draftSnapshot:()=>saved,restoreDraft:async value=>{saved=value;photo=true;}};
  window.SignageGeneration={ready:Promise.resolve(),draftState:()=>null,restoreDraft:async()=>{}};
  window.SignageDraft={ready:startup.promise,flush:async()=>{localSaves.push(window.SignageWorkspace.context().id);}};
  const fetch=async(_url,options={})=>{
    if(String(_url).endsWith('api/config'))return {ok:true,json:async()=>({token:'fixture'})};
    if(options.method==='POST'){
      const body=JSON.parse(options.body);posts.push({url:String(_url),body});await save.promise;
      return {ok:true,json:async()=>({id:'copied-project-00000001',revision:1,name:body.name})};
    }
    return {ok:true,json:async()=>({id:'previous-project-0001',revision:1,name:'Previous',snapshot:saved,generation:null})};
  };
  vm.runInNewContext(source,{window,URL,URLSearchParams,Event,setTimeout,clearTimeout,fetch});
  const button=element('copyServerProject');assert.equal(button.disabled,true,'Copy must be unavailable before restoration');
  await button.trigger('click');assert.equal(posts.length,0);
  startup.resolve({record:null});await window.SignageWorkspace.ready;
  assert.equal(button.disabled,false);
  saved.project.text='Unsaved current fields';const copying=button.trigger('click');await tick();
  assert.equal(button.disabled,true);assert.equal(button.textContent,'Создаю копию…');
  assert.equal(element('saveServerProject').disabled,true);
  await button.trigger('click');assert.equal(posts.length,1,'A rapid second click cannot create another project');
  assert.ok(posts[0].url.endsWith('/api/projects/copied-project-00000001'));
  assert.equal(posts[0].body.snapshot.project.text,'Unsaved current fields');
  save.resolve();assert.equal(await copying,true);assert.equal(button.disabled,false);assert.equal(button.textContent,'Создать копию');
  assert.equal(url.searchParams.get('restoreProject'),'copied-project-00000001');
  assert.deepEqual(localSaves,['copied-project-00000001']);
}
(async()=>{await run();await run({early:false});await run({early:false,failSave:true});await copyButton();console.log('PASS: New project startup/duplicate/failure navigation; Copy startup lock, current fields, duplicate click, busy state, independent URL and local persistence');})().catch(error=>{console.error(error);process.exitCode=1;});
