import {
  simpleSources as sources,
  simpleAds as ads,
  simpleCustomers as customers,
  simpleLeads as leads,
  simpleSeed,
  simplePaid,
  simpleRows,
  simpleAssign,
  simpleLink,
  simpleCreate,
} from './simple-model.mjs';

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
const money = (v) =>
  v == null
    ? '—'
    : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(
        v / 100,
      ) + ' ₽';
const name = (id) =>
  customers.find((c) => c.id === id)?.name.replace('Демо · ', '') || id;
const adName = (id) => ads.find((a) => a.id === id)?.title || 'Без объявления';
const button = (label, action, value = '', cls = '') =>
  `<button class="${cls}" data-s="${action}" data-v="${esc(value)}">${label}</button>`;
const options = (value) =>
  Object.entries(sources)
    .map(
      ([id, label]) =>
        `<option value="${id}" ${value === id ? 'selected' : ''}>${label}</option>`,
    )
    .join('');
let db = simpleSeed(),
  undo = null;
let ui = {
  tab: 'analytics',
  expanded: new Set(['avito']),
  selected: new Set(),
  order: null,
  lead: null,
  form: null,
  target: '',
  filter: 'all',
  sort: 'source',
  descending: false,
  notice: '',
  bulk: 'avito',
};
let host;

