'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const G = require('../assets/geometry.js');
const P = require('../assets/products.js');

// Execute shipped generation.js with real event delivery and controllable API
// responses. Restore scenarios reject POST /api/jobs; only the final explicit
// generation click may submit one job.
const savedId = 'saved-result-0000000001', pendingId = 'pending-result-00000001';
const originalProject = {version: 1, sign: {text: 'ЦВЕТЫ', front_color: '#ffeeee'}, generation: {lighting: 'original'}};
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const settle = async () => {for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));};
class Element {
  constructor() {
    this.value = ''; this.hidden = false; this.children = []; this.scrolled = 0; this.textContent = '';
    this.classes = new Set(); this.classList = {toggle: (key, enabled) => enabled ? this.classes.add(key) : this.classes.delete(key)};
  }
  append(...children) {this.children.push(...children);}
  replaceChildren(...children) {this.children = children;}
  setAttribute() {}
  scrollIntoView() {this.scrolled++;}
}
function page({prefix = '/signs/', query = '', project, serverProject, storage = new Map(), draftReady,
               responseGate, failedPath, connection = {online: true}, statusSequence = ['complete'], sceneRetouchConfigured, twoStageConfigured,
               prepareArtwork, geometry, audit = {}, jobInfo = {}, productUI = false, allowGeneration = false, workspace} = {}) {
  const elements = new Map(), listeners = new Map(), requests = [], events = [], timers = [], restores = [], downloads = [];
  const preparation = {generationIds: 0, photos: 0};
  const element = id => {if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id);};
  element('lighting').value = 'original'; element('aiResult').hidden = true;
  const location = new URL('https://example.test' + prefix + 'calibrator.html' + query);
  const state = {project: clone(project || {...originalProject, sign: {...originalProject.sign, font_bold: true}, ruler: {same_plane: true, image_points: []}}), photoRevision: 1, hasPhoto: true,
    report: {placement: {fits_target: true, polygon_px: []}}};
  const document = {
    getElementById: element, createElement: () => new Element(),
    addEventListener: (type, fn) => {const list = listeners.get(type) || []; list.push(fn); listeners.set(type, list);},
    dispatchEvent: event => {events.push(event.type); for (const fn of listeners.get(event.type) || []) fn(event);}
  };
  const editor = {
    snapshot: () => ({...state}),
    facadeEnabled: () => state.project.facade?.enabled===true,
    target: () => [[0, 0], [10, 0], [10, 10], [0, 10]],
    render: () => document.dispatchEvent(new Event('signage:change')),
    restoreProject: async (value, photo) => {restores.push({value: clone(value), photo}); state.project = clone(value); state.photoRevision++;},
    download: (...args) => downloads.push(args), photoPng: () => {preparation.photos++; if(allowGeneration)return 'data:image/png;base64,fixture';throw new Error('Restore must not prepare a new AI request');}
  };
  const fetch = async (input, options = {}) => {
    const url = new URL(input, location.href), method = options.method || 'GET';
    requests.push({pathname: url.pathname, method, credentials: options.credentials, token: options.headers?.['X-Editor-Token'], ...(options.body?{body:JSON.parse(options.body)}:{})});
    if(!allowGeneration||method!=='POST')assert.equal(method, 'GET', 'Restoring finished/running results must never POST an AI generation');
    assert.ok(url.pathname.startsWith(prefix + 'api/'), 'Request escaped its application prefix');
    if (responseGate?.match(url.pathname)) await responseGate.promise;
    if (failedPath?.(url.pathname)) return {ok: false, status: 404, json: async () => ({error: 'Нет сохранённого файла'})};
    const endpoint = url.pathname.slice(prefix.length);
    if (endpoint === 'api/config') return connection.online ? {ok: true, json: async () => ({provider: 'codex', configured: true, token: 'fixture-token', scene_retouch_configured: sceneRetouchConfigured, two_stage_letters_configured: twoStageConfigured})} : {ok: false, status: 503, json: async () => ({error: 'Нет связи'})};
    if(method==='POST'){assert.equal(endpoint,'api/jobs');return {ok:true,json:async()=>({id:JSON.parse(options.body).request_id,status:'running'})};}
    if(endpoint.startsWith('api/projects/'))return {ok:true,json:async()=>({id:jobInfo.project_id||workspace?.context()?.id,name:'Fixture project',revision:1})};
    if (endpoint.endsWith('/project.json')) return {ok: true, json: async () => clone(serverProject || originalProject)};
    if (/\.png$/.test(endpoint)) return {ok: true, blob: async () => ({filename: endpoint.split('/').pop()})};
    if(endpoint.endsWith('/production-spec.json'))return {ok:true,blob:async()=>({filename:'production-spec.json',source:'saved immutable specification'})};
    const identity = endpoint.slice('api/jobs/'.length);
    const next = statusSequence.length > 1 ? statusSequence.shift() : statusSequence[0],status=typeof next==='string'?next:next.status;
    return {ok: true, json: async () => ({id: identity, status, message: typeof next==='string'?status:next.message, lighting: 'original',
      ...clone(jobInfo),audit: {canvas_size_px: [1200, 800], changed_pixels_outside_edit_zone: 0, ...clone(audit)}})};
  };
  let urlCounter = 0;
  class BrowserURL extends URL {
    static createObjectURL(blob) {return `blob:fixture/${blob.filename}/${++urlCounter}`;}
    static revokeObjectURL() {}
  }
  const legacyMaterialCopy='Тексты и логотипы переносятся из сохранённых PNG.';
  const window = {SignageEditor: editor, SignagePreview: {colorSwatches() {}, materialSummary: () => legacyMaterialCopy},
    LetterGeometry: geometry || {quad() {}, inside: () => true}, ...(draftReady ? {SignageDraft: {ready: draftReady}} : {}),
    ...(workspace?{SignageWorkspace:workspace}:{}),
    ...(productUI?{SignageProducts:P,SignageProductUI:{generationEngine:()=>P.renderer(state.project)==='channel_letters'?'codex':'composite',active:()=>P.activeProduct(state.project),prepareArtwork:prepareArtwork||(async()=>{})}}:prepareArtwork ? {SignageProductUI: {generationEngine: () => 'codex', active: () => state.project, prepareArtwork}} : {})};
  const context = {window, document, location, URL: BrowserURL, URLSearchParams, Event, console,
    fetch, crypto: {randomUUID: () => {preparation.generationIds++; if(allowGeneration)return 'submitted-result-0000001';throw new Error('Restore must not allocate a generation ID');}},
    history: {replaceState: (_, __, url) => {location.href = String(url);}},
    FileReader: class {readAsDataURL() {this.result = 'data:image/png;base64,fixture'; queueMicrotask(() => this.onload());}},
    sessionStorage: {getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
    setTimeout: (callback, delay) => {timers.push({callback, delay}); return timers.length;}
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/generation.js'), 'utf8'), context, {filename: 'generation.js'});
  return {element, state, requests, events, timers, restores, downloads, storage, location, editor, preparation, generation: window.SignageGeneration};
}
function savedState(overrides = {}) {
  return {version: 1, jobId: savedId, view: 'render', photoMatchesResult: true, pendingJobId: null, pendingPhotoMatches: false, ...overrides};
}
async function main() {
  // A facade uses its curved placement boundary unless an explicit edit region
  // was selected. Tool preferences persist without invalidating saved artwork.
  const facadeProject={...clone(originalProject),facade:{version:1,enabled:true,lens_enabled:false,edge_points:[null,null,null,null],grid_visible:true,grid_step_cm:50,snap_elements:true,snap_grid:false}};
  const facadeResult=page({project:facadeProject,serverProject:facadeProject});await facadeResult.generation.ready;
  assert.equal(facadeResult.generation.settings().edit_polygon_px,null);
  assert.equal(facadeResult.generation.settings().edit_region_source,'placement_zone');
  await facadeResult.generation.restoreDraft(savedState());
  assert.equal(facadeResult.element('resultStale').hidden,true);
  Object.assign(facadeResult.state.project.facade,{grid_visible:false,grid_step_cm:25,snap_elements:false,snap_grid:true});facadeResult.editor.render();
  assert.equal(facadeResult.element('resultStale').hidden,true,'View and attraction preferences do not alter rendering geometry');
  facadeResult.state.project.facade.lens_enabled=true;facadeResult.editor.render();
  assert.equal(facadeResult.element('resultStale').hidden,false,'Lens geometry invalidates the saved image');
  const facadeRegion=page({project:{...facadeProject,target_polygon_px:[[0,0],[10,0],[10,10],[0,10]],sign:{...facadeProject.sign,composition_mode:'independent_signs_v1',objects:[{id:'one'}]}},geometry:G});await facadeRegion.generation.ready;
  facadeRegion.state.report={placement:{fits_target:true,polygon_px:[]},calibration:{target_world_cm:[[0,0],[10,0],[10,10],[0,10]],target_boundary_px:[[0,0],[20,0],[20,20],[0,20]]},sign_layout:{objects:[{bounds_cm:[[1,1],[2,1],[2,2],[1,2]],polygon_px:[[5,5],[6,5],[6,6],[5,6]],boundary_px:[[5,5],[6,5],[6,6],[5,6]]}]}};facadeRegion.editor.render();
  assert.equal(facadeRegion.element('generate').disabled,false,'Implicit facade boundary remains an available edit region');
  facadeRegion.generation.setRegion([[0,0],[1,0],[1,1],[0,1]]);facadeRegion.editor.render();
  assert.equal(facadeRegion.generation.settings().edit_region_source,'explicit');assert.equal(facadeRegion.element('generate').disabled,true);
  facadeRegion.generation.restore({edit_region_source:'placement_zone',edit_polygon_px:[[0,0],[1,0],[1,1],[0,1]]});facadeRegion.editor.render();
  assert.equal(facadeRegion.generation.settings().edit_polygon_px,null,'A placement-zone marker cannot restore stale corner fallback as an explicit region');
  assert.equal(facadeRegion.element('generate').disabled,false);
  // Retouch is opt-in. Its category selection is restored as an independent
  // value; neither imported project objects nor returned settings own the UI.
  const allRemovals = ['foreign_signs', 'litter', 'people', 'visual_clutter'];
  const retouch = page();
  await retouch.generation.ready;
  assert.deepEqual(clone(retouch.generation.settings().scene_retouch), {mode: 'off', removals: allRemovals});
  assert.equal(retouch.element('sceneRetouchOptions').hidden, true);
  const importedRetouch = {mode: 'ideal_environment', removals: ['people', 'foreign_signs', 'people', 'unknown']};
  retouch.generation.restore({scene_retouch: importedRetouch});
  assert.deepEqual(clone(retouch.generation.settings().scene_retouch), {mode: 'ideal_environment', removals: ['foreign_signs', 'people']});
  assert.equal(retouch.element('retouchForeignSigns').checked, true);
  assert.equal(retouch.element('retouchLitter').checked, false);
  assert.equal(retouch.element('retouchPeople').checked, true);
  assert.equal(retouch.element('retouchVisualClutter').checked, false);
  importedRetouch.mode = 'off'; importedRetouch.removals.push('litter');
  const returnedRetouch = retouch.generation.settings().scene_retouch;
  returnedRetouch.mode = 'off'; returnedRetouch.removals.length = 0;
  assert.deepEqual(clone(retouch.generation.settings().scene_retouch), {mode: 'ideal_environment', removals: ['foreign_signs', 'people']}, 'Retouch restoration and settings must not alias caller arrays or objects');
  retouch.generation.restore({scene_retouch: {mode: 'unknown'}});
  assert.deepEqual(clone(retouch.generation.settings().scene_retouch), {mode: 'off', removals: allRemovals}, 'Unknown retouch modes must fall back to the unretouched photo');
  retouch.generation.restore({});
  assert.deepEqual(clone(retouch.generation.settings().scene_retouch), {mode: 'off', removals: allRemovals}, 'Older projects without retouch must restore the default');

  // A legacy image has no retouch specification. Remembered categories while
  // off do not invalidate it; changing the active mode or categories does.
  const offProject = clone(originalProject);
  offProject.generation.scene_retouch = {mode: 'off', removals: ['people']};
  const offResult = page({project: offProject});
  await offResult.generation.restoreDraft(savedState());
  assert.equal(offResult.element('resultStale').hidden, true, 'Legacy results must compare equal to retouch off, regardless of inactive categories');
  offResult.state.project.generation.scene_retouch = {mode: 'ideal_environment', removals: ['people']};
  offResult.editor.render();
  assert.equal(offResult.element('resultStale').hidden, false, 'Enabling retouch changes the saved rendering specification');
  const idealProject = clone(offResult.state.project);
  const idealResult = page({project: idealProject, serverProject: idealProject});
  await idealResult.generation.restoreDraft(savedState());
  assert.equal(idealResult.element('resultStale').hidden, true);
  idealResult.state.project.generation.scene_retouch.removals.push('litter');
  idealResult.editor.render();
  assert.equal(idealResult.element('resultStale').hidden, false, 'An active retouch category change must invalidate a saved result');

  // Disabling the visual button is insufficient: direct event delivery must
  // also reject a retouch request before preparing a photo or allocating an ID.
  for (const unsupported of [undefined, false, 'true']) {
    const blocked = page({sceneRetouchConfigured: unsupported});
    await blocked.generation.ready;
    blocked.generation.restore({scene_retouch: {mode: 'ideal_environment', removals: ['people']}});
    blocked.editor.render();
    assert.equal(blocked.element('generate').disabled, true);
    assert.equal(blocked.element('sceneRetouchAvailability').hidden, false);
    assert.ok(blocked.element('generationReady').textContent.includes('пока не подключена'));
    await blocked.element('generate').onclick();
    assert.deepEqual(blocked.preparation, {generationIds: 0, photos: 0}, 'Unsupported retouch must be blocked before request preparation');
    assert.equal(blocked.requests.length, 1, 'Direct onclick must not send or poll an unsupported retouch job');
    assert.ok(blocked.element('generationStatus').textContent.includes('пока не подключена'));
    assert.equal(blocked.generation.draftState().pendingJobId, null);
  }
  const supported = page({sceneRetouchConfigured: true});
  await supported.generation.ready;
  supported.generation.restore({scene_retouch: {mode: 'ideal_environment', removals: ['people']}});
  supported.editor.render();
  assert.equal(supported.element('generate').disabled, false, 'Only an explicit supported capability enables retouch');
  assert.equal(supported.element('sceneRetouchAvailability').hidden, true);
  supported.generation.restore({scene_retouch: {mode: 'ideal_environment', removals: []}});
  supported.editor.render();
  assert.equal(supported.element('generate').disabled, true, 'Retouch needs at least one removal category even on a capable server');
  await supported.element('generate').onclick();
  assert.deepEqual(supported.preparation, {generationIds: 0, photos: 0});
  assert.equal(supported.requests.length, 1);
  assert.ok(supported.element('generationStatus').textContent.includes('хотя бы одну категорию'));

  // A mode change while an awaited preparation is in flight must not bypass
  // the capability gate that was valid when the button was initially pressed.
  const artworkGate = deferred(); let artworkPreparations = 0;
  const retouchRace = page({prepareArtwork: async () => {artworkPreparations++; await artworkGate.promise;}});
  await retouchRace.generation.ready;
  assert.equal(retouchRace.element('generate').disabled, false);
  const generating = retouchRace.element('generate').onclick();
  await settle();
  assert.equal(artworkPreparations, 1);
  retouchRace.element('sceneRetouch').value = 'ideal_environment';
  retouchRace.element('sceneRetouch').onchange();
  artworkGate.resolve(); await generating;
  assert.deepEqual(retouchRace.preparation, {generationIds: 0, photos: 0}, 'Retouch must be revalidated after awaited artwork preparation');
  assert.equal(retouchRace.requests.length, 1);
  assert.ok(retouchRace.element('generationStatus').textContent.includes('пока не подключена'));
  assert.equal(retouchRace.generation.draftState().pendingJobId, null);

  // Coordinates may change while fonts/PNG preparation is awaiting. The real
  // strict geometry report must be checked again, even though the scene can
  // still have a useful editing preview and the original click was permitted.
  const geometryProject = {version:1,image:{width_px:1200,height_px:800},
    calibration:{mode:'frontoparallel',length_cm:100,frontoparallel_assumed:true,image_points:[[0,0],[100,0]]},
    placement:{center_px:[400,200],width_cm:220,height_cm:45,rotation_deg:0},generation:{lighting:'original'},
    sign:{text:'АБВ',objects:[{id:'first',type:'text',text:'АБВ',font_family:'Arial',font_bold:true,
      x_cm:30,y_cm:10,rotation_deg:0,letter_height_cm:15,line_gap_cm:0,text_align:'left',front_color:'#ffeeee',
      preview_line_metrics:{font_size_px:100,lines:[{text:'АБВ',font_family:'Arial',font_weight:700,width:240,
        actualBoundingBoxLeft:0,actualBoundingBoxRight:240,actualBoundingBoxAscent:70,actualBoundingBoxDescent:10}]}}]}};
  for (const change of ['object_outside','placement_removed']) {
    const fontsGate = deferred();let started=0;
    const geometryRace = page({project:geometryProject,prepareArtwork:async()=>{started++;await fontsGate.promise;}});
    await geometryRace.generation.ready;
    const announce = geometryRace.editor.render;
    geometryRace.editor.render = () => {
      try{geometryRace.state.report=G.analyze(geometryRace.state.project);}catch{geometryRace.state.report=null;}
      announce();
    };
    geometryRace.editor.render();assert.equal(geometryRace.element('generate').disabled,false);
    const generating = geometryRace.element('generate').onclick();await settle();assert.equal(started,1);
    if(change==='object_outside')geometryRace.state.project.sign.objects[0].x_cm=500;
    else geometryRace.state.project.placement=null;
    geometryRace.editor.render();
    assert.equal(geometryRace.element('generate').disabled,true);
    if(change==='object_outside'){
      assert.equal(geometryRace.state.report,null);
      assert.equal(G.analyze(geometryRace.state.project,{preview:true}).sign_layout.objects.length,1,'The editing preview must not authorize an AI job');
    }else assert.equal(geometryRace.state.report.placement,null);
    fontsGate.resolve();await generating;
    assert.deepEqual(geometryRace.preparation,{generationIds:0,photos:0},'Recheck strict placement before allocating a job ID or preparing a photo');
    assert.equal(geometryRace.requests.length,1,'An in-flight click must not POST after geometry becomes invalid');
    assert.ok(geometryRace.element('generationStatus').textContent.includes('Исправьте параметры проекта'));
    assert.equal(geometryRace.generation.draftState().pendingJobId,null);
  }

  // Actual separate signs fit a diamond although the union bounding box does not.
  const installation=[[300,50],[550,300],[300,550],[50,300]],separateSigns=clone(geometryProject);
  separateSigns.sign.composition_mode='independent_signs_v1';separateSigns.placement=null;separateSigns.target_polygon_px=installation;
  separateSigns.sign.objects=[{...clone(geometryProject.sign.objects[0]),id:'upper',x_cm:300,y_cm:100},
    {...clone(geometryProject.sign.objects[0]),id:'left',x_cm:80,y_cm:290}];
  const signsPage=page({project:separateSigns,geometry:G});signsPage.editor.target=()=>signsPage.state.project.target_polygon_px;
  signsPage.state.report=G.analyze(signsPage.state.project);await signsPage.generation.ready;signsPage.editor.render();
  assert.equal(signsPage.state.report.placement.polygon_px.every(point=>G.inside(point,installation)),false);
  assert.equal(signsPage.element('generate').disabled,false,'Separate signs fit even when their union does not');
  signsPage.generation.setRegion([[275,75],[375,75],[375,175],[275,175]]);signsPage.editor.render();
  assert.equal(signsPage.element('generate').disabled,true,'Replacement zone must contain every separate sign');
  signsPage.generation.setRegion(null);delete signsPage.state.project.target_polygon_px;signsPage.editor.render();
  assert.equal(signsPage.element('generate').disabled,true,'An explicit installation zone is required');
  // Removing that zone during font preparation must not allocate or submit a job.
  const signsFonts=deferred(),signsRace=page({project:separateSigns,geometry:G,prepareArtwork:()=>signsFonts.promise});
  signsRace.editor.target=()=>signsRace.state.project.target_polygon_px;const signsAnnounce=signsRace.editor.render;
  signsRace.editor.render=()=>{try{signsRace.state.report=G.analyze(signsRace.state.project);}catch{signsRace.state.report=null;}signsAnnounce();};
  await signsRace.generation.ready;signsRace.editor.render();const signsSending=signsRace.element('generate').onclick();await settle();
  delete signsRace.state.project.target_polygon_px;signsFonts.resolve();await signsSending;
  assert.deepEqual(signsRace.preparation,{generationIds:0,photos:0});assert.equal(signsRace.requests.length,1);

  // A linked edit zone must remain linked, rather than freezing the resolved
  // target polygon stored inside project.generation before a reload.
  const linked = page();
  const linkedState = clone(linked.generation.draftState());
  assert.equal(linkedState.editRegion, null);
  const oldTarget = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const newTarget = [[20, 20], [30, 20], [30, 30], [20, 30]];
  linked.generation.restore({edit_polygon_px: oldTarget, lighting: 'original'});
  linked.editor.target = () => newTarget;
  await linked.generation.restoreDraft(linkedState);
  assert.deepEqual(clone(linked.generation.settings().edit_polygon_px), newTarget);
  assert.equal(linked.events.filter(type => type === 'signage:change').length, 1, 'Restoring a raw edit zone renders once even with no saved result');
  assert.equal(linked.requests.length, 1, 'Restoring only a linked edit zone needs no job request');
  const separate = page(), separatePolygon = [[40, 40], [80, 40], [80, 70], [40, 70]];
  separate.generation.setRegion(separatePolygon);
  const separateState = clone(separate.generation.draftState());
  separate.generation.restore({edit_polygon_px: oldTarget});
  separate.editor.target = () => newTarget;
  await separate.generation.restoreDraft(separateState);
  assert.deepEqual(clone(separate.generation.settings().edit_polygon_px), separatePolygon);
  separateState.editRegion[0][0] = 999;
  assert.equal(separate.generation.settings().edit_polygon_px[0][0], 40, 'Restored region must not alias the stored draft');
  await separate.generation.restoreDraft({editRegion: [[NaN, 0]], jobId: null});
  assert.deepEqual(clone(separate.generation.settings().edit_polygon_px), separatePolygon, 'Invalid raw region must not replace valid current geometry');
  const legacy = page();
  legacy.generation.restore({edit_polygon_px: separatePolygon});
  await legacy.generation.restoreDraft({jobId: null});
  assert.deepEqual(clone(legacy.generation.settings().edit_polygon_px), separatePolygon, 'Old drafts without raw editRegion keep restored project geometry');
  for (const prefix of ['/', '/signs/']) {
    const app = page({prefix});
    await app.generation.ready;
    const before = clone(app.state.project);
    assert.equal(await app.generation.restoreDraft(savedState({view: 'base'})), true);
    assert.deepEqual(app.state.project, before, 'Finished result restore must not replace current draft parameters');
    assert.deepEqual(app.restores, [], 'Finished result restore must not load its old source photo into the editor');
    assert.equal(app.element('aiResult').hidden, false);
    assert.equal(app.element('aiResult').scrolled, 0, 'Automatic result restore must retain the saved viewport/scroll');
    assert.ok(app.element('generatedImage').src.includes('lighting-base.png'));
    assert.equal(app.element('resultStale').hidden, true, 'Legacy Bold/ruler defaults and reordered keys should compare equal');
    assert.ok(app.events.includes('signage:resultchange'));
    app.element('showOriginal').onclick();
    const persisted = clone(app.generation.draftState());
    assert.equal(persisted.jobId, savedId); assert.equal(persisted.view, 'source');
    const reloaded = page({prefix});
    await reloaded.generation.ready;
    await reloaded.generation.restoreDraft(persisted);
    assert.ok(reloaded.element('generatedImage').src.includes('source.png'), 'Selected source tab must survive reload');
    app.state.project.sign.text = 'НОВЫЙ ТЕКСТ'; app.editor.render();
    assert.equal(app.element('resultStale').hidden, false);
    const editedReload = page({prefix, project: app.state.project});
    await editedReload.generation.restoreDraft(app.generation.draftState());
    assert.equal(editedReload.state.project.sign.text, 'НОВЫЙ ТЕКСТ');
    assert.equal(editedReload.element('resultStale').hidden, false, 'Server result must still be compared with its old saved specification');
    app.state.photoRevision++; app.editor.render();
    assert.equal(app.generation.draftState().photoMatchesResult, false);
    const differentPhoto = page({prefix});
    await differentPhoto.generation.restoreDraft(app.generation.draftState());
    assert.equal(differentPhoto.element('resultStale').hidden, false, 'A different current photo must not be mistaken for the result source');
  }

  // Scene cleanup has its own saved base. Viewing or restoring it is entirely
  // read-only, and older jobs must not inherit a previous job's scene URL.
  for (const prefix of ['/', '/signs/']) {
    const sceneAudit = {scene_retouch: {enabled: true}, exact_artwork: true};
    const app = page({prefix, audit: sceneAudit});
    assert.equal(await app.generation.restoreDraft(savedState()), true);
    const sceneReads = app.requests.filter(request => request.pathname.endsWith('/scene-base.png'));
    assert.equal(sceneReads.length, 1, 'A completed retouch job must load its separate scene base');
    assert.equal(sceneReads[0].method, 'GET');
    assert.equal(app.element('showScene').hidden, false);
    assert.ok(app.element('resultVerification').textContent.includes('основы после ретуши'), 'Pixel protection must refer to the retouched base');
    app.element('showScene').onclick();
    assert.ok(app.element('generatedImage').src.includes('scene-base.png'));
    assert.equal(app.element('generatedImage').alt, 'Фотография после ретуши окружения без нового изделия');
    assert.equal(app.element('showScene').classes.has('active'), true);
    assert.equal(app.element('showRender').classes.has('active'), false);
    const sceneState = clone(app.generation.draftState());
    assert.equal(sceneState.view, 'scene', 'The selected retouch comparison tab must persist in the draft');
    const restored = page({prefix, audit: sceneAudit});
    assert.equal(await restored.generation.restoreDraft(sceneState), true);
    assert.ok(restored.element('generatedImage').src.includes('scene-base.png'), 'Reload must restore the scene comparison image');
    assert.equal(restored.generation.draftState().view, 'scene');
    assert.equal(restored.element('showScene').hidden, false);

    const legacyResult = page({prefix});
    assert.equal(await legacyResult.generation.restoreDraft(sceneState), true);
    assert.equal(legacyResult.element('showScene').hidden, true, 'A legacy result has no retouch comparison tab');
    assert.ok(legacyResult.element('generatedImage').src.includes('render.png'), 'A remembered scene tab falls back to the main image for a legacy result');
    assert.equal(legacyResult.generation.draftState().view, 'render');
    assert.ok(!legacyResult.requests.some(request => request.pathname.endsWith('/scene-base.png')), 'Never request a missing scene artifact from a legacy job');

    sceneAudit.scene_retouch.enabled = false;
    const beforeOlderResult = app.requests.length;
    assert.equal(await app.generation.restoreDraft(savedState({jobId: 'legacy-result-00000001', view: 'scene'})), true);
    assert.equal(app.element('showScene').hidden, true, 'Switching from a retouched result to an older result hides the previous scene tab');
    assert.ok(app.element('generatedImage').src.includes('render.png'));
    assert.equal(app.generation.draftState().view, 'render');
    assert.ok(!app.requests.slice(beforeOlderResult).some(request => request.pathname.endsWith('/scene-base.png')));
    app.element('showScene').onclick();
    assert.equal(app.generation.draftState().view, 'render', 'A direct click on a hidden legacy scene tab cannot reuse a stale scene URL');
    assert.deepEqual(app.preparation, {generationIds: 0, photos: 0});
  }

  for (const failure of ['job', 'artifact']) {
    const app = page({failedPath: pathname => failure === 'job' ? pathname.endsWith('/' + savedId) : pathname.endsWith('/render.png')});
    const before = clone(app.state);
    assert.equal(await app.generation.restoreDraft(savedState()), false);
    assert.deepEqual(app.state, before, 'Missing jobs/artifacts must preserve the current photo and project');
    assert.equal(app.element('aiResult').hidden, true);
    assert.ok(app.element('generationStatus').textContent.includes('сохранён'));
  }

  // Pending requests win over an older finished result and start polling only
  // after local draft restoration. They never create or resubmit a generation.
  const gate = deferred(), storage = new Map([['signage-pending-job:/signs/', pendingId]]);
  const pending = page({storage, draftReady: gate.promise, statusSequence: ['running', 'complete']});
  await pending.generation.ready;
  assert.equal(await pending.generation.restoreDraft(savedState({pendingJobId: pendingId, pendingPhotoMatches: true})), false);
  assert.equal(pending.requests.length, 1, 'Pending job must wait for draft.ready before reading its result');
  gate.resolve(); await settle();
  assert.ok(pending.requests.some(request => request.pathname.endsWith('/' + pendingId)));
  assert.ok(!pending.requests.some(request => request.pathname.endsWith('/' + savedId)));
  assert.equal(pending.timers.length, 1);
  pending.timers.shift().callback(); await settle();
  assert.equal(pending.generation.draftState().jobId, pendingId);
  assert.equal(pending.generation.draftState().photoMatchesResult, true);
  assert.equal(pending.storage.has('signage-pending-job:/signs/'), false);
  assert.equal(pending.element('aiResult').scrolled, 0);
  const offlineConnection = {online: false}, offlineStorage = new Map([['signage-pending-job:/signs/', pendingId]]);
  const offline = page({storage: offlineStorage, connection: offlineConnection});
  await settle();
  assert.equal(offline.element('generate').disabled, true, 'An unresolved pending job must block a duplicate request even while offline');
  assert.equal(offline.element('resumeGeneration').hidden, false);
  offlineConnection.online = true;
  await offline.element('resumeGeneration').onclick(); await settle();
  assert.equal(offline.generation.draftState().jobId, pendingId, 'Reconnect must resume the existing ID');
  assert.equal(offline.storage.has('signage-pending-job:/signs/'), false);

  // An explicit history URL keeps priority even after generation.js removes
  // its query parameter following a successful project restore.
  const historyGate = deferred(), explicit = page({query: '?restoreJob=' + savedId, draftReady: historyGate.promise});
  await explicit.generation.ready;
  assert.equal(await explicit.generation.restoreDraft(savedState({jobId: 'older-result-000000001'})), false);
  historyGate.resolve(); await settle();
  assert.equal(explicit.restores.length, 1);
  assert.equal(explicit.location.search, '');
  assert.equal(await explicit.generation.restoreDraft(savedState({jobId: 'older-result-000000001'})), false);
  assert.equal(explicit.generation.draftState().jobId, savedId);
  const invalidHistory = page({query: '?restoreJob='});
  await settle();
  assert.equal(await invalidHistory.generation.restoreDraft(savedState()), false);
  assert.ok(invalidHistory.element('generationStatus').textContent.includes('Некорректный'));

  // A user action while the network is slow wins over the old draft result.
  for (const pauseAt of ['job', 'artifact', 'project']) {
    const response = deferred(); let mayApply = true;
    const app = page({responseGate: {promise: response.promise, match: pathname => pauseAt === 'job' ? pathname.endsWith('/' + savedId) : pathname.endsWith(pauseAt === 'artifact' ? '/render.png' : '/project.json')}});
    const restoring = app.generation.restoreDraft(savedState(), {shouldApply: () => mayApply});
    await settle(); mayApply = false; app.state.project.sign.text = 'Пользователь уже изменил проект';
    response.resolve(); assert.equal(await restoring, false);
    assert.equal(app.element('aiResult').hidden, true);
    assert.equal(app.state.project.sign.text, 'Пользователь уже изменил проект');
  }
  const newerResult = page();
  await newerResult.generation.restoreDraft(savedState());
  const restoring = newerResult.generation.restoreDraft(savedState({view: 'base'}));
  newerResult.element('showOriginal').onclick();
  assert.equal(await restoring, false, 'A newer result-tab selection wins over pending draft restore');
  assert.equal(newerResult.generation.draftState().view, 'source');

  // Two-stage execution changes only the generation route. The saved project
  // remains the authority; AI images never supply dimensions to the editor.
  const twoStageProject=clone(geometryProject);
  twoStageProject.generation.engine='codex';
  const sourceBefore=clone(twoStageProject);
  const ownerConstruction={version:1,face:{material:'acrylic',thickness_mm:null},returns:{material:'aluminium',thickness_mm:null,finish:null},provenance:{face_material:'owner_confirmed',returns_material:'owner_confirmed'}};
  for(const capability of [undefined,false,'true',true]){
    const route=page({project:twoStageProject,serverProject:twoStageProject,productUI:true,twoStageConfigured:capability});
    await route.generation.ready;
    assert.equal(route.generation.settings().engine,capability===true?'codex_two_stage':'codex');
    assert.equal(route.element('generate').textContent,capability===true?'Визуализировать':'Создать ИИ-макет');
    assert.deepEqual(twoStageProject,sourceBefore,'Config and settings cannot change imported source dimensions, object parameters or artwork');
  }
  const plaque=P.createProduct('plaque'),plaqueProject={version:2,sign:clone(plaque.params),products:[plaque],active_product_id:plaque.id,generation:{lighting:'original'}};
  const otherProduct=page({project:plaqueProject,productUI:true,twoStageConfigured:true});
  await otherProduct.generation.ready;
  assert.equal(otherProduct.generation.settings().engine,'composite','Another product keeps its own rendering route');

  const newEngineProject=clone(twoStageProject);newEngineProject.generation.engine='codex_two_stage';newEngineProject.sign.construction=clone(ownerConstruction);
  const newEngineBefore=clone(newEngineProject);
  const nightRoute=page({project:twoStageProject,productUI:true,twoStageConfigured:true});
  await nightRoute.generation.ready;
  assert.ok(nightRoute.element('lightingHint').textContent.includes('внутренняя подсветка выключена'));
  nightRoute.element('lighting').value='night';nightRoute.element('lighting').onchange();
  assert.ok(nightRoute.element('lightingHint').textContent.includes('через акриловое лицо'));
  assert.ok(nightRoute.element('lightingHint').textContent.includes('контражур используется только по явному ТЗ'));
  assert.ok(nightRoute.element('lightingHint').textContent.includes('Температура LED не задана'));
  assert.ok(!nightRoute.element('lightingHint').textContent.includes('3000'),'No invented default LED temperature on the new route');
  const warmInput=clone(twoStageProject);warmInput.sign.face_material={type:'custom',led_temperature_k:6000};
  const explicitTemperature=page({project:warmInput,productUI:true,twoStageConfigured:true});
  await explicitTemperature.generation.ready;explicitTemperature.element('lighting').value='night';explicitTemperature.element('lighting').onchange();
  assert.ok(explicitTemperature.element('lightingHint').textContent.includes('6000 K'));
  const legacyNight=page({project:twoStageProject,productUI:true,twoStageConfigured:false});
  await legacyNight.generation.ready;legacyNight.element('lighting').value='night';legacyNight.element('lighting').onchange();
  assert.ok(legacyNight.element('lightingHint').textContent.includes('3000 K'),'Preserve existing legacy route wording');
  for(const different of [null,{...clone(ownerConstruction),face:{material:'acrylic',thickness_mm:3}},{...clone(ownerConstruction),returns:{material:'aluminium',thickness_mm:null,finish:'satin'}},{...clone(ownerConstruction),other:'explicit specification'}]){
    const changedProfile=clone(twoStageProject);changedProfile.sign.construction=different;
    const profilePage=page({project:changedProfile,serverProject:newEngineProject,productUI:true,twoStageConfigured:true});
    assert.equal(await profilePage.generation.restoreDraft(savedState()),true);
    assert.equal(profilePage.element('resultStale').hidden,false,'Only the exact default construction profile may compare equal to an omitted profile');
  }
  for(const prefix of ['/','/signs/']){
    const flags={engine:'codex_two_stage',has_product_neutral:true,has_layout_guide:true,has_production_spec:true};
    const locked=page({prefix,project:twoStageProject,serverProject:newEngineProject,productUI:true,twoStageConfigured:true,jobInfo:flags,audit:{exact_front_geometry:true}});
    assert.equal(await locked.generation.restoreDraft(savedState()),true);
    assert.equal(locked.element('resultGeometryLabel').textContent,'Размер и положение совпадают с разметкой');
    assert.ok(locked.element('resultVerification').textContent.includes('перспектива зафиксированы'));
    assert.ok(locked.element('resultMaterial').textContent.includes('Контуры лиц, размер и положение перенесены'));
    assert.ok(!locked.element('resultVerification').textContent.includes('требуют сравнения'));
    const app=page({prefix,project:twoStageProject,serverProject:newEngineProject,productUI:true,twoStageConfigured:true,jobInfo:flags});
    assert.equal(await app.generation.restoreDraft(savedState({view:'neutral'})),true);
    assert.equal(app.element('resultStale').hidden,true,'The Codex execution alias alone cannot invalidate an older saved specification');
    assert.deepEqual(twoStageProject,sourceBefore,'Comparison must not insert construction into the caller source');
    assert.deepEqual(newEngineProject,newEngineBefore,'Comparison must not edit the server snapshot');
    assert.equal(app.element('showNeutral').hidden,false);assert.equal(app.element('showGuide').hidden,false);
    assert.equal(app.element('downloadProductionSpec').hidden,false);
    assert.ok(app.element('generatedImage').src.includes('product-neutral.png'));
    assert.equal(app.generation.draftState().view,'neutral');
    assert.ok(app.element('resultVerification').textContent.includes('требуют сравнения'));
    assert.equal(app.element('resultGeometryLabel').textContent,'Разметка и размеры сохранены');
    assert.ok(app.element('resultMaterial').textContent.startsWith('Сохранённое ТЗ'));
    assert.ok(app.element('resultMaterial').textContent.includes('максимальная высота строки по ТЗ 15 см'));
    assert.ok(app.element('resultMaterial').textContent.includes('глубина по ТЗ не задана'),'Do not invent a physical thickness/depth in saved source copy');
    assert.ok(app.element('resultMaterial').textContent.includes('Исходных данных JSON'));
    assert.ok(app.element('resultMaterial').textContent.includes('Внешний вид изделия и установки создан ИИ'));
    assert.ok(!app.element('resultMaterial').textContent.includes('переносятся из сохранённых PNG'),'The AI final image is not the legacy exact-PNG compositor');
    app.element('showGuide').onclick();
    assert.ok(app.element('generatedImage').src.includes('layout-guide.png'));
    assert.equal(app.generation.draftState().view,'guide');
    const reload=page({prefix,project:twoStageProject,serverProject:newEngineProject,productUI:true,twoStageConfigured:true,jobInfo:flags});
    assert.equal(await reload.generation.restoreDraft(clone(app.generation.draftState())),true);
    assert.equal(reload.generation.draftState().view,'guide');
    assert.ok(reload.element('generatedImage').src.includes('layout-guide.png'));
    assert.ok(!app.requests.some(r=>r.pathname.endsWith('/production-spec.json')),'The immutable JSON is downloaded only on request');
    await app.element('downloadProductionSpec').onclick();
    const jsonRead=app.requests.find(r=>r.pathname.endsWith('/production-spec.json'));
    assert.equal(jsonRead.method,'GET');assert.equal(jsonRead.token,'fixture-token');assert.equal(jsonRead.credentials,'same-origin');
    assert.equal(app.downloads[0][0].source,'saved immutable specification','Download the server snapshot instead of the edited project');
    assert.equal(app.downloads[0][1],`production-spec-${savedId}.json`);
    const optionalReads=app.requests.filter(r=>/\/(product-neutral|layout-guide)\.png$/.test(r.pathname));
    assert.equal(optionalReads.length,2);
    optionalReads.forEach(r=>{assert.equal(r.method,'GET');assert.equal(r.token,'fixture-token');assert.equal(r.credentials,'same-origin');});
    app.state.project.sign.objects[0].letter_height_cm+=1;app.editor.render();
    assert.equal(app.element('resultStale').hidden,false,'A physical dimension change remains a real stale edit');
    assert.equal(await app.generation.restoreDraft(savedState({jobId:'older-result-000000001',view:'guide'})),true);
    // Switching metadata to an old result cannot reuse optional image URLs.
    flags.has_product_neutral=false;flags.has_layout_guide=false;flags.has_production_spec=false;flags.engine='codex';
    assert.equal(await app.generation.restoreDraft(savedState({jobId:'legacy-result-00000001',view:'guide'})),true);
    assert.equal(app.generation.draftState().view,'render');
    assert.equal(app.element('showNeutral').hidden,true);assert.equal(app.element('showGuide').hidden,true);
    assert.equal(app.element('downloadProductionSpec').hidden,true);
    assert.equal(app.element('resultMaterial').textContent,'Тексты и логотипы переносятся из сохранённых PNG.','Preserve legacy saved-history material copy');
    app.element('showGuide').onclick();assert.equal(app.generation.draftState().view,'render');
    assert.deepEqual(app.preparation,{generationIds:0,photos:0},'Result tabs, reload and immutable JSON download never prepare an AI request');

    const absent=page({prefix,jobInfo:{engine:'codex_two_stage',has_product_neutral:true,has_layout_guide:true},failedPath:pathname=>/\/(product-neutral|layout-guide)\.png$/.test(pathname)});
    assert.equal(await absent.generation.restoreDraft(savedState({view:'neutral'})),true,'Missing optional artifacts cannot turn a complete saved render into an error');
    assert.equal(absent.element('aiResult').hidden,false);assert.equal(absent.element('showNeutral').hidden,true);assert.equal(absent.element('showGuide').hidden,true);
    assert.equal(absent.generation.draftState().view,'render');
  }

  // The saved height contract separates the nominal body from every complete
  // outline. This is source/audit metadata, never a measurement of the AI photo.
  const screenshotPair=clone(geometryProject);
  screenshotPair.sign.composition_mode='independent_signs_v1';screenshotPair.placement=null;
  screenshotPair.sign.objects=[['ДЕТЕЙЛИНГ',609.85546875,92,16],['КОФЕ',279.169921875,73,1]].map(([text,width,ascent,descent],index)=>({
    id:`screenshot-${index}`,type:'text',text,font_family:'Arial',font_bold:true,x_cm:30+index*470,y_cm:60,rotation_deg:0,
    letter_height_cm:50,height_basis:'body',height_reference:'auto',line_gap_cm:0,text_align:'left',front_color:'#ffeeee',
    preview_line_metrics:{font_size_px:100,lines:[{text,font_family:'Arial',font_weight:700,width,
      actualBoundingBoxLeft:0,actualBoundingBoxRight:width,actualBoundingBoxAscent:ascent,actualBoundingBoxDescent:descent}],
      height_reference:{text:'Н',font_family:'Arial',font_weight:700,width:72,actualBoundingBoxLeft:0,actualBoundingBoxRight:72,actualBoundingBoxAscent:72,actualBoundingBoxDescent:0}}}));
  const savedPairBefore=clone(screenshotPair),savedPairGeometry=G.analyze(screenshotPair);
  const bodySummary=page({project:screenshotPair,serverProject:screenshotPair,productUI:true,twoStageConfigured:true,
    jobInfo:{engine:'codex_two_stage',has_production_spec:true},audit:{geometry:savedPairGeometry}});
  assert.equal(await bodySummary.generation.restoreDraft(savedState()),true);
  const summary=bodySummary.element('resultMaterial').textContent;
  assert.ok(summary.includes('«ДЕТЕЙЛИНГ»; основная высота по ТЗ 50 см; полный габарит 423,511 см × 75 см'));
  assert.ok(summary.includes('«КОФЕ»; основная высота по ТЗ 50 см; полный габарит 193,868 см × 51,389 см'));
  assert.ok(!summary.includes('максимальная высота строки по ТЗ'),'Body sizing must not be described as a full row height');
  bodySummary.state.project.sign.objects[0].letter_height_cm=5;bodySummary.editor.render();
  assert.equal(bodySummary.element('resultMaterial').textContent,summary,'A live edit cannot rewrite the saved size recap');
  assert.deepEqual(screenshotPair,savedPairBefore);
  const noSavedGeometry=page({project:screenshotPair,serverProject:screenshotPair,productUI:true,twoStageConfigured:true,
    jobInfo:{engine:'codex_two_stage'}});
  assert.equal(await noSavedGeometry.generation.restoreDraft(savedState()),true);
  assert.ok(noSavedGeometry.element('resultMaterial').textContent.includes('основная высота по ТЗ 50 см'));
  assert.ok(!noSavedGeometry.element('resultMaterial').textContent.includes('полный габарит'),'Missing saved geometry cannot invent a full size');

  // Both server phases recover by polling one persisted ID. Reload never posts
  // a new request; the original server message identifies the active phase.
  const stageStorage=new Map([['signage-pending-job:/signs/',pendingId]]);
  const stageProgress=page({storage:stageStorage,statusSequence:[{status:'queued',message:'1/2 · Подготовка изделия: ожидает запуска'},{status:'running',message:'2/2 · Установка на фото: согласование света'},'complete'],jobInfo:{engine:'codex_two_stage',has_product_neutral:true,has_layout_guide:true,has_production_spec:true}});
  await settle();assert.ok(stageProgress.element('generationStatus').textContent.startsWith('1/2'));
  assert.equal(stageProgress.generation.draftState().pendingJobId,pendingId);
  stageProgress.timers.shift().callback();await settle();
  assert.ok(stageProgress.element('generationStatus').textContent.startsWith('2/2'));
  stageProgress.timers.shift().callback();await settle();
  assert.equal(stageProgress.generation.draftState().jobId,pendingId);
  assert.equal(stageProgress.requests.filter(r=>r.method==='POST').length,0);

  // One explicit click starts one server job, even when it internally performs
  // two image generations. Clicking while busy cannot allocate a second ID.
  const workspaceId='workspace-project-000001',sourceJobId='source-neutral-job-000001',workspaceEvents=[];
  const sendingWorkspace={ready:Promise.resolve(),context:()=>({id:workspaceId,sourceJobId}),flush:async()=>{workspaceEvents.push('flush');return true;},recordJob:id=>workspaceEvents.push(id)};
  const sending=page({project:twoStageProject,productUI:true,twoStageConfigured:true,allowGeneration:true,statusSequence:['running','complete'],jobInfo:{engine:'codex_two_stage',project_id:workspaceId},workspace:sendingWorkspace});
  await sending.generation.ready;
  sending.editor.target=()=>[[0,0],[1200,0],[1200,800],[0,800]];
  const announceSending=sending.editor.render;
  sending.editor.render=()=>{sending.state.project.generation={...sending.state.project.generation,...sending.generation.settings()};sending.state.report=G.analyze(sending.state.project);announceSending();};
  sending.editor.render();assert.equal(sending.element('generate').disabled,false);
  await sending.element('generate').onclick();await settle();await sending.element('generate').onclick();
  const posts=sending.requests.filter(r=>r.method==='POST');
  assert.equal(posts.length,1);assert.equal(posts[0].body.project.generation.engine,'codex_two_stage');
  assert.equal(posts[0].body.project_id,workspaceId);assert.equal(posts[0].body.source_job_id,sourceJobId,'The current workspace source job remains available for neutral-product reuse');
  assert.deepEqual(workspaceEvents,['flush','submitted-result-0000001'],'Save the workspace once before posting, then link the one new job');
  assert.equal(posts[0].pathname,'/signs/api/jobs');assert.equal(posts[0].token,'fixture-token');assert.equal(posts[0].credentials,'same-origin');
  assert.deepEqual(sending.preparation,{generationIds:1,photos:1});
  sending.timers.shift().callback();await settle();assert.equal(sending.generation.draftState().pendingJobId,null);
  assert.deepEqual(twoStageProject,sourceBefore,'The generation payload cannot mutate the caller source project');
  const foreignPending=page({workspace:sendingWorkspace,storage:new Map([['signage-pending-job:/signs/',pendingId]]),jobInfo:{engine:'codex_two_stage',project_id:'foreign-workspace-00001'},statusSequence:['running']});
  await settle();
  assert.equal(foreignPending.generation.draftState().pendingJobId,null,'A pending job from another workspace cannot resume under this project');
  assert.equal(foreignPending.storage.has('signage-pending-job:/signs/'),false);
  assert.equal(foreignPending.requests.filter(r=>r.method==='POST').length,0);
  console.log('PASS: legacy restore/retouch/geometry safeguards; two-stage capability and product routes, authenticated prefixed optional tabs and immutable JSON download, absent artifacts, alias/stale comparison, two-phase read-only recovery and one explicit job POST.');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
