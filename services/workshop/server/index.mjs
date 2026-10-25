import Database from 'better-sqlite3';
import { SalesDesk } from './sales-desk.mjs';
import { SalesSources } from './sales-sources.mjs';
import { salesHandler, salesStatic } from './sales-routes.mjs';
import fs from 'node:fs';
import { validTransaction } from './finance-input.mjs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSession,
  deleteSession,
  hasSession,
  openDatabase,
} from './db.mjs';
import { GoogleSheetsClient } from './google-sheets.mjs';
import { installSheetsGuard } from './sheets-guard.mjs';
import { parseCookies, sessionToken, tokenHash, verifyPin } from './auth.mjs';
import { readExpenseCategories } from './expense-categories.mjs';
import { ProductionError, readProduction, setProductionCompletion } from './production.mjs';
import { readOrders } from './orders.mjs';
import { FinanceSheetStore, FinanceError } from './finance-sheet.mjs';
import { CommandQueue } from './command-queue.mjs';
import { Diagnostics, routeLabel } from './diagnostics.mjs';
import { AvitoClient, avitoApi, isAvitoReadAction } from './avito.mjs';
import { AvitoAnalytics } from './analytics/avito.mjs';
import { AvitoDeepAnalytics } from './analytics/avito-deep.mjs';
import { AnalyticsService } from './analytics/service.mjs';
import { LiveAnalytics } from './analytics/live.mjs';
import { InquiryImport } from './analytics/inquiry-import.mjs';
import { InquiryService } from './analytics/inquiry-service.mjs';
import { NightlyAttribution } from './analytics/nightly-attribution.mjs';
import { ResponseTimes } from './analytics/response-times.mjs';
import { ResearchMaterials } from './analytics/research-materials.mjs';
import { AutoServices } from './analytics/auto-services.mjs';
import { analyticsCatalog } from './analytics/categories.mjs';
import { createRequestHandler } from '../modules/orders/server/index.mjs';
import { MediaStore } from '../modules/orders/server/media.mjs';
import { OrderDocuments } from '../modules/orders/server/documents.mjs';
import { DocumentStamps } from '../modules/orders/server/document-stamps.mjs';
import { createPosition, positionCreationForm, deletePosition } from '../modules/orders/server/positions.mjs';
import { createProductionPilot } from './production-pilot.mjs';
import { MailImapSource } from '../modules/orders/server/mail-imap.mjs';
import { MailWorker } from '../modules/orders/server/mail-worker.mjs';
import { readBoard } from '../modules/orders/server/orders.mjs';
import { MaxBot } from './max-bot.mjs';
import { MaxAssistant } from './max-assistant.mjs';
import { MaxOrderNotes } from './max-order-notes.mjs';
import { MaxNotifications } from './max-notifications.mjs';
import { MaxRetouch } from './max-retouch.mjs';
import { WarehouseError, createWarehouseItem, readWarehouse, refillWarehouseItem, updateWarehouseItem, installWarehouseReceipts, verifyPendingRefills } from './warehouse.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.resolve(root, 'dist/client');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const databaseFile = path.join(dataDir, 'finance.sqlite3');
const db = openDatabase(databaseFile);
if (db.prepare('SELECT count(*) AS n FROM transactions WHERE pending=1').get().n) {
  throw new Error('CUTOVER_BLOCKED: finance queue must be drained before starting the direct Google writer');
}

