'use strict';
const assert = require('node:assert/strict');
const {createController} = require('../assets/project-workspace.js');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const tick = async () => {for (let n = 0; n < 5; n++) await new Promise(resolve => setImmediate(resolve));};
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
class Events {
  constructor() {this.listeners = new Map();}
  addEventListener(type, callback) {const callbacks = this.listeners.get(type) || []; callbacks.push(callback); this.listeners.set(type, callbacks);}
  dispatchEvent(event) {for (const callback of this.listeners.get(event.type) || []) callback(event); return true;}
  emit(type) {return this.dispatchEvent({type, preventDefault() {this.prevented = true;}});}
}
const snapshot = text => ({project: {version: 2, image: {name: 'photo.png', width_px: 1200, height_px: 800}, calibration: {image_points: []}, placement: null,
  products: [{id: 'actual-artwork', type: 'plaque', params: {text}, artwork: {name: 'original.png', source: 'uploaded', data_url: 'data:image/png;base64,EXACT'}}]},
  photo: 'data:image/png;base64,ORIGINAL', photoKey: 'photo-key', ui: {text: {value: text}}, view: {scale: 2, x: 30, y: -80}, interaction: {action: 'reference', pending: [[20, 40]]}});
function server() {
  const records = new Map(), requests = []; let gate = null, down = false, active = 0, maxActive = 0;
  return {records, requests, set gate(value) {gate = value;}, set down(value) {down = value;}, get maxActive() {return maxActive;},
    async request(endpoint, body) {
      requests.push({endpoint, body: clone(body)});
      if (down) throw Object.assign(new Error('Нет связи'), {status: 503});
      const id = endpoint.split('/').at(-1), old = records.get(id);
      if (!body) {if (!old) throw Object.assign(new Error('Проект не найден'), {status: 404}); return clone(old);}
      active++; maxActive = Math.max(active, maxActive);
      try {
        if (gate) {const hold = gate; gate = null; await hold.promise;}
        if ((old?.revision || 0) !== body.base_revision) throw Object.assign(new Error('Изменён на другом ПК'), {status: 409, data: {revision: old.revision}});
        const record = {id, revision: body.base_revision + 1, name: body.name, snapshot: clone(body.snapshot), generation: clone(body.generation)};
        records.set(id, record); return clone(record);
      } finally {active--;}
    }};
}
let identity = 0;
function page(api, {search = '', current = snapshot('Начало'), localRecord, photo = true} = {}) {
  const document = new Events(), window = new Events(), restorations = [], resultRestorations = [];
  const url = new URL('https://example.test/signs/calibrator.html' + search);
  window.location = url; window.history = {replaceState(_a, _b, next) {url.href = String(next);}};
  window.crypto = {randomUUID: () => 'project-qa-identity-' + String(++identity).padStart(12, '0')};
  window.SignageDraft = {ready: Promise.resolve({restored: Boolean(localRecord), record: clone(localRecord)})};
  window.confirm = () => true;
  let value = clone(current), hasPhoto = photo,generationState={version:1,jobId:null,view:'source',editRegion:null};
  const editor = {snapshot: () => ({hasPhoto}), draftSnapshot: () => clone(value), restoreDraft: async saved => {value = clone(saved); hasPhoto = Boolean(saved.photo); restorations.push(clone(saved));}};
  const generation = {ready: Promise.resolve(), draftState: () => clone(generationState), restoreDraft: async saved => {generationState=clone(saved);resultRestorations.push(clone(saved));}};
  const status = {textContent: '', classList: {toggle() {}}}, nameInput = {value: ''};
  const controller = createController({editor, generation, document, window, request: (...args) => api.request(...args), status, nameInput, delay: 60000});
  if (localRecord?.snapshot?.workspace) controller.restoreLocal(localRecord.snapshot.workspace);
  return {controller, document, window, status, nameInput, restorations, resultRestorations, current: () => clone(value), edit(text) {value.project.products[0].params.text = text; value.ui.text.value = text; document.emit('input');}, editGeometry(placement){value.project.placement=clone(placement);value.project.products[0].placement=clone(placement);document.emit('signage:change');},selectResultView(view){generationState.view=view;document.emit('signage:resultchange');},resultState:()=>clone(generationState),setPhoto(enabled) {hasPhoto = enabled;}};
}
async function main() {
  const api = server(), a = page(api, {search: '?newProject=1', photo: false});
  await a.controller.start(); await a.controller.flush();
  assert.equal(api.requests.length, 0, 'An empty new project must not create a useless server record');
  a.setPhoto(true); a.edit('НЕЗАВЕРШЁННЫЙ'); await a.controller.flush();
  const projectId = a.controller.context().id, first = clone(api.records.get(projectId));
  assert.equal(first.revision, 1); assert.equal(first.snapshot.project.placement, null);
  assert.deepEqual(first.snapshot, a.current(), 'Partial geometry, original artwork, photo, unfinished tool and form values persist together');
  assert.equal(first.generation.view, 'source'); assert.equal(first.snapshot.workspace, undefined, 'Local workspace state must not be recursively saved into itself');
  const firstWrites = api.requests.filter(item => item.body).length;
  await a.controller.flush(); assert.equal(api.requests.filter(item => item.body).length, firstWrites, 'Unchanged snapshot must not create another revision');
  assert.equal(a.window.location.searchParams.get('restoreProject'), projectId);
  assert.equal(a.window.location.searchParams.has('newProject'), false);

  const b = page(api, {search: '?restoreProject=' + projectId}); await b.controller.start();
  assert.deepEqual(b.current(), first.snapshot); assert.equal(b.controller.context().revision, 1);
  b.document.emit('signage:change'); b.document.emit('signage:viewchange');
  assert.equal(b.controller.state().dirty, false, 'Unchanged restoration/redraw events must not turn a clean remote read into a pending local edit');
  b.edit('С ПК B'); await b.controller.flush(); assert.equal(api.records.get(projectId).revision, 2);
  a.edit('УСТАРЕВШИЙ ПК A'); assert.equal(await a.controller.flush(), false);
  assert.equal(a.controller.state().conflict, true); assert.equal(api.records.get(projectId).snapshot.project.products[0].params.text, 'С ПК B');
  const failedWrites = api.requests.filter(item => item.body).length;
  a.edit('ЕЩЁ ОДНА УСТАРЕВШАЯ ПРАВКА'); await a.controller.flush();
  assert.equal(api.requests.filter(item => item.body).length, failedWrites, 'A conflict must stop writes until owner chooses resolution');
  assert.ok(a.status.textContent.includes('другом устройстве'));
  assert.equal(await a.controller.copy(), true);
  const copyId = a.controller.context().id; assert.notEqual(copyId, projectId); assert.equal(api.records.get(copyId).revision, 1);
  assert.equal(api.records.get(copyId).snapshot.project.products[0].params.text, 'ЕЩЁ ОДНА УСТАРЕВШАЯ ПРАВКА');
  assert.equal(api.records.get(projectId).snapshot.project.products[0].params.text, 'С ПК B');

  const delayed = page(api, {search: '?restoreProject=' + projectId}); await delayed.controller.start();
  const gate = deferred(); api.gate = gate; delayed.edit('ПЕРВЫЙ СНИМОК'); const saving = delayed.controller.flush(); await tick();
  delayed.edit('ПОКА СОХРАНЯЛСЯ ПЕРВЫЙ'); const waiting = delayed.controller.flush(); gate.resolve();
  assert.equal(await saving, true); assert.equal(await waiting, true);
  assert.equal(api.records.get(projectId).snapshot.project.products[0].params.text, 'ПОКА СОХРАНЯЛСЯ ПЕРВЫЙ');
  assert.equal(api.records.get(projectId).revision, 4); assert.equal(api.maxActive, 1, 'Multiple flushes must serialize requests and advance base revision');
  assert.equal(delayed.controller.state().dirty, false);

  // Local pending changes from an interrupted/offline session use their original
  // revision. They cannot silently acquire a newer server revision on reload.
  const pending = clone(first.snapshot); pending.project.products[0].params.text = 'ЛОКАЛЬНЫЙ ОФЛАЙН'; pending.ui.text.value = 'ЛОКАЛЬНЫЙ ОФЛАЙН';
  pending.workspace = {id: projectId, revision: 1, name: 'Локальное имя', pending: true};
  const recovered = page(api, {search: '?restoreProject=' + projectId, localRecord: {snapshot: pending, generation: first.generation}});
  await recovered.controller.start();
  assert.equal(recovered.current().project.products[0].params.text, 'ЛОКАЛЬНЫЙ ОФЛАЙН');
  assert.equal(recovered.controller.state().conflict, true); assert.equal(await recovered.controller.flush(), false);
  assert.equal(api.records.get(projectId).revision, 4);

  const offline = page(api, {search: '?restoreProject=' + projectId}); api.down = true;
  await offline.controller.start(); offline.edit('НЕ ДОЛЖНА ПЕРЕЗАПИСАТЬ'); await offline.controller.flush();
  assert.equal(offline.controller.state().loading, true, 'Failed explicit remote restore must lock save rather than publish an unrelated default');
  api.down = false; assert.equal(api.records.get(projectId).revision, 4);

  const oldVariant=snapshot('ТОЧНЫЙ СТАРЫЙ ВАРИАНТ');oldVariant.project.placement={center_px:[200,150],width_cm:100,height_cm:35};
  const variant = page(api, {search: '?restoreJob=legacy-variant-000000001',current:oldVariant}); await variant.controller.start();
  const beforeAdopt = api.requests.length;
  const latestBeforeComparison=clone(api.records.get(projectId));
  variant.controller.beginRestore(); variant.controller.adopt({id: projectId, revision: 4, name: 'Сохранённый проект'}, 'legacy-variant-000000001');
  variant.document.emit('signage:change'); variant.controller.endRestore(); await variant.controller.flush();
  assert.equal(api.requests.length, beforeAdopt, 'Opening an exact generation must not modify latest server workspace');
  for(const view of ['neutral','guide','render']){
    variant.selectResultView(view);await tick();
    assert.equal(variant.controller.state().dirty,false,'Comparison tabs cannot classify old variant geometry as a real edit');
    assert.equal(variant.controller.context().revision,4);
    await variant.controller.flush();
    assert.equal(api.requests.length,beforeAdopt,'Comparing a saved variant must not schedule or post an autosave');
    assert.deepEqual(api.records.get(projectId),latestBeforeComparison,'Old variant geometry must never replace the latest server draft through a comparison click');
    assert.equal(variant.resultState().view,view,'Ignoring a comparison view in the fingerprint cannot mutate the captured selection');
  }
  variant.selectResultView('guide');
  const editedPlacement={center_px:[250,180],width_cm:110,height_cm:35};
  variant.editGeometry(editedPlacement);assert.equal(variant.controller.state().dirty,true,'A physical geometry edit still requests an autosave');
  await variant.controller.flush();
  assert.equal(api.records.get(projectId).revision, 5);
  assert.deepEqual(api.records.get(projectId).snapshot.project.placement,editedPlacement);
  assert.equal(api.records.get(projectId).generation.view,'guide','A real saved edit still includes the selected comparison view');
  assert.equal(variant.controller.context().sourceJobId, 'legacy-variant-000000001');
  const namedApi=server(),named=page(namedApi,{search:'?newProject=1'});await named.controller.start();
  const namedId=named.controller.context().id;named.selectResultView('neutral');
  assert.equal(named.controller.state().dirty,false);assert.equal(await named.controller.flush(true),true);
  assert.equal(namedApi.records.get(namedId).revision,2,'An explicit Save action remains allowed even without a physical edit');
  assert.equal(namedApi.records.get(namedId).generation.view,'neutral','An explicit Save includes the selected comparison view');
  const aliasId = 'legacy-merged-project-00000001';
  const aliasDraft = clone(first.snapshot); aliasDraft.project.products[0].params.text = 'НЕСОХРАНЁННЫЕ ПРАВКИ ОБЪЕДИНЁННОГО';
  aliasDraft.ui.text.value = 'НЕСОХРАНЁННЫЕ ПРАВКИ ОБЪЕДИНЁННОГО'; aliasDraft.workspace = {id: aliasId, revision: 1, name: 'Ранее отдельный проект', pending: true};
  const aliasApi = {request: (endpoint, body) => api.request(endpoint.replace(aliasId, projectId), body)};
  const aliased = page(aliasApi, {search: '?restoreProject=' + aliasId, localRecord: {snapshot: aliasDraft, generation: first.generation}});
  const beforeAlias = api.requests.filter(item => item.body).length; await aliased.controller.start();
  assert.equal(aliased.current().project.products[0].params.text, 'НЕСОХРАНЁННЫЕ ПРАВКИ ОБЪЕДИНЁННОГО');
  assert.equal(aliased.controller.context().id, projectId); assert.equal(aliased.controller.state().conflict, true);
  assert.equal(await aliased.controller.flush(), false); assert.equal(api.requests.filter(item => item.body).length, beforeAlias);
  console.log('PASS: server workspace controller — partial atomic snapshot, unchanged-save dedupe, independent PCs, optimistic conflicts, explicit copies, serialized concurrent edits, offline stale draft protection, failed-restore lock, exact-variant comparison GET-only until real geometry edits with preserved comparison selection.');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
