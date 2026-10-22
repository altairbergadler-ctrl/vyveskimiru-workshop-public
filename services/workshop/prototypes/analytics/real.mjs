import { realModel, realSlice, realRows } from './real-model.mjs';
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
const number = (v) =>
  v == null
    ? '—'
    : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(v);
const money = (v) =>
  v == null
    ? '—'
    : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(
        v / 100,
      ) + ' ₽';
const date = (v) =>
  v ? String(v).slice(0, 10).split('-').reverse().join('.') : '—';
const btn = (text, a, v = '') =>
  `<button class="${a === 'mode' && ui.mode === v ? 'active' : ''}" data-r="${a}" data-value="${esc(v)}">${text}</button>`;
const ui = {
  tab: 'source',
  product: 'all',
  query: '',
  selected: null,
  compare: [],
  sort: 'spend',
  desc: true,
  page: 1,
  mode: 'ads',
  error: '',
  busy: false,
  authenticated: false,
};
let model = null,
  host = null,
  started = false;
const filter = () => ({ product: ui.product, query: ui.query });
async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    signal: AbortSignal.timeout(45000),
    ...options,
    headers: { Accept: 'application/json', ...options.headers },
  });
  const value = await response.json();
  if (response.status === 401) {
    ui.authenticated = false;
    model = null;
    throw new Error(
      options.method === 'POST'
        ? 'Неверный PIN. Попробуйте ещё раз.'
        : 'Войдите в Мастерскую для просмотра данных.',
    );
  }
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? 'Слишком много попыток. Подождите и повторите.'
        : 'Источник временно недоступен. Повторите загрузку.',
    );
  return value;
}
async function load(period = null) {
  if (ui.busy) return;
  ui.busy = true;
  ui.error = '';
  render();
  try {
    const session = await request('/api/session');
    ui.authenticated = session.authenticated === true;
    if (!ui.authenticated) {
      model = null;
      return;
    }
    const qs = period
      ? '?' + new URLSearchParams({ dateFrom: period.from, dateTo: period.to })
      : '';
    const ads = await request('/api/analytics/avito/deep' + qs);
    const from = ads.period?.dateFrom,
      to = ads.period?.dateTo;
    if (!from || !to)
      throw new Error('Не удалось определить период статистики Авито.');
    const dates = new URLSearchParams({ from, to });
    const results = await Promise.allSettled([
      request('/api/analytics/overview?' + dates),
      request('/api/analytics/inquiries?' + dates),
      request('/api/analytics/products'),
    ]);
    if (!ui.authenticated) {
      model = null;
      return;
    }
    model = realModel(
      ads,
      results[0].status === 'fulfilled' ? results[0].value : null,
      results[1].status === 'fulfilled' ? results[1].value : null,
      results[2].status === 'fulfilled' ? results[2].value : null,
    );
    model.errors = results.flatMap((r, i) =>
      r.status === 'rejected'
        ? [
            [
              'Заказы не загрузились.',
              'Диалоги не загрузились.',
              'Список продукции не загрузился.',
            ][i],
          ]
        : [],
    );
    if (
      !model.catalogAvailable &&
      !model.errors.includes('Список продукции не загрузился.')
    )
      model.errors.push('Список продукции не загрузился.');
    if (ui.product !== 'all' && !Object.hasOwn(model.products, ui.product))
      ui.product = 'all';
    ui.selected = null;
    ui.compare = [];
    ui.page = 1;
  } catch (error) {
    ui.error = error.message;
    model = null;
  } finally {
    ui.busy = false;
    render();
  }
}
function shell(content) {
  return `<main class="simple performance real-performance"><header class="s-top"><a class="s-brand" href="/"><span>м</span>мастерская <small>/ аналитика</small></a><span class="s-demo">РАБОЧИЕ ДАННЫЕ · ЗАЩИЩЁННЫЙ ПРОСМОТР</span></header>${content}<footer class="s-footer"><span>Данные загружаются из рабочих отчётов после входа. Изменений в Google и рекламе нет.</span><a href="/">В Мастерскую ↗</a></footer></main>`;
}
function funnel(v, label) {
  const orderMode = ui.mode === 'orders',
    values = orderMode ? v.orderFunnel : v.salesFunnel;
  const names = orderMode
    ? ['Заказы в периоде', 'Есть оплата', 'Оплачены полностью']
    : [
        'Новые диалоги',
        'Целевые',
        'Расчёт отправлен',
        'Заказ из рекламы',
        'Есть оплата',
      ];
  return `<section class="s-card p-funnel"><div class="p-section-head"><div><span class="s-eyebrow">${orderMode ? 'ОПЛАТА ЗАКАЗОВ' : 'ВОРОНКА ПРОДАЖ'}</span><h2>${esc(label)}</h2></div><div class="p-segment">${btn('Обращения', 'mode', 'ads')}${btn('Заказы', 'mode', 'orders')}</div></div><div class="p-stages ${orderMode ? 'r-three' : ''}">${names.map((name, i) => `<div class="p-stage"><button data-r="detail" data-value="${orderMode ? 'orders' : 'dialogs'}" ${values[i] == null ? 'disabled' : ' '}><span class="p-stage-title">${name}</span><b>${number(values[i])}</b><small>${values[i] == null ? 'Нет подтверждённых данных' : orderMode ? 'заказов' : 'диалогов создано в периоде'}</small></button></div>`).join('')}</div><div class="p-funnel-foot">${orderMode ? 'Заказы по дате создания. Оплаты накоплены к моменту чтения Google; это не выручка периода.' : 'Целевые заявки, отправленные расчёты и подтверждённые связи с заказами пока не ведутся. Предположения не превращаем в продажи.'}</div>${orderMode ? '' : `<div class="p-coverage">Диалоги — созданные в периоде беседы с наблюдаемыми входящими сообщениями. Они не равны контактам Авито или уникальным клиентам. Импорт может быть неполным.</div>`}</section>`;
}
function dashboard() {
  const products = model.products;
  const rows = realRows(model, ui.tab, filter());
  const chosen = rows.find((r) => r.id === ui.selected),
    total = realSlice(model, filter());
  if (ui.tab === 'ad')
    Object.assign(total, {
      orders: [],
      paid: null,
      businessVisible: false,
      orderFunnel: [null, null, null],
    });
  const v = chosen || total;
  const label = chosen?.label || 'Все в выбранном срезе';
  const allOrders = realSlice(model, { product: ui.product });
  const value = (r, k) =>
    k === 'orders'
      ? r.businessVisible && r.ordersAvailable
        ? r.orders.length
        : null
      : r[k];
  rows.sort((a, b) => {
    const x = value(a, ui.sort),
      y = value(b, ui.sort);
    return x == null
      ? y == null
        ? 0
        : 1
      : y == null
        ? -1
        : (x - y) * (ui.desc ? -1 : 1);
  });
  const pageRows = rows.slice((ui.page - 1) * 20, ui.page * 20);
  const fields =
    ui.mode === 'orders'
      ? [
          ['orders', 'Заказы'],
          ['paid', 'Оплачено'],
          ['attributedOrders', 'Из рекламы'],
          ['cpo', 'Цена заказа'],
        ]
      : [
          ['views', 'Просмотры'],
          ['contacts', 'Контакты Авито'],
          ['spend', 'Расходы'],
          ['costContact', 'Цена контакта'],
        ];
  const format = (r, k) =>
    r[k] == null && r.known?.[k] != null
      ? (k === 'spend' ? money(r.known[k]) : number(r.known[k])) + ' *'
      : k === 'orders'
        ? r.businessVisible && r.ordersAvailable
          ? number(r.orders.length)
          : '—'
        : ['spend', 'paid', 'costContact', 'cpo'].includes(k)
          ? money(r[k])
          : number(r[k]);
  return `<div class="s-heading"><div><span class="s-eyebrow">РЕКЛАМА И ПРОДАЖИ</span><h1>Ваши данные</h1><p>Авито + Google Таблица. Без учебных заказов и вымышленных оплат.</p></div><div class="s-period">${date(model.period.from)} — ${date(model.period.to)}<small>Авито обновлено ${date(model.loadedAt)}</small></div></div><nav class="s-tabs">${[
    ['source', 'Источники'],
    ['ad', 'Объявления'],
    ['product', 'Продукция'],
  ]
    .map(
      ([id, l]) =>
        `<button class="${ui.tab === id ? 'active' : ''}" data-r="tab" data-value="${id}">${l}</button>`,
    )
    .join('')}</nav>
    <div class="p-filters"><label>Период<select id="r-period">${[{ ...model.period }, ...model.periods.filter((p) => p.from !== model.period.from || p.to !== model.period.to)].map((p) => `<option value="${p.from}|${p.to}">${date(p.from)} — ${date(p.to)}</option>`).join('')}</select></label><label>Продукция<select id="r-product"><option value="all">Все виды</option>${Object.entries(
      products,
    )
      .map(
        ([id, l]) =>
          `<option value="${esc(id)}" ${ui.product === id ? 'selected' : ''}>${esc(l)}</option>`,
      )
      .join(
        '',
      )}</select></label><form id="r-search"><label>Поиск объявления<input name="query" value="${esc(ui.query)}" placeholder="Название объявления"></label><button type="submit">Найти</button></form>${btn(ui.busy ? 'Загружаю…' : 'Обновить', 'refresh')}</div>
    <div class="r-notice"><b>Рекламу и продажи пока нельзя связать достоверно.</b> Расходы, просмотры и контакты — реальные. Заказы и оплаты мастерской показаны отдельно; подтверждённой выручки по объявлениям пока нет.</div>${model.stale || model.ordersStale || model.errors.length ? `<div class="r-notice r-warning">${model.stale ? 'Статистика Авито устарела или импорт не завершён. ' : ''}${model.ordersStale ? 'Заказы показаны из последнего успешного чтения. ' : ''}${model.errors.join(' ')}</div>` : ''}
    <div class="r-business"><span>Заказы мастерской в периоде <b>${model.ordersAvailable ? number(allOrders.orders.length) : '—'}</b></span><span>Оплачено по этим заказам <b>${money(allOrders.paid)}</b></span><small>Источник клиента не считается источником конкретного заказа. Отменённые заказы исключены.</small></div>
    ${funnel(v, label)}
    <section class="s-card p-table-card"><div class="p-section-head"><div><h2>${{ source: 'Источники рекламы', ad: 'Объявления Авито', product: 'По видам продукции' }[ui.tab]} · ${rows.length}</h2><p>${ui.tab === 'product' ? 'Виды из «Производство → Продукты и маршруты», включая новые без заказов. Заказы связаны по выбранному маршруту; старые позиции — по точному названию.' : 'Нажмите строку для детализации. Другие рекламные площадки пока не подключены.'}</p></div><div class="p-segment">${btn('Реклама', 'mode', 'ads')}${btn('Заказы', 'mode', 'orders')}</div></div><div class="p-table-scroll"><table class="p-table"><thead><tr><th>Название</th>${fields.map(([k, l]) => `<th>${btn(l + ' ↕', 'sort', k)}</th>`).join('')}</tr></thead><tbody>${pageRows.map((r) => `<tr data-real-row="${esc(r.id)}" class="${ui.selected === r.id ? 'p-selected' : ''}"><th><div class="r-row-name"><input type="checkbox" data-rcompare="${esc(r.id)}" aria-label="Сравнить ${esc(r.label)}" ${ui.compare.includes(r.id) ? 'checked' : ui.compare.length >= 3 ? 'disabled' : ''}><button class="p-name" data-r="select" data-value="${esc(r.id)}"><b>${esc(r.label)}</b><small>${r.product ? esc(products[r.product]) : `${r.ads.length} объявлений`}</small></button></div></th>${fields.map(([k, l]) => `<td data-label="${l}" data-real-metric="${k}">${format(r, k)}</td>`).join('')}</tr>`).join('') || '<tr><td colspan="5">Нет данных для выбранных фильтров.</td></tr>'}</tbody><tfoot><tr><th>Итого по фильтру</th>${fields.map(([k, l]) => `<td data-label="${l}">${format(total, k)}</td>`).join('')}</tr></tfoot></table></div><div class="r-pager">${ui.page > 1 ? btn('← Назад', 'page', String(ui.page - 1)) : ''}<span>${ui.page} / ${Math.max(1, Math.ceil(rows.length / 20))}</span>${ui.page * 20 < rows.length ? btn('Дальше →', 'page', String(ui.page + 1)) : ''}</div><div class="p-table-note">${ui.mode === 'orders' ? 'Виды продукции описывают заказы мастерской, а не доказанный эффект рекламы. Оплаты заказов с несколькими видами целиком остаются в строке «Несколько видов».' : 'Цена контакта = расходы Авито / контакты Авито. Это не цена заявки или заказа. * — сумма доступной статистики; часть объявлений без данных. Прочерк — статистики нет; 0 — подтверждённый ноль.'}</div></section>
    ${
      ui.compare.length
        ? `<section class="s-card p-compare"><div class="p-section-head"><div><h2>Сравнение · ${ui.compare.length} из 3</h2><p>Один период и одинаковые показатели. Выбирайте строки флажками.</p></div>${btn('Очистить', 'clear-compare')}</div><div class="p-compare-grid" style="--count:${ui.compare.length}">${rows
            .filter((r) => ui.compare.includes(r.id))
            .map(
              (r) =>
                `<article><h3>${esc(r.label)}</h3>${fields.map(([k, l]) => `<div><span>${l}</span><b>${format(r, k)}</b></div>`).join('')}</article>`,
            )
            .join('')}</div></section>`
        : ''
    }
    ${ui.selected ? details(v, label) : ''}<details class="s-card p-method"><summary>Что уже известно и чего не хватает</summary><p>Рабочие отчёты доступны после входа. Источник расходов — Авито; Google — источник сумм заказов и накопленных оплат. Деньги по предполагаемым совпадениям переписки исключены.</p><p>Список продукции общий с разделом «Продукты и маршруты». Обновите данные после добавления нового вида. Новые позиции связаны с выбранным маршрутом; старые — только по однозначному точному названию. Объявления пока показаны без привязки: совпадение названия не считается назначением продукции. Составные заказы остаются в «Несколько видов».</p><p>Для полной воронки нужны отметки «целевая», «расчёт отправлен», подтверждённый источник/объявление заказа. Тогда можно будет посчитать цену заказа и окупаемость. Сейчас прочерк честнее придуманной конверсии.</p><p>Импортировано диалогов: ${number(model.dialogCoverage?.loadedDialogs)}; с входящими: ${number(model.dialogCoverage?.dialogsWithIncoming)}. Диалоги с ограниченной историей: ${number(model.dialogCoverage?.truncatedDialogs)}. Статистика отсутствует у ${number(model.coverage?.withoutStats)} объявлений.</p></details>`;
}
function details(v, label) {
  return `<section id="r-details" class="s-card p-details"><div class="p-section-head"><h2>${esc(label)}</h2>${btn('Закрыть', 'close')}</div><div class="p-detail-grid"><div><h3>Новые диалоги · ${model.dialogsAvailable ? v.dialogs.length : '—'}</h3><div class="p-lead-list">${v.dialogs.map((d) => `<div class="p-lead"><b>Диалог …${esc(d.id.slice(-8))}</b><small>${date(d.date)}${d.limited ? ' · история ограничена' : ''}</small></div>`).join('') || '<p class="p-empty">Нет загруженных новых диалогов в этом срезе.</p>'}</div></div><div><h3>Заказы мастерской</h3><div class="p-order-list">${v.businessVisible ? v.orders.map((o) => `<div class="p-order"><span><b>№ ${esc(o.id)} · ${esc(o.title)}</b><small>${date(o.date)} · ${esc(o.status)}</small></span><span>${money(o.paid)}<small>оплачено из ${money(o.amount)}</small></span></div>`).join('') || '<p class="p-empty">Заказов в этом срезе нет или источник не загрузился.</p>' : '<p class="p-empty">Подтверждённых связей этого объявления с заказами пока нет. Предполагаемые совпадения не используются.</p>'}</div></div></div></section>`;
}
function render() {
  if (!host) return;
  let content;
  if (!ui.authenticated)
    content = `<section class="s-card r-login"><span class="s-eyebrow">ДАННЫЕ МАСТЕРСКОЙ</span><h1>Войдите для просмотра</h1><p>Используйте обычный PIN Мастерской. Рабочие заказы и оплаты доступны только после входа.</p><form id="r-login"><label>PIN<input type="password" name="pin" autocomplete="current-password" inputmode="numeric" required maxlength="64"></label><button class="s-primary" type="submit" ${ui.busy ? 'disabled' : ''}>${ui.busy ? 'Проверяю…' : 'Войти'}</button></form><p role="alert">${esc(ui.error)}</p></section>`;
  else if (!model)
    content = `<section class="s-card r-login"><h2>${ui.busy ? 'Загружаю ваши данные…' : 'Данные не загрузились'}</h2><p role="alert">${esc(ui.error)}</p>${!ui.busy ? btn('Повторить', 'refresh') : ''}</section>`;
  else content = dashboard();
  host.innerHTML = shell(content);
  const root = host.querySelector('.real-performance');
  root.addEventListener('click', click);
  root.addEventListener('change', change);
  root.addEventListener('submit', submit);
}
function reset() {
  ui.selected = null;
  ui.compare = [];
  ui.page = 1;
}
function click(event) {
  const b = event.target.closest('[data-r]');
  if (!b) return;
  const a = b.dataset.r,
    v = b.dataset.value;
  if (a === 'refresh') {
    void load(model?.period);
    return;
  }
  if (a === 'tab') {
    ui.tab = v;
    ui.query = '';
    reset();
  }
  if (a === 'mode') ui.mode = v;
  if (a === 'select') ui.selected = ui.selected === v ? null : v;
  if (a === 'close') ui.selected = null;
  if (a === 'clear-compare') ui.compare = [];
  if (a === 'sort') {
    ui.desc = ui.sort === v ? !ui.desc : v !== 'costContact';
    ui.sort = v;
  }
  if (a === 'page') ui.page = Number(v);
  if (a === 'detail' && !ui.selected) ui.selected = 'all';
  render();
  if (a === 'select')
    host.querySelector('.p-funnel')?.scrollIntoView({ block: 'start' });
  if (a === 'detail')
    host.querySelector('#r-details')?.scrollIntoView({ block: 'start' });
}
function change(event) {
  const e = event.target;
  if (e.hasAttribute('data-rcompare')) {
    const id = e.getAttribute('data-rcompare');
    ui.compare = e.checked
      ? [...ui.compare, id].slice(0, 3)
      : ui.compare.filter((v) => v !== id);
    render();
  }
  if (e.id === 'r-product') {
    ui.product = e.value;
    reset();
    render();
  }
  if (e.id === 'r-period') {
    const [from, to] = e.value.split('|');
    void load({ from, to });
  }
}
async function submit(event) {
  event.preventDefault();
  const form = event.target;
  if (form.id === 'r-search') {
    const field = new FormData(form).get('query');
    ui.query = typeof field === 'string' ? field.trim() : '';
    reset();
    render();
    return;
  }
  if (form.id !== 'r-login' || ui.busy) return;
  const pinField = new FormData(form).get('pin');
  const pin = typeof pinField === 'string' ? pinField : '';
  ui.busy = true;
  ui.error = '';
  render();
  try {
    await request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    ui.authenticated = true;
  } catch (e) {
    ui.error = e.message;
  } finally {
    ui.busy = false;
  }
  if (ui.authenticated) await load();
  else render();
}
export function mountReal(app) {
  host = app;
  document.title = 'Ваши данные · Аналитика Мастерской';
  render();
  if (!started) {
    started = true;
    void load();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && ui.authenticated)
        void request('/api/session')
          .then((s) => {
            if (!s.authenticated) {
              model = null;
              ui.authenticated = false;
              render();
            }
          })
          .catch(() => {
            model = null;
            ui.authenticated = false;
            render();
          });
    });
  }
}
