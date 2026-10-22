import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBoard, moveOrder, editRecord, createInstallation, prepareFinancialEdit, archiveOrder, OrderError } from './orders.mjs';
import { editFinancialRecord } from './finance-bridge.mjs';
import { orderCreationForm, createOrder } from './creation.mjs';
import { positionCreationForm, createPosition, deletePosition } from './positions.mjs';
import { clientCreationForm, createClient } from './clients.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = '/kanban';
const assets = new Map([
  [`${base}/`, ['index.html', 'text/html; charset=utf-8']],
  [`${base}/index.html`, ['index.html', 'text/html; charset=utf-8']],
  [`${base}/app.js`, ['app.js', 'text/javascript; charset=utf-8']],
  [`${base}/workspace.js`, ['workspace.js', 'text/javascript; charset=utf-8']],
  [`${base}/board-model.js`, ['board-model.js', 'text/javascript; charset=utf-8']],
  [`${base}/styles.css`, ['styles.css', 'text/css; charset=utf-8']],
  [`${base}/mail-import.html`, ['mail-import.html', 'text/html; charset=utf-8']],
  [`${base}/mail-import.js`, ['mail-import.js', 'text/javascript; charset=utf-8']],
  [`${base}/mail-import.css`, ['mail-import.css', 'text/css; charset=utf-8']],
  [`${base}/favicon.svg`, ['favicon.svg', 'image/svg+xml']],
]);
for(const name of ['order-configurator','order-config-model','client-search','documents','requisites'])assets.set(`${base}/${name}.js`,[`${name}.js`,'text/javascript; charset=utf-8']);
for(const name of ['order-configurator','client-search'])assets.set(`${base}/${name}.css`,[`${name}.css`,'text/css; charset=utf-8']);
for(const name of ['letters','box','neon','print','plotter','banner','plaque','rack','logo'])assets.set(`${base}/configurator-assets/${name}.webp`,[`configurator-assets/${name}.webp`,'image/webp']);
assets.set(`${base}/configurator-assets/custom.svg`,['configurator-assets/custom.svg','image/svg+xml']);
const headers = {
  'Cache-Control': 'no-store, private',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

function json(res, status, value, extra = {}) {
  if (status >= 400 && res.getHeader('X-Request-Id')) value = { ...value, requestId: res.getHeader('X-Request-Id') };
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(value));
}

async function readJson(req, limit = 65_536) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    throw Object.assign(new Error('Ожидается JSON'), { statusCode: 415, name: 'RequestError' });
  }
  let size = 0;
  const parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw Object.assign(new Error('Слишком большой запрос'), { statusCode: 413, name: 'RequestError' });
    parts.push(part);
  }
  try {
    const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch { throw Object.assign(new Error('Некорректный запрос'), { statusCode: 400, name: 'RequestError' }); }
}

async function readFileBody(req, limit = 12 * 1024 * 1024) {
  if (Number(req.headers['content-length']) > limit) throw Object.assign(new Error(`Файл больше ${Math.floor(limit / 1024 / 1024)} МБ.`), { name: 'RequestError', statusCode: 413 });
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw Object.assign(new Error(`Файл больше ${Math.floor(limit / 1024 / 1024)} МБ.`), { name: 'RequestError', statusCode: 413 });
    parts.push(part);
  }
  return Buffer.concat(parts);
}

function routeId(value) {
  let id;
  try { id = decodeURIComponent(value); } catch { /* invalid URL escape */ }
  if (!id || id.length > 200 || /[\u0000-\u001f\u007f]/u.test(id)) {
    throw Object.assign(new Error('Некорректный идентификатор.'), { name: 'RequestError', statusCode: 400 });
  }
  return id;
}