const sheets = new GoogleSheetsClient({
  credentialsFile: process.env.GOOGLE_CREDENTIALS_FILE || '',
  spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID || 'EXAMPLE_PRODUCTION_GOOGLE_SHEET_ID_CHANGE_BEFORE_USE',
});
const sheetsContract = installSheetsGuard(sheets);
const finance = new FinanceSheetStore({ db, client: sheets });
const warehouseReceipts = installWarehouseReceipts(sheets, db);
const commands = new CommandQueue();
const diagnostics = new Diagnostics(db);
const avito = new AvitoClient({ db });
const avitoAnalytics = new AvitoAnalytics({ client: avito, directory: dataDir });
const avitoDeep = new AvitoDeepAnalytics({ client: avito, base: avitoAnalytics });
const nightlyEnabled = process.env.AVITO_NIGHTLY_ATTRIBUTION === 'true' && avito.status().enabled;
const inquiryImport = new InquiryImport({ client: avito, base: avitoAnalytics, ...(nightlyEnabled ? {automatic:false} : {}) });
const moduleChecks = {};
const ordersData = path.join(dataDir, 'orders');
const mediaStore = new MediaStore({ directory: path.join(ordersData, 'media'), maxTotalBytes: 2 * 1024 * 1024 * 1024 });
await mediaStore.init();
await mediaStore.backfillCdrPreviews();
const ordersClient = {
  get configured() { return sheets.configured; },
  request: sheets.request.bind(sheets), getSpreadsheet: sheets.getSpreadsheet.bind(sheets),
  getValues: sheets.getValues.bind(sheets), getRanges: sheets.getRanges.bind(sheets),
  updateValues: data => sheets.updateValues(data, { valueInputOption: 'RAW' }),
  appendValues: sheets.appendValues.bind(sheets), batchUpdate: sheets.batchUpdate.bind(sheets),
};
const maxBot = new MaxBot({ db, readBoard: () => commands.read('max-orders', () => readBoard(ordersClient)) });
const maxNotes = new MaxOrderNotes({ db, client: ordersClient, readBoard: () => readBoard(ordersClient), run: action => commands.run(action,'max-order-note') });
maxBot.notes = maxNotes;
const maxAssistant = new MaxAssistant({ db, settings: () => maxBot.settings(), readBoard: maxBot.readBoard, notes:maxNotes, send: (...args) => maxBot.send(...args) });
maxBot.assistant = maxAssistant;
maxAssistant.start();
const maxNotifications = new MaxNotifications({ db, settings: () => maxBot.settings(),
  send: (...args) => maxBot.send(...args), balance: () => avito.balance() });
const maxRetouch = new MaxRetouch({ db, settings: () => maxBot.settings(),
  send: (...args) => maxBot.send(...args), directory: path.join(dataDir, 'max-retouch') });
maxBot.retouch = maxRetouch;
maxRetouch.start();
const mailSource = new MailImapSource({ enabled: process.env.MAIL_IMPORT_ENABLED === 'true',
  user: process.env.MAIL_IMAP_USER, passwordFile: process.env.MAIL_IMAP_PASSWORD_FILE,
  sender: process.env.MAIL_DESIGNER_SENDER, folder: process.env.MAIL_IMAP_FOLDER || 'INBOX', since: process.env.MAIL_IMAP_SINCE });
const mailWorker = new MailWorker({ db, source: mailSource, mediaStore,
  assistantMode: process.env.MAIL_ASSISTANT_MODE,
  readOrders: async () => (await readBoard(ordersClient)).orders, runCommand: action => commands.run(action, 'mail-import') });
const orderDocuments = new OrderDocuments({ client:ordersClient,mediaStore,directory:path.join(ordersData,'documents') });
const documentStamps = new DocumentStamps({documents:orderDocuments,mediaStore,directory:path.join(ordersData,'document-stamps')});
const ordersHandler = createRequestHandler({ client: ordersClient, mediaStore, documentsService:orderDocuments, documentStampsService:documentStamps,
  documentStampCommand:action=>commands.run(action,'order-document-stamps'), mailService: mailWorker,
  readBoardImpl: async client => { const board=await readBoard(client); return productionPilot?.live ? productionPilot.decorateBoard(board) : board; },
  orderCatalog: input=>{if(!productionPilot)throw new Error('Product catalog unavailable');return productionPilot.orderCatalog(input);},
  creationDirectory: path.join(ordersData, 'creation'), clientCreationDirectory: path.join(ordersData, 'client-creation'),
  positionCreationFormImpl: (client, input) => productionPilot ? productionPilot.positionForm(client, input) : positionCreationForm(client, input),
  createPositionImpl: (client, input, options) => createPosition(client, input, productionPilot ? {
    ...options, prepareProduction: productionPilot.preparePosition, ensureProduction: productionPilot.ensurePosition,
  } : options),
  positionCreationDirectory: path.join(ordersData, 'position-creation'),
  deletePositionImpl:(client,input,options)=>deletePosition(client,input,{...options,assertProductionDetached:productionPilot?.assertPositionDetached}),
  authImpl: async request => ({ response: { ok: true, status: 200, headers: new Headers() },
    value: { authenticated: Boolean(currentSession(request)) } }),
  editFinancialRecordImpl: prepared => finance.editPrepared(prepared),
  invalidateGeneration: () => commands.generation,
  onAudit: entry => console.info(JSON.stringify({ event: entry.event, at: entry.at })),
});

