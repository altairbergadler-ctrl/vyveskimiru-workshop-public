'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Draft = require('../assets/draft.js');
const copy = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};

// IndexedDB requests succeed before the transaction commits. The implementation
// must wait for the latter, including a quota/abort error after request success.
function fakeIDB() {
  const records = new Map(), transactions = [];
  const database = {objectStoreNames: {contains: () => true}, close() {}, transaction(name, mode) {
    const tx = {objectStore() {return {
      get(key) {const request = {}; queueMicrotask(() => {request.result = copy(records.get(key) || null); request.onsuccess?.();}); return request;},
      put(value, key) {tx.pending = [key, copy(value)]; const request = {}; queueMicrotask(() => request.onsuccess?.()); return request;}
    };}};
    tx.commit = () => {if (tx.pending) records.set(...tx.pending); tx.oncomplete?.();};
    tx.abort = () => {tx.error = new Error('quota'); tx.onabort?.();};
    transactions.push(tx); return tx;
  }};
  return {records, transactions, open() {const request = {}; queueMicrotask(() => {request.result = database; request.onsuccess?.();}); return request;}};
}
class Events {
  constructor() {this.listeners = new Map();}
  addEventListener(type, callback) {const callbacks = this.listeners.get(type) || []; callbacks.push(callback); this.listeners.set(type, callbacks);}
  emit(type, extra = {}) {const event = {type, isTrusted: true, defaultPrevented: false, preventDefault() {this.defaultPrevented = true;}, ...extra}; for (const callback of this.listeners.get(type) || []) callback(event); return event;}
}
const snapshot = (text = 'ЦВЕТЫ', photoKey = 'photo-1') => ({
  project: {image: {name: 'photo.png', width_px: 1200, height_px: 800}, sign: {text}},
  photo: photoKey ? `data:image/png;base64,${photoKey}` : '', photoKey,
  ui: {text: {value: text}}, view: {scale: 1, x: -100, y: -20}, interaction: {action: 'measure', pending: []}
});
function page({record = null, read, write, current = snapshot('', null), search = '', storage = new Map(), generationReady = Promise.resolve()} = {}) {
  const document = new Events(), window = new Events(), writes = [], generationRestores = [];
  window.location = {search};
  window.localStorage = {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)};
  let state = copy(current);
  const editor = {snapshot: () => ({hasPhoto: Boolean(state.photo)}), draftSnapshot: () => copy(state),
    async restoreDraft(value, {shouldApply}) {await tick(); if (!shouldApply()) return false; state = copy(value); return true;}};
  const generation = {ready: generationReady, draftState: () => ({jobId: 'saved-job-00000001', view: 'source'}),
    async restoreDraft(value, {shouldApply}) {if (shouldApply()) generationRestores.push(value);}};
  const status = {textContent: '', classList: {toggle() {}}};
  const store = {read: read || (async () => copy(record)), write: write || (async (_key, value) => {writes.push(copy(value));})};
  const controller = Draft.createController({store, editor, generation, status, document, window, key: '/signs/', delay: 10000});
  return {controller, document, window, status, storage, writes, generationRestores, get: () => copy(state), set: value => {state = copy(value);}};
}
const record = value => ({version: 1, saved_at: '2026-10-09T00:00:00.000Z', snapshot: value, generation: {jobId: 'saved-job-00000001', view: 'base'}});
async function testStore() {
  const idb = fakeIDB(), store = Draft.openStore(idb);
  let finished = false;
  const write = store.write('/signs/', record(snapshot())).then(() => {finished = true;});
  await tick(); assert.equal(finished, false, 'Request success is not transaction success');
  idb.transactions.at(-1).commit(); await write; assert.equal(finished, true);
  const read = store.read('/signs/'); await tick(); idb.transactions.at(-1).commit();
  assert.equal((await read).snapshot.photoKey, 'photo-1');
  const failed = store.write('/signs/', record(snapshot('quota failure'))); await tick(); idb.transactions.at(-1).abort();
  await assert.rejects(failed, /quota/);
  assert.equal(idb.records.get('/signs/').snapshot.project.sign.text, 'ЦВЕТЫ');
  await assert.rejects(Draft.openStore(undefined).read('/signs/'), /хранилище/);
}
async function testRestoreAndQuickReload() {
  const app = page({record: record(snapshot('Old text'))});
  await app.controller.start();
  assert.equal(app.get().project.sign.text, 'Old text');
  assert.equal(app.generationRestores.length, 1);
  assert.equal(app.writes.length, 0, 'Opening a draft must not overwrite it with an empty startup state');
  app.set(snapshot('Last keystroke'));
  app.document.emit('input');
  const journal = JSON.parse(app.storage.get('signage-draft-journal:/signs/'));
  assert.equal(journal.snapshot.project.sign.text, 'Last keystroke');
  assert.equal(Object.hasOwn(journal.snapshot, 'photo'), false, 'localStorage never contains the photo');
  const reloaded = page({record: record(snapshot('Old text')), storage: app.storage});
  await reloaded.controller.start();
  assert.equal(reloaded.get().project.sign.text, 'Last keystroke', 'A fast reload restores metadata even before the debounce write');
  assert.equal(reloaded.get().photo, snapshot().photo, 'The journal is combined with exactly the matching photo');
  assert.equal(app.window.emit('beforeunload').defaultPrevented, false, 'A valid tiny journal protects text without a reload warning');
  await app.controller.flush();
  const wrongJournal = new Map(app.storage);
  const bad = copy(journal); bad.snapshot.photoKey = 'another-photo'; wrongJournal.set('signage-draft-journal:/signs/', JSON.stringify(bad));
  const mismatch = page({record: record(snapshot('Old photo state')), storage: wrongJournal});
  await mismatch.controller.start();
  assert.equal(mismatch.get().project.sign.text, 'Old photo state');
  assert.match(mismatch.status.textContent, /предыдущий/);
}
async function testRacesAndFailures() {
  const server = deferred(), slowServer = page({record: record(snapshot('Saved photo')), generationReady: server.promise});
  const slowStartup = slowServer.controller.start();
  await tick(); await tick();
  assert.equal(slowServer.get().project.sign.text, 'Saved photo');
  slowServer.set(snapshot('Typing while result loads')); slowServer.document.emit('input');
  assert.equal(JSON.parse(slowServer.storage.get('signage-draft-journal:/signs/')).snapshot.project.sign.text, 'Typing while result loads');
  server.resolve(); await slowStartup; await slowServer.controller.flush();
  assert.equal(slowServer.generationRestores.length, 0, 'New edits cancel an old delayed result restore');
  const loading = deferred(), app = page({read: () => loading.promise});
  const startup = app.controller.start();
  app.document.emit('pointerdown'); app.set(snapshot('New user photo', 'new-photo')); app.document.emit('signage:change');
  loading.resolve(record(snapshot('Old draft'))); await startup; await app.controller.flush();
  assert.equal(app.get().project.sign.text, 'New user photo', 'User import wins over a late IDB read');
  assert.equal(app.generationRestores.length, 0);
  const explicit = page({record: record(snapshot()), search: '?restoreJob=history-0000000001'});
  await explicit.controller.start(); assert.equal(explicit.get().photo, ''); assert.equal(explicit.generationRestores.length, 0);
  const pendingWrite = deferred(), saved = [];
  const ordered = page({write: async (_key, value) => {saved.push(copy(value)); if (saved.length === 1) await pendingWrite.promise;}});
  await ordered.controller.start();
  ordered.set(snapshot('A')); ordered.document.emit('signage:change'); await tick();
  assert.equal(ordered.window.emit('beforeunload').defaultPrevented, true, 'An uncommitted new photo warns before leaving');
  ordered.set(snapshot('B')); ordered.document.emit('input');
  pendingWrite.resolve(); await ordered.controller.flush();
  assert.deepEqual(saved.map(value => value.snapshot.project.sign.text), ['A', 'B']);
  assert.equal(ordered.window.emit('beforeunload').defaultPrevented, false);
  const failed = page({write: async () => {throw new Error('quota');}});
  await failed.controller.start(); failed.set(snapshot()); failed.document.emit('signage:change'); await failed.controller.flush();
  assert.match(failed.status.textContent, /не сохранён/);
  assert.equal(failed.window.emit('beforeunload').defaultPrevented, true);
}
async function testActualEditorRestore() {
  // Reuse the maintained DOM harness, running the actual shipped editor scripts.
  const source = fs.readFileSync(path.join(__dirname, 'test-viewport.cjs'), 'utf8');
  const harness = new Function('require', '__dirname', source.slice(0, source.indexOf('async function testEditor()')) + '\nreturn {makeEditor, fire};')(require, __dirname);
  const app = harness.makeEditor();
  const project = {version: 1, image: {name: 'source.png', width_px: 1200, height_px: 800},
    calibration: {mode: 'frontoparallel', frontoparallel_assumed: true, length_cm: 200, image_points: [[100,100],[500,100]]},
    placement: null, sign: {text: 'ЦВЕТЫ'}, measurements: [], checks: []};
  await app.editor.restoreProject(project, 'data:image/png;base64,fixture');
  app.element('zoomActual').click(); app.element('measure').click(); app.pointEvent('click', [600,400]);
  app.element('referenceLength').value = '0'; harness.fire(app.element('referenceLength'), 'input');
  const saved = copy(app.editor.draftSnapshot());
  assert.equal(app.editor.snapshot().report, null, 'Unfinished invalid calibration must still be saved');
  const restored = harness.makeEditor();
  assert.equal(await restored.editor.restoreDraft(saved), true);
  assert.equal(restored.element('referenceLength').value, '0');
  assert.equal(restored.editor.snapshot().report, null);
  assert.deepEqual(copy(restored.editor.snapshot().project.ruler.image_points), [[600,400]]);
  assert.equal(restored.element('zoomLevel').textContent, '100%');
  assert.equal(restored.element('measure').getAttribute('aria-pressed'), 'true');
  const before = copy(restored.editor.draftSnapshot());
  assert.equal(await restored.editor.restoreDraft(saved, {shouldApply: () => false}), false);
  assert.deepEqual(copy(restored.editor.draftSnapshot()), before);
}
(async () => {
  await testStore(); await testRestoreAndQuickReload(); await testRacesAndFailures(); await testActualEditorRestore();
  console.log('PASS: drafts — IDB commit/abort, atomic photo/project, fast reload journal, latest-write queue, user/history priority, visible failures, unfinished calibration and view restore.');
})().catch(error => {console.error(error); process.exitCode = 1;});