function save(next, message) {
  undo = db;
  db = next;
  ui.notice = message + ' Изменение только в этом демо.';
  ui.form = null;
  ui.selected.clear();
}
function orderButtons(rows) {
  return rows.length
    ? rows
        .map(
          (o) =>
            `<button class="s-order-link" data-s="order" data-v="${o.id}"><b>№ ${o.id}</b><span>${esc(name(o.customer))}</span><span>${money(simplePaid(db, o.id))}</span><span>↗</span></button>`,
        )
        .join('')
    : '<p class="s-muted">Заказов пока нет.</p>';
}
function analytics() {
  const rows = simpleRows(db);
  if (ui.sort === 'source')
    rows.sort(
      (a, b) => a.label.localeCompare(b.label, 'ru') * (ui.descending ? -1 : 1),
    );
  if (ui.sort !== 'source')
    rows.sort((a, b) => {
      const av = ui.sort === 'orders' ? a.orders.length : a[ui.sort],
        bv = ui.sort === 'orders' ? b.orders.length : b[ui.sort];
      return av == null
        ? bv == null
          ? 0
          : 1
        : bv == null
          ? -1
          : (av - bv) * (ui.descending ? -1 : 1);
    });
  const cells = (r) =>
    `<td>${money(r.spending)}</td><td>${r.leads}</td><td>${r.orders.length}</td><td class="s-paid">${money(r.paid)}</td>`;
  return `<section class="s-card"><div class="s-section"><div><h2>От источника до оплаты</h2><p>Нажмите на источник, чтобы увидеть объявления и заказы.</p></div><span class="s-tag">${db.orders.length} заказов</span></div>
    <div class="s-table-wrap"><table class="s-table"><thead><tr>${[
      ['source', 'Источник'],
      ['spending', 'Расходы'],
      ['leads', 'Обращения'],
      ['orders', 'Заказы'],
      ['paid', 'Оплачено'],
    ]
      .map(
        ([key, label]) =>
          `<th scope="col" aria-sort="${ui.sort === key ? (ui.descending ? 'descending' : 'ascending') : 'none'}">${button(label + (ui.sort === key ? (ui.descending ? ' ↓' : ' ↑') : ' ↕'), 'sort', key)}</th>`,
      )
      .join('')}</tr></thead><tbody>
    ${rows
      .map(
        (
          r,
        ) => `<tr class="s-source" data-source="${r.key}"><th scope="row"><button data-s="expand" data-v="${r.key}" aria-expanded="${ui.expanded.has(r.key)}"><span class="s-chevron">${ui.expanded.has(r.key) ? '⌄' : '›'}</span><span class="s-source-icon ${r.key}">${esc(r.label.slice(0, 1))}</span>${esc(r.label)}</button></th>${cells(r)}</tr>
    ${
      ui.expanded.has(r.key)
        ? simpleRows(db, r.key)
            .map(
              (a) =>
                `<tr class="s-ad" data-ad="${a.key}"><th scope="row"><span>↳</span> ${esc(a.label)}</th>${cells(a)}</tr>`,
            )
            .join('') +
          `<tr class="s-related"><td colspan="5"><div><span class="s-subtitle">Заказы · ${r.label} <small>оплачено по каждому</small></span>${orderButtons(r.orders)}</div></td></tr>`
        : ''
    }`,
      )
      .join('')}
    </tbody><tfoot><tr><th scope="row">Всего</th><td>—<small>расходы неполные</small></td><td>${leads.length}</td><td data-total="orders">${db.orders.length}</td><td class="s-paid" data-total="paid">${money(db.orders.reduce((s, o) => s + simplePaid(db, o.id), 0))}</td></tr></tfoot></table></div>
    <div class="s-scroll-hint">Прокрутите таблицу вправо, чтобы увидеть все показатели →</div><div class="s-footnote">Обращения и заказы созданы 25–31 августа. Оплаты этих заказов — по 9 сентября, включая более поздние платежи. Обращения и заказы — самостоятельные количества, не этапы одной воронки.</div>
    <details class="s-method"><summary>Как считаются цифры</summary><p>Источник берётся из заказа. Переписка необязательна. У заказа одно объявление или «Без объявления», поэтому его оплаты попадают ровно в одну строку. Сумма заказа не считается оплатой.</p><p>Обращения считаются по источнику входящего сообщения. Одно обращение может дать несколько заказов, а заказ — существовать без обращения. Расходы — на рекламу за 25–31 августа; прочерк означает отсутствие данных, 0 ₽ — известный ноль. Данные VK получены с задержкой. ROMI и конверсию из этих разнородных количеств не рассчитываем.</p></details></section>`;
}
function inquiryList() {
  return `<section class="s-card"><div class="s-section"><div><h2>Обращения</h2><p>Создайте заказ или выберите существующий — источник перенесётся автоматически.</p></div></div><div class="s-inquiries">${leads
    .map((l) => {
      const linked = db.links
        .filter((x) => x.lead === l.id)
        .map((x) => db.orders.find((o) => o.id === x.order));
      return `<article class="s-inquiry" data-inquiry="${l.id}"><div class="s-inquiry-top"><span class="s-avatar">${esc(name(l.customer).slice(0, 1))}</span><div><h3>${esc(name(l.customer))}</h3><p>${sources[l.source]} · ${l.id} · ${l.date.slice(8)} августа</p></div><span class="s-tag">${linked.length ? 'Есть заказ' : l.status}</span></div><p class="s-ad-caption">${esc(adName(l.ad))}</p><div class="s-inquiry-actions">${button('＋ Создать заказ', 'create', l.id, 's-primary')}${button('Связать с существующим', 'link', l.id)}</div>${linked.length ? `<div class="s-linked">${linked.map((o) => button('Заказ № ' + o.id + ' ↗', 'order', o.id)).join('')}</div>` : ''}</article>`;
    })
    .join('')}</div></section>`;
}
function orderList() {
  const rows = db.orders.filter(
    (o) => ui.filter === 'all' || o.source === ui.filter,
  );
  return `<section class="s-card"><div class="s-section"><div><h2>Заказы</h2><p>Для старых заказов достаточно указать источник. Искать переписку не нужно.</p></div><label class="s-filter">Источник<select id="s-filter"><option value="all">Все источники</option>${options(ui.filter)}</select></label></div><div class="s-bulk"><span>Выбрано: <b>${ui.selected.size}</b></span><label>Назначить источник<select id="s-bulk-source">${options(ui.bulk)}</select></label><button data-s="bulk" class="s-primary" ${!ui.selected.size ? 'disabled' : ''}>Применить к ${ui.selected.size} заказам</button></div>
    <div class="s-orders">${rows.map((o) => `<div class="s-order-row"><input type="checkbox" aria-label="Выбрать заказ ${o.id}" data-check="${o.id}" ${ui.selected.has(o.id) ? 'checked' : ''}><button data-s="order" data-v="${o.id}"><span><b>№ ${o.id}</b> · ${esc(name(o.customer))}</span><small>${o.date.slice(8)} августа · ${o.status}</small></button><span class="s-tag ${o.source === 'unknown' ? 's-warn' : ''}">${sources[o.source]}</span><div>${money(o.amount)}<small>оплачено ${money(simplePaid(db, o.id))}</small></div></div>`).join('') || '<div class="s-empty">Заказов с этим источником нет.</div>'}</div></section>`;
}
function drawer() {
  if (ui.form) {
    const l = leads.find((l) => l.id === ui.lead),
      target = db.orders.find((o) => o.id === ui.target);
    return `<aside class="s-drawer" aria-label="${ui.form === 'create' ? 'Создание заказа' : 'Связывание заказа'}"><div class="s-drawer-head"><span class="s-eyebrow">ОБРАЩЕНИЕ ${l.id}</span>${button('Закрыть', 'close')}</div><h2>${ui.form === 'create' ? 'Новый заказ' : 'Связать с заказом'}</h2><p>${esc(name(l.customer))}</p><div class="s-transfer"><small>Источник и объявление из обращения</small><b>${sources[l.source]}</b><span>${esc(adName(l.ad))}</span></div>
    <form id="s-form">${ui.form === 'create' ? `<label>Сумма заказа, ₽<input id="s-amount" name="amount" inputmode="decimal" required placeholder="Например, 15000" autocomplete="off"></label><p class="s-muted">Дата в демо — 31 августа. Оплата не создаётся.</p>` : `<label>Выберите существующий заказ<select id="s-target" name="target" required><option value="">Выберите заказ</option>${db.orders.map((o) => `<option value="${o.id}" ${o.id === ui.target ? 'selected' : ''}>№ ${o.id} · ${esc(name(o.customer))} · ${money(o.amount)}</option>`).join('')}</select></label>${target ? `<div class="s-review"><b>После связывания</b><p>Источник заказа: ${sources[target.source]} → ${sources[l.source]}</p><p>Объявление: ${esc(adName(target.ad))} → ${esc(adName(l.ad))}</p><small>Сумма и оплаты сохранятся. Существующие переписки останутся связанными.</small></div>` : '<p class="s-muted">Покажем, как изменится источник выбранного заказа.</p>'}`}
    <button type="submit" class="s-primary" ${ui.form === 'link' && !target ? 'disabled' : ''}>${ui.form === 'create' ? 'Создать заказ' : 'Связать и перенести источник'}</button>${button('Отмена', 'close')}</form></aside>`;
  }
  const o = db.orders.find((o) => o.id === ui.order);
  if (!o) return '';
  const linked = db.links.filter((x) => x.order === o.id);
  return `<aside class="s-drawer" aria-label="Карточка заказа"><div class="s-drawer-head"><span class="s-eyebrow">ЗАКАЗ</span>${button('Закрыть', 'close')}</div><h2>№ ${o.id}</h2><p>${esc(name(o.customer))}</p><span class="s-tag">${o.status}</span><div class="s-order-money"><div><small>Сумма заказа</small><b>${money(o.amount)}</b></div><div><small>Оплачено</small><b>${money(simplePaid(db, o.id))}</b></div></div>
    <form id="s-order-form"><label>Источник заказа<select id="s-order-source" name="source">${options(o.source)}</select></label><button type="submit" class="s-primary">Сохранить источник</button></form><p class="s-muted">При смене источника объявление сбрасывается. Переписка остаётся в истории.</p><div class="s-transfer"><small>Объявление</small><span>${esc(adName(o.ad))}</span></div><h3>Связанные обращения · ${linked.length}</h3>${
      linked.length
        ? linked
            .map((x) => {
              const l = leads.find((l) => l.id === x.lead);
              return `<p class="s-conversation">${x.lead} · ${sources[l.source]}<small>${esc(adName(l.ad))}</small></p>`;
            })
            .join('')
        : '<p class="s-muted">Переписка не связана. Заказ уже учтён в аналитике по своему источнику.</p>'
    }<h3>Платежи</h3>${
      db.payments
        .filter((p) => p.order === o.id)
        .map(
          (p) =>
            `<div class="s-payment"><span>${p.date.split('-').reverse().join('.')}</span><b>${money(p.amount)}</b></div>`,
        )
        .join('') || '<p class="s-muted">Оплат пока нет.</p>'
    }</aside>`;
}