const pinHash = process.env.APP_PIN_HASH || '';
const port = Number(process.env.PORT || 3000);
const sessionDays = Number(process.env.SESSION_DAYS || 180);
const secureCookie = process.env.COOKIE_SECURE !== 'false';
const attempts = new Map();
const productionPilot = await createProductionPilot({ client: ordersClient, sheetsClient:sheets, db, mediaStore, currentOwner: currentSession, json, body });
const productionSnapshot = () => commands.read('production', () => productionPilot ? productionPilot.legacySnapshot() : readProduction(sheets));
const analytics = new AnalyticsService({ connectionReader: () => ({ avito: avitoAnalytics.connection() }), readers: {
  finance: () => finance.snapshot(),
  orders: () => readBoard(ordersClient, { analytics: true }),
  // The existing production adapter updates its command cache while reading.
  // Keep that one reader in the usual queue so an analytics refresh cannot change a command's base state.
  production: productionSnapshot,
  warehouse: () => readWarehouse(sheets, { strictNumbers: true }),
} });
const inquiries = new InquiryService({ importer: inquiryImport, readOrders: () => readBoard(ordersClient) });
const liveBusinessAnalytics = new AnalyticsService({ readers: analytics.readers, sourceIds: ['finance', 'orders'] });
const nightlyAttribution = new NightlyAttribution({base:avitoAnalytics,client:avito,enabled:nightlyEnabled,
  readOrders:()=>readBoard(ordersClient),settings:()=>maxBot.settings()});
nightlyAttribution.start();
const responseTimes = new ResponseTimes({ base: avitoAnalytics, client: avito,
  canRun: () => !nightlyAttribution.flight,
  enabled: process.env.AVITO_AUTO_IMPORT === 'true' && avito.status().enabled });
responseTimes.start();
const researchMaterials = new ResearchMaterials({deep:avitoDeep,client:avito,canRead:()=>!nightlyAttribution.flight});
const liveAnalytics = new LiveAnalytics({ analytics: liveBusinessAnalytics, base: avitoAnalytics, deep: avitoDeep,
  responseTimes,
  attribution:nightlyAttribution,
  readProducts: async () => analyticsCatalog(productionPilot ? await productionPilot.productCatalog() : null,liveAnalytics.mappings()),
  readOrders: () => readBoard(ordersClient), runCommand: action => commands.read('production-catalog', action) });
const autoServices = new AutoServices({base:avitoAnalytics,enabled:nightlyEnabled,bootstrapKey:'categories-v1',settings:()=>maxBot.settings(),
  readInputs:async()=>({board:await liveAnalytics.readOrders(),catalog:await liveAnalytics.readProducts(),mappings:liveAnalytics.mappings(),links:nightlyAttribution.view().links}),
  queue:action=>commands.run(action,'analytics-auto-services'),save:input=>liveAnalytics.save(input)});
liveAnalytics.serviceAutomation=autoServices;
const autoAdServices = new AutoServices({base:avitoAnalytics,kind:'ad',enabled:nightlyEnabled,settings:()=>maxBot.settings(),
  readInputs:async()=>({ads:avitoDeep.view(avitoAnalytics.currentPeriod()).rows,catalog:await liveAnalytics.readProducts(),mappings:liveAnalytics.mappings()}),
  queue:action=>commands.run(action,'analytics-auto-ad-services'),save:input=>liveAnalytics.save(input)});
liveAnalytics.adServiceAutomation=autoAdServices;
nightlyAttribution.services={bootstrap:async()=>{await autoAdServices.bootstrap();await autoServices.bootstrap();},run:async day=>{await autoAdServices.run(day);await autoServices.run(day);}};

