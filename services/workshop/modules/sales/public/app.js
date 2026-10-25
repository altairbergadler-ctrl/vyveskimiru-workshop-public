const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
const statusNames = {
  active: 'В работе',
  waiting: 'Ожидание',
  archived: 'В архиве',
  merged: 'Объединено',
};
const channelNames = {
  avito: 'Авито',
  mail: 'Почта',
  max: 'MAX',
  telegram: 'Telegram',
  forms: 'Сайт',
  calls: 'Звонок',
};
const viewNames = {
  desk: 'Мой стол',
  inbox: 'Входящие',
  today: 'Сегодня',
  team: 'Команда',
  archive: 'Архив',
  channels: 'Подключения',
  settings: 'Настройки',
};
const state = {
  snapshot: null,
  view: 'desk',
  inboxCursor: '',
  inboxChannel: 'avito',
  inboxScope: 'pending',
  chatBusy: '',
  detailRequest: 0,
  inboxPrevious: [],
  inboxLoading: false,
  inboxSearching: false,
  refreshId: 0,
  zone: '',
  list: false,
  pan: { x: 20, y: 20 },
  detail: null,
  tab: 'overview',
  busy: false,
  pending: null,
  drafts: [],
  recoveries: {},
};
const announcedNotices = new Set();
const options = (values, selected) =>
  values
    .map(
      ([v, label]) =>
        `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(label)}</option>`,
    )
    .join('');
