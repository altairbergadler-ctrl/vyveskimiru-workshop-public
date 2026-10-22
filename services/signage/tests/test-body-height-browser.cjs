'use strict';
// Actual Chromium browser/Canvas and real Python workspace in temporary data.
// The shared fixture rejects every POST /api/jobs and forbids image renderers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {startFixture, ready, flush} = require('./test-project-history-browser.cjs');
let playwright;
try {playwright = require('playwright');} catch {playwright = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');}
const root = path.resolve(__dirname, '..');
const reportDir = path.join(root, 'output', 'qa-body-height-live-20261014');
const copy = value => JSON.parse(JSON.stringify(value));
const close = (actual, expected, label = '') => assert.ok(Math.abs(actual - expected) < 1e-7, `${label}: ${actual} != ${expected}`);
const sha = value => createHash('sha256').update(value || '').digest('hex');
const digest = snapshot => snapshot.objects.map(object => ({id: object.id, type: object.type,
  text: object.text, height_basis: object.height_basis || 'bounds', height_reference: object.height_reference,
  letter_height_cm: object.letter_height_cm, x_cm: object.x_cm, y_cm: object.y_cm,
  reference_metric: object.preview_line_metrics?.height_reference,
  png_sha256: object.artwork ? sha(object.artwork.data_url) : null,
  png_size_px: object.artwork ? [object.artwork.width_px, object.artwork.height_px] : null,
  font_size_cm: snapshot.layouts.find(row => row.id === object.id)?.font_size_cm,
  width_cm: snapshot.layouts.find(row => row.id === object.id)?.width_cm,
  height_cm: snapshot.layouts.find(row => row.id === object.id)?.height_cm}));
async function state(page) {
  return page.evaluate(() => {
    const settings = SignageLetterUI.settings();
    return {objects: settings.objects, layouts: settings.objects.map(object => LetterGeometry.independentObjectLayout(object))};
  });
}
async function main() {
  fs.mkdirSync(reportDir, {recursive: true});
  const fixture = await startFixture();
  const browserChannel = process.env.TEST_BROWSER_CHANNEL || 'msedge';
  const browser = await playwright.chromium.launch({channel: browserChannel, headless: true});
  const errors = [], result = {browser: browserChannel === 'chrome' ? 'Google Chrome' : 'Microsoft Edge', browser_channel: browserChannel, browser_version: browser.version(), steps: [], viewports: [], errors};
  const contextA = await browser.newContext({viewport: {width: 1440, height: 1000}});
  const contextB = await browser.newContext({viewport: {width: 1440, height: 1000}});
  const page = await contextA.newPage();
  page.on('pageerror', error => errors.push(error.message));
  try {
    const editorURL = fixture.address + '/signs/calibrator.html';
    await page.goto(editorURL + '?newProject=1'); await ready(page);
    await page.click('#demo'); await page.waitForFunction(() => SignageEditor.snapshot().report?.placement);
    // Replace only this local teaching fixture with the owner's exact word pair.
    // Separate explicit modes and an original PNG provide untouched neighbours.
    await page.evaluate(async () => {
      const snapshot = SignageEditor.draftSnapshot(), params = {...snapshot.project.sign};
      const text = (id, value, height, x, y, extra = {}) => ({id, type: 'text', text: value,
        font_family: 'Arial', font_bold: true, letter_height_cm: height, line_gap_cm: 0,
        text_align: 'left', front_color: '#fff3dc', side_color: '#292f30', depth_cm: 5,
        brief: 'Локальная проверка размера', x_cm: x, y_cm: y, rotation_deg: 0, ...extra});
      const logo = document.createElement('canvas'); logo.width = 80; logo.height = 40;
      const ctx = logo.getContext('2d'); ctx.fillStyle = '#e5b95e'; ctx.beginPath();
      ctx.arc(30, 20, 14, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#31594e'; ctx.fillRect(50, 7, 18, 26);
      params.composition_mode = 'independent_signs_v1';
      params.objects = [text('detailing', 'ДЕТЕЙЛИНГ', 50, 225, 260),
        text('coffee', 'КОФЕ', 50, 725, 273.19444444444446),
        text('explicit-bounds', 'АКСЕССУАРЫ', 15, 490, 365, {height_basis: 'bounds'}),
        text('existing-body', 'СЕРВИС', 15, 225, 365, {height_basis: 'body', height_reference: 'auto'}),
        {id: 'original-logo', type: 'logo', width_cm: 30, x_cm: 965, y_cm: 355, rotation_deg: 0,
          artwork: {name: 'local-original.png', mime_type: 'image/png', source: 'uploaded',
            width_px: 80, height_px: 40, data_url: logo.toDataURL('image/png')}}];
      params.text = params.objects.filter(object => object.type === 'text').map(object => object.text).join('\n');
      snapshot.project.sign = params;
      snapshot.project.products[0].params = JSON.parse(JSON.stringify(params));
      snapshot.project.products[0].placement = null; snapshot.project.placement = null;
      snapshot.project.calibration = {mode: 'frontoparallel', frontoparallel_assumed: true, length_cm: 100,
        image_points: [[150, 500], [250, 500]]};
      snapshot.project.target_polygon_px = [[150, 235], [1050, 235], [1050, 425], [150, 425]];
      snapshot.project.generation = {engine: 'codex', lighting: 'original',
        edit_polygon_px: snapshot.project.target_polygon_px, geometry_lock: true};
      snapshot.photo = SignageEditor.photoPng(); snapshot.ui = {};
      snapshot.letterUi = {selectedId: 'detailing', pendingPlacementIds: []};
      await SignageEditor.restoreDraft(snapshot); SignageInterface.setStep('3');
    });
    await page.waitForFunction(() => !SignageLetterUI.validationError());
    await page.evaluate(async () => {await SignageLetterUI.prepareArtwork(); SignageEditor.render();});
    const before = await state(page); result.before = digest(before);
    assert.ok(before.objects.slice(0, 2).every(object => object.height_basis === undefined));
    const beforePair = before.layouts.slice(0, 2);
    assert.ok(Math.abs(beforePair[0].font_size_cm - beforePair[1].font_size_cm) > 20);
    close(beforePair[0].height_cm, 50); close(beforePair[1].height_cm, 50);
    close(beforePair[0].font_size_cm, 50 / 1.08); close(beforePair[1].font_size_cm, 50 / .74);
    assert.equal(await page.locator('#letterUseBodyHeight').isVisible(), true);
    await page.screenshot({path: path.join(reportDir, 'editor-before-desktop.png'), fullPage: true});
    result.steps.push('Real Arial Bold gives different font scales for the two old full-bounds objects');

    await page.click('#letterUseBodyHeight');
    const after = await state(page); result.after = digest(after);
    for (let index = 0; index < 2; index++) {
      const old = before.objects[index], object = after.objects[index], layout = after.layouts[index];
      assert.equal(object.height_basis, 'body'); assert.equal(object.height_reference, 'auto');
      assert.equal(object.letter_height_cm, 50); assert.equal(object.artwork, undefined);
      assert.equal(object.preview_line_metrics.height_reference.text, 'Н');
      for (const key of ['id', 'text', 'font_family', 'font_bold', 'letter_height_cm', 'x_cm', 'y_cm',
                         'rotation_deg', 'line_gap_cm', 'text_align', 'front_color', 'side_color', 'depth_cm', 'brief'])
        assert.deepEqual(object[key], old[key], `Migration retains ${key} for ${object.id}`);
      close(layout.font_size_cm, 50 / .72); close(layout.body_height_cm, 50);
    }
    close(after.layouts[0].font_size_cm, after.layouts[1].font_size_cm);
    close(after.layouts[0].height_cm, 75); close(after.layouts[1].height_cm, 74 / 72 * 50);
    assert.deepEqual(after.objects.slice(2), before.objects.slice(2), 'Other text modes and original logo stay unchanged');
    assert.equal(await page.locator('#letterUseBodyHeight').isVisible(), false);
    await page.evaluate(() => document.getElementById('letterUseBodyHeight').click());
    assert.deepEqual(await state(page), after, 'Repeating migration is inert');
    result.steps.push('One explicit migration keeps 50cm, placement and neighbours; both words share body scale and retain all outliers');

    await page.evaluate(async () => {await SignageLetterUI.prepareArtwork(); SignageEditor.render();});
    const prepared = await state(page); result.prepared = digest(prepared);
    assert.ok(prepared.objects.slice(0, 2).every(object => object.artwork?.source === 'text'));
    assert.deepEqual(prepared.objects.slice(2), before.objects.slice(2));
    // Uniformly changing physical scale can produce identical normalized PNG
    // pixels; its new saved signature must still bind it to the body contract.
    for (let index = 0; index < 2; index++) assert.notEqual(prepared.objects[index].artwork_signature, before.objects[index].artwork_signature);
    assert.match(await page.locator('#letterObjectSize').textContent(), /Основная высота: 50 см/);
    await flush(page);
    const projectId = await page.evaluate(() => SignageWorkspace.context().id);
    assert.ok(projectId); result.project_id = projectId;
    const config = await (await fetch(fixture.address + '/signs/api/config')).json();
    const savedResponse = await fetch(fixture.address + '/signs/api/projects/' + encodeURIComponent(projectId),
      {headers: {'X-Editor-Token': config.token}});
    assert.equal(savedResponse.ok, true);
    const saved = await savedResponse.json();
    assert.deepEqual(saved.snapshot.project.products[0].params.objects, prepared.objects);
    result.server_revision = saved.revision;
    await page.screenshot({path: path.join(reportDir, 'editor-after-desktop.png'), fullPage: true});
    // Also export the complete actual technical overlay without starting AI.
    const source = await page.evaluate(async () => {
      const value = SignageEditor.snapshot(), canvas = document.createElement('canvas');
      canvas.width = value.project.image.width_px; canvas.height = value.project.image.height_px;
      const ctx = canvas.getContext('2d'), image = new Image();
      const photo = SignageEditor.photoPng(); await new Promise((resolve, reject) => {image.onload = resolve; image.onerror = reject; image.src = photo;});
      ctx.drawImage(image, 0, 0);
      const svg = new Image(), href = URL.createObjectURL(new Blob([LetterGeometry.overlaySvg(value.project, value.report)], {type: 'image/svg+xml'}));
      try {await new Promise((resolve, reject) => {svg.onload = resolve; svg.onerror = reject; svg.src = href;}); ctx.drawImage(svg, 0, 0);}
      finally {URL.revokeObjectURL(href);}
      return canvas.toDataURL('image/png');
    });
    fs.writeFileSync(path.join(reportDir, 'technical-source-pair.png'), Buffer.from(source.split(',')[1], 'base64'));
    result.steps.push('Body flags, real reference metrics and newly prepared PNGs persist in the actual Python project workspace');

    page.once('dialog', dialog => dialog.accept()); await page.reload(); await ready(page);
    assert.deepEqual((await state(page)).objects, prepared.objects, 'Reload preserves flags, metrics and exact prepared PNG bytes');
    const other = await contextB.newPage(); other.on('pageerror', error => errors.push(error.message));
    await other.goto(editorURL + '?restoreProject=' + encodeURIComponent(projectId)); await ready(other);
    assert.equal(await other.evaluate(() => SignageWorkspace.context().id), projectId);
    const restored = await state(other); result.restored = digest(restored);
    assert.deepEqual(restored.objects, prepared.objects, 'An isolated PC/context restores the same body-size inputs and PNGs');
    close(restored.layouts[0].font_size_cm, restored.layouts[1].font_size_cm);
    await other.evaluate(() => SignageInterface.setStep('3'));
    result.steps.push('Reload and another isolated browser context restore the same project by its server ID');
    for (const width of [390, 320]) {
      await other.setViewportSize({width, height: width === 390 ? 844 : 736});
      const viewport = await other.evaluate(() => ({width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        bodyMode: document.getElementById('letterObjectHeightBasis').value, label: document.getElementById('letterObjectHeightLabel').textContent}));
      assert.ok(viewport.scrollWidth <= width, JSON.stringify(viewport)); assert.equal(viewport.bodyMode, 'body');
      await other.screenshot({path: path.join(reportDir, `editor-after-${width}.png`), fullPage: true});
      result.viewports.push(viewport);
    }
    const fixtureState = await (await fetch(fixture.address + '/__qa/state')).json();
    result.imagegenPosts = fixtureState.requests.filter(request => request.method === 'POST' && request.path === '/signs/api/jobs').length;
    result.render_calls = fixtureState.render_calls; result.requests = fixtureState.requests;
    assert.equal(result.imagegenPosts, 0); assert.equal(result.render_calls, 0);
    assert.deepEqual(fixtureState.files, {}, 'No generated job files were created'); assert.deepEqual(errors, []);
    result.passed = true;
    console.log(`PASS: real ${result.browser} Arial Bold owner word pair, explicit all-legacy migration and optical/outlier bounds, unaffected neighbours, inert repeat, real Python workspace save/reload/isolated restore, exact PNGs, 390/320px layout, zero AI requests.`);
  } finally {
    fs.writeFileSync(path.join(reportDir, 'browser-result.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(reportDir, `browser-result-${browserChannel}.json`), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(reportDir, 'python-server.log'), fixture.stderr());
    await browser.close(); fixture.stop();
  }
}
if (require.main === module) main().catch(error => {console.error(error); process.exitCode = 1;});