let salesDb, salesSources, salesApi;
function startSales() {
  if (salesApi) return;
  let candidate;
  try {
    candidate = new Database(path.join(dataDir, 'sales.sqlite3'));
    candidate.pragma('journal_mode = WAL');
    candidate.pragma('busy_timeout = 5000');
    const desk = new SalesDesk({db:candidate,filesDirectory:path.join(dataDir,'sales-files')});
    const sources = new SalesSources({desk,avito,importer:inquiryImport,mail:mailWorker,max:maxBot,canRead:()=>!nightlyAttribution.flight});
    const handler = salesHandler({desk,sources,json,body,secureCookie,mediaStore,creationDirectory:path.join(ordersData,'creation'),readOrders:()=>commands.read('sales-orders',()=>readBoard(ordersClient))});
    salesDb=candidate; salesSources=sources; salesApi=handler;
    avito.observeMessages = value => sources.observeSafely('avito',()=>sources.observeAvito(value));
    maxBot.observeMessage = value => sources.observeSafely('max',()=>sources.observeMax(value));
  } catch {
    try { candidate?.close(); } catch { /* Isolated optional module. */ }
    try {
      db.exec('CREATE TABLE IF NOT EXISTS sales_intake_health(source TEXT PRIMARY KEY,data TEXT NOT NULL)');
      for (const source of ['avito','max','mail']) db.prepare('INSERT INTO sales_intake_health VALUES(?,?) ON CONFLICT(source) DO UPDATE SET data=excluded.data').run(source,JSON.stringify({gapAt:new Date().toISOString()}));
    } catch { /* Shared storage has its own health checks. */ }
    console.error(JSON.stringify({event:'sales_unavailable',code:'SALES_STORAGE_UNAVAILABLE'}));
  }
}
startSales();


const mimeTypes = {
  '.apk': 'application/vnd.android.package-archive',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function json(response, status, body, headers = {}) {
  if (status >= 400) body = { ...body, requestId: response.getHeader('X-Request-Id') };
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length, ...headers });
  response.end(payload);
}

async function body(request, maxSize = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxSize) throw new Error('payload_too_large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function warehouseStatus(error) {
  if (error?.statusCode) return error.statusCode;
  if (!(error instanceof WarehouseError)) return 502;
  if (error.code === 'invalid' || error.code === 'schema') return 400;
  if (error.code === 'missing') return 404;
  if (error.code === 'duplicate' || error.code === 'full' || error.code === 'insufficient') return 409;
  return 503;
}

function saveWarehousePhoto(code, value) {
  const photo = String(value ?? '').trim();
  if (!photo || photo.startsWith('/api/warehouse/photos/')) return photo;
  const match = photo.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new WarehouseError('invalid', 'Фото должно быть в формате JPG, PNG или WebP');
  const file = Buffer.from(match[2], 'base64');
  if (!file.length || file.length > 3 * 1024 * 1024) throw new WarehouseError('invalid', 'Фото должно быть не больше 3 МБ');
  const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
  const safeCode = String(code ?? 'item').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60) || 'item';
  const directory = path.join(dataDir, 'warehouse-photos');
  fs.mkdirSync(directory, { recursive: true });
  const filename = `${safeCode}-${Date.now()}.${extension}`;
  fs.writeFileSync(path.join(directory, filename), file, { flag: 'wx' });
  return `/api/warehouse/photos/${filename}`;
}

function warehousePhoto(response, pathname) {
  const filename = decodeURIComponent(pathname.slice('/api/warehouse/photos/'.length));
  if (!filename || path.basename(filename) !== filename) return json(response, 404, { error: 'Фото не найдено' });
  const target = path.join(dataDir, 'warehouse-photos', filename);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return json(response, 404, { error: 'Фото не найдено' });
  const extension = path.extname(target).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp'].includes(extension)) return json(response, 404, { error: 'Фото не найдено' });
  response.writeHead(200, { 'Content-Type': mimeTypes[extension], 'Cache-Control': 'private, max-age=86400' });
  fs.createReadStream(target).pipe(response);
}


function requestIp(request) {
  return String(request.headers['x-forwarded-for'] || request.socket.remoteAddress || '').split(',')[0].trim();
}

function allowPinAttempt(ip) {
  const now = Date.now();
  const recent = (attempts.get(ip) ?? []).filter((timestamp) => now - timestamp < 15 * 60_000);
  if (recent.length >= 8) return false;
  recent.push(now);
  attempts.set(ip, recent);
  return true;
}

function currentSession(request) {
  const token = parseCookies(request.headers.cookie).finance_session;
  return token && hasSession(db, tokenHash(token)) ? token : null;
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === request.headers.host; } catch { return false; }
}

