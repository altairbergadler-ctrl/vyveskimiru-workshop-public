const { parseRequisites, validateFields } = await import(`./requisites.js${new URL(import.meta.url).search}`);

const text = value => String(value ?? '');
const list = value => Array.isArray(value) ? value : [];
const vatLabel = value => value === 'none' ? 'Без НДС' : value ? value + '%' : 'НДС не выбран';
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
const uuid = () => crypto.randomUUID();
const clone = value => JSON.parse(JSON.stringify(value));
function el(tag, className = '', value) { const node = document.createElement(tag); node.className = className; if (value !== undefined) node.textContent = text(value); return node; }
function button(label, callback, className = 'button button-outline') { const node = el('button', className, label); node.type = 'button'; node.addEventListener('click', callback); return node; }
function field(label, value = '', type = 'text') {
  const group = el('label', 'document-field'); const caption = el('span', '', label); caption.id = 'document-field-' + uuid(); group.append(caption);
  const input = el(type === 'textarea' ? 'textarea' : 'input'); if (type !== 'textarea') input.type = type;
  input.setAttribute('aria-labelledby', caption.id);
  input.value = text(value); if (type === 'number') { input.step = '0.01'; input.min = '0'; }
  group.append(input); return { group, input };
}
function choice(label, options, value) {
  const group = el('label', 'document-field'); const caption = el('span', '', label); caption.id = 'document-choice-' + uuid(); group.append(caption);
  const input = el('select');
  input.setAttribute('aria-labelledby', caption.id);
  for (const option of options) { const node = el('option', '', option.label); node.value = option.value; node.disabled = Boolean(option.disabled); input.append(node); }
  if (value && !options.some(option => option.value === text(value))) { const saved = el('option', '', 'Зафиксированное значение: ' + value); saved.value = text(value); saved.disabled = true; input.append(saved); }
  input.value = text(value); group.append(input); return { group, input };
}
function modal(title, onClose) {
  const dialog = el('dialog', 'document-dialog'); const shell = el('div', 'document-dialog-shell'); const header = el('header', 'document-dialog-header');
  const heading = el('h2', '', title); heading.id = 'document-dialog-' + uuid(); dialog.setAttribute('aria-labelledby', heading.id);
  let guard = null;
  const close = () => { if (guard && !guard()) return; dialog.close(); dialog.remove(); onClose?.(); };
  header.append(heading, button('Закрыть', close)); shell.append(header); dialog.append(shell); document.body.append(dialog);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); }); dialog.showModal(); return { dialog, shell, close, setGuard(value) { guard = value; } };
}
function details(title, object, fields) {
  const section = el('section', 'document-details'); section.append(el('h3', '', title));
  for (const [key, label] of fields) if (object?.[key]) section.append(el('p', '', label + ': ' + object[key]));
  return section;
}
const PARTY = [['name', 'Наименование'], ['inn', 'ИНН'], ['kpp', 'КПП'], ['ogrn', 'ОГРН / ОГРНИП'], ['address', 'Адрес']];
const BANK = [['bank', 'Банк'], ['bik', 'БИК'], ['account', 'Р/с'], ['correspondent', 'К/с']];
const PENDING_KEY = 'workshop.documents.pending';
const STAMP_PENDING_KEY = 'workshop.documents.pending-stamps';
const STAMP_REJECTED = new Set(['DOCUMENT_SELLER_CHANGED', 'DOCUMENT_STAMP_PROFILE_MISSING', 'DOCUMENT_STAMP_PROFILE_CHANGED', 'DOCUMENT_STAMP_PROFILE_INVALID', 'DOCUMENT_STAMP_WRONG_COMPANY', 'DOCUMENT_STAMP_LAYOUT_MISSING', 'DOCUMENT_STAMP_SOURCE', 'DOCUMENT_STAMP_REQUEST_CONFLICT', 'DOCUMENT_STAMP_REQUEST', 'DOCUMENT_STAMP_FAILED', 'DOCUMENT_STAMP_FILE_MISSING', 'DOCUMENT_STAMP_REJECTED', 'DOCUMENT_STAMP_CONFLICT', 'DOCUMENT_MEDIA_DELETED', 'DOCUMENT_MEDIA_CONFLICT', 'DOCUMENT_NOT_FOUND', 'MEDIA_NOT_FOUND']);
const stampImageUrl = (kind, id) => /^[a-f0-9]{32}$/.test(text(id)) ? '/tools/stamp/api/' + (kind === 'stamp' ? 'stamps' : 'signatures') + '/' + id + '/image' : null;
function sellerStampBinding(seller) {
  const value = seller?.source?.documentStamps;
  return value?.version === 1 && (value.stamp || value.signature) ? value : null;
}
function stampSummary(binding, library) {
  const section = el('section', 'document-stamp-summary');
  if (!binding) return section;
  for (const kind of ['stamp', 'signature']) {
    const ref = binding[kind]; if (!ref) continue;
    const item = list(library?.[kind === 'stamp' ? 'stamps' : 'signatures']).find(value => value.id === ref.id);
    const card = el('div', 'document-stamp-card'); const image = el('img'); image.alt = kind === 'stamp' ? 'Выбранная печать' : 'Выбранная подпись';
    const url = stampImageUrl(kind, ref.id); if (url) image.src = url;
    card.append(image, el('strong', '', item?.name || (kind === 'stamp' ? 'Привязанная печать' : 'Привязанная подпись')));
    if (item?.companyInn) card.append(el('span', '', 'ИНН ' + item.companyInn));
    if (item?.signer) card.append(el('span', '', 'Подписант: ' + item.signer));
    section.append(card);
  }
  section.append(el('p', 'document-hint', 'Скан-эффект: ' + ({ light: 'лёгкий', standard: 'обычный', strong: 'выраженный' }[binding.profile] || 'обычный') + ' · ' + binding.dpi + ' dpi. Исходный PDF сохранится.'));
  return section;
}

