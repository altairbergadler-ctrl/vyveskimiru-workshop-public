const { mountOrderConfigurator, positionConfiguration } = await import(`./order-configurator.js${new URL(import.meta.url).search}`);
const { createMediaGallery, openRecordEditor } = await import(`./workspace.js${new URL(import.meta.url).search}`);
const { orderZone, canArchiveOrder, orderCommentParts, replaceOrderComment } = await import(`./board-model.js${new URL(import.meta.url).search}`);
const { createOrderDocumentsUI } = await import(`./documents.js${new URL(import.meta.url).search}`);
const { enhanceRequisitesEditor } = await import(`./requisites.js${new URL(import.meta.url).search}`);
const API = '/kanban/api';
const DEFAULT_STATUSES = ['Расчёт / КП', 'Согласован', 'В производстве', 'Готов к выдаче', 'Монтаж', 'Сдан', 'Отменён'];
const FINISHED = new Set(['Сдан', 'Отменён']);
const MANUFACTURING_FINISHED = new Set(['Готов к выдаче', 'Монтаж', 'Сдан', 'Отменён']);
const STATUS_COLORS = {
  'Расчёт / КП': ['#a79b73', '#f1ecdf'],
  'Согласован': ['#8c9bb2', '#ebeff5'],
  'В производстве': ['#bd936c', '#f5ecdf'],
  'Готов к выдаче': ['#8ba572', '#edf2e5'],
  'Монтаж': ['#9b91b6', '#f0edf6'],
  'Сдан': ['#76a393', '#e7f0e9'],
  'Отменён': ['#ae9690', '#f0e9e6'],
};
const PATHS = {
  columns: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'M9 3v18M15 3v18'],
  layers: ['m12 3 10 5-10 5L2 8l10-5Z', 'm2 12 10 5 10-5M2 16l10 5 10-5'],
  'log-out': ['M9 4H4v16h5M14 8l4 4-4 4M8 12h12'],
  table: ['M4 3h16v18H4zM4 8h16M4 13h16M9 8v13M15 8v13'],
  'arrow-up-right': ['M6 18 18 6M6 6h12v12'],
  search: ['M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Z', 'm16 16 5 5'],
  user: ['M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z', 'M4 21v-2a8 8 0 0 1 16 0v2'],
  refresh: ['M20 7v5h-5M4 17v-5h5', 'M6.1 6a8 8 0 0 1 12.7 2L20 12M4 12l1.2 4A8 8 0 0 0 18 18'],
  wallet: ['M3 5h15v4M3 5v14h18V9H6a3 3 0 0 1 0-6h12v2', 'M16 12h5v4h-5z'],
  clock: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z', 'M12 6v6l4 2'],
  calendar: ['M4 5h16v16H4zM4 10h16M8 3v4M16 3v4'],
  box: ['m12 3 9 5v10l-9 5-9-5V8l9-5Z', 'm3 8 9 5 9-5M12 13v10M8 5l9 5'],
  check: ['m5 12 4 4L19 6'],
  chevron: ['m9 5 7 7-7 7'],
  close: ['m6 6 12 12M6 18 18 6'],
  info: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z', 'M12 11v6M12 7h.01'],
  alert: ['m12 3 10 18H2L12 3Z', 'M12 9v5M12 17h.01'],
  list: ['M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'],
  tool: ['m14 6 4 4M3 21l7-7', 'M20 4a6 6 0 0 0-8 8l-8 8 1 1 8-8a6 6 0 0 0 7-9Z'],
  factory: ['M12 16h.01M16 16h.01M8 16h.01', 'M3 19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5a.5.5 0 0 0-.77-.42l-4.46 2.84A.5.5 0 0 1 15 10.5v-2a.5.5 0 0 0-.77-.42l-4.46 2.84A.5.5 0 0 1 9 10.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2Z'],
  boxes: ['M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42ZM12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z', 'm7 16.5-4.74-2.85M7 16.5l5-3M7 16.5v5.17m10-5.17-5-3m5 3 4.74-2.85M17 16.5v5.17', 'M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8ZM12 8 7.26 5.15M12 8l4.74-2.85M12 13.5V8'],
  users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M16 3.13a4 4 0 0 1 0 7.74M22 21v-2a4 4 0 0 0-3-3.87', 'M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z'],
  money: ['M3 5h18v14H3z', 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z', 'M6 12h.01M18 12h.01'],
  inbox: ['M4 5h16l2 14H2L4 5Z', 'M3 13h5l2 3h4l2-3h5'],
  image: ['M3 3h18v18H3z', 'm3 16 5-5 4 4 3-3 6 6M16 7h.01'],
  stamp: ['M5 14h14v5H5zM4 22h16', 'M8 14v-2a4 4 0 0 1 1-2.6V6a3 3 0 0 1 6 0v3.4a4 4 0 0 1 1 2.6v2'],
  calculator: ['M4 3h16v18H4z', 'M7 7h10M7 11h.01M12 11h.01M17 11h.01M7 15h.01M12 15h.01M17 15v4M7 19h.01M12 19h.01'],
  scan: ['M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3M4 12h16'],
  edit: ['m16 3 5 5-13 13H3v-5L16 3ZM13 6l5 5'],
  archive: ['M3 3h18v5H3zM5 8v13h14V8M9 12h6'],
  panel: ['M3 3h18v18H3zM9 3v18M5 7h1M5 11h1'],
  dashboard: ['M4 3h5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM15 3h5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM15 12h5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1ZM4 16h5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z'],
  plus: ['M12 5v14M5 12h14'],
};

const $ = (id) => document.getElementById(id);
const toastRegion = $('toast-region');
const state = {
  authenticated: false, board: null, query: '', manager: '',
  fetching: false, pending: null, dragId: null, dragX: 0, dragY: 0, dragFrame: null,
  dialogOrderId: null, dialogTab: 'overview', lastFocus: null, toastTimer: null,
  fetchVersion: 0, lastDragEnd: 0, hasSyncError: false,
  editing: false, mediaBusy: false, archiveNeedsRefresh: false,
};
const documentUI = createOrderDocumentsUI({
  api,
  onError: error => { if (error.status === 401) scheduleSessionRenewal(); },
  onEditBuyer: order => {
    const contacts = list(order.contacts).filter(contact => contact.edit?.fields?.some(field => field.id === 'requisites' && field.editable));
    if (contacts.length !== 1) { showToast('В заказе нет однозначной карточки клиента. Укажите клиента в обзоре заказа.', { error: true }); return; }
    editEntity(contacts[0], 'Реквизиты клиента');
  },
  onCreated: (order, result) => {
    const showingOrder = $('order-dialog').open && text(state.dialogOrderId) === text(order.id);
    if (showingOrder) state.dialogTab = result.keepDocuments ? 'documents' : 'media';
    const target = currentOrder(order.id);
    if (target && Array.isArray(result.media.items)) {
      const items = new Map(list(target.media?.items).map(item => [item.id, item]));
      for (const item of result.media.items) items.set(item.id, item);
      target.media = { ...target.media, ...result.media, items: [...items.values()] };
    }
    else if (target && result.media.id) target.media = { ...target.media, items: [...list(target.media?.items).filter(item => item.id !== result.media.id), result.media] };
    renderBoard();
    if (showingOrder) renderDialog();
    showToast(result.decorationComplete ? 'PDF с изображениями и скан сохранены во «Файлы» заказа' : result.keepDocuments ? 'Исходный PDF сохранён. Готовим печать и скан.' : 'PDF сохранён во «Файлы» заказа');
  },
});
const NEW_ORDER_STORAGE_KEY = 'workshop.order.pending-creation';
const NEW_CLIENT_STORAGE_KEY = 'workshop.client.pending-creation';
const NEW_POSITION_STORAGE_KEY = 'workshop.position.pending-creation';
const DELETE_POSITION_STORAGE_KEY = 'workshop.position.pending-deletion';
const ORDER_CREATION_SAFE_ERRORS = new Set(['INVALID_REQUEST_ID', 'INVALID_ORDER_CREATE', 'REQUIRED_FIELD', 'INVALID_FIELD', 'ORDER_CREATE_SOURCE_CHANGED', 'ORDER_CREATE_SCHEMA', 'ORDER_CREATE_STATUS', 'ORDER_CREATE_NO_ROW', 'ORDER_CREATE_ID']);
const CLIENT_CREATION_SAFE_ERRORS = new Set(['INVALID_REQUEST_ID', 'INVALID_CLIENT_CREATE', 'REQUIRED_FIELD', 'INVALID_FIELD', 'CLIENT_CREATE_SOURCE_CHANGED', 'CLIENT_CREATE_SCHEMA', 'CLIENT_EXISTS', 'CLIENT_CREATE_NO_ROW']);
const POSITION_CREATION_SAFE_ERRORS = new Set(['INVALID_REQUEST_ID', 'INVALID_ORDER', 'INVALID_POSITION_CREATE', 'INVALID_POSITION_TEMPLATE', 'REQUIRED_FIELD', 'INVALID_FIELD', 'POSITION_CREATE_SOURCE_CHANGED', 'POSITION_CREATE_SCHEMA', 'POSITION_CREATE_NO_ITEM_ROW', 'POSITION_CREATE_NO_PRODUCTION_ROWS', 'POSITION_ORDER_CLOSED', 'POSITION_ROUTE_INVALID']);
let pendingOrderCreation = null;
let pendingClientCreation = null;
let pendingPositionCreation = null;
let pendingPositionDeletion = null;
try {
  const stored=JSON.parse(sessionStorage.getItem(DELETE_POSITION_STORAGE_KEY));
  if(typeof stored?.requestId==='string'&&typeof stored.orderId==='string'&&stored.record&&stored.item)pendingPositionDeletion=stored;
} catch {}
let sessionRenewalOpen = false;
try {
  const stored = JSON.parse(sessionStorage.getItem(NEW_ORDER_STORAGE_KEY));
  if (typeof stored?.requestId === 'string' && stored.changes && typeof stored.changes === 'object' && !Array.isArray(stored.changes)) pendingOrderCreation = stored;
} catch {}
try {
  const stored = JSON.parse(sessionStorage.getItem(NEW_CLIENT_STORAGE_KEY));
  if (typeof stored?.requestId === 'string' && stored.changes && typeof stored.changes === 'object' && !Array.isArray(stored.changes)) pendingClientCreation = stored;
} catch {}
try {
  const stored = JSON.parse(sessionStorage.getItem(NEW_POSITION_STORAGE_KEY));
  if (typeof stored?.requestId === 'string' && typeof stored.orderId === 'string' && ((typeof stored.templateId === 'string' && stored.position && stored.values) || (stored.kind === 'configurator' && Array.isArray(stored.positions) && stored.configDraft))) pendingPositionCreation = stored;
} catch {}
const currency = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 });
const shortCurrency = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const fullDateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of PATHS[name] || PATHS.info) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function button(text, className, onClick, iconName) {
  const element = el('button', className);
  element.type = 'button';
  if (iconName) element.append(icon(iconName));
  if (text) element.append(el('span', '', text));
  if (onClick) element.addEventListener('click', onClick);
  return element;
}