async function api(request, response, url) {
  if (!sameOrigin(request) && request.method !== 'GET') return json(response, 403, { error: 'Недопустимый источник запроса' });
  if (url.pathname === '/api/production-pilot' || url.pathname.startsWith('/api/production-pilot/')) {
    if (!productionPilot) return json(response, 404, { error: 'Тестовое производство не включено.' });
    return productionPilot.handle(request, response, url);
  }
  if (url.pathname === '/api/health' && request.method === 'GET') {
    const sync = finance.status();
    const stale = !sync.last_success_at || Date.now() - Date.parse(sync.last_success_at) > 180_000;
    const warehousePending = warehouseReceipts.pending().length + warehouseReceipts.pendingIssues().length;
    const productionPending = Boolean(productionPilot?.pending());
    const degraded = productionPending || warehousePending > 0 || !sync.configured || sync.pending > 0 || sync.invalidRows > 0 || Boolean(sync.last_error) || stale || Boolean(sheets.lastError)
      || !sheetsContract.status().ok || Object.values(moduleChecks).some(check => !check.ok);
    return json(response, 200, { status: degraded ? 'degraded' : 'ok', version: process.env.APP_VERSION || 'dev', sync,
      modules: ['finance', 'orders', 'production', 'warehouse'], checks: moduleChecks, warehousePending, productionPending, crm: 'paused', stale });
  }
  if (url.pathname === '/api/session' && request.method === 'GET') {
    return json(response, 200, { authenticated: Boolean(currentSession(request)) });
  }
  if (url.pathname === '/api/session' && request.method === 'POST') {
    const ip = requestIp(request);
    if (!allowPinAttempt(ip)) return json(response, 429, { error: 'Слишком много попыток. Попробуйте позже.' });
    const input = await body(request);
    if (!pinHash || !await verifyPin(String(input.pin ?? ''), pinHash)) return json(response, 401, { error: 'Неверный PIN. Попробуйте ещё раз.' });
    attempts.delete(ip);
    const token = sessionToken();
    const maxAge = sessionDays * 24 * 60 * 60;
    createSession(db, tokenHash(token), new Date(Date.now() + maxAge * 1000).toISOString());
    return json(response, 200, { authenticated: true }, {
      'Set-Cookie': `finance_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`,
    });
  }
  if (url.pathname === '/api/session' && request.method === 'DELETE') {
    const token = parseCookies(request.headers.cookie).finance_session;
    if (token) deleteSession(db, tokenHash(token));
    return json(response, 200, { authenticated: false }, {
      'Set-Cookie': `finance_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie ? '; Secure' : ''}`,
    });
  }

  if (!currentSession(request)) return json(response, 401, { error: 'Требуется вход' });
  if (url.pathname === '/api/sales' || url.pathname.startsWith('/api/sales/')) return salesApi ? salesApi(request,response,url) : json(response,503,{error:'Хранилище рабочего стола недоступно. Повторите позже; основные разделы работают.',code:'SALES_STORAGE_UNAVAILABLE'});

  if (['/api/analytics/live','/api/analytics/live/links','/api/analytics/live/attribution'].includes(url.pathname)) return liveAnalytics.handle(request,response,url,json,body);

  if (['/api/analytics/inquiries','/api/analytics/inquiries/import'].includes(url.pathname)) return inquiries.handle(request,response,url,json,body);
  if (['/api/analytics/avito/deep','/api/analytics/avito/deep/history','/api/analytics/avito/deep/notes','/api/analytics/avito/deep/daily','/api/analytics/avito/deep/daily/cancel'].includes(url.pathname)) return avitoDeep.handle(request,response,url,json,body);
  if (['/api/analytics/materials','/api/analytics/materials/content','/api/analytics/materials/page','/api/analytics/materials/excerpt'].includes(url.pathname)) return researchMaterials.handle(request,response,url,json,body);
  if (url.pathname === '/api/analytics/avito') return avitoAnalytics.handle(request, response, url, json, body);
  if (url.pathname === '/api/integrations/avito' || url.pathname.startsWith('/api/integrations/avito/')) {
    const result = await avitoApi(avito, url.pathname, request.method,
      isAvitoReadAction(url.pathname, request.method) ? await body(request, 4096) : {});
    return json(response, result.status, result.data, { 'Cache-Control': 'private, no-store', ...result.headers });
  }

  if (url.pathname === '/api/analytics/products' && request.method === 'GET') return json(response, 200, await commands.read('production-catalog', () => productionPilot ? productionPilot.productCatalog() : { products: [], positions: [], source: 'unavailable' }));
  if (url.pathname.startsWith('/api/analytics/')) return analytics.handle(request, response, url, json);

  if (url.pathname === '/api/diagnostics' && request.method === 'GET') {
    await sheetsContract.check().catch(() => {});
    return json(response, 200, { version: process.env.APP_VERSION || 'dev', finance: finance.status(),
      google: { lastSuccessAt: sheets.lastSuccessAt, lastError: sheets.lastError }, sheetsContract: sheetsContract.status(),
      queue: commands.waiting, commandQueue: commands.status(), pendingCommands: finance.pending(), warehousePending: warehouseReceipts.pending(), events: diagnostics.recent(),
      activeFailures: diagnostics.activeFailures(), checks: moduleChecks, analytics: analytics.status(), analyticsLive: liveBusinessAnalytics.status(), integrations: { avito: avitoAnalytics.diagnostics(), maxNotifications: maxNotifications.status(), maxRetouch: maxRetouch.status() } });
  }

  if (url.pathname.startsWith('/api/warehouse/photos/') && request.method === 'GET') return warehousePhoto(response, url.pathname);
  if (url.pathname === '/api/warehouse' && request.method === 'GET') {
    try {
      return json(response, 200, await readWarehouse(sheets));
    } catch (error) {
      return json(response, warehouseStatus(error), { error: error instanceof Error ? error.message : 'Не удалось загрузить склад' });
    }
  }
  if (url.pathname === '/api/expense-categories' && request.method === 'GET') {
    try {
      return json(response, 200, await readExpenseCategories(sheets));
    } catch (error) {
      return json(response, 502, { error: error instanceof Error ? error.message : 'Не удалось загрузить категории расходов' });
    }
  }
  if (url.pathname === '/api/warehouse/items' && request.method === 'POST') {
    try {
      const input = await body(request, 5 * 1024 * 1024);
      input.photoUrl = saveWarehousePhoto(input.sku, input.photoUrl);
      return json(response, 201, await createWarehouseItem(sheets, input));
    } catch (error) {
      return json(response, warehouseStatus(error), { error: error instanceof Error ? error.message : 'Не удалось добавить позицию' });
    }
  }
  const warehouseItemMatch = url.pathname.match(/^\/api\/warehouse\/items\/([^/]+)$/);
  if (warehouseItemMatch && request.method === 'PATCH') {
    try {
      const code = decodeURIComponent(warehouseItemMatch[1]);
      const input = await body(request, 5 * 1024 * 1024);
      input.photoUrl = saveWarehousePhoto(code, input.photoUrl);
      return json(response, 200, await updateWarehouseItem(sheets, code, input));
    } catch (error) {
      return json(response, warehouseStatus(error), { error: error instanceof Error ? error.message : 'Не удалось изменить позицию' });
    }
  }
  if (url.pathname === '/api/warehouse/movements' && request.method === 'POST') {
    try {
      return json(response, 201, await refillWarehouseItem(sheets, await body(request)));
    } catch (error) {
      return json(response, warehouseStatus(error), { error: error instanceof WarehouseError || error?.name === 'SheetsError' ? error.message : 'Не удалось проверить пополнение. Повторите проверку.',
        code: error.code || 'WAREHOUSE_UNAVAILABLE', receiptState: error.receiptState });
    }
  }

  if (url.pathname === '/api/warehouse/issues' && request.method === 'POST') {
    try {
      const input = await body(request);
      return json(response, 201, await finance.issueWarehouseExpense(input, {
        async getValidOrderNumbers() {
          const { orders } = await readOrders(sheets);
          return orders.map((order) => order.number);
        },
      }));
    } catch (error) {
      if (error instanceof SyntaxError || error?.message === 'payload_too_large') throw error;
      if (error instanceof FinanceError) throw error;
      return json(response, warehouseStatus(error), { error: error instanceof Error ? error.message : 'Не удалось списать материал' });
    }
  }

  if (url.pathname === '/api/transactions' && request.method === 'GET') {
    return json(response, 200, { transactions: await commands.read('finance', () => finance.read()), source: 'google', readAt: finance.lastSuccessAt });
  }
  if (url.pathname === '/api/orders' && request.method === 'GET') {
    try {
      return json(response, 200, await readOrders(sheets));
    } catch (error) {
      return json(response, 502, { error: error instanceof Error ? error.message : 'Не удалось загрузить заказы' });
    }
  }
  if (url.pathname === '/api/transactions' && request.method === 'POST') {
    const payload = await body(request);
    const input = validTransaction(payload);
    if (!input) return json(response, 400, { error: 'Проверьте обязательные поля и сумму' });
    const result = await finance.execute('create', { ...input, requestId: payload.requestId, duplicateConfirmation: payload.duplicateConfirmation });
    return json(response, 201, { ...result, syncPending: false });
  }
  if (url.pathname === '/api/transactions' && request.method === 'PATCH') {
    const payload = await body(request);
    const input = validTransaction(payload);
    const id = String(payload.id ?? '').trim();
    if (!id || !input) return json(response, 400, { error: 'Проверьте данные операции' });
    const result = await finance.execute('update', { ...input, id, requestId: payload.requestId, expectedHash: payload.expectedHash });
    return json(response, 200, { ...result, syncPending: false });
  }
  if (url.pathname === '/api/transactions' && request.method === 'DELETE') {
    const payload = await body(request);
    const id = String(payload.id ?? '').trim();
    if (!id) return json(response, 404, { error: 'Операция не найдена' });
    const result = await finance.execute('delete', { id, requestId: payload.requestId, expectedHash: payload.expectedHash });
    return json(response, 200, { ...result, syncPending: false });
  }
  if (url.pathname === '/api/production' && request.method === 'GET') {
    try {
      return json(response, 200, await productionSnapshot());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось загрузить производство';
      return json(response, error instanceof ProductionError && error.code === 'unavailable' ? 503 : 502, { error: message });
    }
  }
  if (url.pathname === '/api/production' && request.method === 'PATCH') {
    if (productionPilot?.live) return json(response,409,{error:'Производство перенесено в новый раздел. Откройте /production/.',code:'PRODUCTION_MOVED'});
    try {
      const production = await setProductionCompletion(sheets, await body(request));
      return json(response, 200, production);
    } catch (error) {
      const status = error instanceof ProductionError
        ? error.code === 'invalid' ? 400 : error.code === 'blocked' ? 409 : error.code === 'stale' ? 409 : 503
        : 502;
      const message = error instanceof Error ? error.message : 'Не удалось обновить производство';
      return json(response, status, { error: message });
    }
  }
  if (url.pathname === '/api/sync' && request.method === 'GET') {
    return json(response, 200, finance.status());
  }
  if (url.pathname === '/api/sync' && request.method === 'POST') {
    await finance.verifyPending();
    await finance.read();
    return json(response, 200, { ...finance.status(), result: { success: true } });
  }
  return json(response, 404, { error: 'Не найдено' });
}

