'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Products = require('../assets/products.js');

// Execute the shipped page scripts against a tiny DOM and a same-directory server.
// Wrong-root requests fail, so the assertions cover real fetches and page actions.
const id = '00000000-0000-4000-8000-000000000001';
const projectId = '00000000-0000-4000-8000-000000000101';
const secondProjectId = '00000000-0000-4000-8000-000000000102';
const project = {sign: {text: 'ЦВЕТЫ', front_color: '#ffffff', side_color: '#ff00aa'}};
const audit = {canvas_size_px: [960, 1280], changed_pixels_outside_edit_zone: 0};
const job = {id, status: 'complete', message: 'Готово', lighting: 'original', audit};
const projectMetadata = {id: projectId, name: 'Цветочный магазин', revision: 1, updated_at: 1, variant_count: 1, last_job_id: id, thumbnail_job_id: id};
class Element {
  constructor(tagName = 'div', id = '') { this.tagName = tagName; this.id = id; this.children = []; this.value = ''; this.hidden = false; this.className = ''; this.dataset = {}; this.isConnected = true; this.disabled = false; this.classList = {toggle() {}, remove() {}}; }
  append(...items) { for (const item of items) item.parentNode = this; this.children.push(...items); }
  replaceChildren(...items) { this.children = []; this.append(...items); if (this.tagName === 'select') this.value = items[0]?.value || ''; }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (matches(node, selector)) return node; return null; }
  scrollIntoView() {}
  focus() {}
}
function matches(element, selector) {
  if (selector.startsWith('.')) return element.className.split(/\s+/).includes(selector.slice(1));
  if (selector.startsWith('#')) return element.id === selector.slice(1);
  return element.tagName === selector;
}
function page(script, href, prefix, storage = new Map(), auth = {accepted: true}, fixtures = {}) {
  const elements = new Map(), requests = [], storageWrites = [], navigations = [];
  const element = name => { if (!elements.has(name)) elements.set(name, new Element(name === 'mergeTarget' ? 'select' : 'div', name)); return elements.get(name); };
  for (const name of ['projectHeading','projectBreadcrumb','mergePanel','detail']) element(name).hidden=true;
  element('lighting').value = 'original';
  const location = new URL(href);
  location.assign = target => navigations.push(String(target));
  const document = {getElementById: element, createElement: tag => new Element(tag), addEventListener() {}, dispatchEvent() {}, querySelectorAll(selector) {
    const all = new Set();
    const visit = node => { if (all.has(node)) return; all.add(node); node.children.forEach(visit); };
    [...elements.values()].forEach(visit);
    return [...all].filter(node => selector.split(',').some(part => {
      const [ancestor, descendant] = part.trim().split(/\s+/);
      return descendant ? matches(node, descendant) && !!node.parentNode?.closest(ancestor) : matches(node, ancestor);
    }));
  }};
  const editor = {
    snapshot: () => ({project, hasPhoto: true, photoRevision: 1, report: {placement: {fits_target: true, polygon_px: []}}}),
    target: () => [[0, 0], [10, 0], [10, 10], [0, 10]], photoPng: () => 'data:image/png;base64,AA==', render() {}
  };
  const fetch = async (input, options = {}) => {
    const url = new URL(input, href);
    requests.push({url: url.href, method: options.method || 'GET', headers: {...options.headers}, body: options.body});
    assert.equal(url.origin, location.origin);
    assert.ok(url.pathname.startsWith(prefix + 'api/'), `API escaped app directory: ${url.href}`);
    if (!auth.accepted) return {ok: false, status: 401, json: async () => ({error: 'Требуется вход', auth_required: true})};
    const endpoint = url.pathname.slice(prefix.length);
    const projectItems = fixtures.projectItems || [projectMetadata];
    const historyItems = fixtures.historyItems || [{...job, text: project.sign.text, created: 1, project_id: projectId}];
    if (endpoint === 'api/projects/merge' && fixtures.mergeError) return {ok: false, status: 409, json: async () => ({error: fixtures.mergeError})};
    const data = endpoint === 'api/config' ? {provider: 'codex', configured: true, token: 'test-token'} :
      endpoint === 'api/projects' ? {items: projectItems, total: projectItems.length} :
      /^api\/projects\/[^/]+\/jobs$/.test(endpoint) ? {items: historyItems, total: historyItems.length} :
      endpoint === 'api/projects/merge' ? {...projectItems.find(item => item.id === JSON.parse(options.body).target_id), variant_count: undefined} :
      endpoint.endsWith('/project.json') ? (fixtures.project||project) : (fixtures.job||job);
    return {ok: true, json: async () => data, blob: async () => new Blob(['fixture'])};
  };
  const context = {
    URL, URLSearchParams, Blob, Event, AbortController, document, location, fetch, console,
    crypto: {randomUUID: () => id},
    sessionStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => { storageWrites.push(key); storage.set(key, value); },
      removeItem: key => { storageWrites.push(key); storage.delete(key); }
    },
    setTimeout: () => { throw new Error('Unexpected polling retry'); },
    window: {...(fixtures.products ? {SignageProducts: fixtures.products} : {}), addEventListener() {}, SignageEditor: editor, SignagePreview: {colorSwatches() {}, materialSummary: () => ''},
      LetterGeometry: {quad() {}, inside: () => true}}
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets', script), 'utf8'), context, {filename: script});
  return {element, requests, storageWrites, storage, navigations, generation:context.window.SignageGeneration};
}
async function settle() { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); }
async function checkGeneration(prefix, pageName) {
  const origin = 'https://example.test', storage = new Map([['signage-pending-job:/other/', 'other-directory-job']]);
  const app = page('generation.js', origin + prefix + pageName, prefix, storage);
  await settle();
  assert.equal(app.requests.length, 1, 'Another app directory must not resume its pending job');
  assert.equal(app.requests[0].url, origin + prefix + 'api/config');
  assert.equal(app.element('generate').disabled, false);
  await app.element('generate').onclick();
  await settle();
  const expected = ['api/config', 'api/jobs', `api/jobs/${id}`, ...['render.png', 'lighting-base.png', 'source.png', 'project.json'].map(file => `api/jobs/${id}/${file}`)];
  assert.deepEqual(app.requests.map(request => request.url), expected.map(route => origin + prefix + route));
  assert.equal(app.requests[1].method, 'POST');
  assert.equal(app.element('aiResult').hidden, false);
  assert.deepEqual(app.storageWrites, [`signage-pending-job:${prefix}`, `signage-pending-job:${prefix}`]);
  assert.equal(app.storage.get('signage-pending-job:/other/'), 'other-directory-job');
}
async function checkHistory(prefix) {
  const origin = 'https://example.test', href = origin + prefix + 'history.html';
  const app = page('history.js', href, prefix);
  await settle();
  assert.equal(app.element('historyGrid').children.length, 1);
  assert.equal(app.requests[1].url, origin + prefix + 'api/projects?limit=24&offset=0&q=');
  const card = app.element('historyGrid').children[0];
  assert.equal(new URL(card.children[2].children[1].href, href).href, origin + prefix + 'calibrator.html?restoreProject=' + projectId);
  await card.children[1].onclick();
  await settle();
  assert.equal(app.element('projectHeading').hidden, false);
  assert.equal(app.element('projectTitle').textContent, projectMetadata.name);
  assert.equal(new URL(app.element('continueProject').href, href).href, origin + prefix + 'calibrator.html?restoreProject=' + projectId);
  assert.ok(app.requests.some(request => request.url === origin + prefix + `api/projects/${projectId}/jobs?limit=24&offset=0&q=`));
  await app.element('historyGrid').children[0].onclick();
  await settle();
  app.element('viewSource').onclick();
  await settle();
  assert.equal(new URL(app.element('restoreProject').href, href).href, origin + prefix + 'calibrator.html?restoreJob=' + id);
  for (const file of ['thumbnail.jpg', 'project.json', 'render.png', 'source.png']) {
    assert.ok(app.requests.some(request => request.url === origin + prefix + `api/jobs/${id}/${file}`), `${prefix}: ${file}`);
  }
  app.element('search').value = 'ЦВЕТЫ & БУКЕТЫ';
  app.element('searchForm').onsubmit({preventDefault() {}});
  await settle();
  assert.ok(app.requests.some(request => request.url === origin + prefix + `api/projects/${projectId}/jobs?limit=24&offset=0&q=` + encodeURIComponent('ЦВЕТЫ & БУКЕТЫ')));
  await app.element('backToProjects').onclick();
  await settle();
  assert.equal(app.element('projectHeading').hidden, true);
  app.element('search').value = 'ЦВЕТЫ & БУКЕТЫ';
  app.element('searchForm').onsubmit({preventDefault() {}});
  await settle();
  assert.ok(app.requests.some(request => request.url === origin + prefix + 'api/projects?limit=24&offset=0&q=' + encodeURIComponent('ЦВЕТЫ & БУКЕТЫ')));
  assert.ok(app.requests.every(request => request.method === 'GET'), 'Opening projects and variants must never generate');
}
async function openFirstProject(app) { await settle(); await app.element('historyGrid').children[0].children[1].onclick(); await settle(); }
async function checkDraftOnlyProject(prefix) {
  const draft = {...projectMetadata, name: 'Черновик <без генераций>', variant_count: 0, last_job_id: null, thumbnail_job_id: null};
  const app = page('history.js', 'https://example.test'+prefix+'history.html', prefix, new Map(), {accepted:true}, {projectItems:[draft], historyItems:[]});
  await settle();
  const card = app.element('historyGrid').children[0];
  assert.equal(card.children[1].children[0].textContent, 'Сохранённый черновик');
  assert.equal(card.children[1].children[1].children[0].textContent, draft.name, 'Project names are plain text');
  assert.equal(card.children[1].children[1].children[0].children.length, 0);
  await openFirstProject(app);
  assert.equal(app.element('historyGrid').children.length, 0);
  assert.match(app.element('historyStatus').textContent, /Продолжить редактирование/);
  assert.ok(app.element('continueProject').href.endsWith('restoreProject='+projectId));
  assert.ok(app.requests.every(request=>request.method==='GET' && !/api\/jobs\//.test(request.url)), 'A draft can open without fetching generation artifacts or generating');
}
async function checkProjectMerge(prefix) {
  const source = {...projectMetadata, id:secondProjectId, name:'Другая версия'};
  const fixtures = {projectItems:[projectMetadata,source], historyItems:[{...job,text:'Первый вариант'},{...job,id:id.slice(0,-1)+'2',text:'Второй вариант'}]};
  const app = page('history.js', 'https://example.test'+prefix+'history.html', prefix, new Map(), {accepted:true}, fixtures);
  await settle();
  const cards = app.element('historyGrid').children;
  const choose = index => {const checkbox=cards[index].children[0].children[0];checkbox.checked=true;checkbox.onchange();};
  choose(0);
  assert.equal(app.element('mergeTarget').value, projectId, 'First selected project is the default merge target');
  assert.equal(app.element('mergeProjects').disabled, true);
  await app.element('mergeProjects').onclick();
  assert.ok(app.requests.every(request=>request.method==='GET'), 'One selected project cannot submit a merge');
  choose(1);
  assert.equal(app.element('mergeProjects').disabled, false);
  assert.equal(app.element('mergeTarget').value, projectId);
  assert.equal(app.element('mergeTarget').children.length, 2);
  app.element('mergeTarget').value=secondProjectId;app.element('mergeTarget').onchange();
  assert.match(app.element('mergeHint').textContent, /Другая версия/);
  await app.element('mergeProjects').onclick();
  await settle();
  const posts=app.requests.filter(request=>request.method==='POST');
  assert.equal(posts.length,1);
  assert.equal(posts[0].url,'https://example.test'+prefix+'api/projects/merge');
  assert.equal(posts[0].headers['X-Editor-Token'],'test-token');
  assert.equal(posts[0].headers['Content-Type'],'application/json');
  assert.deepEqual(JSON.parse(posts[0].body),{project_ids:[projectId,secondProjectId],target_id:secondProjectId});
  assert.equal(app.element('projectTitle').textContent,source.name);
  assert.equal(app.element('historyGrid').children.length,2);
  assert.match(app.element('projectMeta').textContent,/2 варианта/,'Merged header count is refreshed from the project jobs');
  assert.equal(app.element('mergePanel').hidden,true);
  assert.ok(app.requests.every(request=>!(request.method==='POST'&&/\/api\/jobs$/.test(request.url))), 'Merging history must never submit generation');

  const rejected=page('history.js','https://example.test'+prefix+'history.html',prefix,new Map(),{accepted:true},{...fixtures,mergeError:'Проект изменился на другом компьютере'});
  await settle();
  for (const card of rejected.element('historyGrid').children) {const checkbox=card.children[0].children[0];checkbox.checked=true;checkbox.onchange();}
  await rejected.element('mergeProjects').onclick();
  await settle();
  assert.match(rejected.element('mergeStatus').textContent,/другом компьютере/);
  assert.equal(rejected.element('mergePanel').hidden,false,'A rejected merge keeps the selection available for review');
  assert.equal(rejected.element('mergeTarget').value,projectId);
  assert.equal(rejected.element('mergeProjects').disabled,false,'A rejected merge unlocks the controls');

  const mergeAuth={accepted:true};
  const expired=page('history.js','https://example.test'+prefix+'history.html',prefix,new Map(),mergeAuth,fixtures);
  await settle();
  for (const card of expired.element('historyGrid').children) {const checkbox=card.children[0].children[0];checkbox.checked=true;checkbox.onchange();}
  mergeAuth.accepted=false;
  await expired.element('mergeProjects').onclick();
  await settle();
  assert.equal(expired.element('authExpiredNotice').hidden,false,'An expired merge session requires login');
  assert.equal(expired.element('mergePanel').hidden,false,'Unauthorized merges keep the selection');
  assert.equal(expired.element('projectHeading').hidden,true,'Unauthorized merges do not open a successful group');
  assert.deepEqual(expired.navigations,[],'Expired merge login must preserve the current page');
}
async function checkHistoryProductLabels(prefix) {
  // Snapshot labels from history keep catalog variants distinct. Old records
  // without saved labels retain descriptor and product_type fallbacks.
  const cases = [
    [{product:{type:'channel_letters',label:'Буквы по сохранённому ТЗ'}}, 'Буквы по сохранённому ТЗ'],
    [{product:{type:'plaque',label:'Табличка с номером кабинета'}}, 'Табличка с номером кабинета'],
    [{product:{type:'neon',label:'Сохранённый контур неона'}}, 'Сохранённый контур неона'],
    [{product_type:'plaque'}, 'Табличка'],
    [{product_type:'neon'}, 'Неоновая вывеска'],
    [{}, 'Объёмные буквы'],
    [{product:{type:'plaque'},product_type:'neon'}, 'Табличка'],
    [{product:{},product_type:'neon'}, 'Неоновая вывеска'],
    [{product:{type:'future-module'},product_type:'plaque'}, 'Табличка'],
    [{product:{type:'future-module'},product_type:'other-module'}, 'Объёмные буквы']
  ];
  const items = cases.map(([fields],index) => ({...job,id:id.slice(0,-3)+String(index).padStart(3,'0'),text:'История '+index,created:1,...fields}));
  const app = page('history.js','https://example.test'+prefix+'history.html',prefix,new Map(),{accepted:true},{historyItems:items.slice(0,8),products:Products});
  await openFirstProject(app);
  const cards = app.element('historyGrid').children;
  assert.equal(cards.length, 8);
  assert.deepEqual(cards.map(card => card.children[1].children[1].textContent),cases.slice(0,8).map(([,label]) => label), 'History labels retain catalog identity with legacy fallback');
  assert.ok(app.requests.every(request => request.method === 'GET'), 'Building cards must not submit a generation');
  const unknown = page('history.js','https://example.test'+prefix+'history.html',prefix,new Map(),{accepted:true},{historyItems:items.slice(8),products:Products});
  await openFirstProject(unknown);
  assert.equal(unknown.element('historyGrid').children.length, 2, 'Unknown product metadata must not abort the history list');
  assert.deepEqual(unknown.element('historyGrid').children.map(card => card.children[1].children[1].textContent),cases.slice(8).map(([,label]) => label));
  const noCatalogue = page('history.js','https://example.test'+prefix+'history.html',prefix,new Map(),{accepted:true},{historyItems:[items[1]]});
  await openFirstProject(noCatalogue);
  assert.equal(noCatalogue.element('historyGrid').children[0].children[1].children[1].textContent,'Табличка с номером кабинета','Saved labels remain available when the catalog is unavailable');
}
async function checkUnsupportedHistory(prefix){
  const unsupported={version:2,products:[{id:'unsupported-product',type:'future_module',module_version:99,renderer_family:'future_renderer',renderer_version:99,catalog_snapshot:{label:'Прежняя конструкция'},params:{text:'Сохранённая графика'}}],active_product_id:'unsupported-product'};
  const archived={...job,editable:false,compatibility_error:'Не поддерживается версия модуля',product:{type:'future_module',label:'Прежняя конструкция'}};
  const app=page('history.js','https://example.test'+prefix+'history.html',prefix,new Map(),{accepted:true},{historyItems:[{...archived,text:'Сохранённая графика'}],project:unsupported,job:archived,products:Products});
  await openFirstProject(app);await app.element('historyGrid').children[0].onclick();await settle();
  assert.equal(app.element('downloadProject').hidden,false,'Unknown modules retain raw JSON downloads');
  assert.equal(app.element('detailImage').hidden,false,'Unknown modules retain their saved image');
  assert.equal(app.element('restoreProject').hidden,true,'Unsupported editing cannot submit a replacement generation');
  assert.match(app.element('detailStatus').textContent,/Редактирование недоступно/);
  assert.ok(app.requests.every(request=>request.method==='GET'));
}
async function checkExpiredSession(prefix, script) {
  const auth = {accepted: true}, storage = new Map();
  const app = page(script, 'https://example.test' + prefix + (script === 'generation.js' ? 'calibrator.html' : 'history.html'), prefix, storage, auth);
  await settle();
  const reconnect = () => script === 'generation.js' ? app.generation.checkConnection() : app.element('refreshHistory').onclick();
  auth.accepted = false;
  await reconnect();
  await settle();
  assert.equal(app.element('authExpiredNotice').hidden, false);
  assert.deepEqual(app.navigations, [], 'Expired login must not discard unsaved photo and dimensions');
  auth.accepted = true;
  await reconnect();
  await settle();
  assert.equal(app.element('authExpiredNotice').hidden, true);
  if (script === 'generation.js') assert.equal(app.element('generate').disabled, false);
}
(async () => {
  for (const prefix of ['/', '/signs/']) {
    await checkGeneration(prefix, '');
    await checkGeneration(prefix, 'calibrator.html');
    await checkHistory(prefix);
    await checkDraftOnlyProject(prefix);
    await checkProjectMerge(prefix);
    await checkHistoryProductLabels(prefix);
    await checkUnsupportedHistory(prefix);
    await checkExpiredSession(prefix, 'generation.js');
    await checkExpiredSession(prefix, 'history.js');
  }
  console.log('Path-prefix browser-script checks passed: root and /signs/, project/variant links and searches, draft-only projects, authenticated explicit merges and rejected-merge recovery, artifacts and catalog fallbacks, pending-job isolation, expired-session recovery. All renderer calls are mocked.');
})().catch(error => { console.error(error); process.exitCode = 1; });