export function createOrderDocumentsUI({ api, onCreated, onEditBuyer, onError, onSellersChange }) {
  const orders = new Map();
  const pending = new Map();
  const stampPending = new Map();
  try {
    const saved = JSON.parse(sessionStorage.getItem(PENDING_KEY));
    if (Array.isArray(saved)) for (const [id, value] of saved) if (typeof id === 'string' && typeof value?.requestId === 'string' && value.payload) pending.set(id, value);
  } catch {}
  try {
    const saved = JSON.parse(sessionStorage.getItem(STAMP_PENDING_KEY));
    if (Array.isArray(saved)) for (const [id, value] of saved) if (typeof id === 'string' && typeof value?.requestId === 'string' && typeof value?.documentId === 'string' && value.basePayload) stampPending.set(id, value);
  } catch {}
  const remember = () => { try { sessionStorage.setItem(PENDING_KEY, JSON.stringify([...pending])); } catch {} };
  const rememberStamps = () => { try { sessionStorage.setItem(STAMP_PENDING_KEY, JSON.stringify([...stampPending])); } catch {} };
  let sellers = [];
  let sellerPending = null;
  let stampLibrary = null;
  let stampLibraryError = '';
  let libraryLoading = null;
  async function loadStampLibrary() {
    if (libraryLoading) return libraryLoading;
    libraryLoading = (async () => {
      try { const response = await api('/document-stamp-library'); if (response.version !== 1 || !Array.isArray(response.stamps) || !Array.isArray(response.signatures)) throw new Error('Библиотека печатей вернула неполные данные.'); stampLibrary = response; stampLibraryError = ''; return response; }
      catch (error) { stampLibrary = null; stampLibraryError = error.message; throw error; }
      finally { libraryLoading = null; }
    })();
    return libraryLoading;
  }
  function bindingIssue(seller, binding) {
    if (!binding) return '';
    if (!['light', 'standard', 'strong'].includes(binding.profile) || ![150, 200].includes(binding.dpi)) return 'Проверьте профиль и качество скана в карточке юрлица.';
    if (!stampLibrary) return stampLibraryError || 'Не удалось проверить библиотеку печатей и подписей.';
    for (const kind of ['stamp', 'signature']) {
      const ref = binding[kind]; if (!ref) continue;
      const item = list(stampLibrary[kind === 'stamp' ? 'stamps' : 'signatures']).find(value => value.id === ref.id);
      if (!item || item.sha256 !== ref.sha256 || item.revision !== ref.revision) return 'Печать или подпись изменились. Выберите изображения заново в карточке юрлица.';
      if (kind === 'stamp' && text(item.companyInn) !== text(seller.inn)) return 'ИНН печати не совпадает с ИНН выбранного юрлица.';
    }
    return '';
  }

  async function loadOrder(entry) {
    if (entry.loading) return;
    entry.loading = true; entry.error = ''; paint(entry);
    try {
      entry.data = await api('/orders/' + encodeURIComponent(entry.order.id) + '/documents/prepare?type=' + entry.draft.type);
      sellers = list(entry.data.sellerItems);
      if (sellers.some(seller => sellerStampBinding(seller))) { try { await loadStampLibrary(); } catch {} }
      const active = sellers.filter(seller => seller.active !== false);
      if (!active.some(seller => seller.id === entry.draft.sellerId)) entry.draft.sellerId = active.length === 1 ? active[0].id : '';
      selectAccount(entry);
      if (!entry.draft.number) entry.draft.number = text(entry.data.suggestedNumber || entry.order.id + '-1');
      if (entry.draft.amountDue === '') entry.draft.amountDue = entry.data.total === null || entry.data.total === undefined ? '' : text(entry.data.total);
    } catch (error) { entry.error = error.message; onError?.(error); }
    finally { entry.loading = false; paint(entry); }
  }
  function selectAccount(entry) {
    const selected = sellers.find(seller => seller.id === entry.draft.sellerId);
    const accounts = list(selected?.accounts).filter(account => account.active !== false);
    if (!accounts.some(account => account.id === entry.draft.accountId)) entry.draft.accountId = accounts.length === 1 ? accounts[0].id : '';
  }
  function paint(entry) {
    if (!entry.host?.isConnected) return;
    const uncertain = pending.get(text(entry.order.id));
    if (uncertain) { Object.assign(entry.draft, uncertain.payload); entry.draft.decorate = Boolean(uncertain.decoration); }
    const { host, draft, data } = entry;
    host.replaceChildren();
    const heading = el('div', 'document-heading'); heading.append(el('h3', '', 'Документы заказа'), button('Обновить', () => loadOrder(entry)), button('Наши юрлица', () => openSellers(() => loadOrder(entry)))); host.append(heading);
    if (stampPending.has(text(entry.order.id))) { renderStampPending(entry, stampPending.get(text(entry.order.id))); return; }
    if (entry.loading) { host.append(el('p', 'detail-empty', 'Загружаем реквизиты и состав заказа…')); return; }
    if (entry.error) host.append(el('p', 'document-error', entry.error), button('Обновить данные', () => loadOrder(entry)));
    if (!data) return;
    const form = el('form', 'document-form'); const grid = el('div', 'document-form-grid');
    const type = choice('Документ', [{ value: 'invoice', label: 'Счёт на оплату' }, { value: 'upd', label: 'УПД по окончании работы', disabled: !data.completed }], draft.type);
    type.input.addEventListener('change', () => { draft.type = type.input.value; draft.number = ''; void loadOrder(entry); });
    const seller = choice('Наша организация', [{ value: '', label: 'Выберите организацию' }, ...sellers.filter(item => item.active !== false).map(item => ({ value: item.id, label: item.label || item.name }))], draft.sellerId);
    seller.input.required = true; seller.input.addEventListener('change', () => { draft.sellerId = seller.input.value; draft.accountId = ''; draft.decorate = Boolean(sellerStampBinding(sellers.find(item => item.id === draft.sellerId))); selectAccount(entry); paint(entry); });
    const selected = sellers.find(item => item.id === draft.sellerId);
    const account = choice('Счёт для оплаты', [{ value: '', label: 'Выберите банковский счёт' }, ...list(selected?.accounts).filter(item => item.active !== false).map(item => ({ value: item.id, label: (item.label || item.bank) + ' · ' + text(item.account).slice(-4) }))], draft.accountId);
    account.input.required = true; account.input.addEventListener('change', () => { draft.accountId = account.input.value; });
    const number = field('Номер документа', draft.number); number.input.required = true; number.input.maxLength = 40; number.input.addEventListener('input', () => { draft.number = number.input.value; });
    const date = field('Дата документа', draft.date, 'date'); date.input.required = true; date.input.addEventListener('input', () => { draft.date = date.input.value; });
    const amount = field('К оплате по счёту, ₽', draft.amountDue, 'number'); amount.input.required = draft.type === 'invoice'; amount.input.min = '0.01'; if (typeof data.total === 'number') amount.input.max = text(data.total); amount.group.hidden = draft.type !== 'invoice'; amount.input.addEventListener('input', () => { draft.amountDue = amount.input.value; });
    grid.append(type.group, seller.group, account.group, number.group, date.group, amount.group); form.append(grid);
    if (selected) form.append(el('p', 'document-hint', 'Исполнитель: ' + selected.name + ' · ' + vatLabel(selected.vat)));
    const binding = sellerStampBinding(selected);
    if (draft.decorate === undefined) draft.decorate = Boolean(binding);
    if (binding) {
      const decorate = field('Нанести печать/подпись и сделать скан', '', 'checkbox'); decorate.input.checked = Boolean(draft.decorate); decorate.input.addEventListener('change', () => { draft.decorate = decorate.input.checked; }); form.append(decorate.group, stampSummary(binding, stampLibrary));
      const issue = bindingIssue(selected, binding); if (issue) form.append(el('p', 'document-warning', issue + ' Можно сохранить исходный PDF, сняв отметку обработки.'));
    }
    if (!data.completed) form.append(el('p', 'document-hint', 'УПД доступен после завершения заказа (статус «Сдан») и монтажей.'));
    const warnings = el('div', 'document-warnings');
    for (const warning of list(data.warnings)) warnings.append(el('p', '', typeof warning === 'string' ? warning : warning.message));
    form.append(warnings, details('Покупатель / заказчик', data.buyer, PARTY));
    form.append(button('Проверить реквизиты клиента', () => onEditBuyer?.(entry.order)));
    const test = field('Тестовый документ', '', 'checkbox'); test.input.checked = draft.test; test.input.addEventListener('change', () => { draft.test = test.input.checked; }); form.append(test.group);
    const status = el('p', 'document-status'); status.setAttribute('role', 'status'); form.append(status);
    const action = el('button', 'button button-primary', pending.has(text(entry.order.id)) ? 'Проверить создание документа' : 'Предпросмотр'); action.type = 'submit';
    action.disabled = Boolean(entry.submitting) || (data.ready === false && !uncertain); form.append(action); host.append(form);
    if (uncertain) {
      for (const control of form.querySelectorAll('input,select,textarea,button')) if (control !== action) control.disabled = true;
      status.textContent = entry.submitting ? 'Проверяем зафиксированный запрос создания документа…' : 'Результат предыдущего запроса пока не подтверждён. Показаны зафиксированные данные. Проверка использует тот же запрос и не создаёт копию.';
    }
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (pending.has(text(entry.order.id))) { void createDocument(entry, null, action, status); return; }
      const sellerRecord = sellers.find(item => item.id === draft.sellerId);
      const selectedAccount = sellerRecord?.accounts?.find(item => item.id === draft.accountId && item.active !== false);
      if (!sellerRecord || !selectedAccount) { status.textContent = 'Выберите организацию и её действующий банковский счёт.'; return; }
      if (sellerRecord.vat !== 'none') { status.textContent = sellerRecord.vat ? 'Документы с НДС требуют отдельной настройки. Сейчас доступен подтверждённый режим «Без НДС».' : 'Сначала укажите НДС для выбранной организации в справочнике «Наши юрлица».'; return; }
      const imageIssue = draft.decorate ? bindingIssue(sellerRecord, sellerStampBinding(sellerRecord)) : '';
      if (imageIssue) { status.textContent = imageIssue; return; }
      const issues = validateFields(sellerRecord).concat(validateFields(selectedAccount));
      if (issues.length) { status.textContent = issues.map(issue => issue.message).join(' '); return; }
      preview(entry, sellerRecord, selectedAccount);
    });
  }
  function preview(entry, seller, account) {
    const { shell, close } = modal(entry.draft.type === 'invoice' ? 'Предпросмотр счёта' : 'Предпросмотр УПД');
    shell.append(el('p', 'document-hint', 'Проверьте реквизиты и состав. PDF сохранится во «Файлы» этого заказа отдельной версией.'));
    shell.append(el('p', '', 'Заказ ' + entry.order.id + ' · № ' + entry.draft.number + ' от ' + entry.draft.date));
    if (entry.draft.test) shell.append(el('p', 'document-warning', 'ТЕСТОВЫЙ ДОКУМЕНТ · НЕ ДЛЯ ОПЛАТЫ'));
    if (entry.draft.decorate && sellerStampBinding(seller)) shell.append(el('h3', '', 'Печать, подпись и скан-эффект'), stampSummary(sellerStampBinding(seller), stampLibrary));
    shell.append(details('Исполнитель', seller, PARTY), details('Банк исполнителя', account, BANK), details('Покупатель / заказчик', entry.data.buyer, PARTY));
    const table = el('table', 'document-items'); const head = el('tr'); for (const label of ['Наименование', 'Кол-во', 'Ед.', 'Цена, ₽', 'Сумма, ₽']) head.append(el('th', '', label));
    const thead = el('thead'); thead.append(head); table.append(thead); const body = el('tbody');
    for (const item of list(entry.data.items)) { const row = el('tr'); for (const key of ['name', 'quantity', 'unit', 'price', 'amount']) row.append(el('td', '', item[key] ?? '—')); body.append(row); }
    table.append(body); shell.append(table, el('p', 'document-total', 'Итого по заказу: ' + text(entry.data.total) + ' ₽ · ' + vatLabel(seller.vat)));
    if (entry.draft.type === 'invoice') shell.append(el('p', 'document-total', 'К оплате: ' + entry.draft.amountDue + ' ₽'));
    const status = el('p', 'document-status'); status.setAttribute('role', 'status');
    const create = button('Создать PDF и сохранить в «Файлы»', () => createDocument(entry, close, create, status), 'button button-primary'); shell.append(status, create);
  }
  async function createDocument(entry, close, action, status) {
    const id = text(entry.order.id);
    let job = pending.get(id);
    if (!job) { job = { requestId: uuid(), decoration: entry.draft.decorate ? clone(sellerStampBinding(sellers.find(seller => seller.id === entry.draft.sellerId))) : null, payload: { type: entry.draft.type, number: entry.draft.number.trim(), date: entry.draft.date, sellerId: entry.draft.sellerId, accountId: entry.draft.accountId, amountDue: entry.draft.type === 'invoice' ? Number(entry.draft.amountDue) : null, test: entry.draft.test, expectedSourceHash: entry.data.sourceHash, expectedSellerRevision: sellers.find(seller => seller.id === entry.draft.sellerId)?.revision } }; pending.set(id, job); remember(); }
    entry.submitting = true; paint(entry);
    action.disabled = true; status.textContent = 'Создаём PDF и сохраняем файл заказа…';
    try {
      const result = await api('/orders/' + encodeURIComponent(id) + '/documents', { method: 'POST', body: JSON.stringify({ requestId: job.requestId, ...job.payload }) });
      if (result.state !== 'confirmed' || !result.document || !result.media) throw new Error('Создание документа пока не подтверждено. Повторите проверку.');
      if (job.decoration) {
        if (!result.document.id) throw new Error('Исходный PDF сохранён, но сервер ещё не подтвердил его ID. Проверьте тот же запрос.');
        stampPending.set(id, { requestId: uuid(), documentId: result.document.id, expectedSellerRevision: job.payload.expectedSellerRevision, basePayload: clone(job.payload), binding: clone(job.decoration), state: 'prepared', stage: 'start', message: 'Исходный PDF сохранён. Подготавливаем печать, подпись и скан-эффект.' }); rememberStamps();
      }
      pending.delete(id); remember(); entry.submitting = false; close?.();
      try { await onCreated?.(entry.order, { ...result, keepDocuments: Boolean(job.decoration) }); } catch (error) { onError?.(error); }
      entry.error = ''; entry.data = null;
      if (job.decoration) { paint(entry); void runStamps(entry, { initial: true }); }
    } catch (error) {
      entry.submitting = false;
      if (['DOCUMENT_SOURCE_CHANGED', 'DOCUMENT_SELLER_CHANGED', 'DOCUMENT_SELLER_CONFLICT'].includes(error.code)) {
        pending.delete(id); remember(); close?.(); await loadOrder(entry); entry.error = error.message + ' Проверьте обновлённый предпросмотр.'; paint(entry); return;
      }
      if ([400, 422].includes(error.status) || ['DOCUMENT_NUMBER_DUPLICATE', 'DOCUMENT_REQUEST_CONFLICT', 'DOCUMENT_FILE_MISSING'].includes(error.code)) { pending.delete(id); remember(); }
      entry.error = error.message; paint(entry);
      status.textContent = error.message; action.textContent = pending.has(id) ? 'Проверить создание документа' : 'Повторить'; action.disabled = false; onError?.(error);
    }
  }

  function renderStampPending(entry, job) {
    const section = el('section', 'document-stamp-progress');
    section.append(el('h3', '', 'Исходный PDF уже сохранён'), el('p', 'document-hint', 'Печать, подпись и скан-эффект создаются для этого PDF. Повторная проверка не создаёт новый счёт или УПД.'));
    const grid = el('div', 'document-form-grid');
    for (const [label, value] of [['Документ', job.basePayload.type === 'upd' ? 'УПД' : 'Счёт'], ['Номер документа', job.basePayload.number], ['Дата документа', job.basePayload.date], ['К оплате по счёту, ₽', job.basePayload.amountDue ?? '—']]) { const control = field(label, value); control.input.disabled = true; grid.append(control.group); }
    section.append(grid, stampSummary(job.binding, stampLibrary));
    const message = el('p', job.state === 'failed' || job.state === 'uncertain' ? 'document-warning' : 'document-status', job.message || 'Проверяем обработку документа…'); message.setAttribute('role', 'status'); section.append(message);
    const verify = button(entry.stampBusy ? 'Проверяем обработку…' : job.state === 'prepared' ? 'Повторить обработку' : 'Проверить обработку', () => runStamps(entry, { manual: true }), 'button button-primary'); verify.disabled = Boolean(entry.stampBusy); section.append(verify);
    if (job.state === 'failed') section.append(button('Оставить исходный PDF', () => { stampPending.delete(text(entry.order.id)); rememberStamps(); entry.error = ''; entry.data = null; void loadOrder(entry); }));
    entry.host.append(section);
  }
  async function runStamps(entry, { initial = false, manual = false } = {}) {
    const id = text(entry.order.id), job = stampPending.get(id);
    if (!job || entry.stampBusy) return;
    clearTimeout(entry.stampTimer); entry.stampBusy = true; paint(entry);
    const path = '/orders/' + encodeURIComponent(id) + '/documents/' + encodeURIComponent(job.documentId) + '/stamps';
    const start = () => api(path, { method: 'POST', body: JSON.stringify({ requestId: job.requestId, expectedSellerRevision: job.expectedSellerRevision }) });
    try {
      let response;
      if (initial) response = await start();
      else {
        try { response = await api(path + '/' + encodeURIComponent(job.requestId)); }
        catch (error) { if (manual && job.stage === 'start' && error.status === 404 && error.code === 'DOCUMENT_STAMP_NOT_FOUND') response = await start(); else throw error; }
        if (manual && response.state === 'prepared') response = await start();
      }
      if (response.operationId) job.operationId = response.operationId;
      if (response.jobId) job.jobId = response.jobId;
      if (response.state === 'prepared') { job.state = 'prepared'; job.stage = 'start'; job.message = 'Запрос сохранён, но обработка ещё не запущена. Нажмите «Повторить обработку»: используем тот же запрос и исходный PDF.'; rememberStamps(); return; }
      if (response.state === 'failed') { job.state = 'failed'; job.message = response.message || response.error || 'Обработка не выполнена. Исходный PDF сохранён во «Файлы».'; rememberStamps(); return; }
      if (response.state === 'completed') {
        job.stage = 'files'; job.state = 'processing'; job.message = 'Печать и скан готовы. Сохраняем оба PDF во «Файлы»…'; rememberStamps(); paint(entry);
        const attached = await api(path + '/' + encodeURIComponent(job.requestId) + '/files', { method: 'POST', body: '{}' });
        const media = attached.media?.items ? attached.media : { items: list(attached.items) };
        if (attached.state !== 'confirmed' || !media.items.length) throw new Error('Добавление готовых файлов пока не подтверждено. Проверьте тот же запрос.');
        stampPending.delete(id); rememberStamps(); entry.error = ''; entry.data = null;
        try { await onCreated?.(entry.order, { ...attached, document: { id: job.documentId }, media, decorationComplete: true }); } catch (error) { onError?.(error); }
        return;
      }
      if (response.state !== 'processing') throw new Error('Сервер ещё не подтвердил состояние обработки. Проверьте тот же запрос.');
      job.stage = 'poll'; job.state = 'processing'; job.message = 'Наносим выбранные изображения и создаём скан-эффект. Исходный PDF сохранён.'; rememberStamps();
      entry.stampTimer = setTimeout(() => { void runStamps(entry); }, 2000);
    } catch (error) {
      job.state = [400, 422].includes(error.status) || STAMP_REJECTED.has(error.code) ? 'failed' : 'uncertain';
      job.message = 'Исходный PDF сохранён. ' + error.message + (job.state === 'uncertain' ? ' Проверьте обработку: используем тот же запрос.' : ''); rememberStamps(); onError?.(error);
    } finally { entry.stampBusy = false; paint(entry); }
  }

  async function openSellers(afterSave) {
    const view = modal('Наши юрлица'); const content = el('div', 'document-sellers'); view.shell.append(content);
    async function refresh() {
      content.replaceChildren(el('p', '', 'Загружаем организации…'));
      try {
        const response = await api('/document-sellers?includeArchived=1'); sellers = list(response.items);
        content.replaceChildren(button('+ Добавить организацию', () => editSeller(null)), button('Обновить справочник', refresh));
        if (!sellers.length) content.append(el('p', 'detail-empty', 'Добавьте организацию и банковский счёт для выставления документов.'));
        for (const seller of sellers) {
          const row = el('article', 'document-seller-row'); row.append(el('strong', '', seller.label || seller.name), el('p', '', seller.name + ' · ИНН ' + seller.inn), el('p', 'document-hint', seller.active === false ? 'В архиве' : vatLabel(seller.vat)));
          row.append(button('Изменить', () => editSeller(seller)));
          row.append(button(seller.active === false ? 'Восстановить' : 'В архив', async () => {
            if (!confirm(seller.active === false ? 'Вернуть организацию в действующие?' : 'Архивировать организацию? Ранее созданные документы сохранятся.')) return;
            try { await api('/document-sellers', { method: 'POST', body: JSON.stringify({ requestId: uuid(), seller: { ...seller, active: seller.active === false } }) }); await refresh(); afterSave?.(); }
            catch (error) { row.append(el('p', 'document-error', error.message)); onError?.(error); }
          })); content.append(row);
        }
      } catch (error) { content.replaceChildren(el('p', 'document-error', error.message), button('Повторить', refresh)); onError?.(error); }
    }
    function editSeller(existing) {
      const value = clone(existing || { id: uuid(), label: '', name: '', inn: '', kpp: '', ogrn: '', address: '', signer: '', signerRole: '', vat: null, active: true, accounts: [], source: {} });
      const edit = modal(existing ? 'Изменить организацию' : 'Новая организация'); const form = el('form', 'document-seller-form'); const grid = el('div', 'document-form-grid'); const controls = new Map();
      const unresolved = new Set(list(value.source?.unresolvedFields));
      let saving = false;
      let artworkInvalid = false;
      let refreshArtwork = null;
      for (const [key, label] of [['label', 'Короткое название'], ...PARTY, ['signer', 'Подписант'], ['signerRole', 'Должность подписанта']]) {
        const control = field(label, value[key]); control.input.required = ['label', 'name', 'inn'].includes(key); control.input.addEventListener('input', () => { value[key] = control.input.value; if (control.input.value.trim() || !['label', 'name', 'inn'].includes(key)) unresolved.delete(key); if (key === 'inn') refreshArtwork?.(); updateImportState(); }); controls.set(key, control.input); grid.append(control.group);
      }
      const vat = choice('НДС для документов', [{ value: '', label: 'Не выбран — черновик' }, { value: 'none', label: 'Без НДС' }, ...(value.vat && value.vat !== 'none' ? [{ value: value.vat, label: vatLabel(value.vat) + ' — требуется отдельная настройка', disabled: true }] : [])], value.vat);
      vat.input.addEventListener('change', () => { value.vat = vat.input.value || null; }); grid.append(vat.group);
      const pasted = field('Вставить реквизиты организации', '', 'textarea');
      const parseNotice = el('p', 'document-hint');
      const parse = button('Распределить по полям', () => {
        const parsed = parseRequisites(pasted.input.value);
        for (const [key, input] of controls) {
          if (parsed.unresolvedFields.includes(key)) { input.value = parsed.fields[key] || ''; value[key] = parsed.fields[key] || ''; unresolved.add(key); }
          else if (parsed.fields[key]) { input.value = parsed.fields[key]; value[key] = parsed.fields[key]; unresolved.delete(key); }
        }
        if (['bank', 'bik', 'account', 'correspondent'].some(key => parsed.fields[key] || parsed.candidates[key]?.length || parsed.unresolvedFields.includes(key))) {
          const account = value.accounts.find(item => item.account === parsed.fields.account && item.bik === parsed.fields.bik) || { id: uuid(), label: 'Основной', active: true };
          for (const key of ['bank', 'bik', 'account', 'correspondent']) {
            account[key] = parsed.fields[key] || '';
            const unresolvedKey = 'account:' + account.id + ':' + key;
            if (parsed.unresolvedFields.includes(key)) unresolved.add(unresolvedKey); else unresolved.delete(unresolvedKey);
          }
          if (!value.accounts.includes(account)) value.accounts.push(account); renderAccounts();
        }
        value.source = { ...value.source, text: pasted.input.value }; refreshArtwork?.(); updateImportState();
      });
      const accounts = el('div', 'document-account-list');
      function renderAccounts() {
        accounts.replaceChildren();
        for (const account of value.accounts) {
          const group = el('section', 'document-account-editor'); group.append(el('h3', '', account.label || 'Банковский счёт'));
          const fields = el('div', 'document-form-grid');
          for (const [key, label] of [['label', 'Название счёта'], ...BANK]) { const control = field(label, account[key]); control.input.required = key !== 'label'; control.input.addEventListener('input', () => { account[key] = control.input.value; if (control.input.value.trim()) unresolved.delete('account:' + account.id + ':' + key); updateImportState(); }); fields.append(control.group); }
          const active = field('Действующий счёт', '', 'checkbox'); active.input.checked = account.active !== false; active.input.addEventListener('change', () => { account.active = active.input.checked; }); group.append(fields, active.group);
          if (!existing?.accounts?.some(saved => saved.id === account.id)) group.append(button('Убрать несохранённый счёт', () => { value.accounts = value.accounts.filter(item => item !== account); for (const key of unresolved) if (key.startsWith('account:' + account.id + ':')) unresolved.delete(key); renderAccounts(); updateImportState(); }));
          accounts.append(group);
        }
      }
      renderAccounts();
      const add = button('+ Банковский счёт', () => { value.accounts.push({ id: uuid(), label: '', bank: '', bik: '', account: '', correspondent: '', active: true }); renderAccounts(); });
      const status = el('p', 'document-status'); status.setAttribute('role', 'status'); const save = el('button', 'button button-primary', 'Сохранить организацию'); save.type = 'submit';
      const artwork = el('section', 'document-artwork-editor'); artwork.append(el('h3', '', 'Печать и подпись для документов'));
      const openTool = el('a', 'button button-outline', 'Открыть Оттиски'); openTool.href = '/tools/stamp/'; openTool.target = '_blank'; openTool.rel = 'noopener noreferrer'; artwork.append(openTool);
      const artworkBody = el('div'); artwork.append(artworkBody);
      const artworkConfig = clone(value.source?.documentStamps?.version === 1 ? value.source.documentStamps : { version: 1, stamp: null, signature: null, profile: 'standard', dpi: 150 });
      const storeArtwork = () => { value.source = { ...value.source, documentStamps: artworkConfig.stamp || artworkConfig.signature ? clone(artworkConfig) : null }; };
      function renderArtwork() {
        artworkBody.replaceChildren(); artworkInvalid = !['light', 'standard', 'strong'].includes(artworkConfig.profile) || ![150, 200].includes(artworkConfig.dpi);
        if (!stampLibrary) {
          artworkBody.append(el('p', 'document-warning', stampLibraryError || 'Загружаем библиотеку печатей и подписей…'));
          if (stampLibraryError) artworkBody.append(el('p', 'document-hint', 'Сохранённые привязки не изменены. Исходный PDF можно создавать без обработки.'), button('Повторить загрузку библиотеки', () => { void fetchArtwork(); }));
          updateImportState(); return;
        }
        const fields = el('div', 'document-form-grid');
        for (const kind of ['stamp', 'signature']) {
          const items = list(stampLibrary[kind === 'stamp' ? 'stamps' : 'signatures']); const selected = items.find(item => item.id === artworkConfig[kind]?.id);
          const stale = artworkConfig[kind] && (!selected || selected.sha256 !== artworkConfig[kind].sha256 || selected.revision !== artworkConfig[kind].revision);
          const wrongInn = kind === 'stamp' && selected && text(selected.companyInn) !== text(value.inn);
          if (stale || wrongInn) artworkInvalid = true;
          const options = [{ value: '', label: kind === 'stamp' ? 'Без печати' : 'Без подписи' }, ...items.map(item => ({ value: item.id, label: item.name + (kind === 'stamp' ? ' · ИНН ' + item.companyInn + (text(item.companyInn) !== text(value.inn) ? ' — другой ИНН' : '') : item.signer ? ' · ' + item.signer : ''), disabled: !stampImageUrl(kind, item.id) || (kind === 'stamp' && text(item.companyInn) !== text(value.inn)) }))];
          if (stale) options.push({ value: '__stale__', label: 'Изображение изменилось — выберите заново', disabled: true });
          const select = choice(kind === 'stamp' ? 'Печать организации' : 'Подпись для документов', options, stale ? '__stale__' : artworkConfig[kind]?.id || '');
          select.input.addEventListener('change', () => {
            const next = items.find(item => item.id === select.input.value);
            if (select.input.value && (!next || !stampImageUrl(kind, next.id) || (kind === 'stamp' && text(next.companyInn) !== text(value.inn)))) { renderArtwork(); return; }
            artworkConfig[kind] = next ? { id: next.id, sha256: next.sha256, revision: next.revision } : null; storeArtwork(); renderArtwork();
          }); fields.append(select.group);
        }
        const profile = choice('Скан-эффект', [{ value: 'light', label: 'Лёгкий' }, { value: 'standard', label: 'Обычный скан' }, { value: 'strong', label: 'Выраженный' }], artworkConfig.profile);
        profile.input.addEventListener('change', () => { artworkConfig.profile = profile.input.value; storeArtwork(); renderArtwork(); });
        const dpi = choice('Качество скана', [{ value: '150', label: '150 dpi' }, { value: '200', label: '200 dpi' }], text(artworkConfig.dpi));
        dpi.input.addEventListener('change', () => { artworkConfig.dpi = Number(dpi.input.value); storeArtwork(); renderArtwork(); }); fields.append(profile.group, dpi.group);
        artworkBody.append(fields);
        if (artworkConfig.stamp || artworkConfig.signature) artworkBody.append(stampSummary(artworkConfig, stampLibrary));
        if (artworkInvalid) artworkBody.append(el('p', 'document-warning', 'Проверьте привязку: выберите актуальные изображения с ИНН этой организации или уберите их.'));
        artworkBody.append(el('p', 'document-hint', 'Изображения выбираются явно для этого юрлица. Общий выбор в Оттисках не меняется. Без привязки создаётся исходный PDF.'));
        updateImportState();
      }
      async function fetchArtwork() { try { await loadStampLibrary(); } catch {} if (edit.dialog.isConnected) renderArtwork(); }
      refreshArtwork = renderArtwork;
      function updateImportState() {
        value.source = { ...value.source, unresolvedFields: [...unresolved] };
        save.disabled = saving || unresolved.size > 0 || artworkInvalid;
        const labels = Object.fromEntries([...PARTY, ...BANK, ['signer', 'Подписант'], ['signerRole', 'Должность подписанта']]);
        parseNotice.textContent = unresolved.size ? 'В исходнике есть неоднозначные поля. Укажите каждое из них вручную перед сохранением: ' + [...unresolved].map(key => key.startsWith('account:') ? 'Счёт: ' + (labels[key.split(':').at(-1)] || 'реквизиты') : labels[key] || 'исходный текст').join(', ') + '.' : 'Проверьте реквизиты перед сохранением.';
      }
      updateImportState();
      form.append(pasted.group, parse, parseNotice, grid, accounts, add, artwork, status, save); edit.shell.append(form);
      renderArtwork(); void fetchArtwork();
      const baseline = JSON.stringify(value);
      edit.setGuard(() => {
        if (sellerPending?.seller.id === value.id) { status.textContent = 'Сначала проверьте результат сохранения организации.'; return false; }
        return JSON.stringify(value) === baseline || confirm('Закрыть карточку без сохранения изменений?');
      });
      form.addEventListener('submit', async event => {
        event.preventDefault(); if (unresolved.size || artworkInvalid) { updateImportState(); return; } const issues = validateFields(value).concat(value.accounts.flatMap(validateFields));
        if (issues.length) { status.textContent = issues.map(issue => issue.message).join(' '); return; }
        if (sellerPending && sellerPending.seller.id !== value.id) { status.textContent = 'Сначала проверьте сохранение предыдущей организации.'; return; }
        sellerPending ||= { requestId: uuid(), seller: clone(value) };
        saving = true;
        for (const control of form.querySelectorAll('input,select,textarea,button')) control.disabled = true;
        status.textContent = 'Сохраняем организацию…';
        try {
          const response = await api('/document-sellers', { method: 'POST', body: JSON.stringify(sellerPending) });
          if (response.state && response.state !== 'confirmed') throw new Error('Сохранение организации пока не подтверждено. Повторите проверку.');
          sellerPending = null; edit.setGuard(null); edit.close(); await refresh(); afterSave?.(); onSellersChange?.();
        } catch (error) {
          saving = false;
          if ([400, 422].includes(error.status) || ['DOCUMENT_SELLER_CONFLICT', 'DOCUMENT_ACCOUNT_INVALID', 'DOCUMENT_REQUEST_CONFLICT'].includes(error.code)) sellerPending = null;
          for (const control of form.querySelectorAll('input,select,textarea,button')) control.disabled = Boolean(sellerPending);
          save.disabled = false; save.textContent = sellerPending ? 'Проверить сохранение' : 'Сохранить организацию'; status.textContent = error.message; onError?.(error);
        }
      });
    }
    await refresh();
  }
  return {
    openSellers,
    renderOrder(order) {
      const id = text(order.id); let entry = orders.get(id);
      if (!entry) { const job = pending.get(id), stamping = stampPending.get(id); entry = { order, draft: { type: 'invoice', sellerId: '', accountId: '', number: '', date: today(), amountDue: '', test: false, ...job?.payload, ...stamping?.basePayload }, data: null, loading: false, host: null, error: '' }; orders.set(id, entry); }
      entry.order = order; entry.host = el('section', 'order-documents');
      queueMicrotask(() => { if (stampPending.has(id)) { paint(entry); if (stampPending.get(id).state === 'processing' && !entry.stampTimer) void runStamps(entry); } else if (!entry.data && !entry.loading) void loadOrder(entry); else paint(entry); }); return entry.host;
    },
    pendingNotice(order, openDocuments) {
      if (!stampPending.has(text(order.id))) return null;
      const notice = el('section', 'document-warning'); notice.append(el('p', '', 'Для одного PDF этого заказа ещё нужно проверить печать и скан. Исходный файл сохранён.'), button('Проверить печать и скан', openDocuments)); return notice;
    },
  };
}
