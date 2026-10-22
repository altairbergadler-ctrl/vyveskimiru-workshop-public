import {
  performanceSources as sources,
  products,
  stages,
  performanceAds as ads,
  performanceOrders as orders,
  performanceSlice as slice,
  performanceRows as rows,
  performanceSort as sort,
  performanceStageRows as stageRows,
} from './performance-model.mjs';
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
const num = (v) =>
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(v);
const money = (v) =>
  v == null
    ? '—'
    : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(
        v / 100,
      ) + ' ₽';
const percent = (v) => (v == null ? '—' : num(v) + '%');
const metric = (r, k) =>
  k === 'leads' || k === 'orders'
    ? r[k].length
    : k === 'cr'
      ? percent(r[k])
      : k === 'payback'
        ? r[k] == null
          ? '—'
          : num(r[k]) + '×'
        : money(r[k]);
const btn = (label, action, value = '', cls = '') =>
  `<button class="${cls}" data-p="${action}" data-value="${esc(value)}">${label}</button>`;
const opts = (catalog, selected) =>
  Object.entries(catalog)
    .map(
      ([id, label]) =>
        `<option value="${id}" ${id === selected ? 'selected' : ''}>${esc(label)}</option>`,
    )
    .join('');
const labels = { source: 'Источники', ad: 'Объявления', product: 'Продукция' };
const ui = {
  tab: 'source',
  source: 'all',
  product: 'all',
  selected: null,
  expanded: new Set(['avito']),
  metricSet: 'result',
  sort: 'paid',
  desc: true,
  compare: [],
  stage: null,
  drop: false,
  order: null,
  notice: '',
};
let host;
const filters = () => ({ source: ui.source, product: ui.product });
const columns = () =>
  ui.metricSet === 'result'
    ? [
        ['spend', 'Расходы'],
        ['leads', 'Заявки'],
        ['orders', 'Заказы'],
        ['cr', 'В заказ'],
        ['paid', 'Оплачено'],
      ]
    : [
        ['spend', 'Расходы'],
        ['cpl', 'Цена заявки'],
        ['cpo', 'Цена заказа'],
        ['cr', 'В заказ'],
        ['payback', 'Оплаты / расход'],
      ];
