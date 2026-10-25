'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the actual editor and ruler scripts. The tiny DOM supplies rendering
// primitives; mouse events and all measurements use the shipped application.
const assets = path.join(__dirname, '../assets');
const html = fs.readFileSync(path.join(assets, 'calibrator.html'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
const textNodes = root => [root.textContent, ...root.children.flatMap(textNodes)].filter(value => value !== undefined).map(String);
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.value = ''; this.checked = false;
    this.hidden = false; this.disabled = false; this.style = {}; this.attrs = {}; this.handlers = new Map();
    this.clientWidth = 600; this.clientHeight = 400; this.validity = {badInput: false}; this.isContentEditable = false;
    this.classes = new Set(); this.classList = {toggle: (name, state) => state ? this.classes.add(name) : this.classes.delete(name), contains: name => this.classes.has(name)};
  }
  append(...items) { this.children.push(...items); }
  appendChild(item) { this.children.push(item); return item; }
  replaceChildren(...items) { this.children = items; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  querySelector(selector) {
    // The fake SVG parser omits composition polygons. Match any explicitly
    // supplied frame without pretending to render SVG in this ruler harness.
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
  addEventListener(type, listener) { const list = this.handlers.get(type) || []; list.push(listener); this.handlers.set(type, list); }
  dispatchEvent(event) { event.target ||= this; for (const listener of this.handlers.get(event.type) || []) listener(event); this['on' + event.type]?.(event); return !event.defaultPrevented; }
  getBoundingClientRect() { return {left: 100, top: 50, width: 600, height: 400, right: 700, bottom: 450}; }
  closest(selector) { return /input|textarea|select/.test(selector) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(this.tagName) ? this : null; }
  focus() {}
  setPointerCapture(id) {this.captured=id;}
  hasPointerCapture(id) {return this.captured===id;}
  releasePointerCapture(id) {if(this.captured===id)this.captured=null;}
  click() { return this.onclick?.({target: this, preventDefault() {}}); }
  getContext() { return {measureText: text => ({width: text.length * 50, actualBoundingBoxAscent: 70, actualBoundingBoxDescent: 0, actualBoundingBoxLeft: 0, actualBoundingBoxRight: text.length * 50}), drawImage() {}}; }
}
function makePage() {
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
  const element = id => { assert.ok(elements.has(id), `Missing HTML element: ${id}`); return elements.get(id); };
  element('stage').parentElement = element('imageViewport');
  const document = new Element(); document.body = new Element('body'); document.activeElement = document.body; document.documentElement={dataset:{}};
  document.getElementById = element; document.createElement = tag => new Element(tag);
  document.createElementNS = (_, tag) => new Element(tag); document.importNode = node => node;
  const window = new Element(); window.innerHeight = 1000;
  const context = {window, document, console, URL, URLSearchParams, Blob, setTimeout, clearTimeout,
    Event: class {constructor(type) {this.type = type;}},
    getComputedStyle: () => ({paddingLeft: '0', paddingRight: '0'}),
    ResizeObserver: class {observe() {}},
    DOMParser: class {parseFromString() {return {documentElement: {childNodes: []}};}},
    Image: class {constructor() {this.naturalWidth = 1200; this.naturalHeight = 800;} set src(_) {queueMicrotask(() => this.onload());}},
    FileReader: class {readAsDataURL(file) {this.result = file.data; queueMicrotask(() => this.onload());}}
  };
  vm.createContext(context);
  for (const script of ['facade-projection.js', 'geometry.js', 'ruler.js', 'viewport.js', 'facade-ui.js', 'calibrator.js']) {
    vm.runInContext(fs.readFileSync(path.join(assets, script), 'utf8'), context, {filename: script});
    if (script === 'geometry.js') window.LetterGeometry = context.LetterGeometry;
    if (script === 'facade-ui.js') window.SignageFacadeUI = context.SignageFacadeUI;
  }
  const event = (target, type, extra = {}) => {const evt = {type, target, button: 0, defaultPrevented: false, preventDefault() {this.defaultPrevented = true;}, stopImmediatePropagation() {}, ...extra}; target.dispatchEvent(evt); return evt;};
  const photoEvent = (type, [x, y], extra = {}) => event(element('stage'), type, {clientX: 100 + x / 2, clientY: 50 + y / 2, ...extra});
  return {element, context, window, document, event, photoEvent, editor: window.SignageEditor};
}
const fixture = {
  version: 1, image: {name: 'ruler-fixture.png', width_px: 1200, height_px: 800},
  calibration: {mode: 'frontoparallel', frontoparallel_assumed: true, image_points: [[100, 100], [500, 100]], length_cm: 200},
  placement: null, sign: {text: 'ЦВЕТЫ', front_color: '#ffffff', side_color: '#000000'}, measurements: [], checks: []
};
async function main() {
  // A fitted portrait used to shrink a calibration handle to about 3 CSS px.
  // Check visible handle size, pending progress, and completed points in the real editor.
  const referenceApp = makePage();
  await referenceApp.editor.restoreProject(clone(fixture), 'data:image/png;base64,reference');
  const marks = kind => referenceApp.element('overlay').children.filter(node => node.getAttribute('data-handle') === kind);
  assert.equal(marks('reference').length, 2);
  near(Number(marks('reference')[0].getAttribute('r')) * .5, 6);
  referenceApp.element('reference').click();
  referenceApp.photoEvent('click', [700, 200]);
  assert.match(referenceApp.element('referenceState').textContent, /1 из 2/);
  assert.equal(marks('pending').length, 1);
  near(Number(marks('pending')[0].getAttribute('r')) * .5, 6);
  const originalBounds = referenceApp.element('image').getBoundingClientRect;
  referenceApp.element('image').getBoundingClientRect = () => ({left:100,top:50,width:120,height:80,right:220,bottom:130});
  referenceApp.editor.render();
  near(Number(marks('pending')[0].getAttribute('r')) * .1, 6, 'Fitted handle must stay visible');
  near(Number(marks('reference')[0].getAttribute('r')) * .1, 6);
  referenceApp.element('image').getBoundingClientRect = originalBounds;
  referenceApp.photoEvent('click', [900, 200]);
  assert.deepEqual(clone(referenceApp.editor.snapshot().project.calibration.image_points), [[700,200],[900,200]]);
  assert.equal(marks('pending').length, 0);
  assert.equal(marks('reference').length, 2);
  assert.match(referenceApp.element('referenceState').textContent, /Сохранено точек: 2/);
  const app = makePage();
  await app.editor.restoreProject(clone(fixture), 'data:image/png;base64,fixture');
  assert.equal(app.editor.snapshot().hasPhoto, true);
  const overlay = new Element('svg'), points = [[100, 100], [300, 100], [300, 500]];
  const calibration = app.window.LetterGeometry.calibrate(fixture.calibration);
  const drawOptions = {image: fixture.image, points, hover: [500, 500], calibration, samePlane: true, active: true, width: 600, height: 400};
  const measurement = app.window.SignageRuler.draw(overlay, drawOptions).measurement;
  near(measurement.total_cm, 300);
  assert.ok(textNodes(overlay).some(text => text.includes('100 см')), 'The first segment must have an on-photo size');
  assert.ok(textNodes(overlay).some(text => text.includes('200 см')), 'The second segment must have an on-photo size');
  assert.ok(textNodes(overlay).some(text => text.includes('Итого:') && text.includes('300 см')), 'The chain total must be visible');
  assert.ok(textNodes(overlay).some(text => text.startsWith('+ ') && text.includes('100 см')), 'Hover shows the next segment without saving it');
  assert.equal(drawOptions.points.length, 3);
  const unconfirmed = app.window.SignageRuler.draw(overlay, {...drawOptions, samePlane: false});
  assert.equal(unconfirmed.measurement, null);
  assert.ok(!textNodes(overlay).some(text => /\d[\d ,]* см/.test(text)), 'An unconfirmed plane must not present real-world lengths');
  const uncalibrated = app.window.SignageRuler.draw(overlay, {...drawOptions, calibration: null});
  assert.equal(uncalibrated.measurement, null);
  assert.ok(uncalibrated.error);
  assert.throws(() => app.window.SignageRuler.validate([[1201, 0]], fixture.image));
  assert.throws(() => app.window.SignageRuler.validate([[NaN, 0]], fixture.image));
  assert.throws(() => app.window.SignageRuler.validate(Array.from({length: 257}, () => [0, 0]), fixture.image));
  // Clicking three times continues the same chain and stores original pixels,
  // even though the photo on screen has half the original dimensions.
  const snapshot = () => clone(app.editor.snapshot());
  const rulerPoints = () => snapshot().project.ruler.image_points;
  const rulerLabels = () => textNodes(app.element('rulerOverlay'));
  app.element('measure').click();
  points.forEach(point => app.photoEvent('click', point));
  assert.deepEqual(rulerPoints(), points);
  assert.equal(app.element('measure').getAttribute('aria-pressed'), 'true');
  assert.equal(snapshot().project.placement, null, 'Ruler needs no sign placement');
  near(snapshot().report.ruler.total_cm, 300);
  assert.ok(app.element('rulerReadout').textContent.includes('300 см'));
  app.photoEvent('mousemove', [500, 500]);
  assert.deepEqual(rulerPoints(), points, 'Mouse move must not add points');
  assert.ok(rulerLabels().some(text => text.startsWith('+ ') && text.includes('100 см')));
  app.photoEvent('mouseleave', [500, 500]);
  assert.ok(!rulerLabels().some(text => text.startsWith('+ ')));
  app.photoEvent('click', [800, 700], {button: 2});
  app.photoEvent('click', [1300, 500]);
  assert.deepEqual(rulerPoints(), points, 'Right click and clicks outside photo must not add points');

  const miss = app.photoEvent('contextmenu', [900, 700], {button: 2});
  assert.equal(miss.defaultPrevented, true);
  assert.deepEqual(rulerPoints(), points, 'Empty-area right click must not remove an arbitrary point');
  const hit = app.photoEvent('contextmenu', [328, 100], {button: 2});
  assert.equal(hit.defaultPrevented, true);
  assert.deepEqual(rulerPoints(), [points[0], points[2]], 'Right click within 14 CSS px removes the closest vertex');
  near(snapshot().report.ruler.total_cm, Math.hypot(100, 200));
  app.photoEvent('contextmenu', [336, 500], {button: 2});
  assert.equal(rulerPoints().length, 2, 'Right click 18 CSS px from a point must miss');

  const key = (key, target = app.document.body, extra = {}) => app.event(app.document, 'keydown', {key, target, ...extra});
  assert.equal(key('Backspace', app.element('text')).defaultPrevented, false);
  assert.equal(key('Delete', app.element('referenceLength')).defaultPrevented, false);
  assert.equal(key('Escape', app.element('font')).defaultPrevented, false);
  assert.equal(key('Delete', app.document.body, {ctrlKey: true}).defaultPrevented, false);
  assert.equal(rulerPoints().length, 2, 'Editing text/numbers or modifier shortcuts must not remove vertices');
  assert.equal(key('Escape').defaultPrevented, true);
  assert.equal(app.element('measure').getAttribute('aria-pressed'), 'false');
  assert.equal(rulerPoints().length, 2, 'Escape keeps the ruler');
  assert.equal(app.photoEvent('contextmenu', points[0], {button: 2}).defaultPrevented, false, 'Other modes retain native context menu');
  app.photoEvent('click', [900, 700]);
  assert.equal(rulerPoints().length, 2);
  app.element('reference').click();
  app.photoEvent('click', [700, 200]);
  app.element('measure').click();
  assert.equal(rulerPoints().length, 2, 'Changing modes preserves ruler vertices');
  assert.equal(key('Backspace').defaultPrevented, true);
  assert.equal(rulerPoints().length, 1);
  app.photoEvent('click', [300, 500]);
  app.element('undo').click();
  assert.equal(rulerPoints().length, 1, 'Undo removes the last ruler point while ruler is active');
  app.photoEvent('click', [300, 500]);

  // The ruler remains useful while a separate sign dimension is invalid.
  app.element('place').click();
  app.photoEvent('click', [600, 300]);
  app.element('signWidth').value = '0';
  app.event(app.element('signWidth'), 'input');
  assert.equal(snapshot().report, null);
  assert.ok(rulerLabels().some(text => text.includes('Итого:') && text.includes('223,6 см')), 'Invalid sign size must not hide valid calibrated ruler dimensions');
  app.element('signWidth').value = '220';
  app.event(app.element('signWidth'), 'input');

  app.element('rulerSamePlane').checked = false;
  app.event(app.element('rulerSamePlane'), 'change');
  assert.equal(snapshot().report.ruler.total_cm, null);
  assert.ok(!rulerLabels().some(text => /\d[\d ,]* см/.test(text)));
  app.element('rulerSamePlane').checked = true;
  app.event(app.element('rulerSamePlane'), 'change');
  app.element('referenceLength').value = '0';
  app.event(app.element('referenceLength'), 'input');
  assert.ok(!rulerLabels().some(text => /\d[\d ,]* см/.test(text)), 'Invalid calibration must not leave stale numeric labels');
  app.element('referenceLength').value = '400';
  app.event(app.element('referenceLength'), 'input');
  assert.ok(rulerLabels().some(text => text.includes('Итого:') && text.includes('447,2 см')), 'Changing the reference size immediately recalculates the ruler');

  const saved = snapshot().project;
  app.element('clearRuler').click();
  assert.deepEqual(rulerPoints(), []);
  assert.equal(app.element('clearRuler').hidden, true);
  await app.editor.restoreProject(JSON.parse(JSON.stringify(saved)), 'data:image/png;base64,fixture');
  assert.deepEqual(rulerPoints(), saved.ruler.image_points, 'JSON/history restore must bring the same ruler back');
  assert.ok(rulerLabels().some(text => text.includes('447,2 см')));
  await app.editor.restoreProject({...clone(fixture), ruler: {image_points: points, same_plane: false}}, 'data:image/png;base64,fixture');
  assert.equal(app.element('rulerSamePlane').checked, false);
  assert.deepEqual(rulerPoints(), points);
  const beforeInvalidImport = snapshot().project;
  await assert.rejects(app.editor.restoreProject({...clone(fixture), ruler: {image_points: [[1201, 0]], same_plane: true}}, 'data:image/png;base64,fixture'));
  assert.deepEqual(snapshot().project, beforeInvalidImport, 'Malformed import must preserve the current project');
  await app.editor.restoreProject(clone(fixture), 'data:image/png;base64,fixture');
  assert.deepEqual(rulerPoints(), [], 'Old project without a ruler remains compatible');

  app.element('measure').click();
  app.photoEvent('click', [100, 100]);
  app.photoEvent('click', [300, 100]);
  app.event(app.element('photo'), 'change', {target: {files: [{name: 'new-photo.png', data: 'data:image/png;base64,new'}]}});
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(rulerPoints(), [], 'A new photo must clear the ruler along with the old calibration');
  assert.equal(snapshot().project.image.name, 'new-photo.png');
  // The shipped zone UI opts in only on an explicit choice/new contour.
  // Derived zone centimetres never become editable calibration inputs.
  const facadeApp=makePage(),rectangle={...clone(fixture),calibration:{mode:'rectangle',width_cm:200,height_cm:100,image_points:[[100,100],[500,100],[500,300],[100,300]]},target_polygon_px:[[100,100],[500,100],[500,300],[100,300]]};
  await facadeApp.editor.restoreProject(rectangle,'data:image/png;base64,facade');
  assert.equal(facadeApp.editor.snapshot().project.facade,undefined,'Legacy zone stays unchanged until opted in');
  assert.equal(facadeApp.element('facadeEnabled').checked,false);
  assert.equal(facadeApp.element('facadeZoneWidth').tagName,'OUTPUT');
  facadeApp.element('target').click();
  const zone=[[100,100],[900,100],[900,500],[100,500]];zone.forEach(p=>facadeApp.photoEvent('click',p));
  assert.equal(facadeApp.editor.snapshot().project.facade.enabled,true,'New zone enables perspective');
  assert.equal(facadeApp.element('facadeZoneWidth').value,'400 см');
  assert.equal(facadeApp.element('facadeZoneHeight').value,'200 см');
  assert.ok(facadeApp.element('overlay').children.some(n=>n.getAttribute('data-facade-overlay')==='true'),'Grid uses the effective facade plane');
  const prior=clone(facadeApp.editor.snapshot().project.calibration);
  facadeApp.element('facadeLens').checked=true;facadeApp.event(facadeApp.element('facadeLens'),'change');
  facadeApp.element('facadeEdges').click();const edgePoints=[[500,100],[900,300],[500,500],[100,300]];edgePoints.forEach(p=>facadeApp.photoEvent('click',p));
  assert.deepEqual(clone(facadeApp.editor.snapshot().project.facade.edge_points),edgePoints);
  assert.deepEqual(clone(facadeApp.editor.snapshot().project.calibration),prior,'Zone tools preserve the prior measured reference');
  facadeApp.element('facadeSnapGrid').checked=true;facadeApp.event(facadeApp.element('facadeSnapGrid'),'change');
  facadeApp.element('facadeGridStep').value='25';facadeApp.event(facadeApp.element('facadeGridStep'),'change');
  const facadeDraft=clone(facadeApp.editor.draftSnapshot()),restoredFacade=makePage();await restoredFacade.editor.restoreDraft(facadeDraft);
  assert.deepEqual(clone(restoredFacade.editor.snapshot().project.facade),facadeDraft.project.facade,'Draft restores lens points and view/snap preferences');
  restoredFacade.element('calibrationMode').onchange();
  assert.equal(restoredFacade.element('facadeZoneWidth').value,'—','Missing reference clears derived readouts');
  assert.equal(restoredFacade.element('facadeZoneHeight').value,'—');
  // Execute the actual whole-product drag branch (also used by plaques and
  // neon), including grid attraction, Alt bypass, boundary stop and resizing.
  const whole=makePage(),wholeProject={...clone(rectangle),target_polygon_px:zone,placement:{center_px:[440,262],width_cm:80,height_cm:20,rotation_deg:0},facade:{version:1,enabled:true}};
  await whole.editor.restoreProject(wholeProject,'data:image/png;base64,whole');
  assert.equal(whole.editor.snapshot().project.facade.snap_grid,true);
  const viewport=whole.element('imageViewport'),pointerAt=(type,[x,y],extra={})=>whole.event(viewport,type,{clientX:100+x/2,clientY:50+y/2,pointerId:7,buttons:type==='pointerup'?0:1,...extra});
  const centerPhoto=()=>clone(whole.editor.snapshot().project.placement.center_px),widthBefore=whole.editor.snapshot().project.placement.width_cm;
  let dragChanges=0,viewChanges=0;
  whole.document.addEventListener('signage:change',()=>dragChanges++);
  whole.document.addEventListener('signage:viewchange',()=>viewChanges++);
  pointerAt('pointerdown',centerPhoto());pointerAt('pointermove',[524,262]);
  assert.equal(dragChanges,0,'Pointer movement updates the preview without serializing a full autosave');
  near(centerPhoto()[0],520,'The geometry must be current before release');
  pointerAt('pointerup',[524,262]);
  assert.equal(dragChanges,1,'Release commits the final geometry exactly once');
  assert.equal(viewChanges,0,'Object movement must not reconfigure the photo viewport');
  near(centerPhoto()[0],520);near(whole.editor.snapshot().report.placement.center_cm[0],210);
  assert.equal(whole.editor.snapshot().project.placement.width_cm,widthBefore,'Whole-product attraction preserves physical width');
  pointerAt('pointerdown',centerPhoto());pointerAt('pointermove',[524,262],{altKey:true});pointerAt('pointerup',[524,262],{altKey:true});near(centerPhoto()[0],524);
  pointerAt('pointerdown',centerPhoto());pointerAt('pointermove',[880,262]);pointerAt('pointerup',[880,262]);assert.ok(Math.abs(whole.editor.snapshot().report.placement.center_cm[0]-360)<1e-4);
  assert.ok(whole.editor.snapshot().report.placement.corners_cm.every(p=>GInsideWhole(p)),'The complete physical product stops at the facade boundary');
  function GInsideWhole(p){return whole.window.LetterGeometry.inside(p,whole.editor.snapshot().report.calibration.target_world_cm);}
  whole.element('signWidth').value='60';whole.event(whole.element('signWidth'),'input');whole.element('rotation').value='12';whole.event(whole.element('rotation'),'input');
  const resized=whole.editor.snapshot();assert.equal(resized.project.placement.width_cm,60);assert.equal(resized.project.placement.rotation_deg,12);assert.ok(resized.report.placement.boundary_px.length>4);
  for(let i=0;i<4;i++){const back=whole.window.LetterGeometry.apply(resized.report.calibration.imageToWorld,resized.report.placement.polygon_px[i]);near(back[0],resized.report.placement.corners_cm[i][0]);near(back[1],resized.report.placement.corners_cm[i][1]);}
  for(const finish of ['pointercancel','lostpointercapture','blur','pagehide','visibilitychange']){
    const before=dragChanges,start=centerPhoto();
    pointerAt('pointerdown',start);pointerAt('pointermove',[start[0]-4,start[1]-4],{altKey:true});
    const moved=centerPhoto();assert.notDeepEqual(moved,start);
    assert.equal(dragChanges,before,finish+' must not save intermediate pointer movement');
    const end=()=>{
      if(finish==='visibilitychange'){whole.document.hidden=true;whole.event(whole.document,finish);}
      else if(['blur','pagehide'].includes(finish))whole.event(whole.window,finish);
      else pointerAt(finish,moved);
    };
    end();end();whole.document.hidden=false;
    assert.equal(dragChanges,before+1,finish+' commits exactly once, even when repeated');
    assert.deepEqual(centerPhoto(),moved,finish+' preserves the final preview coordinates');
  }
  console.log('PASS: shipped ruler UI — continuous points, scaled coordinates, hover/segment/total labels, nearest right-click removal, keyboard typing guards, mode persistence, independent calibration, clear/new photo, JSON restore and legacy compatibility.');
  console.log('PASS: shipped facade UI — explicit legacy opt-in, new-zone defaults, informational dimensions, lens points, prior calibration preservation, draft restore and no stale size fallback.');
  console.log('PASS: shipped whole-product drag — facade grid, exact Alt bypass, physical bounds, resize/rotation, inverse projection and one final commit on release/cancel/blur/page exit.');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
