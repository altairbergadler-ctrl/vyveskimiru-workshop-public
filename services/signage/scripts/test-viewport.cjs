'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assets = path.join(__dirname, '../assets');
const clone = value => JSON.parse(JSON.stringify(value));
const near = (actual, expected, message = '') => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-6, `${message} ${actual} != ${expected}`);
const samePoint = (actual, expected, message) => {assert.ok(actual && expected, message); near(actual[0], expected[0], message); near(actual[1], expected[1], message);};
const V = require(path.join(assets, 'viewport.js'));

function testModel() {
  const image = Object.freeze({name: 'viewport-fixture.png', width_px: 1200, height_px: 800});
  const model = V.createModel();
  model.configure(image, 600, 400, {reset: true});
  let state = model.snapshot();
  near(state.fitScale, .45, 'Fit leaves 20 CSS pixels of breathing space on each side');
  near(state.scale, .45); near(state.x, 30); near(state.y, 20);
  samePoint(model.imagePoint(165, 110), [300, 200], 'CSS positions must map to original pixels');
  assert.equal(model.imagePoint(15, 100), null, 'Visible margin is not part of the photograph');
  assert.equal(model.imagePoint(-1, 100), null, 'Outside photo cannot become a calibration point');
  assert.equal(model.imagePoint(601, 100), null);

  const anchor = model.imagePoint(165, 110);
  model.zoomAt(1, 165, 110);
  samePoint(model.imagePoint(165, 110), anchor, 'Wheel zoom must keep the pixel below the cursor in place');
  near(model.snapshot().scale, 1);
  near(model.snapshot().x, -135); near(model.snapshot().y, -90);
  const beforePan = model.snapshot();
  model.panBy(-40, -30);
  near(model.snapshot().x, beforePan.x - 40); near(model.snapshot().y, beforePan.y - 30);
  samePoint(model.imagePoint(165, 110), [340, 230], 'Pan moves the view without changing original pixels');
  const beforeZoom = model.imagePoint(300, 200);
  model.zoomBy(1.5, 300, 200);
  samePoint(model.imagePoint(300, 200), beforeZoom);

  // Editor renders after every change. Reconfiguring an unchanged image must
  // not silently fit it again and undo the user's magnification or pan.
  const remembered = clone(model.snapshot());
  model.configure(image, 600, 400);
  near(model.snapshot().scale, remembered.scale);
  near(model.snapshot().x, remembered.x); near(model.snapshot().y, remembered.y);
  const oldCentre = model.imagePoint(300, 200);
  model.configure(image, 700, 450);
  samePoint(model.imagePoint(350, 225), oldCentre, 'Resize keeps the viewed image centre');

  model.zoomAt(1e12, 350, 225);
  state = model.snapshot(); near(state.scale, state.maxScale);
  model.zoomAt(1e-12, 350, 225);
  state = model.snapshot(); near(state.scale, state.minScale);
  model.panBy(1e8, 1e8);
  state = model.snapshot();
  assert.ok(state.x < state.width && state.y < state.height, 'Panning cannot lose the whole image beyond the positive edge');
  model.panBy(-2e8, -2e8);
  state = model.snapshot();
  assert.ok(state.x + image.width_px * state.scale > 0 && state.y + image.height_px * state.scale > 0, 'Panning cannot lose the whole image beyond the negative edge');

  model.fit(); state = model.snapshot();
  near(state.scale, state.fitScale);
  near(state.x, (state.width - image.width_px * state.scale) / 2);
  near(state.y, (state.height - image.height_px * state.scale) / 2);
  model.zoomBy(2, 350, 225);
  model.configure(image, 700, 450, {reset: true});
  near(model.snapshot().scale, model.snapshot().fitScale, 'New/restored photo explicitly resets the view');
  const finiteState = clone(model.snapshot());
  model.zoomAt(NaN); model.panBy(Infinity, 1); model.zoomBy(-2); model.configure(image, 0, 0);
  assert.deepEqual(clone(model.snapshot()), finiteState, 'Invalid input or a temporarily collapsed viewport must not corrupt the camera');
  const detached = model.snapshot(); detached.image.width_px = 1;
  assert.equal(model.snapshot().image.width_px, 1200, 'Reading view state must not expose mutable image metadata');
  model.configure({width_px: 1000, height_px: 2000}, 600, 400);
  near(model.snapshot().scale, .18, 'Changing to a portrait photo resets fit even if reset was omitted');
  samePoint(model.imagePoint(300, 200), [500, 1000]);
  model.configure(null, 600, 400);
  assert.equal(model.imagePoint(300, 200), null, 'An empty view has no measurable image coordinates');
  assert.deepEqual(image, {name: 'viewport-fixture.png', width_px: 1200, height_px: 800}, 'View operations must not modify project image metadata');
}

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.value = ''; this.checked = false;
    this.hidden = false; this.disabled = false; this.style = {}; this.attrs = {}; this.handlers = new Map();
    this.clientWidth = 600; this.clientHeight = 400; this.validity = {badInput: false}; this.isContentEditable = false;
    this.classes = new Set(); this.classList = {toggle: (name, state) => state ? this.classes.add(name) : this.classes.delete(name), contains: name => this.classes.has(name), add: name => this.classes.add(name), remove: name => this.classes.delete(name)};
    this.captured = new Set();
  }
  get clientWidth() {return parseFloat(this.style.width) || this._clientWidth;}
  set clientWidth(value) {this._clientWidth = value;}
  get clientHeight() {return parseFloat(this.style.height) || this._clientHeight;}
  set clientHeight(value) {this._clientHeight = value;}
  append(...items) { this.children.push(...items); }
  appendChild(item) { this.children.push(item); return item; }
  replaceChildren(...items) { this.children = items; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  querySelector(selector) {
    // SVG drawing is stubbed here; only explicitly supplied frame nodes exist.
    assert.equal(selector, 'polygon[fill="#ffb454"]');
    const find = root => {
      for (const child of root.children) {
        if (child.tagName === 'POLYGON' && child.getAttribute('fill') === '#ffb454') return child;
        const nested = find(child); if (nested) return nested;
      }
      return null;
    };
    return find(this);
  }
  removeAttribute(name) { delete this.attrs[name]; }
  addEventListener(type, listener, options) { const list = this.handlers.get(type) || []; list.push({listener, options}); this.handlers.set(type, list); }
  removeEventListener(type, listener) { this.handlers.set(type, (this.handlers.get(type) || []).filter(item => item.listener !== listener)); }
  dispatchEvent(event) { event.target ||= this; for (const {listener} of this.handlers.get(event.type) || []) listener(event); this['on' + event.type]?.(event); return !event.defaultPrevented; }
  getBoundingClientRect() { return {left: 100, top: 50, width: this.clientWidth, height: this.clientHeight, right: 100 + this.clientWidth, bottom: 50 + this.clientHeight}; }
  setPointerCapture(id) { this.captured.add(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
  closest(selector) { return /input|textarea|select/.test(selector) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(this.tagName) ? this : null; }
  focus() {}
  click() { return fire(this, 'click'); }
  getContext() { return {measureText: text => ({width: text.length * 50, actualBoundingBoxAscent: 70, actualBoundingBoxDescent: 0, actualBoundingBoxLeft: 0, actualBoundingBoxRight: text.length * 50}), drawImage() {}}; }
}
function fire(target, type, extra = {}) {
  const event = {type, target, button: 0, pointerId: 1, clientX: 400, clientY: 250, defaultPrevented: false,
    preventDefault() {this.defaultPrevented = true;}, stopPropagation() {this.propagationStopped = true;}, ...extra};
  target.dispatchEvent(event); return event;
}

function testController() {
  const viewport = new Element(), stage = new Element();
  const ownerDocument = new Element(), ownerWindow = new Element();
  ownerDocument.defaultView = ownerWindow; ownerDocument.visibilityState = 'visible'; viewport.ownerDocument = ownerDocument;
  const controls = Object.fromEntries(['zoomIn', 'zoomOut', 'zoomFit', 'zoomActual', 'zoomLevel'].map(key => [key, new Element('button')]));
  let changeCount = 0;
  const controller = V.mount({viewport, stage, controls, onChange() {changeCount++;}});
  controller.configure(null);
  assert.equal(controls.zoomIn.disabled, true);
  assert.equal(controls.zoomActual.disabled, true);
  assert.equal(fire(viewport, 'wheel', {deltaY: -100, deltaMode: 0}).defaultPrevented, false, 'An empty editor must not consume ordinary page scrolling');
  controller.configure({width_px: 1200, height_px: 800}, {reset: true});
  controls.zoomActual.click();
  near(controller.snapshot().scale, 1, '100% button means one screen pixel per source pixel');
  const originalState = clone(controller.snapshot());
  const local = [200, 150];
  const anchor = [(local[0] - originalState.x) / originalState.scale, (local[1] - originalState.y) / originalState.scale];
  const wheel = fire(viewport, 'wheel', {clientX: 100 + local[0], clientY: 50 + local[1], deltaY: -100, deltaMode: 0});
  assert.equal(wheel.defaultPrevented, true, 'Magnifying the photo must not scroll the whole page');
  assert.ok(controller.snapshot().scale > 1, 'Wheel up magnifies');
  let state = controller.snapshot();
  samePoint([(local[0] - state.x) / state.scale, (local[1] - state.y) / state.scale], anchor, 'Wheel converts client coordinates to viewport-local coordinates');
  assert.ok(viewport.handlers.get('wheel').some(item => item.options?.passive === false), 'Wheel listener must allow preventDefault');
  assert.match(controls.zoomLevel.textContent, /%/, 'Current scale is visible');
  near(parseFloat(stage.style.width), 1200 * state.scale);
  near(parseFloat(stage.style.height), 800 * state.scale);
  near(parseFloat(stage.style.left), state.x); near(parseFloat(stage.style.top), state.y);

  const beforeLeft = clone(state);
  fire(viewport, 'pointerdown', {button: 0});
  fire(viewport, 'pointermove', {clientX: 440, clientY: 280});
  fire(viewport, 'pointerup', {button: 0, clientX: 440, clientY: 280});
  near(controller.snapshot().x, beforeLeft.x); near(controller.snapshot().y, beforeLeft.y);
  assert.equal(controller.isPanning(), false, 'Left button remains available for calibration and ruler points');
  const down = fire(viewport, 'pointerdown', {button: 1});
  assert.equal(down.defaultPrevented, true, 'Middle drag suppresses browser autoscroll');
  assert.equal(controller.isPanning(), true);
  fire(viewport, 'pointermove', {button: 1, clientX: 440, clientY: 280});
  near(controller.snapshot().x, beforeLeft.x + 40); near(controller.snapshot().y, beforeLeft.y + 30);
  fire(viewport, 'pointerup', {button: 1, clientX: 440, clientY: 280});
  assert.equal(controller.isPanning(), false);
  fire(viewport, 'pointerdown', {button: 1});
  fire(viewport, 'pointercancel', {button: 1});
  assert.equal(controller.isPanning(), false, 'Cancelled pointer cannot leave the editor stuck in pan mode');
  fire(viewport, 'pointerdown', {button: 1});
  fire(viewport, 'lostpointercapture');
  assert.equal(controller.isPanning(), false, 'Losing pointer capture releases drag state');
  // Reproduce a missing pointerup: navigation must recover before the next
  // calibration click, rather than waiting for a later pointermove.
  const startStalePan = () => {
    fire(viewport, 'pointerdown', {button: 1, buttons: 4, pointerId: 7});
    assert.equal(controller.isPanning(), true);
    assert.equal(viewport.hasPointerCapture(7), true);
  };
  const assertPanReleased = () => {
    assert.equal(controller.isPanning(), false);
    assert.equal(viewport.hasPointerCapture(7), false, 'Cancellation releases native pointer capture as well');
    assert.equal(viewport.classList.contains('is-panning'), false);
  };
  startStalePan(); fire(ownerWindow, 'blur'); assertPanReleased();
  startStalePan(); ownerDocument.visibilityState = 'hidden'; fire(ownerDocument, 'visibilitychange'); assertPanReleased();
  ownerDocument.visibilityState = 'visible';
  startStalePan();
  const firstLeft = fire(viewport, 'pointerdown', {button: 0, buttons: 1, pointerId: 7});
  assertPanReleased(); assert.equal(firstLeft.defaultPrevented, false, 'Recovered primary click must remain available to the editor');
  startStalePan(); fire(ownerDocument, 'pointerdown', {button: 0, buttons: 1}); assertPanReleased();
  startStalePan(); controller.cancelPan(); assertPanReleased();
  controller.cancelPan(); assertPanReleased();
  startStalePan(); fire(viewport, 'pointerdown', {button: 0, buttons: 5});
  assert.equal(controller.isPanning(), true, 'Pressing left while middle is still held is not a stale pan');
  controller.cancelPan();
  const beforeButtons = controller.snapshot().scale;
  controls.zoomIn.click(); assert.ok(controller.snapshot().scale > beforeButtons);
  controls.zoomOut.click(); near(controller.snapshot().scale, beforeButtons);
  controls.zoomFit.click(); near(controller.snapshot().scale, controller.snapshot().fitScale);
  assert.ok(changeCount >= 6, 'Viewport changes redraw overlays');
}

function makeEditor() {
  const html = fs.readFileSync(path.join(assets, 'calibrator.html'), 'utf8');
  const elements = new Map();
  for (const match of html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = new Element(match[1]); element.id = match[3];
    element.value = match[2].match(/\bvalue="([^"]*)"/)?.[1] || '';
    element.checked = /\bchecked\b/.test(match[2]); element.hidden = /\bhidden\b/.test(match[2]);
    elements.set(element.id, element);
  }
  for (const match of html.matchAll(/<select\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const options = [...match[2].matchAll(/<option\b([^>]*)>/g)];
    elements.get(match[1]).value = (options.find(option => /\bselected\b/.test(option[1])) || options[0])[1].match(/\bvalue="([^"]*)"/)[1];
  }
  for (const match of html.matchAll(/<textarea\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) elements.get(match[1]).value = match[2];
  const element = id => {assert.ok(elements.has(id), `Missing HTML element: ${id}`); return elements.get(id);};
  const viewport = element('imageViewport'), stage = element('stage'), image = element('image');
  stage.parentElement = viewport;
  stage.getBoundingClientRect = () => {
    const root = viewport.getBoundingClientRect(), left = root.left + (parseFloat(stage.style.left) || 0), top = root.top + (parseFloat(stage.style.top) || 0);
    return {left, top, width: stage.clientWidth, height: stage.clientHeight, right: left + stage.clientWidth, bottom: top + stage.clientHeight};
  };
  image.getBoundingClientRect = () => stage.getBoundingClientRect();
  const document = new Element(); document.body = new Element('body'); document.activeElement = document.body; document.documentElement={dataset:{}};
  document.getElementById = element; document.createElement = tag => new Element(tag);
  document.createElementNS = (_, tag) => new Element(tag); document.importNode = node => node;
  const window = new Element(); window.innerHeight = 1000;
  const context = {window, document, console, URL, URLSearchParams, Blob, setTimeout, clearTimeout,
    Event: class {constructor(type) {this.type = type;}}, getComputedStyle: () => ({paddingLeft: '0', paddingRight: '0'}),
    ResizeObserver: class {observe() {}}, DOMParser: class {parseFromString() {return {documentElement: {childNodes: []}};}},
    Image: class {constructor() {this.naturalWidth = 1200; this.naturalHeight = 800;} set src(_) {queueMicrotask(() => this.onload());}},
    FileReader: class {readAsDataURL(file) {this.result = file.data; queueMicrotask(() => this.onload());}}
  };
  vm.createContext(context);
  for (const script of ['facade-projection.js', 'geometry.js', 'ruler.js', 'viewport.js', 'facade-ui.js', 'calibrator.js']) {
    vm.runInContext(fs.readFileSync(path.join(assets, script), 'utf8'), context, {filename: script});
    if (script === 'geometry.js') window.LetterGeometry = context.LetterGeometry;
    if (script === 'facade-ui.js') window.SignageFacadeUI = context.SignageFacadeUI;
  }
  const pointEvent = (type, point, extra = {}) => {const box = image.getBoundingClientRect(); return fire(stage, type, {clientX: box.left + point[0] * box.width / 1200, clientY: box.top + point[1] * box.height / 800, ...extra});};
  return {element, window, editor: window.SignageEditor, pointEvent, viewport, stage};
}

async function testEditor() {
  const app = makeEditor();
  const fixture = {
    version: 1, image: {name: 'viewport-fixture.png', width_px: 1200, height_px: 800},
    calibration: {mode: 'frontoparallel', frontoparallel_assumed: true, image_points: [[100, 100], [500, 100]], length_cm: 200},
    placement: {center_px: [600, 400], width_cm: 220, height_cm: 45, rotation_deg: 0},
    sign: {text: 'ЦВЕТЫ', front_color: '#ffffff', side_color: '#000000'},
    ruler: {image_points: [[450, 350], [750, 350]], same_plane: true}, measurements: [], checks: []
  };
  await app.editor.restoreProject(clone(fixture), 'data:image/png;base64,fixture');
  const saved = clone(app.editor.snapshot().project);
  near(app.editor.snapshot().report.ruler.total_cm, 150);
  app.element('measure').click();
  app.element('zoomActual').click();
  fire(app.viewport, 'wheel', {deltaY: -100, deltaMode: 0});
  fire(app.viewport, 'pointerdown', {button: 1});
  app.pointEvent('click', [600, 400]);
  assert.equal(app.editor.snapshot().project.ruler.image_points.length, 2, 'An accidental click during middle drag must not add a ruler point');
  fire(app.viewport, 'pointermove', {button: 1, clientX: 360, clientY: 220});
  fire(app.viewport, 'pointerup', {button: 1, clientX: 360, clientY: 220});
  app.pointEvent('click', [600, 400], {button: 1});
  assert.deepEqual(clone(app.editor.snapshot().project), saved, 'Zoom/pan are viewing state and never rewrite calibration, placement, ruler or exported project');
  near(app.editor.snapshot().report.ruler.total_cm, 150, 'View zoom must not alter centimetres');
  const magnifiedWidth = app.stage.clientWidth;
  app.pointEvent('click', [600, 450]);
  samePoint(app.editor.snapshot().project.ruler.image_points[2], [600, 450], 'After zoom/pan a click still stores exact source coordinates');
  near(app.stage.clientWidth, magnifiedWidth, 'Adding points and rerendering must retain magnification');
  app.pointEvent('contextmenu', [600, 450], {button: 2});
  assert.equal(app.editor.snapshot().project.ruler.image_points.length, 2, 'Right-click removal works in the magnified view');
  near(app.stage.clientWidth, magnifiedWidth);
  app.element('zoomFit').click();
  assert.ok(app.stage.clientWidth <= app.viewport.clientWidth && app.stage.clientHeight <= app.viewport.clientHeight, 'Fit restores the whole photo');
  assert.deepEqual(clone(app.editor.snapshot().project), saved);
}

async function main() {
  testModel(); testController(); await testEditor();
  console.log('PASS: viewport — fit/100%, cursor anchor, bounded zoom/pan, resize/reset; real editor source coordinates, ruler dimensions and saved project remain unchanged by navigation.');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