export function createRequestHandler({
  client,
  origin = process.env.PUBLIC_ORIGIN || 'https://vm-app.ru',
  authUrl = process.env.AUTH_URL || 'http://127.0.0.1:18100/api/session',
  authOrigin = process.env.AUTH_ORIGIN || 'https://vm-app.ru',
  fetchImpl = fetch,
  authImpl,
  editFinancialRecordImpl = editFinancialRecord,
  invalidateGeneration = () => 0,
  readBoardImpl = readBoard,
  moveOrderImpl = moveOrder,
  editRecordImpl = editRecord,
  createInstallationImpl = createInstallation,
  prepareFinancialEditImpl = prepareFinancialEdit,
  archiveOrderImpl = archiveOrder,
  orderCreationFormImpl = orderCreationForm,
  createOrderImpl = createOrder,
  creationDirectory = process.env.ORDER_CREATE_DIR || path.join(root, 'work', 'creation'),
  clientCreationFormImpl = clientCreationForm,
  createClientImpl = createClient,
  clientCreationDirectory = process.env.CLIENT_CREATE_DIR || path.join(root, 'work', 'client-creation'),
  positionCreationFormImpl = positionCreationForm,
  createPositionImpl = createPosition,
  deletePositionImpl = deletePosition,
  positionCreationDirectory = process.env.POSITION_CREATE_DIR || path.join(root, 'work', 'position-creation'),
  orderCatalog,
  mediaStore,
  documentsService,
  documentStampsService,
  documentStampCommand = action => action(),
  mailService,
  version = process.env.APP_VERSION || 'dev',
  onAudit = (entry) => console.info(JSON.stringify(entry)),
} = {}) {
  let snapshot;
  let snapshotAt = 0;
  let loading;
  let writes = Promise.resolve();
  let generation = 0;
  let externalGeneration = invalidateGeneration();

  function mediaResponse(orderId, value) {
    return { ...value, items: value.items.map(item => {
      const url = `${base}/api/orders/${encodeURIComponent(orderId)}/media/${encodeURIComponent(item.id)}`;
      return { ...item, url, downloadUrl: `${url}?download=1` };
    }) };
  }

  async function decorateBoard(value) {
    if (!mediaStore) return value;
    const orders = await Promise.all(value.orders.map(async order => ({
      ...order, media: mediaResponse(order.id, await mediaStore.list(order.id)),
    })));
    return { ...value, orders };
  }

  function mutate(action) {
    const pending = writes.then(async () => {
      generation++;
      snapshot = null;
      snapshotAt = 0;
      loading = null;
      try { return await action(); } finally { generation++; }
    });
    writes = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async function board({ fresh = false } = {}) {
    if (externalGeneration !== invalidateGeneration()) {
      externalGeneration = invalidateGeneration();
      generation++; snapshot = null; loading = null; snapshotAt = 0;
    }
    if (!fresh && snapshot && Date.now() - snapshotAt < 12_000) return snapshot;
    if (loading && !fresh) return loading;
    const before = generation;
    const promise = readBoardImpl(client).then(decorateBoard).then((value) => {
      if (before === generation) { snapshot = value; snapshotAt = Date.now(); }
      return value;
    });
    loading = promise;
    try { return await promise; } finally { if (loading === promise) loading = null; }
  }

  async function auth(req, method = 'GET', input) {
    if (authImpl) return authImpl(req, method, input);
    const forwarded = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const response = await fetchImpl(authUrl, {
      method,
      headers: {
        Cookie: req.headers.cookie || '',
        // Fetch owns Host. Use the internal target for the finance Origin check.
        Origin: new URL(authUrl).origin,
        'X-Forwarded-For': forwarded,
        ...(input ? { 'Content-Type': 'application/json' } : {}),
      },
      body: input ? JSON.stringify(input) : undefined,
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
    });
    const value = await response.json();
    return { response, value };
  }

  return async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === `${base}/api/health`) {
        return json(res, 200, { status: client?.configured ? 'ok' : 'unconfigured', version });
      }
      if (url.pathname === base && ['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(308, { ...headers, Location: `${base}/` }); return res.end();
      }
      if (!['GET', 'HEAD'].includes(req.method)) {
        if (req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') {
          return json(res, 403, { error: 'Недопустимый источник запроса' });
        }
      }
      if (url.pathname === `${base}/api/session` && ['GET', 'POST', 'DELETE'].includes(req.method)) {
        const input = req.method === 'POST' ? await readJson(req) : undefined;
        if (input && (typeof input.pin !== 'string' || input.pin.length > 256 || !input.pin.length)) {
          return json(res, 400, { error: 'Введите PIN' });
        }
        let result;
        try { result = await auth(req, req.method, input ? { pin: input.pin } : undefined); }
        catch { return json(res, 503, { error: 'Сервис входа временно недоступен. Попробуйте ещё раз.' }); }
        const { response, value } = result;
        const cookie = response.headers.get('set-cookie');
        const code = [200, 400, 401, 429].includes(response.status) ? response.status : 503;
        return json(res, code, code === 200 ? { authenticated: value.authenticated === true } : {
          error: code === 429 ? 'Слишком много попыток. Попробуйте позже.' : code === 401 ? 'Неверный PIN' : 'Не удалось войти',
        }, cookie && [200, 401].includes(code) ? { 'Set-Cookie': cookie } : {});
      }
      if (url.pathname.startsWith(`${base}/api/`)) {
        let authenticated = false;
        try {
          const { response, value } = await auth(req);
          if (!response.ok) throw new Error();
          authenticated = value.authenticated === true;
        } catch { return json(res, 503, { error: 'Не удалось проверить вход. Повторите попытку.' }); }
        if (!authenticated) return json(res, 401, { error: 'Требуется вход' });
        if (url.pathname === `${base}/api/mail/queue` && req.method === 'GET' && mailService) {
          await writes;
          return json(res, 200, { ...mailService.queue(), orders: (await board()).orders.map(({ id, title, client }) => ({ id, title, client })) });
        }
        if (url.pathname === `${base}/api/mail/resolve` && req.method === 'POST' && mailService) {
          const input = await readJson(req);
          return json(res, 200, await mailService.resolve(input));
        }
        if (url.pathname === `${base}/api/board` && req.method === 'GET') {
          await writes;
          return json(res, 200, await board({ fresh: url.searchParams.get('fresh') === '1' }));
        }
        if (url.pathname === `${base}/api/document-sellers` && documentsService) {
          if(req.method==='GET') {await writes;return json(res,200,await documentsService.sellers({includeArchived:url.searchParams.get('includeArchived')==='1'}));}
          if(req.method==='POST') {const input=await readJson(req);return json(res,200,await mutate(()=>documentsService.saveSeller(input)));}
        }
        if(url.pathname===`${base}/api/document-stamp-library`&&req.method==='GET'&&documentStampsService)return json(res,200,await documentStampsService.library(req.headers.cookie));
        const stampMatch=url.pathname.match(/^\/kanban\/api\/orders\/([^/]+)\/documents\/([a-f0-9-]{36})\/stamps(?:\/([a-f0-9-]{36})(?:\/(files))?)?$/i);
        if(stampMatch&&documentStampsService) {
          const id=routeId(stampMatch[1]),documentId=stampMatch[2],requestId=stampMatch[3],cookie=req.headers.cookie;
          if(req.method==='POST'&&!requestId) {
            const input=await readJson(req);
            // Rendering and downloads never occupy the shared Google writer.
            const library=await documentStampsService.library(cookie);
            await documentStampCommand(()=>mutate(()=>documentStampsService.reserve(id,documentId,input,library)));
            return json(res,200,await documentStampsService.start(id,documentId,input.requestId,cookie));
          }
          if(req.method==='GET'&&requestId&&!stampMatch[4])return json(res,200,await documentStampsService.status(id,documentId,requestId,cookie));
          if(req.method==='POST'&&requestId&&stampMatch[4]) {
            const input=await readJson(req);if(!input||Object.keys(input).length)return json(res,400,{code:'DOCUMENT_STAMP_REQUEST',error:'Проверьте запрос сохранения файлов.'});
            const prepared=await documentStampsService.download(id,documentId,requestId,cookie);
            const result=await documentStampCommand(()=>mutate(()=>documentStampsService.publish(id,documentId,prepared)));
            return json(res,200,{...result,media:mediaResponse(id,result.media)});
          }
        }
        const documentMatch=url.pathname.match(/^\/kanban\/api\/orders\/([^/]+)\/documents(?:\/(prepare))?$/);
        if(documentMatch&&documentsService) {
          const id=routeId(documentMatch[1]);
          if(req.method==='GET'&&documentMatch[2]) {await writes;return json(res,200,await documentsService.prepare(id));}
          if(req.method==='POST'&&!documentMatch[2]) {
            const input=await readJson(req);
            return json(res,200,await mutate(async()=>{
              const result=await documentsService.create(id,input);
              const media=mediaResponse(id,{items:[result.media]}).items[0];
              onAudit({event:'order_document_created',at:new Date().toISOString()});
              return {...result,media};
            }));
          }
        }
        if(url.pathname===`${base}/api/configurator` && orderCatalog){
          if(req.method==='GET'){await writes;return json(res,200,await orderCatalog());}
          if(req.method==='POST'){const input=await readJson(req);return json(res,200,await mutate(()=>orderCatalog(input)));}
        }
        if (url.pathname === `${base}/api/orders/new` && req.method === 'GET') {
          await writes;
          return json(res, 200, await orderCreationFormImpl(client));
        }
        if (url.pathname === `${base}/api/clients/new` && req.method === 'GET') {
          await writes;
          return json(res, 200, await clientCreationFormImpl(client));
        }
        if (url.pathname === `${base}/api/clients` && req.method === 'POST') {
          const input = await readJson(req);
          if (typeof input.requestId !== 'string' || input.requestId.length !== 36 ||
              !input.changes || typeof input.changes !== 'object' || Array.isArray(input.changes) ||
              Object.keys(input).some(key => !['requestId', 'changes'].includes(key))) {
            return json(res, 400, { error: 'Проверьте поля нового клиента.' });
          }
          return json(res, 200, await mutate(async () => {
            const created = await createClientImpl(client, input, { journalDir: clientCreationDirectory });
            onAudit({ event: created.changed === false ? 'client_selected' : 'client_created', id: created.id, at: new Date().toISOString() });
            return { id: created.id, name: created.name, created: created.changed !== false };
          }));
        }
        if (url.pathname === `${base}/api/orders` && req.method === 'POST') {
          const input = await readJson(req);
          if (typeof input.requestId !== 'string' || input.requestId.length !== 36 ||
              !input.changes || typeof input.changes !== 'object' || Array.isArray(input.changes) ||
              Object.keys(input).some(key => !['requestId', 'changes'].includes(key))) {
            return json(res, 400, { error: 'Проверьте поля нового заказа.' });
          }
          return json(res, 200, await mutate(async () => {
            const created = await createOrderImpl(client, input, { journalDir: creationDirectory });
            onAudit({ event: 'order_created', id: created.id, at: new Date().toISOString() });
            try { return { ...await board({ fresh: true }), createdOrderId: String(created.id) }; }
            catch { throw new OrderError('ORDER_CREATE_UNCONFIRMED', 'Заказ записан, но доска пока не обновилась. Нажмите «Проверить создание», чтобы получить тот же заказ.', 409); }
          }));
        }
        const positionFormMatch = url.pathname.match(/^\/kanban\/api\/orders\/([^/]+)\/positions\/new$/);
        if (positionFormMatch && req.method === 'GET') {
          await writes;
          const id = routeId(positionFormMatch[1]);
          return json(res, 200, await positionCreationFormImpl(client, { orderId: id }));
        }
        const positionCreateMatch = url.pathname.match(/^\/kanban\/api\/orders\/([^/]+)\/positions$/);
        if (positionCreateMatch && req.method === 'DELETE') {
          const id=routeId(positionCreateMatch[1]),input=await readJson(req);
          if(!input.record||typeof input.record!=='object'||Array.isArray(input.record)||typeof input.requestId!=='string'||Object.keys(input).some(key=>!['requestId','record'].includes(key)))return json(res,400,{error:'Проверьте удаляемую позицию.'});
          return json(res,200,await mutate(async()=>{
            const removed=await deletePositionImpl(client,{requestId:input.requestId,orderId:id,record:input.record},{journalDir:positionCreationDirectory});
            onAudit({event:'order_position_deleted',id,at:new Date().toISOString()});
            try{return {...await board({fresh:true}),deletedPosition:removed};}
            catch{throw new OrderError('POSITION_DELETE_UNCONFIRMED','Позиция удалена, но доска пока не обновилась. Нажмите «Проверить удаление».',409);}
          }));
        }
        if (positionCreateMatch && req.method === 'POST') {
          const id = routeId(positionCreateMatch[1]);
          const input = await readJson(req);
          if (typeof input.requestId !== 'string' || input.requestId.length !== 36 ||
              !input.position || typeof input.position !== 'object' || Array.isArray(input.position) ||
              Object.keys(input).some(key => !['requestId', 'position'].includes(key))) {
            return json(res, 400, { error: 'Проверьте поля новой позиции.' });
          }
          return json(res, 200, await mutate(async () => {
            const created = await createPositionImpl(client, { requestId: input.requestId, orderId: id, position: input.position }, { journalDir: positionCreationDirectory });
            onAudit({ event: 'order_position_created', id, product: created.product, routeStageCount: created.routeStageCount, at: new Date().toISOString() });
            try { return { ...await board({ fresh: true }), createdPosition: created }; }
            catch { throw new OrderError('POSITION_CREATE_UNCONFIRMED', 'Позиция записана, но доска пока не обновилась. Нажмите «Проверить добавление», чтобы получить тот же результат.', 409); }
          }));
        }
        const recordMatch = url.pathname.match(/^\/kanban\/api\/records\/(order|item|contact|production|payment|expense|installation)$/);
        if (recordMatch && req.method === 'PATCH') {
          const input = await readJson(req);
          if (!input.record || !input.changes || typeof input.changes !== 'object' || Array.isArray(input.changes)) {
            return json(res, 400, { error: 'Проверьте изменённые поля.' });
          }
          return json(res, 200, await mutate(async () => {
            const edit = { type: recordMatch[1], record: input.record, changes: input.changes };
            if (['payment', 'expense'].includes(edit.type)) {
              const prepared = await prepareFinancialEditImpl(client, edit);
              await editFinancialRecordImpl(prepared, { authUrl, authOrigin, cookie: req.headers.cookie || '', fetchImpl });
            } else await editRecordImpl(client, edit);
            onAudit({ event: 'order_record_edited', type: recordMatch[1], at: new Date().toISOString() });
            return board({ fresh: true });
          }));
        }
        const installationMatch = url.pathname.match(/^\/kanban\/api\/orders\/([^/]+)\/installations$/);
        if (installationMatch && req.method === 'POST') {
          const id = routeId(installationMatch[1]);
          const input = await readJson(req);
          return json(res, 200, await mutate(async () => {
            await createInstallationImpl(client, { orderId: id, changes: input.changes });
            onAudit({ event: 'installation_created', id, at: new Date().toISOString() });
            return board({ fresh: true });
          }));
        }
        const archiveMatch = url.pathname.match(/^\/kanban\/api\/orders\/([^/]+)\/archive$/);
        if (archiveMatch && req.method === 'POST') {
          const id = routeId(archiveMatch[1]);
          const input = await readJson(req);
          if (typeof input.expectedStatus !== 'string' || input.expectedStatus.length > 160 || !Array.isArray(input.installations) || input.installations.length > 1000) {
            return json(res, 400, { error: 'Передайте текущий статус заказа и список его монтажей.' });
          }
          return json(res, 200, await mutate(async () => {
            const result = await archiveOrderImpl(client, { orderId: id, expectedStatus: input.expectedStatus, installations: input.installations });
            onAudit({ event: 'order_archived', id, completedInstallations: result?.completedInstallations, at: new Date().toISOString() });
            return board({ fresh: true });
          }));
        }
        const mediaMatch = url.pathname.match(/^\/kanban\/api\/orders\/([^/]+)\/media(?:\/([^/]+))?$/);
        if (mediaMatch && mediaStore) {
          const id = routeId(mediaMatch[1]);
          const mediaId = mediaMatch[2] ? routeId(mediaMatch[2]) : null;
          await writes;
          const exists = (await board()).orders.some(order => order.id === id);
          if (!exists) return json(res, 404, { error: 'Заказ не найден.' });
          if (!mediaId && req.method === 'GET') return json(res, 200, mediaResponse(id, await mediaStore.list(id)));
          if (mediaId && ['GET', 'HEAD'].includes(req.method)) {
            const { bytes, media } = await mediaStore.read(id, mediaId);
            const disposition = media.kind === 'image' && url.searchParams.get('download') !== '1' ? 'inline' : 'attachment';
            const filename = encodeURIComponent(media.name).replaceAll("'", '%27');
            res.writeHead(200, { ...headers, 'Content-Type': media.contentType,
              'Content-Length': bytes.length,
              'Content-Disposition': `${disposition}; filename="attachment"; filename*=UTF-8''${filename}`,
              'Content-Security-Policy': "default-src 'none'; sandbox",
            });
            return res.end(req.method === 'HEAD' ? undefined : bytes);
          }
          if (!mediaId && req.method === 'POST') {
            let name;
            try { name = decodeURIComponent(req.headers['x-file-name'] || ''); }
            catch { return json(res, 400, { error: 'Некорректное имя файла.' }); }
            const bytes = await readFileBody(req, mediaStore.maxFileBytes);
            return json(res, 201, await mutate(async () => {
              await mediaStore.add(id, { name, contentType: req.headers['content-type'] || '', bytes });
              onAudit({ event: 'order_media_uploaded', id, size: bytes.length, at: new Date().toISOString() });
              return mediaResponse(id, await mediaStore.list(id));
            }));
          }
          if (mediaId && req.method === 'PATCH') {
            const input = await readJson(req);
            if (input.cover !== true) return json(res, 400, { error: 'Выберите изображение для обложки.' });
            return json(res, 200, await mutate(async () => mediaResponse(id, await mediaStore.setCover(id, mediaId))));
          }
          if (mediaId && req.method === 'DELETE') {
            return json(res, 200, await mutate(async () => mediaResponse(id, await mediaStore.remove(id, mediaId))));
          }
        }
        const match = url.pathname.match(/^\/kanban\/api\/orders\/([^/]+)\/status$/);
        if (match && req.method === 'PATCH') {
          const input = await readJson(req);
          if (typeof input.status !== 'string' || typeof input.expectedStatus !== 'string' || input.status.length > 160 || input.expectedStatus.length > 160) {
            return json(res, 400, { error: 'Проверьте статус заказа' });
          }
          const id = routeId(match[1]);
          const action = mutate(async () => {
              await moveOrderImpl(client, { id, status: input.status, expectedStatus: input.expectedStatus });
              onAudit({ event: 'order_status_changed', id, from: input.expectedStatus, to: input.status, at: new Date().toISOString() });
              return await board({ fresh: true });
          });
          return json(res, 200, await action);
        }
        return json(res, 404, { error: 'Страница не найдена' });
      }
      const asset = assets.get(url.pathname);
      if (asset && ['GET', 'HEAD'].includes(req.method)) {
        let data = await fs.readFile(path.join(root, 'public', asset[0]));
        if (asset[0] === 'index.html') data = Buffer.from(data.toString('utf8').replaceAll('?v=1', `?v=${encodeURIComponent(version)}`));
        res.writeHead(200, { ...headers, 'Content-Type': asset[1], 'Content-Length': data.length });
        return res.end(req.method === 'HEAD' ? undefined : data);
      }
      return json(res, 404, { error: 'Страница не найдена' });
    } catch (error) {
      const candidate = error.statusCode ?? error.status;
      const status = Number.isInteger(candidate) && candidate >= 400 && candidate < 600 ? candidate : 502;
      const safe = ['OrdersError', 'OrderError', 'SheetsError', 'FinanceError', 'RequestError', 'MediaError'].includes(error.name);
      return json(res, status, {
        error: safe ? error.message : 'Не удалось получить данные Google-таблицы. Обновите доску и повторите попытку.',
        ...(safe && /^[a-z0-9_]{1,64}$/i.test(error.code || '') ? { code: error.code } : {}),
      });
    }
  };
}

export function createAppServer(options) { return http.createServer(createRequestHandler(options)); }

if (process.argv[1] && await fs.realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  throw new Error('Orders is a workshop module. Start the common server with npm start at the repository root.');
}
