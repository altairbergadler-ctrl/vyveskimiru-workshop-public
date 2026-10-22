'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../assets/project-workspace.js'), 'utf8');
const tick = async () => {for (let n=0;n<5;n++) await new Promise(resolve=>setImmediate(resolve));};
const deferred = () => {let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
class Events {
  constructor(){this.listeners=new Map();}
  addEventListener(type,fn){const all=this.listeners.get(type)||[];all.push(fn);this.listeners.set(type,all);}
  dispatchEvent(event){for(const fn of this.listeners.get(event.type)||[])fn(event);}
}
async function run({early=true,failSave=false}={}){
  const document=new Events(),window=new Events(),elements=new Map(),gate=deferred(),navigations=[],posts=[],order=[];
  const element=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:id==='newServerProject'?'Новый проект':'',classList:{toggle(){}}});return elements.get(id);};
  document.getElementById=element;document.querySelector=()=>null;
  window.document=document;window.location={href:'https://example.test/signs/?restoreProject=previous-project-0001',search:'?restoreProject=previous-project-0001',assign:url=>{order.push('navigate');navigations.push(String(url));}};
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
(async()=>{await run();await run({early:false});await run({early:false,failSave:true});console.log('PASS: early/ready New project clicks, duplicate clicks, local-save ordering, failed server save retains edits');})().catch(error=>{console.error(error);process.exitCode=1;});
