'use strict';
// Real browser and real Python project store. The renderer is forbidden; all
// historical images are explicit local fixtures, never subscription requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
let playwright;
try {playwright = require('playwright');} catch {playwright = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');}
const root = path.resolve(__dirname, '..');
const python = process.env.TEST_PYTHON || 'C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const reportDir = path.join(root, 'qa-project-history-20261013');
const pythonFixture = String.raw`
import base64, hashlib, io, json, sys, tempfile, threading, time
from pathlib import Path
sys.path.insert(0, str(Path.cwd() / 'scripts'))
from PIL import Image
import render_server as app
requests = []
def renderer(*args, **kwargs):
    raise AssertionError('Browser QA must never invoke an image renderer')
temp = tempfile.TemporaryDirectory(prefix='signage-project-browser-')
output = Path(temp.name) / 'jobs'
output.mkdir()
Original = app.Handler
class PrefixHandler(Original):
    def route(self, method):
        if self.path.startswith('/__qa/state'):
            files = {str(file.relative_to(output)): hashlib.sha256(file.read_bytes()).hexdigest() for file in output.rglob('*') if file.is_file()}
            return self.respond(200, {'requests': requests, 'render_calls': 0, 'files': files})
        if self.path == '/__qa/seed' and method == 'POST':
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
            identity = body['id']
            if not app.re.fullmatch(r'[a-zA-Z0-9_-]{16,80}', identity):
                return self.respond(400, {'error': 'Invalid fixture identity'})
            folder = output / identity
            folder.mkdir(exist_ok=False)
            (folder / 'project.json').write_text(json.dumps(body['project'], ensure_ascii=False), encoding='utf8')
            photo = base64.b64decode(body['photo'].split(',', 1)[1])
            for name in ('source.png','render.png','lighting-base.png'):
                (folder / name).write_bytes(photo)
            (folder / 'audit.json').write_text(json.dumps({'lighting': 'original', 'canvas_size_px': [1200,800], 'changed_pixels_outside_edit_zone': 0}), encoding='utf8')
            (folder / 'job.json').write_text(json.dumps({'id': identity, 'status': 'complete', 'created': body.get('created', time.time())}), encoding='utf8')
            with Image.open(io.BytesIO(photo)) as image:
                image.convert('RGB').save(folder / 'thumbnail.jpg')
            if body.get('project_id'):
                self.service.projects.link_job(identity, body['project_id'], body.get('created', time.time()))
            return self.respond(201, {'id': identity})
        requests.append({'method': method, 'path': self.path})
        if self.path == '/signs':
            self.path = '/'
        elif self.path.startswith('/signs/'):
            self.path = self.path[len('/signs'):]
        else:
            return self.respond(404, {'error': 'Fixture requires /signs/'})
        if self.path == '/api/jobs' and method == 'POST':
            return self.respond(503, {'error': 'AI generation is deliberately blocked by browser QA'})
        return getattr(Original, 'do_' + method)(self)
    def do_GET(self): return self.route('GET')
    def do_POST(self): return self.route('POST')
    def do_PUT(self): return self.route('PUT')
server = app.create_server(0, output, renderer=renderer, status_reader=lambda: {'configured': True, 'connection_message': 'Local fixtures; image generation forbidden'})
server.RequestHandlerClass = PrefixHandler
threading.Thread(target=server.serve_forever, daemon=True).start()
print(json.dumps({'port': server.server_port}), flush=True)
try:
    sys.stdin.read()
finally:
    server.shutdown()
    server.service.shutdown(timeout=1) if hasattr(server.service, 'shutdown') else None
    server.server_close()
    temp.cleanup()
`;
async function startFixture() {
  const child = spawn(python, ['-u', '-c', pythonFixture], {cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
  let stderr = '', stdout = '';
  child.stderr.on('data', chunk => {stderr += chunk;});
  const address = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Python fixture did not start: ' + stderr)), 20000);
    child.once('exit', code => {clearTimeout(timer); reject(new Error(`Python fixture exited (${code}): ${stderr}`));});
    child.stdout.on('data', chunk => {stdout += chunk; const first = stdout.split('\n')[0]; try {const {port} = JSON.parse(first); if (port) {clearTimeout(timer); resolve(`http://127.0.0.1:${port}`);}} catch {}});
  });
  return {child, address, stop() {child.stdin.end();}, stderr: () => stderr};
}
async function ready(page) {
  await page.waitForFunction(() => window.SignageWorkspace && window.SignageEditor);
  await page.evaluate(() => Promise.all([SignageDraft.ready, SignageWorkspace.ready, SignageGeneration.ready, SignageInterface.ready]));
}
async function edit(page, id, value) {
  await page.evaluate(({id, value}) => {const input = document.getElementById(id); input.value = value; input.dispatchEvent(new Event('input', {bubbles: true})); input.dispatchEvent(new Event('change', {bubbles: true}));}, {id, value});
}
async function flush(page) {await page.evaluate(async () => {await SignageDraft.flush(); await SignageWorkspace.flush();});}
async function localAfterServer(page) {await page.evaluate(async () => {await SignageWorkspace.flush(); await SignageDraft.flush();});}
async function main() {
  fs.mkdirSync(reportDir, {recursive: true});
  const fixture = await startFixture();
  if (process.argv.includes('--serve-only')) {
    console.log(JSON.stringify({url: fixture.address + '/signs/calibrator.html', fixture: 'Python real project store; renderer forbidden'}));
    return;
  }
  const browser = await playwright.chromium.launch({channel: process.env.TEST_BROWSER_CHANNEL || 'msedge', headless: true});
  const errors = [], result = {steps: [], viewports: [], errors};
  const captureErrors = page => page.on('pageerror', error => errors.push(error.message));
  try {
    const config = await (await fetch(fixture.address + '/signs/api/config')).json();
    const api = async (endpoint, body) => {
      const response = await fetch(fixture.address + '/signs/api/' + endpoint, {method: body ? 'POST' : 'GET', headers: {'X-Editor-Token': config.token, ...(body ? {'Content-Type': 'application/json'} : {})}, ...(body ? {body: JSON.stringify(body)} : {})});
      const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
    };
    const contextA = await browser.newContext({viewport: {width: 1280, height: 900}});
    const contextB = await browser.newContext({viewport: {width: 1280, height: 900}});
    const a = await contextA.newPage(), b = await contextB.newPage(); captureErrors(a); captureErrors(b);
    const editorURL = fixture.address + '/signs/calibrator.html';
    await a.goto(editorURL + '?newProject=1'); await ready(a);
    await a.click('#demo'); await a.waitForFunction(() => SignageEditor.snapshot().report?.placement);
    const fullSnapshot = await a.evaluate(() => ({...SignageEditor.draftSnapshot(), photo: SignageEditor.photoPng()}));
    await a.evaluate(async () => {const snapshot = SignageEditor.draftSnapshot(); snapshot.project.calibration.image_points = []; snapshot.project.placement = null; snapshot.ui.text.value = 'НЕЗАВЕРШЁННЫЙ ПРОЕКТ'; await SignageEditor.restoreDraft(snapshot);});
    await flush(a);
    let listing = await api('projects'), current = listing.items.find(item => !item.legacy);
    assert.ok(current, 'A partially calibrated draft must be stored without generation validation');
    const projectId = current.id;
    let saved = await api('projects/' + projectId);
    assert.equal(saved.snapshot.project.calibration.image_points.length, 0);
    assert.equal(saved.snapshot.project.placement, null);
    assert.ok(saved.snapshot.photo.startsWith('data:image/png;base64,'));
    await b.goto(editorURL + '?restoreProject=' + encodeURIComponent(projectId)); await ready(b);
    assert.equal(await b.evaluate(() => SignageEditor.snapshot().project.calibration.image_points.length), 0);
    result.steps.push('Partial draft with original photo loads on independent PC B');

    await a.evaluate(async snapshot => SignageEditor.restoreDraft(snapshot), fullSnapshot);
    await a.evaluate(() => SignageProductUI.switchType('plaque'));
    await a.waitForFunction(() => SignageEditor.snapshot().project.products[0].type === 'plaque');
    await a.click('#interfaceSteps [data-interface-step-button="3"]');
    const uploadedURL = await a.evaluate(() => {const c = document.createElement('canvas'); c.width = 160; c.height = 90; const ctx = c.getContext('2d'); ctx.fillStyle = '#125a85'; ctx.fillRect(0, 0, 160, 90); ctx.fillStyle = '#f2df13'; ctx.fillRect(23, 13, 70, 25); return c.toDataURL('image/png');});
    await a.selectOption('#artworkSource', 'uploaded');
    await a.setInputFiles('#artworkUpload', {name: 'exact-original.png', mimeType: 'image/png', buffer: Buffer.from(uploadedURL.split(',')[1], 'base64')});
    await a.waitForFunction(() => SignageEditor.snapshot().project.products[0].artwork?.source === 'uploaded');
    await edit(a, 'text', 'ПРОЕКТ A'); await flush(a);
    saved = await api('projects/' + projectId);
    assert.equal(saved.snapshot.project.products[0].artwork.data_url, uploadedURL);
    const savedPhoto = saved.snapshot.photo;
    await b.goto(editorURL + '?restoreProject=' + encodeURIComponent(projectId)); await ready(b);
    let snapshotB = await b.evaluate(() => SignageEditor.draftSnapshot());
    assert.equal(snapshotB.photo === savedPhoto, true, JSON.stringify(await b.evaluate(() => ({status: document.getElementById('serverProjectStatus').textContent, draft: document.getElementById('draftStatus').textContent, workspace: SignageWorkspace.state(), photo: SignageEditor.snapshot().hasPhoto, warnings: document.getElementById('warnings').textContent}))));
    assert.equal(snapshotB.project.products[0].artwork?.data_url === uploadedURL, true, JSON.stringify(await b.evaluate(() => ({status: document.getElementById('serverProjectStatus').textContent, workspace: SignageWorkspace.state(), type: SignageEditor.snapshot().project.products[0].type, text: SignageEditor.snapshot().project.products[0].params.text}))));
    assert.deepEqual(snapshotB.project.calibration, saved.snapshot.project.calibration);
    result.steps.push('Calibrated geometry, photo and exact uploaded artwork load on PC B');

    await edit(b, 'text', 'ПРАВКА НА ПК B'); await flush(b);
    const newest = await api('projects/' + projectId);
    await edit(a, 'text', 'УСТАРЕВШАЯ ПРАВКА A'); await flush(a);
    const afterConflict = await api('projects/' + projectId);
    assert.equal(afterConflict.revision, newest.revision, 'Stale PC A must not advance or overwrite revision');
    assert.equal(afterConflict.snapshot.project.products[0].params.text, 'ПРАВКА НА ПК B');
    const workspaceStatus = await a.evaluate(() => document.getElementById('serverProjectStatus')?.textContent || JSON.stringify(SignageWorkspace.state?.() || {}));
    result.conflict = workspaceStatus;
    result.steps.push('Stale PC A cannot overwrite a newer PC B revision');
    await localAfterServer(b);
    const cleanDefault = await contextB.newPage(); captureErrors(cleanDefault);
    await cleanDefault.goto(editorURL); await ready(cleanDefault);
    assert.equal(await cleanDefault.inputValue('#text'), 'ПРАВКА НА ПК B');
    assert.equal(await cleanDefault.evaluate(() => SignageWorkspace.state().conflict), false);
    result.steps.push('Clean default reopen gets current server workspace');
    const slow = await contextA.newPage(); captureErrors(slow);
    let releaseRead; const heldRead = new Promise(resolve => {releaseRead = resolve;});
    await slow.route('**/signs/api/projects/' + projectId, async route => {await heldRead; await route.continue();});
    await slow.goto(editorURL + '?restoreProject=' + projectId);
    await slow.waitForFunction(() => window.SignageWorkspace?.state().loading);
    assert.equal(await slow.evaluate(() => document.querySelector('.layout').inert), true, 'Editor must block interaction while remote project is restoring');
    assert.equal(await slow.isDisabled('#projectName'), true);
    releaseRead(); await ready(slow);
    assert.equal(await slow.evaluate(() => document.querySelector('.layout').inert), false);
    result.steps.push('Slow server restore blocks edits until the project has loaded');

    const legacyId = 'legacy-qa-project-000001';
    const seedResponse = await fetch(fixture.address + '/__qa/seed', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: legacyId, project: fullSnapshot.project, photo: fullSnapshot.photo, created: 1791800000})});
    assert.equal(seedResponse.status, 201);
    for (let index = 1; index <= 2; index++) {
      const historical = JSON.parse(JSON.stringify(fullSnapshot.project)); historical.sign.text = 'ВАРИАНТ ' + index; historical.products[0].params.text = 'ВАРИАНТ ' + index;
      const response = await fetch(fixture.address + '/__qa/seed', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: 'grouped-qa-variant-' + String(index).padStart(6, '0'), project_id: projectId, project: historical, photo: fullSnapshot.photo, created: 1791800000 + index})});
      assert.equal(response.status, 201);
    }
    const beforeRead = await (await fetch(fixture.address + '/__qa/state')).json();
    const exact = await contextB.newPage(); captureErrors(exact);
    await exact.goto(editorURL + '?restoreJob=' + legacyId); await ready(exact);
    await exact.waitForFunction(() => !document.getElementById('aiResult').hidden);
    assert.equal(await exact.inputValue('#text'), fullSnapshot.project.products[0].params.text);
    const afterRead = await (await fetch(fixture.address + '/__qa/state')).json();
    assert.equal(afterRead.requests.filter(r => r.method === 'POST' && r.path === '/signs/api/jobs').length, 0);
    assert.equal(afterRead.requests.filter(r => r.method === 'POST' && /^\/signs\/api\/projects\//.test(r.path)).length, beforeRead.requests.filter(r => r.method === 'POST' && /^\/signs\/api\/projects\//.test(r.path)).length, 'Exact variant restore must be read-only until an edit');
    result.steps.push('Exact legacy generation opens without imagegen or project writes');
    await exact.evaluate(() => SignageWorkspace.copy());
    const copyId = await exact.evaluate(() => SignageWorkspace.context().id);
    assert.notEqual(copyId, 'legacy-' + legacyId);
    const copiedRecord = await api('projects/' + copyId);
    assert.equal(copiedRecord.generation.jobId, null, 'Copy must not claim ownership of an existing result from another project');
    assert.equal(copiedRecord.generation.pendingJobId, null);
    const copiedPage = await contextB.newPage(); captureErrors(copiedPage);
    await copiedPage.goto(editorURL + '?restoreProject=' + copyId); await ready(copiedPage);
    assert.equal(await copiedPage.evaluate(() => document.getElementById('aiResult').hidden), true, 'Opening a copied project must not restore an unrelated historical result');
    result.steps.push('Copy of exact existing variant has separate identity and no foreign result reference');
    await copiedPage.route('**/signs/api/projects/**', route => route.abort());
    await edit(copiedPage, 'letterObjectText', 'ОФЛАЙН ПРАВКА КОПИИ'); await localAfterServer(copiedPage);
    assert.equal(await copiedPage.evaluate(() => SignageWorkspace.state().dirty), true);
    result.offlineBefore = await copiedPage.evaluate(() => ({text: document.getElementById('letterObjectText').value, actual: SignageEditor.snapshot().project.products[0].params.text, workspace: SignageWorkspace.state(), status: document.getElementById('serverProjectStatus').textContent, journal: JSON.parse(localStorage.getItem('signage-draft-journal:/signs/')).snapshot.workspace}));
    copiedPage.once('dialog', dialog => dialog.accept());
    await copiedPage.reload(); await ready(copiedPage);
    result.offlineAfter = await copiedPage.evaluate(() => ({text: document.getElementById('letterObjectText').value, actual: SignageEditor.snapshot().project.products[0].params.text, workspace: SignageWorkspace.state(), status: document.getElementById('serverProjectStatus').textContent, journal: JSON.parse(localStorage.getItem('signage-draft-journal:/signs/')).snapshot.workspace}));
    assert.equal(await copiedPage.inputValue('#letterObjectText'), 'ОФЛАЙН ПРАВКА КОПИИ', JSON.stringify({before: result.offlineBefore, after: result.offlineAfter}));
    assert.equal(await copiedPage.evaluate(() => SignageWorkspace.state().loading), false, 'Local matching pending draft must stay editable when remote read fails');
    await copiedPage.unroute('**/signs/api/projects/**'); await localAfterServer(copiedPage);
    assert.equal((await api('projects/' + copyId)).snapshot.project.products[0].params.text, 'ОФЛАЙН ПРАВКА КОПИИ');
    result.steps.push('Offline pending local edits survive reload and sync after connection returns');

    const fresh = await contextB.newPage(); captureErrors(fresh);
    await fresh.goto(editorURL + '?newProject=1'); await ready(fresh);
    assert.equal(await fresh.evaluate(() => SignageEditor.snapshot().hasPhoto), false, 'New project must ignore local previous project');
    await fresh.click('#demo'); await fresh.waitForFunction(() => SignageEditor.snapshot().report?.placement); await flush(fresh);
    listing = await api('projects');
    assert.ok(listing.items.filter(item => !item.legacy).some(item => item.id !== projectId), 'New project must receive separate server identity');
    assert.equal((await api('projects/' + projectId)).snapshot.project.products[0].params.text, 'ПРАВКА НА ПК B');
    result.steps.push('Explicit new project stays separate from edited server project');

    const history = await contextB.newPage(); captureErrors(history);
    await history.goto(fixture.address + '/signs/history.html');
    await history.waitForFunction(() => document.getElementById('historyStatus')?.textContent && !document.getElementById('historyStatus').textContent.includes('Загружаю'));
    assert.ok(await history.locator('.project-card').count() >= 3, 'History must include server drafts and legacy project');
    const parentCard = history.locator(`[data-project-id="${projectId}"]`);
    assert.equal(await parentCard.locator('.variant-count').textContent(), '2 варианта');
    await parentCard.locator('.project-open').click();
    await history.waitForFunction(() => document.getElementById('historyStatus').textContent.includes('варианты') && !document.getElementById('historyStatus').textContent.includes('Загружаю'));
    assert.equal(await history.locator('.history-card').count(), 2);
    assert.ok((await history.locator('#continueProject').getAttribute('href')).includes('restoreProject=' + projectId));
    await history.locator('.history-card').first().click();
    await history.waitForFunction(() => document.getElementById('detailStatus').textContent === 'Сохранённая генерация.');
    assert.ok((await history.locator('#restoreProject').getAttribute('href')).includes('restoreJob=grouped-qa-variant-'));
    result.steps.push('Grouped project lists all exact variants and separate latest-edit and variant-edit links');
    await history.click('#backToProjects');
    await history.waitForFunction(() => document.querySelectorAll('.project-card').length >= 3);
    await history.locator(`[data-project-id="${projectId}"] .project-checkbox`).check();
    await history.locator(`[data-project-id="legacy-${legacyId}"] .project-checkbox`).check();
    await history.selectOption('#mergeTarget', projectId);
    await history.click('#mergeProjects');
    await history.waitForFunction(() => document.querySelectorAll('.history-card').length === 3);
    assert.ok((await history.locator('#projectMeta').textContent()).startsWith('3 варианта'), 'Project heading must reflect merged variant count');
    assert.equal((await api('projects/' + projectId)).snapshot.project.products[0].params.text, 'ПРАВКА НА ПК B');
    assert.deepEqual((await (await fetch(fixture.address + '/__qa/state')).json()).files, beforeRead.files, 'Grouping must preserve every saved generation file byte for byte');
    result.steps.push('Explicit legacy grouping retains all files and chosen latest workspace');
    for (const width of [320, 390, 1280]) {
      for (const [name, page] of [['editor', b], ['history', history]]) {
        await page.setViewportSize({width, height: 900});
        await page.waitForTimeout(70);
        const dimensions = await page.evaluate(() => ({viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth}));
        assert.ok(dimensions.content <= dimensions.viewport + 1, `${name} overflows at ${width}: ${JSON.stringify(dimensions)}`);
        result.viewports.push({name, width, ...dimensions});
        await page.screenshot({path: path.join(reportDir, `${name}-${width}.png`), fullPage: true});
      }
    }
    assert.deepEqual(errors, []);
    result.requests = (await (await fetch(fixture.address + '/__qa/state')).json()).requests;
    result.imagegenPosts = result.requests.filter(r => r.method === 'POST' && r.path === '/signs/api/jobs').length;
    assert.equal(result.imagegenPosts, 0);
    result.passed = true;
    console.log('PASS: real project API, independent PCs, partial and exact originals, revision conflicts, legacy read-only restore, separate new project, grouped history, responsive 320/390/1280. No image generation.');
  } finally {
    fs.writeFileSync(path.join(reportDir, 'browser-result.json'), JSON.stringify(result, null, 2));
    await browser.close(); fixture.stop();
  }
}
if (require.main === module) main().catch(error => {console.error(error); process.exitCode = 1;});
module.exports = {startFixture, ready, edit, flush};