const fmt = (value) =>
  value
    ? new Intl.DateTimeFormat('ru-RU', {
        timeZone: state.snapshot?.settings.timezone || 'Europe/Moscow',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(value))
    : 'Не указан';
const local = (value) => {
  if (!value) return '';
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
const iso = (value) => (value ? new Date(value).toISOString() : null);
const label = (name, caption, value = '', type = 'text', extra = '') =>
  `<label ${extra}>${esc(caption)}<input name="${esc(name)}" type="${type}" value="${esc(value)}" ${['title', 'action', 'object', 'owner'].includes(name) ? 'required' : ''}></label>`;
const select = (name, caption, values, selected, extra = '') =>
  `<label ${extra}>${esc(caption)}<select name="${name}">${options(values, selected)}</select></label>`;
const textarea = (name, caption, value, extra = 'class="wide"') =>
  `<label ${extra}>${esc(caption)}<textarea name="${name}">${esc(value || '')}</textarea></label>`;
let noticeTimer,
  mutationFlight = null;
function notice(message, error = false) {
  if (!$('notice').hidden && $('notice-text').textContent === message) return;
  clearTimeout(noticeTimer);
  $('notice-text').textContent = message;
  $('notice').className = 'notice' + (error ? ' error' : '');
  $('notice').hidden = false;
  if (!error)
    noticeTimer = setTimeout(() => {
      $('notice').hidden = true;
    }, 6000);
}
$('dismiss-notice').onclick = () => {
  $('notice').hidden = true;
};
async function api(path, options = {}) {
  const controller = new AbortController(),
    timer =
      options.body instanceof File
        ? null
        : setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch('/api/sales' + path, {
      ...options,
      signal: controller.signal,
      headers: {
        ...(options.body && typeof options.body === 'string'
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...options.headers,
      },
    });
    const value = await response.json();
    if (!response.ok) {
      const e = new Error(value.error || 'Ошибка запроса');
      e.status = response.status;
      e.current = value.current;
      e.code = value.code;
      throw e;
    }
    return value;
  } finally {
    clearTimeout(timer);
  }
}
function pending(value, uncertain = false) {
  state.pending = value;
  if (value) {
    sessionStorage.setItem('sales.pending', JSON.stringify(value));
    if (state.detail?.id)
      sessionStorage.setItem('sales.pending-note', state.detail.id);
  } else {
    sessionStorage.removeItem('sales.pending');
    sessionStorage.removeItem('sales.pending-note');
  }
  $('pending').hidden = !value || !uncertain;
}
function saveDraft(input) {
  const originalId = state.recoveries[input.requestId] || input.requestId;
  if (!state.drafts.some((d) => d.input.requestId === originalId))
    state.drafts.push({
      input,
      noteId:
        sessionStorage.getItem('sales.pending-note') ||
        input.data?.noteId ||
        input.noteId,
      at: new Date().toISOString(),
    });
  persistDrafts();
}
function recoveryReceipt(requestId, draftId) {
  state.recoveries[requestId] = draftId;
  sessionStorage.setItem('sales.recoveries', JSON.stringify(state.recoveries));
}
function resolveRecovery(requestId, confirmed) {
  const draftId = state.recoveries[requestId];
  if (confirmed && draftId) {
    state.drafts = state.drafts.filter((d) => d.input.requestId !== draftId);
    persistDrafts();
  }
  delete state.recoveries[requestId];
  sessionStorage.setItem('sales.recoveries', JSON.stringify(state.recoveries));
}
function persistDrafts() {
  sessionStorage.setItem('sales.drafts', JSON.stringify(state.drafts));
  $('drafts').hidden = !state.drafts.length;
  $('review-drafts').textContent = `Черновики (${state.drafts.length})`;
}
const draftLabels = {
  title: 'Название',
  client: 'Клиент',
  owner: 'Ответственный',
  manual: 'Заметки',
  status: 'Состояние обращения',
  state: 'Состояние',
  action: 'Действие',
  object: 'Объект',
  dueAt: 'Обещанный срок',
  remindAt: 'Напоминание',
  waitingFor: 'Ожидание',
  reviewAt: 'Контроль',
  reason: 'Причина',
  orderId: 'Заказ',
  priority: 'Приоритет',
  color: 'Цвет',
  newNote: 'Новая записка',
  patch: 'Изменённые поля',
  resolution: 'Итог объединения',
  fileIds: 'Выбранные файлы',
  eventIds: 'Выбранные события',
  positions: 'Положение записок',
  zones: 'Зоны',
  zoom: 'Масштаб',
  name: 'Название',
  mime: 'Тип файла',
};
function draftText(value) {
  return Object.entries(value || {})
    .filter(
      ([k]) =>
        ![
          'revision',
          'sourceRevision',
          'targetRevision',
          'eventRevision',
        ].includes(k),
    )
    .map(([k, v]) => {
      const name = draftLabels[k] || k;
      const shown =
        v && typeof v === 'object'
          ? draftText(v)
          : statusNames[v] || String(v ?? '—');
      return name + ': ' + shown;
    })
    .join('\n');
}
function showDrafts() {
  $('source-title').textContent = 'Несохранённые черновики';
  $('source-body').innerHTML = state.drafts
    .map(
      (d, i) =>
        `<section class="panel"><p>${fmt(d.at)}</p><pre class="manual">${esc(draftText(d.input.data || d.input))}</pre><button data-draft-review="${i}">Сверить с текущими данными</button> <button data-draft-remove="${i}">Удалить этот черновик</button></section>`,
    )
    .join('');
  if (!$('source-dialog').open) $('source-dialog').showModal();
  for (const button of $('source-body').querySelectorAll('[data-draft-remove]'))
    button.onclick = () => {
      state.drafts.splice(Number(button.dataset.draftRemove), 1);
      persistDrafts();
      showDrafts();
    };
  for (const button of $('source-body').querySelectorAll('[data-draft-review]'))
    button.onclick = () =>
      run(() => reviewDraft(Number(button.dataset.draftReview)));
}
async function reviewDraft(index) {
  if (state.pending)
    throw new Error(
      'Сначала проверьте результат предыдущего сохранения. Черновик сохранён.',
    );
  const draft = state.drafts[index],
    input = draft.input,
    data = structuredClone(input.data || {});
  if (input.file) {
    $('source-dialog').close();
    await openNote(input.noteId, 'files');
    upload(
      {
        ...input,
        requestId: crypto.randomUUID(),
        revision: state.detail.revision,
      },
      () => {},
      draft.input.requestId,
    );
    return;
  }
  let current = null;
  if (['note.update', 'note.manual'].includes(input.action))
    current = await api('/note?id=' + encodeURIComponent(data.id));
  const supported = ['note.update', 'note.manual', 'note.create'].includes(
    input.action,
  );
  $('source-dialog').close();
  editor(
    'Проверьте сохранённый черновик',
    `<p class="policy-box">${supported ? 'Будут применены только показанные сохранённые поля. Проверьте отличия от текущей записи.' : 'Эту операцию нужно заново выполнить в карточке. Черновик остаётся доступен для сверки.'}</p><h3>Сохранённые значения</h3><pre class="manual">${esc(draftText(data.patch || data))}</pre>${current ? '<h3>Текущие значения</h3><pre class="manual">' + esc(draftText(Object.fromEntries(Object.keys(data.patch || (input.action === 'note.manual' ? { manual: '' } : {})).map((k) => [k, current[k]])))) + '</pre>' : ''}`,
    async () => {
      if (!supported) return;
      if (input.action === 'note.manual') data.before = current.manual;
      else if (current) data.revision = current.revision;
      await mutate(input.action, data, draft.input.requestId);
      if (input.action === 'note.manual')
        sessionStorage.removeItem('sales.quick.' + data.id);
      state.drafts = state.drafts.filter((d) => d !== draft);
      persistDrafts();
    },
    supported ? 'Применить после сверки' : 'Закрыть',
  );
}
$('review-drafts').onclick = showDrafts;
function mutate(action, data, draftId, requestId = crypto.randomUUID()) {
  const previous = mutationFlight;
  const operation = (async () => {
    await previous?.catch(() => {});
    return performMutation(action, data, draftId, requestId);
  })();
  mutationFlight = operation;
  return operation.finally(() => {
    if (mutationFlight === operation) mutationFlight = null;
  });
}
async function performMutation(action, data, draftId, requestId) {
  if (state.pending)
    throw new Error('Сначала проверьте результат предыдущего сохранения.');
  const input = { requestId, action, data };
  if (draftId) recoveryReceipt(input.requestId, draftId);
  pending(input);
  try {
    const result = await api('/command', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    resolveRecovery(input.requestId, true);
    pending(null);
    return result;
  } catch (e) {
    if (e.status && e.status < 500) {
      if (e.status === 409) saveDraft(input);
      resolveRecovery(input.requestId, false);
      pending(null);
    } else pending(input, true);
    throw e;
  }
}
async function refresh({
  quiet = false,
  inboxCursor = state.inboxCursor,
  inboxPrevious = state.inboxPrevious,
} = {}) {
  const refreshId = ++state.refreshId;
  const query = state.view === 'inbox' ? $('search').value : '';
  if (
    query.trim().toLowerCase() !== state.snapshot?.chatPage.query ||
    state.inboxChannel !== state.snapshot?.chatPage.channel ||
    state.inboxScope !== state.snapshot?.chatPage.scope
  ) {
    inboxCursor = '';
    inboxPrevious = [];
  }
  const previous = [...inboxPrevious];
  if (state.view === 'inbox') {
    state.inboxSearching = true;
    render();
  }
  try {
    const snapshot = await api(
      '?chatCursor=' +
        encodeURIComponent(inboxCursor) +
        '&inboxQuery=' +
        encodeURIComponent(query) +
        '&channel=' +
        encodeURIComponent(state.inboxChannel) +
        '&scope=' +
        state.inboxScope,
    );
    if (refreshId !== state.refreshId) return 'stale';
    // Commit the page, its cursor and its back stack together only after acceptance.
    // A snapshot started before an acknowledged write must not rewind the layout.
    if (state.snapshot?.layout.revision > snapshot.layout.revision)
      snapshot.layout = state.snapshot.layout;
    if (zoomSaveTimer) snapshot.layout.zoom = state.snapshot.layout.zoom;
    state.snapshot = snapshot;
    for (const change of layoutChanges)
      applyLayoutPatch(snapshot.layout, change.data);
    state.inboxCursor = inboxCursor;
    state.inboxPrevious = previous;
    state.inboxSearching = false;
    $('app').hidden = false;
    $('login').hidden = true;
    render();
    if (!quiet) notice('Стол обновлён. Все изменения сохранены на сервере.');
    return 'applied';
  } catch (e) {
    if (refreshId !== state.refreshId) return 'stale';
    state.inboxSearching =
      state.view === 'inbox' &&
      ($('search').value.trim().toLowerCase() !==
        state.snapshot?.chatPage.query ||
        state.inboxChannel !== state.snapshot?.chatPage.channel ||
        state.inboxScope !== state.snapshot?.chatPage.scope);
    if (e.status === 401) {
      $('app').hidden = true;
      $('login').hidden = false;
    } else
      notice(
        e.message ||
          'Нет связи с сервером. Несохранённые изменения не подтверждены.',
        true,
      );
    render();
    return 'failed';
  }
}
function filteredNotes() {
  const s = state.snapshot,
    q = $('search').value.toLowerCase().trim();
  return s.notes
    .filter((n) =>
      state.view === 'archive'
        ? ['archived', 'merged'].includes(n.status)
        : !n.trashedAt && !['archived', 'merged'].includes(n.status),
    )
    .filter((n) => !state.zone || s.layout.positions[n.id]?.zone === state.zone)
    .filter(
      (n) =>
        state.view !== 'archive' ||
        !$('owner-filter').value ||
        n.owner === $('owner-filter').value,
    )
    .filter(
      (n) =>
        state.view !== 'archive' ||
        !$('status-filter').value ||
        n.status === $('status-filter').value,
    )
    .filter(
      (n) =>
        state.view !== 'archive' || !$('unread-filter').checked || n.unread,
    )
    .filter(
      (n) =>
        !q ||
        [
          n.title,
          n.client,
          n.manual,
          n.summary?.text,
          n.searchText,
          n.next?.action,
          n.next?.object,
        ]
          .join(' ')
          .toLowerCase()
          .includes(q),
    );
}
function render() {
  if (drag || document.activeElement?.matches('[data-quick-note]')) return;
  const s = state.snapshot;
  if (!s) return;
  $('inbox-count').textContent = s.counts.chats;
  $('today-count').textContent = s.today.length;
  const previous = $('owner-filter').value;
  $('owner-filter').innerHTML = options(
    [
      ['', 'Все ответственные'],
      ...[
        ...new Set([...s.settings.owners, ...s.notes.map((n) => n.owner)]),
      ].map((n) => [n, n]),
    ],
    previous,
  );
  document
    .querySelectorAll('[data-view]')
    .forEach((b) =>
      b.classList.toggle(
        'active',
        b.dataset.view === state.view && !state.zone,
      ),
    );
  $('zones-nav').innerHTML = s.layout.zones
    .map(
      (z) =>
        `<button data-zone="${z.id}" class="${state.zone === z.id ? 'active' : ''}">◦ <span>${esc(z.name)}</span></button>`,
    )
    .join('');
  $('search').placeholder =
    state.view === 'inbox'
      ? 'Поиск по всем чатам канала'
      : 'Поиск по обращениям';
  $('view-title').textContent = state.zone
    ? s.layout.zones.find((z) => z.id === state.zone)?.name || 'Зона'
    : viewNames[state.view];
  $('view-subtitle').textContent = {
    desk: 'Одно обращение — одна записка. Каждый следующий шаг на виду.',
    inbox:
      'Канал → чат → карточка. Сообщения уже собраны, саммари появится после создания карточки.',
    today:
      'Обещания, напоминания, ожидания и обращения, которым нужен следующий шаг.',
    team: 'Нагрузка и следующие действия по ответственным.',
    archive: 'История сохраняется. Обращение можно открыть снова.',
    channels: 'Реальные источники, границы доступа и состояние получения.',
    settings:
      'Время напоминаний и ответственные. Права наследуются от Мастерской.',
  }[state.view];
  $('filters').hidden = state.view !== 'archive';
  $('view-heading').hidden = state.view === 'desk';
  $('content').classList.toggle(
    'canvas',
    state.view === 'desk' && !state.list && innerWidth > 640,
  );
  $('desk-controls').hidden = state.view !== 'desk';
  $('trash-strip').hidden = state.view !== 'desk';
  $('trash-count').textContent = s.trash?.length ? ` (${s.trash.length})` : '';
  $('zoom-label').textContent = Math.round(s.layout.zoom * 100) + '%';
  $('toggle-list').textContent = state.list ? '▦ Стол' : '☷ Список';
  $('toggle-newest').setAttribute('aria-pressed', String(newestMode()));
  $('today-date').textContent = new Intl.DateTimeFormat('ru-RU', {
    timeZone: s.settings.timezone,
    day: 'numeric',
    month: 'long',
    weekday: 'short',
  }).format(new Date(s.now));
  $('today-list').innerHTML =
    s.today.slice(0, 8).map(todayCard).join('') ||
    '<p class="muted">На сегодня всё спокойно.<br>Новые обязательства появятся здесь.</p>';
  if (state.view === 'desk' || state.view === 'archive') renderBoard();
  else if (state.view === 'inbox') renderInbox();
  else if (state.view === 'today')
    $('content').innerHTML = s.today.length
      ? `<div class="panel">${s.today.map(todayCard).join('')}</div>`
      : empty(
          'Нет обязательств на сегодня',
          'Можно заняться новыми обращениями.',
        );
  else if (state.view === 'channels') renderChannels();
  else if (state.view === 'team') renderTeam();
  else renderSettings();
  const fresh = s.notifications.filter(
    (n) => n.first && !announcedNotices.has(n.id),
  );
  fresh.forEach((n) => announcedNotices.add(n.id));
  if (fresh.length)
    notice(
      `Напоминания: ${fresh.length}. Ближайшие действия собраны в «Сегодня».`,
    );
}
function empty(title, description, create = false) {
  return `<div class="empty"><div class="empty-art">▱</div><h3>${esc(title)}</h3><p>${esc(description)}</p>${create ? '<button class="primary" data-action="new">＋ Создать первую записку</button>' : ''}</div>`;
}
function todayCard(t) {
  if (t.kind === 'inbox')
    return `<button class="today-card" data-view="inbox"><span class="time">Нужно разобрать входящее</span><strong>${esc(t.title)}</strong><small>${esc(t.owner)}</small></button>`;
  const note = state.snapshot.notes.find((n) => n.id === t.noteId);
  const title = note?.displayTitle || note?.title || t.title || 'Обращение';
  return `<button class="today-card" data-open="${t.noteId}"><span class="time ${t.overdue ? 'overdue' : ''}">◷ ${'Проверить ожидание'}</span><strong>${esc(title)}</strong><span>${esc(note?.waitingFor || '')}</span><small><br>${esc(t.owner)}</small></button>`;
}
function newestMode() {
  return state.view === 'desk' && state.snapshot?.layout.mode === 'newest';
}
function boardMetrics() {
  const available = $('content').clientWidth;
  const width = Math.min(360, Math.max(240, (available - 70) / 2));
  return {
    width,
    step: width + 45,
    columns: Math.max(
      1,
      newestMode()
        ? Math.floor(
            (available - 40) / state.snapshot.layout.zoom / (width + 45),
          )
        : Math.min(2, Math.floor((available + 10) / (width + 45))),
    ),
  };
}
function summaryMarkup(value) {
  // Only a small text vocabulary, never raw model HTML or links.
  const lines = String(value || '')
    .replace(/\r/g, '')
    .split(/\n+|(?<=[.!?])\s+(?=[А-ЯЁA-Z])/u)
    .filter(Boolean);
  return lines
    .map((line) => {
      const heading = line.match(/^(?:#{1,3}\s+|\*\*)(.*?)(?:\*\*)?:?$/);
      if (heading) return `<h4>${esc(heading[1].replace(/\*\*/g, ''))}</h4>`;
      return `<p>${esc(line.replace(/^[-•*]\s+/, '• ')).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')}</p>`;
    })
    .join('');
}
function card(n, index, list) {
  const layout = state.snapshot.layout,
    p = layout.positions[n.id];
  const { columns, step, width } = boardMetrics();
  const x = (!newestMode() ? p?.x : undefined) ?? (index % columns) * step + 10,
    y =
      (!newestMode() ? p?.y : undefined) ??
      Math.floor(index / columns) * 480 + 10;
  const angle = [-2, 2, -1.3, 1.4][index % 4];
  const draft = sessionStorage.getItem('sales.quick.' + n.id);
  return `<article class="note ${esc(n.color)} ${p?.pinned ? 'pinned' : ''}" data-note="${n.id}" style="width:${width}px;left:${x}px;top:${y}px;--angle:${angle}deg">
    ${!list ? ['top', 'right', 'bottom', 'left'].map((edge) => `<div class="card-edge edge-${edge}" title="Переместить карточку"></div>`).join('') : ''}
    <div class="note-top"><button class="drag-handle" aria-label="Переместить записку" title="Перетащите за верхнюю треть или любой край">⠿</button><div class="chips"><span class="tag ">${esc(statusNames[n.status])}</span>${n.unread ? '<span class="tag unread">Новое</span>' : ''}${n.channels.map((c) => `<span class="tag">${esc(channelNames[c] || c)}</span>`).join('')}${n.summaryPartial ? '<span class="tag warning" title="Доступна часть переписки">Частично</span>' : ''}${n.analysis && ['pending', 'running'].includes(n.analysis.state) ? '<span class="tag">Обновляется</span>' : n.summaryStale ? '<span class="tag warning">Есть изменения</span>' : ''}${n.fileCount ? `<span class="tag">⌕ ${n.fileCount}</span>` : ''}</div><button class="pin" data-pin="${n.id}" aria-label="${p?.pinned ? 'Открепить' : 'Закрепить'} записку">${p?.pinned ? '●' : '○'}</button></div>
    ${n.client ? `<p class="client">${esc(n.client)}</p>` : ''}<h3>${esc(n.displayTitle || n.title)}</h3>
    <div class="summary compact-summary">${summaryMarkup(n.summary?.text || 'Саммари появится после анализа переписки.')}</div>
    <label class="quick-note-label"><textarea data-quick-note="${n.id}" data-before="${esc(n.manual)}" placeholder="Нажмите и запишите…" aria-label="Заметки к ${esc(n.displayTitle || n.title)}" ${['archived', 'merged'].includes(n.status) ? 'readonly' : ''}>${esc(draft ?? n.manual)}</textarea></label>
    <div class="note-footer"><span class="quick-status" data-quick-status="${n.id}">${draft !== null ? 'Черновик' : ''}</span>${list || layout.zones.length ? `<select aria-label="Зона записки" data-note-zone="${n.id}">${options([['', 'Без зоны'], ...layout.zones.map((z) => [z.id, z.name])], p?.zone || '')}</select>` : ''}<button data-open="${n.id}">Открыть →</button></div></article>`;
}
function renderBoard() {
  const notes = filteredNotes();
  if (newestMode())
    notes.sort(
      (a, b) =>
        (b.createdAt || '').localeCompare(a.createdAt || '') ||
        b.id.localeCompare(a.id),
    );
  $('result-count').textContent = notes.length + ' обращ.';
  if (!notes.length) {
    $('content').innerHTML = empty(
      state.view === 'archive'
        ? 'Архив пока пуст'
        : 'Здесь начинается следующий шаг',
      state.view === 'archive'
        ? 'Завершённые обращения сохранят переписку, заметки и файлы.'
        : 'Создайте записку или разберите входящее. Её можно свободно разместить на столе.',
      state.view === 'desk',
    );
    return;
  }
  const list =
    state.list || state.view === 'archive' || window.innerWidth <= 640;
  const { columns, step, width } = boardMetrics();
  const maxY = Math.max(
    ...notes.map(
      (n, i) =>
        (state.snapshot.layout.positions[n.id]?.y ??
          Math.floor(i / columns) * 480) + 470,
    ),
  );
  const maxX = Math.max(
    ...notes.map(
      (n, i) =>
        (state.snapshot.layout.positions[n.id]?.x ?? (i % columns) * step) +
        width +
        20,
    ),
  );
  $('content').style.overflow = list ? 'visible' : 'hidden';
  $('content').innerHTML =
    `<div class="${list ? 'list' : 'board'}" data-columns="${columns}" data-step="${step}" style="${list ? '' : `--note-text-scale:${cardTextScale()};--summary-text-scale:${summaryTextScale()};min-height:${maxY}px;width:${maxX}px;transform:translate(${state.pan.x}px,${state.pan.y}px) scale(${state.snapshot.layout.zoom})`}">${notes.map((n, i) => card(n, i, list)).join('')}</div>`;
  if (!list) flowNewestRows($('content').firstElementChild);
}
function cardTextScale() {
  // Compensate gently for zooming out; zooming in keeps native proportions.
  return Math.max(
    1,
    Math.min(1.35, 1 + (1 - state.snapshot.layout.zoom) * 0.7),
  );
}
function summaryTextScale() {
  // Keep the summary readable at 50% without expanding card headers and fields.
  return Math.max(1, Math.min(2, 1 / state.snapshot.layout.zoom));
}
function flowNewestRows(board) {
  if (!newestMode()) return;
  const columns = Number(board.dataset.columns),
    step = Number(board.dataset.step);
  const cards = [...board.querySelectorAll('.note')];
  let y = 10;
  for (let i = 0; i < cards.length; i += columns) {
    const row = cards.slice(i, i + columns);
    row.forEach((node) => {
      node.style.top = y + 'px';
    });
    y += Math.max(...row.map((node) => node.offsetHeight)) + 35;
  }
  board.style.width = Math.min(columns, cards.length) * step + 20 + 'px';
  board.style.minHeight = y + 'px';
}
function renderInbox() {
  const s = state.snapshot,
    entries = s.chats,
    p = s.chatPage;
  const loading = state.inboxLoading || state.inboxSearching;
  const disabled = loading ? 'disabled' : '';
  const navigation = `<div class="row wrap inbox-pages"><button data-inbox-start ${!state.inboxCursor || loading ? 'disabled' : ''}>В начало</button><button data-inbox-prev ${!state.inboxPrevious.length || loading ? 'disabled' : ''}>← Новее</button><span class="muted">Чатов на странице: ${entries.length} · всего: ${p.total}</span><button data-inbox-next="${esc(p.nextCursor)}" ${!p.nextCursor ? 'disabled' : disabled}>Ранее →</button></div>`;
  const channels = s.channels.filter(
    (c) => c.connected || s.chatChannels.some((g) => g.source === c.id),
  );
  const pills = channels
    .map((c) => {
      const count = s.chatChannels.find((g) => g.source === c.id)?.chats || 0;
      return `<button data-inbox-channel="${c.id}" aria-pressed="${state.inboxChannel === c.id}" class="channel-tab ${state.inboxChannel === c.id ? 'selected' : ''}"><span>${esc(c.name)}</span><b>${count}</b><small>чатов</small></button>`;
    })
    .join('');
  const chat = (c) => {
    const active = c.notes.filter(
      (n) => !n.trashedAt && !['archived', 'merged'].includes(n.status),
    );
    const busy = state.chatBusy === c.id;
    return `<article class="inbox-item chat-item" data-chat="${c.id}"><div class="row wrap"><strong>${esc(c.title)}</strong><span class="tag">${c.messages} сообщ.</span></div><p class="muted">Чат ${esc(c.conversationId.slice(-16))} · ${fmt(c.occurredAt)}${c.pending ? ' · без карточки: ' + c.pending : ''}</p><div class="inbox-actions">${c.pending ? `<button class="primary" data-chat-create="${c.id}" ${disabled || (busy ? 'disabled' : '')}>${busy ? 'Создаём…' : active.length > 1 ? 'Выбрать карточку' : active.length ? 'Добавить в карточку' : 'Создать карточку + саммари'}</button>` : ''}${c.notes.map((n) => `<button data-open="${n.id}">${n.trashedAt ? 'В корзине: ' : ['archived', 'merged'].includes(n.status) ? 'Архив: ' : 'Открыть: '}${esc(n.title)}</button>`).join('')}<button data-chat-open="${c.id}">Открыть чат</button>${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">Чат в источнике ↗</a>` : ''}</div></article>`;
  };
  $('content').innerHTML =
    `<div class="chat-channels" aria-label="Каналы"><button data-inbox-channel="" aria-pressed="${!state.inboxChannel}" class="channel-tab ${!state.inboxChannel ? 'selected' : ''}"><span>Все каналы</span><b>${s.chatChannels.reduce((n, c) => n + c.chats, 0)}</b><small>чатов</small></button>${pills}</div><div class="row wrap chat-toolbar"><div class="row wrap"><button data-inbox-scope="pending" aria-pressed="${state.inboxScope === 'pending'}">Без карточки</button><button data-inbox-scope="all" aria-pressed="${state.inboxScope === 'all'}">Все чаты</button></div><button data-action="sync">↻ Обновить</button></div><p class="muted">Во входящих ${s.counts.chats} чатов · ${s.counts.inbox} сообщений без карточки. При создании карточки помощник прочитает доступную переписку.</p>${p.query ? `<p class="muted">Поиск по всем чатам выбранного канала: ${p.total} совпадений.</p>` : ''}${navigation}${entries.length ? `<div class="panel chat-list">${entries.map(chat).join('')}</div>` : empty(p.query ? 'По запросу ничего не найдено' : state.inboxScope === 'all' ? 'В этом канале пока нет чатов' : 'Все чаты связаны с карточками', 'Выберите другой канал или откройте «Все чаты», чтобы перейти к созданным карточкам.')}${entries.length ? navigation : ''}`;
}
async function createChatCard(id, noteId) {
  if (state.chatBusy || state.pending) return;
  const chat = state.snapshot.chats.find((c) => c.id === id);
  if (!chat) return;
  const candidates = chat.notes.filter(
    (n) => !n.trashedAt && !['archived', 'merged'].includes(n.status),
  );
  if (!noteId && candidates.length > 1)
    return editor(
      'Выберите обращение',
      `<p>В этом чате несколько проектов. Выберите, куда добавить новые сообщения.</p>${select(
        'noteId',
        'Карточка',
        candidates.map((n) => [n.id, n.title]),
        candidates[0].id,
      )}`,
      (f) => createChatCard(id, f.get('noteId')),
      'Добавить и составить саммари',
    );
  state.chatBusy = id;
  render();
  try {
    const result = await mutate('chat.create', {
      chatId: id,
      title: chat.title,
      ...(noteId ? { noteId } : {}),
    });
    await openNote(result.noteId, 'overview');
    await refresh({ quiet: true });
    notice(
      result.jobId
        ? state.detail?.jobs[0]?.state === 'error'
          ? 'Карточка сохранена. Саммари пока недоступно — повторите в карточке.'
          : 'Карточка сохранена. Саммари составляется и появится здесь автоматически.'
        : 'Открыта существующая карточка чата.',
    );
  } finally {
    state.chatBusy = '';
    render();
  }
}
async function inboxNavigate(kind, cursor = '') {
  if (state.inboxLoading || state.inboxSearching) return;
  const previous = [...state.inboxPrevious];
  let destination = '';
  if (kind === 'next') {
    previous.push(state.inboxCursor);
    destination = cursor;
  } else if (kind === 'prev') destination = previous.pop() || '';
  else previous.length = 0;
  state.inboxLoading = true;
  render();
  try {
    await refresh({
      quiet: true,
      inboxCursor: destination,
      inboxPrevious: previous,
    });
  } finally {
    state.inboxLoading = false;
    render();
  }
  if (state.view === 'inbox') $('content').scrollIntoView({ block: 'start' });
}
function renderChannels() {
  const s = state.snapshot;
  $('content').innerHTML =
    `<p class="policy-box">${s.channels[0].intake ? 'Сохраняются ID, ссылки и краткие итоги. Полный архив переписки не создаётся.' : 'Приём событий ещё не включён: ожидается выбор глубины истории.'} В Авито можно отвечать прямо из чата.</p><p>${!s.channels[0].intake ? '<button class="primary" data-action="configure-intake">Выбрать глубину и включить приём</button> ' : ''}<button data-action="history">Выбрать сообщение из истории Авито</button></p><div class="channel-grid">${s.channels.map((c) => `<article class="panel"><div class="row"><h3>${esc(c.name)}</h3><span class="tag ${c.connected ? 'badge-ok' : 'badge-off'}">${c.connected ? 'Подключение есть' : 'Не подключено'}</span></div><p>${esc(c.scope)}</p><p><b>Получение:</b> ${esc(c.sync)}</p><p><b>История:</b> ${esc(c.history)}</p><p>Последний успех: ${c.lastSuccessAt ? fmt(c.lastSuccessAt) : 'ещё не подтверждён'}</p>${c.error || c.intakeError ? `<p class="error">Нужно внимание: ${esc(c.intakeError || c.error)}</p>` : ''}${c.gapAt ? `<p class="error">Был сбой приёма ${fmt(c.gapAt)}. За этот период возможен пробел; проверьте источник.</p>` : ''}${c.pending ? `<p class="error">Ожидают сохранения: ${c.pending}. Повтор выполняется из надёжной очереди.</p>` : ''}<span class="tag">${c.partial ? 'Полнота ограничена' : 'Полный срез'}</span></article>`).join('')}</div><p class="muted">Ошибки одного источника не блокируют записки.</p>`;
}
function renderTeam() {
  const s = state.snapshot;
  const owners = [
    ...new Set([...s.settings.owners, ...s.notes.map((n) => n.owner)]),
  ];
  $('content').innerHTML =
    `<p class="muted">Доступ сейчас соответствует общему входу руководителя Мастерской. Имена ответственных не создают новые учётные записи.</p><div class="channel-grid">${owners
      .map((owner) => {
        const notes = s.notes.filter(
          (n) =>
            n.owner === owner &&
            !n.trashedAt &&
            !['archived', 'merged'].includes(n.status),
        );
        const todo = s.today.filter((t) => t.owner === owner);
        return `<div class="panel"><h3>${esc(owner)}</h3><div class="row"><span>Активные обращения</span><b class="count-box">${notes.length}</b></div><p>Сегодня требуют внимания: ${todo.length}</p>${notes
          .slice(0, 5)
          .map(
            (n) =>
              `<button class="today-card" data-open="${n.id}">${esc(n.title)}</button>`,
          )
          .join('')}</div>`;
      })
      .join('')}</div>`;
}
function renderSettings() {
  const s = state.snapshot.settings;
  $('content').innerHTML =
    `<div class="panel"><h3>Рабочее время и команда</h3><p>Часовой пояс: ${esc(s.timezone)}<br>Карточки с контрольной датой ожидания появляются в «Сегодня».</p><button data-action="settings">Изменить</button></div><div class="panel"><h3>Данные и восстановление</h3><p>Записки, переписка и выбранные файлы сохраняются на VPS и входят в резервную копию Мастерской. Заказы и финансы остаются в Google.</p><p>Перетаскивание и закрепление меняют только раскладку этого браузера. При потере записки используйте «Собрать записки» или список.</p></div>`;
}

async function openNote(id, tab = state.tab) {
  const request = ++state.detailRequest;
  try {
    const detail = await api('/note?id=' + encodeURIComponent(id));
    if (request !== state.detailRequest) return;
    state.detail = detail;
    state.tab = tab;
    renderDetail();
    if (!$('detail').open) $('detail').showModal();
  } catch (e) {
    notice(e.message, true);
  }
}
function mediaMarkup(items = []) {
  return `<div class="media-grid">${items
    .map(
      (m) => `<article class="media-item" data-media-id="${esc(m.id)}">
    ${m.available && m.kind === 'image' ? `<a class="media-preview" href="${esc(m.url)}" target="_blank" rel="noopener noreferrer" aria-label="Открыть ${esc(m.name)}"><img src="${esc(m.preview || m.url)}" alt="${esc(m.name)}" loading="lazy"><span class="media-fallback" hidden>Предпросмотр недоступен</span></a>` : ''}
    ${m.available && ['audio', 'video'].includes(m.kind) ? `<${m.kind} controls preload="none" src="${esc(m.url)}"></${m.kind}>` : ''}
    <strong class="media-name">${esc(m.name)}</strong><span class="muted small">${esc(channelNames[m.source] || m.source)} · ${fmt(m.at)}${m.size ? ' · ' + (m.size / 1024 / 1024 >= 1 ? (m.size / 1024 / 1024).toFixed(1) + ' МБ' : Math.ceil(m.size / 1024) + ' КБ') : ''}</span>
    ${m.available ? `<a class="small" href="${esc(m.url)}&download=1">Скачать</a>` : `<span class="small">${esc(m.reason)}</span>`}${m.origin ? `<a class="small" href="${esc(m.origin)}" target="_blank" rel="noopener noreferrer">В сообщении ↗</a>` : ''}</article>`,
    )
    .join('')}</div>`;
}
function renderNoteMedia() {
  const box = $('note-media'),
    view = state.mediaView;
  if (!box || !view || view.noteId !== state.detail?.id) return;
  box.innerHTML = `<div class="row wrap"><h3 class="section-heading">Медиа из переписки${view.items.length ? ' · ' + view.items.length : ''}</h3><button data-media-refresh ${view.loading ? 'disabled' : ''}>Обновить</button></div>
    ${mediaMarkup(view.items)}${view.error ? `<p class="error" role="status">${esc(view.error)}</p>` : ''}
    ${view.unavailable.length ? `<p class="muted">Не удалось прочитать вложения из ${view.unavailable.length} сообщений. Можно обновить список или открыть чат.</p>` : ''}
    ${view.loading ? '<p class="muted" role="status">Загружаю вложения…</p>' : !view.items.length && !view.error && !view.unavailable.length ? '<p class="muted">В связанных сообщениях пока нет вложений.</p>' : ''}
    ${view.nextOffset !== null ? `<button data-media-more ${view.loading ? 'disabled' : ''}>Показать ещё</button>` : ''}`;
}
async function loadNoteMedia(view, offset = 0) {
  if (view.loading) return;
  view.loading = true;
  view.error = '';
  renderNoteMedia();
  try {
    const value = await api(
      '/note-media?noteId=' +
        encodeURIComponent(view.noteId) +
        '&offset=' +
        offset,
    );
    if (state.mediaView !== view || state.detail?.id !== view.noteId) return;
    const items = offset ? view.items : [];
    view.items = [
      ...new Map([...items, ...value.items].map((m) => [m.id, m])).values(),
    ];
    view.unavailable = offset
      ? [...view.unavailable, ...value.unavailable]
      : value.unavailable;
    view.nextOffset = value.nextOffset;
  } catch (error) {
    if (state.mediaView === view) view.error = error.message;
  } finally {
    view.loading = false;
    if (state.mediaView === view) renderNoteMedia();
  }
}
function ensureNoteMedia() {
  if (!$('note-media')) return;
  if (
    state.mediaView?.noteId !== state.detail.id ||
    state.mediaView?.watermark !== state.detail.watermark
  ) {
    state.mediaView = {
      noteId: state.detail.id,
      watermark: state.detail.watermark,
      items: [],
      unavailable: [],
      nextOffset: null,
      loading: false,
    };
    void loadNoteMedia(state.mediaView);
  } else renderNoteMedia();
}
document.addEventListener(
  'error',
  (e) => {
    if (e.target.matches?.('.media-preview img')) {
      e.target.hidden = true;
      e.target
        .closest('.media-preview')
        .querySelector('.media-fallback').hidden = false;
    }
  },
  true,
);
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-media-refresh]') && state.mediaView)
    void loadNoteMedia(state.mediaView);
  if (
    e.target.closest('[data-media-more]') &&
    state.mediaView?.nextOffset !== null
  )
    void loadNoteMedia(state.mediaView, state.mediaView.nextOffset);
});
function renderDetail() {
  const n = state.detail;
  const closed =
    Boolean(n.trashedAt) || ['archived', 'merged'].includes(n.status);
  const stale = n.summary && n.summary.watermark !== n.watermark;
  const latestJob = n.analysis;
  let content = '';
  if (state.tab === 'overview')
    content = `<div class="row wrap"><h3 class="section-heading">Саммари</h3>${!closed ? '<button data-detail-action="analyze">✦ Обновить с помощником</button>' : ''}</div>${latestJob && ['running', 'pending', 'error', 'stale'].includes(latestJob.state) ? `<p class="policy-box">${latestJob.state === 'error' ? 'Анализ недоступен или прерван. Данные сохранены. Можно повторить.' : latestJob.state === 'stale' ? 'После начала анализа поступили изменения. Старый результат не применён.' : latestJob.automatic && latestJob.state === 'pending' ? (latestJob.retrying ? 'Саммари обновится автоматически после повторной попытки. Предыдущий итог сохранён.' : 'Новые сообщения получены. Саммари скоро обновится автоматически.') : 'Помощник читает доступные источники. Можно продолжать работу.'}</p>` : ''}<p class="muted">Саммари обновляется автоматически при новых сообщениях чата.</p><div class="summary-box"><div class="formatted-summary">${summaryMarkup(n.summary?.text || 'Итог ещё не составлен. Помощник использует доступные сообщения чата; при ошибке нажмите «Обновить с помощником».')}</div>${n.summary?.partial ? `<p class="policy-box">Разобрана часть источников: ${n.summary.coverage.processed.length} из ${n.events.length}. Пропущено: ${n.summary.coverage.omitted.length}; сокращено: ${n.summary.coverage.truncated.length}. ${n.summary.coverage.sourcePartial ? 'Источник предоставляет ограниченную историю. ' : ''}Остальные события требуют отдельного просмотра. ${n.summary.coverage.manualTruncated ? 'Ручная заметка сокращена для анализа.' : ''}</p>` : ''}${n.summary ? `<div class="changes"><b>Что изменилось</b><div>${summaryMarkup(n.summary.changes || 'Изменения не выделены.')}</div><p class="small">Обработано ${fmt(n.summary.at)}${stale ? ' · Есть новые события, итог устарел' : ''}</p><div class="chips">${n.summary.sources.map((id) => `<button class="small" data-source="${id}">Источник ↗</button>`).join('')}</div></div>` : ''}</div><h3 class="section-heading">Заметки менеджера</h3><div class="manual">${esc(n.manual || 'Пока нет заметок.')}</div>${n.status === 'waiting' ? `<h3 class="section-heading">Ожидание</h3><p>${esc(n.waitingFor)}<br><span class="muted">Контроль: ${fmt(n.reviewAt)} · ${esc(n.owner)}</span></p>` : ''}`;
  if (state.tab === 'events')
    content = `<p class="muted">Тексты читаются из источника по запросу. Здесь хранятся ссылки, ID и версии событий.</p>${n.events.map((e) => `<div class="panel"><div class="row"><strong>${esc(e.title)}</strong><span class="tag">${esc(channelNames[e.source] || e.source)}</span></div><p>${fmt(e.occurredAt)} · ${e.direction === 'in' ? 'Входящее' : e.direction === 'out' ? 'Исходящее' : 'Автор неизвестен'}${e.deleted ? ' · Удалено в источнике' : ''}${e.revision > 1 ? ' · Источник изменён' : ''}</p><div class="inbox-actions"><button data-source="${e.id}">Читать</button><button data-event-link="${e.id}">Связать ещё с обращением</button>${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">Открыть канал ↗</a>` : ''}</div></div>`).join('') || '<p class="muted">Добавьте связанное событие из входящих.</p>'}`;
  if (state.tab === 'files')
    content = `<div class="row"><h3 class="section-heading">Добавленные вручную</h3>${!closed ? '<button data-detail-action="upload">＋ Прикрепить файл</button>' : ''}</div><p class="muted">Согласованный вариант выбирается явно, новая загрузка его не заменяет.</p>${n.files.map((f) => `<div class="file-card"><div class="row wrap"><a class="file-name" href="/api/sales/file?id=${f.id}" target="_blank" rel="noopener noreferrer">${esc(f.name)}</a><span class="tag">${n.approvedFile === f.id ? '✓ Согласован' : 'Версия файла'}</span></div><p class="muted">${(f.size / 1024).toFixed(0)} КБ · ${fmt(f.at)}</p>${!closed && n.approvedFile !== f.id ? `<button data-file-approve="${f.id}">Отметить согласованным</button>` : ''}</div>`).join('') || '<p class="muted">Вы пока не добавляли файлы вручную.</p>'}`;
  if (['overview', 'files'].includes(state.tab))
    content +=
      '<section id="note-media" class="note-media" aria-label="Медиа из переписки"></section>';
  $('detail-body').innerHTML =
    `<span class="tag">${n.trashedAt ? 'В корзине' : esc(statusNames[n.status])}</span><h2 class="detail-title">${esc(n.displayTitle || n.title)}</h2><p class="muted">${esc(n.client || n.channelClient || 'Клиент ещё не указан')} · Ответственный: ${esc(n.owner)}</p>${n.orderId ? `<a href="/kanban/?order=${encodeURIComponent(n.orderId)}" target="_blank" rel="noopener noreferrer">Заказ №${esc(n.orderId)} в Мастерской ↗</a>` : ''}${n.status === 'merged' ? `<p class="policy-box">Обращение объединено. <button data-open="${n.mergedInto}">Открыть основное</button></p>` : ''}<div class="detail-actions">${!closed ? '<button data-detail-action="edit">Изменить</button><button data-detail-action="merge">Объединить с карточкой</button><button data-detail-action="split">Выделить в новую</button><button data-detail-action="order">Заполнить заказ</button><button data-detail-action="archive">В архив</button><button data-detail-action="trash">В корзину</button>' : n.trashedAt ? '<button data-detail-action="restore">Восстановить из корзины</button>' : n.status === 'archived' ? '<button data-detail-action="reopen">Вернуть в работу</button>' : ''}<button data-detail-action="read">Прочитано</button></div><div class="chips">${(n.chats || []).map((c, i) => `<button data-chat-open="${c.id}">Чат · ${esc(channelNames[c.source] || c.source)}${n.chats.length > 1 ? ' ' + (i + 1) : ''}</button>`).join('')}</div><div class="detail-tabs">${[
      ['overview', 'Обзор'],
      ['events', 'Источники'],
      ['files', 'Файлы'],
    ]
      .map(
        ([id, label]) =>
          `<button class="${state.tab === id ? 'active' : ''}" data-tab="${id}">${label}</button>`,
      )
      .join('')}</div>${content}`;
  if (n.orderId && n.orderTransfer) {
    const status = document.createElement('p');
    status.className = 'policy-box';
    status.textContent = n.orderTransfer.done
      ? 'Файлы перенесены в заказ.'
      : 'Перенос файлов в заказ не завершён.';
    if (n.orderTransfer.unavailable)
      status.append(
        ' Недоступных у источника: ' + n.orderTransfer.unavailable + '.',
      );
    if (!n.orderTransfer.done) {
      const button = document.createElement('button');
      button.dataset.detailAction = 'transfer';
      button.disabled = state.transferring === n.id || closed;
      button.textContent =
        state.transferring === n.id
          ? 'Переносим файлы…'
          : 'Продолжить перенос файлов';
      status.append(' ', button);
    }
    $('detail-body').querySelector('.detail-actions').before(status);
  }
  if (state.orderAfterAnalysis?.noteId === n.id) {
    const button = $('detail-body').querySelector('[data-detail-action=order]');
    if (button) {
      button.disabled = true;
      button.textContent = 'Проверяем контекст…';
    }
  }
  if (n.orderId)
    $('detail-body').querySelector('[data-detail-action=order]')?.remove();
  ensureNoteMedia();
}
function editor(title, html, submit, labelText = 'Сохранить') {
  $('editor-title').textContent = title;
  $('editor-error').textContent = '';
  $('editor-form').innerHTML =
    `${html}<div class="form-actions"><button type="button" data-cancel-editor>Отмена</button><button type="submit" class="primary">${labelText}</button></div>`;
  $('editor-form').onsubmit = async (e) => {
    e.preventDefault();
    if (state.busy) return;
    state.busy = true;
    const button = e.submitter;
    button.disabled = true;
    try {
      const result = await submit(new FormData(e.target));
      if (result === false) return;
      $('editor').close();
      await refresh({ quiet: true });
      if (state.detail && $('detail').open) await openNote(state.detail.id);
    } catch (error) {
      $('editor-error').textContent =
        error.message +
        (error.current
          ? '\nТекущая серверная версия: ' + JSON.stringify(error.current)
          : '');
    } finally {
      state.busy = false;
      button.disabled = false;
    }
  };
  $('editor').showModal();
}
function noteForm(n = {}) {
  return `<div class="form-grid">${label('title', 'Название обращения', n.displayTitle || n.title || '', 'text', 'class="wide"')}${label('client', 'Клиент / организация', n.client || '')}${label('owner', 'Ответственный', n.owner || 'Руководитель')}${select(
    'status',
    'Состояние',
    Object.entries(statusNames).filter(
      ([k]) => !['archived', 'merged'].includes(k),
    ),
    n.status || 'active',
  )}${select(
    'priority',
    'Приоритет',
    [
      ['normal', 'Обычный'],
      ['high', 'Важное'],
    ],
    n.priority || 'normal',
  )}${select(
    'color',
    'Цвет записки',
    [
      ['yellow', 'Медовый'],
      ['green', 'Шалфей'],
      ['blue', 'Голубой'],
      ['lilac', 'Сиреневый'],
      ['rose', 'Персиковый'],
    ],
    n.color || 'yellow',
  )}${label('orderId', 'Номер существующего заказа', n.orderId || '')}${label('waitingFor', 'Кого / чего ждём', n.waitingFor || '', 'text', 'class="wide"')}${label('reviewAt', 'Контроль ожидания', local(n.reviewAt), 'datetime-local', 'class="wide"')}${textarea('manual', 'Заметки менеджера', n.manual || '')}</div><p class="muted">Время вводится в часовом поясе устройства. В столе отображается ${esc(state.snapshot.settings.timezone)}.</p>`;
}
function noteData(f) {
  return {
    title: f.get('title'),
    client: f.get('client'),
    owner: f.get('owner'),
    status: f.get('status'),
    priority: f.get('priority'),
    color: f.get('color'),
    orderId: f.get('orderId'),
    waitingFor: f.get('waitingFor'),
    reviewAt: iso(f.get('reviewAt')),
    manual: f.get('manual'),
  };
}
function newNote(event) {
  editor(
    event ? 'Обращение из входящего' : 'Новая записка',
    noteForm(),
    async (f) => {
      const data = noteData(f);
      const result = event
        ? await mutate('event.link', {
            eventId: event.id,
            eventRevision: event.revision,
            newNote: data,
          })
        : await mutate('note.create', data);
      await openNote(result.noteId || result.id, 'overview');
    },
  );
}
function editNote() {
  const n = state.detail;
  editor('Изменить обращение', noteForm(n), (f) =>
    mutate('note.update', {
      id: n.id,
      revision: n.revision,
      patch: noteData(f),
    }),
  );
}
function linkEvent(id) {
  const event =
    state.snapshot.inbox.find((e) => e.id === id) ||
    state.detail?.events.find((e) => e.id === id);
  if (!event) return;
  const candidates = state.snapshot.notes.filter(
    (n) => !n.trashedAt && !['archived', 'merged'].includes(n.status),
  );
  if (!candidates.length) return newNote(event);
  editor(
    'Связать событие с обращением',
    `<p class="muted">Проверьте смысл запроса. Одно событие можно связать с несколькими обращениями.</p>${select(
      'noteId',
      'Обращение',
      candidates.map((n) => [n.id, n.title]),
      candidates[0].id,
    )}`,
    async (f) => {
      const id = f.get('noteId'),
        n = await api('/note?id=' + id);
      const result = await mutate('event.link', {
        eventId: event.id,
        eventRevision: event.revision,
        noteId: id,
        revision: n.revision,
      });
      await openNote(result.noteId, 'events');
    },
    'Связать',
  );
}
function mergeNotes() {
  const source = state.detail;
  const candidates = state.snapshot.notes.filter(
    (n) =>
      n.id !== source.id &&
      !n.trashedAt &&
      !['archived', 'merged'].includes(n.status),
  );
  if (!candidates.length)
    return notice('Для объединения нужны две активные карточки.', true);
  editor(
    'Объединить две карточки',
    `<p>Все сообщения, файлы и заметки из «${esc(source.displayTitle || source.title)}» перейдут в выбранную основную карточку. Исходная карточка будет скрыта со стола.</p>${select(
      'targetId',
      'В какую карточку перенести',
      candidates.map((n) => [n.id, n.displayTitle || n.title]),
      candidates[0].id,
    )}`,
    async (f) => {
      mergeForm(source, await api('/note?id=' + f.get('targetId')));
      return false;
    },
    'Посмотреть результат',
  );
}
function mergeForm(source, target) {
  const approved = [...source.files, ...target.files].filter((f) =>
    [source.approvedFile, target.approvedFile].includes(f.id),
  );
  const combined = {
    ...target,
    title: target.displayTitle || target.title,
    manual: [target.manual, source.manual].filter(Boolean).join('\n\n'),
  };
  editor(
    'Результат объединения',
    `<div class="merge-preview"><div><b>Присоединяем</b><p>${esc(source.displayTitle || source.title)}</p><p>${source.events.length} сообщений · ${source.files.length} ручных файлов</p><p>${esc(source.client || source.channelClient || 'Клиент не указан')}</p></div><div><b>Основная карточка</b><p>${esc(target.displayTitle || target.title)}</p><p>${target.events.length} сообщений · ${target.files.length} ручных файлов</p><p>${esc(target.client || target.channelClient || 'Клиент не указан')}</p></div></div><p class="policy-box">Медиа перейдут вместе с сообщениями. Ручные заметки соединены ниже. Проверьте клиента и номер заказа; саммари обновится по объединённой переписке.</p>${noteForm(combined)}${
      approved.length
        ? select(
            'approvedFile',
            'Согласованный файл',
            approved.map((f) => [f.id, f.name]),
            target.approvedFile || source.approvedFile,
          )
        : ''
    }`,
    async (f) => {
      const result = await mutate('notes.merge', {
        sourceId: source.id,
        sourceRevision: source.revision,
        targetId: target.id,
        targetRevision: target.revision,
        resolution: noteData(f),
        approvedFile: f.get('approvedFile') || null,
      });
      await openNote(result.noteId);
      notice('Карточки объединены. Саммари обновляется.');
    },
    'Объединить карточки',
  );
}
function splitNote() {
  const n = state.detail,
    groups = new Map();
  for (const e of n.events) {
    const key = JSON.stringify([
      e.source,
      e.account,
      e.conversationId || e.nativeId,
    ]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const chats = [...groups.values()];
  if (!n.events.length && !n.files.length)
    return notice(
      'В карточке пока нет сообщений или файлов для переноса.',
      true,
    );
  const token = crypto.randomUUID();
  state.splitToken = token;
  editor(
    'Выделить отдельный запрос',
    `<p>Выберите переписку или файлы для новой карточки. Невыбранное останется в «${esc(n.displayTitle || n.title)}». Медиа переместятся вместе со своими сообщениями.</p><h3>1. Что перенести</h3>${chats.map((events, i) => `<label class="selection-group"><input type="checkbox" name="chatGroup" value="${i}">${esc(channelNames[events[0].source] || events[0].source)} · диалог ${i + 1} · ${events.length} сообщений</label>`).join('')}<details open><summary>Выбрать отдельные сообщения</summary><div id="split-messages"><p>Загружаем сообщения…</p></div><button type="button" id="split-more" hidden>Показать более ранние</button></details>${n.files.map((f) => `<label class="selection-group"><input type="checkbox" name="fileIds" value="${f.id}">Файл: ${esc(f.name)}</label>`).join('')}<h3>2. Новая карточка</h3>${label('title', 'Кратко: что нужно клиенту', '', 'text', 'required')}${textarea('manual', 'Заметки для новой карточки', '')}<p class="muted">Исходные ручные заметки и заказ остаются в текущей карточке. Новые сообщения общего чата можно будет направить в нужную карточку во входящих.</p>`,
    async (f) => {
      const eventIds = new Set(f.getAll('eventIds'));
      for (const i of f.getAll('chatGroup'))
        for (const e of chats[Number(i)] || []) eventIds.add(e.id);
      const result = await mutate('notes.split', {
        id: n.id,
        revision: n.revision,
        newNote: {
          title: f.get('title'),
          manual: f.get('manual'),
          client: n.client,
          owner: n.owner,
          color: n.color,
        },
        eventIds: [...eventIds],
        fileIds: f.getAll('fileIds'),
      });
      await openNote(result.noteId);
      notice('Выбранное перенесено в новую карточку.');
    },
    'Создать карточку и перенести',
  );
  const load = async (offset = 0) => {
    const host = $('split-messages'),
      more = $('split-more');
    more.disabled = true;
    try {
      const page = await api(
        '/split-preview?noteId=' +
          encodeURIComponent(n.id) +
          '&offset=' +
          offset,
      );
      if (
        state.splitToken !== token ||
        !$('editor').open ||
        $('split-messages') !== host
      )
        return;
      if (!offset) host.replaceChildren();
      host.insertAdjacentHTML(
        'beforeend',
        page.items
          .map(
            (e) =>
              `<label class="split-message"><input type="checkbox" name="eventIds" value="${e.id}"><span><small>${esc(channelNames[e.source] || e.source)} · диалог ${chats.findIndex((group) => group.some((item) => item.id === e.id)) + 1} · ${fmt(e.occurredAt)} · ${e.direction === 'in' ? 'Клиент' : 'Ответ'}</small><span class="source-text">${esc(e.text || (e.type === 'text' ? 'Текст недоступен' : 'Вложение: ' + e.type))}</span></span></label>`,
          )
          .join(''),
      );
      more.hidden = page.nextOffset === null;
      more.onclick = () => void load(page.nextOffset);
    } catch {
      if (host.isConnected) {
        if (!offset)
          host.textContent =
            'Не удалось прочитать сообщения. Можно выбрать целый чат или повторить.';
        more.hidden = false;
        more.textContent = 'Повторить чтение';
        more.onclick = () => void load(offset);
      }
    } finally {
      more.disabled = false;
    }
  };
  void load();
}
async function history(chatId = '', offset = 0) {
  state.chat = null;
  const request = (state.sourceRequest = (state.sourceRequest || 0) + 1);
  $('source-title').textContent = 'История Авито';
  $('source-body').innerHTML = '<p class="muted">Читаю доступную историю…</p>';
  if (!$('source-dialog').open) $('source-dialog').showModal();
  try {
    const result = await api(
      '/history?chatId=' + encodeURIComponent(chatId) + '&offset=' + offset,
    );
    if (request !== state.sourceRequest || !$('source-dialog').open) return;
    if (!chatId) {
      $('source-body').innerHTML =
        `<p class="muted">Существующий индекс Авито. История ограничена, обновление использует прежнюю очередь. Тексты не архивируются.</p>${result.chats.map((c) => `<button class="today-card" data-history-chat="${esc(c.id)}"><strong>${esc(c.title || 'Диалог объявления')}</strong><span>${fmt(c.updatedAt)}</span></button>`).join('') || '<p>Индекс пока пуст. Нажмите «Обновить входящие».</p>'}`;
      return;
    }
    $('source-body').innerHTML =
      `<button data-action="history">← Диалоги</button><p class="muted">Выбор события сохраняет только ID и ссылку. Старое событие не создаёт срочного уведомления.</p>${result.messages.map((m) => `<div class="panel"><p class="muted">${fmt(m.createdAt)} · ${m.direction === 'in' ? 'Входящее' : 'Исходящее'}</p><div class="source-text">${esc(m.text || 'Текст недоступен: ' + m.type)}</div><button data-history-select="${esc(m.id)}" data-chat-id="${esc(chatId)}" data-offset="${offset}">Добавить во входящие</button></div>`).join('')}${result.hasMore && offset < 900 ? `<button data-history-chat="${esc(chatId)}" data-offset="${offset + 100}">Ранее</button>` : ''}`;
  } catch (e) {
    if (request !== state.sourceRequest || !$('source-dialog').open) return;
    $('source-body').innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}
function replaceChatSend(key, requestId, value = null) {
  const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
  if (saved?.requestId !== requestId) return false;
  if (value) sessionStorage.setItem(key, JSON.stringify(value));
  else sessionStorage.removeItem(key);
  return true;
}
async function openChat(id) {
  const chat = {
    id,
    messages: new Map(),
    offset: 0,
    loading: false,
    sending: false,
  };
  state.chat = chat;
  state.sourceRequest = (state.sourceRequest || 0) + 1;
  $('source-title').textContent = 'Чат с клиентом';
  $('source-body').innerHTML =
    `<div class="row wrap"><button id="chat-refresh">Обновить</button><button id="chat-older" hidden>Ранее</button><a id="chat-origin" target="_blank" rel="noopener noreferrer">В источнике ↗</a></div><p id="chat-error" class="error" role="status"></p><p id="chat-loading" class="muted" role="status">Загружаю переписку…</p><div id="chat-messages" class="chat-messages" aria-live="polite"></div><p id="chat-limit" class="muted"></p><form id="chat-compose" hidden><label>Сообщение клиенту<textarea id="chat-text" maxlength="1000" placeholder="Напишите ответ…" required></textarea></label><div class="row"><span id="chat-send-status" class="muted"></span><button id="chat-send" class="primary" type="submit">Отправить</button></div></form><button id="chat-resolve" hidden>Проверил: сообщения нет, разрешить повтор</button>`;
  if (!$('source-dialog').open) $('source-dialog').showModal();
  $('chat-text').value = sessionStorage.getItem('sales.chat-draft.' + id) || '';
  $('chat-text').oninput = () =>
    sessionStorage.setItem('sales.chat-draft.' + id, $('chat-text').value);
  $('chat-refresh').onclick = () => void loadChat(chat, 0);
  $('chat-older').onclick = () => void loadChat(chat, chat.offset + 100);
  for (const event of ['pause', 'ended']) {
    $('chat-messages').addEventListener(
      event,
      () => {
        if (
          chat.deferredMessages &&
          state.chat === chat &&
          $('source-dialog').open
        )
          void loadChat(chat, 0);
      },
      true,
    );
  }
  $('chat-compose').onsubmit = (e) => {
    e.preventDefault();
    void sendChat(chat);
  };
  $('chat-resolve').onclick = () =>
    void run(async () => {
      const pendingSend = JSON.parse(
        sessionStorage.getItem('sales.chat-send.' + id) || 'null',
      );
      if (!pendingSend) return;
      const receipt = await api('/chat/resolve', {
        method: 'POST',
        body: JSON.stringify({ requestId: pendingSend.requestId, chatId: id }),
      });
      replaceChatSend('sales.chat-send.' + id, pendingSend.requestId);
      if (state.chat !== chat || !$('source-dialog').open) return;
      $('chat-resolve').hidden = true;
      $('chat-send-status').textContent =
        receipt.state === 'sent'
          ? 'Источник подтвердил предыдущую отправку.'
          : 'Можно отправить повторно.';
      await loadChat(chat, 0);
    });
  await loadChat(chat, 0);
}
function renderChatMessages(chat, box) {
  const messages = [...chat.messages.values()].sort(
    (a, b) =>
      (a.createdAt || '').localeCompare(b.createdAt || '') ||
      a.id.localeCompare(b.id),
  );
  const existing = new Map(
    [...box.children].map((node) => [node.dataset.messageId, node]),
  );
  for (const node of box.children) {
    if (!node.dataset.messageId) node.remove();
  }
  let cursor = box.firstChild,
    complete = true;
  for (const m of messages) {
    const signature = JSON.stringify(m);
    let node = existing.get(m.id);
    if (!node || node.messageSignature !== signature) {
      if (
        node &&
        [...node.querySelectorAll('audio,video')].some(
          (player) => !player.paused,
        )
      ) {
        // Keep the active player; other messages must still appear immediately.
        complete = false;
      } else {
        const template = document.createElement('template');
        template.innerHTML = `<article data-message-id="${esc(m.id)}" class="message ${m.direction === 'out' ? 'outgoing' : 'incoming'}"><span class="message-author">${m.direction === 'out' ? 'Вы' : m.direction === 'in' ? 'Клиент' : 'Источник'} · ${fmt(m.createdAt)}</span><div>${esc(m.text || (m.unavailable ? 'Сообщение недоступно' : m.media?.length ? '' : 'Вложение: ' + m.type))}</div>${mediaMarkup(m.media)}</article>`;
        const replacement = template.content.firstElementChild;
        replacement.messageSignature = signature;
        if (node) {
          if (cursor === node) cursor = replacement;
          node.replaceWith(replacement);
        }
        node = replacement;
      }
    }
    if (node !== cursor) box.insertBefore(node, cursor);
    cursor = node.nextSibling;
  }
  if (!messages.length)
    box.innerHTML = '<p class="muted">Нет доступных сообщений.</p>';
  chat.deferredMessages = !complete;
  return complete;
}
async function loadChat(chat, offset) {
  if (chat.loading) {
    if (offset === 0) chat.refreshAgain = true;
    return;
  }
  chat.loading = true;
  $('chat-loading').hidden = false;
  $('chat-loading').textContent = chat.messages.size
    ? 'Обновляю переписку…'
    : 'Загружаю переписку…';
  const generation = chat.generation || 0;
  $('chat-resolve').disabled = true;
  try {
    const value = await api(
      '/chat?chatId=' + encodeURIComponent(chat.id) + '&offset=' + offset,
    );
    if (
      state.chat !== chat ||
      !$('source-dialog').open ||
      generation !== (chat.generation || 0)
    )
      return;
    const box = $('chat-messages'),
      atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const height = box.scrollHeight,
      top = box.scrollTop;
    value.messages.forEach((m) => chat.messages.set(m.id, m));
    $('source-title').textContent = value.title || 'Чат с клиентом';
    $('chat-error').textContent = '';
    $('chat-origin').href = value.url || '#';
    $('chat-origin').hidden = !value.url;
    if (offset >= chat.offset) {
      chat.offset = offset;
      $('chat-older').hidden = !value.hasMore || offset >= 900;
    }
    $('chat-limit').textContent = value.limited
      ? 'Показана доступная история источника.'
      : '';
    $('chat-compose').hidden = !value.canSend;
    const complete = renderChatMessages(chat, box);
    if (offset === 0) chat.latestGeneration = generation;
    $('chat-resolve').disabled =
      !complete || chat.sending || chat.latestGeneration !== generation;
    if (!complete)
      $('chat-error').textContent =
        'Изменения голосового сообщения появятся после прослушивания.';
    box.scrollTop =
      offset > 0
        ? top + box.scrollHeight - height
        : atBottom
          ? box.scrollHeight
          : top;
  } catch (error) {
    if (
      state.chat === chat &&
      $('source-dialog').open &&
      generation === (chat.generation || 0)
    )
      $('chat-error').textContent =
        error.name === 'AbortError'
          ? 'Переписка загружается слишком долго. Нажмите «Обновить», чтобы повторить.'
          : error.message ||
            'Не удалось загрузить переписку. Нажмите «Обновить».';
  } finally {
    chat.loading = false;
    if (state.chat === chat && $('chat-loading'))
      $('chat-loading').hidden = true;
    if (chat.refreshAgain && state.chat === chat && $('source-dialog').open) {
      chat.refreshAgain = false;
      void loadChat(chat, 0);
    }
  }
}
async function sendChat(chat) {
  if (chat.sending || state.chat !== chat) return;
  const text = $('chat-text').value.trim();
  if (!text) return;
  const key = 'sales.chat-send.' + chat.id;
  let input = JSON.parse(sessionStorage.getItem(key) || 'null');
  if (input && input.text !== text) {
    $('chat-error').textContent =
      'Сначала проверьте предыдущую отправку. Текущий текст сохранён.';
    $('chat-resolve').hidden = false;
    return;
  }
  input ||= { chatId: chat.id, requestId: crypto.randomUUID(), text };
  sessionStorage.setItem(key, JSON.stringify(input));
  chat.sending = true;
  chat.generation = (chat.generation || 0) + 1;
  $('chat-resolve').disabled = true;
  $('chat-send').disabled = true;
  $('chat-send-status').textContent = 'Отправляю…';
  try {
    await api('/chat/send', { method: 'POST', body: JSON.stringify(input) });
    chat.generation = (chat.generation || 0) + 1;
    replaceChatSend(key, input.requestId);
    if (state.chat !== chat || !$('source-dialog').open) return;
    if ($('chat-text').value.trim() === input.text) {
      $('chat-text').value = '';
      sessionStorage.removeItem('sales.chat-draft.' + chat.id);
    }
    $('chat-send-status').textContent = 'Отправлено';
    $('chat-resolve').hidden = true;
    await loadChat(chat, 0);
  } catch (error) {
    chat.generation = (chat.generation || 0) + 1;
    if (error.code === 'SALES_SEND_REJECTED')
      replaceChatSend(key, input.requestId);
    if (error.code === 'SALES_SEND_UNKNOWN' && error.current?.requestId) {
      replaceChatSend(key, input.requestId, {
        ...input,
        requestId: error.current.requestId,
      });
    }
    if (state.chat === chat && $('source-dialog').open) {
      $('chat-error').textContent = error.message;
      $('chat-send-status').textContent = 'Отправка не подтверждена';
      $('chat-resolve').hidden = error.code === 'SALES_SEND_REJECTED';
      if (error.code !== 'SALES_SEND_REJECTED') void loadChat(chat, 0);
    }
  } finally {
    chat.sending = false;
    if (state.chat === chat && $('chat-send')) $('chat-send').disabled = false;
  }
}
setInterval(() => {
  if (state.chat && $('source-dialog').open && !document.hidden)
    void loadChat(state.chat, 0);
}, 15000);
async function source(id) {
  state.chat = null;
  const request = (state.sourceRequest = (state.sourceRequest || 0) + 1);
  $('source-title').textContent = 'Источник';
  $('source-body').innerHTML = '<p class="muted">Читаю источник…</p>';
  $('source-dialog').showModal();
  try {
    const result = await api('/source?id=' + id);
    if (request !== state.sourceRequest || !$('source-dialog').open) return;
    $('source-body').innerHTML =
      `<p class="muted">${esc(channelNames[result.source] || result.source)} · ${fmt(result.at)}${result.partial ? ' · История может быть неполной' : ''}</p>${result.subject ? `<h3>${esc(result.subject)}</h3>` : ''}<div class="source-text">${esc(result.text || 'Текст отсутствует.')}</div>${mediaMarkup(result.media)}<p class="muted">Полный текст не сохраняется в архив стола.</p>`;
  } catch (e) {
    if (request !== state.sourceRequest || !$('source-dialog').open) return;
    $('source-body').innerHTML =
      `<p class="error">${esc(e.message)}</p><button data-source-retry="${id}">Повторить чтение</button>`;
  }
}
async function openOrderDraft(note) {
  const value = await api(
    '/order-draft?noteId=' +
      encodeURIComponent(note.id) +
      '&summaryId=' +
      encodeURIComponent(note.summary?.jobId || ''),
  );
  location.href =
    '/kanban/?action=create&salesNote=' +
    encodeURIComponent(note.id) +
    '&salesSummary=' +
    encodeURIComponent(value.summaryId);
}
async function updated() {
  await refresh({ quiet: true });
  if (state.detail && $('detail').open) await openNote(state.detail.id);
}
async function run(action) {
  try {
    await action();
  } catch (e) {
    notice(e.message || 'Нет связи. Проверьте результат сохранения.', true);
  }
}
let layoutChanges = [],
  layoutFlight = null;
function applyLayoutPatch(layout, patch) {
  if (patch.zoom !== undefined) layout.zoom = patch.zoom;
  if (patch.mode !== undefined) layout.mode = patch.mode;
  for (const [id, position] of Object.entries(patch.positions || {})) {
    const { initial, ...changes } = position;
    layout.positions[id] = {
      x: 0,
      y: 0,
      pinned: false,
      zone: '',
      ...(layout.positions[id] || initial),
      ...changes,
    };
  }
  for (const zone of patch.zones || []) {
    const i = layout.zones.findIndex((z) => z.id === zone.id);
    if (i < 0) layout.zones.push(zone);
    else layout.zones[i] = zone;
  }
}
function persistLayoutChanges() {
  sessionStorage.setItem('sales.layout-changes', JSON.stringify(layoutChanges));
}
function saveLayout(patch) {
  layoutChanges.push({ requestId: crypto.randomUUID(), data: patch });
  persistLayoutChanges();
  applyLayoutPatch(state.snapshot.layout, patch);
  if (!drag && !zoomSaveTimer) render();
  return flushLayouts();
}
function flushLayouts() {
  if (layoutFlight) return layoutFlight;
  if (state.pending && !mutationFlight) return Promise.resolve();
  layoutFlight = (async () => {
    let rejected = null;
    while (layoutChanges.length) {
      const change = layoutChanges[0];
      let result;
      try {
        result = await mutate(
          'layout.patch',
          change.data,
          null,
          change.requestId,
        );
      } catch (error) {
        if (![400, 409].includes(error.status)) throw error;
        // A rejected zone/position must not block every subsequent gesture.
        saveDraft({ ...change, action: 'layout.patch' });
        layoutChanges.shift();
        persistLayoutChanges();
        rejected = error;
        await refresh({ quiet: true });
        continue;
      }
      layoutChanges.shift();
      persistLayoutChanges();
      // A late receipt can be older than the snapshot from a second tab.
      if (result.revision >= state.snapshot.layout.revision) {
        const zoom = state.snapshot.layout.zoom;
        state.snapshot.layout = result;
        if (zoomSaveTimer) state.snapshot.layout.zoom = zoom;
      }
      for (const queued of layoutChanges)
        applyLayoutPatch(state.snapshot.layout, queued.data);
      if (!drag && !zoomSaveTimer) render();
    }
    if (rejected) throw rejected;
  })().finally(() => {
    layoutFlight = null;
  });
  return layoutFlight;
}
async function trashNote(id) {
  const saved = await mutate('note.trash', { id });
  if (state.detail?.id === id) $('detail').close();
  await refresh({ quiet: true });
  $('undo-trash').dataset.id = id;
  $('undo-trash').dataset.trashId = saved.trashId;
  $('trash-undo').hidden = false;
}
async function restoreNote(id, trashId) {
  await mutate('note.restore', { id, trashId });
  $('trash-undo').hidden = true;
  await updated();
}
function showTrash(open = true) {
  if (!open && (!state.trashOpen || !$('source-dialog').open)) return;
  state.trashOpen = true;
  $('source-title').textContent = 'Корзина';
  $('source-body').innerHTML =
    `<p class="muted">Карточки можно восстановить вместе с заметками, файлами и связями.</p>${(state.snapshot.trash || []).map((n) => `<section class="panel row wrap"><div><strong>${esc(n.title)}</strong><p class="muted">${fmt(n.trashedAt)}</p></div><button data-restore="${n.id}" data-trash-id="${esc(n.trashId)}">Восстановить</button></section>`).join('') || '<p>Корзина пуста.</p>'}`;
  if (!$('source-dialog').open) $('source-dialog').showModal();
}
$('open-trash').onclick = () =>
  run(async () => {
    await refresh({ quiet: true });
    showTrash();
  });
$('undo-trash').onclick = () =>
  run(() =>
    restoreNote($('undo-trash').dataset.id, $('undo-trash').dataset.trashId),
  );
function position(id) {
  const n = $('content').querySelector(`[data-note="${id}"]`);
  return (
    (newestMode() && n
      ? {
          ...state.snapshot.layout.positions[id],
          x: parseFloat(n.style.left) || 0,
          y: parseFloat(n.style.top) || 0,
        }
      : state.snapshot.layout.positions[id]) || {
      x: n ? parseFloat(n.style.left) || 0 : 0,
      y: n ? parseFloat(n.style.top) || 0 : 0,
      pinned: false,
      zone: '',
    }
  );
}
function layoutClone() {
  return structuredClone(state.snapshot.layout);
}
function arrange() {
  state.pan = { x: 20, y: 20 };
  if (newestMode()) {
    render();
    return;
  }
  const layout = layoutClone(),
    notes = filteredNotes(),
    { step, columns } = boardMetrics();
  notes.forEach((n, i) => {
    layout.positions[n.id] = {
      ...position(n.id),
      x: (i % columns) * step + 10,
      y: Math.floor(i / columns) * 480 + 10,
    };
  });
  return saveLayout({
    positions: Object.fromEntries(
      notes.map((n) => [
        n.id,
        { x: layout.positions[n.id].x, y: layout.positions[n.id].y },
      ]),
    ),
  });
}
function configureIntake() {
  editor(
    'Включить приём входящих',
    `<p class="policy-box">Выберите глубину приёма. Сохраняются ссылки, ID и версии событий; тексты читаются по запросу. Полный архив переписки не создаётся. Доступны только уже разрешённые источники.</p><label>Глубина приёма<select name="policy" required><option value="">Выберите вариант</option><option value="new">Только новые события с момента включения</option><option value="30days">Добавить события за последние 30 дней</option></select></label><p class="muted">Старую историю можно просматривать по запросу. Подключения показывают фактические пределы и расписание каждого канала.</p>`,
    (f) => mutate('intake.configure', { policy: f.get('policy') }),
    'Включить с выбранной глубиной',
  );
}
function settingsForm() {
  const s = state.snapshot.settings;
  editor(
    'Рабочее время и ответственные',
    `<div class="form-grid">${select(
      'timezone',
      'Часовой пояс',
      [
        ['Europe/Moscow', 'Москва · UTC+3'],
        ['Asia/Riyadh', 'Эр-Рияд · UTC+3'],
        ['Asia/Yekaterinburg', 'Екатеринбург · UTC+5'],
      ],
      s.timezone,
      'class="wide"',
    )}${label('startHour', 'Начало, час', s.startHour, 'number')}${label('endHour', 'Окончание, час', s.endHour, 'number')}<div class="wide selection-list">${[
      ['1', 'Понедельник'],
      ['2', 'Вторник'],
      ['3', 'Среда'],
      ['4', 'Четверг'],
      ['5', 'Пятница'],
      ['6', 'Суббота'],
      ['0', 'Воскресенье'],
    ]
      .map(
        ([v, n]) =>
          `<label><input type="checkbox" name="days" value="${v}" ${s.days.includes(Number(v)) ? 'checked' : ''}>${n}</label>`,
      )
      .join(
        '',
      )}</div>${textarea('owners', 'Ответственные, по одному в строке', s.owners.join('\n'))}</div>`,
    (f) =>
      mutate('settings.save', {
        timezone: f.get('timezone'),
        startHour: Number(f.get('startHour')),
        endHour: Number(f.get('endHour')),
        days: f.getAll('days').map(Number),
        owners: f
          .get('owners')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      }),
  );
}
function upload(recovery = null, onSaved = () => {}, draftId) {
  const n = state.detail;
  editor(
    recovery ? 'Продолжить загрузку файла' : 'Прикрепить файл',
    `<p class="muted">${recovery ? 'Выберите тот же файл: ' + esc(recovery.name) : 'Исходный формат сохраняется.'}</p><label>Файл<input name="file" type="file" required></label>`,
    async (f) => {
      if (
        state.pending &&
        (!recovery || state.pending.requestId !== recovery.requestId)
      )
        throw new Error('Сначала проверьте предыдущее сохранение.');
      const file = f.get('file');
      // The server streams and hashes the whole file. Avoid loading it into
      // browser memory just to validate a retry; the durable receipt checks bytes.
      if (
        recovery &&
        (file.name !== recovery.name ||
          (recovery.size !== undefined && file.size !== recovery.size))
      )
        throw new Error('Это другой файл. Выберите исходный файл загрузки.');
      const meta = recovery || {
        requestId: crypto.randomUUID(),
        file: true,
        noteId: n.id,
        revision: n.revision,
        name: file.name,
        mime: [
          'image/png',
          'image/jpeg',
          'image/webp',
          'application/pdf',
        ].includes(file.type)
          ? file.type
          : 'application/octet-stream',
        size: file.size,
      };
      if (draftId) recoveryReceipt(meta.requestId, draftId);
      pending(meta);
      try {
        await api('/file', {
          method: 'POST',
          body: file,
          headers: {
            'x-request-id': meta.requestId,
            'x-note-id': meta.noteId,
            'x-note-revision': String(meta.revision),
            'x-file-name': encodeURIComponent(meta.name),
            'Content-Type': meta.mime,
          },
        });
        resolveRecovery(meta.requestId, true);
        pending(null);
        onSaved();
      } catch (e) {
        if (e.status && e.status < 500) {
          if (e.status === 409) saveDraft(meta);
          resolveRecovery(meta.requestId, false);
          pending(null);
        } else pending(meta, true);
        throw e;
      }
    },
  );
}
async function detailAction(action) {
  const n = state.detail;
  if (action === 'trash') return trashNote(n.id);
  if (action === 'restore') return restoreNote(n.id, n.trashId);
  if (action === 'edit') return editNote();
  if (action === 'merge') return mergeNotes();
  if (action === 'split') return splitNote();
  if (action === 'upload') return upload();
  if (action === 'archive') {
    return editor(
      'Отправить обращение в архив',
      `<p>Архивируем «${esc(n.title)}». Переписка, файлы и заметки сохранятся.</p>`,
      () =>
        mutate('note.update', {
          id: n.id,
          revision: n.revision,
          patch: { status: 'archived' },
        }),
      'В архив',
    );
  }
  if (action === 'reopen') {
    await mutate('note.update', {
      id: n.id,
      revision: n.revision,
      patch: { status: 'active' },
    });
    return updated();
  }
  if (action === 'read') {
    await mutate('note.read', { id: n.id, watermark: n.watermark });
    return refresh({ quiet: true });
  }
  if (action === 'transfer') {
    if (state.transferring) return;
    const id = n.id,
      orderId = n.orderId;
    state.transferring = id;
    renderDetail();
    try {
      let result;
      do {
        result = await api('/order-files', {
          method: 'POST',
          body: JSON.stringify({ noteId: id, orderId }),
        });
      } while (!result.done);
      notice(
        result.pending
          ? 'Часть файлов пока недоступна. Остальные перенесены. Продолжение сохранено в карточке.'
          : 'Перенос файлов завершён.' +
              (result.unavailable
                ? ' Недоступных у источника: ' + result.unavailable + '.'
                : ''),
      );
    } finally {
      state.transferring = null;
      if (state.detail?.id === id && $('detail').open) await openNote(id);
    }
    return;
  }
  if (action === 'order') {
    if (state.orderAfterAnalysis) return;
    const job = await api('/order-prepare', {
      method: 'POST',
      body: JSON.stringify({
        noteId: n.id,
        revision: n.revision,
        requestId: crypto.randomUUID(),
      }),
    });
    state.orderAfterAnalysis = {
      noteId: n.id,
      jobId: job.id,
      startedAt: Date.now(),
    };
    notice(
      'Проверяем новые сообщения и обновляем данные заказа. Затем откроется форма для проверки.',
    );
    renderDetail();
    return;
  }
  if (action === 'analyze') {
    const prior = n.jobs.find(
      (j) =>
        j.state === 'error' &&
        j.revision === n.revision &&
        j.watermark === n.watermark,
    );
    const requestId = prior?.id || crypto.randomUUID();
    await api('/analyze', {
      method: 'POST',
      body: JSON.stringify({ noteId: n.id, revision: n.revision, requestId }),
    });
    await openNote(n.id);
    notice('Анализ запущен. Ручные заметки сохранятся.');
  }
}
document.addEventListener('click', (event) => {
  const b = event.target.closest('button');
  if (!b || b.disabled) return;
  const d = b.dataset;
  if (d.restore)
    return run(async () => {
      await restoreNote(d.restore, d.trashId);
      showTrash(false);
    });
  if (d.chatOpen) return run(() => openChat(d.chatOpen));
  if (d.historyChat)
    return run(() => history(d.historyChat, Number(d.offset || 0)));
  if (d.historySelect)
    return run(async () => {
      await api('/history', {
        method: 'POST',
        body: JSON.stringify({
          chatId: d.chatId,
          messageId: d.historySelect,
          offset: Number(d.offset || 0),
        }),
      });
      $('source-dialog').close();
      state.view = 'inbox';
      state.zone = '';
      await refresh({ quiet: true });
    });
  if (d.open) return run(() => openNote(d.open));
  if (d.chatCreate) return run(() => createChatCard(d.chatCreate));
  if (d.inboxChannel !== undefined || d.inboxScope !== undefined) {
    clearTimeout(inboxSearchTimer);
    if (d.inboxChannel !== undefined) state.inboxChannel = d.inboxChannel;
    if (d.inboxScope !== undefined) state.inboxScope = d.inboxScope;
    state.refreshId++;
    return run(() =>
      refresh({ quiet: true, inboxCursor: '', inboxPrevious: [] }),
    );
  }
  if (d.inboxNext !== undefined)
    return run(() => inboxNavigate('next', d.inboxNext));
  if (d.inboxPrev !== undefined) return run(() => inboxNavigate('prev'));
  if (d.inboxStart !== undefined) return run(() => inboxNavigate('start'));
  if (d.view) {
    state.view = d.view;
    state.zone = '';
    state.refreshId++;
    if (d.view === 'inbox')
      return run(() =>
        refresh({ quiet: true, inboxCursor: '', inboxPrevious: [] }),
      );
    state.inboxSearching = false;
    render();
    return;
  }
  if (d.zone) {
    state.view = 'desk';
    state.zone = d.zone;
    render();
    return;
  }
  if (d.tab) {
    state.tab = d.tab;
    renderDetail();
    return;
  }
  if (d.detailAction) return run(() => detailAction(d.detailAction));
  if (d.eventNew)
    return newNote(state.snapshot.inbox.find((e) => e.id === d.eventNew));
  if (d.eventLink) return linkEvent(d.eventLink);
  if (d.source) return run(() => source(d.source));
  if (d.sourceRetry) return run(() => source(d.sourceRetry));
  if (d.fileApprove) {
    const n = state.detail;
    return editor(
      'Согласованный файл',
      textarea('reason', 'Основание согласования', ''),
      (f) =>
        mutate('file.approve', {
          id: d.fileApprove,
          noteId: n.id,
          revision: n.revision,
          reason: f.get('reason'),
        }),
    );
  }
  if (d.unmerge)
    return editor(
      'Отменить объединение',
      '<p>Исходные записки и состав будут восстановлены, если после объединения не было других правок. Иначе используйте разделение.</p>',
      async () => {
        const r = await mutate('notes.unmerge', { mergeId: d.unmerge });
        await openNote(r.noteId);
      },
      'Восстановить',
    );
  if (d.pin)
    return run(async () => {
      const l = layoutClone();
      l.positions[d.pin] = {
        ...position(d.pin),
        pinned: !position(d.pin).pinned,
      };
      await saveLayout({
        positions: {
          [d.pin]: {
            initial: { x: position(d.pin).x, y: position(d.pin).y },
            pinned: l.positions[d.pin].pinned,
          },
        },
      });
    });
  if (Object.hasOwn(d, 'cancelEditor')) return $('editor').close();
  if (d.action === 'configure-intake') return configureIntake();
  if (d.action === 'history') return run(() => history());
  if (d.action === 'new') return newNote();
  if (d.action === 'settings') return settingsForm();
  if (d.action === 'sync')
    return run(async () => {
      await api('/sync', { method: 'POST', body: '{}' });
      notice(
        'Обновление передано существующей очереди источника. Результат появится после обработки.',
      );
      await refresh({ quiet: true });
    });
});
document.addEventListener('input', (event) => {
  const id = event.target.dataset.quickNote;
  if (id) sessionStorage.setItem('sales.quick.' + id, event.target.value);
});
const manualSaves = new Map();
function saveManual(id, before, manual) {
  const previous = manualSaves.get(id);
  const entry = {
    before,
    manual,
    bases: new Set([before, ...(previous?.bases || [])]),
  };
  entry.promise = (async () => {
    let expected = before;
    if (previous) {
      const saved = await previous.promise.catch(() => null);
      // Only advance over our own acknowledged edit, never a fresh server value.
      // A third-party change after that edit still fails the server's text guard.
      if (saved && (previous.bases.has(before) || before === previous.manual)) {
        expected = saved.manual;
        entry.bases.add(saved.manual);
      }
    }
    return mutate('note.manual', { id, before: expected, manual });
  })();
  manualSaves.set(id, entry);
  return entry.promise.finally(() => {
    if (manualSaves.get(id) === entry) manualSaves.delete(id);
  });
}
document.addEventListener('focusout', (event) => {
  const input = event.target,
    id = input.dataset.quickNote;
  if (!id || input.readOnly || input.value === input.dataset.before) return;
  const manual = input.value,
    before = input.dataset.before;
  void run(async () => {
    await saveManual(id, before, manual);
    if (sessionStorage.getItem('sales.quick.' + id) === manual)
      sessionStorage.removeItem('sales.quick.' + id);
    input.dataset.before = manual;
    await refresh({ quiet: true });
  });
});
for (const [id, side, label] of [
  ['toggle-navigation', 'left', 'меню'],
  ['toggle-today', 'right', 'Сегодня'],
]) {
  $(id).onclick = () => {
    const collapsed = $('shell').classList.toggle(side + '-collapsed');
    $(id).setAttribute('aria-expanded', String(!collapsed));
    $(id).setAttribute(
      'aria-label',
      (collapsed ? 'Развернуть ' : 'Свернуть ') + label,
    );
  };
}
document
  .querySelectorAll('#navigation [data-view]')
  .forEach((b) => b.setAttribute('title', b.textContent.trim()));
document.addEventListener('change', (event) => {
  const id = event.target.dataset.noteZone;
  if (id)
    void run(async () => {
      const l = layoutClone();
      l.positions[id] = { ...position(id), zone: event.target.value };
      await saveLayout({
        positions: {
          [id]: {
            initial: { x: position(id).x, y: position(id).y },
            zone: event.target.value,
          },
        },
      });
    });
});
$('new-note').onclick = () => newNote();
$('refresh').onclick = () => refresh();
$('close-detail').onclick = () => $('detail').close();
// Both pointer ends must be on the backdrop: selecting text out of the window must not close it.
for (const dialog of document.querySelectorAll('dialog')) {
  let backdropDown = false;
  const outside = (e) => {
    const r = dialog.getBoundingClientRect();
    return (
      e.target === dialog &&
      (e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom)
    );
  };
  dialog.addEventListener('pointerdown', (e) => {
    backdropDown = outside(e);
  });
  dialog.addEventListener('click', (e) => {
    if (backdropDown && outside(e)) dialog.close();
    backdropDown = false;
  });
}

$('detail').addEventListener('close', () => {
  state.detailRequest++;
  state.orderAfterAnalysis = null;
});
$('close-editor').onclick = () => $('editor').close();
$('close-source').onclick = () => $('source-dialog').close();
$('source-dialog').addEventListener('close', () => {
  state.trashOpen = false;
  state.sourceRequest = (state.sourceRequest || 0) + 1;
  state.chat = null;
});
let inboxSearchTimer;
$('search').oninput = () => {
  clearTimeout(inboxSearchTimer);
  if (state.view !== 'inbox') return render();
  state.refreshId++;
  state.inboxSearching = true;
  render();
  inboxSearchTimer = setTimeout(() => {
    void refresh({ quiet: true, inboxCursor: '', inboxPrevious: [] });
  }, 250);
};
$('owner-filter').onchange = () => render();
$('status-filter').onchange = () => render();
$('unread-filter').onchange = () => render();
$('toggle-list').onclick = () => {
  state.list = !state.list;
  render();
};
$('arrange').onclick = () => run(arrange);
$('toggle-newest').onclick = () =>
  run(() => {
    const mode = newestMode() ? 'free' : 'newest';
    state.pan = { x: 20, y: 20 };
    return saveLayout({ mode });
  });
for (const [id, delta] of [
  ['zoom-out', -0.1],
  ['zoom-in', 0.1],
])
  $(id).onclick = () =>
    run(() => {
      const l = layoutClone();
      l.zoom = Math.max(
        0.5,
        Math.min(1.5, Math.round((l.zoom + delta) * 10) / 10),
      );
      return saveLayout({ zoom: l.zoom });
    });
$('add-zone').onclick = () =>
  editor('Новая зона', label('name', 'Название зоны', '', 'text'), (f) => {
    const l = layoutClone();
    l.zones.push({ id: crypto.randomUUID(), name: f.get('name') });
    return saveLayout({ zones: [l.zones.at(-1)] });
  });
$('login-form').onsubmit = async (e) => {
  e.preventDefault();
  const button = e.submitter;
  button.disabled = true;
  try {
    const response = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: new FormData(e.target).get('pin') }),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error);
    e.target.reset();
    await refresh({ quiet: true });
    await flushLayouts();
  } catch (error) {
    $('login-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
$('retry-pending').onclick = () =>
  run(async () => {
    const p = state.pending;
    if (!p) return;
    const receipt = await api('/receipt?id=' + encodeURIComponent(p.requestId));
    if (receipt.found) {
      resolveRecovery(p.requestId, true);
      pending(null);
      await updated();
      await flushLayouts();
      notice('Сохранение подтверждено сервером.');
      return;
    }
    if (p.file) {
      await openNote(p.noteId, 'files');
      upload(p);
      return;
    }
    try {
      await api('/command', { method: 'POST', body: JSON.stringify(p) });
    } catch (error) {
      if (error.status >= 400 && error.status < 500) {
        saveDraft(p);
        resolveRecovery(p.requestId, false);
        pending(null);
        if (p.action === 'layout.patch' && [400, 409].includes(error.status)) {
          layoutChanges = layoutChanges.filter(
            (change) => change.requestId !== p.requestId,
          );
          persistLayoutChanges();
        }
        await refresh({ quiet: true });
        await flushLayouts();
        throw new Error(
          error.message +
            ' Предыдущая команда не применена. Проверьте свежие данные и сохраните заново.',
        );
      }
      throw error;
    }
    resolveRecovery(p.requestId, true);
    pending(null);
    await updated();
    await flushLayouts();
    notice('Команда подтверждена.');
  });
let drag = null,
  zoomSaveTimer = null;
function applyViewport() {
  const board = $('content').querySelector('.board');
  if (board) {
    board.style.transform = `translate(${state.pan.x}px,${state.pan.y}px) scale(${state.snapshot.layout.zoom})`;
    const textScale = String(cardTextScale()),
      summaryScale = String(summaryTextScale());
    if (
      board.style.getPropertyValue('--note-text-scale') !== textScale ||
      board.style.getPropertyValue('--summary-text-scale') !== summaryScale
    ) {
      board.style.setProperty('--note-text-scale', textScale);
      board.style.setProperty('--summary-text-scale', summaryScale);
      // Reflow rows without replacing focused inputs or scrolled summaries.
      flowNewestRows(board);
    }
  }
  $('zoom-label').textContent =
    Math.round(state.snapshot.layout.zoom * 100) + '%';
}
function saveZoom() {
  clearTimeout(zoomSaveTimer);
  zoomSaveTimer = null;
  return saveLayout({ zoom: state.snapshot.layout.zoom });
}
$('content').addEventListener(
  'wheel',
  (e) => {
    if (
      !$('content').classList.contains('canvas') ||
      drag ||
      (state.pending && state.pending.action !== 'layout.patch') ||
      e.target.closest('textarea,.compact-summary')
    )
      return;
    e.preventDefault();
    const rect = $('content').getBoundingClientRect(),
      old = state.snapshot.layout.zoom;
    const next = Math.max(
      0.5,
      Math.min(1.5, old * Math.exp(-e.deltaY * 0.001)),
    );
    if (old === next) return;
    const x = e.clientX - rect.left,
      y = e.clientY - rect.top;
    state.pan = {
      x: x - ((x - state.pan.x) * next) / old,
      y: y - ((y - state.pan.y) * next) / old,
    };
    state.snapshot.layout.zoom = next;
    applyViewport();
    clearTimeout(zoomSaveTimer);
    zoomSaveTimer = setTimeout(() => void run(saveZoom), 500);
  },
  { passive: false },
);
$('content').addEventListener('auxclick', (e) => {
  if (e.button === 1) e.preventDefault();
});
function dragTarget(e) {
  const note = e.target.closest('.note');
  if (!note || note.classList.contains('pinned')) return null;
  if (e.target.closest('.drag-handle,.card-edge')) return note;
  if (
    e.target.closest('button,a,input,textarea,select,label,[contenteditable]')
  )
    return null;
  const rect = note.getBoundingClientRect();
  return e.clientY <= rect.top + rect.height / 3 ? note : null;
}
function overTrash(e) {
  const rect = $('trash-strip').getBoundingClientRect();
  return (
    !$('trash-strip').hidden &&
    e.clientX >= rect.left &&
    e.clientX <= rect.right &&
    e.clientY >= rect.top &&
    e.clientY <= rect.bottom
  );
}
$('content').addEventListener('pointerdown', (e) => {
  if (
    !$('content').classList.contains('canvas') ||
    drag ||
    (state.pending && state.pending.action !== 'layout.patch')
  )
    return;
  if (e.button === 1) {
    drag = {
      kind: 'pan',
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      ...state.pan,
    };
  } else {
    const note = dragTarget(e);
    if (!note || e.button !== 0) return;
    if (document.activeElement?.matches('[data-quick-note]'))
      document.activeElement.blur();
    const id = note.dataset.note,
      p = position(id);
    drag = {
      kind: 'card',
      id,
      pointerId: e.pointerId,
      node: note,
      startX: e.clientX,
      startY: e.clientY,
      x: p.x,
      y: p.y,
      zoom: state.snapshot.layout.zoom,
      moved: false,
    };
  }
  $('content').setPointerCapture(e.pointerId);
  e.preventDefault();
});
$('content').addEventListener('pointermove', (e) => {
  if (!drag) {
    $('content').classList.toggle('can-drag', Boolean(dragTarget(e)));
    return;
  }
  if (drag.pointerId !== e.pointerId) return;
  if (drag.kind === 'pan') {
    state.pan = {
      x: drag.x + e.clientX - drag.startX,
      y: drag.y + e.clientY - drag.startY,
    };
    applyViewport();
    return;
  }
  if (
    !drag.moved &&
    Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 4
  )
    return;
  drag.moved = true;
  drag.node.classList.add('dragging');
  $('trash-strip').classList.add('drag-active');
  $('trash-strip').classList.toggle('drop-ready', overTrash(e));
  drag.node.style.left =
    Math.max(
      0,
      Math.min(10000, drag.x + (e.clientX - drag.startX) / drag.zoom),
    ) + 'px';
  drag.node.style.top =
    Math.max(
      0,
      Math.min(10000, drag.y + (e.clientY - drag.startY) / drag.zoom),
    ) + 'px';
});
function finishDrag(e, cancelled = false) {
  if (!drag || (e.pointerId !== undefined && e.pointerId !== drag.pointerId))
    return;
  const current = drag;
  drag = null;
  $('trash-strip').classList.remove('drag-active', 'drop-ready');
  if ($('content').hasPointerCapture(current.pointerId))
    $('content').releasePointerCapture(current.pointerId);
  if (cancelled) {
    if (current.kind === 'pan') state.pan = { x: current.x, y: current.y };
    render();
    return;
  }
  if (current.kind === 'pan' || !current.moved) return;
  current.node.classList.remove('dragging');
  if (overTrash(e)) {
    // Remove only after the server acknowledges; errors restore the previous position.
    current.node.style.left = current.x + 'px';
    current.node.style.top = current.y + 'px';
    void run(() => trashNote(current.id));
    return;
  }
  if (newestMode()) {
    render();
    return;
  }
  void run(() =>
    saveLayout({
      positions: {
        [current.id]: {
          x: parseFloat(current.node.style.left),
          y: parseFloat(current.node.style.top),
        },
      },
    }),
  );
}
$('content').addEventListener('pointerup', (e) => finishDrag(e));
$('content').addEventListener('pointercancel', (e) => finishDrag(e, true));
$('content').addEventListener('lostpointercapture', (e) => finishDrag(e, true));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drag) {
    e.preventDefault();
    finishDrag(e, true);
  }
});
window.addEventListener('resize', () => {
  if (state.snapshot && !drag) render();
});
try {
  state.recoveries = JSON.parse(
    sessionStorage.getItem('sales.recoveries') || '{}',
  );
  state.drafts = JSON.parse(sessionStorage.getItem('sales.drafts') || '[]');
  persistDrafts();
  pending(JSON.parse(sessionStorage.getItem('sales.pending') || 'null'), true);
  layoutChanges = JSON.parse(
    sessionStorage.getItem('sales.layout-changes') || '[]',
  );
} catch {
  pending(null);
}
await refresh({ quiet: true });
if (state.snapshot && !state.pending) void run(flushLayouts);
setInterval(() => {
  if (
    document.hidden ||
    $('editor').open ||
    state.pending ||
    state.inboxLoading ||
    layoutChanges.length ||
    zoomSaveTimer ||
    drag
  )
    return;
  void refresh({ quiet: true });
}, 30000);

let analysisPollBusy = false;
setInterval(async () => {
  if (
    analysisPollBusy ||
    drag ||
    zoomSaveTimer ||
    layoutChanges.length ||
    document.hidden ||
    !$('detail').open ||
    $('editor').open ||
    state.pending ||
    !state.detail
  )
    return;
  const id = state.detail.id,
    request = state.detailRequest;
  analysisPollBusy = true;
  try {
    const detail = await api('/note?id=' + encodeURIComponent(id));
    if (
      !$('detail').open ||
      request !== state.detailRequest ||
      state.detail.id !== id ||
      state.pending ||
      $('editor').open
    )
      return;
    if (state.orderAfterAnalysis?.noteId === detail.id) {
      const pending = state.orderAfterAnalysis;
      const job = await api(
        '/order-prepare?noteId=' +
          encodeURIComponent(detail.id) +
          '&requestId=' +
          encodeURIComponent(pending.jobId),
      );
      if (
        state.orderAfterAnalysis !== pending ||
        request !== state.detailRequest ||
        !$('detail').open
      )
        return;
      if (job && ['done', 'error', 'stale'].includes(job.state)) {
        state.orderAfterAnalysis = null;
        await openOrderDraft(detail);
        return;
      }
    }
    if (JSON.stringify(detail) === JSON.stringify(state.detail)) return;
    if (
      [...$('detail-body').querySelectorAll('audio,video')].some(
        (player) => !player.paused,
      )
    )
      return;
    const summaryChanged =
      detail.summary &&
      JSON.stringify(detail.summary) !== JSON.stringify(state.detail.summary);
    state.detail = detail;
    renderDetail();
    if (summaryChanged) notice('Саммари обновлено.');
    await refresh({ quiet: true });
  } catch (error) {
    if (error.code?.startsWith('SALES_ORDER_')) notice(error.message, true);
    /* Keep the saved card and retry the read on the next tick. */
  } finally {
    analysisPollBusy = false;
  }
}, 3000);