function staticFile(response, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let filename = path.resolve(publicRoot, requested);
  if (!filename.startsWith(`${publicRoot}${path.sep}`) && filename !== path.join(publicRoot, 'index.html')) return false;
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) filename = path.join(publicRoot, 'index.html');
  if (!fs.existsSync(filename)) return false;
  const extension = path.extname(filename);
  const headers = {
    'Content-Type': mimeTypes[extension] || 'application/octet-stream',
    'Cache-Control': extension === '.html' || extension === '.webmanifest' || ['sw.js', 'status.js'].includes(path.basename(filename))
      ? 'no-cache'
      : 'public, max-age=31536000, immutable',
  };
  if (extension === '.apk') headers['Content-Disposition'] = `attachment; filename="${path.basename(filename)}"`;
  response.writeHead(200, headers);
  fs.createReadStream(filename).pipe(response);
  return true;
}

const server = http.createServer(async (request, response) => {
  diagnostics.attach(request, response);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (url.pathname === '/api/max/webhook') {
      response.setHeader('Cache-Control', 'no-store');
      if (request.method !== 'POST') return json(response, 405, { error: 'Метод не поддерживается' });
      if (!maxBot.authorized(request.headers['x-max-bot-api-secret'])) return json(response, 403, { error: 'Доступ запрещён' });
      await maxBot.process(await body(request, 16 * 1024));
      return json(response, 200, { success: true });
    }
    if (url.pathname.startsWith('/api/') || url.pathname === '/kanban' || url.pathname.startsWith('/kanban/')) {
      response.setHeader('Cache-Control', 'no-store, private');
      const action = async () => {
        if (url.pathname === '/kanban/api/session') { url.pathname = '/api/session'; return api(request, response, url); }
        if (url.pathname.startsWith('/kanban')) return ordersHandler(request, response);
        return api(request, response, url);
      };
      const mutation = !['GET', 'HEAD'].includes(request.method) && !url.pathname.endsWith('/session');
      const stampOperation=/^\/kanban\/api\/orders\/[^/]+\/documents\/[a-f0-9-]{36}\/stamps(?:\/[a-f0-9-]{36}(?:\/files)?)?$/i.test(url.pathname);
      // Finance/production GET readers enter the queue themselves and share their
      // in-flight result. Finance reads may assign technical UUIDs to manual rows.
      // MailWorker performs slow downloads before entering this same queue for
      // the final write. Wrapping resolve here would enqueue it inside itself.
      if ((mutation && !url.pathname.startsWith('/api/sales') && !stampOperation && url.pathname !== '/kanban/api/mail/resolve' && !isAvitoReadAction(url.pathname, request.method) && !['/api/analytics/inquiries/import','/api/analytics/avito','/api/analytics/avito/deep','/api/analytics/avito/deep/notes','/api/analytics/avito/deep/daily','/api/analytics/avito/deep/daily/cancel','/api/analytics/materials/page'].includes(url.pathname)) || url.pathname === '/kanban/api/board' || url.pathname.startsWith('/api/production-pilot')) return await commands.run(action, `${request.method} ${routeLabel(url.pathname)}`);
      return await action();
    }
    if (salesStatic(response,url,root)) return;
    if (!staticFile(response, url.pathname)) json(response, 503, { error: 'Приложение не собрано' });
  } catch (error) {
    const safe = error instanceof FinanceError || error?.name === 'SheetsError';
    const status = error instanceof SyntaxError ? 400 : error?.message === 'payload_too_large' ? 413 : safe ? error.statusCode : 500;
    if (!response.headersSent) json(response, status, { error: safe ? error.message : status === 400 ? 'Некорректный запрос' : 'Внутренняя ошибка',
      code: safe ? error.code : 'REQUEST_FAILED', requestId: request.requestId,
      ...(error instanceof FinanceError && error.duplicateWarning ? { duplicateWarning: error.duplicateWarning } : {}) });
    else response.end();
  }
});

