/* Server workspace identity and optimistic autosave; generation snapshots stay immutable. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else{
    let token='';const base=new URL('.',root.location.href);
    async function request(path,body){
      if(!token){const response=await fetch(new URL('api/config',base),{credentials:'same-origin',cache:'no-store'});if(!response.ok)throw Object.assign(new Error('Войдите в редактор и повторите сохранение.'),{status:response.status});token=(await response.json()).token;}
      const response=await fetch(new URL(path.replace(/^\//,''),base),{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:{'X-Editor-Token':token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
      const data=await response.json();
      if(!response.ok){if(response.status===403)token='';throw Object.assign(new Error(data.message||data.error||'Не удалось связаться с сервером.'),{status:response.status,data});}
      return data;
    }
    const controller=api.createController({editor:root.SignageEditor,generation:root.SignageGeneration,document:root.document,window:root,request,status:root.document.getElementById('serverProjectStatus'),nameInput:root.document.getElementById('projectName')});
    root.SignageWorkspace=controller;
    root.document.addEventListener('signage:workspacestatus',()=>{
      const state=controller.state();root.document.getElementById('reloadServerProject').hidden=!state.conflict;root.document.getElementById('copyServerProject').hidden=!state.conflict;
      const layout=root.document.querySelector('.layout');if(layout)layout.inert=state.loading||state.suspended>0;
      root.document.getElementById('saveServerProject').disabled=state.loading||state.suspended>0;
      root.document.getElementById('projectName').disabled=state.loading||state.suspended>0;
    });
    controller.ready=controller.start();
    root.document.getElementById('saveServerProject').onclick=()=>controller.flush(true);
    root.document.getElementById('reloadServerProject').onclick=()=>controller.reload();
    root.document.getElementById('copyServerProject').onclick=()=>controller.copy();
    const newProjectButton=root.document.getElementById('newServerProject');
    newProjectButton.onclick=async()=>{
      if(newProjectButton.disabled)return;
      const label=newProjectButton.textContent;
      newProjectButton.disabled=true;newProjectButton.textContent='Открываю новый проект…';
      try{
        // A click during startup used to fail flush() silently and leave the
        // previous project on screen as soon as its restoration completed.
        await controller.ready;
        if(await controller.flush()){
          await root.SignageDraft?.flush();
          root.location.assign(new URL('calibrator.html?newProject=1',base));
        }
      }finally{newProjectButton.disabled=false;newProjectButton.textContent=label;}
    };
  }
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{16,96}$/.test(id);
  const clone=value=>JSON.parse(JSON.stringify(value));
  function createController({editor,generation,document,window,request,status,nameInput,delay=1200}){
    const search=new URLSearchParams(window.location.search),requested=search.get('restoreProject'),variant=search.has('restoreJob'),fresh=search.get('newProject')==='1';
    let id='',revision=0,name='',sourceJobId=null,ready=false,suspended=0,dirty=false,conflict=false,loading=false,write=null,timer=null,editEpoch=0,lastSaved='',restoredLocal=null,foreignResult=false;
    const uuid=()=>window.crypto.randomUUID();
    function feedback(text,error=false){if(status){status.textContent=text;status.classList?.toggle('error',error);}document.dispatchEvent(new Event('signage:workspacestatus'));}
    function context(){return id?{id,revision,name,sourceJobId,pending:dirty,foreignResult}:null;}
    function state(){return {...context(),dirty,conflict,loading,ready,suspended};}
    function nameValue(){return (nameInput?.value||name||'Новый проект').trim().slice(0,160)||'Новый проект';}
    function capture(){const snapshot=clone(editor.draftSnapshot());delete snapshot.workspace;if(/^data:image\/svg\+xml/.test(snapshot.photo))snapshot.photo=editor.photoPng();const result=clone(generation?.draftState?.()||null);if(foreignResult&&result){result.jobId=null;result.pendingJobId=null;result.photoMatchesResult=false;result.pendingPhotoMatches=false;}return {snapshot,generation:result};}
    function fingerprint(value){const snapshot={...value.snapshot},generation=value.generation?{...value.generation}:value.generation;delete snapshot.view;if(generation)delete generation.view;return JSON.stringify({name:nameValue(),snapshot,generation});}
    function stamp(){return fingerprint(capture());}
    function localChanged(){document.dispatchEvent(new Event('signage:workspacechange'));}
    function adopt(record,jobId=null){if(!validId(record?.id))throw new Error('Некорректный проект.');id=record.id;revision=record.revision||0;name=record.name||'Новый проект';sourceJobId=jobId||null;foreignResult=record.foreignResult===true;if(nameInput)nameInput.value=name;conflict=false;dirty=false;}
    function recordJob(jobId){sourceJobId=jobId;foreignResult=false;localChanged();}
    function restoreLocal(value){if(suspended||loading||!validId(value?.id))return;restoredLocal=value;if(!requested&&!variant&&!fresh){adopt(value,value.sourceJobId);dirty=value.pending===true;}}
    function beginRestore(){suspended++;}
    function endRestore(success=true){suspended=Math.max(0,suspended-1);lastSaved=stamp();dirty=false;localChanged();feedback(success?'Открыт сохранённый вариант. Правки будут сохраняться в этом проекте.':'Не удалось полностью открыть сохранённый вариант. Повторите открытие из истории.',!success);}
    function schedule(){
      if(!ready||suspended||loading||!editor.snapshot().hasPhoto)return;
      try{if(stamp()===lastSaved)return;}catch{}
      dirty=true;editEpoch++;localChanged();clearTimeout(timer);
      if(conflict)return;
      feedback('Есть правки · сохраняю на сервере…');timer=setTimeout(()=>void flush(),delay);
    }
    async function flush(force=false){
      clearTimeout(timer);timer=null;
      if(!ready||suspended||loading)return false;
      if(!editor.snapshot().hasPhoto){feedback('Добавьте фото — проект будет сохранён на сервере.');return true;}
      if(conflict){feedback('Проект изменён на другом устройстве. Откройте серверную версию или сохраните свои правки отдельным проектом.',true);return false;}
      if(write){await write;return dirty&&!conflict?flush(force):!dirty;}
      let value,key;
      try{value=capture();key=fingerprint(value);}catch(error){feedback(error.message,true);return false;}
      if(key===lastSaved&&!force){dirty=false;return true;}
      if(!id)id=uuid();name=nameValue();const targetId=id,targetRevision=revision,epoch=editEpoch;
      dirty=true;feedback('Сохраняю проект на сервере…');
      write=(async()=>{
        try{
          const answer=await request(`/api/projects/${targetId}`,{base_revision:targetRevision,name,...value});
          if(id!==targetId)return false;
          revision=answer.revision;name=answer.name||name;lastSaved=key;dirty=editEpoch!==epoch||stamp()!==key;
          localChanged();feedback(dirty?'Есть новые правки · сохраняю…':'Проект сохранён на сервере · доступен с любого ПК.');
          if(!variant){const url=new URL(window.location.href);url.searchParams.delete('newProject');url.searchParams.set('restoreProject',id);window.history.replaceState(null,'',url);}
          return true;
        }catch(error){
          if(error.status===409){conflict=true;feedback('Проект изменён на другом устройстве. Ваши правки сохранены локально; выберите серверную версию или сохраните копию.',true);}
          else feedback('Правки пока только на этом устройстве. '+error.message+' Нажмите «Сохранить» после восстановления связи.',true);
          localChanged();return false;
        }finally{write=null;}
      })();
      const success=await write;
      if(success&&dirty&&!conflict)return flush();return success;
    }
    async function restoreRecord(record,localRecord=null){
      beginRestore();loading=true;
      try{
        adopt(record);const local=localRecord?.snapshot?.workspace;
        const localMatches=local?.id===record.id||local?.id===requested||local?.id===id;
        const useLocal=localMatches&&local?.pending===true;
        const value=useLocal?localRecord:record;
        if(value.snapshot){await editor.restoreDraft(value.snapshot);await generation?.restoreDraft?.(value.generation);}
        if(useLocal){name=local.name||name;if(nameInput)nameInput.value=name;sourceJobId=local.sourceJobId||null;foreignResult=local.foreignResult===true;dirty=true;conflict=local.id!==record.id||local.revision!==record.revision;lastSaved='';feedback(conflict?'Восстановлены локальные правки. На сервере есть новая версия: откройте её или сохраните свои правки отдельным проектом.':'Восстановлены правки с этого устройства. Сохраняю на сервере…',conflict);}
        else{lastSaved=stamp();dirty=false;feedback('Проект загружен с сервера. Можно продолжать редактирование.');}
        sourceJobId=sourceJobId||value.generation?.jobId||null;localChanged();
      }finally{loading=false;suspended=Math.max(0,suspended-1);document.dispatchEvent(new Event('signage:workspacestatus'));}
    }
    async function start(){
      loading=true;feedback('Проверяю сохранённый проект…');
      const draft=await window.SignageDraft?.ready;await generation?.ready;
      ready=true;loading=false;
      const local=draft?.record?.snapshot?.workspace;
      if(!requested&&!variant&&!fresh&&validId(local?.id)){adopt(local,local.sourceJobId);dirty=local.pending===true;}
      if(variant){feedback('Открываю вариант из истории…');return;}
      if(fresh){id=uuid();name=nameValue();if(nameInput)nameInput.value=name;dirty=editor.snapshot().hasPhoto;feedback(dirty?'Сохраняю новый проект…':'Новый проект · добавьте фото.');if(dirty)await flush();return;}
      if(requested&&!validId(requested)){loading=true;feedback('Некорректный идентификатор проекта.',true);return;}
      const target=requested||id;
      if(target){
        loading=true;feedback('Загружаю проект с сервера…');
        try{await restoreRecord(await request(`/api/projects/${target}`),draft?.record);}
        catch(error){
          loading=false;
          const saved=draft?.record,local=saved?.snapshot?.workspace;
          if(local?.id===target){beginRestore();await editor.restoreDraft(saved.snapshot);adopt(local,local.sourceJobId);dirty=local.pending===true;lastSaved=dirty?'':stamp();suspended--;feedback('Восстановлена локальная копия. Сервер недоступен; новые правки будут сохранены после подключения.',true);}
          else{loading=true;feedback('Не удалось открыть проект. '+error.message+' Обновите страницу после подключения.',true);}
        }
      }else{
        const previous=generation?.draftState?.().jobId;
        if(previous&&editor.snapshot().hasPhoto){
          try{const job=await request(`/api/jobs/${previous}`),record=await request(`/api/projects/${job.project_id||'legacy-'+previous}`);adopt(record,previous);dirty=true;lastSaved='';feedback('Сохраняю восстановленные правки в исходном проекте…');}
          catch{loading=true;feedback('Не удалось определить исходный проект восстановленного черновика. Проверьте связь или сохраните копию.',true);}
        }else{id=uuid();name=nameValue();if(nameInput)nameInput.value=name;dirty=editor.snapshot().hasPhoto;feedback(dirty?'Сохраняю восстановленный черновик как проект…':'Добавьте фото — проект будет сохранён на сервере.');}
      }
      if(dirty&&!conflict&&!loading)await flush();
    }
    async function reload(){
      if(!id)return false;
      if(dirty&&!window.confirm('Открыть серверную версию? Текущие локальные правки будут заменены. Чтобы оставить их, выберите «Сохранить копию».'))return false;
      try{await restoreRecord(await request(`/api/projects/${id}`));return true;}catch(error){feedback(error.message,true);return false;}
    }
    async function copy(){
      if(write)await write;
      id=uuid();revision=0;sourceJobId=null;foreignResult=true;conflict=false;loading=false;name=nameValue().slice(0,150)+' · копия';if(nameInput)nameInput.value=name;lastSaved='';dirty=true;editEpoch++;localChanged();return flush();
    }
    ['input','change'].forEach(type=>document.addEventListener(type,schedule));
    ['signage:change','signage:viewchange','signage:resultchange'].forEach(type=>document.addEventListener(type,schedule));
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&dirty)void flush();});
    window.addEventListener('online',()=>{if(dirty&&!conflict)void flush();});
    window.addEventListener('beforeunload',event=>{if(dirty&&!loading){void flush();event.preventDefault();event.returnValue='';}});
    return {start,flush,adopt,context,state,restoreLocal,beginRestore,endRestore,reload,copy,recordJob};
  }
  return {createController};
});