function numeric(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function money(value) { return numeric(value) === null ? '—' : currency.format(value); }
function compactMoney(value) { return numeric(value) === null ? '—' : `${shortCurrency.format(value)} ₽`; }
function sum(values) {
  const present = values.map(numeric).filter((value) => value !== null);
  return present.length ? Math.round(present.reduce((total, value) => total + value, 0) * 100) / 100 : null;
}
function list(value) { return Array.isArray(value) ? value : []; }
function text(value) { return value === undefined || value === null ? '' : String(value); }
function statusLabel(status) { return status || 'Без статуса'; }
function allowedStatuses() { return list(state.board?.configuredStatuses).length ? state.board.configuredStatuses : DEFAULT_STATUSES; }
function colors(status) { return STATUS_COLORS[status] || ['#929c88', '#edf0e8']; }
function applyStatusColor(element, status) {
  const [color, background] = colors(status);
  element.style.setProperty('--stage-color', color);
  element.style.setProperty('--stage-bg', background);
}
function allStatuses() {
  return [...new Set([...list(state.board?.statuses), ...list(state.board?.orders).map((order) => text(order.status))])];
}
function currentOrder(id) { return list(state.board?.orders).find((order) => String(order.id) === String(id)); }
function displayId(id) { return String(id).startsWith('#') ? String(id) : `#${id}`; }
function pluralLabel(count, one, few, many) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  return `${count} ${mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many}`;
}
function countLabel(count) {
  return pluralLabel(count, 'заказ', 'заказа', 'заказов');
}
function initials(name) { return text(name).trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toLocaleUpperCase('ru-RU') || '—'; }
function normalized(value) { return text(value).toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').trim(); }

function parsedDate(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:T|$)/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.valueOf()) ? null : date;
}
function dateLabel(value, full = false) {
  const date = parsedDate(value);
  return date ? (full ? fullDateFormat : dateFormat).format(date) : text(value) || 'Не указан';
}
function daysUntil(value) {
  const date = parsedDate(value);
  if (!date) return null;
  const now = new Date();
  return Math.round((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
}
function manufacturingDone(order) { return typeof order.manufacturingDone === 'boolean' ? order.manufacturingDone : MANUFACTURING_FINISHED.has(order.status); }
function overdue(order) { const days = daysUntil(order.dueDate); return !manufacturingDone(order) && days !== null && days < 0; }
function deadlineNote(order) {
  if (manufacturingDone(order)) return '';
  const days = daysUntil(order.dueDate);
  if (days === null) return '';
  if (days < 0) return `Просрочен на ${pluralLabel(-days, 'день', 'дня', 'дней')}`;
  return days === 0 ? 'Сегодня' : days === 1 ? 'Завтра' : '';
}
function productionInfo(order) {
  const production = list(order.production);
  const installation = production.filter((stage) => normalized(stage.name) === 'монтаж');
  const manufacture = production.filter((stage) => normalized(stage.name) !== 'монтаж');
  const done = manufacture.filter((stage) => stage.done === true).length;
  const current = manufacture.find((stage) => stage.done !== true);
  return { manufacture, installation, done, total: manufacture.length, current };
}
function safeUrl(value) {
  try {
    const url = new URL(text(value));
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function externalLink(label, url, className = '') {
  const href = safeUrl(url);
  if (!href) return null;
  const link = el('a', className, label);
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

async function api(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(`${API}${path}`, {
      credentials: 'same-origin', cache: 'no-store', ...options,
      headers: { 'Accept': 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(text(data.message || data.error) || 'Не удалось выполнить запрос. Попробуйте ещё раз.');
      error.status = response.status;
      error.code = data.code;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Таблица отвечает дольше обычного. Попробуйте обновить данные.');
    if (error instanceof TypeError) throw new Error('Нет связи с сервером. Проверьте подключение и повторите попытку.');
    throw error;
  } finally { clearTimeout(timer); }
}

function setSync(message, type = 'muted') {
  $('sync-status').textContent = message;
  $('sync-dot').className = `status-dot dot-${type}`;
}
function updateSyncTime() {
  const raw = state.board?.updatedAt;
  const date = raw ? new Date(raw) : null;
  const label = date && !Number.isNaN(date.valueOf()) ? `Обновлено в ${timeFormat.format(date)}` : 'Данные обновлены';
  setSync(label, 'green');
}
function showLogin(message = '') {
  state.authenticated = false;
  state.board = null;
  state.fetchVersion += 1;
  closeDialog();
  endDrag();
  $('boot').hidden = true;
  $('app').hidden = true;
  $('login').hidden = false;
  $('login-error').textContent = message;
  $('pin').value = '';
  $('pin').focus();
}
async function enterApp() {
  state.authenticated = true;
  if (mobileSidebarMedia.matches) setSidebarExpanded(false);
  $('boot').hidden = true;
  $('login').hidden = true;
  $('pin').value = '';
  $('app').hidden = false;
  await loadBoard({ initial: true });
}
let requestedOrderOpened = false;
function openRequestedOrder() {
  if (requestedOrderOpened || !state.board) return;
  const params = new URLSearchParams(location.search);
  const id = params.get('order');
  requestedOrderOpened = true;
  if (id) {
    if (!currentOrder(id)) { showToast('Заказ из ссылки не найден.', { error: true }); return; }
    openDialog(id);
    const tab = params.get('tab');
    if (['overview', 'positions', 'production', 'finance', 'documents', 'media'].includes(tab)) { state.dialogTab = tab; renderDialog(); }
  } else if (params.get('action') === 'create') {
    queueMicrotask(() => void createOrder());
  }
}
function setBoardError(message) {
  const area = $('board-error');
  area.replaceChildren();
  area.hidden = !message;
  if (!message) return;
  area.append(el('span', '', message), button('Повторить', '', () => loadBoard({ fresh: true })));
}
function validBoard(board) {
  if (!board || !Array.isArray(board.orders) || !Array.isArray(board.statuses)) throw new Error('Сервер вернул неполные данные доски. Попробуйте обновить страницу.');
  return board;
}
async function loadBoard({ initial = false, quiet = false, fresh = false } = {}) {
  if (!state.authenticated || state.fetching || state.pending || state.editing || state.mediaBusy || state.dragId !== null) return;
  state.fetching = true;
  const version = ++state.fetchVersion;
  $('refresh').classList.add('loading');
  $('refresh').disabled = true;
  if (!quiet) setSync('Синхронизация…');
  if (initial || !state.board) $('board-loading').hidden = false;
  try {
    const board = validBoard(await api(`/board${fresh ? '?fresh=1' : ''}`));
    if (version !== state.fetchVersion || !state.authenticated) return;
    state.board = board;
    if (fresh) state.archiveNeedsRefresh = false;
    state.hasSyncError = false;
    setBoardError('');
    render();
    openRequestedOrder();
    updateSyncTime();
    if ($('order-dialog').open && state.dialogOrderId) renderDialog({ keepFocus: true });
  } catch (error) {
    if (version !== state.fetchVersion) return;
    if (error.status === 401) { showLogin('Сессия закончилась. Введите PIN ещё раз.'); return; }
    state.hasSyncError = true;
    setSync('Не удалось обновить', 'error');
    setBoardError(state.board ? `Показаны последние загруженные данные. ${error.message}` : error.message);
  } finally {
    state.fetching = false;
    $('refresh').classList.remove('loading');
    $('refresh').disabled = Boolean(state.pending);
    $('board-loading').hidden = true;
    if ($('order-dialog').open && $('order-status')) $('order-status').disabled = Boolean(state.pending);
  }
}

function render() {
  if (!state.board) return;
  renderStats();
  renderManagerFilter();
  renderWarnings();
  renderBoard();
  const href = safeUrl(state.board.spreadsheetUrl);
  $('sheet-link').hidden = !href;
  if (href) $('sheet-link').href = href;
  else $('sheet-link').removeAttribute('href');
  $('nav-count').textContent = state.board.orders.length;
}
function renderStats() {
  const orders = list(state.board.orders);
  const active = orders.filter((order) => !manufacturingDone(order));
  const debt = sum(orders.map((order) => numeric(order.debt) === null ? null : Math.max(order.debt, 0)));
  const overpayment = sum(orders.map((order) => numeric(order.debt) === null ? null : Math.max(-order.debt, 0)));
  const late = active.filter(overdue).length;
  const values = [
    { label: 'В работе', value: active.length, detail: `из ${countLabel(orders.length)}`, icon: 'box' },
    { label: 'Сумма заказов', value: compactMoney(sum(orders.map((order) => order.amount))), detail: 'по всем заказам', icon: 'wallet', small: true },
    { label: 'К получению', value: compactMoney(debt), detail: overpayment > 0 ? `Переплаты: ${compactMoney(overpayment)}` : 'остаток оплаты по заказам', icon: 'money', small: true },
    { label: 'Срок прошёл', value: late, detail: late ? 'требуют внимания' : 'нет просроченных заказов', icon: 'clock', warning: late > 0 },
  ];
  $('stats').replaceChildren(...values.map((value) => {
    const stat = el('div', `stat${value.warning ? ' stat-warning' : ''}`);
    stat.title = `${value.label}: ${value.value}. ${value.detail}`;
    const top = el('div', 'stat-top');
    top.append(el('span', '', value.label), icon(value.icon));
    stat.append(top, el('div', `stat-value${value.small ? ' stat-value-small' : ''}`, value.value), el('div', 'stat-detail', value.detail));
    return stat;
  }));
}
function renderManagerFilter() {
  const managers = [...new Set(state.board.orders.map((order) => text(order.manager).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  const select = $('manager');
  const values = ['', ...managers];
  if (state.manager && !values.includes(state.manager)) state.manager = '';
  if (Array.from(select.options).map((option) => option.value).join('\n') !== values.join('\n')) {
    select.replaceChildren(...values.map((value) => { const option = el('option', '', value || 'Все менеджеры'); option.value = value; return option; }));
  }
  select.value = state.manager;
}
function renderWarnings() {
  const warnings = list(state.board.warnings).filter(Boolean);
  const area = $('notices');
  area.replaceChildren();
  area.hidden = warnings.length === 0;
  if (!warnings.length) return;
  const details = el('details');
  const summary = el('summary');
  summary.append(icon('info'), el('span', '', `Примечания к данным: ${warnings.length}`));
  const items = el('ul');
  warnings.forEach((warning) => items.append(el('li', '', warning)));
  details.append(summary, items);
  area.append(details);
}
function visibleOrders() {
  return list(state.board?.orders).filter((order) => {
    if (state.manager && text(order.manager).trim() !== state.manager) return false;
    if (!state.query) return true;
    const haystack = [order.id, order.title, order.client, order.manager, order.status, order.comment, ...list(order.items).flatMap((item) => [item.name, item.description]), ...list(order.installations).flatMap((item) => [item.status, item.contact, item.phone, item.address, item.comment])].map(normalized).join(' ');
    return state.query.split(/\s+/).every((part) => haystack.includes(part));
  });
}
function renderBoard() {
  const board = $('board');
  const filterKey = JSON.stringify([state.query, state.manager]);
  const revealResult = innerWidth <= 600 && (!board.childElementCount || board.dataset.filterKey !== filterKey);
  board.dataset.filterKey = filterKey;
  const scrollLeft = board.scrollLeft;
  const scrolls = new Map(Array.from(board.children).map((column) => [column.dataset.status, column.querySelector('.column-body')?.scrollTop || 0]));
  const focusedCard = document.activeElement?.classList.contains('order-card') ? document.activeElement.dataset.orderId : null;
  const orders = visibleOrders();
  const statuses = allStatuses().filter((status) => !FINISHED.has(status) && status !== 'Монтаж');
  const productionOrders = orders.filter((order) => orderZone(order) === 'board');
  board.hidden = false;
  board.classList.toggle('is-pending', Boolean(state.pending));
  board.setAttribute('aria-busy', String(Boolean(state.pending)));
  board.style.setProperty('--column-count', Math.max(statuses.length, 1));
  board.replaceChildren(...statuses.map((status) => createColumn(status, productionOrders.filter((order) => text(order.status) === status))));
  renderInstallationLane(orders.filter((order) => orderZone(order) === 'installation'));
  renderArchive(orders.filter((order) => orderZone(order) === 'archive'));
  renderCancelled(orders.filter((order) => orderZone(order) === 'cancelled'));
  board.scrollLeft = scrollLeft;
  if (revealResult) {
    const resultColumn = board.querySelector('.order-card')?.closest('.column');
    if (resultColumn) board.scrollLeft += resultColumn.getBoundingClientRect().left - board.getBoundingClientRect().left - 1;
  }
  for (const column of board.children) {
    const body = column.querySelector('.column-body');
    if (body) body.scrollTop = scrolls.get(column.dataset.status) || 0;
  }
  if (focusedCard && !$('order-dialog').open) findCard(focusedCard)?.focus({ preventScroll: true });
  $('visible-count').textContent = orders.length;
  $('board-footer-count').textContent = `${countLabel(orders.length)} из ${state.board.orders.length}`;
}
function findCard(id) { return Array.from(document.querySelectorAll('.work-area .order-card, #cancelled-dialog .order-card')).find((card) => card.dataset.orderId === String(id)); }
function renderCancelled(orders) {
  const target = $('cancelled');
  const heading = el('span', 'cancelled-heading');
  heading.append(icon('close'), el('strong', '', 'Отменённые'), el('span', 'subtle-count', orders.length));
  target.replaceChildren(heading, el('span', 'cancelled-hint', 'Перетащите для отмены'), el('span', 'cancelled-hint', 'Нажмите, чтобы открыть'));
  target.setAttribute('aria-busy', String(Boolean(state.pending)));
  if ($('cancelled-dialog').open) renderCancelledDialog(orders);
}
function renderCancelledDialog(orders = visibleOrders().filter(order => orderZone(order) === 'cancelled')) {
  const dialog = $('cancelled-dialog');
  const head = el('div', 'cancelled-dialog-head');
  const title = el('h2', '', 'Отменённые заказы'); title.id = 'cancelled-title';
  head.append(title, button('Закрыть', 'button button-outline', () => dialog.close(), 'close'));
  const body = el('div', 'cancelled-list');
  orders.forEach(order => {
    const card = createCard(order, 'archive');
    card.draggable = false;
    card.addEventListener('click', () => dialog.close());
    card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') dialog.close(); });
    body.append(card);
  });
  if (!orders.length) body.append(el('p', '', state.query || state.manager ? 'Ничего не найдено' : 'Отменённых заказов нет'));
  dialog.replaceChildren(head, body);
}
function installationLead(order) {
  return list(order.installations).filter((item) => item.status !== 'Отменён').sort((a, b) =>
    Number(a.status === 'Выполнен') - Number(b.status === 'Выполнен') ||
    text(a.date || '9999').localeCompare(text(b.date || '9999')))[0];
}
function renderInstallationLane(orders) {
  const lane = $('installation-lane');
  const left = lane.scrollLeft;
  const sorted = [...orders].sort((a, b) => text(installationLead(a)?.date || '9999').localeCompare(text(installationLead(b)?.date || '9999')) || text(a.id).localeCompare(text(b.id), 'ru', { numeric: true }));
  lane.replaceChildren(...sorted.map((order) => createCard(order, 'installation')));
  if (!orders.length) {
    const empty = el('div', 'installation-empty');
    empty.append(icon('tool'), el('span', '', state.query || state.manager ? 'Монтажей по фильтру нет' : 'Заказы с монтажом появятся здесь'), el('small', '', 'Можно перенести готовый заказ'));
    lane.append(empty);
  }
  lane.scrollLeft = left;
  $('installation-count').textContent = orders.length;
  $('installation-section').classList.toggle('is-empty', !orders.length);
  $('installation-section').setAttribute('aria-busy', String(Boolean(state.pending)));
}
function renderArchive(orders) {
  const archive = $('archive');
  const scrollTop = archive.querySelector('.archive-body')?.scrollTop || 0;
  const head = el('div', 'archive-head');
  head.append(icon('archive'), el('h2', '', 'Архив'), el('span', 'column-count', orders.length));
  const hint = el('p', 'archive-hint', 'Из готовности или монтажа');
  const body = el('div', 'archive-body');
  orders.forEach((order) => body.append(createCard(order, 'archive')));
  if (!orders.length) {
    const empty = el('div', 'archive-empty');
    empty.append(icon('archive'), el('span', '', state.query || state.manager ? 'Ничего не найдено' : 'Завершённые заказы'), el('small', '', 'Перетащите карточку сюда'));
    body.append(empty);
  }
  archive.replaceChildren(head, hint, body);
  archive.setAttribute('aria-busy', String(Boolean(state.pending)));
  body.scrollTop = scrollTop;
}
function bindDropTarget(target, accept, action, invalidMessage) {
  const acceptDrag = (event) => {
    if (state.dragId === null || state.pending) return;
    const accepted = accept(currentOrder(state.dragId));
    event.preventDefault();
    event.dataTransfer.dropEffect = accepted ? 'move' : 'none';
    document.querySelectorAll('.drop-target,.drop-invalid').forEach((node) => { if (node !== target) node.classList.remove('drop-target', 'drop-invalid'); });
    target.classList.toggle('drop-target', accepted);
    target.classList.toggle('drop-invalid', !accepted);
  };
  target.addEventListener('dragenter', acceptDrag);
  target.addEventListener('dragover', acceptDrag);
  target.addEventListener('dragleave', (event) => { if (!target.contains(event.relatedTarget)) target.classList.remove('drop-target', 'drop-invalid'); });
  target.addEventListener('drop', (event) => {
    if (state.dragId === null || state.pending) return;
    event.preventDefault();
    const id = state.dragId;
    const accepted = accept(currentOrder(id));
    endDrag();
    if (accepted) action(id);
    else if (invalidMessage) showToast(invalidMessage, { error: true });
  });
}
function createColumn(status, orders) {
  const column = el('section', 'column');
  column.dataset.status = status;
  column.setAttribute('aria-label', `${statusLabel(status)}: ${countLabel(orders.length)}`);
  applyStatusColor(column, status);
  const header = el('div', 'column-head');
  header.append(el('span', 'column-dot'), el('h2', 'column-title', statusLabel(status)), el('span', 'column-count', orders.length));
  const total = el('span', 'column-total', orders.length ? compactMoney(sum(orders.map((order) => order.amount))) : '');
  total.title = 'Сумма заказов в столбце';
  header.append(total);
  const body = el('div', 'column-body');
  if (orders.length) orders.forEach((order) => body.append(createCard(order)));
  else {
    const empty = el('div', 'column-empty');
    empty.append(icon('inbox'), el('span', '', state.query || state.manager ? 'Нет подходящих заказов' : 'Пока нет заказов'));
    if (allowedStatuses().includes(status)) empty.append(el('small', '', 'Перетащите карточку сюда'));
    body.append(empty);
  }
  column.append(header, body);
  bindDropTarget(column, (order) => Boolean(order && allowedStatuses().includes(status)), (id) => moveOrder(id, status));
  return column;
}
function positionFacts(item) {
  const facts = [];
  const width = numeric(item.width), height = numeric(item.height), quantity = numeric(item.quantity);
  if (width !== null && height !== null) facts.push(`${shortCurrency.format(width)} × ${shortCurrency.format(height)} м`);
  else if (width !== null) facts.push(`Ширина ${shortCurrency.format(width)} м`);
  else if (height !== null) facts.push(`Высота ${shortCurrency.format(height)} м`);
  if (quantity !== null) facts.push(`${shortCurrency.format(quantity)}${text(item.unit) ? ` ${text(item.unit)}` : ''}`);
  return facts;
}
function cardComposition(order) {
  const composition = el('div', 'card-composition');
  const items = list(order.items);
  composition.append(el('div', 'card-composition-label', 'Состав заказа'));
  if (!items.length) {
    composition.append(el('p', 'card-composition-empty', 'Состав не заполнен'));
    return composition;
  }
  for (const item of items.slice(0, 2)) {
    const row = el('div', 'card-composition-item');
    row.append(el('div', 'card-item-name', text(item.name) || 'Изделие без названия'));
    const facts = positionFacts(item);
    if (facts.length) row.append(el('div', 'card-item-facts', facts.join(' · ')));
    const descriptionText = text(item.description).replace(/^Тип продукции:[ \t]*/gm, '').trim();
    if (descriptionText) {
      const description = el('p', 'card-item-description', descriptionText);
      description.title = descriptionText;
      row.append(description);
    }
    composition.append(row);
  }
  if (items.length > 2) composition.append(el('div', 'card-composition-more', `Ещё ${pluralLabel(items.length - 2, 'позиция', 'позиции', 'позиций')} в составе`));
  return composition;
}
function createCard(order, variant = 'board') {
  const card = el('article', `order-card${variant === 'installation' ? ' installation-lane-card' : variant === 'archive' ? ' archive-card' : ''}`);
  const id = String(order.id);
  card.dataset.orderId = id;
  card.draggable = !state.pending;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-haspopup', 'dialog');
  card.setAttribute('aria-label', `${displayId(id)}. ${order.client || 'Клиент не указан'}. ${order.title || 'Заказ без названия'}. ${statusLabel(order.status)}. ${money(order.amount)}. Открыть детали.`);
  if (String(state.pending?.id) === id) card.classList.add('card-pending');
  if (variant !== 'board') {
    const top = el('div', 'card-top');
    top.append(el('span', 'order-id', displayId(id)));
    const installation = installationLead(order);
    const label = variant === 'archive' ? (order.status === 'Отменён' ? 'Отменён' : 'Сдан') : installation?.status || 'Не согласован';
    top.append(el('span', 'installation-status', label));
    card.append(top, el('div', 'card-client', order.title || 'Заказ без названия'), el('p', 'card-title', order.client || 'Клиент не указан'));
    if (variant === 'installation') {
      const plan = el('div', 'installation-card-plan');
      plan.append(icon('calendar'), el('strong', '', installation?.date ? dateLabel(installation.date) : 'Дата не согласована'), el('span', '', installation?.time || ''));
      card.append(plan);
      const contact = [installation?.contact || order.contacts?.[0]?.name, installation?.phone || order.contacts?.[0]?.phone].filter(Boolean).join(' · ');
      if (contact) card.append(el('p', 'installation-card-contact', contact));
      if (installation?.address) { const address = el('p', 'installation-card-address', installation.address); address.title = installation.address; card.append(address); }
      const total = list(order.installations).filter((item) => item.status !== 'Отменён').length;
      if (total > 1) card.append(el('span', 'installation-card-more', `Выездов: ${total}`));
    } else {
      card.append(el('strong', 'archive-amount', compactMoney(order.amount)));
    }
    return bindCardEvents(card, id);
  }
  const cover = list(order.media?.items).find((item) => item.id === order.media?.coverId && item.kind === 'image');
  const coverUrl = privateMediaUrl(cover?.url);
  if (cover && coverUrl) {
    const picture = el('img', `card-cover${cover.derivedFrom?.kind === 'cdr-preview' ? ' cdr-cover' : ''}`);
    picture.src = coverUrl;
    picture.alt = text(cover.name) || 'Обложка заказа';
    picture.loading = 'lazy';
    picture.decoding = 'async';
    picture.draggable = false;
    picture.addEventListener('error', () => picture.remove());
    card.append(picture);
  }
  const top = el('div', 'card-top');
  top.append(el('span', 'order-id', displayId(id)));
  const days = daysUntil(order.dueDate);
  const late = overdue(order);
  const soon = !manufacturingDone(order) && (days === 0 || days === 1);
  const due = el('span', `card-due${late ? ' overdue' : soon ? ' due-soon' : ''}`);
  if (order.dueDate) {
    const label = late && days !== null ? `Просрочен на ${pluralLabel(-days, 'день', 'дня', 'дней')}`
      : soon ? `Срок: ${days === 0 ? 'сегодня' : 'завтра'}` : `Срок: ${dateLabel(order.dueDate)}`;
    due.append(icon(late ? 'clock' : 'calendar'), el('span', '', label));
    due.title = `Срок изготовления: ${dateLabel(order.dueDate, true)}`;
  } else { due.textContent = 'Срок не указан'; }
  top.append(due);
  card.append(top, el('div', 'card-client', order.title || 'Заказ без названия'), el('p', 'card-title', order.client || 'Клиент не указан'));
  card.append(cardComposition(order));
  const financial = el('div', 'card-money');
  const total = el('div', 'card-total');
  total.append(el('span', 'card-money-label', 'Сумма заказа'), el('strong', 'card-amount', compactMoney(order.amount)));
  financial.append(total);
  const balance = el('div', 'card-balance');
  const paid = el('div', 'card-paid');
  paid.append(el('span', '', 'Внесено'), el('span', '', compactMoney(order.paid)));
  balance.append(paid);
  card.append(financial, balance);
  const bottom = el('div', 'card-bottom');
  const avatar = el('span', 'manager-avatar', initials(order.manager));
  avatar.setAttribute('aria-hidden', 'true');
  bottom.append(avatar, el('span', '', order.manager || 'Без менеджера'));
  card.append(bottom);
  const scheduled = list(order.installations).find((installation) => !['Выполнен', 'Отменён'].includes(installation.status));
  if (scheduled) {
    const late = daysUntil(scheduled.date) !== null && daysUntil(scheduled.date) < 0;
    const note = el('div', `card-installation${late ? ' overdue' : ''}`);
    note.append(icon('tool'), el('span', '', `Монтаж: ${scheduled.date ? dateLabel(scheduled.date) : 'дата не согласована'}${scheduled.time ? `, ${scheduled.time}` : ''}`));
    card.append(note);
  }
  return bindCardEvents(card, id);
}
function bindCardEvents(card, id) {
  card.addEventListener('click', () => { if (Date.now() - state.lastDragEnd > 180 && !state.pending) openDialog(id); });
  card.addEventListener('keydown', (event) => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); if (!state.pending) openDialog(id); } });
  card.addEventListener('dragstart', (event) => {
    if (state.pending || state.fetching) { event.preventDefault(); return; }
    state.dragId = id;
    state.dragX = event.clientX;
    state.dragY = event.clientY;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
    requestAnimationFrame(() => { if (state.dragId === id) card.classList.add('dragging'); });
    state.dragFrame = requestAnimationFrame(autoScroll);
  });
  card.addEventListener('dragend', endDrag);
  return card;
}
function progressBar(done, total) {
  const track = el('div', 'progress-track');
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-label', 'Выполненные этапы производства');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', String(total || 1));
  track.setAttribute('aria-valuenow', String(done));
  track.style.setProperty('--progress', `${total ? Math.min(done / total * 100, 100) : 0}%`);
  track.append(el('span', 'progress-fill'));
  return track;
}
function autoScroll() {
  if (state.dragId === null) return;
  const edge = 58;
  for (const scroller of [$('board'), $('installation-lane')]) {
    const rect = scroller.getBoundingClientRect();
    if (state.dragY < rect.top || state.dragY > rect.bottom || state.dragX < rect.left - edge || state.dragX > rect.right + edge) continue;
    if (state.dragX < rect.left + edge) scroller.scrollLeft -= Math.max(2, (rect.left + edge - state.dragX) / 5);
    else if (state.dragX > rect.right - edge) scroller.scrollLeft += Math.max(2, (state.dragX - rect.right + edge) / 5);
  }
  const hovered = document.elementFromPoint(state.dragX, state.dragY);
  const columnBody = hovered?.closest('.column')?.querySelector('.column-body') || hovered?.closest('.archive-rail')?.querySelector('.archive-body');
  if (columnBody) {
    const bodyRect = columnBody.getBoundingClientRect();
    if (state.dragY < bodyRect.top + 35) columnBody.scrollTop -= 5;
    if (state.dragY > bodyRect.bottom - 35) columnBody.scrollTop += 5;
  }
  state.dragFrame = requestAnimationFrame(autoScroll);
}
function endDrag() {
  if (state.dragId !== null) state.lastDragEnd = Date.now();
  state.dragId = null;
  if (state.dragFrame) cancelAnimationFrame(state.dragFrame);
  state.dragFrame = null;
  document.querySelectorAll('.dragging,.drop-target,.drop-invalid').forEach((element) => element.classList.remove('dragging', 'drop-target', 'drop-invalid'));
}

async function moveOrder(id, newStatus, { expectedStatus, undo = false } = {}) {
  if (state.pending || state.fetching || state.editing || state.mediaBusy || !state.authenticated) return;
  const order = currentOrder(id);
  if (!order || !allowedStatuses().includes(newStatus)) return;
  const oldStatus = text(order.status);
  if (expectedStatus !== undefined && oldStatus !== expectedStatus) {
    showToast('Статус заказа уже изменился. Отмена не выполнена.', { error: true });
    return;
  }
  if (oldStatus === newStatus) return;
  if (newStatus === 'Сдан') { await archiveOrder(id); return; }
  state.pending = { id: String(id), oldStatus, newStatus };
  state.fetchVersion += 1;
  order.status = newStatus;
  $('refresh').disabled = true;
  setSync('Сохраняем статус…');
  render();
  if ($('order-dialog').open) renderDialog({ keepFocus: true });
  try {
    const board = validBoard(await api(`/orders/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: JSON.stringify({ status: newStatus, expectedStatus: oldStatus }) }));
    state.board = board;
    state.hasSyncError = false;
    state.pending = null;
    render();
    setBoardError('');
    updateSyncTime();
    if ($('order-dialog').open) renderDialog({ keepFocus: true });
    const canUndo = allowedStatuses().includes(oldStatus) && oldStatus !== 'Сдан';
    showToast(undo ? `Статус ${displayId(id)} восстановлен` : `${displayId(id)} → ${statusLabel(newStatus)}`, {
      action: !undo && canUndo ? { label: 'Отменить', run: () => moveOrder(id, oldStatus, { expectedStatus: newStatus, undo: true }) } : null,
    });
  } catch (error) {
    const current = currentOrder(id);
    if (current) current.status = oldStatus;
    state.pending = null;
    if (error.status === 401) { showLogin('Сессия закончилась. Введите PIN ещё раз.'); return; }
    render();
    if ($('order-dialog').open) renderDialog({ keepFocus: true });
    const message = error.status === 409 ? `${error.message} Проверяем актуальный статус…` : `Не удалось подтвердить перенос. ${error.message} Проверяем актуальный статус…`;
    showToast(message, { error: true });
    setSync('Проверяем статус заказа…', 'warning');
    await loadBoard({ fresh: true });
  } finally {
    state.pending = null;
    $('refresh').disabled = false;
  }
}

async function archiveOrder(id) {
  if (state.pending || state.fetching || state.editing || state.mediaBusy || !state.authenticated) return;
  const order = currentOrder(id);
  if (!canArchiveOrder(order)) { showToast('В архив можно отправить готовый заказ или заказ с монтажом.', { error: true }); return; }
  if (state.archiveNeedsRefresh) { showToast('Сначала обновите доску и проверьте результат предыдущего сохранения.', { error: true }); return; }
  const installations = list(order.installations).map((item) => ({ record: item.edit?.record }));
  if (installations.some((item) => !item.record)) { showToast('Обновите доску, чтобы получить актуальные записи монтажа.', { error: true }); return; }
  state.pending = { id: String(id), action: 'archive' };
  state.fetchVersion += 1;
  $('refresh').disabled = true;
  render();
  if ($('order-dialog').open) renderDialog({ keepFocus: true });
  setSync('Завершаем заказ…');
  try {
    state.board = validBoard(await api(`/orders/${encodeURIComponent(id)}/archive`, { method: 'POST', body: JSON.stringify({ expectedStatus: order.status, installations }) }));
    state.pending = null;
    state.hasSyncError = false;
    render();
    setBoardError('');
    updateSyncTime();
    if ($('order-dialog').open) renderDialog({ keepFocus: true });
    showToast(`${displayId(id)} в архиве${installations.length ? ' · монтаж завершён' : ''}`);
  } catch (error) {
    state.pending = null;
    state.archiveNeedsRefresh = true;
    if (error.status === 401) { showLogin('Сессия закончилась. Введите PIN ещё раз.'); return; }
    render();
    if ($('order-dialog').open) renderDialog({ keepFocus: true });
    showToast(`${error.message} Проверяем актуальные данные.`, { error: true });
    await loadBoard({ fresh: true });
  } finally { state.pending = null; $('refresh').disabled = false; }
}

function showToast(message, { error = false, action = null } = {}) {
  clearTimeout(state.toastTimer);
  const region = toastRegion;
  if ($('order-dialog').open) $('order-dialog').querySelector('.dialog-shell')?.append(region);
  else document.body.append(region);
  const toast = el('div', `toast${error ? ' error' : ''}`);
  toast.append(icon(error ? 'alert' : 'check'), el('span', 'toast-message', message));
  if (action) toast.append(button(action.label, '', () => { region.replaceChildren(); clearTimeout(state.toastTimer); action.run(); }));
  const close = button('', 'toast-dismiss', () => { region.replaceChildren(); clearTimeout(state.toastTimer); }, 'close');
  close.setAttribute('aria-label', 'Закрыть уведомление');
  toast.append(close);
  region.replaceChildren(toast);
  state.toastTimer = setTimeout(() => region.replaceChildren(), action || error ? 15000 : 5000);
}

function openDialog(id) {
  if (!currentOrder(id)) return;
  state.lastFocus = document.activeElement;
  state.dialogOrderId = id;
  state.dialogTab = 'overview';
  renderDialog();
  $('order-dialog').showModal();
  $('order-dialog').querySelector('.dialog-close')?.focus({ preventScroll: true });
}
function closeDialog() {
  const dialog = $('order-dialog');
  if (!dialog.open) return;
  if (state.mediaBusy) { showToast('Дождитесь завершения загрузки файлов.'); return; }
  const id = state.dialogOrderId;
  document.body.append(toastRegion);
  dialog.close();
  state.dialogOrderId = null;
  const target = findCard(id) || (state.lastFocus?.isConnected ? state.lastFocus : $('board'));
  target?.focus({ preventScroll: true });
}
function detailRow(label, value, className = '') {
  const row = el('div', 'detail-row');
  row.append(el('dt', '', label), el('dd', className, value || 'Не указан'));
  return row;
}
function detailSection(label, content, className = '') {
  const section = el('section', `detail-section ${className}`.trim());
  section.append(el('h3', 'section-label', label), content);
  return section;
}
function moneySummary(order) {
  const summary = el('div', 'summary-money');
  const values = [
    ['Сумма заказа', order.amount, ''], ['Оплачено', order.paid, ''],
    [order.debt < 0 ? 'Переплата' : 'К получению', order.debt < 0 ? -order.debt : order.debt, order.debt < 0 ? 'outstanding-cell credit-cell' : 'outstanding-cell'],
  ];
  for (const [label, value, className] of values) {
    const cell = el('div', `money-cell ${className}`.trim());
    cell.append(el('span', '', label), el('strong', '', compactMoney(value)));
    summary.append(cell);
  }
  return summary;
}
function renderDialog({ keepFocus = false } = {}) {
  const dialog = $('order-dialog');
  const order = currentOrder(state.dialogOrderId);
  if (!order) { closeDialog(); return; }
  const focused = keepFocus && dialog.contains(document.activeElement) ? document.activeElement?.dataset.focusKey : null;
  const scrollTop = keepFocus ? dialog.querySelector('.dialog-content')?.scrollTop || 0 : 0;
  const shell = el('div', 'dialog-shell');
  const header = el('header', 'dialog-header');
  const headingRow = el('div', 'dialog-heading-row');
  const headingContent = el('div');
  const eyebrow = el('div', 'dialog-eyebrow');
  const status = el('span', 'status-pill', statusLabel(order.status));
  applyStatusColor(status, order.status);
  eyebrow.append(el('span', '', `ЗАКАЗ ${displayId(order.id)}`), status);
  const title = el('h2', 'dialog-title', order.title || 'Заказ без названия');
  title.id = 'order-dialog-title';
  headingContent.append(eyebrow, title, el('p', 'dialog-subtitle', order.client || 'Клиент не указан'));
  const close = button('', 'dialog-close', closeDialog, 'close');
  close.setAttribute('aria-label', 'Закрыть заказ');
  close.dataset.focusKey = 'close';
  headingRow.append(headingContent, close);
  const statusRow = el('div', 'dialog-status-row');
  const statusLabelElement = el('label', 'status-select-label', state.pending ? 'Сохраняем…' : 'Статус заказа');
  statusLabelElement.htmlFor = 'order-status';
  const select = el('select', 'status-select');
  select.id = 'order-status';
  select.dataset.focusKey = 'status';
  select.disabled = Boolean(state.pending || state.fetching);
  const statuses = [...new Set([text(order.status), ...allowedStatuses()])];
  for (const value of statuses) {
    const option = el('option', '', value === 'Сдан' ? 'Архив · Сдан' : statusLabel(value));
    option.value = value;
    option.disabled = !allowedStatuses().includes(value) || (value === 'Сдан' && order.status !== 'Сдан' && !canArchiveOrder(order));
    select.append(option);
  }
  select.value = text(order.status);
  select.addEventListener('change', () => moveOrder(order.id, select.value));
  statusRow.append(statusLabelElement, select);
  const edit = entityEditButton(order, 'Заказ', 'button button-outline dialog-edit');
  if (edit) { edit.dataset.focusKey = 'edit-order'; statusRow.append(edit); }
  if (order.edit?.fields.some(field => field.id === 'client' && field.editable)) {
    const clientEdit = button(order.client ? 'Сменить клиента' : 'Указать клиента', 'button button-outline', () => editEntity(order, 'Клиент заказа', null, false, 'client'), 'edit');
    clientEdit.dataset.focusKey = 'edit-order-client';
    clientEdit.disabled = Boolean(state.pending || state.fetching);
    statusRow.append(clientEdit);
  }
  if (canArchiveOrder(order)) {
    const archive = button('В архив', 'button button-outline dialog-archive', () => archiveOrder(order.id), 'archive');
    archive.dataset.focusKey = 'archive';
    archive.disabled = Boolean(state.pending || state.fetching);
    archive.title = 'Завершить связанные монтажи и отправить заказ в архив';
    statusRow.append(archive);
  } else if (FINISHED.has(order.status)) {
    const restoreStatus = order.status === 'Отменён'
      ? (allowedStatuses().includes('Расчёт / КП') ? 'Расчёт / КП' : allowedStatuses().find(status => !MANUFACTURING_FINISHED.has(status)) || '')
      : installationLead(order) ? 'Монтаж' : 'Готов к выдаче';
    const restore = button('Вернуть на доску', 'button button-outline', () => moveOrder(order.id, restoreStatus), 'layers');
    restore.dataset.focusKey = 'restore';
    restore.disabled = Boolean(state.pending || state.fetching || !allowedStatuses().includes(restoreStatus));
    statusRow.append(restore);
  }
  const source = externalLink('В таблице', order.sourceUrl || state.board.spreadsheetUrl, 'dialog-source');
  if (source) { source.append(icon('arrow-up-right')); source.dataset.focusKey = 'source'; statusRow.append(source); }
  header.append(headingRow, statusRow);
  const tabs = el('div', 'dialog-tablist');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Детали заказа');
  const tabsData = [['overview', 'Обзор', 'list'], ['positions', 'Состав', 'box'], ['production', 'Производство', 'tool'], ['finance', 'Финансы', 'money'], ['documents', 'Документы', 'table'], ['media', 'Файлы', 'image']];
  for (const [key, label, iconName] of tabsData) {
    const tab = button(label, 'dialog-tab', () => { if (state.mediaBusy) return; state.dialogTab = key; renderDialog(); $('order-dialog').querySelector(`[data-focus-key="tab-${key}"]`)?.focus({ preventScroll: true }); }, iconName);
    tab.id = `tab-${key}`;
    tab.dataset.focusKey = `tab-${key}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(state.dialogTab === key));
    tab.setAttribute('aria-controls', 'order-panel');
    tab.disabled = state.mediaBusy;
    tab.tabIndex = state.dialogTab === key ? 0 : -1;
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      if (state.mediaBusy) return;
      const index = tabsData.findIndex(([value]) => value === key);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabsData.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabsData.length) % tabsData.length;
      state.dialogTab = tabsData[next][0];
      renderDialog();
      $('order-dialog').querySelector(`[data-focus-key="tab-${state.dialogTab}"]`)?.focus({ preventScroll: true });
    });
    tabs.append(tab);
  }
  const content = el('div', 'dialog-content');
  content.id = 'order-panel';
  content.setAttribute('role', 'tabpanel');
  content.setAttribute('aria-labelledby', `tab-${state.dialogTab}`);
  content.tabIndex = 0;
  content.dataset.focusKey = 'panel';
  if (state.dialogTab === 'overview') content.append(renderOverview(order));
  else if (state.dialogTab === 'positions') content.append(renderPositions(order));
  else if (state.dialogTab === 'production') content.append(renderProduction(order));
  else if (state.dialogTab === 'media') content.append(renderMedia(order));
  else if (state.dialogTab === 'documents') content.append(documentUI.renderOrder(order));
  else content.append(renderFinance(order));
  const bottom = el('div', 'dialog-bottom');
  bottom.append(el('span', '', 'Данные из Google Таблиц'), button('Готово', 'button button-outline', closeDialog));
  bottom.lastChild.dataset.focusKey = 'done';
  shell.append(header, tabs, content, bottom);
  dialog.replaceChildren(shell);
  if (toastRegion.children.length && dialog.open) shell.append(toastRegion);
  content.scrollTop = scrollTop;
  if (focused) {
    const target = Array.from(dialog.querySelectorAll('[data-focus-key]')).find((element) => element.dataset.focusKey === focused && !element.disabled);
    (target || close).focus({ preventScroll: true });
  }
}
function renderOverview(order) {
  const wrapper = el('div');
  wrapper.append(moneySummary(order));
  const grid = el('div', 'detail-grid');
  const left = el('div');
  left.append(renderPositions(order, true));
  const right = el('div');
  const rows = el('dl', 'detail-rows');
  const deadline = detailRow('Срок изготовления', dateLabel(order.dueDate, true), overdue(order) ? 'overdue' : '');
  const note = deadlineNote(order);
  if (note) deadline.lastChild.append(el('span', `detail-deadline-note${overdue(order) ? ' overdue' : ' due-soon'}`, note));
  rows.append(detailRow('Менеджер', order.manager), detailRow('Дата заказа', dateLabel(order.createdDate, true)), detailRow('Желаемая дата', dateLabel(order.desiredDate, true)), deadline);
  if (order.readyDate || manufacturingDone(order) && order.status !== 'Отменён') rows.append(detailRow('Готово по факту', order.readyDate ? dateLabel(order.readyDate, true) : 'Дата не указана'));
  right.append(detailSection('Информация', rows));
  right.append(renderInstallations(order));
  const contacts = el('div');
  if (!list(order.contacts).length) contacts.append(el('p', 'detail-empty', 'Контакты в таблице не заполнены.'));
  for (const contact of list(order.contacts)) {
    const element = el('div', 'contact');
    element.append(el('p', 'contact-name', contact.name || order.client || 'Контакт'));
    if (contact.type) element.append(el('p', 'contact-detail', contact.type));
    if (contact.phone) {
      const phone = text(contact.phone);
      const cleaned = phone.replace(/[^\d+]/g, '');
      const link = el('a', 'contact-link', phone);
      if (/^\+?\d{5,20}$/.test(cleaned)) link.href = `tel:${cleaned}`;
      element.append(link);
    }
    if (contact.email) {
      const email = text(contact.email).trim();
      const link = el('a', 'contact-link', email);
      if (/^[^\s@?&#]+@[^\s@?&#]+\.[^\s@?&#]+$/.test(email)) link.href = `mailto:${encodeURIComponent(email).replace('%40', '@')}`;
      element.append(link);
    }
    if (contact.source) element.append(el('p', 'contact-detail', `Источник: ${contact.source}`));
    if (contact.comment) element.append(el('p', 'contact-detail', contact.comment));
    const edit = entityEditButton(contact, 'Контакт клиента');
    if (edit) element.append(edit);
    contacts.append(element);
  }
  right.append(detailSection('Контакты', contacts));
  grid.append(left, right);
  wrapper.append(grid);
  return wrapper;
}

function renderPositions(order, overview = false) {
  const wrapper = el('div', 'positions-panel');
  const header = el('div', 'positions-header');
  const copy = el('div');
  copy.append(el('h3', '', 'Состав заказа'), el('p', '', 'Изделия, материалы и полные характеристики для производства.'));
  const closed = MANUFACTURING_FINISHED.has(order.status);
  const pendingHere = pendingPositionCreation?.orderId === String(order.id);
  const add = button(pendingHere ? 'Проверить добавление' : 'Добавить изделие', 'button button-primary position-add-button', () => createPosition(order), pendingHere ? 'refresh' : 'plus');
  add.disabled = state.editing || state.pending || state.mediaBusy || closed;
  if (closed) add.title = 'Сначала верните заказ в рабочий статус';
  header.append(copy, add);
  if(pendingPositionDeletion?.orderId===String(order.id)){
    const retry=button('Проверить удаление','button button-outline position-delete-retry',()=>removePosition(order), 'refresh');
    retry.disabled=state.editing||state.pending||state.mediaBusy;
    header.append(retry);
  }
  wrapper.append(header);
  if (closed) wrapper.append(el('p', 'position-locked-note', 'Заказ уже завершён или передан на монтаж. Для новой позиции сначала верните его в рабочий статус.'));
  const items = el('div', 'position-list');
  if (!list(order.items).length) items.append(el('div', 'position-empty', 'Пока нет позиций. Выберите тип изделия и заполните только нужные параметры.'));
  list(order.items).forEach((item, index) => {
    const card = el('article', 'position-card');
    const number = el('span', 'position-number', String(index + 1).padStart(2, '0'));
    const body = el('div', 'position-card-body');
    const heading = el('div', 'position-card-heading');
    heading.append(el('strong', '', item.name || 'Позиция без названия'), el('span', '', compactMoney(item.amount)));
    body.append(heading);
    const configured = positionConfiguration(item);
    if (configured) {
      const summary = el('div', 'position-config-summary');
      mountOrderConfigurator(summary, { initial: { items: [configured], editor: null, editingIndex: null, showCatalog: false }, readOnly: true });
      body.append(summary);
    } else if (item.description) body.append(el('p', 'position-description', item.description));
    const facts = el('div', 'position-facts');
    (configured ? [] : positionFacts(item)).forEach(value => facts.append(el('span', '', value)));
    const stages = list(order.production).filter(stage => text(stage.product) === text(item.name) && text(stage.name) !== 'Монтаж');
    if (stages.length) facts.append(el('span', '', `${pluralLabel(stages.length, 'этап', 'этапа', 'этапов')} · ${stages.filter(stage => stage.done).length} готово`));
    if (facts.children.length) body.append(facts);
    const edit = configured && ['name','description','width','height','quantity'].every(key=>item.edit?.fields?.some(f=>f.id===key&&f.editable)) ? button('Изменить параметры', 'button button-outline position-edit-button', () => editConfiguredPosition(item), 'edit') : entityEditButton(item, 'Позиция заказа', 'button button-outline position-edit-button');
    if (edit) edit.disabled = state.editing || state.pending || state.mediaBusy;
    card.append(number, body);
    const actions=el('div','position-actions');
    if (edit) actions.append(edit);
    if(item.edit?.record){
      const remove=button('Удалить','button button-danger-soft position-delete-button',()=>removePosition(order,item));
      remove.setAttribute('aria-label',`Удалить позицию: ${item.name||'Без названия'}`);
      const linked=list(order.production).some(stage=>text(stage.product)===text(item.name));
      remove.disabled=state.editing||Boolean(state.pending)||state.mediaBusy||closed||linked;
      if(closed)remove.title='Сначала верните заказ в рабочий статус';
      else if(linked)remove.title='Позиция связана с производственными заданиями';
      actions.append(remove);
      if(linked)actions.append(el('span','position-delete-note','Удаление недоступно: есть производственные задания'));
    }
    card.append(actions);
    items.append(card);
  });
  wrapper.append(items);
  const { original, comment } = orderCommentParts(order.comment);
  const comments = el('section', 'detail-section order-comment-section');
  const commentHeading = el('div', 'installation-heading');
  commentHeading.append(el('h3', 'section-label', 'Комментарий к заказу'));
  if (list(order.edit?.fields).some(field => field.id === 'comment' && field.editable)) {
    const edit = button(comment ? 'Изменить' : 'Добавить', 'inline-edit', () => editEntity(order, 'Комментарий к заказу', null, true), 'edit');
    edit.setAttribute('aria-label', comment ? 'Изменить комментарий к заказу' : 'Добавить комментарий к заказу');
    edit.dataset.focusKey = 'edit-order-comment';
    edit.disabled = Boolean(state.editing || state.pending || state.mediaBusy);
    commentHeading.append(edit);
  }
  comments.append(commentHeading, el('div', comment ? 'note-box' : 'detail-empty', comment || 'Комментарий пока не добавлен.'));
  wrapper.append(comments);
  if (original) {
    const source = el('details', 'original-composition');
    source.append(el('summary', '', 'Исходное описание при создании заказа'), el('div', 'note-box', original));
    wrapper.append(source);
  }
  if (overview) wrapper.classList.add('positions-overview');
  return wrapper;
}
function renderStage(stage) {
  const done = stage.done === true;
  const item = el('article', 'stage-item');
  const check = el('span', `stage-check${done ? ' done' : ''}`);
  check.setAttribute('aria-hidden', 'true');
  if (done) check.append(icon('check'));
  const body = el('div');
  body.append(el('h4', 'stage-title', stage.name || 'Этап без названия'));
  if (stage.product) body.append(el('p', 'stage-product', stage.product));
  const meta = el('div', 'stage-meta');
  if (stage.assignee) meta.append(el('span', '', `Ответственный: ${stage.assignee}`));
  if (stage.availability) meta.append(el('span', '', `Доступность: ${stage.availability}`));
  if (stage.planDate) meta.append(el('span', '', `План: ${dateLabel(stage.planDate)}`));
  if (stage.actualDate) meta.append(el('span', '', `Факт: ${dateLabel(stage.actualDate)}`));
  if (meta.children.length) body.append(meta);
  if (stage.comment) body.append(el('p', 'stage-comment', stage.comment));
  const edit = entityEditButton(stage, 'Этап производства');
  if (edit) body.append(edit);
  item.append(check, body, el('span', `stage-state${done ? ' done' : ''}`, done ? 'Готово' : 'Не завершён'));
  return item;
}
function renderProduction(order) {
  const wrapper = el('div');
  const info = productionInfo(order);
  const summary = el('div', 'stage-summary');
  const summaryText = el('p');
  summaryText.append(el('strong', '', `${info.done} из ${info.total}`), document.createTextNode(' этапов производства готовы'));
  summary.append(summaryText, progressBar(info.done, info.total));
  wrapper.append(summary);
  if (manufacturingDone(order) && order.status !== 'Отменён') wrapper.append(el('p', 'ready-notice', `Изделие готово${order.readyDate ? ` с ${dateLabel(order.readyDate, true)}` : ''}. Отметки отдельных этапов показаны по таблице.`));
  const stages = el('div', 'stage-list');
  if (info.manufacture.length) info.manufacture.forEach((stage) => stages.append(renderStage(stage)));
  else stages.append(el('p', 'detail-empty', 'Этапы производства ещё не добавлены.'));
  wrapper.append(detailSection('Производство', stages));
  const installation = el('div', 'stage-list');
  if (info.installation.length) info.installation.forEach((stage) => installation.append(renderStage(stage)));
  else installation.append(el('p', 'detail-empty', 'Монтаж в таблице не указан.'));
  if (info.installation.length) wrapper.append(detailSection('Этап «Монтаж» в исходной таблице', installation, 'production-installation'));
  wrapper.append(renderInstallations(order));
  const note = el('div', 'production-note');
  note.append(icon('info'), el('span', '', 'Изменения этапов сохраняются в таблице. Готовность изделия и согласованный выезд на монтаж учитываются отдельно.'));
  wrapper.append(note);
  return wrapper;
}
function ledger(entries, type) {
  const wrapper = el('div');
  if (!entries.length) { wrapper.append(el('p', 'detail-empty', type === 'payment' ? 'Платежи по заказу ещё не записаны.' : 'Расходы по заказу ещё не записаны.')); return wrapper; }
  const rows = el('div', 'ledger-list');
  for (const entry of entries) {
    const row = el('div', 'ledger-row');
    const description = el('div', 'ledger-text', type === 'payment' ? entry.kind || 'Платёж' : entry.description || entry.category || 'Расход');
    const details = [type === 'expense' && entry.description ? entry.category : '', entry.account, entry.comment].filter(Boolean).join(' · ');
    if (details) description.append(el('small', '', details));
    const edit = entityEditButton(entry, type === 'payment' ? 'Платёж' : 'Расход');
    if (edit) description.append(edit);
    row.append(el('span', 'ledger-date', entry.date ? dateLabel(entry.date) : 'Без даты'), description, el('span', `ledger-amount${type === 'expense' ? ' expense-amount' : ''}`, compactMoney(entry.amount)));
    rows.append(row);
  }
  const total = el('div', 'ledger-total');
  total.append(el('span', '', 'Итого по записям'), el('strong', '', compactMoney(sum(entries.map((entry) => entry.amount)))));
  wrapper.append(rows, total);
  return wrapper;
}
function renderFinance(order) {
  const wrapper = el('div');
  wrapper.append(moneySummary(order));
  const edit = entityEditButton(order, 'Расчёт заказа', 'inline-edit finance-edit');
  if (edit) { edit.textContent = 'Изменить исходные значения расчёта'; wrapper.append(edit); }
  const extra = el('dl', 'finance-extra');
  extra.append(detailRow('Себестоимость', compactMoney(order.cost)), detailRow('Доп. расходы', compactMoney(order.extraCost)), detailRow('Оценочная прибыль · 50% до рекламы', compactMoney(order.profit)));
  wrapper.append(extra, detailSection(`Платежи · ${list(order.payments).length}`, ledger(list(order.payments), 'payment')), detailSection(`Расходы · ${list(order.expenses).length}`, ledger(list(order.expenses), 'expense')));
  wrapper.append(el('p', 'finance-note', 'Сумма, оплата и остаток рассчитываются в таблице. Прибыль на сайте — временная оценка: 50% суммы заказа до рекламы. Исходные затраты и формулы таблицы сохранены. Отрицательный остаток отображается как переплата.'));
  return wrapper;
}

function privateMediaUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(text(value), location.origin);
    return url.origin === location.origin && url.pathname.startsWith('/kanban/api/orders/') && url.pathname.includes('/media/') ? url.href : null;
  } catch { return null; }
}
function renderMedia(order) {
  const openDocuments = () => {
    if (state.mediaBusy) return;
    state.dialogTab = 'documents'; renderDialog();
    $('order-dialog').querySelector('[data-focus-key="tab-documents"]')?.focus({ preventScroll: true });
  };
  const entry = el('section', 'media-document-entry');
  const create = button('Счёт или УПД', 'button button-primary', openDocuments, 'table');
  create.disabled = state.mediaBusy;
  entry.append(create, el('p', 'media-description', 'Выставьте счёт на оплату или оформите УПД после завершения заказа. PDF сохранится здесь.'));
  const notice = documentUI.pendingNotice(order, openDocuments);
  notice?.querySelectorAll('button').forEach((element) => { element.disabled = state.mediaBusy; });
  const gallery = createMediaGallery({
    orderId: order.id,
    media: order.media,
    api,
    onChange: (media) => {
      const target = currentOrder(order.id);
      if (target) target.media = media;
      renderBoard();
    },
    onBusy: (busy) => {
      state.mediaBusy = busy;
      create.disabled = busy;
      notice?.querySelectorAll('button').forEach((element) => { element.disabled = busy; });
      $('order-dialog').querySelectorAll('.dialog-tab,.dialog-edit,.dialog-close,.dialog-bottom button').forEach((element) => { element.disabled = busy; });
      if ($('order-status')) $('order-status').disabled = busy || Boolean(state.pending);
    },
  });
  const wrapper = el('div'); wrapper.append(entry); if (notice) wrapper.append(notice); wrapper.append(gallery); return wrapper;
}
async function acceptEditResult(result) {
  const board = result?.board || result;
  if (Array.isArray(board?.orders) && Array.isArray(board?.statuses)) {
    state.board = validBoard(board);
    render();
    openRequestedOrder();
    updateSyncTime();
    if ($('order-dialog').open) renderDialog({ keepFocus: true });
  } else await loadBoard({ fresh: true });
  showToast('Изменения сохранены в таблице');
}
function rememberPositionCreation(value) {
  pendingPositionCreation = value;
  try {
    if (value) sessionStorage.setItem(NEW_POSITION_STORAGE_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(NEW_POSITION_STORAGE_KEY);
  } catch {}
}
function templateRouteLabel(template) {
  if (!list(template.stages).length) return template.id === 'custom' ? 'Маршрут назначит технолог' : 'Маршрут для шаблона пока не настроен';
  const hours = Number(template.totalHours) || 0;
  const minutes = Math.round(hours * 60);
  const duration = [Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)} ч` : '', minutes % 60 ? `${minutes % 60} мин` : ''].filter(Boolean).join(' ');
  return `${pluralLabel(template.stages.length, 'этап', 'этапа', 'этапов')}${duration ? ` · ${duration}` : ''} · монтаж отдельно`;
}
function positionFields(template, units) {
  if (template.unit && template.unit !== 'позиция') units = [template.unit];
  const common = [
    { key: 'quantity', label: 'Количество', type: 'number', value: 1, required: true, min: 0.01 },
    { key: 'unit', label: 'Единица', type: 'select', value: units.includes('шт') ? 'шт' : units[0], options: units, required: true },
    { key: 'width', label: 'Ширина, м', type: 'number', value: '', min: 0 },
    { key: 'height', label: 'Высота, м', type: 'number', value: '', min: 0 },
  ];
  const finance = [
    { key: 'unitPrice', label: 'Цена за единицу', type: 'number', value: '', min: 0, hint: 'Необязательно — сумму рассчитает таблица.' },
    { key: 'unitCost', label: 'Себестоимость за единицу', type: 'number', value: '', min: 0, hint: 'Можно заполнить позднее.' },
  ];
  if ((template.formKind || template.id) === 'street') return [
    ...common,
    { key: 'face', label: 'Лицевая часть', type: 'select', value: 'Лицо: белый акрил', options: ['Лицо: белый акрил', 'Лицо: красный акрил', 'Лицо: плёнка'] },
    { key: 'edge', label: 'Борт', type: 'select', value: 'Борт: чёрный 40 мм', options: ['Борт: чёрный 40 мм', 'Борт: белый 40 мм', 'Борт: в цвет фасада'] },
    { key: 'light', label: 'Подсветка', type: 'select', value: 'Подсветка: 8500K', options: ['Подсветка: 8500K', 'Подсветка: 4000K', 'Без подсветки'] },
    { key: 'note', label: 'Уточнения для производства', type: 'textarea', value: '', rows: 3, fullWidth: true, placeholder: 'Каркас, кассета, аппликация, адрес или особенности крепления…' },
    ...finance,
  ];
  if ((template.formKind || template.id) === 'neon') return [
    ...common,
    { key: 'color', label: 'Цвет неона', type: 'select', value: 'Розовый неон', options: ['Розовый неон', 'Белый неон', 'Тёплый белый неон', 'Цвет по образцу'] },
    { key: 'base', label: 'Основание', type: 'select', value: 'Прозрачный акрил', options: ['Прозрачный акрил', 'Чёрный акрил', 'Без основания'] },
    { key: 'mounting', label: 'Крепление', type: 'select', value: 'Подвес на тросиках', options: ['Подвес на тросиках', 'Дистанционные держатели', 'Скрытое крепление'] },
    { key: 'note', label: 'Уточнения для производства', type: 'textarea', value: '', rows: 3, fullWidth: true, placeholder: 'Вывод питания, блок питания, макет и особые требования…' },
    ...finance,
  ];
  if ((template.formKind || template.id) === 'plotter') return [
    ...common,
    { key: 'material', label: 'Материал', type: 'select', value: 'Матовая плёнка', options: ['Матовая плёнка', 'Глянцевая плёнка', 'Трафаретная плёнка'] },
    { key: 'color', label: 'Цвет', type: 'select', value: 'Чёрный', options: ['Чёрный', 'Белый', 'Цвет по образцу'] },
    { key: 'artwork', label: 'Макет', type: 'select', value: 'Макет готов', options: ['Макет готов', 'Нужна подготовка', 'Нужна отрисовка'] },
    { key: 'note', label: 'Уточнения для производства', type: 'textarea', value: '', rows: 3, fullWidth: true, placeholder: 'Поверхность, способ переноса, требования к выборке…' },
    ...finance,
  ];
  return [
    ...(template.id === 'custom' ? [{ key: 'name', label: 'Название работы', type: 'text', value: '', required: true, fullWidth: true, placeholder: 'Например: Стеллаж для цветов' }] : []),
    { key: 'description', label: 'Свободное описание', type: 'textarea', value: '', required: true, rows: 7, fullWidth: true, placeholder: 'Размеры, материалы, цвет, крепление, особенности объекта и ожидаемый результат…' },
    ...common, ...finance,
  ];
}
function buildPosition(template, values) {
  const note = text(values.note);
  let description;
  if ((template.formKind || template.id) === 'street') description = [values.face, values.edge, values.light, note].filter(Boolean).join('. ');
  else if ((template.formKind || template.id) === 'neon') description = [values.color, values.base, values.mounting, note].filter(Boolean).join('. ');
  else if ((template.formKind || template.id) === 'plotter') description = [values.material, `Цвет: ${values.color}`, values.artwork, note].filter(Boolean).join('. ');
  else description = text(values.description);
  return {
    template: template.id,
    name: template.id === 'custom' ? text(values.name) : template.name,
    description,
    unit: values.unit,
    width: values.width,
    height: values.height,
    quantity: values.quantity,
    unitPrice: values.unitPrice,
    unitCost: values.unitCost,
  };
}
function openPositionEditor(order, descriptor, template, pending = null) {
  let requestId = pending?.requestId || crypto.randomUUID();
  let submitted = pending ? { position: pending.position, values: pending.values } : null;
  openRecordEditor({
    title: template.name,
    subtitle: templateRouteLabel(template),
    eyebrow: 'НОВАЯ ПОЗИЦИЯ',
    creationTitle: 'Добавление позиции',
    sourceLabel: 'Позиция',
    busyLabel: 'Добавляем…',
    retryLabel: 'Проверить добавление',
    fields: positionFields(template, descriptor.units),
    values: submitted?.values || {},
    mode: 'create',
    pendingCreation: Boolean(submitted),
    submitLabel: 'Добавить позицию',
    submit: async (_changes, all) => {
      submitted ||= { position: buildPosition(template, all), values: { ...all } };
      rememberPositionCreation({ requestId, orderId: String(order.id), templateId: template.id, ...submitted });
      try {
        const result = await api(`/orders/${encodeURIComponent(order.id)}/positions`, { method: 'POST', body: JSON.stringify({ requestId, position: submitted.position }) });
        validBoard(result);
        rememberPositionCreation(null);
        return result;
      } catch (error) {
        if (POSITION_CREATION_SAFE_ERRORS.has(error.code)) {
          submitted = null;
          requestId = crypto.randomUUID();
          rememberPositionCreation(null);
          error.creationSafeFailure = true;
        } else error.creationPending = true;
        throw error;
      }
    },
    onSaved: (board) => {
      state.board = validBoard(board);
      state.hasSyncError = false;
      setBoardError('');
      render();
      updateSyncTime();
      state.dialogTab = 'positions';
      renderDialog();
      const count = Number(board.createdPosition?.routeStageCount) || 0;
      showToast(count ? `Позиция добавлена · создано этапов: ${count}` : 'Позиция добавлена в таблицу');
    },
    onClose: () => { state.editing = false; if ($('order-dialog').open) renderDialog({ keepFocus: true }); },
  });
}
function rememberPositionDeletion(value){
  pendingPositionDeletion=value;
  try{if(value)sessionStorage.setItem(DELETE_POSITION_STORAGE_KEY,JSON.stringify(value));else sessionStorage.removeItem(DELETE_POSITION_STORAGE_KEY);}catch{}
}
function removePosition(order,item){
  if(!state.authenticated||state.editing||state.pending||state.mediaBusy)return;
  if(pendingPositionDeletion&&pendingPositionDeletion.orderId!==String(order.id)){
    showToast(`Сначала проверьте удаление в заказе ${displayId(pendingPositionDeletion.orderId)}.`,{error:true});return;
  }
  const pending=pendingPositionDeletion;
  if(pending&&item&&(pending.record.key!==item.edit?.record?.key||pending.record.rowNumber!==item.edit?.record?.rowNumber)){
    showToast('Сначала завершите проверку предыдущего удаления.',{error:true});return;
  }
  const target=pending?.item||item;
  if(!target?.edit?.record)return;
  state.editing=true;
  let request=pending||{requestId:crypto.randomUUID(),orderId:String(order.id),record:target.edit.record,item:target};
  openRecordEditor({
    title:'Удалить позицию?',eyebrow:`ЗАКАЗ ${displayId(order.id)}`,
    subtitle:'Позиция будет удалена из состава и таблицы. Суммы по позициям пересчитаются. Сумма заказа, заданная вручную, и платежи сохранятся.',
    fields:[{key:'product',label:'Изделие',value:target.name,readOnly:true,fullWidth:true,hint:positionFacts(target).join(' · ')},{key:'description',label:'Характеристики',value:target.description,readOnly:true,fullWidth:true,hint:'Проверьте, что выбрали нужную позицию.'}],
    mode:'create',sourceLabel:'Удаление',creationTitle:'Удаление позиции',pendingCreation:Boolean(pending),
    submitLabel:'Удалить позицию',busyLabel:'Удаляем…',retryLabel:'Проверить удаление',createHint:'Удаление выполнится только после нажатия кнопки',
    enhance:({dialog})=>{const save=dialog.querySelector('button[type=submit]');save.classList.remove('button-primary');save.classList.add('button-danger-soft');},
    submit:async()=>{
      rememberPositionDeletion(request);
      try{
        const result=validBoard(await api(`/orders/${encodeURIComponent(order.id)}/positions`,{method:'DELETE',body:JSON.stringify({requestId:request.requestId,record:request.record})}));
        if(!result.deletedPosition)throw new Error('Сервер пока не подтвердил удаление.');
        rememberPositionDeletion(null);return result;
      }catch(error){
        if(['INVALID_REQUEST_ID','INVALID_POSITION_DELETE','POSITION_DELETE_SOURCE_CHANGED','POSITION_DELETE_SCHEMA','POSITION_DELETE_PRODUCTION','POSITION_DELETE_PENDING','POSITION_ORDER_CLOSED'].includes(error.code)||error.code?.startsWith('SHEETS_CONTRACT_')){
          rememberPositionDeletion(null);request={...request,requestId:crypto.randomUUID()};error.creationSafeFailure=true;
        }else{error.creationPending=true;if(error.status===401)scheduleSessionRenewal();}
        throw error;
      }
    },
    onSaved:async board=>{await acceptEditResult(board);showToast('Позиция удалена из заказа');},
    onClose:()=>{state.editing=false;if($('order-dialog').open)renderDialog({keepFocus:true});},
  });
}
function saveConfiguratorOption(scope, value) {
  return api('/configurator', { method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID(), scope, value }) }).then(result => result.options);
}
function openConfiguredPositionCreator(order, catalog, pending) {
  let configurator;
  let submitted = pending;
  openRecordEditor({
    title: 'Добавить изделия', eyebrow: `ЗАКАЗ ${displayId(order.id)}`,
    subtitle: order.title, fields: [], mode: 'create',
    submitLabel: 'Сохранить в заказ', creationTitle: 'Добавление изделий',
    retryLabel: 'Проверить добавление', pendingCreation: Boolean(pending),
    enhance: ({ grid, changed }) => {
      const host = el('section', 'record-config-section'); grid.append(host);
      configurator = mountOrderConfigurator(host, { options: catalog.options, initial: pending?.configDraft,
        onChange: changed, saveOption: saveConfiguratorOption });
      return configurator;
    },
    submit: async () => {
      if (!submitted) {
        const positions = configurator.positions().map(position => ({ requestId: crypto.randomUUID(), position }));
        if (!positions.length) throw Object.assign(new Error('Выберите и добавьте хотя бы одно изделие.'), { creationSafeFailure: true, status: 422 });
        submitted = { kind: 'configurator', requestId: crypto.randomUUID(), orderId: String(order.id), positions, completed: 0, configDraft: configurator.state() };
      }
      rememberPositionCreation(submitted);
      try {
        let result;
        while (submitted.completed < submitted.positions.length) {
          result = validBoard(await api(`/orders/${encodeURIComponent(order.id)}/positions`, { method: 'POST', body: JSON.stringify(submitted.positions[submitted.completed]) }));
          if (!result.createdPosition) throw new Error('Сервер ещё не подтвердил позицию.');
          submitted.completed++; rememberPositionCreation(submitted);
        }
        rememberPositionCreation(null);
        return result || validBoard(await api('/board?fresh=1'));
      } catch (error) {
        if (!submitted.completed && POSITION_CREATION_SAFE_ERRORS.has(error.code)) {
          submitted = null; rememberPositionCreation(null); error.creationSafeFailure = true;
        } else {
          error.creationPending = true;
          error.message = `Подтверждено изделий: ${submitted.completed} из ${submitted.positions.length}. ${error.message} Повторная проверка продолжит добавление без дублей.`;
        }
        throw error;
      }
    },
    onSaved: async board => { state.dialogTab = 'positions'; await acceptEditResult(board); },
    onClose: () => { state.editing = false; if ($('order-dialog').open) renderDialog({ keepFocus: true }); },
  });
}
async function editConfiguredPosition(item) {
  if (!item.edit || state.editing || state.pending || state.mediaBusy) return;
  state.editing = true;
  try {
    const catalog = await api('/configurator');
    state.editing = false;
    editEntity(item, 'Параметры изделия', catalog);
  } catch (error) { state.editing = false; showToast(error.message, { error: true }); }
}
async function createPosition(order) {
  if (!state.authenticated || state.editing || state.pending || state.mediaBusy || state.dragId !== null) return;
  if (pendingPositionCreation && pendingPositionCreation.orderId !== String(order.id)) {
    showToast(`Сначала проверьте добавление позиции в заказе ${displayId(pendingPositionCreation.orderId)}.`, { error: true });
    return;
  }
  state.editing = true;
  renderDialog({ keepFocus: true });
  try {
    const descriptor = await api(`/orders/${encodeURIComponent(order.id)}/positions/new`);
    if (!Array.isArray(descriptor.templates) || !descriptor.templates.length || !Array.isArray(descriptor.units) || !descriptor.units.length) throw new Error('Не удалось загрузить шаблоны позиций.');
    const pending = pendingPositionCreation?.orderId === String(order.id) ? pendingPositionCreation : null;
    if (pending && pending.kind !== 'configurator') {
      const template = descriptor.templates.find(value => value.id === pending.templateId);
      if (!template) throw new Error('Шаблон ожидающей позиции больше недоступен.');
      openPositionEditor(order, descriptor, template, pending);
    } else openConfiguredPositionCreator(order, await api('/configurator'), pending);
  } catch (error) {
    state.editing = false;
    renderDialog({ keepFocus: true });
    if (error.status === 401) showLogin('Сессия закончилась. Введите PIN ещё раз.');
    else showToast(error.message, { error: true });
  }
}
function rememberOrderCreation(value) {
  pendingOrderCreation = value;
  try {
    if (value) sessionStorage.setItem(NEW_ORDER_STORAGE_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(NEW_ORDER_STORAGE_KEY);
  } catch {}
}
function rememberClientCreation(value) {
  pendingClientCreation = value;
  try {
    if (value) sessionStorage.setItem(NEW_CLIENT_STORAGE_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(NEW_CLIENT_STORAGE_KEY);
  } catch {}
}
function mapClientCreationFields(descriptor) {
  const sections = {
    companyName: { section: 'Клиент', sectionHint: 'Основные данные карточки клиента.' },
    type: { section: 'Клиент' },
    name: { section: 'Контакты', sectionHint: 'К кому обращаться по заказу.' },
    phone: { section: 'Контакты' },
    email: { section: 'Контакты' },
    requisites: { section: 'Реквизиты и источник', sectionHint: 'Дополнительные данные можно заполнить позже.' },
    source: { section: 'Реквизиты и источник' },
    createdDate: { section: 'Реквизиты и источник' },
    comment: { section: 'Комментарий' },
  };
  return descriptor.fields.map((field) => {
    const key = field.id || field.key;
    return {
      key,
      label: field.label || key,
      type: field.type,
      value: field.value,
      readOnly: field.editable === false || Boolean(field.readOnly),
      required: Boolean(field.required || key === 'companyName'),
      options: field.options,
      hint: field.hint || field.reason,
      min: field.minimum ?? field.min,
      max: field.maximum ?? field.max,
      maxLength: field.maxLength,
      autocomplete: key === 'companyName' ? 'organization' : key === 'name' ? 'name' : key === 'phone' ? 'tel' : key === 'email' ? 'email' : undefined,
      fullWidth: ['companyName', 'requisites', 'comment'].includes(key) || field.type === 'textarea',
      ...sections[key],
    };
  });
}
function scheduleSessionRenewal() {
  setTimeout(() => {
    if (sessionRenewalOpen) return;
    sessionRenewalOpen = true;
    openRecordEditor({
      title: 'Вход в мастерскую',
      subtitle: 'Введите PIN ещё раз. Открытые формы и введённые значения останутся на месте.',
      fields: [{ key: 'pin', label: 'PIN-код', type: 'password', required: true, fullWidth: true, autocomplete: 'current-password', maxLength: 256 }],
      mode: 'create',
      eyebrow: 'СЕССИЯ ЗАКОНЧИЛАСЬ',
      sourceLabel: 'Сессия',
      createHint: 'Черновики останутся открытыми',
      creationTitle: 'Вход',
      submitLabel: 'Войти',
      busyLabel: 'Проверяем PIN…',
      allowCopy: false,
      submit: async (_changes, all) => {
        try {
          const result = await api('/session', { method: 'POST', body: JSON.stringify({ pin: all.pin }) });
          if (result.authenticated !== true) throw new Error('Не удалось подтвердить вход.');
          state.authenticated = true;
          return result;
        } catch (error) {
          error.creationSafeFailure = true;
          throw error;
        }
      },
      onSaved: () => showToast('Сессия восстановлена. Можно продолжить.'),
      onClose: () => { sessionRenewalOpen = false; },
    });
  }, 0);
}
async function openClientCreator(parentEditor) {
  let descriptor;
  try { descriptor = await api('/clients/new'); }
  catch (error) {
    if (error.status === 401) {
      error.message = 'Сессия закончилась. Войдите во всплывающем окне: черновик заказа останется открытым.';
      scheduleSessionRenewal();
    }
    throw error;
  }
  if (!parentEditor.isOpen()) return;
  if (!Array.isArray(descriptor.fields) || !descriptor.fields.length) throw new Error('Не удалось загрузить поля нового клиента.');
  let requestId = pendingClientCreation?.requestId || crypto.randomUUID();
  let submitted = pendingClientCreation?.changes || null;
  openRecordEditor({
    title: 'Новый клиент',
    subtitle: 'После сохранения клиент будет выбран в текущем заказе. Контакты можно изменить позже из карточки заказа.',
    fields: mapClientCreationFields(descriptor),
    values: submitted || {},
    mode: 'create',
    pendingCreation: Boolean(submitted),
    eyebrow: 'СОЗДАНИЕ КЛИЕНТА',
    sourceLabel: 'Клиент',
    creationTitle: 'Создание клиента',
    submitLabel: 'Создать клиента',
    busyLabel: 'Создаём клиента…',
    retryLabel: 'Проверить клиента',
    enhance: enhanceRequisitesEditor,
    refreshSource: async () => {
      const fresh = await api('/clients/new');
      if (!Array.isArray(fresh.fields) || !fresh.fields.length) throw new Error('Не удалось обновить поля нового клиента.');
      return mapClientCreationFields(fresh);
    },
    submit: async (_changes, all) => {
      submitted ||= { ...all };
      rememberClientCreation({ requestId, changes: submitted });
      parentEditor.setActionLabel('client', 'Проверить клиента');
      try {
        const created = await api('/clients', { method: 'POST', body: JSON.stringify({ requestId, changes: submitted }) });
        if (!created?.id || !created?.name) throw new Error('Сервер не подтвердил созданного клиента. Нажмите «Проверить клиента», чтобы получить результат без повторной записи.');
        rememberClientCreation(null);
        return created;
      } catch (error) {
        const sessionExpired = error.status === 401;
        if (CLIENT_CREATION_SAFE_ERRORS.has(error.code) || sessionExpired) {
          submitted = null;
          requestId = crypto.randomUUID();
          rememberClientCreation(null);
          parentEditor.setActionLabel('client', '+ Создать нового клиента');
          error.creationSafeFailure = true;
          if (sessionExpired) {
            error.message = 'Сессия закончилась. Войдите во всплывающем окне и повторите создание: оба черновика сохранены.';
            scheduleSessionRenewal();
          }
        } else {
          parentEditor.setActionLabel('client', 'Проверить клиента');
          error.creationPending = true;
        }
        throw error;
      }
    },
    onSaved: (created) => {
      parentEditor.addOption('client', { value: created.name, label: created.name, phone:submitted?.phone||'', contact:submitted?.name||'' }, { select: true });
      parentEditor.setActionLabel('client', '+ Создать нового клиента');
      showToast(created.created === false ? `Клиент ${created.id} уже есть и выбран` : `Клиент ${created.id} создан и выбран`);
    },
  });
}
async function createOrder() {
  if (!state.authenticated || state.editing || state.pending || state.mediaBusy || state.dragId !== null) return;
  if (!state.board) { showToast('Дождитесь загрузки доски и повторите попытку.', { error: true }); return; }
  state.editing = true;
  state.fetchVersion += 1;
  const trigger = $('create-order');
  trigger.disabled = true;
  trigger.setAttribute('aria-busy', 'true');
  try {
    const [descriptor,catalog] = await Promise.all([api('/orders/new'),api('/configurator')]);
    let configurator;
    let positions = pendingOrderCreation?.positions || null;
    let createdId = pendingOrderCreation?.createdId || null;
    let completed = pendingOrderCreation?.completed || 0;
    let configDraft = pendingOrderCreation?.configDraft || null;
    let userComment = pendingOrderCreation?.userComment;
    if (!Array.isArray(descriptor.fields) || !descriptor.fields.length) throw new Error('Не удалось загрузить поля нового заказа. Обновите данные и повторите попытку.');
    let requestId = pendingOrderCreation?.requestId || crypto.randomUUID();
    let submitted = pendingOrderCreation?.changes || null;
    const sections = {
      title: { section: 'Заказ', sectionHint: 'Что делаем и когда приняли заказ.' },
      createdDate: { section: 'Заказ' },
      client: { section: 'Клиент и ответственный', sectionHint: 'Выберите клиента и менеджера проекта.' },
      manager: { section: 'Клиент и ответственный' },
      amountOverride: { section: 'Бюджет и сроки', sectionHint: 'Необязательные ручные значения. Итоги пересчитает таблица.' },
      costOverride: { section: 'Бюджет и сроки' },
      desiredDate: { section: 'Бюджет и сроки' },
      dueOverride: { section: 'Бюджет и сроки' },
      comment: { section: 'Комментарий' },
    };
    openRecordEditor({
      title: 'Новый заказ',
      subtitle: `Заказ появится в столбце «${descriptor.initialStatus || 'Расчёт / КП'}». Детали заказа можно изменить после создания.`,
      fields: descriptor.fields.map((field) => {
        const key = field.id || field.key;
        return {
          key,
          label: field.label || key,
          type: field.type,
          value: field.value,
          readOnly: field.editable === false || Boolean(field.readOnly),
          required: Boolean(field.required || key === 'title' || key === 'client'),
          options: field.options,
          searchable:key==='client', contacts:field.contacts,
          hint: field.hint || field.reason || (key === 'dueOverride' ? 'Если пусто, используем желаемую дату клиента.' : ''),
          min: field.minimum ?? field.min,
          max: field.maximum ?? field.max,
          maxLength: field.maxLength,
           fullWidth: ['title', 'comment'].includes(key) || field.type === 'textarea',
          ...sections[key],
          ...(!submitted && key === 'client' ? {
            actionLabel: pendingClientCreation ? 'Проверить клиента' : '+ Создать нового клиента',
            action: openClientCreator,
          } : {}),
        };
      }),
      values: submitted ? {...submitted,comment:userComment??submitted.comment} : {},
      enhance:({controls,changed})=>{
        const host=document.createElement('section');host.className='record-config-section';
        controls.get('comment').group.closest('.record-section').before(host);
        configurator=mountOrderConfigurator(host,{options:catalog.options,initial:configDraft,onChange:changed,saveOption:async(scope,value)=>{
          const result=await api('/configurator',{method:'POST',body:JSON.stringify({requestId:crypto.randomUUID(),scope,value})});return result.options;
        }});
        const comment=controls.get('comment').input;const sync=()=>configurator.setComment(comment.value);comment.addEventListener('input',sync);sync();
        return {...configurator,destroy:()=>comment.removeEventListener('input',sync)};
      },
      mode: 'create',
      pendingCreation: Boolean(submitted),
      submitLabel: 'Создать заказ',
      submit: async (_changes, all) => {
        if(!submitted){
          positions=configurator.positions().map(position=>({requestId:crypto.randomUUID(),position}));
          configDraft=configurator.state();userComment=all.comment||'';
          const comment=userComment;
          if(comment.length>12000)throw Object.assign(new Error('Описание заказа слишком длинное. Сократите дополнительные варианты или разделите заказ.'),{creationSafeFailure:true,status:422});
          submitted={...all,comment};
        }
        const remember=()=>rememberOrderCreation({requestId,changes:submitted,positions,createdId,completed,configDraft,userComment});
        remember();
        try {
          let result = createdId ? await api('/board?fresh=1') : await api('/orders', { method: 'POST', body: JSON.stringify({ requestId, changes: submitted }) });
          validBoard(result);
          if (!createdId && (!result.createdOrderId || !result.orders.some((order) => String(order.id) === String(result.createdOrderId)))) throw new Error('Сервер не подтвердил созданный заказ. Нажмите «Проверить создание», чтобы получить результат без повторного заказа.');
          createdId ||= result.createdOrderId;remember();
          for(;completed<(positions?.length||0);){
            result=await api(`/orders/${encodeURIComponent(createdId)}/positions`,{method:'POST',body:JSON.stringify(positions[completed])});
            validBoard(result);if(!result.createdPosition)throw new Error('Позиция пока не подтверждена. Проверьте создание повторно.');completed++;remember();
          }
          rememberOrderCreation(null);
          return {...result,createdOrderId:createdId};
        } catch (error) {
          const sessionExpired = error.status === 401;
          if (!createdId && (ORDER_CREATION_SAFE_ERRORS.has(error.code) || sessionExpired)) {
            submitted = null;
            requestId = crypto.randomUUID();
            rememberOrderCreation(null);
            error.creationSafeFailure = true;
            if (sessionExpired) {
              error.message = 'Сессия закончилась. Войдите во всплывающем окне и повторите создание: черновик заказа сохранён.';
              scheduleSessionRenewal();
            }
          } else {
            if(createdId)error.message=`Заказ №${createdId} сохранён. Подтверждено позиций: ${completed} из ${positions?.length||0}. ${error.message} Повторная проверка продолжит ту же заявку.`;
            if(sessionExpired)scheduleSessionRenewal();
            error.creationPending = true;
          }
          throw error;
        }
      },
      onSaved: (board) => {
        state.board = validBoard(board);
        state.query = '';
        state.manager = '';
        state.hasSyncError = false;
        $('search').value = '';
        $('manager').value = '';
        setBoardError('');
        render();
        updateSyncTime();
        const card = $('board').querySelector(`[data-order-id="${CSS.escape(String(board.createdOrderId))}"]`);
        card?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        openDialog(board.createdOrderId);
        showToast(`Заказ ${displayId(board.createdOrderId)} создан в таблице`);
      },
      onClose: () => { state.editing = false; trigger.disabled = false; },
    });
  } catch (error) {
    state.editing = false;
    trigger.disabled = false;
    if (error.status === 401) showLogin('Сессия закончилась. Введите PIN ещё раз.');
    else showToast(error.message, { error: true });
  } finally { trigger.removeAttribute('aria-busy'); }
}
function entityEditButton(entity, title, className = 'inline-edit') {
  if (!entity?.edit || !list(entity.edit.fields).some((field) => field.editable)) return null;
  const edit = button('Изменить', className, () => editEntity(entity, title), 'edit');
  edit.dataset.focusKey = `edit-${entity.edit.type}-${entity.edit.record?.key || ''}`;
  edit.setAttribute('aria-label', `Изменить: ${title}`);
  return edit;
}
function editEntity(entity, title, catalog = null, commentOnly = false, fieldOnly = null) {
  if (!entity.edit || state.editing || state.pending || state.mediaBusy) return;
  state.editing = true;
  let editDescriptor = entity.edit;
  const mapFields = (descriptor) => descriptor.fields.filter(field => (!commentOnly || field.id === 'comment') && (!fieldOnly || field.id === fieldOnly)).map((field) => ({
    key: field.id,
    label: field.label || field.id,
    type: field.type,
    value: commentOnly ? orderCommentParts(field.value).comment : field.value,
    ...(commentOnly ? { rows: 8, maxLength: 12000 } : {}),
    readOnly: !field.editable,
    required: Boolean(field.required),
    searchable: descriptor.type === 'order' && field.id === 'client',
    contacts: field.contacts,
    options: descriptor.type === 'order' && field.id === 'status' && field.value !== 'Сдан' ? list(field.options).filter((option) => text(typeof option === 'object' ? option.value : option).trim() !== 'Сдан') : field.options,
    hint: descriptor.type === 'order' && field.id === 'status' ? 'Чтобы завершить заказ и монтаж, используйте кнопку «В архив».' : field.reason || (field.id === 'dueOverride' ? 'Если пусто, используем желаемую дату клиента.' : field.derived || !field.editable ? field.source || 'Рассчитывается из связанных данных' : ''),
    fullWidth: ['textarea'].includes(field.type),
  }));
  const fields = mapFields(editDescriptor);
  let configurator;
  openRecordEditor({
    title,
    subtitle: commentOnly || fieldOnly ? `Заказ ${displayId(entity.id)} · ${entity.title || 'Без названия'}` : 'Измените нужные поля. Расчётные значения обновятся по исходным данным.',
    fields,
    enhance: catalog ? ({grid, controls, editorApi, changed}) => {
      const host = el('section', 'record-config-section'); grid.prepend(host);
      const keys = ['name','description','width','height','quantity'];
      for (const key of keys) { controls.get(key).group.hidden = true; controls.get(key).group.dataset.configField = 'true'; }
      const mount = () => {
        const current = {...entity};
        for (const key of keys) current[key] = controls.get(key).read();
        const item = positionConfiguration(current);
        if (!item) throw new Error('Описание изменилось. Закройте форму и откройте актуальную позицию заново.');
        configurator = null;
        configurator = mountOrderConfigurator(host, {options: catalog.options, singleItem: true,
          initial: {items:[item], editor: structuredClone(item), editingIndex:0, showCatalog:false},
          saveOption: saveConfiguratorOption,
          onChange: () => {
            if (!configurator || configurator.state().editor) { changed(); return; }
            const positions = configurator.positions();
            if (positions.length === 1) for (const key of keys) editorApi.setValue(key, positions[0][key]);
            changed();
          },
        });
      };
      mount();
      return {hasChanges:()=>Boolean(configurator?.hasChanges()), setDisabled:value=>configurator?.setDisabled(value), refresh:mount};
    } : editDescriptor.type === 'contact' ? enhanceRequisitesEditor : undefined,
    submit: (changes) => {
      if (configurator) configurator.positions();
      if (!Object.keys(changes).length) return api('/board?fresh=1');
      if (commentOnly && Object.hasOwn(changes, 'comment')) {
        const source = editDescriptor.fields.find(field => field.id === 'comment');
        changes = { comment: replaceOrderComment(source.value, changes.comment) };
      }
      return api(`/records/${encodeURIComponent(editDescriptor.type)}`, { method: 'PATCH', body: JSON.stringify({ record: editDescriptor.record, changes }) });
    },
    refreshSource: async () => {
      const freshBoard = validBoard(await api('/board?fresh=1'));
      const candidates = freshBoard.orders.flatMap((order) => [order, ...list(order.items), ...list(order.contacts), ...list(order.production), ...list(order.payments), ...list(order.expenses), ...list(order.installations)]);
      const matches = new Map();
      for (const candidate of candidates) {
        const edit = candidate.edit;
        if (edit?.type === editDescriptor.type && edit.record?.key && edit.record.key === editDescriptor.record.key && edit.record.sheet === editDescriptor.record.sheet) matches.set(`${edit.record.sheet}:${edit.record.rowNumber}`, candidate);
      }
      state.board = freshBoard;
      render();
      updateSyncTime();
      if (matches.size !== 1) throw new Error('Запись изменилась так, что её нельзя однозначно сопоставить с исходной строкой. Автоматическое переназначение правки остановлено.');
      editDescriptor = [...matches.values()][0].edit;
      return mapFields(editDescriptor);
    },
    onSaved: acceptEditResult,
    onClose: () => { state.editing = false; if ($('order-dialog').open) renderDialog({ keepFocus: true }); },
  });
}
function renderInstallations(order) {
  const wrapper = el('section', 'detail-section installations-section');
  const heading = el('div', 'installation-heading');
  heading.append(el('h3', 'section-label', 'Монтаж'), button('+ Согласовать', 'inline-edit installation-add', () => createInstallation(order)));
  wrapper.append(heading);
  const installations = list(order.installations);
  if (!installations.length) {
    wrapper.append(el('div', 'installation-empty', 'Выезд на монтаж ещё не согласован. Назначьте дату и контакт отдельно от изготовления.'));
    return wrapper;
  }
  for (const installation of installations) {
    const card = el('article', 'installation-card');
    const complete = ['Выполнен', 'Отменён'].includes(installation.status);
    const late = !complete && daysUntil(installation.date) !== null && daysUntil(installation.date) < 0;
    const top = el('div', 'installation-top');
    const status = el('span', `installation-status${complete ? ' complete' : ''}`, installation.status || 'На согласовании');
    top.append(status);
    const edit = entityEditButton(installation, 'Монтаж');
    if (edit) top.append(edit);
    card.append(top);
    const schedule = el('div', `installation-date${late ? ' overdue' : ''}`);
    schedule.append(icon('calendar'), el('span', '', `${installation.date ? dateLabel(installation.date, true) : 'Дата не согласована'}${installation.time ? ` · ${installation.time}` : ''}`));
    card.append(schedule);
    if (late) card.append(el('p', 'installation-late', 'Дата монтажа прошла'));
    const contact = installation.contact || order.contacts?.[0]?.name || order.client;
    const phone = installation.phone || order.contacts?.[0]?.phone;
    if (contact || phone) {
      const line = el('div', 'installation-contact');
      if (contact) line.append(el('span', '', contact));
      if (phone) {
        const link = el('a', '', phone);
        const cleaned = text(phone).replace(/[^\d+]/g, '');
        if (/^\+?\d{5,20}$/.test(cleaned)) link.href = `tel:${cleaned}`;
        line.append(link);
      }
      card.append(line);
    }
    if (installation.address) card.append(el('p', 'installation-meta', installation.address));
    if (installation.assignee) card.append(el('p', 'installation-meta', `Ответственный: ${installation.assignee}`));
    if (installation.comment) card.append(el('p', 'installation-comment', installation.comment));
    wrapper.append(card);
  }
  return wrapper;
}
function createInstallation(order) {
  if (state.editing || state.pending || state.mediaBusy) return;
  state.editing = true;
  const contact = order.contacts?.[0] || {};
  openRecordEditor({
    title: 'Согласовать монтаж',
    subtitle: `${displayId(order.id)} · ${order.client || 'Заказ'}. Выезд не меняет статус изготовления.`,
    fields: [
      { key: 'status', label: 'Статус монтажа', type: 'select', options: ['На согласовании', 'Назначен', 'Выполнен', 'Отменён'], value: 'На согласовании', required: true },
      { key: 'assignee', label: 'Ответственный', type: 'text', value: '' },
      { key: 'date', label: 'Согласованная дата', type: 'date', value: '' },
      { key: 'time', label: 'Время', type: 'time', value: '' },
      { key: 'contact', label: 'Контакт на месте', type: 'text', value: contact.name || order.client || '', hint: 'Из контактов клиента. При необходимости укажите другого человека.' },
      { key: 'phone', label: 'Телефон', type: 'tel', value: contact.phone || '', hint: 'Телефон клиента можно заменить для этого выезда.' },
      { key: 'address', label: 'Адрес монтажа', type: 'textarea', value: '', fullWidth: true },
      { key: 'comment', label: 'Комментарий', type: 'textarea', value: '', fullWidth: true },
    ],
    submitLabel: 'Создать монтаж',
    submit: (_changes, all) => api(`/orders/${encodeURIComponent(order.id)}/installations`, { method: 'POST', body: JSON.stringify({ changes: all }) }),
    onSaved: acceptEditResult,
    onClose: () => { state.editing = false; },
  });
}

document.querySelectorAll('[data-icon]').forEach((element) => element.replaceChildren(icon(element.dataset.icon)));
$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const pin = $('pin').value;
  if (!pin || $('login-button').disabled) return;
  $('login-button').disabled = true;
  $('login-error').textContent = '';
  try {
    await api('/session', { method: 'POST', body: JSON.stringify({ pin }) });
    await enterApp();
  } catch (error) {
    $('login-error').textContent = error.status === 401 || error.status === 403 ? 'Неверный PIN. Попробуйте ещё раз.' : error.message;
    $('pin').value = '';
    $('pin').focus();
  } finally { $('login-button').disabled = false; }
});
$('logout').addEventListener('click', async () => {
  if (state.pending) { showToast('Дождитесь сохранения статуса.', { error: true }); return; }
  $('logout').disabled = true;
  try { await api('/session', { method: 'DELETE' }); showLogin(); }
  catch (error) { showToast(error.message, { error: true }); }
  finally { $('logout').disabled = false; }
});
$('search').addEventListener('input', (event) => { state.query = normalized(event.target.value); if (state.board) renderBoard(); });
$('manager').addEventListener('change', (event) => { state.manager = event.target.value; if (state.board) renderBoard(); });
const toolsPopover = $('tools-popover');
const nativeToolsPopover = typeof toolsPopover.showPopover === 'function' && typeof toolsPopover.hidePopover === 'function';
let toolsOpen = false;
// Older WebViews keep the existing board and use a regular positioned disclosure.
toolsPopover.hidden = !nativeToolsPopover;
if (!nativeToolsPopover) {
  toolsPopover.removeAttribute('popover');
  $('tools-toggle').removeAttribute('popovertarget');
}
function closeToolsMenu() {
  if (!toolsOpen) return;
  toolsOpen = false;
  $('tools-toggle').setAttribute('aria-expanded', 'false');
  if (nativeToolsPopover) toolsPopover.hidePopover();
  else toolsPopover.hidden = true;
}
function setSidebarExpanded(expanded) {
  closeToolsMenu();
  $('app').classList.toggle('sidebar-expanded', expanded);
  $('sidebar-toggle').setAttribute('aria-expanded', String(expanded));
  $('sidebar-toggle').setAttribute('aria-label', expanded ? 'Свернуть меню' : 'Раскрыть меню');
  $('sidebar-toggle').title = expanded ? 'Свернуть меню' : 'Раскрыть меню';
}
const mobileSidebarMedia = matchMedia('(max-width: 600px)');
function storedSidebarExpanded() {
  try { return localStorage.getItem('workshop.sidebar.expanded') === 'true'; }
  catch { return false; }
}
function restoreSidebarForViewport() {
  setSidebarExpanded(!mobileSidebarMedia.matches && storedSidebarExpanded());
}
restoreSidebarForViewport();
$('sidebar-toggle').addEventListener('click', () => {
  const expanded = !$('app').classList.contains('sidebar-expanded');
  setSidebarExpanded(expanded);
  if (!mobileSidebarMedia.matches) {
    try { localStorage.setItem('workshop.sidebar.expanded', String(expanded)); } catch {}
  }
});
$('sidebar-navigation').addEventListener('click', (event) => {
  if (mobileSidebarMedia.matches && event.target.closest('a')) setSidebarExpanded(false);
});
document.addEventListener('click', (event) => {
  if (mobileSidebarMedia.matches && $('app').classList.contains('sidebar-expanded') && !event.target.closest('.sidebar')) setSidebarExpanded(false);
});
window.addEventListener('pageshow', () => {
  if (mobileSidebarMedia.matches) setSidebarExpanded(false);
});
mobileSidebarMedia.addEventListener('change', restoreSidebarForViewport);
function showToolsMenu(open) {
  toolsOpen = open;
  $('tools-toggle').setAttribute('aria-expanded', String(open));
  if (!nativeToolsPopover) toolsPopover.hidden = !open;
  if (!open) return;
  const anchor = $('tools-toggle').getBoundingClientRect();
  const left = mobileSidebarMedia.matches ? anchor.left : anchor.right + 8;
  const top = mobileSidebarMedia.matches ? anchor.bottom + 8 : anchor.top;
  toolsPopover.style.left = Math.max(8, Math.min(left, innerWidth - toolsPopover.offsetWidth - 8)) + 'px';
  toolsPopover.style.top = Math.max(8, Math.min(top, innerHeight - toolsPopover.offsetHeight - 8)) + 'px';
  toolsPopover.querySelector('a').focus();
}
if (nativeToolsPopover) toolsPopover.addEventListener('toggle', (event) => {
  showToolsMenu(event.newState === 'open');
});
$('tools-toggle').addEventListener('click', () => {
  if (!nativeToolsPopover) showToolsMenu(!toolsOpen);
});
document.addEventListener('click', (event) => {
  if (!nativeToolsPopover && toolsOpen && !toolsPopover.contains(event.target) && !$('tools-toggle').contains(event.target)) closeToolsMenu();
});
toolsPopover.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !nativeToolsPopover) {
    event.preventDefault();
    closeToolsMenu();
    $('tools-toggle').focus();
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const links = Array.from(toolsPopover.querySelectorAll('a'));
  const current = links.indexOf(document.activeElement);
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1 :
    (current + (event.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
  links[index].focus();
});
window.addEventListener('resize', () => {
  closeToolsMenu();
});
bindDropTarget($('installation-section'), (order) => Boolean(order && order.status === 'Готов к выдаче' && allowedStatuses().includes('Монтаж')), (id) => moveOrder(id, 'Монтаж'), 'В монтаж можно перенести готовый заказ.');
bindDropTarget($('archive'), (order) => canArchiveOrder(order) && allowedStatuses().includes('Сдан') && !state.archiveNeedsRefresh, archiveOrder, 'В архив можно перенести готовый заказ или заказ с монтажом.');
bindDropTarget($('cancelled'), (order) => Boolean(order && order.status !== 'Отменён' && allowedStatuses().includes('Отменён')), (id) => moveOrder(id, 'Отменён'), 'Отмена недоступна. Обновите доску и проверьте статус заказа.');
$('cancelled').addEventListener('click', () => {
  if (state.pending || Date.now() - state.lastDragEnd < 300) return;
  renderCancelledDialog(); $('cancelled-dialog').showModal();
});
$('refresh').addEventListener('click', () => loadBoard({ fresh: true }));
$('create-order').addEventListener('click', createOrder);
const sellersNavigation = button('Наши юрлица', 'nav-item', () => documentUI.openSellers(), 'users');
sellersNavigation.id = 'document-sellers-nav';
sellersNavigation.title = 'Наши юрлица';
sellersNavigation.setAttribute('aria-label', 'Наши юрлица');
const sellersNavigationText = sellersNavigation.querySelector('span:last-child');
if (sellersNavigationText) sellersNavigationText.classList.add('nav-label');
$('tools-toggle').before(sellersNavigation);
$('order-dialog').addEventListener('cancel', (event) => { event.preventDefault(); closeDialog(); });
$('order-dialog').addEventListener('click', (event) => {
  if (event.target !== $('order-dialog')) return;
  const rect = $('order-dialog').getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog();
});
document.addEventListener('keydown', (event) => {
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && state.authenticated && !state.editing && !$('order-dialog').open && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
    event.preventDefault(); $('search').focus();
  }
});
document.addEventListener('dragover', (event) => { if (state.dragId !== null) { state.dragX = event.clientX; state.dragY = event.clientY; } });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.authenticated && !$('order-dialog').open) loadBoard({ quiet: true });
});
window.addEventListener('online', () => { if (state.authenticated && !$('order-dialog').open) loadBoard({ quiet: true }); });
setInterval(() => {
  if (document.visibilityState === 'visible' && state.authenticated && !$('order-dialog').open && !state.pending && state.dragId === null) loadBoard({ quiet: true });
}, 45000);

try {
  const session = await api('/session');
  if (session.authenticated) await enterApp();
  else showLogin();
} catch (error) { showLogin(error.message); }
