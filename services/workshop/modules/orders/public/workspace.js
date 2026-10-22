import { enhanceClientSelect } from './client-search.js';
function el(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined && value !== null) node.textContent = String(value);
  return node;
}
function button(label, className, action) {
  const node = el('button', className, label);
  node.type = 'button';
  if (action) node.addEventListener('click', action);
  return node;
}
function string(value) { return value === undefined || value === null ? '' : String(value); }
let editorSequence = 0;
function mediaUrl(value) {
  try {
    const url = new URL(value, location.origin);
    return url.origin === location.origin && url.pathname.startsWith('/kanban/api/orders/') && url.pathname.includes('/media/') ? url.href : null;
  } catch { return null; }
}
function bytes(value) {
  return value < 1024 * 1024 ? `${Math.ceil(value / 1024)} КБ` : `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value / 1024 / 1024)} МБ`;
}

export function createMediaGallery({ orderId, media = {}, api, onChange, onBusy }) {
  const wrapper = el('section', 'media-section');
  const toolbar = el('div', 'media-toolbar');
  const title = el('div');
  title.append(el('h3', 'section-label', 'Файлы заказа'), el('p', 'media-description', 'Макеты, фотографии и документы. Обложка видна на доске.'));
  const fileInput = el('input', 'file-picker');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.accept = 'image/jpeg,image/png,image/webp,image/gif,application/pdf,.cdr';
  fileInput.setAttribute('aria-label', 'Загрузить файлы заказа');
  fileInput.tabIndex = -1;
  const upload = button('+ Добавить файлы', 'button button-primary', () => fileInput.click());
  toolbar.append(title, upload, fileInput);
  const mailImport = el('a', 'button button-outline', 'Из письма');
  mailImport.href = '/kanban/mail-import.html';
  toolbar.append(mailImport);
  const status = el('p', 'media-feedback');
  status.setAttribute('role', 'status');
  const limits = el('p', 'media-limits', 'CDR — до 64 МБ · JPG, PNG, WebP, GIF, PDF — до 12 МБ');
  const grid = el('div', 'media-grid');
  const empty = el('div', 'media-empty');
  empty.append(el('span', 'media-empty-symbol', '↥'), el('strong', '', 'Здесь будут файлы заказа'), el('span', '', 'Добавьте макет или фотографию. Первое изображение станет обложкой.'));
  const storage = el('div', 'media-storage');
  wrapper.append(toolbar, limits, status, grid, empty, storage);
  let current = { items: Array.isArray(media.items) ? media.items : [], coverId: media.coverId || null };
  let busy = false;

  function setBusy(value) {
    busy = value;
    upload.disabled = value;
    wrapper.setAttribute('aria-busy', String(value));
    grid.querySelectorAll('button').forEach((node) => { node.disabled = value || node.dataset.currentCover === 'true'; });
    onBusy?.(value);
  }
  function apply(value) {
    current = { items: Array.isArray(value.items) ? value.items : [], coverId: value.coverId || null };
    render();
    onChange?.(current);
  }
  async function mutate(action, message) {
    if (busy) return;
    setBusy(true);
    status.className = 'media-feedback';
    status.textContent = message;
    try {
      apply(await action());
      status.textContent = 'Сохранено';
    } catch (error) {
      status.className = 'media-feedback error';
      status.textContent = error.message || 'Не удалось выполнить действие. Попробуйте ещё раз.';
    } finally { setBusy(false); }
  }
  function render() {
    grid.replaceChildren();
    empty.hidden = current.items.length > 0;
    for (const item of current.items) {
      const card = el('article', 'media-card');
      const url = mediaUrl(item.url);
      const downloadUrl = mediaUrl(item.downloadUrl || item.url);
      const preview = el('a', `media-preview${item.kind === 'image' ? '' : ' media-document'}`);
      if (item.derivedFrom?.kind === 'cdr-preview') preview.classList.add('cdr-preview');
      if (url) { preview.href = url; preview.target = '_blank'; preview.rel = 'noopener noreferrer'; }
      preview.setAttribute('aria-label', `Открыть ${item.name}`);
      if (item.kind === 'image' && url) {
        const image = el('img');
        image.src = url;
        image.alt = string(item.name);
        image.loading = 'lazy';
        image.decoding = 'async';
        image.addEventListener('error', () => { preview.replaceChildren(el('span', '', 'Предпросмотр недоступен')); });
        preview.append(image);
      } else { preview.append(el('span', 'pdf-symbol', item.contentType === 'application/vnd.corel-draw' ? 'CDR' : 'PDF'), el('span', '', 'Скачать документ')); }
      if (current.coverId === item.id) preview.append(el('span', 'cover-label', 'Обложка'));
      const info = el('div', 'media-card-info');
      const name = el('p', 'media-filename', item.name);
      name.title = string(item.name);
      info.append(name, el('span', 'media-size', bytes(Number(item.size) || 0)));
      if (item.generatedDocument) {
        const doc = item.generatedDocument;
        const decoration = doc.decoration?.kind === 'scan' ? ' · Скан-эффект' : doc.decoration?.kind === 'stamped' ? ' · Печать / подпись' : '';
        info.append(el('p', 'media-description', `Создан из заказа · ${doc.type === 'upd' ? 'УПД' : 'Счёт'} №${doc.number || '—'} · версия ${doc.version || '—'}${decoration}${doc.test ? ' · ТЕСТОВЫЙ · НЕ ДЛЯ ОПЛАТЫ' : ''}`));
      }
      if (item.source) info.append(el('p', 'media-description', `Из письма: ${item.source.subject || 'Без темы'} · ${item.source.from}${item.source.sentAt ? ` · ${new Date(item.source.sentAt).toLocaleDateString('ru-RU')}` : ''}`));
      if (item.derivedFrom?.kind === 'cdr-preview') {
        const original = current.items.find(file => file.id === item.derivedFrom.mediaId);
        info.append(el('p', 'media-description', `Превью из ${original?.name || 'исходного CDR'}`));
      }
      if (item.previewStatus === 'unavailable') info.append(el('p', 'media-description', 'В CDR нет доступной миниатюры. Исходник сохранён.'));
      if (item.previewStatus === 'error') info.append(el('p', 'media-description', 'Исходник сохранён. Создание превью будет повторено.'));
      const actions = el('div', 'media-actions');
      if (item.kind === 'image') {
        const cover = button(current.coverId === item.id ? '✓ Обложка' : 'На обложку', 'media-action', () => mutate(() => api(`/orders/${encodeURIComponent(orderId)}/media/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify({ cover: true }) }), 'Обновляем обложку…'));
        cover.dataset.currentCover = String(current.coverId === item.id);
        cover.disabled = current.coverId === item.id || busy;
        actions.append(cover);
      }
      if (downloadUrl) {
        const download = el('a', 'media-action', 'Скачать');
        const forced = new URL(downloadUrl);
        forced.searchParams.set('download', '1');
        download.href = forced.href;
        download.setAttribute('download', string(item.name));
        actions.append(download);
      }
      const remove = button('Удалить', 'media-action media-remove', () => {
        if (busy) return;
        const confirmation = el('div', 'media-delete-confirm');
        confirmation.append(el('span', '', 'Удалить этот файл?'), button('Удалить', 'media-action media-remove', () => mutate(() => api(`/orders/${encodeURIComponent(orderId)}/media/${encodeURIComponent(item.id)}`, { method: 'DELETE' }), 'Удаляем файл…')), button('Оставить', 'media-action', () => confirmation.remove()));
        card.querySelector('.media-delete-confirm')?.remove();
        card.append(confirmation);
        confirmation.querySelector('button')?.focus();
      });
      remove.disabled = busy;
      actions.append(remove);
      info.append(actions);
      card.append(preview, info);
      grid.append(card);
    }
    const total = current.items.reduce((count, item) => count + (Number(item.size) || 0), 0);
    storage.textContent = `${current.items.length} из 30 файлов · ${bytes(total)} из 200 МБ`;
  }
  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files || []);
    fileInput.value = '';
    if (busy || !files.length) return;
    setBusy(true);
    const errors = [];
    let uploaded = 0;
    const accepted = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);
    for (const file of files) {
      const contentType = /\.cdr$/i.test(file.name) ? 'application/vnd.corel-draw' : file.type;
      if (!accepted.has(contentType) && contentType !== 'application/vnd.corel-draw') { errors.push(`${file.name}: поддерживаются изображения, PDF и CDR.`); continue; }
      const limit = /\.cdr$/i.test(file.name) ? 64 : 12;
      if (file.size > limit * 1024 * 1024) { errors.push(`${file.name}: размер больше ${limit} МБ.`); continue; }
      status.className = 'media-feedback';
      status.textContent = `Загружаем ${uploaded + 1} из ${files.length}: ${file.name}`;
      try {
        apply(await api(`/orders/${encodeURIComponent(orderId)}/media`, { method: 'POST', headers: { 'Content-Type': contentType, 'X-File-Name': encodeURIComponent(file.name) }, body: file }));
        uploaded += 1;
      } catch (error) { errors.push(`${file.name}: ${error.message}`); }
    }
    setBusy(false);
    status.className = `media-feedback${errors.length ? ' error' : ''}`;
    status.textContent = [uploaded ? `Загружено файлов: ${uploaded}.` : '', ...errors].filter(Boolean).join(' ');
  });
  render();
  return wrapper;
}

function defaultInputValue(value, type) {
  if (type === 'date') {
    const raw = string(value);
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
    const ru = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (ru) return `${ru[3]}-${ru[2].padStart(2, '0')}-${ru[1].padStart(2, '0')}`;
  }
  return string(value);
}

export function openRecordEditor({ title, subtitle, fields, values = {}, submit, refreshSource, onSaved, onClose, submitLabel = 'Сохранить изменения', mode = 'edit', pendingCreation = false, eyebrow, creationTitle = 'Создание заказа', sourceLabel = 'Заказ', createHint, busyLabel = 'Создаём…', retryLabel = 'Проверить создание', allowCopy = true, enhance }) {
  const dialog = el('dialog', 'record-dialog');
  const editorId = `record-editor-${++editorSequence}`;
  dialog.setAttribute('aria-labelledby', `${editorId}-title`);
  const previousFocus = document.activeElement;
  const shell = el('form', 'record-shell');
  const header = el('header', 'record-header');
  const titleBlock = el('div');
  const heading = el('h2', 'record-title', title);
  heading.id = `${editorId}-title`;
  titleBlock.append(el('p', 'eyebrow', eyebrow || (mode === 'create' ? 'СОЗДАНИЕ ЗАКАЗА' : 'РЕДАКТИРОВАНИЕ')), heading);
  if (subtitle) titleBlock.append(el('p', 'record-subtitle', subtitle));
  const close = button('×', 'dialog-close', () => requestClose());
  close.setAttribute('aria-label', 'Закрыть редактор');
  header.append(titleBlock, close);
  const body = el('div', 'record-body');
  const grid = el('div', 'record-grid');
  const sections = new Map();
  const controls = new Map();
  const computed = new Map();
  const initial = new Map();
  const actionButtons = new Map();
  const activeActions = new Set();
  let extension=null;
  let dirty = false;
  let busy = false;
  let retryBlocked = false;
  let financePending = false;
  let uncertainCreation = mode === 'create' && pendingCreation;
  const unresolved = new Set();
  let closingPrompt = null;
  const error = el('div', 'record-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const footer = el('footer', 'record-footer');
  const footerHint = el('span', 'record-save-hint', 'Изменения сохранятся в таблице');
  const footerActions = el('div', 'record-footer-actions');
  const cancel = button('Отмена', 'button button-outline', () => requestClose());
  const save = button(submitLabel, 'button button-primary');
  save.type = 'submit';
  footerActions.append(cancel, save);
  footer.append(footerHint, footerActions);

  function fieldTarget(field, index) {
    if (!field.section) return grid;
    const key = string(field.section);
    if (sections.has(key)) return sections.get(key);
    const section = el('section', 'record-section');
    const heading = el('div', 'record-section-heading');
    const title = el('h3', '', key);
    title.id = `${editorId}-section-${sections.size + 1}`;
    heading.append(title);
    if (field.sectionHint) heading.append(el('p', '', field.sectionHint));
    const fields = el('div', 'record-section-grid');
    section.setAttribute('aria-labelledby', title.id);
    section.append(heading, fields);
    grid.append(section);
    sections.set(key, fields);
    return fields;
  }

  for (const [index, field] of fields.entries()) {
    const key = field.key;
    const type = field.type || 'text';
    const group = el('div', `record-field${field.fullWidth || ['textarea', 'multiline'].includes(type) ? ' full-width' : ''}${field.readOnly ? ' readonly' : ''}`);
    const id = `${editorId}-field-${index}`;
    const target = fieldTarget(field, index);
    const label = el('label', '', field.label || key);
    label.htmlFor = id;
    if (field.required) label.append(el('span', 'required-mark', ' *'));
    const initialValue = Object.hasOwn(values, key) ? values[key] : field.value;
    let input;
    if (field.readOnly) {
      input = el('div', 'record-computed', initialValue === null || initialValue === undefined || initialValue === '' ? '—' : initialValue);
      input.id = id;
      computed.set(key, input);
      group.append(label, input, el('p', 'record-field-hint', field.hint || 'Рассчитывается из связанных данных'));
      target.append(group);
      continue;
    }
    if (type === 'boolean' || type === 'checkbox') {
      input = el('input');
      input.type = 'checkbox';
      input.checked = initialValue === true || initialValue === 'TRUE' || initialValue === 1;
      group.classList.add('record-checkbox');
    } else if (Array.isArray(field.options) && (field.options.length || type === 'select')) {
      input = el('select');
      if (!field.required) { const empty = el('option', '', 'Не указано'); empty.value = ''; input.append(empty); }
      const optionValues = field.options.map((option) => typeof option === 'object' ? option.value : option);
      if (initialValue !== undefined && initialValue !== null && initialValue !== '' && !optionValues.some((value) => string(value) === string(initialValue))) {
        const current = el('option', '', initialValue);
        current.value = string(initialValue);
        input.append(current);
      }
      for (const option of field.options) {
        const node = el('option', '', typeof option === 'object' ? option.label ?? option.value : option);
        node.value = string(typeof option === 'object' ? option.value : option);
        input.append(node);
      }
      input.value = string(initialValue);
    } else if (type === 'textarea' || type === 'multiline') {
      input = el('textarea');
      input.rows = field.rows || 3;
      input.value = string(initialValue);
    } else {
      input = el('input');
      input.type = ['date', 'time', 'number', 'email', 'tel', 'password'].includes(type) ? type : 'text';
      if (type === 'number') { input.step = 'any'; input.inputMode = 'decimal'; }
      input.value = defaultInputValue(initialValue, type);
    }
    input.id = id;
    input.name = key;
    input.required = Boolean(field.required);
    if (field.placeholder) input.placeholder = field.placeholder;
    if (field.maxLength) input.maxLength = field.maxLength;
    if (field.min !== undefined) input.min = field.min;
    if (field.max !== undefined) input.max = field.max;
    if (field.autocomplete) input.autocomplete = field.autocomplete;
    const read = () => input.type === 'checkbox' ? input.checked : input.type === 'number' ? (input.value === '' ? '' : Number(input.value)) : input.value;
    const write = (value) => {
      if (input.type === 'checkbox') input.checked = value === true || value === 'TRUE' || value === 1;
      else {
        const next = defaultInputValue(value, type);
        if (input.tagName === 'SELECT' && !Array.from(input.options).some((option) => option.value === next)) { const option = el('option', '', next || 'Не указано'); option.value = next; input.append(option); }
        input.value = next;
      }
    };
    controls.set(key, { input, read, write, group, label: field.label || key });
    initial.set(key, read());
    input.addEventListener('input', () => {
      updateDraftState();
      if (closingPrompt) { closingPrompt.remove(); closingPrompt = null; }
    });
    group.append(label, input);
    if (field.hint) group.append(el('p', 'record-field-hint', field.hint));
    if (field.actionLabel && typeof field.action === 'function') {
      const fieldAction = button(field.actionLabel, 'record-field-action', async () => {
        if (busy || uncertainCreation || activeActions.has(key)) return;
        activeActions.add(key);
        updateDraftState();
        error.hidden = true;
        try { await field.action(editorApi); }
        catch (failure) {
          if (dialog.isConnected) {
            error.hidden = false;
            error.replaceChildren(el('strong', '', 'Не удалось открыть форму.'), el('p', '', failure.message || 'Повторите попытку.'), errorActions());
            error.scrollIntoView({ block: 'nearest' });
          }
        } finally {
          activeActions.delete(key);
          updateDraftState();
        }
      });
      actionButtons.set(key, fieldAction);
      group.append(fieldAction);
    }
    target.append(group);
    if(field.searchable && input.tagName==='SELECT') controls.get(key).clientSearch=enhanceClientSelect(input,field.contacts||[]);
  }
  body.append(grid, error);
  shell.append(header, body, footer);
  dialog.append(shell);
  document.body.append(dialog);

  const editorApi = {
    dialog,
    isOpen() { return dialog.isConnected && dialog.open; },
    getValue(key) { return controls.get(key)?.read(); },
    setValue(key, value) {
      const entry = controls.get(key);
      if (!entry) return false;
      entry.write(value);
      entry.input.dispatchEvent(new Event('input',{bubbles:true}));
      updateDraftState();
      return true;
    },
    addOption(key, option, { select = false } = {}) {
      const entry = controls.get(key);
      if (!entry || entry.input.tagName !== 'SELECT') return false;
      const value = string(typeof option === 'object' ? option.value : option);
      const label = string(typeof option === 'object' ? option.label ?? option.value : option);
      if (!Array.from(entry.input.options).some(node => node.value === value)) {
        const node = el('option', '', label);
        node.value = value;
        node.dataset.phone=option.phone||'';
        node.dataset.contact=option.contact||'';
        entry.input.append(node);
      }
      if (select) entry.write(value);
      entry.input.dispatchEvent(new Event('input',{bubbles:true}));
      entry.input.dispatchEvent(new Event('input',{bubbles:true}));
      updateDraftState();
      return true;
    },
    setActionLabel(key, label) {
      const node = actionButtons.get(key);
      if (!node) return false;
      node.textContent = string(label);
      return true;
    },
  };

  extension = enhance?.({dialog,grid,controls,editorApi,changed:()=>updateDraftState()});

  function updateDraftState() {
    dirty = Boolean(extension?.hasChanges?.()) || Array.from(controls).some(([key, entry]) => entry.read() !== initial.get(key));
    extension?.setDisabled?.(busy || uncertainCreation);
    footerHint.textContent = uncertainCreation ? 'Проверим результат без создания копии' : unresolved.size ? 'Сверьте поля, изменённые в таблице' : retryBlocked ? 'Сначала проверьте актуальные данные' : dirty ? 'Есть несохранённые изменения' : mode === 'create' ? createHint || `${sourceLabel} сохранится в таблице` : 'Изменения совпадают с таблицей';
    footerHint.classList.toggle('has-draft', dirty || retryBlocked || uncertainCreation);
    save.disabled = busy || retryBlocked || unresolved.size > 0 || activeActions.size > 0;
    for (const [key, node] of actionButtons) {
      node.disabled = busy || uncertainCreation;
      node.setAttribute('aria-busy', String(activeActions.has(key)));
    }
    if (!busy) save.textContent = uncertainCreation ? retryLabel : submitLabel;
  }
  function errorActions() {
    const actions = el('div', 'record-error-actions');
    if (refreshSource) actions.append(button('Обновить исходные данные', 'button button-outline', refreshDraft));
    if (allowCopy) actions.append(button('Скопировать изменения', 'button button-outline', async () => {
      const lines = Array.from(controls).filter(([key, entry]) => mode === 'create' || entry.read() !== initial.get(key)).map(([, entry]) => `${entry.label}: ${entry.read()}`);
      const content = `${title}\n${lines.join('\n')}`;
      try { await navigator.clipboard.writeText(content); actions.append(el('span', 'record-copy-note', 'Изменения скопированы')); }
      catch {
        const area = el('textarea', 'record-draft-copy');
        area.value = content;
        area.readOnly = true;
        area.setAttribute('aria-label', 'Изменения для копирования');
        error.append(area);
        area.focus();
        area.select();
      }
    }));
    return actions;
  }
  async function refreshDraft() {
    if (busy || !refreshSource) return;
    busy = true;
    updateDraftState();
    cancel.disabled = true;
    close.disabled = true;
    for (const { input } of controls.values()) input.disabled = true;
    error.querySelectorAll('button').forEach((node) => { node.disabled = true; });
    const old = new Map(initial);
    const drafts = new Map(Array.from(controls).map(([key, entry]) => [key, entry.read()]));
    try {
      const freshFields = await refreshSource();
      const byKey = new Map(freshFields.map((field) => [field.key, field]));
      for (const [key, draft] of drafts) {
        if (draft !== old.get(key) && (!byKey.has(key) || byKey.get(key).readOnly)) throw new Error('Одно из изменённых полей больше недоступно для редактирования. Черновик оставлен в форме; скопируйте его перед закрытием.');
      }
      unresolved.clear();
      grid.querySelectorAll('.record-field-conflict').forEach((node) => node.remove());
      for (const [key, entry] of controls) {
        const source = byKey.get(key);
        if (!source) continue;
        if (entry.input.tagName === 'SELECT' && Array.isArray(source.options)) {
          entry.input.replaceChildren();
          if (!source.required) { const empty = el('option', '', 'Не указано'); empty.value = ''; entry.input.append(empty); }
          const options = [...source.options];
          if (source.value && !options.some(option => string(typeof option === 'object' ? option.value : option) === string(source.value))) options.push(source.value);
          for (const option of options) {
            const node = el('option', '', typeof option === 'object' ? option.label ?? option.value : option);
            node.value = string(typeof option === 'object' ? option.value : option);
            entry.input.append(node);
          }
        }
        entry.write(source.value);
        const fresh = entry.read();
        initial.set(key, fresh);
        const edited = drafts.get(key) !== old.get(key);
        if (edited) entry.write(drafts.get(key));
        entry.clientSearch?.refresh(source.contacts || []);
        if (edited && fresh !== old.get(key) && drafts.get(key) !== fresh) {
          unresolved.add(key);
          if (entry.group.dataset.configField) entry.group.hidden = false;
          const conflict = el('div', 'record-field-conflict');
          conflict.append(el('p', '', `В таблице сейчас: ${fresh === '' ? 'не заполнено' : fresh}. В поле оставлен ваш вариант.`));
          const resolve = (useSource) => {
            if (useSource) entry.write(fresh);
            entry.clientSearch?.refresh(source.contacts || []);
            unresolved.delete(key);
            conflict.remove();
            if (entry.group.dataset.configField) entry.group.hidden = true;
            extension?.refresh?.();
            updateDraftState();
          };
          conflict.append(button('Взять из таблицы', 'button button-outline', () => resolve(true)), button('Оставить мой вариант', 'button button-outline', () => resolve(false)));
          entry.group.append(conflict);
        }
      }
      extension?.refresh?.();
      for (const [key, node] of computed) if (byKey.has(key)) node.textContent = string(byKey.get(key).value) || '—';
      dirty = Boolean(extension?.hasChanges?.()) || Array.from(controls).some(([key, entry]) => entry.read() !== initial.get(key));
      retryBlocked = financePending && dirty;
      error.replaceChildren(el('strong', '', retryBlocked ? 'Правка сохранена в финансах, ожидаем синхронизацию.' : 'Исходные данные обновлены. Черновик сохранён.'), el('p', '', retryBlocked ? 'Повторная запись заблокирована. Обновите исходные данные чуть позже.' : unresolved.size ? 'Проверьте отмеченные поля и выберите значения перед сохранением.' : dirty ? 'Проверьте ваш вариант и нажмите «Сохранить изменения», когда будете готовы.' : 'Ваши значения уже отражены в таблице. Можно закрыть редактор.'), errorActions());
    } catch (failure) {
      retryBlocked = true;
      error.replaceChildren(el('strong', '', 'Не удалось безопасно обновить запись.'), el('p', '', failure.message), el('p', 'record-error-help', 'Черновик сохранён. Скопируйте изменения, затем откройте нужную запись заново.'), errorActions());
    } finally {
      busy = false;
      cancel.disabled = false;
      close.disabled = false;
      for (const { input } of controls.values()) input.disabled = false;
      updateDraftState();
    }
  }

  function closeEditor() {
    extension?.destroy?.();
    dialog.close();
    dialog.remove();
    window.removeEventListener('beforeunload', beforeUnload);
    onClose?.();
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  }
  function requestClose() {
    if (busy) return;
    if (uncertainCreation) { closeEditor(); return; }
    if (!dirty) { closeEditor(); return; }
    if (closingPrompt) { closingPrompt.querySelector('button')?.focus(); return; }
    closingPrompt = el('div', 'draft-confirm');
    closingPrompt.append(el('span', '', 'Изменения ещё не сохранены.'), button('Продолжить редактирование', 'button button-outline', () => { closingPrompt.remove(); closingPrompt = null; }), button('Не сохранять', 'button button-danger-soft', closeEditor));
    footer.before(closingPrompt);
    closingPrompt.querySelector('button')?.focus();
  }
  function beforeUnload(event) { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } }
  window.addEventListener('beforeunload', beforeUnload);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); requestClose(); });
  shell.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || retryBlocked || unresolved.size || !shell.reportValidity()) return;
    const changes = {};
    const all = {};
    for (const [key, { read }] of controls) {
      all[key] = read();
      if (all[key] !== initial.get(key)) changes[key] = all[key];
    }
    if (!Object.keys(changes).length && !extension?.hasChanges?.() && mode !== 'create' && submitLabel !== 'Создать монтаж') { closeEditor(); return; }
    busy = true;
    extension?.setDisabled?.(true);
    save.disabled = true;
    cancel.disabled = true;
    close.disabled = true;
    for (const { input } of controls.values()) input.disabled = true;
    for (const node of actionButtons.values()) node.disabled = true;
    save.textContent = uncertainCreation ? 'Проверяем…' : mode === 'create' ? busyLabel : 'Сохраняем…';
    error.hidden = true;
    try {
      const result = await submit(changes, all);
      dirty = false;
      closeEditor();
      await onSaved?.(result);
    } catch (failure) {
      error.hidden = false;
      financePending = failure.code === 'FINANCE_PENDING';
      retryBlocked = financePending || failure.status === 409 || failure.status >= 500 || !failure.status || ['EDIT_UNCONFIRMED', 'MOVE_UNCONFIRMED'].includes(failure.code);
      if (mode === 'create' && failure.creationSafeFailure) { uncertainCreation = false; retryBlocked = false; }
      else if (mode === 'create' && (retryBlocked || failure.creationPending)) { uncertainCreation = true; retryBlocked = false; }
      const heading = uncertainCreation ? `${creationTitle} пока не подтверждено.` : financePending ? 'Правка сохранена, синхронизация продолжается.' : failure.code === 'RECORD_CONFLICT' ? 'Данные изменились после открытия редактора.' : retryBlocked ? 'Результат записи нужно проверить.' : 'Проверьте введённые значения.';
      error.replaceChildren(el('strong', '', heading), el('p', '', failure.message || 'Не удалось получить подтверждение от сервера.'), el('p', 'record-error-help', uncertainCreation ? `Нажмите «${retryLabel}»: используем тот же запрос, чтобы избежать копии. Поля сохранены и временно заблокированы.` : retryBlocked ? 'Повторная запись заблокирована до проверки. Ваши значения сохранены в этой форме.' : 'Ваши значения сохранены в форме. Исправьте отмеченное поле и сохраните снова.'), errorActions());
      error.scrollIntoView({ block: 'nearest' });
    } finally {
      busy = false;
      cancel.disabled = false;
      close.disabled = false;
      save.textContent = submitLabel;
      for (const { input } of controls.values()) input.disabled = uncertainCreation;
      updateDraftState();
    }
  });
  if (uncertainCreation) {
    for (const { input } of controls.values()) input.disabled = true;
    error.hidden = false;
    error.append(el('strong', '', `Продолжим проверку: ${creationTitle.toLowerCase()}.`), el('p', '', `Предыдущий запрос ещё не подтверждён. Нажмите «${retryLabel}»: проверим тот же результат без повторного добавления.`));
  }
  updateDraftState();
  dialog.showModal();
  const firstInput = grid.querySelector('input:not([type=checkbox]):not(:disabled),textarea:not(:disabled),select:not(:disabled)');
  (firstInput || close).focus({ preventScroll: true });
  return dialog;
}