function render() {
  const focus = document.activeElement;
  const focusId = focus?.id,
    action = focus?.dataset.s,
    value = focus?.dataset.v,
    check = focus?.dataset.check;
  const unknown = db.orders.filter((o) => o.source === 'unknown').length;
  const panel = drawer();
  host.innerHTML = `<main class="simple"><header class="s-top"><a class="s-brand" href="#concept=simple"><span>м</span>мастерская <small>/ аналитика</small></a><div><span class="s-demo">ДЕМО · ВЫМЫШЛЕННЫЕ ДАННЫЕ</span>${button('Начать заново', 'reset')}</div></header><div class="s-heading"><div><span class="s-eyebrow">ЭКОНОМИКА + РАБОЧЕЕ МЕСТО</span><h1>Откуда приходят заказы</h1><p>Укажите источник. Всё остальное соберётся в одной таблице.</p></div><div class="s-period">25–31 августа 2026<small>оплаты по 9 сентября</small></div></div><nav class="s-tabs" aria-label="Разделы упрощённого демо">${[
    ['analytics', 'Аналитика'],
    ['inquiries', 'Обращения'],
    ['orders', 'Заказы'],
  ]
    .map(
      ([id, label]) =>
        `<button data-s="tab" data-v="${id}" aria-current="${ui.tab === id ? 'page' : 'false'}" class="${ui.tab === id ? 'active' : ''}">${label}<span>${id === 'inquiries' ? leads.length : id === 'orders' ? db.orders.length : ''}</span></button>`,
    )
    .join('')}</nav>
    ${unknown ? `<div class="s-nudge"><span><b>${unknown} заказа без источника</b> — их оплаты уже видны в строке «Не указан».</span>${button('Указать источники →', 'unmarked')}</div>` : '<div class="s-nudge s-done">✓ У всех заказов указан источник</div>'}
    <div class="s-status" role="status"><span>${esc(ui.notice)}</span>${undo ? button('Отменить изменение', 'undo') : ''}</div><div class="s-workspace ${panel ? 'has-drawer' : ''}"><div class="s-content">${ui.tab === 'analytics' ? analytics() : ui.tab === 'inquiries' ? inquiryList() : orderList()}</div>${panel}</div><footer class="s-footer"><span>Локальное демо. Изменения хранятся до перезагрузки страницы.</span><a href="#concept=hybrid&source=all">Предыдущий вариант ↗</a></footer></main>`;
  const root = host.querySelector('.simple');
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('submit', onSubmit);
  const restore = focusId
    ? root.querySelector('#' + focusId)
    : check
      ? root.querySelector(`[data-check="${check}"]`)
      : action
        ? [...root.querySelectorAll('[data-s]')].find(
            (x) => x.dataset.s === action && x.dataset.v === value,
          )
        : null;
  restore?.focus({ preventScroll: true });
}
function onClick(event) {
  const b = event.target.closest('[data-s]');
  if (!b) return;
  if (b.closest('form')) event.preventDefault();
  const action = b.dataset.s,
    value = b.dataset.v;
  if (action === 'tab') {
    ui.tab = value;
    ui.order = null;
    ui.form = null;
    ui.selected.clear();
  }
  if (action === 'expand') {
    if (ui.expanded.has(value)) ui.expanded.delete(value);
    else ui.expanded.add(value);
  }
  if (action === 'sort') {
    ui.descending = ui.sort === value ? !ui.descending : true;
    ui.sort = value;
  }
  if (action === 'order') {
    ui.order = value;
    ui.form = null;
  }
  if (action === 'close') {
    ui.order = null;
    ui.form = null;
  }
  if (action === 'create' || action === 'link') {
    ui.lead = value;
    ui.form = action;
    ui.target = '';
    ui.order = null;
  }
  if (action === 'unmarked') {
    ui.tab = 'orders';
    ui.filter = 'unknown';
    ui.selected.clear();
    ui.order = null;
    ui.form = null;
  }
  if (action === 'bulk' && ui.selected.size)
    save(
      simpleAssign(db, [...ui.selected], ui.bulk),
      `Источник «${sources[ui.bulk]}» назначен: ${ui.selected.size} заказам.`,
    );
  if (action === 'undo' && undo) {
    db = undo;
    undo = null;
    ui.order = null;
    ui.form = null;
    ui.selected.clear();
    ui.notice = 'Последнее изменение отменено.';
  }
  if (action === 'reset') {
    undo = db;
    db = simpleSeed();
    ui = {
      ...ui,
      tab: 'analytics',
      expanded: new Set(['avito']),
      selected: new Set(),
      order: null,
      form: null,
      filter: 'all',
      notice: 'Начальные данные восстановлены.',
    };
  }
  render();
  if (['order', 'create', 'link'].includes(action)) {
    const panel = host.querySelector('.s-drawer');
    panel?.scrollIntoView({ block: 'nearest' });
    panel?.querySelector('input,select,button')?.focus({ preventScroll: true });
  }
}
function onChange(event) {
  const el = event.target;
  if (el.dataset.check) {
    if (el.checked) ui.selected.add(el.dataset.check);
    else ui.selected.delete(el.dataset.check);
  } else if (el.id === 's-filter') {
    ui.filter = el.value;
    ui.selected.clear();
  } else if (el.id === 's-bulk-source') ui.bulk = el.value;
  else if (el.id === 's-target') ui.target = el.value;
  else return;
  render();
}
function onSubmit(event) {
  event.preventDefault();
  const form = event.target;
  try {
    if (form.id === 's-order-form')
      save(
        simpleAssign(db, [ui.order], new FormData(form).get('source')),
        'Источник заказа сохранён.',
      );
    if (form.id === 's-form' && ui.form === 'create') {
      const next = simpleCreate(db, ui.lead, new FormData(form).get('amount'));
      ui.order = next.orders.at(-1).id;
      save(
        next,
        `Заказ № ${ui.order} создан; источник и объявление перенесены.`,
      );
    } else if (form.id === 's-form' && ui.form === 'link') {
      ui.order = ui.target;
      save(
        simpleLink(db, ui.lead, ui.target),
        'Обращение связано с заказом; источник и объявление перенесены.',
      );
    }
    render();
  } catch (error) {
    ui.notice = error.message;
    const status = host.querySelector('.s-status span');
    status.textContent = error.message;
  }
}
export function mountSimple(app) {
  host = app;
  document.title = 'Откуда приходят заказы · Мастерская · Демо';
  render();
}
