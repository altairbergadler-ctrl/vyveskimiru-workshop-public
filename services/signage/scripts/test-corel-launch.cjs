'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const id = 'a'.repeat(64), token = 'b'.repeat(43), key = 'signage-corel-launch:/signs/';
const savedTicket = () => ({id, status_token: token, launch_url: 'signage-corel://open/' + id, status: 'pending'});
const settle = async () => {for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));};
function page({prefix = '/signs/', storage = new Map(), states = ['pending'], accepted = true, createGate,
               createOverride, failStatus = false, statusCode = 200, project = {}, letterOverrides = false} = {}) {
  const elements = new Map(), requests = [], protocol = [], timers = new Map(), downloads = [], events = new Map();
  let timerId = 0;
  const controls = {accepted, failStatus, statusCode};
  class Element {
    constructor(name) {this.name = name; this.value = ''; this.textContent = ''; this.checked = false; this.hidden = true; this.disabled = false;}
    addEventListener(name, fn) {events.set(this.name + ':' + name, fn);}
    removeAttribute(name) {delete this[name];}
    click() {if (this.onclick?.() !== false && this.name === 'corelOpenAgain') protocol.push(this.href);}
  }
  const element = name => {if (!elements.has(name)) elements.set(name, new Element(name)); return elements.get(name);};
  for (const [name, value] of Object.entries({text: 'ЦВЕТЫ\nИ ПОДАРКИ', signWidth: '220', signHeight: '60', lineGap: '5', textAlign: 'center', font: 'Arial', frontColor: '#ffffff'})) element(name).value = value;
  element('corelBold').checked = true;
  const location = new URL('https://example.test' + prefix + 'calibrator.html');
  const document = {getElementById: element, addEventListener: (name, fn) => events.set(name, fn)};
  const fetch = async (input, options = {}) => {
    const url = new URL(input, location.href), method = options.method || 'GET';
    requests.push({path: url.pathname, method, headers: options.headers, body: options.body});
    assert.equal(url.origin, location.origin);
    assert.ok(url.pathname.startsWith(prefix + 'api/'), 'Every request must stay under the app directory');
    assert.ok(!url.pathname.includes('/api/jobs'), 'Corel must never generate an AI image');
    const response = (value, code = 200) => ({status: code, ok: code >= 200 && code < 300, json: async () => value, blob: async () => 'zip-fixture'});
    if (!controls.accepted) return response({error: 'Требуется вход'}, 401);
    const route = url.pathname.slice(prefix.length);
    if (route === 'api/config') return response({token: 'editor-token'});
    assert.equal(options.headers['X-Editor-Token'], 'editor-token');
    if (route === 'api/corel-launch') {
      assert.equal(method, 'POST');
      if (createGate) await createGate;
      return response(createOverride || {...savedTicket(), expires_in: 300}, 201);
    }
    if (route === 'api/corel-package') return response({});
    assert.equal(route, 'api/corel-launch/' + id);
    assert.equal(method, 'GET');
    assert.equal(options.headers['X-Corel-Status-Token'], token);
    assert.equal(url.search, '', 'Status token must never appear in URLs');
    if (controls.failStatus) throw new Error('Временно нет сети');
    if (controls.statusCode !== 200) return response({error: 'Нет запроса'}, controls.statusCode);
    const state = states.length > 1 ? states.shift() : states[0];
    return response({id, status: state, filename: 'face-letters-test.cdr', message: state === 'failed' ? 'Шрифт не установлен' : undefined});
  };
  const window = {location, SignageEditor: {download: (...args) => downloads.push(args), snapshot: () => ({project})},
    SignageLetterUI: {hasOverrides: () => letterOverrides}};
  const context = {window, document, URL, fetch, console,
    sessionStorage: {getItem: k => storage.get(k) || null, setItem: (k, value) => storage.set(k, value), removeItem: k => storage.delete(k)},
    setTimeout: fn => {const i = ++timerId; timers.set(i, fn); return i;}, clearTimeout: i => timers.delete(i)};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/corel-export.js'), 'utf8'), context, {filename: 'corel-export.js'});
  return {element, requests, protocol, timers, downloads, storage, controls, corel: window.SignageCorel, location,
    update: () => events.get('signage:change')?.(),
    tick: async () => {const [number, callback] = timers.entries().next().value || []; if (callback) {timers.delete(number); callback(); await settle();}}};
}
async function main() {
  for (const prefix of ['/', '/signs/']) {
    const app = page({prefix, states: ['pending', 'claimed', 'complete']});
    assert.equal(app.requests.length, 0, 'Opening the editor alone must not create or launch anything');
    await app.element('launchCorel').onclick();
    assert.equal(app.protocol.length, 1);
    assert.equal(app.protocol[0], savedTicket().launch_url);
    assert.equal(app.location.pathname, prefix + 'calibrator.html', 'Native protocol must not navigate away from the editor');
    const post = app.requests.find(request => request.method === 'POST');
    const spec = JSON.parse(post.body);
    assert.equal(spec.front_color, '#000000', 'CDR defaults to black regardless of the photo face color');
    assert.equal(spec.text, 'ЦВЕТЫ\nИ ПОДАРКИ');
    assert.equal(app.element('launchCorel').disabled, true);
    await app.element('launchCorel').onclick();
    assert.equal(app.requests.filter(request => request.method === 'POST').length, 1, 'Repeated create clicks cannot duplicate a pending request');
    app.element('corelOpenAgain').click();
    assert.equal(app.protocol.length, 2);
    assert.equal(app.requests.filter(request => request.method === 'POST').length, 1, 'Explicit retry must reopen the same ticket');
    await app.tick();
    assert.equal(app.element('corelOpenAgain').hidden, true, 'A claimed ticket must not be relaunchable');
    assert.match(app.element('corelStatus').textContent, /создаёт CDR/);
    await app.tick();
    assert.match(app.element('corelStatus').textContent, /face-letters-test.cdr/);
    assert.equal(app.element('launchCorel').disabled, false);
    assert.equal(app.storage.size, 0);
    assert.equal(app.timers.size, 0);
    await app.element('exportCorel').onclick();
    assert.equal(app.downloads.length, 1);
    assert.match(app.element('corelPackageStatus').textContent, /ZIP скачан/);
    app.corel.restore({font_bold: false});
    assert.equal(app.corel.settings().font_bold, false, 'Existing draft bold setting is preserved');
    assert.deepEqual(Object.keys(app.corel.settings()), ['font_bold'], 'Launch secrets must never enter project/draft settings');
  }

  let release;
  const delayed = page({createGate: new Promise(resolve => {release = resolve;})});
  const creating = delayed.element('launchCorel').onclick(); await settle();
  await delayed.element('launchCorel').onclick();
  assert.equal(delayed.requests.filter(request => request.method === 'POST').length, 1, 'Fast double-click while POST waits creates only one request');
  release(); await creating;

  const storage = new Map([[key, JSON.stringify(savedTicket())], ['signage-corel-launch:/other/', JSON.stringify(savedTicket())]]);
  const restored = page({storage}); await settle();
  assert.equal(restored.protocol.length, 0, 'Reload must never activate the native protocol');
  assert.ok(restored.requests.every(request => request.method === 'GET'), 'Reload must only read status');
  assert.equal(restored.element('launchCorel').disabled, true);
  assert.equal(restored.element('corelOpenAgain').hidden, false);
  restored.element('corelOpenAgain').click();
  assert.equal(restored.protocol.length, 1, 'Only an explicit reload fallback click may launch the helper');
  const other = page({storage: new Map([['signage-corel-launch:/other/', JSON.stringify(savedTicket())]])});
  assert.equal(other.requests.length, 0, 'Another application directory cannot resume this request');

  for (const terminal of ['failed', 'expired']) {
    const app = page({states: [terminal]}); await app.element('launchCorel').onclick();
    assert.equal(app.element('launchCorel').disabled, false);
    assert.equal(app.storage.size, 0);
    assert.equal(app.timers.size, 0);
    assert.match(app.element('corelStatus').textContent, terminal === 'failed' ? /Шрифт не установлен/ : /вовремя/);
  }
  const missing = page({storage: new Map([[key, JSON.stringify(savedTicket())]]), statusCode: 404}); await settle();
  assert.equal(missing.storage.size, 0);
  assert.equal(missing.element('launchCorel').disabled, false);

  const unauthorized = page({accepted: false}); await unauthorized.element('launchCorel').onclick();
  assert.equal(unauthorized.element('authExpiredNotice').hidden, false);
  assert.equal(unauthorized.protocol.length, 0);
  assert.equal(unauthorized.element('launchCorel').disabled, false);
  assert.equal(unauthorized.location.pathname, '/signs/calibrator.html');
  const resumed = page({storage: new Map([[key, JSON.stringify(savedTicket())]]), accepted: false}); await settle();
  assert.equal(resumed.element('launchCorel').disabled, true, 'Auth failure must preserve pending ticket to avoid duplicate work');
  assert.equal(resumed.element('corelCheckStatus').hidden, false);
  resumed.controls.accepted = true;
  await resumed.element('corelCheckStatus').onclick();
  assert.equal(resumed.element('authExpiredNotice').hidden, true);
  assert.ok(resumed.requests.every(request => request.method === 'GET'));

  const offline = page({failStatus: true}); await offline.element('launchCorel').onclick();
  assert.equal(offline.element('corelCheckStatus').hidden, false);
  assert.equal(offline.timers.size, 0, 'Failed reads pause polling until explicitly checked again');
  offline.controls.failStatus = false;
  await offline.element('corelCheckStatus').onclick();
  assert.equal(offline.requests.filter(request => request.method === 'POST').length, 1);
  assert.equal(offline.protocol.length, 1, 'Status recovery must not relaunch native code');

  for (const malformed of [{...savedTicket(), launch_url: 'https://evil.test/'}, {...savedTicket(), status_token: 'short'}, {...savedTicket(), id: '../bad'}]) {
    const app = page({createOverride: malformed}); await app.element('launchCorel').onclick();
    assert.equal(app.protocol.length, 0, 'Untrusted server launch URLs must not navigate a frame');
    assert.equal(app.storage.size, 0);
    assert.equal(app.element('launchCorel').disabled, false);
  }
  for (const sign of [{objects: [{id: 'text-1', type: 'text', text: 'КОФЕ'}]}, {objects: []}, {objects: null}, {composition_mode: 'independent_objects_v1'}]) {
    const app = page({project: {sign}});
    assert.equal(app.element('launchCorel').disabled, true, 'Object compositions must not use the legacy Corel helper');
    assert.equal(app.element('exportCorel').disabled, true, 'Object compositions must not send a flattened ZIP specification');
    assert.equal(app.element('corelBold').disabled, true);
    assert.match(app.element('corelSummary').textContent, /независимых текстов и логотипов/);
    assert.match(app.element('corelSummary').textContent, /Схему SVG/);
    await app.element('launchCorel').onclick();
    await app.element('exportCorel').onclick();
    assert.equal(app.requests.length, 0, 'Even direct handler calls must not send a legacy object request');
    assert.equal(app.protocol.length, 0);
    assert.equal(app.downloads.length, 0);
    assert.equal(app.element('exportSvg').disabled, false, 'Corel restrictions must not disable SVG export');
    assert.equal(app.element('exportPng').disabled, false, 'Corel restrictions must not disable PNG export');
  }
  const migrated = page({letterOverrides: true});
  assert.equal(migrated.element('launchCorel').disabled, true, 'New object UI must be blocked before canonical project sync');

  const changingProject = {sign: {objects: []}};
  const changed = page({project: changingProject});
  changingProject.sign = {text: 'Старый проект без объектов'};
  changed.update();
  assert.equal(changed.element('launchCorel').disabled, false, 'A legacy text project must retain Corel functionality');
  assert.equal(changed.element('corelBold').disabled, false);
  await changed.element('exportCorel').onclick();
  assert.equal(changed.downloads.length, 1);

  const previous = page({project: {sign: {objects: []}}, storage: new Map([[key, JSON.stringify(savedTicket())]]), states: ['pending', 'complete']});
  await settle();
  assert.ok(previous.requests.every(request => request.method === 'GET'), 'Object UI may only recover an existing Corel ticket');
  assert.equal(previous.element('corelOpenAgain').hidden, false, 'Existing pending helper requests remain recoverable');
  previous.element('corelOpenAgain').click();
  assert.equal(previous.protocol.length, 1, 'Explicit recovery opens only the existing helper ticket');
  await previous.tick();
  assert.equal(previous.element('launchCorel').disabled, true, 'Completing a previous request must not enable a new flattened composition');
  assert.equal(previous.storage.size, 0);
  assert.equal(previous.requests.filter(request => request.method === 'POST').length, 0);
  assert.match(previous.element('corelStatus').textContent, /face-letters-test.cdr/);
  console.log('PASS: Corel create, ZIP and legacy behavior; independent-object export blocked with explanation; pending recovery preserved; prefix/auth/token handling; no AI calls.');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
