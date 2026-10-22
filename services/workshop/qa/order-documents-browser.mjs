import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(root, 'modules/orders/public');
const out = path.join(root, 'work/validation/order-documents-ui'); fs.mkdirSync(out, { recursive: true });
const account = { id: '00000000-0000-4000-8000-000000000002', label: 'Учебный счёт', bank: 'Учебный банк', bik: '049999999', account: '40702810900000000001', correspondent: '30101810300000000001', active: true };
const seller = { id: '00000000-0000-4000-8000-000000000001', revision: 'seller-revision-1', label: 'Учебный исполнитель', name: 'ООО «Учебный исполнитель»', inn: '9900000000', kpp: '990001001', address: 'г. Учебный, ул. Примерная, 1', signer: 'Учебный Иван', signerRole: 'Директор', vat: 'none', active: true, accounts: [account], source: {} };
const sellerItems = [seller, { ...seller, id: '00000000-0000-4000-8000-000000000003', label: 'Организация без выбранного НДС', vat: null, accounts: [{ ...account, id: '00000000-0000-4000-8000-000000000004' }] }];
const buyer = { name: '<script>window.injected=true</script> Учебный покупатель', inn: '9900000000', kpp: '990001001', address: 'г. Учебный, 2' };
const posts = [], errors = [], changes = [];
let failFirst = true, created = 0;
const stampTemplate = { id: 'a'.repeat(32), name: 'Учебная печать', companyName: 'ООО «Учебный исполнитель»', companyInn: '9900000000', widthMm: 40, aspect: 1, sha256: 'a'.repeat(64), revision: 'stamp-r1' };
const otherStamp = { ...stampTemplate, id: 'b'.repeat(32), name: 'Другая учебная печать', companyInn: '9900000024', sha256: 'b'.repeat(64) };
const signatureTemplate = { id: 'c'.repeat(32), name: 'Учебная подпись', signer: 'Основная', widthMm: 60, aspect: 2, sha256: 'c'.repeat(64), revision: 'signature-r1' };
const imageRef = image => ({ id: image.id, sha256: image.sha256, revision: image.revision });
let stampScenario = null;
const stampBaseFiles = new Map();
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const json = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8' }); response.end(JSON.stringify(value)); };
  if (url.pathname.startsWith('/fake/')) {
    if (url.pathname === '/fake/document-stamp-library') return stampScenario?.mode === 'library-unavailable' ? json(503, { message: 'Учебная библиотека временно недоступна' }) : json(200, { version: 1, stamps: [stampTemplate, otherStamp], signatures: [signatureTemplate] });
    if (url.pathname.includes('/documents/prepare')) return json(200, { sellerItems, buyer, items: [{ name: 'Учебная табличка', quantity: 2, unit: 'шт.', price: 600, amount: 1200 }], total: 1200, orderId: '9001', orderDate: '2026-10-21', completed: false, warnings: [], ready: true, sourceHash: 'source-hash-1' });
    if (url.pathname === '/fake/document-sellers' && request.method === 'GET') return json(200, { items: sellerItems, ready: true });
    let body = ''; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body || '{}');
    const stampRoute = url.pathname.match(/^\/fake\/orders\/9001\/documents\/([^/]+)\/stamps(?:\/([^/]+))?(?:\/(files))?$/);
    if (stampRoute && stampScenario) {
      const [, documentId, operationRequestId, files] = stampRoute;
      if (!operationRequestId && request.method === 'POST') {
        stampScenario.starts.push(payload);
        if (stampScenario.mode === 'stale') return json(409, { code: 'DOCUMENT_STAMP_PROFILE_CHANGED', message: 'Учебная привязка изменилась после предпросмотра.' });
        if (!stampScenario.jobs.has(payload.requestId)) stampScenario.jobs.set(payload.requestId, { polls: 0, documentId, attached: null });
        const job = stampScenario.jobs.get(payload.requestId);
        job.prepared = ['engine503', 'prepared-poll'].includes(stampScenario.mode) && stampScenario.starts.length === 1;
        if (stampScenario.mode === 'engine503' && stampScenario.starts.length === 1) return json(503, { code: 'DOCUMENT_STAMP_UNAVAILABLE', message: 'Учебный движок временно недоступен.' });
        if (stampScenario.mode === 'timeout' && stampScenario.starts.length === 1) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write(' '); return; }
        return json(200, { state: 'processing', operationId: payload.requestId, jobId: 'engine-job' });
      }
      const job = stampScenario.jobs.get(operationRequestId);
      if (!job) return json(404, { code: 'DOCUMENT_STAMP_NOT_FOUND', message: 'Учебный запрос ещё не зарегистрирован.' });
      if (files && request.method === 'POST') {
        stampScenario.filePosts.push({ requestId: operationRequestId, payload });
        if (!job.attached) {
          const original = stampBaseFiles.get(documentId);
          const derived = kind => ({ ...original, id: original.id + '-' + kind, name: original.name.replace('.pdf', '-' + kind + '.pdf'), generatedDocument: { ...original.generatedDocument, decoration: { kind } }, url: original.url + '-' + kind });
          job.attached = { state: 'confirmed', items: [original, derived('stamped'), derived('scan')] };
        }
        if (stampScenario.mode === 'timeout' && stampScenario.filePosts.length === 1) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write(' '); return; }
        return json(200, job.attached);
      }
      stampScenario.gets++;
      if (job.prepared) return json(200, { state: 'prepared', operationId: operationRequestId });
      job.polls++;
      return json(200, { state: job.polls <= 1 ? 'processing' : 'completed', operationId: operationRequestId, jobId: 'engine-job' });
    }
    if (url.pathname === '/fake/document-sellers') { const index = sellerItems.findIndex(item => item.id === payload.seller.id); const saved = { ...payload.seller, revision: 'saved-revision' }; if (index < 0) sellerItems.push(saved); else sellerItems[index] = saved; changes.push(payload); return json(200, { state: 'confirmed', seller: saved }); }
    if (url.pathname === '/fake/orders/9001/documents') {
      posts.push(payload);
      if (failFirst) { failFirst = false; return json(503, { code: 'DOCUMENT_UNCONFIRMED', message: 'Тестовая потеря ответа. Проверьте тот же запрос.' }); }
      created++;
      if (stampScenario) {
        const id = 'stamp-document-' + created;
        const media = { id: 'base-' + created, name: 'Учебный-счёт-v' + created + '.pdf', kind: 'document', contentType: 'application/pdf', size: 1500, url: '/kanban/api/orders/9001/media/base-' + created, generatedDocument: { type: 'invoice', number: payload.number, version: created, test: true } };
        stampBaseFiles.set(id, media);
        return json(200, { state: 'confirmed', document: { id, version: created }, media, layout: { version: 1, templateHash: 'fictional-template', anchors: [] } });
      }
      return json(200, { state: 'confirmed', document: { id: 'sample-document', version: 1 }, media: { items: [{ id: 'sample-pdf', name: 'Счёт-9001-v1.pdf', kind: 'document', contentType: 'application/pdf', size: 1500, url: '/kanban/api/orders/9001/media/sample-pdf', generatedDocument: { type: 'invoice', number: payload.number, version: 1, test: true } }] } });
    }
    return json(404, { message: 'Unknown test API' });
  }
  if (url.pathname === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
    response.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/kanban/styles.css"></head><body style="padding:20px"><button id="open-sellers">Наши юрлица</button><button id="edit-client">Изменить клиента</button><main id="host"></main><div id="result"></div><script type="module">
      import {createOrderDocumentsUI} from '/kanban/documents.js';
      import {enhanceRequisitesEditor,parseRequisites,requisitesSource} from '/kanban/requisites.js';
      import {openRecordEditor,createMediaGallery} from '/kanban/workspace.js';
      const api=async(path,options={})=>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),1000);try{const response=await fetch('/fake'+path,{...options,headers:{'Content-Type':'application/json'},signal:controller.signal});const data=await response.json();if(!response.ok){const error=new Error(data.message);error.status=response.status;error.code=data.code;throw error;}return data;}finally{clearTimeout(timer);}};
      const currentMedia={items:[]};
      const controller=createOrderDocumentsUI({api,onCreated:(order,result)=>{const incoming=result.media.items||[result.media];const items=new Map(currentMedia.items.map(item=>[item.id,item]));incoming.forEach(item=>items.set(item.id,item));currentMedia.items=[...items.values()];window.mediaFiles=currentMedia.items;if(result.keepDocuments)show();else document.getElementById('host').replaceChildren(createMediaGallery({orderId:order.id,media:currentMedia,api}));document.getElementById('result').textContent=result.decorationComplete?'Печать и скан сохранены':result.keepDocuments?'Исходный PDF сохранён':'PDF сохранён';}});
      const show=()=>document.getElementById('host').replaceChildren(controller.renderOrder({id:'9001',title:'Учебный заказ'})); show();
      window.showOrder=show;
      document.getElementById('open-sellers').onclick=()=>controller.openSellers();
      document.getElementById('edit-client').onclick=()=>openRecordEditor({title:'Клиент',fields:[{key:'companyName',label:'Название клиента',value:'Учебный клиент'},{key:'requisites',label:'Реквизиты',type:'textarea',value:window.savedRequisites||''}],enhance:enhanceRequisitesEditor,submit:async(changes,all)=>{window.savedRequisites=all.requisites;return{};},onSaved:()=>{window.parsedSaved=parseRequisites(window.savedRequisites);window.originalSaved=requisitesSource(window.savedRequisites);}});
    </script></body></html>`); return;
  }
  if (url.pathname.startsWith('/kanban/')) {
    const filename = path.resolve(publicRoot, url.pathname.slice('/kanban/'.length));
    if (!filename.startsWith(publicRoot + path.sep) || !fs.existsSync(filename)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': filename.endsWith('.css') ? 'text/css;charset=utf-8' : 'text/javascript;charset=utf-8' }); response.end(fs.readFileSync(filename)); return;
  }
  if (/^\/tools\/stamp\/api\/(stamps|signatures)\/[a-f0-9]{32}\/image$/.test(url.pathname)) { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')); return; }
  response.writeHead(404); response.end();
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:', error.message); });
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.getByLabel('Наша организация', { exact: true }).selectOption(sellerItems[1].id);
  await page.getByRole('button', { name: 'Предпросмотр', exact: true }).click();
  await page.getByText('Сначала укажите НДС для выбранной организации', { exact: false }).waitFor(); assert.equal(posts.length, 0);
  await page.getByLabel('Наша организация', { exact: true }).selectOption(seller.id);
  await page.getByLabel('Тестовый документ', { exact: true }).check();
  for (const width of [1440, 384, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert(await page.locator('.order-documents').evaluate(node => node.scrollWidth <= node.clientWidth), 'Document form overflow at ' + width);
    await page.screenshot({ path: path.join(out, 'documents-' + width + '.png') });
  }
  await page.getByRole('button', { name: 'Предпросмотр', exact: true }).click();
  const preview = page.locator('.document-dialog[open]');
  assert.equal(await page.evaluate(() => window.injected), undefined);
  await preview.getByText('ТЕСТОВЫЙ ДОКУМЕНТ · НЕ ДЛЯ ОПЛАТЫ', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(out, 'preview-320.png') });
  await preview.getByRole('button', { name: 'Создать PDF и сохранить в «Файлы»', exact: true }).click();
  await preview.getByRole('button', { name: 'Проверить создание документа', exact: true }).waitFor();
  await preview.getByRole('button', { name: 'Закрыть', exact: true }).click();
  const pendingForm = page.locator('.document-form');
  assert.equal(await pendingForm.getByLabel('К оплате по счёту, ₽', { exact: true }).inputValue(), '1200');
  for (const label of ['К оплате по счёту, ₽', 'Номер документа', 'Дата документа', 'Наша организация', 'Счёт для оплаты', 'Тестовый документ']) assert.equal(await pendingForm.getByLabel(label, { exact: true }).isDisabled(), true, label);
  assert.equal(await pendingForm.getByRole('button', { name: 'Предпросмотр', exact: true }).count(), 0);
  await page.screenshot({ path: path.join(out, 'pending-320.png') });
  await pendingForm.getByRole('button', { name: 'Проверить создание документа', exact: true }).click();
  await page.getByText('PDF сохранён', { exact: true }).waitFor();
  assert.equal(posts.length, 2); assert.equal(posts[0].requestId, posts[1].requestId); assert.deepEqual(posts[0], posts[1]); assert.equal(created, 1);
  assert.equal(posts[0].test, true); assert.equal(posts[0].expectedSourceHash, 'source-hash-1'); assert.equal(posts[0].expectedSellerRevision, seller.revision);
  await page.getByText('Создан из заказа · Счёт №9001-1 · версия 1 · ТЕСТОВЫЙ · НЕ ДЛЯ ОПЛАТЫ', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Изменить клиента', exact: true }).click();
  const editor = page.locator('.record-dialog[open]');
  const original = 'ООО «Учебный клиент»\nИНН: 9900000001\nКПП: 990001001\nНеизвестное поле: сохранить';
  await editor.getByLabel('Исходный текст клиента', { exact: true }).fill(original);
  await editor.getByLabel('ИНН', { exact: true }).fill('9900000000');
  await editor.getByLabel('Наименование', { exact: true }).fill('ООО «Подтверждённый клиент»');
  const extendedOriginal = original + '\nЮридический адрес: г. Учебный, д. 1';
  await editor.getByLabel('Исходный текст клиента', { exact: true }).fill(extendedOriginal);
  assert.equal(await editor.getByLabel('ИНН', { exact: true }).inputValue(), '9900000000');
  assert.equal(await editor.getByLabel('Наименование', { exact: true }).inputValue(), 'ООО «Подтверждённый клиент»');
  await editor.getByRole('button', { name: 'Разобрать исходник заново', exact: true }).click();
  assert.equal(await editor.getByLabel('ИНН', { exact: true }).inputValue(), '9900000001');
  assert.equal(await editor.getByLabel('Наименование', { exact: true }).inputValue(), 'ООО «Учебный клиент»');
  await editor.getByLabel('ИНН', { exact: true }).fill('9900000000');
  await editor.getByLabel('Наименование', { exact: true }).fill('ООО «Подтверждённый клиент»');
  for (const width of [1440, 384, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert(await editor.evaluate(node => node.scrollWidth <= node.clientWidth), 'Client editor overflow at ' + width);
    await page.screenshot({ path: path.join(out, 'requisites-' + width + '.png') });
  }
  await editor.getByRole('button', { name: 'Сохранить изменения', exact: true }).click(); await editor.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.parsedSaved.fields.inn), '9900000000');
  assert.equal(await page.evaluate(() => window.originalSaved), extendedOriginal);
  await page.getByRole('button', { name: 'Изменить клиента', exact: true }).click();
  assert.equal(await editor.getByLabel('ИНН', { exact: true }).inputValue(), '9900000000');
  assert.equal(await editor.getByLabel('Исходный текст клиента', { exact: true }).inputValue(), extendedOriginal);
  assert.equal(await editor.getByLabel('Наименование', { exact: true }).inputValue(), 'ООО «Подтверждённый клиент»');
  await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
  await page.evaluate(() => { window.savedRequisites = ''; });
  await page.getByRole('button', { name: 'Изменить клиента', exact: true }).click();
  const ambiguous = 'ООО «Первый учебный клиент»\nООО «Второй учебный клиент»\nИНН 9900000000\nЮридический адрес: г. Учебный, д. 1';
  await editor.getByLabel('Исходный текст клиента', { exact: true }).fill(ambiguous);
  assert.equal(await editor.getByLabel('Наименование', { exact: true }).inputValue(), '');
  await editor.getByRole('button', { name: 'Сохранить изменения', exact: true }).click(); await editor.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.parsedSaved.issues.some(issue => issue.field === 'name')), true);
  await page.getByRole('button', { name: 'Изменить клиента', exact: true }).click();
  await editor.getByLabel('Наименование', { exact: true }).fill('ООО «Явно выбранный клиент»');
  await editor.getByRole('button', { name: 'Сохранить изменения', exact: true }).click(); await editor.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.parsedSaved.issues.length), 0);
  await page.evaluate(() => { window.savedRequisites = ''; });
  await page.getByRole('button', { name: 'Изменить клиента', exact: true }).click();
  await editor.getByLabel('Исходный текст клиента', { exact: true }).fill('ИП Учебный Иван\nИНН 990000000041\nКПП: не присвоен\nЮридический адрес: г. Учебный, д. 1');
  await editor.getByLabel('КПП', { exact: true }).fill('');
  await editor.getByRole('button', { name: 'Сохранить изменения', exact: true }).click(); await editor.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.parsedSaved.issues.length), 0);
  assert.equal(await page.evaluate(() => window.parsedSaved.fields.kpp), '');
  await page.getByRole('button', { name: 'Изменить клиента', exact: true }).click();
  assert.equal(await editor.getByLabel('КПП', { exact: true }).inputValue(), '');
  await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
  await page.getByRole('button', { name: 'Наши юрлица', exact: true }).click();
  await page.locator('.document-seller-row').filter({ hasText: seller.label }).first().getByRole('button', { name: 'Изменить', exact: true }).click();
  const existingSellerForm = page.locator('.document-seller-form');
  await existingSellerForm.getByLabel('Вставить реквизиты организации', { exact: true }).fill('ООО «Вариант первый»\nООО «Вариант второй»\nИНН 9900000024');
  await existingSellerForm.getByRole('button', { name: 'Распределить по полям', exact: true }).click();
  assert.equal(await existingSellerForm.getByLabel('Наименование', { exact: true }).inputValue(), '');
  assert.equal(await existingSellerForm.getByLabel('ИНН', { exact: true }).inputValue(), '9900000024');
  assert.equal(await existingSellerForm.getByRole('button', { name: 'Сохранить организацию', exact: true }).isDisabled(), true);
  assert.equal(changes.length, 0);
  await page.screenshot({ path: path.join(out, 'seller-unresolved-320.png') });
  await existingSellerForm.getByLabel('Наименование', { exact: true }).fill('ООО «Выбранная организация»');
  await existingSellerForm.getByRole('button', { name: 'Сохранить организацию', exact: true }).click(); await existingSellerForm.waitFor({ state: 'detached' });
  assert.equal(changes[0].seller.name, 'ООО «Выбранная организация»'); assert.deepEqual(changes[0].seller.source.unresolvedFields, []);
  await page.getByRole('button', { name: '+ Добавить организацию', exact: true }).click();
  const sellerForm = page.locator('.document-seller-form');
  await sellerForm.getByLabel('Короткое название', { exact: true }).fill('Учебный черновик');
  await sellerForm.getByLabel('Наименование', { exact: true }).fill('ООО «Учебный черновик»');
  await sellerForm.getByLabel('ИНН', { exact: true }).fill('9900000000');
  await sellerForm.getByLabel('Вставить реквизиты организации', { exact: true }).fill('ИП Учебный Иван\nИНН 990000000041\nКПП: не присвоен');
  await sellerForm.getByRole('button', { name: 'Распределить по полям', exact: true }).click();
  assert.equal(await sellerForm.getByRole('button', { name: 'Сохранить организацию', exact: true }).isDisabled(), true);
  await sellerForm.getByLabel('КПП', { exact: true }).fill('');
  assert.equal(await sellerForm.getByRole('button', { name: 'Сохранить организацию', exact: true }).isDisabled(), false);
  await sellerForm.getByRole('button', { name: 'Сохранить организацию', exact: true }).click();
  await sellerForm.waitFor({ state: 'detached' }); assert.equal(changes.length, 2); assert.equal(changes.at(-1).seller.vat, null); assert.equal(changes.at(-1).seller.accounts.length, 0); assert.equal(changes.at(-1).seller.kpp, ''); assert.deepEqual(changes.at(-1).seller.source.unresolvedFields, []);
  const startStampCase = async (mode, { signatureOnly = false, unbound = false } = {}) => {
    stampScenario = { mode, starts: [], gets: 0, filePosts: [], jobs: new Map() };
    const binding = unbound ? null : { version: 1, stamp: signatureOnly ? null : imageRef(stampTemplate), signature: signatureOnly ? imageRef(signatureTemplate) : null, profile: 'standard', dpi: 150 };
    sellerItems.splice(0, sellerItems.length, { ...seller, accounts: [{ ...account }], source: { documentStamps: binding } });
    const current = await browser.newPage({ viewport: { width: 384, height: 1000 } }); current.on('pageerror', error => errors.push(error.message));
    await current.goto('http://127.0.0.1:' + server.address().port);
    await current.getByRole('button', { name: 'Предпросмотр', exact: true }).waitFor();
    return current;
  };
  const createStampedBase = async current => {
    await current.getByLabel('Тестовый документ', { exact: true }).check();
    await current.getByRole('button', { name: 'Предпросмотр', exact: true }).click();
    const currentPreview = current.locator('.document-dialog[open]');
    assert.equal(await currentPreview.locator('.document-stamp-card').count(), 1);
    await currentPreview.getByRole('button', { name: 'Создать PDF и сохранить в «Файлы»', exact: true }).click();
    await current.getByRole('button', { name: 'Проверить обработку', exact: true }).waitFor();
  };
  const verifyThreeFiles = async current => {
    await current.getByText('Печать и скан сохранены', { exact: true }).waitFor({ timeout: 15000 });
    assert.equal(await current.locator('.media-card').count(), 3);
    const kinds = await current.evaluate(() => window.mediaFiles.map(item => item.generatedDocument.decoration?.kind || 'original').sort());
    assert.deepEqual(kinds, ['original', 'scan', 'stamped']);
    await current.getByText('Скан-эффект', { exact: false }).waitFor();
  };
  let beforeBase = posts.length;
  let stampPage = await startStampCase('engine503');
  assert.equal(await stampPage.getByLabel('Нанести печать/подпись и сделать скан', { exact: true }).isChecked(), true);
  await createStampedBase(stampPage);
  assert.equal(stampScenario.starts.length, 1); assert.equal(posts.length, beforeBase + 1);
  assert.equal(stampScenario.jobs.size, 1); assert.equal([...stampScenario.jobs.values()][0].prepared, true);
  const originalStampRequest = stampScenario.starts[0].requestId;
  assert.equal(await stampPage.getByLabel('К оплате по счёту, ₽', { exact: true }).isDisabled(), true);
  await stampPage.screenshot({ path: path.join(out, 'stamp-engine-unavailable-384.png') });
  await stampPage.getByRole('button', { name: 'Проверить обработку', exact: true }).click();
  await verifyThreeFiles(stampPage);
  assert.equal(stampScenario.starts.length, 2); assert.deepEqual(stampScenario.starts[1], stampScenario.starts[0]); assert.equal(stampScenario.starts[1].requestId, originalStampRequest); assert.equal(stampScenario.jobs.size, 1); assert.equal(posts.length, beforeBase + 1);
  await stampPage.screenshot({ path: path.join(out, 'original-stamped-scan-384.png') }); await stampPage.close();

  beforeBase = posts.length; stampPage = await startStampCase('prepared-poll'); await createStampedBase(stampPage);
  await stampPage.getByRole('button', { name: 'Повторить обработку', exact: true }).waitFor();
  const stoppedGets = stampScenario.gets;
  await new Promise(resolve => setTimeout(resolve, 2200));
  assert.equal(stampScenario.gets, stoppedGets); assert.equal(stampScenario.starts.length, 1); assert.equal(posts.length, beforeBase + 1);
  await stampPage.reload(); await stampPage.getByRole('button', { name: 'Повторить обработку', exact: true }).waitFor();
  assert.equal(stampScenario.gets, stoppedGets); assert.equal(stampScenario.starts.length, 1);
  await stampPage.screenshot({ path: path.join(out, 'stamp-prepared-retry-384.png') });
  await stampPage.getByRole('button', { name: 'Повторить обработку', exact: true }).click();
  await verifyThreeFiles(stampPage);
  assert.equal(stampScenario.starts.length, 2); assert.deepEqual(stampScenario.starts[1], stampScenario.starts[0]); assert.equal(posts.length, beforeBase + 1); await stampPage.close();

  beforeBase = posts.length; stampPage = await startStampCase('timeout', { signatureOnly: true });
  assert.equal(await stampPage.locator('.document-stamp-card img').getAttribute('src'), '/tools/stamp/api/signatures/' + signatureTemplate.id + '/image');
  await createStampedBase(stampPage);
  assert.equal(stampScenario.starts.length, 1); const recoveredRequest = stampScenario.starts[0].requestId;
  await stampPage.reload(); await stampPage.getByRole('button', { name: 'Проверить обработку', exact: true }).waitFor();
  assert.equal(stampScenario.starts.length, 1); assert.equal(posts.length, beforeBase + 1);
  assert.equal(await stampPage.getByLabel('К оплате по счёту, ₽', { exact: true }).inputValue(), '1200');
  await stampPage.getByRole('button', { name: 'Проверить обработку', exact: true }).click();
  for (let attempt = 0; stampScenario.filePosts.length < 1 && attempt < 150; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(stampScenario.filePosts.length, 1);
  await stampPage.getByRole('button', { name: 'Проверить обработку', exact: true }).waitFor();
  await stampPage.getByRole('button', { name: 'Проверить обработку', exact: true }).click();
  await verifyThreeFiles(stampPage);
  assert.equal(stampScenario.starts.length, 1); assert.equal(stampScenario.filePosts.length, 2); assert.equal(stampScenario.filePosts[0].requestId, recoveredRequest); assert.equal(stampScenario.filePosts[1].requestId, recoveredRequest); assert.equal(posts.length, beforeBase + 1);
  await stampPage.close();

  beforeBase = posts.length; stampPage = await startStampCase('stale'); await createStampedBase(stampPage);
  await stampPage.getByRole('button', { name: 'Оставить исходный PDF', exact: true }).waitFor();
  assert.equal(posts.length, beforeBase + 1); assert.equal(stampScenario.filePosts.length, 0); assert.equal(await stampPage.evaluate(() => window.mediaFiles.length), 1);
  await stampPage.getByRole('button', { name: 'Оставить исходный PDF', exact: true }).click();
  await stampPage.getByRole('button', { name: 'Предпросмотр', exact: true }).waitFor(); assert.equal(posts.length, beforeBase + 1); await stampPage.close();

  beforeBase = posts.length; stampPage = await startStampCase('library-unavailable');
  await stampPage.getByRole('button', { name: 'Предпросмотр', exact: true }).click(); assert.equal(posts.length, beforeBase);
  await stampPage.getByText('Учебная библиотека временно недоступна', { exact: false }).first().waitFor();
  await stampPage.getByLabel('Нанести печать/подпись и сделать скан', { exact: true }).uncheck();
  await stampPage.getByRole('button', { name: 'Предпросмотр', exact: true }).click();
  await stampPage.locator('.document-dialog[open]').getByRole('button', { name: 'Создать PDF и сохранить в «Файлы»', exact: true }).click();
  await stampPage.getByText('PDF сохранён', { exact: true }).waitFor(); assert.equal(posts.length, beforeBase + 1); assert.equal(stampScenario.starts.length, 0); await stampPage.close();

  stampPage = await startStampCase('success', { unbound: true });
  await stampPage.getByRole('button', { name: 'Наши юрлица', exact: true }).last().click();
  await stampPage.getByRole('button', { name: '+ Добавить организацию', exact: true }).click();
  const imageSeller = stampPage.locator('.document-seller-form');
  await imageSeller.getByLabel('Короткое название', { exact: true }).fill('Учебное юрлицо с подписью');
  await imageSeller.getByLabel('Наименование', { exact: true }).fill('ООО «Учебное юрлицо»');
  await imageSeller.getByLabel('ИНН', { exact: true }).fill('9900000000');
  await imageSeller.getByLabel('Подпись для документов', { exact: true }).waitFor();
  assert.equal(await imageSeller.getByLabel('Подпись для документов', { exact: true }).inputValue(), '');
  assert.equal(await imageSeller.getByLabel('Печать организации', { exact: true }).inputValue(), '');
  assert.equal(await imageSeller.getByLabel('Печать организации', { exact: true }).locator('option[value="' + otherStamp.id + '"]').evaluate(node => node.disabled), true);
  await imageSeller.getByLabel('Подпись для документов', { exact: true }).selectOption(signatureTemplate.id);
  await imageSeller.getByLabel('Качество скана', { exact: true }).selectOption('200');
  await stampPage.screenshot({ path: path.join(out, 'seller-signature-binding-384.png') });
  await imageSeller.getByRole('button', { name: 'Сохранить организацию', exact: true }).click(); await imageSeller.waitFor({ state: 'detached' });
  assert.equal(changes.at(-1).seller.source.documentStamps.stamp, null); assert.deepEqual(changes.at(-1).seller.source.documentStamps.signature, imageRef(signatureTemplate)); assert.equal(changes.at(-1).seller.source.documentStamps.dpi, 200);
  await stampPage.close(); stampScenario = null;
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ ok: true, widths: [1440, 384, 320], checks: ['nullable VAT blocks creation', 'safe preview', 'uncertain preview close freezes original payload and exposes only verification', 'same request after uncertain save', 'PDF appears in order Files with version/test metadata', 'manual INN/name survive source edits; explicit reparse may replace them', 'source ambiguity survives canonical save until explicit choice', 'seller import clears ambiguous old name and blocks save until manual resolution', 'explicit blank optional KPP resolves source issue for both client and seller', 'client and document responsive widths', 'draft seller without account/VAT', 'reserved prepared request after engine 503 retries same stamp payload without base replay', 'polled prepared stops polling, survives reload and starts only on explicit same-request retry', 'start and files response loss recover after reload without duplicate files', 'seller binding changed preserves base and stops decoration', 'library unavailable allows explicit base-only output', 'single signature without stamp supported', 'signature never chosen automatically and wrong-INN stamp disabled', 'original plus stamped and scan files preserved'], createdBaseDocuments: created, browserErrors: errors }, null, 2));
  console.log('Order documents UI checks passed (isolated mock API, fictional data).');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
