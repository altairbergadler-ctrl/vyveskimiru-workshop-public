'use strict';
// Loopback fixtures only: no Codex process, OpenAI request or production history.
// --serve-only exposes the same fixture for manual browser/CUA regression.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assets = path.resolve(__dirname, '../assets');
const jobs = new Map(), projects = new Map(), requests = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64');
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' signage-corel:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'";
const postCount = () => requests.filter(r => r.method === 'POST' && r.path === '/signs/api/jobs').length;
const complete = () => {for (const job of jobs.values()) job.status = 'complete';};
function fixtureState() {
  return {postJobs: postCount(), getJobs: requests.filter(r => r.method === 'GET' && r.path.startsWith('/signs/api/jobs/')).length,
    requests, jobs: [...jobs.values()].map(job => ({id: job.id, status: job.status, lighting: job.lighting,
      text: job.project.sign.text, type: job.project.products?.[0]?.type, engine: job.project.generation.engine}))};
}
async function body(req) {const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString() || '{}');}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost'), route = url.pathname, method = req.method;
  const send = (data, mime = 'application/json; charset=utf-8', status = 200) => {
    res.writeHead(status, {'Content-Type': mime, 'Cache-Control': 'no-store', 'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'});
    res.end(Buffer.isBuffer(data) ? data : JSON.stringify(data));
  };
  try {
    if (route === '/__qa/state' && method === 'GET') return send(fixtureState());
    if (route === '/__qa/complete' && method === 'POST') {complete(); return send(fixtureState());}
    if (route === '/signs/catalog.js') return send(Buffer.from('globalThis.SignageCatalog='+fs.readFileSync(path.join(assets,'product-catalog.json'),'utf8')+';'), 'application/javascript; charset=utf-8');
    requests.push({method, path: route});
    if (!route.startsWith('/signs/')) return send({error: 'Fixture routes require /signs/'}, undefined, 404);
    const endpoint = route.slice('/signs/'.length);
    if (endpoint === 'api/config') return send({provider: 'codex', configured: true, composite_configured: true,
      token: 'fixture-token', connection_message: 'Локальный тестовый сервер. Реальные запросы ИИ отключены.'});
    if (endpoint === 'api/history') return send({items: [], total: 0});
    // This presentation fixture exercises the empty history page; listing and
    // search are covered by the real project-store browser suite.
    if (endpoint === 'api/projects') return send({items: [], total: 0});
    const projectMatch = /^api\/projects\/([a-zA-Z0-9_-]{16,96})$/.exec(endpoint);
    if (projectMatch) {
      const id = projectMatch[1], previous = projects.get(id);
      if (method === 'POST') {
        const payload = await body(req);
        if (payload.base_revision !== (previous?.revision || 0)) return send({error: 'Project revision conflict'}, undefined, 409);
        const record = {id, name: payload.name, revision: (previous?.revision || 0) + 1, snapshot: payload.snapshot, generation: payload.generation};
        projects.set(id, record); return send(record);
      }
      if (method === 'GET') return previous ? send(previous) : send({error: 'Project not found'}, undefined, 404);
    }
    if (endpoint === 'api/jobs' && method === 'POST') {
      const payload = await body(req);
      if (jobs.has(payload.request_id)) return send({error: 'Regression: repeated POST for an existing fixture job'}, undefined, 409);
      const photo = /^data:image\/png;base64,/.test(payload.photo || '') ? Buffer.from(payload.photo.split(',')[1], 'base64') : png;
      const job = {id: payload.request_id, project_id: payload.project_id, status: 'running', lighting: payload.project.generation.lighting,
        project: payload.project, photo, created: Date.now() / 1000};
      jobs.set(job.id, job); return send({id: job.id, status: job.status});
    }
    const match = /^api\/jobs\/([a-zA-Z0-9_-]+)(?:\/(project\.json|render\.png|lighting-base\.png|source\.png))?$/.exec(endpoint);
    if (match) {
      const job = jobs.get(match[1]); if (!job) return send({error: 'Fixture job not found'}, undefined, 404);
      if (match[2] === 'project.json') return send(job.project);
      // All three artifacts are the original source in this transport fixture.
      // Their dimensions match the project; this does not test image rendering.
      if (match[2]) return send(job.photo, 'image/png');
      return send({id: job.id, project_id: job.project_id, status: job.status, lighting: job.lighting, created: job.created,
        message: job.status === 'running' ? 'Локальное тестовое задание выполняется. ИИ не вызывался.' : 'Тестовое задание завершено.',
        audit: {canvas_size_px: [job.project.image.width_px, job.project.image.height_px], changed_pixels_outside_edit_zone: 0, exact_artwork: true}});
    }
    const file = path.resolve(assets, endpoint || 'calibrator.html');
    if (!file.startsWith(assets + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send({error: 'Not found'}, undefined, 404);
    const mime = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.woff2': 'font/woff2'}[path.extname(file)] || 'application/octet-stream';
    return send(fs.readFileSync(file), mime);
  } catch (error) {send({error: error.message}, undefined, 500);}
});
const listen = port => new Promise((resolve, reject) => {server.once('error', reject); server.listen(port, '127.0.0.1', resolve);});
const stepButton = n => `#interfaceSteps [data-interface-step-button="${n}"]`;
async function ready(page) {await page.evaluate(() => Promise.all([SignageDraft.ready, SignageInterface.ready]));}
async function assertHiddenStates(page) {
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[hidden]')]
    .filter(node => getComputedStyle(node).display !== 'none').map(node => node.id || node.className || node.tagName)), [],
  'Presentation CSS must respect editor-owned hidden states');
}
async function assertAllPanelsAvailable(page) {
  assert.equal(await page.evaluate(() => document.documentElement.dataset.interface), 'redesign');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.interfaceReady), undefined);
  assert.deepEqual(await page.evaluate(() => {
    // Independent signs intentionally replace the former global controls;
    // these functional product conditions remain effective in fallback too.
    const productOwned = new Set(document.documentElement.dataset.letterObjects === 'true'
      ? ['interfaceTextLayout', 'interfaceFontField', 'productFontBoldLabel', 'lettersFields'] : []);
    if (document.documentElement.dataset.independentSigns === 'true') productOwned.add('interfaceSizeHint');
    return [...document.querySelectorAll('[data-interface-panel]:not([hidden]),.interface-production-field:not([hidden])')]
      .filter(node => !productOwned.has(node.id) && !node.parentElement.closest('[hidden]') && getComputedStyle(node).display === 'none')
      .map(node => node.id || node.className);
  }), [],
  'Readiness/failure state must keep the current editor panels and production settings available');
  await assertHiddenStates(page);
}
async function assertCurrentOnly(page) {
  assert.equal(await page.locator('#interfaceToggle').count(), 0);
  assert.equal(await page.evaluate(() => SignageInterface.setMode('legacy')), false);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.interface), 'redesign');
  assert.equal(await page.evaluate(() => SignageInterface.setMode('redesign')), true);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.interface), 'redesign');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.interfaceReady), 'true');
  await assertHiddenStates(page);
}
async function stableState(page) {
  return page.evaluate(() => {
    const draft = SignageEditor.draftSnapshot();
    return {project: draft.project, ui: draft.ui, interaction: draft.interaction, photo: draft.photo, photoKey: draft.photoKey,
      productUi: draft.productUi, letterUi: draft.letterUi, photoRevision: SignageEditor.snapshot().photoRevision, generation: SignageGeneration.draftState()};
  });
}
async function rememberNodes(page) {
  await page.evaluate(() => {window.__interfaceNodes = new Map([...document.querySelectorAll('[id]')]
    .filter(node => !node.parentElement?.closest('#overlay,#rulerOverlay,#textArt')).map(node => [node.id, node]));
    window.__interfaceLoad = performance.timeOrigin;});
}
async function assertNodes(page) {
  assert.deepEqual(await page.evaluate(() => {
    const seen = new Set(), errors = [];
    for (const node of document.querySelectorAll('[id]')) {if (seen.has(node.id)) errors.push(`duplicate:${node.id}`); seen.add(node.id);}
    for (const [id, node] of window.__interfaceNodes) if (document.getElementById(id) !== node || !node.isConnected) errors.push(`replaced:${id}`);
    if (window.__interfaceLoad !== performance.timeOrigin) errors.push('page-reloaded'); return errors;
  }), []);
}
async function assertImageViewer(page, src, screenshotPath) {
  await page.evaluate(src => SignagePreview.openImage({src, title: 'Проверка сохранённого изображения'}), src);
  assert.equal(await page.locator('.image-dialog').isVisible(), true);
  await page.locator('.image-dialog img').evaluate(img => img.decode());
  const fit = await page.locator('.image-dialog img').evaluate(img => ({position: getComputedStyle(img).position,
    width: img.getBoundingClientRect().width, viewport: img.parentElement.getBoundingClientRect().width}));
  assert.equal(fit.position, 'absolute'); assert.ok(fit.width <= fit.viewport);
  await page.locator('.image-dialog button[aria-pressed]').click();
  const natural = await page.locator('.image-dialog img').evaluate(img => ({position: getComputedStyle(img).position,
    width: img.getBoundingClientRect().width, natural: img.naturalWidth}));
  assert.equal(natural.position, 'static'); assert.equal(natural.width, natural.natural);
  await page.locator('.image-dialog button[aria-pressed]').click();
  await page.screenshot({path: screenshotPath, fullPage: true});
  await page.getByRole('button', {name: 'Закрыть просмотр изображения'}).click();
  assert.equal(await page.locator('.image-dialog').isVisible(), false);
}
async function assertDownloads(page, output) {
  await page.evaluate(async () => {await SignageProductUI.prepareArtwork(); SignageEditor.render();});
  const project = await page.evaluate(() => SignageEditor.snapshot().project);
  assert.equal(project.sign.composition_mode, 'independent_signs_v1');
  assert.ok(project.sign.objects.length > 0, 'Export fixture must contain real independent signs');
  const downloads = [];
  for (const [id, name] of [['exportProject', 'signage-project.json'], ['exportSvg', 'signage-geometry.svg'], ['exportPng', 'signage-geometry.png']]) {
    assert.equal(await page.locator(`#${id}`).isEnabled(), true);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click(`#${id}`)]);
    assert.equal(download.suggestedFilename(), name); assert.equal(await download.failure(), null);
    const file = path.join(output, name); await download.saveAs(file);
    downloads.push({name, bytes: fs.statSync(file).size});
  }
  const saved = JSON.parse(fs.readFileSync(path.join(output, 'signage-project.json'), 'utf8'));
  assert.deepEqual(saved, project, 'JSON export must retain the complete current independent-sign project');
  const svg = fs.readFileSync(path.join(output, 'signage-geometry.svg'), 'utf8');
  assert.match(svg, /<svg\b/); assert.ok(svg.includes(`viewBox="0 0 ${project.image.width_px} ${project.image.height_px}"`));
  const image = fs.readFileSync(path.join(output, 'signage-geometry.png'));
  assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.deepEqual([image.readUInt32BE(16), image.readUInt32BE(20)], [project.image.width_px, project.image.height_px]);
  assert.deepEqual(await page.evaluate(() => SignageEditor.snapshot().project), project, 'Exports must not change project geometry or artwork');
  return downloads;
}
async function assertProductFamilies(page) {
  const families = [
    ['channel_letters', '#letterObjectHeight', null], ['plaque', '#plaqueThickness', '4'],
    ['neon', '#neonTubing', '10'], ['flat_print', '#productParam-opacity', '0.75'],
    ['lightbox', '#productParam-depth_cm', '12'], ['cutout', '#productParam-opacity', '0.5'],
  ];
  const beforePhoto = await page.evaluate(() => ({photo: SignageEditor.draftSnapshot().photo, revision: SignageEditor.snapshot().photoRevision}));
  for (const [type, field, value] of families) {
    await page.click(`[data-product-type="${type}"]`);
    assert.equal(await page.evaluate(() => SignageProductUI.type()), type);
    assert.equal(await page.locator(`[data-product-type="${type}"]`).getAttribute('aria-pressed'), 'true');
    if (type !== 'channel_letters' && await page.locator('#interfaceProductionToggle').getAttribute('aria-expanded') !== 'true') await page.click('#interfaceProductionToggle');
    assert.equal(await page.locator(field).isVisible(), true, `${type}: its active parameter must be reachable`);
    assert.equal(await page.locator(field).isEnabled(), true);
    if (value !== null) await page.fill(field, value);
    assert.equal(await page.locator('#letterComposition').isVisible(), type === 'channel_letters');
    assert.equal(await page.locator('#artworkFields').isVisible(), type !== 'channel_letters');
    if (type === 'cutout') {
      assert.equal(await page.locator('#artworkSource').isDisabled(), true);
      assert.equal(await page.locator('#artworkUpload').isVisible(), true);
    } else if (['flat_print', 'lightbox'].includes(type)) {
      assert.equal(await page.locator('#artworkSource').isDisabled(), false);
      await page.selectOption('#artworkSource', 'uploaded');
      assert.equal(await page.locator('#artworkUpload').isVisible(), true);
      await page.selectOption('#artworkSource', 'text');
      assert.equal(await page.locator('#artworkUpload').isVisible(), false);
    }
    await assertHiddenStates(page);
    assert.deepEqual(await page.evaluate(() => ({photo: SignageEditor.draftSnapshot().photo, revision: SignageEditor.snapshot().photoRevision})), beforePhoto);
  }
  for (const [type, field, value] of families.filter(([, , value]) => value !== null)) {
    await page.click(`[data-product-type="${type}"]`);
    assert.equal(await page.inputValue(field), value, `${type}: its own settings must survive family changes`);
  }
  await page.click('[data-product-type="plaque"]');
  return families.map(([type]) => type);
}
async function browserRegression() {
  // This mode is deliberately separate from --serve-only. Run it only where
  // direct Playwright browser automation is permitted by the calling workflow.
  let playwright;
  try {playwright = require('playwright');} catch {playwright = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');}
  await listen(0);
  const address = `http://127.0.0.1:${server.address().port}/signs/calibrator.html?interface=legacy`;
  const browser = await playwright.chromium.launch({channel: process.env.TEST_BROWSER_CHANNEL || 'msedge', headless: true});
  const errors = [], external = [], responsive = [];
  let downloads = [], families = [];
  const output = path.resolve(process.env.INTERFACE_QA_OUTPUT || path.join(__dirname, '../qa-current-design-styles'));
  fs.mkdirSync(output, {recursive: true});
  async function pageIn(context) {
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== new URL(address).origin) {external.push(url.href); return route.abort();}
      return route.continue();
    }); return page;
  }
  try {
    const context = await browser.newContext({viewport: {width: 1280, height: 900}}), page = await pageIn(context);
    await page.addInitScript(() => localStorage.setItem('signage-interface-v1:/signs/', 'legacy'));
    await page.goto(address); await ready(page); await page.click('#demo');
    await assertCurrentOnly(page);
    await page.waitForFunction(() => SignageEditor.snapshot().report?.placement);
    await page.click(stepButton(4)); downloads = await assertDownloads(page, output);
    assert.equal(postCount(), 0, 'Local exports must not start any generation');
    await rememberNodes(page);
    // Incomplete calibration and temporarily invalid input are useful work,
    // even when they cannot produce a valid export or generation.
    await page.click(stepButton(2));
    await page.selectOption('#calibrationMode', 'frontoparallel');
    assert.equal(await page.locator('#frontal').count(), 0);
    assert.equal(await page.evaluate(() => SignageEditor.snapshot().project.calibration.frontoparallel_assumed), true);
    await page.click('#reference');
    const image = await page.locator('#image').boundingBox();
    await page.mouse.click(image.x + image.width * .3, image.y + image.height * .3);
    await page.click(stepButton(3));
    await page.fill('#letterObjectText', 'НЕЗАВЕРШЁННЫЙ\nПРОЕКТ'); await page.fill('#letterObjectHeight', '');
    const partial = await stableState(page); assert.equal(partial.interaction.pending.length, 1);
    await assertCurrentOnly(page); assert.deepEqual(await stableState(page), partial); await assertNodes(page);
    await page.click(stepButton(1)); await page.click('#demo'); await page.waitForFunction(() => SignageEditor.snapshot().report?.placement);
    await page.click(stepButton(3));
    await page.click('[data-product-type="neon"]'); await page.click('#interfaceProductionToggle');
    await page.fill('#text', 'МОЙ НЕОН'); await page.fill('#neonTubing', '10');
    await page.evaluate(() => SignageProductUI.prepareArtwork());
    await page.click('[data-product-type="plaque"]');
    const original = await page.evaluate(() => {const c = document.createElement('canvas'); c.width = 80; c.height = 50;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#174f3b'; ctx.fillRect(0, 0, 80, 50); return c.toDataURL('image/png');});
    await page.selectOption('#artworkSource', 'uploaded');
    await page.setInputFiles('#artworkUpload', {name: 'retained-original.png', mimeType: 'image/png', buffer: Buffer.from(original.split(',')[1], 'base64')});
    await page.waitForFunction(() => SignageProductUI.active().artwork?.source === 'uploaded');
    await page.fill('#text', 'ТЕКСТ НЕ ЗАМЕНЯЕТ ОРИГИНАЛ'); await page.fill('#plaqueThickness', '4');
    await rememberNodes(page);
    const product = await stableState(page); await assertCurrentOnly(page); assert.deepEqual(await stableState(page), product); await assertNodes(page);
    await page.click('[data-product-type="neon"]'); assert.equal(await page.inputValue('#text'), 'МОЙ НЕОН'); assert.equal(await page.inputValue('#neonTubing'), '10');
    await page.click('[data-product-type="plaque"]'); assert.equal(await page.inputValue('#plaqueThickness'), '4');
    assert.equal(await page.evaluate(() => SignageProductUI.active().artwork.data_url), original);
    families = await assertProductFamilies(page);
    assert.equal(await page.evaluate(() => SignageProductUI.active().artwork.data_url), original);
    await rememberNodes(page);
    // Request delivery, running-job polling and mode API calls must
    // all keep the same ID. The only POST below is the explicit generate click.
    await page.evaluate(() => {SignageEditor.setPlacement({center_px: [594, 294], width_cm: 120, height_cm: 25, rotation_deg: 0}); SignageEditor.render();});
    await page.click(stepButton(4));
    await page.waitForFunction(() => !document.getElementById('generate').disabled).catch(async error => {
      console.error(await page.evaluate(() => ({reason: document.getElementById('generationReady').textContent,
        warning: document.getElementById('warnings').textContent, calibration: SignageEditor.snapshot().project.calibration,
        generation: SignageGeneration.draftState()})));
      throw error;
    });
    const beforePost = postCount(); await page.click('#generate');
    await page.waitForFunction(() => SignageGeneration.draftState().pendingJobId);
    const pending = await page.evaluate(() => SignageGeneration.draftState().pendingJobId);
    await assertCurrentOnly(page); assert.equal(postCount(), beforePost + 1);
    assert.equal(await page.evaluate(() => SignageGeneration.draftState().pendingJobId), pending);
    assert.equal(await page.locator('#generate').isDisabled(), true); await assertNodes(page);
    complete(); await page.waitForFunction(() => !document.getElementById('aiResult').hidden, null, {timeout: 8000});
    await page.click('#showBase'); await page.evaluate(() => SignageDraft.flush());
    await page.reload(); await ready(page); await assertCurrentOnly(page);
    await page.waitForFunction(() => !document.getElementById('aiResult').hidden);
    assert.equal(postCount(), beforePost + 1); await rememberNodes(page);
    const restored = await stableState(page), resultSrc = await page.locator('#generatedImage').getAttribute('src');
    await assertCurrentOnly(page); assert.deepEqual(await stableState(page), restored); await assertNodes(page);
    assert.equal(await page.locator('#generatedImage').getAttribute('src'), resultSrc); assert.equal(postCount(), beforePost + 1);
    await assertImageViewer(page, resultSrc, path.join(output, 'editor-image-viewer.png'));
    await page.click(stepButton(1));
    await page.getByRole('button', {name: 'Подсказка: Фотография и проект', exact: true}).click();
    assert.equal(await page.locator('#interfaceHelpDialog').isVisible(), true);
    assert.match(await page.locator('#interfaceHelpContent').innerText(), /фото/i);
    await page.screenshot({path: path.join(output, 'editor-help-dialog.png'), fullPage: true});
    await page.click('#interfaceHelpClose'); assert.equal(await page.locator('#interfaceHelpDialog').isVisible(), false);
    // Current layout must ignore old preferences and work without storage.
    const blockedContext = await browser.newContext(), blocked = await pageIn(blockedContext);
    await blocked.addInitScript(() => Object.defineProperty(window, 'localStorage', {get() {throw new DOMException('Blocked', 'SecurityError');}}));
    await blocked.goto(address); await ready(blocked); await assertCurrentOnly(blocked);
    await blocked.click('#demo'); assert.equal(await blocked.evaluate(() => SignageEditor.snapshot().hasPhoto), true);
    await blockedContext.close();
    // Hold only the IndexedDB open notification to expose an authentic slow
    // restore. Early API/step input must not cancel the saved draft.
    const delayed = await pageIn(context);
    await delayed.addInitScript(() => {
      const open = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (...args) {
        const request = open.apply(this, args); if (args[0] !== 'signage-editor-drafts') return request;
        return new Proxy(request, {get(target, key) {const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;},
          set(target, key, value) {if (key === 'onsuccess') {target.onsuccess = event => {window.__draftWaiting = true; window.__releaseDraftRead = () => value.call(target, event);}; return true;}
            return Reflect.set(target, key, value, target);}});
      };
    });
    await delayed.goto(address); await delayed.waitForFunction(() => window.__draftWaiting);
    assert.equal(await delayed.locator('#interfaceToggle').count(), 0);
    assert.equal(await delayed.evaluate(() => SignageInterface.setMode('legacy')), false);
    assert.equal(await delayed.evaluate(() => SignageInterface.setMode('redesign')), false);
    assert.equal(await delayed.locator(stepButton(3)).isDisabled(), true);
    const box = await delayed.locator(stepButton(3)).boundingBox();
    if (box) await delayed.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await assertAllPanelsAvailable(delayed);
    await delayed.screenshot({path: path.join(output, 'restoration-current-layout.png'), fullPage: true});
    await delayed.evaluate(() => window.__releaseDraftRead()); await ready(delayed);
    assert.equal(await delayed.evaluate(() => SignageEditor.snapshot().hasPhoto), true, 'Early presentation input cancelled the saved draft');
    assert.equal(await delayed.evaluate(() => SignageProductUI.active().artwork.data_url), original);
    await assertCurrentOnly(delayed); assert.equal(await delayed.locator(stepButton(3)).isDisabled(), false); await delayed.close();
    // All step controls and type-specific content must remain reachable at
    // mobile widths. Browser viewport checks do not imply phone acceptance.
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({width, height: 844}); await page.evaluate(() => SignageInterface.setMode('redesign'));
      for (const step of [1, 2, 3, 4]) {
        await page.click(stepButton(step));
        assert.equal(await page.evaluate(() => Number(document.documentElement.dataset.interfaceStep)), step);
        assert.equal(await page.locator(`[data-interface-panel="${step}"]`).first().isVisible(), true);
        await page.waitForTimeout(50);
        const size = await page.evaluate(() => ({width: innerWidth, scroll: document.documentElement.scrollWidth}));
        assert.ok(size.scroll <= size.width, `Horizontal overflow at ${width}px, step ${step}: ${size.scroll}`);
        await assertHiddenStates(page);
        responsive.push({...size, step});
        if ([1440, 768, 390, 320].includes(width)) await page.screenshot({path: path.join(output, `step-${step}-${width}.png`), fullPage: true});
        assert.equal(await page.locator('#interfaceToggle').count(), 0);
      }
      await assertCurrentOnly(page); await assertNodes(page);
    }
    // Dynamic product fields, alternative calibration, saved result and help
    // retain their own hidden states; the presentation must never reveal them.
    await page.click(stepButton(2)); await page.selectOption('#calibrationMode', 'rectangle');
    assert.equal(await page.locator('#rectangleFields').isVisible(), true);
    assert.equal(await page.locator('#frontFields').isVisible(), false); await assertHiddenStates(page);
    await page.selectOption('#calibrationMode', 'frontoparallel');
    assert.equal(await page.locator('#rectangleFields').isVisible(), false);
    assert.equal(await page.locator('#frontFields').isVisible(), true); await assertHiddenStates(page);
    await page.click(stepButton(3)); await page.click('[data-product-type="channel_letters"]');
    assert.equal(await page.locator('#letterComposition').isVisible(), true);
    assert.equal(await page.locator('#globalTextField').isVisible(), false);
    assert.equal(await page.locator('#artworkFields').isVisible(), false); await assertHiddenStates(page);
    await page.click('[data-product-type="plaque"]');
    assert.equal(await page.locator('#letterComposition').isVisible(), false);
    assert.equal(await page.locator('#artworkFields').isVisible(), true); await assertHiddenStates(page);
    // A stylesheet failure after readiness drops only presentation filtering.
    // Existing user work and result/job identity remain untouched.
    await rememberNodes(page); const beforeFailure = await stableState(page), countBeforeFailure = postCount();
    await page.evaluate(() => document.getElementById('interfaceStyles').dispatchEvent(new Event('error')));
    await assertAllPanelsAvailable(page); assert.deepEqual(await stableState(page), beforeFailure);
    await assertNodes(page); assert.equal(postCount(), countBeforeFailure);
    assert.equal(await page.locator(stepButton(3)).isDisabled(), true);
    await page.screenshot({path: path.join(output, 'css-error-current-panels.png'), fullPage: true});
    // A missing file on the initial request must also leave all functional
    // sections reachable; the page must not switch to retired markup or mode.
    const noCssContext = await browser.newContext({viewport: {width: 1280, height: 900}}), noCss = await pageIn(noCssContext);
    await noCss.route('**/interface.css?*', route => route.abort());
    await noCss.goto(address); await ready(noCss); await assertAllPanelsAvailable(noCss);
    assert.equal(await noCss.evaluate(() => SignageInterface.setMode('redesign')), false);
    assert.equal(await noCss.evaluate(() => SignageInterface.setMode('legacy')), false);
    await noCss.click('#demo'); await noCss.waitForFunction(() => SignageEditor.snapshot().hasPhoto);
    await assertAllPanelsAvailable(noCss);
    await noCss.screenshot({path: path.join(output, 'css-missing-current-panels.png'), fullPage: true});
    await noCssContext.close();
    const history = await pageIn(context);
    await history.goto(new URL('history.html', address).href);
    await history.waitForFunction(() => window.SignagePreview && document.getElementById('historyStatus').textContent.includes('пока нет'));
    assert.equal(await history.locator('#detail').isVisible(), false);
    await assertImageViewer(history, resultSrc, path.join(output, 'history-image-viewer.png'));
    await assertHiddenStates(history); await history.close();
    assert.deepEqual(errors, []); assert.deepEqual(external, []); await context.close();
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({browser: process.env.TEST_BROWSER_CHANNEL || 'msedge', responsive,
      requests: fixtureState().requests, postJobs: postCount(), errors, external, downloads, families, currentLayoutAtFirstPaint: true,
      cssFailureKeepsCurrentPanels: true, editorHiddenStatesPreserved: true, draftPhotoProductsAndJobRetained: true}, null, 2));
    console.log('PASS: current interface only, legacy query/preference ignored, no mode toggle, DOM identity, JSON/SVG/PNG downloads of independent signs, all six product families/settings, unfinished independent sign/photo/input, product drafts/original PNG, pending/restored job without repeated POST, blocked localStorage, slow restoration/current panels, hidden condition states, CSS failure/current panels, 320/390/768/1024/1440px steps; fixture only, no AI calls.');
  } finally {await browser.close(); await new Promise(resolve => server.close(resolve));}
}
async function unitRegression() {
  const vm = require('node:vm'), html = fs.readFileSync(path.join(assets, 'calibrator.html'), 'utf8');
  const source = fs.readFileSync(path.join(assets, 'interface.js'), 'utf8');
  assert.match(html, /<html\b[^>]*data-interface="redesign"/, 'The first paint must already use the current presentation');
  assert.match(html, /<body\b[^>]*class="[^"]*\bsignage-editor\b/, 'Current editor styles must be scoped independently of sibling pages');
  assert.doesNotMatch(html, /<style\b|interface-legacy|interface-only|interface-header-description/, 'Retired layout and inline base styles must be removed');
  assert.doesNotMatch(html, /id="interfaceToggle"/, 'Retired mode toggle must be absent from the DOM');
  const styleUrls = [...html.matchAll(/<link\b[^>]*href="([^"]+\.css[^\"]*)"/g)].map(match => match[1]);
  assert.ok(styleUrls.length >= 4, 'Functional component styles must remain linked');
  for (const url of [...styleUrls, /<script\b[^>]*src="(interface\.js[^\"]*)"/.exec(html)?.[1]]) {
    assert.ok(url && new URL(url, 'http://fixture/').searchParams.get('v'), `Changed presentation assets need a cache version: ${url}`);
  }
  const cssFiles = styleUrls.map(url => fs.readFileSync(path.join(assets, url.split('?')[0]), 'utf8'));
  assert.doesNotMatch(cssFiles.join('\n'), /\.interface-(?:legacy-title|toggle|only)\b|data-interface\s*=\s*["']?legacy/, 'Retired presentation selectors must not ship');
  class Element {
    constructor(id = '', tag = 'div') {this.id = id; this.tagName = tag; this.dataset = {}; this.hidden = true; this.disabled = true;
      this.textContent = ''; this.title = ''; this.attributes = new Map(); this.listeners = new Map(); this.classes = new Set();
      this.classList = {contains: value => this.classes.has(value)};}
    matches(selectors) {return selectors.split(',').some(selector => {selector = selector.trim();
      if (selector.startsWith('#')) return this.id === selector.slice(1);
      if (selector.startsWith('.')) return this.classes.has(selector.slice(1));
      if (selector === '[data-interface-panel]') return Object.hasOwn(this.dataset, 'interfacePanel');
      if (selector === '[data-interface-step-button]') return Object.hasOwn(this.dataset, 'interfaceStepButton');
      return this.tagName === selector;});}
    closest(selector) {for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null;}
    contains(node) {for (; node; node = node.parentElement) if (node === this) return true; return false;}
    setAttribute(key, value) {this.attributes.set(key, String(value));}
    removeAttribute(key) {this.attributes.delete(key);}
    addEventListener(type, callback) {const handlers = this.listeners.get(type) || []; handlers.push(callback); this.listeners.set(type, handlers);}
    dispatchEvent(event) {for (const callback of this.listeners.get(event.type) || []) callback(event); return !event.defaultPrevented;}
    querySelector(selector) {return this.children?.find(node => node.matches(selector)) || null;}
  }
  function harness({css = true, storageBlocked = false, savedMode = null, search = '',
    generationDeferred = false, restoredPending = null, action = '', hasPhoto = false, openingStatus = '', initializationError = false} = {}) {
    const root = new Element('', 'html'), docBody = new Element('', 'body'), nodes = new Map(), frames = [], reads = [], writes = [], mutations = [], warnings = [];
    root.dataset = {interface: 'redesign', interfaceStep: '1'}; docBody.parentElement = root;
    for (const match of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
      const node = new Element(match[3], match[1]); node.parentElement = docBody;
      node.hidden = /\bhidden\b/.test(match[2]); node.disabled = /\bdisabled\b/.test(match[2]);
      const classes = /\bclass="([^"]+)"/.exec(match[2]); if (classes) classes[1].split(/\s+/).forEach(value => node.classes.add(value));
      const panel = /data-interface-panel="([^"]+)"/.exec(match[2]); if (panel) node.dataset.interfacePanel = panel[1];
      nodes.set(node.id, node);
    }
    const buttons = [], navigation = [], navStart = html.indexOf('<nav'), navEnd = html.indexOf('</nav>');
    for (const match of html.matchAll(/<button\b([^>]*data-interface-step-button="([1-4])"[^>]*)>/g)) {
      const id = /\bid="([^"]+)"/.exec(match[1]), node = id ? nodes.get(id[1]) : new Element('', 'button');
      node.dataset.interfaceStepButton = match[2]; node.disabled = /\bdisabled\b/.test(match[1]); node.parentElement = docBody;
      if (match.index > navStart && match.index < navEnd) {node.parentElement = nodes.get('interfaceSteps');
        const state = new Element(); state.classes.add('interface-step-state'); node.children = [state]; navigation.push(node);}
      buttons.push(node);
    }
    const connectionLabel = new Element('', 'span'); nodes.get('interfaceConnection').children = [connectionLabel];
    nodes.get('interfaceProduction').dataset.productionOpen = 'false';
    nodes.get('draftStatus').textContent = 'Изменения автоматически сохраняются в этом браузере.';
    nodes.get('connectionBadge').textContent = 'Codex подключён';
    nodes.get('generationStatus').textContent = openingStatus;
    nodes.get('authExpiredNotice').hidden = true; nodes.get('aiResult').hidden = true; nodes.get('resultStale').hidden = true;
    const document = new Element(), window = new Element();
    document.documentElement = root; document.body = docBody; document.activeElement = docBody;
    document.getElementById = id => nodes.get(id);
    document.querySelectorAll = selector => selector === '[data-interface-step-button]' ? buttons :
      selector === '#interfaceSteps [data-interface-step-button]' ? navigation :
      selector === '.interface-only' ? [...nodes.values()].filter(node => node.classes.has('interface-only')) :
      selector === '[data-interface-focus-retained]' ? [...nodes.values()].filter(node => Object.hasOwn(node.dataset, 'interfaceFocusRetained')) : [];
    let release, releaseGeneration;
    const draftReady = new Promise(resolve => {release = resolve;}), generationReady = new Promise(resolve => {releaseGeneration = resolve;});
    const project = {image: hasPhoto ? {width_px: 1200, height_px: 800} : null, calibration: {}, sign: {text: 'ТЕСТ'}};
    const forbid = operation => () => {mutations.push(operation); throw new Error(`Presentation attempted ${operation}`);};
    window.SignageDraft = {ready: draftReady};
    window.SignageEditor = {snapshot: () => {if (initializationError) throw new Error('Fixture initialization failure');
      return {project, hasPhoto, report: hasPhoto ? {placement: {fits_target: true}} : null};}, draftSnapshot: () => ({project, interaction: {action}}),
      render: forbid('editor.render'), restoreDraft: forbid('editor.restoreDraft'), restoreProject: forbid('editor.restoreProject')};
    const generationState = {jobId: null, pendingJobId: null};
    window.SignageGeneration = {ready: generationReady, draftState: () => ({...generationState}), restore: forbid('generation.restore')};
    // Match generation.js: restoration is a separate continuation of ready,
    // and it must also wait for the draft. The presentation reads this state;
    // the fixture does not poll, submit, or restore a business object here.
    const pendingRestore = generationReady.then(async () => {await draftReady; generationState.pendingJobId = restoredPending;});
    if (!generationDeferred) releaseGeneration();
    window.SignageProductUI = {generationEngine: () => 'codex', active: () => ({type: 'channel_letters'})};
    window.LetterGeometry = {calibrate: () => {throw new Error('No calibration');}};
    const storage = {getItem(key) {reads.push(key); if (storageBlocked) throw new Error('blocked'); return savedMode;}, setItem(key, value) {if (storageBlocked) throw new Error('blocked'); writes.push({key, value});}};
    const location = new URL('http://127.0.0.1:54748/signs/calibrator.html' + search);
    const context = {window, document, location, URL, URLSearchParams, localStorage: storage, Event, console: {...console, warn: (...args) => warnings.push(args)},
      getComputedStyle: () => ({getPropertyValue: () => css ? '1' : ''}),
      requestAnimationFrame: callback => {frames.push(callback); return frames.length;}, queueMicrotask,
      MutationObserver: class {observe() {}}, fetch: forbid('fetch')};
    vm.runInNewContext(source, context, {filename: 'interface.js'});
    const drain = () => {for (let i = 0; frames.length && i < 20; i++) frames.shift()(); assert.equal(frames.length, 0);};
    return {api: window.SignageInterface, root, document, window, nodes, buttons, release, releaseGeneration,
      pendingRestore, drain, reads, writes, mutations, warnings, location, generationState, identities: [...nodes.entries()], project};
  }
  for (const css of [true, false]) {
    const app = harness({css});
    assert.equal(app.api.setMode('redesign'), false); assert.equal(app.api.setMode('legacy'), false); assert.equal(app.api.setStep(4), false);
    assert.equal(app.root.dataset.interface, 'redesign'); assert.equal(app.nodes.has('interfaceToggle'), false);
    assert.equal(app.root.dataset.interfaceReady, undefined);
    assert.ok(app.buttons.every(button => button.disabled));
    const event = {type: 'pointerdown', target: app.buttons[0], preventDefault() {this.prevented = true;}, stopImmediatePropagation() {this.stopped = true;}};
    app.window.dispatchEvent(event); assert.equal(event.prevented, true); assert.equal(event.stopped, true);
    app.release(); const result = await app.api.ready; app.drain();
    assert.equal(result.available, css);
    assert.equal(result.mode, 'redesign');
    assert.deepEqual(app.reads, []); assert.deepEqual(app.writes, []);
    if (!css) {assert.equal(app.api.mode(), 'redesign'); assert.equal(app.api.setMode('redesign'), false);
      assert.equal(app.api.setMode('legacy'), false); assert.equal(app.api.setStep(2), false);
      assert.equal(app.root.dataset.interfaceReady, undefined);
      assert.equal(app.root.dataset.interfaceProductionOpen, 'true');
      assert.equal(app.root.dataset.interfaceWorkspace, 'visible');
      assert.ok(app.buttons.every(button => button.disabled));}
    else {assert.equal(app.api.mode(), 'redesign'); assert.ok(app.buttons.every(button => !button.disabled));
      assert.equal(app.root.dataset.interfaceReady, 'true');
      for (const step of [1, 2, 3, 4]) {assert.equal(app.api.setStep(step), true); assert.equal(app.root.dataset.interfaceStep, String(step));}
      const beforeRejection = {mode: app.api.mode(), step: app.api.step(), writes: app.writes.length};
      for (const mode of ['legacy', '', 'unknown']) {assert.equal(app.api.setMode(mode), false); assert.equal(app.api.mode(), beforeRejection.mode);
        assert.equal(app.api.step(), beforeRejection.step); assert.equal(app.writes.length, beforeRejection.writes);}
      assert.equal(app.api.setMode('redesign'), true); assert.equal(app.api.mode(), 'redesign');
      assert.equal(app.window.SignageEditor.snapshot().project, app.project);
      for (const [id, node] of app.identities) assert.equal(app.nodes.get(id), node);
      app.nodes.get('interfaceStyles').dispatchEvent({type: 'error'}); assert.equal(app.api.mode(), 'redesign');
      assert.equal(app.root.dataset.interfaceReady, undefined);
      assert.equal(app.root.dataset.interfaceProductionOpen, 'true');
      assert.equal(app.root.dataset.interfaceWorkspace, 'visible');
      assert.equal(app.api.setMode('legacy'), false); assert.equal(app.api.setMode('redesign'), false); assert.equal(app.api.setStep(2), false);
      assert.ok(app.buttons.every(button => button.disabled));}
    assert.deepEqual(app.mutations, []);
  }
  const failed = harness({initializationError: true}); failed.release(); const failedReady = await failed.api.ready; failed.drain();
  assert.equal(failedReady.available, false); assert.equal(failedReady.mode, 'redesign'); assert.equal(failed.api.mode(), 'redesign');
  assert.equal(failed.root.dataset.interfaceReady, undefined);
  assert.equal(failed.root.dataset.interfaceProductionOpen, 'true');
  assert.equal(failed.api.setMode('legacy'), false); assert.equal(failed.api.setMode('redesign'), false);
  assert.equal(failed.api.setStep(3), false); assert.equal(failed.warnings.length, 1);
  assert.ok(failed.buttons.every(button => button.disabled)); assert.deepEqual(failed.mutations, []);
  const blocked = harness({storageBlocked: true, search: '?interface=legacy'}); blocked.release(); await blocked.api.ready;
  assert.equal(blocked.api.mode(), 'redesign'); assert.equal(blocked.api.setMode('legacy'), false);
  assert.equal(blocked.api.setMode('redesign'), true); blocked.drain(); assert.deepEqual(blocked.reads, []);
  assert.deepEqual(blocked.mutations, []);
  for (const [requested, savedMode] of [['legacy', 'redesign'], ['redesign', 'legacy'], ['legacy', 'legacy'], ['', 'legacy']]) {
    const app = harness({savedMode, search: `?interface=${requested}`}); app.release(); await app.api.ready;
    assert.equal(app.api.mode(), 'redesign', 'Retired query and stored preference must not re-enable legacy mode');
    assert.equal(app.api.setMode('legacy'), false); assert.equal(app.api.mode(), 'redesign');
    assert.deepEqual(app.reads, [], 'Current layout must not read the retired preference');
    assert.equal(app.writes.length, 0, 'Initialization must not overwrite the saved preference');
    app.drain(); assert.deepEqual(app.mutations, []);
  }
  const focused = harness({savedMode: 'legacy'}); focused.release(); await focused.api.ready;
  assert.equal(focused.api.mode(), 'redesign'); assert.equal(focused.api.setStep(2), true);
  const field = focused.nodes.get('text'), panel = focused.nodes.get('interfaceSignPanel');
  field.parentElement = panel; field.value = 'НЕЗАВЕРШЁННЫЙ\nПРОЕКТ'; field.selectionStart = 3; field.selectionEnd = 8;
  focused.document.activeElement = field;
  assert.equal(focused.api.setMode('legacy'), false); assert.equal(focused.api.step(), '2');
  assert.equal(focused.api.setMode('redesign'), true); assert.equal(focused.api.step(), '3');
  assert.equal(focused.api.setStep(4), true); assert.equal(panel.dataset.interfaceFocusRetained, '');
  assert.equal(focused.document.activeElement, field); assert.equal(field.value, 'НЕЗАВЕРШЁННЫЙ\nПРОЕКТ');
  assert.deepEqual([field.selectionStart, field.selectionEnd], [3, 8]);
  focused.document.activeElement = focused.document.body; focused.document.dispatchEvent({type: 'focusout'});
  await Promise.resolve(); assert.equal(Object.hasOwn(panel.dataset, 'interfaceFocusRetained'), false);
  focused.drain(); assert.deepEqual(focused.mutations, []);
  for (const order of ['generation-first', 'draft-first']) {
    for (const action of ['', 'reference', 'measure', 'place', 'target', 'editRegion']) {
      const app = harness({generationDeferred: true, restoredPending: 'retained-pending-id', action, hasPhoto: true});
      (order === 'generation-first' ? app.releaseGeneration : app.release)();
      await Promise.resolve(); await Promise.resolve();
      assert.ok(app.buttons.every(button => button.disabled), `${order}: UI must wait for both ready promises`);
      assert.equal(app.root.dataset.interface, 'redesign'); assert.equal(app.root.dataset.interfaceReady, undefined);
      assert.equal(app.nodes.has('interfaceToggle'), false);
      assert.equal(app.api.setMode('legacy'), false);
      assert.equal(app.api.setMode('redesign'), false);
      (order === 'generation-first' ? app.release : app.releaseGeneration)();
      await app.api.ready; await app.pendingRestore; app.drain();
      const expectedStep = action === 'reference' || action === 'measure' ? '2' : action === 'place' || action === 'target' ? '3' : '4';
      assert.equal(app.api.step(), expectedStep, `${order}, ${action || 'no action'}: pending restoration startup step`);
      assert.equal(app.window.SignageGeneration.draftState().pendingJobId, 'retained-pending-id');
      for (const [id, node] of app.identities) assert.equal(app.nodes.get(id), node);
      assert.deepEqual(app.mutations, []);
    }
  }
  for (const scenario of [
    {search: '?restoreJob=retained-history-id', removeQuery: true, expectedStep: '4'},
    {search: '?restoreJob=invalid-short', expectedStep: '1'},
    {openingStatus: 'Открываю сохранённый проект и исходное фото…', expectedStep: '4'},
  ]) {
    const app = harness(scenario);
    if (scenario.removeQuery) {app.location.searchParams.delete('restoreJob'); assert.equal(app.location.searchParams.has('restoreJob'), false);}
    app.release(); await app.api.ready; app.drain();
    assert.equal(app.api.step(), scenario.expectedStep, 'History startup must recognize only the captured valid ID or actual opening status');
    assert.equal(app.api.setStep(2), true);
    app.generationState.jobId = 'retained-history-id'; app.nodes.get('aiResult').hidden = false;
    app.nodes.get('generationStatus').textContent = 'Сохранённый макет восстановлен. Генерация не запускалась.';
    app.document.dispatchEvent({type: 'signage:resultchange'}); app.drain();
    assert.equal(app.api.step(), '2', 'A later resultchange must not replace the step chosen by the user');
    assert.equal(app.root.dataset.interfaceResult, 'true');
    for (const [id, node] of app.identities) assert.equal(app.nodes.get(id), node);
    assert.deepEqual(app.mutations, []);
  }
  console.log('PASS: interface VM — current presentation from first paint, no retired CSS/markup, versioned presentation assets, legacy query/preference ignored, legacy API rejected, readiness guard, current panels exposed on CSS/error failure, blocked storage, four steps, editor/node identity, focused field/selection, pending restore in both ready orders with unfinished actions, history startup/query removal and retained user step after resultchange, no editor restore/render/fetch writes. Browser regression not run.');
}
if (process.argv.includes('--serve-only')) {
  listen(54748).then(() => console.log('Interface fixture: http://127.0.0.1:54748/signs/ ; GET /__qa/state ; POST /__qa/complete ; no AI calls.'))
    .catch(error => {console.error(error); process.exitCode = 1;});
} else if (process.argv.includes('--browser')) {
  browserRegression().catch(error => {console.error(error); server.close(); process.exitCode = 1;});
} else {
  unitRegression().catch(error => {console.error(error); process.exitCode = 1;});
}
