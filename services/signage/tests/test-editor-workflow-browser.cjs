'use strict';
// Real browser, temporary local project store, no generation or production data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {startFixture, ready} = require('./test-project-history-browser.cjs');
let playwright;
try {playwright = require('playwright');} catch {playwright = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');}
const output = process.env.SIGNAGE_QA_OUTPUT || path.resolve(__dirname, '../qa-editor-workflow');

(async () => {
  fs.mkdirSync(output, {recursive: true});
  const fixture = await startFixture();
  const browser = await playwright.chromium.launch({channel: process.env.TEST_BROWSER_CHANNEL || 'msedge', headless: true});
  const page = await browser.newPage({viewport: {width: 1280, height: 900}});
  const errors = [], generations = [], widths = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {if(response.status()>=400 && /\.(js|css)(\?|$)/.test(response.url()))errors.push('Asset '+response.status()+': '+response.url());});
  page.on('request', request => {if (request.method() === 'POST' && new URL(request.url()).pathname === '/signs/api/jobs') generations.push(request.url());});
  if (process.env.SIGNAGE_ASSET_OVERRIDE) await page.route(/\/signs\/[^/]+\.(?:html|css|js)(?:\?.*)?$/, route => {
    const name = path.basename(new URL(route.request().url()).pathname);
    const file = path.join(process.env.SIGNAGE_ASSET_OVERRIDE, name);
    if (!fs.existsSync(file)) return route.continue();
    return route.fulfill({path: file, contentType: name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'});
  });
  const headerStep = step => '#interfaceSteps [data-interface-step-button="' + step + '"]';
  async function assertStep(step) {
    assert.equal(await page.evaluate(() => SignageInterface.step()), String(step));
    const stale = await page.evaluate(current => [...document.querySelectorAll('[data-interface-panel]')]
      .filter(node => !node.dataset.interfacePanel.split(' ').includes(String(current)) && node.getClientRects().length)
      .map(node => node.id), step);
    assert.deepEqual(stale, [], 'Previous step must disappear immediately, without an extra click');
  }
  async function clickStep(step, footer = false) {
    await page.locator(footer ? 'aside .interface-step-footer [data-interface-step-button="' + step + '"]:visible' : headerStep(step)).click();
    await assertStep(step);
  }
  async function zoomWithWheel(deltaY = -400) {
    await page.locator('#imageViewport').scrollIntoViewIfNeeded();
    const box = await page.locator('#imageViewport').boundingBox();
    const before = await page.evaluate(() => SignageEditor.draftSnapshot().view.scale);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, deltaY);
    await page.waitForFunction(previous => SignageEditor.draftSnapshot().view.scale !== previous, before);
  }
  try {
    await page.goto(fixture.address + '/signs/calibrator.html?newProject=1');
    await ready(page);
    for (const width of [1280, 390]) {
      await page.setViewportSize({width, height: 900});
      await clickStep(1);
      for (const step of [2, 3, 4, 3, 2, 1]) await clickStep(step, true);
      await page.locator('#interfacePhotoPanel .interface-step-footer button').focus();
      await page.keyboard.press('Enter');
      await assertStep(2);
      assert.equal(await page.locator(headerStep(2)).evaluate(el => el === document.activeElement), true);
    }
    assert.equal(await page.locator('#frontal').count(), 0, 'No checkbox for the default frontoparallel assumption');
    assert.equal(await page.evaluate(() => SignageEditor.snapshot().project.calibration.frontoparallel_assumed), true);
    await clickStep(1);
    await page.click('#demo');
    await page.waitForFunction(() => SignageEditor.snapshot().report?.placement);
    const original = await page.evaluate(() => SignageEditor.draftSnapshot());
    await page.evaluate(async saved => {
      saved.project.calibration = {mode: 'frontoparallel', image_points: [[200, 200], [600, 200]], length_cm: 200, frontoparallel_assumed: false};
      saved.ui.calibrationMode = {value: 'frontoparallel'};
      saved.ui.referenceLength = {value: '200'};
      saved.ui.frontal = {checked: false};
      await SignageEditor.restoreDraft(saved);
    }, original);
    let calibration = await page.evaluate(() => SignageEditor.snapshot().project.calibration);
    assert.equal(calibration.frontoparallel_assumed, true, 'Old unchecked drafts adopt the enabled UI default');
    assert.deepEqual(calibration.image_points, [[200, 200], [600, 200]]);
    assert.equal(calibration.length_cm, 200);
    await page.evaluate(async () => {await SignageWorkspace.flush(); await SignageDraft.flush();});
    await page.reload(); await ready(page);
    assert.equal(await page.evaluate(() => SignageEditor.snapshot().project.calibration.frontoparallel_assumed), true);
    assert.equal(await page.locator('#frontal').count(), 0);
    await clickStep(1);
    const legacyImport = {version: 1, image: original.project.image, sign: {text: 'Проверка'}, placement: null,
      calibration: {mode: 'frontoparallel', image_points: [[200, 200], [600, 200]], length_cm: 250, frontoparallel_assumed: false}};
    await page.setInputFiles('#import', {name: 'legacy-scale.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacyImport))});
    await page.waitForFunction(() => SignageEditor.snapshot().project.calibration.length_cm === 250);
    assert.equal(await page.evaluate(() => SignageEditor.snapshot().project.calibration.frontoparallel_assumed), true, 'Legacy JSON import enables the assumption before validation');
    await page.evaluate(async saved => SignageEditor.restoreDraft(saved), original);
    assert.deepEqual(await page.evaluate(() => SignageEditor.snapshot().project.calibration), original.project.calibration, 'Rectangle calibration must be unchanged');
    await clickStep(3);
    assert.equal(await page.locator('#overlay #signage-overlay-caption').count(), 0, 'Technical summary belongs below the interactive photo');
    const beforeTools = await page.evaluate(() => SignageEditor.snapshot().project);
    await page.click('#target');
    assert.equal(await page.locator('#target').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await page.evaluate(() => SignageEditor.draftSnapshot().interaction.pending), []);
    await page.click('#target');
    assert.equal(await page.locator('#target').getAttribute('aria-pressed'), 'false');
    assert.deepEqual(await page.evaluate(() => SignageEditor.snapshot().project), beforeTools, 'Toggling a tool must not change coordinates');
    await page.click('#measure');
    assert.equal(await page.locator('#measure').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await page.evaluate(() => SignageEditor.snapshot().project.ruler.image_points), []);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#measure').getAttribute('aria-pressed'), 'false');
    for (const width of [1655, 1280, 768, 390, 320]) {
      await page.setViewportSize({width, height: 900});
      await page.locator('#imageViewport').scrollIntoViewIfNeeded();
      const result = await page.evaluate(() => {
        const viewport = document.getElementById('imageViewport').getBoundingClientRect();
        const tools = ['target', 'measure', 'zoomFit', 'openPhotoImage'].map(id => {
          const button = document.getElementById(id), box = button.getBoundingClientRect();
          return {id, left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height, hit: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button') === button};
        });
        const panels = ['.toolbar', '#facadeControls'].map(selector => ({selector, top: document.querySelector(selector).getBoundingClientRect().top}));
        return {width: innerWidth, content: document.documentElement.scrollWidth, viewport: {left: viewport.left, right: viewport.right, top: viewport.top, bottom: viewport.bottom}, tools, panels};
      });
      assert.ok(result.content <= width, 'Horizontal overflow at ' + width);
      for (const b of result.tools) assert.ok(b.hit && b.width >= 44 && b.height >= 44 && b.left >= result.viewport.left && b.right <= result.viewport.right && b.top >= result.viewport.top && b.bottom <= result.viewport.bottom, JSON.stringify(b));
      for (const panel of result.panels) assert.ok(panel.top >= result.viewport.bottom - 1, panel.selector + ' must be below the canvas');
      widths.push(result);
      if ([1655, 390].includes(width)) await page.locator('.workspace').screenshot({path: path.join(output, 'workspace-' + width + '.png')});
      if (width === 1655) await page.locator('#productSection').screenshot({path: path.join(output, 'product-types.png')});
    }
    await page.setViewportSize({width: 1280, height: 1000});
    assert.equal(await page.locator('.view-controls,#zoomIn,#zoomOut,#zoomActual,#zoomLevel').count(), 0, 'Retired zoom toolbar must be absent');
    assert.equal(await page.locator('#catalogSearch,#catalogCategory,#catalogCount,#productTemplate,#applyProductTemplate,#catalogSelectionNote').count(), 0, 'Only the product-type selector remains');
    assert.equal(await page.locator('#productPicker [data-product-type]').count(), 6);
    for (const id of ['interfaceWorkspaceToggle', 'editRegion', 'useTarget', 'checkConnection', 'twoStageNote', 'geometryLockTitle', 'independentPlacementHint', 'subscriptionSettings', 'subscriptionUsageHint']) {
      assert.equal(await page.locator('#' + id).count(), 0, 'Retired UI must be removed: ' + id);
    }
    await page.click('#measure');
    const beforeViewer = await page.evaluate(() => SignageEditor.draftSnapshot().interaction.pending);
    await page.click('#openPhotoImage');
    assert.equal(await page.locator('.image-dialog').isVisible(), true);
    await page.getByRole('button', {name: 'Закрыть просмотр изображения', exact: true}).click();
    await page.click('#zoomFit');
    assert.deepEqual(await page.evaluate(() => SignageEditor.draftSnapshot().interaction.pending), beforeViewer, 'Viewer and fit icons cannot create measurement points');
    await page.keyboard.press('Escape');
    const bounded = async () => {
      const view = await page.evaluate(() => SignageEditor.draftSnapshot().view);
      for (const [offset, size, extent] of [[view.x, view.width, view.image.width_px*view.scale], [view.y, view.height, view.image.height_px*view.scale]]) {
        if (extent <= size) assert.ok(Math.abs(offset-(size-extent)/2)<.01, 'Small photo must stay centered');
        else assert.ok(offset <= .01 && offset >= size-extent-.01, 'Enlarged photo cannot leave its viewport');
      }
    };
    await zoomWithWheel(-800);
    for (const direction of [-1, 1]) {
      await page.locator('#imageViewport').scrollIntoViewIfNeeded();
      const view = await page.locator('#imageViewport').boundingBox();
      await page.mouse.move(view.x+view.width/2, view.y+view.height/2);
      await page.mouse.down({button: 'middle'});
      await page.mouse.move(view.x+view.width/2+direction*1500, view.y+view.height/2+direction*1200, {steps: 6});
      await page.mouse.up({button: 'middle'});
      await bounded();
    }
    await page.evaluate(async () => {const draft=SignageEditor.draftSnapshot();draft.view.x=99999;draft.view.y=-99999;await SignageEditor.restoreDraft(draft);});
    await bounded();
    await page.click('#zoomFit');
    await page.locator('#imageViewport').scrollIntoViewIfNeeded();
    const image = await page.locator('#image').boundingBox();
    await page.click('#measure');
    for (const [x, y] of [[.3, .4], [.6, .4]]) await page.mouse.click(image.x + image.width * x, image.y + image.height * y);
    assert.equal(await page.evaluate(() => SignageEditor.snapshot().project.ruler.image_points.length), 2);
    await zoomWithWheel();
    assert.equal(await page.evaluate(() => SignageEditor.snapshot().project.ruler.image_points.length), 2, 'Zoom controls cannot insert ruler points');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#measure').getAttribute('aria-pressed'), 'false');
    await page.click('#zoomFit');
    await page.locator('#imageViewport').scrollIntoViewIfNeeded();
    const targetImage = await page.locator('#image').boundingBox();
    await page.click('#target');
    for (const [x, y] of [[.25, .25], [.75, .25], [.75, .6], [.25, .6]]) await page.mouse.click(targetImage.x + targetImage.width * x, targetImage.y + targetImage.height * y);
    const polygon = await page.evaluate(() => SignageEditor.snapshot().project.target_polygon_px);
    assert.equal(polygon.length, 4);
    for (const [i, point] of [[300, 195], [900, 195], [900, 468], [300, 468]].entries()) assert.ok(Math.hypot(polygon[i][0] - point[0], polygon[i][1] - point[1]) < 2, 'Tool overlay must not alter photo coordinates');
    assert.equal(await page.locator('#target').getAttribute('aria-pressed'), 'false');
    await page.evaluate(async () => {await SignageWorkspace.flush(); await SignageDraft.flush();});
    await page.reload(); await ready(page);
    assert.deepEqual(await page.evaluate(() => SignageEditor.snapshot().project.target_polygon_px), polygon);
    await clickStep(4);
    assert.equal(await page.locator('#imageViewport').isVisible(), false, 'The result step never displays the editing canvas');
    assert.equal(await page.locator('#status').isVisible(), false);
    assert.equal(await page.locator('#interfaceResultEmpty').isVisible(), true);
    assert.equal(await page.locator('#connectionBadge').isVisible(), false);
    assert.equal(await page.locator('#connectionMessage').isVisible(), false);
    for (const choice of ['sunny', 'cloudy', 'night', 'original', 'photo_match']) {
      await page.locator('[name="lightingChoice"][value="' + choice + '"]').check();
      assert.equal(await page.inputValue('#lighting'), choice);
      assert.equal(await page.locator('[name="lightingChoice"]:checked').count(), 1);
    }
    await page.locator('[name="sceneRetouchChoice"][value="ideal_environment"]').check();
    assert.equal(await page.locator('#sceneRetouchOptions').isVisible(), true);
    await page.locator('[name="sceneRetouchChoice"][value="off"]').check();
    assert.equal(await page.locator('#sceneRetouchOptions').isVisible(), false);
    assert.equal(await page.evaluate(() => SignageGeneration.settings().photo_match), 'source_noise_v1');
    assert.equal(await page.evaluate(() => SignageGeneration.settings().lighting), 'original');
    await page.evaluate(async () => {await SignageWorkspace.flush();await SignageDraft.flush();});
    await page.reload();await ready(page);await clickStep(4);
    assert.equal(await page.locator('[name="lightingChoice"][value="photo_match"]').isChecked(), true);
    const saved = await page.evaluate(() => ({project: SignageEditor.snapshot().project, photo: SignageEditor.draftSnapshot().photo, project_id: SignageWorkspace.context().id}));
    const seeded = await page.request.post(fixture.address+'/__qa/seed', {data: {...saved, id: 'editor-controls-saved-result-0001'}});
    assert.equal(seeded.status(), 201);
    await page.evaluate(() => SignageGeneration.restoreDraft({version: 1, jobId: 'editor-controls-saved-result-0001', view: 'render', photoMatchesResult: true}));
    assert.equal(await page.locator('#aiResult').isVisible(), true);
    assert.equal(await page.locator('#imageViewport').isVisible(), false, 'Saved results do not reveal the editing canvas');
    assert.equal(await page.locator('#interfaceResultEmpty').isVisible(), false);
    await clickStep(3);
    await zoomWithWheel();
    const beforeResultRoundTrip = await page.evaluate(() => ({project: SignageEditor.snapshot().project, view: SignageEditor.draftSnapshot().view}));
    await clickStep(4, true);
    assert.equal(await page.locator('#aiResult').isVisible(), true);
    await clickStep(3, true);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#imageViewport').isVisible(), true);
    assert.deepEqual(await page.evaluate(() => ({project: SignageEditor.snapshot().project, view: SignageEditor.draftSnapshot().view})), beforeResultRoundTrip, 'Result navigation preserves geometry, zoom and pan');
    await clickStep(4, true);
    assert.ok(await page.locator('#resultMaterial .result-object-card').count() > 0);
    assert.match(await page.locator('#resultMaterial').innerText(), /Цветокоррекция как на фото/);
    assert.match(await page.locator('#resultTitle').innerText(), /Цветокоррекция как на фото/);
    for (const width of [1655, 768, 390, 320]) {
      await page.setViewportSize({width, height: 1000});
      const result = await page.evaluate(() => {
        const image=document.getElementById('generatedImage').getBoundingClientRect(),params=document.querySelector('.result-specification').getBoundingClientRect();
        return {imageBottom: image.bottom, paramsTop: params.top, width: innerWidth, content: document.documentElement.scrollWidth,
          commonRow: ['openResultImage','downloadRender','downloadAudit','downloadProductionSpec'].every(id=>document.getElementById(id).parentElement.classList.contains('preview-actions'))};
      });
      assert.ok(result.paramsTop > result.imageBottom && result.commonRow);
      assert.ok(result.content <= result.width, 'Result layout overflow at '+width);
      assert.equal(await page.locator('#imageViewport').isVisible(), false);
      assert.equal(await page.locator('#status').isVisible(), false);
      assert.equal(await page.locator('#interfaceResultEmpty').isVisible(), false);
      if (width===1655 || width===390) await page.locator('#aiResult').screenshot({path: path.join(output, 'result-'+width+'.png')});
      if (width===1655 || width===390) await page.screenshot({path: path.join(output, 'result-page-'+width+'.png'), fullPage: true});
      await clickStep(3);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await bounded();
      await clickStep(4);
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(generations, []);
    fs.writeFileSync(path.join(output, 'browser-result.json'), JSON.stringify({passed: true, widths, errors, generations}, null, 2));
    console.log('PASS: Next/Back and keyboard focus, old panel hidden immediately, default segment scale and legacy draft reload, rectangle preserved, canvas tools and real point placement, settings below canvas, 320-1655px, persistence, no image generation');
  } catch(error) {await page.screenshot({path: path.join(output, 'failure.png')}); throw error;}
  finally {await browser.close(); fixture.stop();}
})().catch(error => {console.error(error); process.exitCode = 1;});