server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`finance-pwa listening on ${port}`));
mailWorker.start();
server.requestTimeout = 90_000;
server.headersTimeout = 10_000;
let refreshFlight;
const refresh = () => refreshFlight ??= commands.run(async () => {
  await verifyPendingRefills(sheets);
  try { await productionPilot?.reconcile(); } catch { console.error(JSON.stringify({event:'production_confirmation_pending'})); }
  await finance.verifyPending(); // Read-back only: an uncertain write is never sent again.
  return finance.read();
}, 'finance-refresh').then(records => maxNotifications.observeIncome(records))
  .catch(error => { maxNotifications.invalidateFinance(); console.error(JSON.stringify({ event: 'finance_refresh_failed', code: error.code || 'FINANCE_UNAVAILABLE' })); })
  .finally(() => { refreshFlight = null; });
void refresh();
const refreshTimer = setInterval(refresh, 60_000); refreshTimer.unref();
async function checkModules() {
  // Read-only domain checks. A configured OAuth key alone is not a health check.
  let board;
  for (const [name, read] of [['orders', () => readBoard(ordersClient)], ['production', () => readProduction(sheets)], ['warehouse', () => readWarehouse(sheets)]]) {
    try { const result = await read(); if (name === 'orders') board = result; moduleChecks[name] = { ok: true, checkedAt: new Date().toISOString() }; }
    catch (error) {
      if (name === 'orders') maxNotifications.invalidateOrders();
      moduleChecks[name] = { ok: false, checkedAt: new Date().toISOString(), code: error.code || 'READ_FAILED' };
      console.error(JSON.stringify({ event: 'module_check_failed', module: name, ...moduleChecks[name] }));
    }
  }
  if (board) await maxNotifications.observeOrders(board);
  await maxNotifications.checkBalance();
  startSales();
  salesSources?.observeSafely('mail',()=>salesSources.observeMail());
}
void checkModules();
const checkTimer = setInterval(checkModules, 5 * 60_000); checkTimer.unref();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  clearInterval(refreshTimer);
  clearInterval(checkTimer);
  const notificationsClosed = maxNotifications.close();
  const retouchClosed = maxRetouch.close();
  await refreshFlight;
  await notificationsClosed;
  await retouchClosed;
  await Promise.all([responseTimes.close(),nightlyAttribution.close(),autoServices.close(),autoAdServices.close()]);
  avito.close();
  await inquiryImport.close();
  await avitoDeep.close();
  avitoAnalytics.close();
  clearInterval(refreshTimer);
  clearInterval(checkTimer);
  server.close(async () => { await mailWorker.stop(); await maxAssistant.close(); await commands.tail; await salesSources?.close(); salesDb?.close(); db.close(); process.exit(0); });
});