function current() {
  const all = rows(ui.tab, filters());
  const selected = all.find((r) => r.id === ui.selected);
  return {
    all,
    selected,
    view: selected || slice(filters()),
    label: selected?.label || 'Все в выбранном срезе',
  };
}
function funnel(view, label) {
  const total = view.funnel[0];
  return `<section class="p-funnel s-card"><div class="p-section-head"><div><span class="s-eyebrow">ВОРОНКА ПРОДАЖ</span><h2>${esc(label)}</h2></div>${ui.selected ? btn('Весь срез', 'clear-selected') : ''}</div><div class="p-stages">${stages
    .map((stage, i) => {
      const n = view.funnel[i],
        previous = i ? view.funnel[i - 1] : total;
      return `<div class="p-stage"><button data-p="stage" data-value="${i}" aria-pressed="${ui.stage === i && !ui.drop}"><span class="p-stage-title">${i + 1}. ${stage}</span><b data-stage-count="${i}">${n}</b><span class="p-stage-track"><i style="width:${total ? (n / total) * 100 : 0}%"></i></span><small>${i ? percent(previous ? (n / previous) * 100 : null) + ' с предыдущего этапа' : total ? '100% заявок среза' : 'Нет заявок'}</small></button>${i < 4 ? btn(`Не перешли: ${n - view.funnel[i + 1]} ↓`, 'drop', String(i), 'p-drop') : '<span class="p-drop-note">Любая положительная оплата</span>'}</div>`;
    })
    .join(
      '',
    )}</div><div class="p-funnel-foot"><span>Считаем заявки, дошедшие до этапа. Нажмите этап или переход для разбора.</span><b>Заявка → заказ: ${percent(view.cr)}</b></div>${view.unlinked.length ? `<div class="p-coverage">Ещё ${view.unlinked.length} заказа без заявки учтены в суммах, но не входят в воронку.</div>` : ''}${view.spend == null && view.ads.length ? `<div class="p-coverage">Расходы неполные: известно ${money(view.knownSpend)}. Стоимость заявки, заказа и отношение оплат к расходам пока не рассчитаны.</div>` : ''}</section>`;
}
function tableRow(r, child = false) {
  const meta = ui.tab === 'ad' || child ? ads.find((a) => a.id === r.id) : null;
  const expanded = ui.expanded.has(r.id);
  return `<tr data-performance-row="${r.id}" class="${child ? 'p-child ' : ''}${ui.selected === r.id && !child ? 'p-selected' : ''}"><th scope="row"><div class="p-row-name">${!child ? `<input type="checkbox" data-pcompare="${r.id}" aria-label="Сравнить ${esc(r.label)}" ${ui.compare.includes(r.id) ? 'checked' : ''}>` : ''}${!child && ui.tab !== 'ad' ? `<button class="p-expand" data-p="expand" data-value="${r.id}" aria-label="Раскрыть ${esc(r.label)}" aria-expanded="${expanded}">${expanded ? '⌄' : '›'}</button>` : ''}<button class="p-name" data-p="${child ? 'open-ad' : 'select'}" data-value="${r.id}"><b>${esc(r.label)}</b><small>${meta ? `${sources[meta.source]} · ${products[meta.product]}` : r.id === 'none' ? 'Заказы учтены, объявление не указано' : `${r.ads.length} объявл. · ${r.unassigned.length} заказов без объявления`}</small></button></div></th>${columns()
    .map(
      ([k, label]) =>
        `<td data-label="${label}" data-metric="${k}" class="${k === 'paid' ? 'p-money' : ''}">${metric(r, k)}</td>`,
    )
    .join('')}</tr>`;
}
function mainTable(all) {
  return `<section class="s-card p-table-card"><div class="p-section-head"><div><h2>${labels[ui.tab]}</h2><p>${ui.tab === 'product' ? 'Какая продукция приносит заказы и сколько стоит её реклама.' : ui.tab === 'ad' ? 'Нажмите объявление — его воронка и результаты появятся выше.' : 'Общий результат по источникам. Раскройте строку до объявлений.'}</p></div><div class="p-segment" aria-label="Показатели">${btn('Результат', 'metrics', 'result', ui.metricSet === 'result' ? 'active' : '')}${btn('Стоимость', 'metrics', 'cost', ui.metricSet === 'cost' ? 'active' : '')}</div></div><div class="p-sort-mobile"><label>Сортировать<select id="p-sort">${[
    ['paid', 'Оплачено'],
    ['spend', 'Расходы'],
    ['cpo', 'Цена заказа'],
    ['cr', 'Конверсия'],
    ['leads', 'Заявки'],
  ]
    .map(
      ([k, l]) =>
        `<option value="${k}" ${ui.sort === k ? 'selected' : ''}>${l}</option>`,
    )
    .join(
      '',
    )}</select></label>${btn(ui.desc ? 'По убыванию ↓' : 'По возрастанию ↑', 'direction')}</div><div class="p-table-scroll"><table class="p-table"><thead><tr><th>${btn(ui.tab === 'ad' ? 'Объявление' : ui.tab === 'product' ? 'Вид продукции' : 'Источник', 'sort', 'label')}</th>${columns()
    .map(
      ([k, l]) =>
        `<th aria-sort="${ui.sort === k ? (ui.desc ? 'descending' : 'ascending') : 'none'}">${btn(l + (ui.sort === k ? (ui.desc ? ' ↓' : ' ↑') : ' ↕'), 'sort', k)}</th>`,
    )
    .join('')}</tr></thead><tbody>${
    sort(all, ui.sort, ui.desc)
      .map(
        (r) =>
          tableRow(r) +
          (ui.tab !== 'ad' && ui.expanded.has(r.id)
            ? sort(rows('ad', r.scope), ui.sort, ui.desc)
                .map((a) => tableRow(a, true))
                .join('')
            : ''),
      )
      .join('') ||
    '<tr><td colspan="6" class="p-empty">В этом срезе нет данных. Измените фильтры.</td></tr>'
  }</tbody><tfoot><tr><th>Итого по фильтру</th>${columns()
    .map(
      ([k, l]) =>
        `<td data-label="${l}" data-total="${k}">${metric(slice(filters()), k)}</td>`,
    )
    .join(
      '',
    )}</tr></tfoot></table></div><div class="p-table-note">${ui.metricSet === 'result' ? '«В заказ» — доля заявок, давших заказ. Оплачено — фактические учебные поступления, включая частичные.' : 'Цена заказа = расходы / заказы с известным объявлением. Оплаты / расход — отношение поступлений рекламных заказов к расходам, не прибыль.'} Прочерк — данных недостаточно.</div></section>`;
}
function comparison(all) {
  const selected = all.filter((r) => ui.compare.includes(r.id));
  if (!selected.length) return '';
  return `<section class="s-card p-compare"><div class="p-section-head"><div><h2>Сравнение · ${selected.length} из 3</h2><p>Одинаковый период и показатели. Выбирайте строки флажками.</p></div>${btn('Очистить', 'clear-compare')}</div><div class="p-compare-grid" style="--count:${selected.length}">${selected
    .map(
      (r) =>
        `<article><h3>${esc(r.label)}</h3>${[
          ['spend', 'Расходы'],
          ['leads', 'Заявки'],
          ['orders', 'Заказы'],
          ['cr', 'В заказ'],
          ['cpl', 'Цена заявки'],
          ['cpo', 'Цена заказа'],
          ['paid', 'Оплачено'],
          ['payback', 'Оплаты / расход'],
        ]
          .map(([k, l]) => `<div><span>${l}</span><b>${metric(r, k)}</b></div>`)
          .join('')}</article>`,
    )
    .join('')}</div></section>`;
}
function details(view, label) {
  const selectedOrder = orders.find((o) => o.id === ui.order);
  const list =
    ui.stage == null ? view.leads : stageRows(view, ui.stage, ui.drop);
  const lost = list.filter((l) => l.lost).length;
  return `<section class="s-card p-details" id="p-details"><div class="p-section-head"><div><span class="s-eyebrow">РАЗБОР · ${esc(label)}</span><h2>${ui.stage == null ? 'Заявки и заказы' : ui.drop ? `Не перешли: ${stages[ui.stage]} → ${stages[ui.stage + 1]}` : stages[ui.stage]} <span class="s-tag">${list.length}</span></h2><p>${ui.drop ? `Потеряно: ${lost}. Ещё в работе: ${list.length - lost}.` : 'Заявки выбранного среза; ниже — все его заказы и оплаты.'}</p></div>${ui.stage != null ? btn('Все заявки', 'all-stages') : ''}</div><div class="p-detail-grid"><div><h3>Заявки</h3><div class="p-lead-list">${
    list
      .map((l) => {
        const order = orders.find((o) => o.lead === l.id);
        return `<div class="p-lead"><div><b>${l.id} · ${esc(l.customer)}</b><small>${products[l.product]} · ${sources[l.source]} · ${l.date.slice(8)} августа</small><span class="${l.lost ? 'p-lost' : 'p-progress'}">${l.lost ? l.reason : stages[l.rank]}</span></div>${order ? btn(order.id + ' ↗', 'order', order.id) : ''}</div>`;
      })
      .join('') || '<p class="p-empty">На этом этапе заявок нет.</p>'
  }</div></div><div><h3>Заказы · ${view.orders.length}</h3><div class="p-order-list">${view.orders.map((o) => `<button class="p-order" data-p="order" data-value="${o.id}"><span><b>${o.id}</b><small>${products[o.product]}${o.lead ? '' : ' · без заявки'}</small></span><span>${money(o.paid)}<small>оплачено из ${money(o.amount)}</small></span></button>`).join('') || '<p class="p-empty">Заказов ещё нет.</p>'}</div>${selectedOrder ? `<article class="p-order-detail"><div class="p-section-head"><h3>${selectedOrder.id}</h3>${btn('Закрыть', 'close-order')}</div><p>${products[selectedOrder.product]} · ${sources[selectedOrder.source]}</p><p>${esc(ads.find((a) => a.id === selectedOrder.ad)?.title || 'Объявление не указано')}</p><div><span>Сумма заказа</span><b>${money(selectedOrder.amount)}</b></div><div><span>Оплачено</span><b>${money(selectedOrder.paid)}</b></div><div><span>Осталось оплатить</span><b>${money(selectedOrder.amount - selectedOrder.paid)}</b></div></article>` : ''}</div></div></section>`;
}
function render() {
  const focus = document.activeElement,
    focusedId = focus?.id,
    action = focus?.dataset.p,
    value = focus?.dataset.value;
  const { all, selected, view, label } = current();
  if (!selected) ui.selected = null;
  host.innerHTML = `<main class="simple performance"><header class="s-top"><a class="s-brand" href="#concept=simple"><span>м</span>мастерская <small>/ аналитика</small></a><span class="s-demo">ДЕМО · ВСЕ ДАННЫЕ ВЫМЫШЛЕНЫ</span></header><div class="s-heading"><div><span class="s-eyebrow">РЕКЛАМА И ПРОДАЖИ</span><h1>Что приводит к заказам</h1><p>Источники, объявления и продукция — от заявки до оплаты.</p></div><div class="s-period">25–31 августа 2026<small>оплаты по 9 сентября</small></div></div><nav class="s-tabs" aria-label="Разрез аналитики">${Object.entries(
    labels,
  )
    .map(([id, l]) => btn(l, 'tab', id, ui.tab === id ? 'active' : ''))
    .join(
      '',
    )}</nav><div class="p-filters"><label>Источник<select id="p-source"><option value="all">Все источники</option>${opts(sources, ui.source)}</select></label><label>Продукция<select id="p-product"><option value="all">Все виды продукции</option>${opts(products, ui.product)}</select></label>${btn('Сбросить', 'reset')}<span role="status">${esc(ui.notice)}</span></div>${funnel(view, label)}${mainTable(all)}${comparison(all)}${selected || ui.stage != null ? details(view, label) : ''}<details class="s-card p-method"><summary>Как считаем эффективность</summary><p>Воронка отслеживает одну группу заявок за 25–31 августа по состоянию на 9 сентября. «Не перешли» включает потерянные заявки и ещё находящиеся в работе. Есть оплата — хотя бы один положительный платёж. Просмотры не включены в воронку заявок: это другая единица измерения.</p><p>Цена заявки = рекламные расходы / заявки. Цена заказа = расходы / заказы с известным объявлением. Заказы без объявления входят в общий результат, но не удешевляют рекламный заказ. Оплаты / расход использует только оплаты заказов с известным объявлением; это не ROMI и не прибыль — себестоимость не вычтена.</p><p>В учебном наборе каждому объявлению и заказу явно назначен один вид продукции. В рабочей версии смешанную рекламу и заказы с несколькими видами продукции нужно распределить; без разметки они останутся отдельной строкой. Отсутствующие расходы не заменяются нулём. Итоги по продукции и объявлениям не дублируют деньги.</p></details><footer class="s-footer"><span>Учебная модель для обсуждения. Рабочие данные не подключены.</span><span>6 объявлений · 4 вида продукции</span></footer></main>`;
  const root = host.querySelector('.performance');
  root.addEventListener('click', click);
  root.addEventListener('change', change);
  const restore = focusedId
    ? root.querySelector('#' + focusedId)
    : [...root.querySelectorAll('[data-p]')].find(
        (x) => x.dataset.p === action && x.dataset.value === value,
      );
  restore?.focus({ preventScroll: true });
}
function resetContext() {
  ui.selected = null;
  ui.stage = null;
  ui.drop = false;
  ui.order = null;
  ui.compare = [];
  ui.notice = '';
}
function click(event) {
  const b = event.target.closest('[data-p]');
  if (!b) return;
  const a = b.dataset.p,
    v = b.dataset.value;
  if (a === 'tab') {
    ui.tab = v;
    ui.metricSet = v === 'source' ? 'result' : 'cost';
    ui.expanded = new Set();
    resetContext();
  }
  if (a === 'select') {
    ui.selected = ui.selected === v ? null : v;
    ui.stage = null;
    ui.order = null;
  }
  if (a === 'open-ad') {
    ui.tab = 'ad';
    ui.metricSet = 'cost';
    resetContext();
    ui.selected = v;
  }
  if (a === 'expand') {
    if (ui.expanded.has(v)) ui.expanded.delete(v);
    else ui.expanded.add(v);
  }
  if (a === 'metrics') ui.metricSet = v;
  if (a === 'sort') {
    ui.desc = ui.sort === v ? !ui.desc : v !== 'cpo' && v !== 'cpl';
    ui.sort = v;
  }
  if (a === 'direction') ui.desc = !ui.desc;
  if (a === 'clear-selected') {
    ui.selected = null;
    ui.stage = null;
    ui.order = null;
  }
  if (a === 'stage' || a === 'drop') {
    ui.stage = Number(v);
    ui.drop = a === 'drop';
    ui.order = null;
  }
  if (a === 'all-stages') {
    ui.stage = null;
    ui.drop = false;
  }
  if (a === 'order') ui.order = v;
  if (a === 'close-order') ui.order = null;
  if (a === 'clear-compare') ui.compare = [];
  if (a === 'reset') {
    ui.source = 'all';
    ui.product = 'all';
    resetContext();
  }
  render();
  if (a === 'stage' || a === 'drop')
    host.querySelector('#p-details').scrollIntoView({ block: 'start' });
  if (a === 'select' || a === 'open-ad')
    host.querySelector('.p-funnel').scrollIntoView({ block: 'start' });
  if (a === 'order')
    host.querySelector('.p-order-detail')?.scrollIntoView({ block: 'nearest' });
}
function change(event) {
  const e = event.target;
  if (e.dataset.pcompare) {
    if (!e.checked)
      ui.compare = ui.compare.filter((id) => id !== e.dataset.pcompare);
    else if (ui.compare.length < 3) ui.compare.push(e.dataset.pcompare);
    else ui.notice = 'Для сравнения можно выбрать до трёх строк.';
  } else if (e.id === 'p-source' || e.id === 'p-product') {
    ui[e.id === 'p-source' ? 'source' : 'product'] = e.value;
    resetContext();
  } else if (e.id === 'p-sort') {
    ui.sort = e.value;
    ui.desc = e.value !== 'cpo';
  } else return;
  render();
}
export function mountPerformance(app) {
  host = app;
  document.title = 'Реклама и продажи · Мастерская · Демо';
  render();
}
