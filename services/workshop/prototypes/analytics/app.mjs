import { mountSimple } from './simple.mjs';
import { mountPerformance } from './performance.mjs';
import { mountReal } from './real.mjs';
import {
  sources,
  periods,
  ads,
  customers,
  leads,
  orders,
  links,
  payments,
  orderEvents,
  defaultState,
  normalizeState,
  select,
  adMetrics,
  hybridDefaults,
  hybridScope,
  hybridSlice,
  hybridValue,
  hybridRows,
  hybridLeadRows,
} from './model.mjs';
import { efficiency } from '../../server/analytics/advertising-metrics.mjs';

const concepts = [
  {
    id: 'map',
    n: '01',
    name: 'Карта связей',
    short: 'Как всё связано',
    title: 'От внимания — к оплате',
    desc: 'Раскройте цепочку и найдите место, где теряется результат.',
    strength: 'Лучше всего объясняет связи и пробелы в атрибуции.',
    limit:
      'Большой поток потребует группировки узлов; карта не заменит точный список.',
    need: 'Идентификаторы обращений, подтверждённые связи с заказами и уникальные платежи.',
    scenario:
      'Источник → объявление → узел обращений → история → заказ и оплаты.',
  },
  {
    id: 'desk',
    n: '02',
    name: 'Рабочее место',
    short: 'Разобраться в деталях',
    title: 'Исследование без потери контекста',
    desc: 'Связанные списки, точное сравнение и карточка обращения на одном экране.',
    strength: 'Быстрое исследование отдельных строк и проверка гипотез.',
    limit:
      'Требует навыка работы с таблицами; на телефоне панели становятся последовательными.',
    need: 'Реестр обращений, статусы, причины потерь, история обработки и сохранённые фильтры.',
    scenario:
      'Сравнить две строки → сузить выборку → открыть обращение → сохранить исследование.',
  },
  {
    id: 'story',
    n: '03',
    name: 'История',
    short: 'Что было раньше',
    title: 'Одна история. Три линии событий.',
    desc: 'Реклама, разговор и заказ рядом — с видимыми паузами между ними.',
    strength:
      'Показывает задержки и последовательность событий, помогает разбирать сложные случаи.',
    limit:
      'Совпадение изменения рекламы и результата не доказывает причинность.',
    need: 'Время первого ответа, стадий, оплат, наблюдений версий объявления и продвижения.',
    scenario:
      'Выбрать объявление → обращение → сопоставить рекламу и обработку → проверить заказ.',
  },
  {
    id: 'matrix',
    n: '04',
    name: 'Экономика',
    short: 'Где качество и стоимость',
    title: 'Сравнивайте сопоставимое',
    desc: 'Объём, качество и результат по когортам. Незрелые периоды видны отдельно.',
    strength:
      'Помогает сравнивать качество и стоимость на одинаковом горизонте.',
    limit:
      'Малые выборки не дают устойчивого рейтинга; неполные расходы блокируют стоимость.',
    need: 'Полные расходы, дата обращения, квалификация, источник заказа и единое окно наблюдения.',
    scenario:
      'Выбрать показатель → сравнить недели → раскрыть источник и объявление → проверить обращения.',
  },
  {
    id: 'actions',
    n: '05',
    name: 'Решения',
    short: 'На что обратить внимание',
    title: 'Внимание туда, где оно нужно',
    desc: 'Сначала сигнал, затем факты и следующий проверяемый шаг.',
    strength: 'Снижает время поиска проблем для руководителя.',
    limit:
      'Правила приоритета требуют настройки; это очередь проверок, а не автоматический совет по бюджету.',
    need: 'Порог ответа, качество импорта, причины потерь, зрелость когорты и доступные доказательства.',
    scenario:
      'Сигнал → доказательства → конкретное обращение → история и связанные деньги.',
  },
];
const app = document.querySelector('#app');
const num = (v) =>
  v == null ? '—' : v.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
const rub = (v) => (v == null ? '—' : num(v) + ' ₽');
const money = (v) => rub(v == null ? null : v / 100);
const pct = (v) => (v == null ? '—' : num(v) + '%');
const date = (v) => (v ? v.slice(8) + '.' + v.slice(5, 7) : '—');
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
const customer = (id) => customers.find((c) => c.id === id);
const sourceLabel = (id) => (id === 'all' ? 'Все источники' : sources[id]);
const statusBadge = (l) =>
  `<span class="badge ${l.status === 'Потеря' ? 'red' : l.status === 'Заказ' ? 'green' : 'amber'}">${l.status}</span>`;
const btn = (text, action, value = '', cls = '') =>
  `<button class="${cls}" data-action="${action}" data-value="${esc(value)}">${text}</button>`;
const empty = (text) =>
  `<div class="empty"><span>∅</span><h3>Нет данных в этом срезе</h3><p>${text}</p></div>`;
let restored;
try {
  restored = JSON.parse(
    sessionStorage.getItem('analytics-concepts-context') || 'null',
  );
} catch {
  restored = null;
}
let state = normalizeState({
  ...restored,
  ...Object.fromEntries(new URLSearchParams(location.hash.slice(1))),
});
let notice = '';
function stateBadge(a) {
  return a.state === 'partial'
    ? '<span class="badge amber">Неполный импорт · расходы неизвестны</span>'
    : a.state === 'stale'
      ? '<span class="badge amber">Устарело · снимок 31.08</span>'
      : '<span class="badge green">Полный учебный срез</span>';
}
function adButton(a) {
  return btn(esc(a.title) + ' <span>↗</span>', 'ad', a.id, 'text-link');
}
function leadButton(l) {
  return btn(
    `<b>${l.id}</b> ${esc(customer(l.customer).name)}`,
    'lead',
    l.id,
    'lead-link ' + (state.focus === l.id ? 'selected' : ''),
  );
}
function totals(v) {
  return `<div class="totals" aria-label="Итог активного среза">
    <div><small>Обращения</small><strong data-testid="lead-count">${v.rows.length}</strong><span>${v.qualified} целевых · ${v.rows.filter((l) => l.repeat).length} повторных</span></div>
    <div><small>Уникальные заказы</small><strong data-testid="order-count">${v.connected.length}</strong><span>${v.converted} обращений связаны с заказом</span></div>
    <div><small>Сумма заказов</small><strong>${money(v.orderTotal)}</strong><span>По подтверждённым связям</span></div>
    <div><small>Оплаты этих заказов</small><strong data-testid="paid-total">${money(v.paidTotal)}</strong><span>Накоплено к 09.09 · не поток недели</span></div>
  </div>`;
}
function catalog(v, compact = false) {
  if (!v.catalog.length)
    return empty(
      'Объявления этого источника в демонаборе отсутствуют. Это не нулевые расходы.',
    );
  return `<div class="table-wrap"><table class="ad-table ${compact ? 'compact' : ''}"><thead><tr><th>Объявление / кампания</th><th>Просмотры</th><th>Контакты¹</th><th>Расходы</th><th>Цена контакта</th><th>Сравнить</th></tr></thead><tbody>${v.catalog
    .map((a) => {
      const m = adMetrics(a, state.period);
      return `<tr data-ad="${a.id}"><td>${adButton(a)}<small>${a.campaign}</small>${stateBadge(a)}</td><td>${num(m.views)}</td><td>${num(m.contacts)}</td><td>${money(m.spending)}</td><td>${rub(efficiency(m).costContact)}</td><td><input type="checkbox" data-compare="${a.id}" aria-label="Сравнить ${esc(a.title)}" ${state.compare.includes(a.id) ? 'checked' : ''}></td></tr>`;
    })
    .join(
      '',
    )}</tbody></table></div><p class="footnote">¹ Контакты Авито — действия в объявлении, не уникальные обращения или покупатели. У других источников эта метрика здесь недоступна.</p>`;
}
function comparison() {
  const chosen = ads.filter(
    (a) =>
      state.compare.includes(a.id) &&
      (state.source === 'all' || a.source === state.source),
  );
  if (!chosen.length) return '';
  return `<section class="comparison panel"><div class="panel-head"><h3>Сравнение объявлений · ${chosen.length}/2</h3>${btn('Очистить', 'clearCompare')}</div><p>Закреплённые объявления источника · ${periods[state.period].label}. Фильтр одного объявления не меняет эту пару.</p><div class="compare-cards">${chosen
    .map((a) => {
      const v = select({ ...state, ad: a.id });
      return `<article><small>${a.campaign}</small><h3>${esc(a.title)}</h3><dl><div><dt>Обращения / целевые</dt><dd>${v.rows.length} / ${v.qualified}</dd></div><div><dt>Потери</dt><dd>${v.lost}</dd></div><div><dt>Обращение → заказ</dt><dd>${pct(v.conversion)} <small>(${v.converted}/${v.rows.length})</small></dd></div><div><dt>Расход / уникальный заказ</dt><dd>${rub(v.spendOrder)}</dd></div></dl>${adButton(a)}</article>`;
    })
    .join(
      '',
    )}</div><p class="footnote">Малая выборка. Один заказ может быть связан с двумя объявлениями; суммы срезов не складываются. Общий итог считает заказ и платёж один раз.</p></section>`;
}
function leadList(v) {
  return v.rows.length
    ? `<div class="lead-list">${v.rows.map((l) => `<article>${leadButton(l)}<small>${date(l.date)} · ${sources[l.source]} · ${l.repeat ? 'Повторное' : 'Первое'} обращение</small>${statusBadge(l)}</article>`).join('')}</div>`
    : empty(
        'Попробуйте другой источник или неделю. Отсутствие обращений в демонаборе не доказывает отсутствие клиентов в бизнесе.',
      );
}
function orderDetail(o) {
  const ps = payments.filter((p) => p.order === o.id);
  const related = links.filter((e) => e.order === o.id);
  return `<article class="order-detail"><div class="panel-head"><h3>${o.id} · ${o.status}</h3><span class="badge green">Подтверждённый заказ</span></div><p>Источник этого заказа: <b>${sources[o.source]}</b> · создан ${date(o.date)}</p><div class="mini-metrics"><div><small>Сумма заказа</small><strong>${money(o.amount)}</strong></div><div><small>Оплачено</small><strong>${money(ps.reduce((s, p) => s + p.amount, 0))}</strong></div><div><small>Расчётная прибыль</small><strong>${money(o.profit)}</strong></div></div><p class="footnote">Прибыль — отдельное учебное значение формулы; состав затрат не известен. ROMI недоступен.</p><h4>Платежи</h4>${ps.length ? ps.map((p) => `<div class="payment"><span>${p.id} · ${date(p.date)} · Поступление</span><b>${money(p.amount)}</b></div>`).join('') : '<p>0 ₽ · платежей по этому заказу нет в полном учебном реестре.</p>'}<h4>История стадий заказа</h4>${(orderEvents[o.id] || []).map((event) => `<p class="relation">${date(event.date)} · ${event.stage}</p>`).join('')}<h4>Все связи заказа</h4>${related.map((e) => `<p class="relation ${e.confirmed ? '' : 'uncertain'}">${e.lead} → ${o.id} · ${e.confirmed ? 'Подтверждено менеджером' : 'Неподтверждённая связь · исключена из итогов'}</p>`).join('')}<p class="footnote">Каждый платёж включён в итог один раз по своему идентификатору.</p></article>`;
}
function inspector(v, story = false) {
  const l = v.rows.find((row) => row.id === state.focus);
  if (!l)
    return `<section class="panel inspector"><div class="empty"><span>↗</span><h3>Откройте обращение</h3><p>Выберите запись, чтобы увидеть историю обработки, источники и деньги связанных заказов.</p></div></section>`;
  const c = customer(l.customer),
    a = ads.find((ad) => ad.id === l.ad),
    edges = links.filter((e) => e.lead === l.id);
  const linked = edges
    .filter((e) => e.confirmed)
    .map((e) => orders.find((o) => o.id === e.order));
  const order = linked.find((o) => o.id === state.order) || linked[0];
  return `<section class="panel inspector" id="evidence"><div class="panel-head"><div><small>Карточка обращения · ${l.id}</small><h2>${esc(c.name)}</h2></div>${statusBadge(l)}</div>
    <div class="source-triad"><div><small>Первое привлечение клиента</small><b>${sources[c.first]}</b></div><div><small>Это обращение ${l.repeat ? '· повторное' : ''}</small><b>${sources[l.source]}</b></div><div><small>Источник заказа</small><b>${linked.length ? [...new Set(linked.map((o) => sources[o.source]))].join(', ') : 'Не установлен'}</b></div></div>
    <p>${a ? esc(a.campaign) + ' → ' + esc(a.title) : 'Объявление и первый источник не установлены'}</p>
    <div class="${story ? 'story-lanes' : 'evidence-columns'}">
    ${story ? `<div class="lane"><h3>01 / Реклама</h3><article class="event"><small>17.08 · наблюдение</small><h4>${a ? 'Версия 1 · основной текст' : 'Источник неизвестен'}</h4><p>${a ? esc(a.title) : 'Нет сохранённого объявления'}</p></article><article class="event"><small>25.08 · учебная отметка</small><h4>${a ? 'Версия 2 · добавлены сроки' : 'Нет данных'}</h4><p>История наблюдений не гарантирует все промежуточные правки.</p></article>${a ? `<article class="event"><small>26.08</small><h4>Продвижение</h4><p>Учебное событие. Влияние на конкретное обращение не установлено.</p></article>` : ''}</div>` : ''}
    <div class="lane"><h3>${story ? '02 / ' : ''}Обработка обращения</h3><article class="event"><small>${date(l.date)} · 10:00</small><h4>Получено обращение</h4><p>${l.qualified ? 'Целевое: запрос соответствует профилю' : 'Квалификация не подтверждена'}</p></article><article class="event ${l.response > 60 ? 'warning' : ''}"><small>До первого ответа</small><h4>${l.response == null ? 'Время ответа неизвестно' : num(l.response) + ' мин'}</h4><p>${l.response > 60 ? 'Выше учебного ориентира 60 минут. Это сигнал для проверки, не доказанная причина потери.' : 'Время из учебного журнала обработки.'}</p></article><article class="event"><small>Текущее состояние</small><h4>${l.status}</h4><p>${l.reason || 'Запрос согласован, связь подтверждена менеджером.'}</p></article></div>
    <div class="lane"><h3>${story ? '03 / ' : ''}Заказы и оплаты</h3>${
      linked.length
        ? linked
            .map((o) => {
              const first = payments.find((p) => p.order === o.id);
              return `<article class="event"><small>${date(o.date)}</small>${btn(o.id + ' · ' + money(o.amount), 'order', o.id, 'order-link')}<p>До заказа: ${(Date.parse(o.date) - Date.parse(l.date)) / 86400000} дн. · до первой оплаты: ${first ? (Date.parse(first.date) - Date.parse(l.date)) / 86400000 + ' дн.' : 'оплат нет'}</p></article>`;
            })
            .join('')
        : '<p>Подтверждённых заказов нет.</p>'
    }${edges
      .filter((e) => !e.confirmed)
      .map(
        (e) =>
          `<article class="event warning"><h4>${e.order} · связь не подтверждена</h4><p>Совпадение названия недостаточно. Заказ и его оплаты исключены из этого среза.</p></article>`,
      )
      .join('')}</div></div>
    ${order ? orderDetail(order) : ''}
    <details><summary>Связи клиента за пределами текущего среза</summary><p>Справочная история клиента целиком; не включается в итог фильтра.</p>${leads
      .filter((row) => row.customer === l.customer)
      .map(
        (row) =>
          `<p>${row.id} · ${date(row.date)} · ${sources[row.source]} · ${row.repeat ? 'повторное' : 'первое'} обращение</p>`,
      )
      .join('')}</details>
  </section>`;
}
function connectionMap(v) {
  return `<section class="panel connection-map"><div class="panel-head"><div><span class="eyebrow">Связи отдельных записей</span><h2>Каждая ветвь до результата</h2></div><span>Нажмите обращение или заказ</span></div><p>Кампания → объявление → обращение → заказ → оплаты. Повторяющийся номер заказа означает общий узел, его сумма не складывается повторно.</p>${
    v.rows.length
      ? v.rows
          .map((l) => {
            const ad = ads.find((a) => a.id === l.ad),
              edges = v.edges.filter((e) => e.lead === l.id);
            return `<div class="connection-row ${state.focus === l.id ? 'highlight' : ''}"><div class="connection-ad"><small>${ad?.campaign || 'Кампания неизвестна'}</small><b>${ad?.title || 'Объявление неизвестно'}</b></div><span class="connector">→</span><div>${leadButton(l)}${statusBadge(l)}</div><span class="connector ${edges.some((e) => !e.confirmed) ? 'uncertain' : ''}">${edges.some((e) => !e.confirmed) ? '⇢' : '→'}</span><div>${
              edges.length
                ? edges
                    .map(
                      (e) =>
                        `<div class="branch-order ${e.confirmed ? '' : 'uncertain'}">${e.confirmed ? btn(e.order, 'mapOrder', e.order, 'order-link') : `<b>${e.order} · не подтверждено</b>`}<small>${
                          e.confirmed
                            ? payments
                                .filter((p) => p.order === e.order)
                                .map((p) => p.id + ' · ' + money(p.amount))
                                .join(' + ') || '0 ₽ · платежей нет'
                            : 'Оплаты исключены из итога'
                        }</small></div>`,
                    )
                    .join('')
                : `<p class="branch-stop">${l.status === 'Потеря' ? 'Потеря · ' + l.reason : 'Заказ пока не подтверждён'}</p>`
            }</div></div>`;
          })
          .join('')
      : empty('Нет обращений для построения связей.')
  }</section>`;
}
function map(v) {
  const steps = [
    ['ads', 'Объявления', v.catalog.length, 'По выбранному источнику'],
    ['leads', 'Обращения', v.rows.length, `${v.qualified} целевых`],
    [
      'orders',
      'Заказы',
      v.connected.length,
      `${v.converted} обращений со связью`,
    ],
    ['payments', 'Оплаты', v.paid.length, money(v.paidTotal)],
  ];
  return `<section class="map-canvas"><div class="map-heading"><span class="eyebrow">Маршрут результата</span><span>Сплошная — подтверждено · пунктир — требует проверки</span></div><div class="flow-source"><span class="source-dot"></span><b>${sourceLabel(state.source)}</b><small>Источник конкретного обращения</small></div><div class="flow">${steps.map(([id, label, n, note], i) => `<button class="flow-node ${state.stage === id ? 'active' : ''}" data-action="stage" data-value="${id}"><small>0${i + 1} / ${label}</small><strong>${n}</strong><span>${note}</span><em>${state.stage === id ? 'Раскрыто ↓' : 'Раскрыть →'}</em></button>`).join('')}</div><div class="losses"><span>${v.lost} потеряно <small>по статусу обращения</small></span><span>${v.pending} ещё в обработке <small>не равно потере</small></span><span class="dashed">${v.edges.filter((e) => !e.confirmed).length} спорных связей <small>не участвуют в деньгах</small></span></div><p class="map-note">Переход контактов Авито в обращения не сопоставлен: полнота неизвестна. Из ${v.rows.length} обращений ${v.converted} имеют подтверждённую связь с заказом. Это не оценка полноты всех связей.</p></section>
    <section class="panel"><div class="panel-head"><h2>${{ ads: 'Объявления и кампании', leads: 'Обращения выбранной цепочки', orders: 'Уникальные связанные заказы', payments: 'Платежи связанных заказов' }[state.stage]}</h2><span class="muted">Нажмите, чтобы исследовать</span></div>${state.stage === 'ads' ? catalog(v) : state.stage === 'orders' ? v.connected.map((o) => `<div class="payment">${btn(o.id + ' · ' + esc(customer(o.customer).name), 'mapOrder', o.id, 'text-link')}<b>${money(o.amount)}</b></div>`).join('') || empty('Подтверждённых связей с заказами нет.') : state.stage === 'payments' ? v.paid.map((p) => `<div class="payment">${btn(p.id + ' → ' + p.order + ' · ' + date(p.date), 'mapOrder', p.order, 'text-link')}<b>${money(p.amount)}</b></div>`).join('') || empty('Нет платежей по подтверждённым связанным заказам.') : leadList(v)}</section>${comparison()}${connectionMap(v)}${inspector(v)}`;
}
function desk(v) {
  return `<div class="desk-layout"><aside class="panel research"><span class="eyebrow">Исследование</span><h3>Контекст под рукой</h3><p>${sourceLabel(state.source)}<br>${periods[state.period].label}</p><div class="research-step active">1. Сравните объявления</div><div class="research-step">2. Проверьте обращения</div><div class="research-step">3. Откройте заказ</div>${btn('Сохранить исследование', 'save', '', 'primary')}${btn('Вернуть сохранённое', 'restore')}<p class="footnote">Сохраняются фильтры, выбранная пара и обращение в этом браузере.</p><div role="status">${notice}</div></aside><div class="desk-main"><section class="panel"><div class="panel-head"><h2>Объявления</h2><span>${v.catalog.length} строк</span></div>${catalog(v, true)}</section>${comparison()}<div class="desk-split"><section class="panel"><h2>Реестр обращений</h2>${leadList(v)}</section>${inspector(v)}</div></div></div>`;
}
function story(v) {
  const a =
    ads.find((ad) => ad.id === state.ad) ||
    ads.find((ad) => ad.id === v.rows.find((l) => l.id === state.focus)?.ad);
  return `<section class="story-top"><div><span class="eyebrow">Исследование во времени</span><h2>Не только «сколько»,<br>но и «когда»</h2><p>Срез обращений: ${periods[state.period].label}. История каждого продолжается до 09.09.</p></div><div class="panel before-after"><h3>Наблюдение до / после 25.08</h3>${a ? `<p>${esc(a.title)}</p><div class="mini-metrics"><div><small>18–24 авг · 7 дней</small><strong>${num(a.previous.contacts)}</strong><span>контактов</span></div><div><small>26 авг – 1 сен · 7 дней</small><strong>—</strong><span>только 6 из 7 дней</span></div></div><p>Изменение не рассчитано: неполный период после. День правки исключён.</p>` : '<p>Выберите объявление или обращение с известной рекламой.</p>'}<span class="badge amber">Версии не доказывают причинный эффект</span></div></section><details class="panel"><summary>Сравнить объявления перед разбором истории</summary>${catalog(v)}</details>${comparison()}<section class="panel story-picker"><h3>Чью историю исследуем</h3>${leadList(v)}</section>${inspector(v, true)}`;
}
function matrix(v) {
  const lens = {
    conversion: 'Обращение → заказ',
    quality: 'Доля целевых',
    cost: 'Расход / заказ',
  }[state.lens];
  const sourceKeys =
    state.source === 'all' ? Object.keys(sources) : [state.source];
  return `<div class="matrix-layout"><section class="panel"><div class="panel-head"><div><span class="eyebrow">Когортный анализ</span><h2>${lens}</h2></div><label>Показатель<select id="lens">${[
    ['conversion', 'Конверсия'],
    ['quality', 'Качество'],
    ['cost', 'Стоимость'],
  ]
    .map(
      ([id, label]) =>
        `<option value="${id}" ${state.lens === id ? 'selected' : ''}>${label}</option>`,
    )
    .join(
      '',
    )}</select></label></div><p>Одинаковые недели, результат в первые 7 дней после обращения. Основной итог выше — накопленный к 09.09. Для свежей недели полное окно ещё не прошло.</p><div class="cohort-grid"><div class="cohort-head">Источник / неделя обращения</div>${['previous', 'mature', 'recent'].map((p) => `<div class="cohort-head ${state.period === p ? 'current' : ''}">${periods[p].label}</div>`).join('')}${sourceKeys
    .map(
      (source) =>
        `<div class="cohort-source">${sources[source]}</div>${[
          'previous',
          'mature',
          'recent',
        ]
          .map((period) => {
            const slice = select({ ...state, source, period });
            const ordered = slice.rows.filter((l) =>
              links.some(
                (e) =>
                  e.lead === l.id &&
                  e.confirmed &&
                  (Date.parse(orders.find((o) => o.id === e.order).date) -
                    Date.parse(l.date)) /
                    86400000 <=
                    7,
              ),
            );
            const rate = slice.rows.length
              ? (ordered.length / slice.rows.length) * 100
              : null;
            const value =
              state.lens === 'quality'
                ? slice.rows.length
                  ? (slice.qualified / slice.rows.length) * 100
                  : null
                : state.lens === 'cost'
                  ? slice.spendOrder
                  : rate;
            return `<button class="cohort-cell ${period === 'recent' ? 'immature' : value == null ? 'missing' : value === 0 ? 'zero' : 'heat'} ${state.period === period ? 'current' : ''}" data-action="cell" data-value="${source}:${period}"><strong>${period === 'recent' ? 'Ещё рано' : state.lens === 'cost' ? rub(value) : pct(value)}</strong><span>n = ${slice.rows.length}${slice.rows.length > 0 && slice.rows.length < 10 ? ' · малая выборка' : ''}</span><small>${period === 'recent' ? 'Окно 7 дней не закрыто' : slice.rows.length ? 'Открыть доказательства ↗' : 'Нет обращений'}</small></button>`;
          })
          .join('')}`,
    )
    .join(
      '',
    )}</div><p class="footnote">Целевое = запрос соответствует профилю по отметке менеджера. Конверсия = обращения хотя бы с одним подтверждённым заказом / все обращения. Несколько заказов не повышают числитель.</p></section><aside class="panel economy-notes"><h3>Условия сравнения</h3><div class="check-row">✓ Равные периоды: 7 дней</div><div class="check-row">✓ Одинаковое окно: 7 дней</div><div class="check-row amber-text">△ Выборки меньше 10</div><div class="check-row amber-text">△ Директ: расходы неполные</div><h4>Рейтинг не построен</h4><p>Данных недостаточно для устойчивого вывода о лучшем источнике.</p><h4>CAC и ROMI</h4><p>Недоступны: нет полного состава затрат и доказанного учёта новых клиентов. Расход / заказ — отдельное отношение.</p></aside></div><section class="panel"><h2>Объявления выбранной ячейки</h2>${catalog(v)}</section>${comparison()}<div class="desk-split"><section class="panel"><h2>Обращения · доказательства</h2>${leadList(v)}</section>${inspector(v)}</div>`;
}
function signals(v) {
  const result = [];
  if (state.period === 'mature')
    for (const a of v.catalog) {
      const now = efficiency(a.metrics).costContact,
        before = efficiency(a.previous).costContact;
      if (now != null && before > 0 && now > before)
        result.push({
          id: 'price-' + a.id,
          tag: 'Стоимость контакта',
          title: `${a.title}: ${rub(before)} → ${rub(now)}`,
          text: 'Сравнение двух полных недель. Проверьте состав контактов и обработку обращений до решения о бюджете.',
          rows: v.rows.filter((l) => l.ad === a.id),
          next: 'Сопоставить объявление, качество обращений и результат',
          priority: '03',
        });
    }
  const slow = v.rows.filter((l) => l.response > 60);
  if (slow.length)
    result.push({
      id: 'slow',
      tag: 'Обработка',
      title: `${slow.length} ${slow.length === 1 ? 'обращение' : 'обращения'} с ответом дольше часа`,
      text: 'Проверьте время и обстоятельства ответа. Медленный ответ сам по себе не доказывает причину потери.',
      rows: slow,
      next: 'Разобрать журнал ответа и загрузку менеджера',
      priority: '01',
    });
  const lost = v.rows.filter((l) => l.status === 'Потеря');
  if (lost.length)
    result.push({
      id: 'lost',
      tag: 'Потери',
      title: `${lost.length} ${lost.length === 1 ? 'обращение потеряно' : 'обращения потеряны'}`,
      text: 'Причины записаны в учебном реестре. Сопоставьте срок, профиль запроса и предложение.',
      rows: lost,
      next: 'Сверить причины потерь с исходным запросом',
      priority: '02',
    });
  if (v.edges.some((e) => !e.confirmed))
    result.push({
      id: 'link',
      tag: 'Достоверность',
      title: 'Есть неподтверждённая связь',
      text: 'Эти деньги исключены из результата. Совпадения названий недостаточно.',
      rows: v.rows.filter((l) =>
        v.edges.some((e) => e.lead === l.id && !e.confirmed),
      ),
      next: 'Проверить идентичность клиента по первичному обращению',
      priority: '01',
    });
  if (v.catalog.some((a) => a.state !== 'ready'))
    result.push({
      id: 'import',
      tag: 'Данные',
      title: 'Сначала проверить свежесть и полноту',
      text: 'Неполные расходы или устаревший снимок не позволяют сравнивать стоимость результата.',
      rows: v.rows,
      next: 'Проверить журнал загрузки выбранного источника',
      priority: '01',
    });
  if (v.rows.length && !slow.length && !lost.length)
    result.push({
      id: 'sample',
      tag: 'Выборка',
      title: 'Слишком мало наблюдений для решения о бюджете',
      text: `В срезе ${v.rows.length} обращений. Продолжите наблюдение на одинаковом горизонте.`,
      rows: v.rows,
      next: 'Проверить качество каждого обращения',
      priority: '03',
    });
  return result.sort((a, b) => a.priority.localeCompare(b.priority));
}
let activeSignal = '';
function actions(v) {
  const items = signals(v),
    selected = items.find((s) => s.id === activeSignal) || items[0];
  return `<div class="actions-layout"><section><div class="panel-head"><span class="eyebrow">Очередь внимания · ${items.length}</span><span>Правило: данные → обработка → потери</span></div>${items.length ? items.map((s) => `<button class="signal-card ${s.id === selected.id ? 'selected' : ''}" data-action="signal" data-value="${s.id}"><span class="signal-num">${s.priority}</span><div><small>${s.tag}</small><h2>${s.title}</h2><p>${s.text}</p><b>Разобрать доказательства →</b></div></button>`).join('') : empty('В этом срезе нет сигналов. Это не заключение об эффективности источника.')}</section><aside class="panel action-evidence"><span class="eyebrow">Следующий шаг</span><h2>${selected?.next || 'Выберите другой срез'}</h2><p>Учебное правило, без автоматического изменения рекламы и без оценки упущенной выручки.</p>${selected ? `<h3>Основание сигнала</h3>${leadList({ ...v, rows: selected.rows })}<details><summary>Объявления и качество загрузки</summary>${v.catalog.map((a) => `<p>${adButton(a)}<br>${stateBadge(a)}</p>`).join('') || 'Нет объявлений'}</details>` : ''}</aside></div><details class="panel all-signal-leads"><summary>Все обращения текущего среза</summary>${leadList(v)}</details>${inspector(v)}<details class="panel"><summary>Сравнить объявления и проверить альтернативы</summary>${catalog(v)}</details>${comparison()}`;
}
function comparePage() {
  return `<section class="comparison-hero"><span class="eyebrow">Пять способов думать об одном результате</span><h1>Выберите устройство работы,<br>а не оформление графика</h1><p>Контекст сохраняется при переходе между концепциями. Откройте одно обращение в разных интерфейсах и сравните путь к ответу.</p></section><div class="concept-cards">${concepts.map((c) => `<article class="panel"><span class="concept-number">${c.n}</span><h2>${c.name}</h2><p>${c.short}</p><div class="mini-preview ${c.id}" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><h4>Основной сценарий</h4><p>${c.scenario}</p><h4>Сильная сторона</h4><p>${c.strength}</p><h4>Ограничение</h4><p>${c.limit}</p><h4>Нужны данные</h4><p>${c.need}</p>${btn('Открыть концепцию →', 'concept', c.id, 'primary')}</article>`).join('')}</div><section class="recommendation panel"><span class="eyebrow">Рекомендация для рабочего модуля</span><h2>Рабочее место как основа. Карта и история — для объяснения.</h2><p>Начать с реестра обращений и проверки связей в рабочем месте: он делает происхождение результата проверяемым. Добавить карту в карточку источника, а историю — в карточку обращения. Матрицы включать после накопления зрелых когорт и полных расходов; экран руководителя строить поверх проверенных правил и всегда вести к доказательствам.</p><p>До появления реестра обращений рабочий модуль продолжает показывать существующие рекламные показатели. Сквозные суммы этих прототипов не являются доступными интеграциями.</p></section>`;
}
const hSets = {
  result: [
    ['spending', 'Расходы'],
    ['leads', 'Обращения'],
    ['conversion', 'В заказ'],
    ['cost', 'Цена заказа¹'],
    ['paid', 'Оплаты²'],
  ],
  ads: [
    ['impressions', 'Показы'],
    ['views', 'Просмотры'],
    ['contacts', 'Контакты Авито'],
    ['costContact', 'Цена контакта'],
    ['leads', 'Обращения'],
  ],
  quality: [
    ['leads', 'Обращения'],
    ['quality', 'Целевые'],
    ['repeat', 'Повторные'],
    ['lost', 'Потери'],
    ['orders', 'Заказы'],
  ],
};
function hFormat(value, key) {
  return ['spending', 'paid'].includes(key)
    ? money(value)
    : ['cost', 'costContact'].includes(key)
      ? rub(value)
      : ['conversion', 'quality'].includes(key)
        ? pct(value)
        : num(value);
}
function hDelta(v, older, key) {
  if (!state.hPrevious) return '';
  if (key === 'paid') return '<small class="h-delta">накоплено²</small>';
  if (!older) return '<small class="h-delta">нет сравнения</small>';
  if (
    !periods[state.period].mature &&
    ['conversion', 'cost', 'paid', 'orders', 'quality'].includes(key)
  )
    return '<small class="h-delta">ещё созревает</small>';
  const a = hybridValue(v, key),
    b = hybridValue(older, key);
  if (a == null || b == null)
    return '<small class="h-delta">нет данных</small>';
  const diff = a - b;
  return `<small class="h-delta ${diff === 0 ? '' : diff > 0 ? 'up' : 'down'}">${diff === 0 ? 'без изменений' : b === 0 ? 'с нулевой базы' : `${diff > 0 ? '+' : ''}${num((diff / Math.abs(b)) * 100)}%`}</small>`;
}
function hQuality(v) {
  return v.partial
    ? '<span class="h-flag amber">неполный импорт</span>'
    : v.stale
      ? '<span class="h-flag amber">устарело · 31.08</span>'
      : !v.catalog.length && !v.rows.length
        ? '<span class="h-flag">нет данных</span>'
        : v.edges.some((e) => !e.confirmed)
          ? '<span class="h-flag amber">связь не подтверждена</span>'
          : v.rows.length < 10 && v.rows.length > 0
            ? '<span class="h-flag">малая выборка</span>'
            : '';
}
function hPrevious(v, key) {
  return v.previousPeriod ? hybridSlice(state, key, v.previousPeriod) : null;
}
function hTraffic(v) {
  const m = v.metrics;
  return `<details class="h-traffic" ${state.hSet === 'ads' ? 'open' : ''}><summary>Рекламная воронка</summary><div>${[
    ['Показы', m.impressions, null],
    ['Просмотры', m.views, v.rates.ctr],
    ['Контакты Авито', m.contacts, v.rates.contactRate],
  ]
    .map(
      ([name, value, rate]) =>
        `<div><span>${name}<b>${num(value)}</b></span><small>${rate == null ? 'Переход не рассчитан' : pct(rate) + ' от предыдущего этапа'}</small></div>`,
    )
    .join(
      '',
    )}</div><p>Показы → просмотры → действия с объявлением. Связь этих действий с обращениями не установлена; сквозная конверсия здесь не рассчитана.</p></details>`;
}
function hFunnel(v, compact = false) {
  const steps = [
    ['all', 'Обращения', v.rows.length],
    ['qualified', 'Целевые', v.qualified],
    ['ordered', 'С заказом', v.converted],
    ['paid', 'С оплатой', v.paidLeadIds.length],
  ];
  return `<div class="h-funnel ${compact ? 'mini' : ''}">${steps.map(([id, label, n], i) => `<button data-action="h-stage" data-value="${id}" class="${state.hStage === id ? 'active' : ''}" aria-pressed="${state.hStage === id}"><span>${label}<b>${n}</b></span><i style="width:${v.rows.length ? (n / v.rows.length) * 100 : 0}%"></i><small>${i ? (steps[i - 1][2] ? `${pct((n / steps[i - 1][2]) * 100)} от предыдущего этапа` : 'Переход не рассчитан') : 'Все обращения выбранной строки'}</small></button>`).join('')}</div>`;
}
function hComparison(rows) {
  const selected = state.hCompare
    .map((key) => rows.find((r) => r.key === key))
    .filter(Boolean);
  if (!selected.length) return '';
  const cols = [
    ['spending', 'Расходы'],
    ['leads', 'Обращения'],
    ['quality', 'Целевые'],
    ['conversion', 'В заказ'],
    ['cost', 'Цена заказа¹'],
    ['paid', 'Оплаты²'],
  ];
  return `<section class="h-compare" id="h-comparison"><div class="h-section-head"><div><span class="eyebrow">СРАВНЕНИЕ · ${selected.length}/3</span><h2>${{ source: 'Источники', campaign: 'Кампании', ad: 'Объявления' }[selected[0].kind]} рядом</h2></div>${btn('Очистить', 'h-clear')}</div><div class="h-compare-grid" style="--columns:${selected.length}">${selected.map((r) => `<article><small>${r.kind === 'ad' ? sources[hybridScope(r.key).source] : r.kind === 'campaign' ? sources[hybridScope(r.key).source] : 'Источник'}</small><h3>${esc(r.label)}</h3>${hQuality(r.view)}<dl>${cols.map(([key, label]) => `<div><dt>${label}</dt><dd><b>${hFormat(hybridValue(r.view, key), key)}</b>${hDelta(r.view, hPrevious(r.view, r.key), key)}</dd></div>`).join('')}</dl><div class="h-compare-funnel">Обращения → целевые → с заказом → с оплатой<strong>${r.view.rows.length} → ${r.view.qualified} → ${r.view.converted} → ${r.view.paidLeadIds.length}</strong></div>${btn('Исследовать →', 'h-select', r.key, 'text-link')}</article>`).join('')}</div><p>Период одинаковый: ${periods[state.period].label}. Срезы могут пересекаться: общие заказы и оплаты не складываются. Малая выборка не даёт устойчивого рейтинга.</p></section>`;
}
function hybridPage() {
  state = { ...hybridDefaults, ...state };
  for (const [key, values] of Object.entries({
    hGroup: ['source', 'campaign', 'ads'],
    hSet: ['result', 'ads', 'quality'],
    hDir: ['asc', 'desc'],
    hStage: ['all', 'qualified', 'ordered', 'paid', 'lost', 'pending'],
    hSort: [
      'name',
      'spending',
      'leads',
      'conversion',
      'cost',
      'paid',
      'quality',
      'repeat',
      'lost',
      'orders',
      'views',
      'impressions',
      'contacts',
      'costContact',
    ],
  }))
    if (!values.includes(state[key])) state[key] = hybridDefaults[key];
  state.hClosed = Array.isArray(state.hClosed) ? state.hClosed : [];
  state.hCompare = Array.isArray(state.hCompare)
    ? state.hCompare.filter((k) => hybridScope(k)).slice(0, 3)
    : [];
  state.hSearch =
    typeof state.hSearch === 'string' ? state.hSearch.slice(0, 120) : '';
  const allRows = hybridRows(state, false),
    visible = hybridRows(state),
    whole = hybridSlice(state);
  state.hCompare = state.hCompare.filter((key) =>
    allRows.some((r) => r.key === key),
  );
  if (!allRows.some((r) => r.key === state.hSelected)) {
    state.hSelected = allRows[0]?.key || '';
    state.focus = null;
    state.order = null;
  }
  const chosen = allRows.find((r) => r.key === state.hSelected),
    v = chosen?.view;
  const previous = hPrevious(whole, null),
    metrics = hSets[state.hSet];
  const filteredLeads = v ? hybridLeadRows(v, state.hStage) : [];
  return `<div class="hybrid"><header class="h-header"><a class="brand" href="#concept=hybrid"><span class="brandmark">М</span><span>МАСТЕРСКАЯ<small>Аналитика</small></span></a><span class="h-breadcrumb">Источники / эффективность</span><span class="demo-pill">ВЫМЫШЛЕННЫЕ ДАННЫЕ</span>${btn('Пять концепций ↗', 'concept', 'compare', 'compare-button')}</header><main class="h-main"><div class="h-title"><div><span class="eyebrow">ЭКОНОМИКА + РАБОЧЕЕ МЕСТО</span><h1>От источника до результата</h1></div><p>Источники, кампании и объявления.<br>Одна таблица, одна логика сравнения.</p></div><div class="h-demo">Демо будущего интерфейса. Все записи и числа вымышлены; рабочие обращения и сквозные связи не подключены.</div>
  <section class="h-controls"><label>Неделя обращения<select id="period">${Object.entries(
    periods,
  )
    .map(
      ([id, p]) =>
        `<option value="${id}" ${state.period === id ? 'selected' : ''}>${p.label}</option>`,
    )
    .join(
      '',
    )}</select></label><label>Источник<select id="source"><option value="all" ${state.source === 'all' ? 'selected' : ''}>Все источники</option>${Object.entries(
    sources,
  )
    .map(
      ([id, name]) =>
        `<option value="${id}" ${state.source === id ? 'selected' : ''}>${name}</option>`,
    )
    .join(
      '',
    )}</select></label><form id="h-search-form"><label>Поиск в источниках, кампаниях и объявлениях<div class="h-search"><input id="hSearch" name="search" type="search" placeholder="Название объявления или кампании" value="${esc(state.hSearch)}"><button type="submit" aria-label="Найти">↵</button></div></label></form><label class="h-check"><input type="checkbox" id="hPrevious" ${state.hPrevious ? 'checked' : ''}>С предыдущей неделей</label>${btn('Сбросить', 'h-reset', '', 'h-reset')}</section>
  <div class="h-scope"><span>Итог таблицы · <b>${sourceLabel(state.source)}</b>${state.hSearch ? ' · поиск: ' + esc(state.hSearch) : ''}</span><span>Накопленный результат к 09.09.2026${!periods[state.period].mature ? ' · когорта ещё созревает' : ''}</span></div><section class="h-kpis">${[
    [
      'spending',
      'Расходы на рекламу',
      whole.partial ? 'Не все расходы загружены' : 'Деньги кабинетов',
    ],
    [
      'leads',
      'Обращения',
      `${whole.qualified} целевых · ${whole.lost} потеряно`,
    ],
    [
      'orders',
      'Уникальные заказы',
      `${whole.converted} обращений связаны с заказом`,
    ],
    ['paid', 'Оплаты этих заказов', 'Накоплено, не поток за неделю'],
  ]
    .map(
      ([key, label, note]) =>
        `<div><small>${label}</small><strong data-hkpi="${key}">${hFormat(hybridValue(whole, key), key)}</strong><span>${note}</span>${hDelta(whole, previous, key)}</div>`,
    )
    .join('')}</section>
  <section class="h-workspace"><div class="h-table-panel"><div class="h-table-toolbar"><div class="h-segments" aria-label="Набор показателей">${[
    ['result', 'Результат'],
    ['ads', 'Реклама'],
    ['quality', 'Качество'],
  ]
    .map(([id, label]) =>
      btn(label, 'h-set', id, state.hSet === id ? 'active' : ''),
    )
    .join(
      '',
    )}</div><span class="h-count">${whole.catalog.length} объявлений · ${whole.rows.length} обращений</span></div><div class="h-table-options"><label>Группировка<select id="hGroup"><option value="source" ${state.hGroup === 'source' ? 'selected' : ''}>Источник → объявления</option><option value="campaign" ${state.hGroup === 'campaign' ? 'selected' : ''}>Источник → кампании → объявления</option><option value="ads" ${state.hGroup === 'ads' ? 'selected' : ''}>Все объявления списком</option></select></label><label>Сортировка<select id="hSort">${[
    ['spending', 'По расходам'],
    ['leads', 'По обращениям'],
    ['conversion', 'По конверсии'],
    ['cost', 'По цене заказа'],
    ['paid', 'По оплатам'],
    ['impressions', 'По показам'],
    ['views', 'По просмотрам'],
    ['contacts', 'По контактам'],
    ['costContact', 'По цене контакта'],
    ['quality', 'По доле целевых'],
    ['repeat', 'По повторным'],
    ['lost', 'По потерям'],
    ['orders', 'По заказам'],
    ['name', 'По названию'],
  ]
    .map(
      ([id, label]) =>
        `<option value="${id}" ${state.hSort === id ? 'selected' : ''}>${label}</option>`,
    )
    .join(
      '',
    )}</select></label>${btn(state.hDir === 'desc' ? '↓' : '↑', 'h-direction', '', 'h-direction')}${state.hGroup === 'ads' ? '' : btn(state.hClosed.length ? 'Раскрыть всё' : 'Свернуть всё', 'h-expand', '', 'h-expand')}</div>
  <div class="h-table-scroll"><table class="h-table"><thead><tr><th class="h-name-head">${btn('Название', 'h-sort', 'name')}<small>Флажки — сравнить до 3 строк</small></th>${metrics.map(([key, label]) => `<th><button data-action="h-sort" data-value="${key}" aria-label="Сортировать: ${label}">${label}${state.hSort === key ? (state.hDir === 'desc' ? ' ↓' : ' ↑') : ''}</button></th>`).join('')}</tr></thead><tbody>${
    visible
      .map((r) => {
        const old = hPrevious(r.view, r.key);
        const expandable =
          r.kind !== 'ad' &&
          r.view.catalog.length > 0 &&
          state.hGroup !== 'ads';
        return `<tr class="h-row ${r.kind} ${state.hSelected === r.key ? 'selected' : ''}" data-hrow="${esc(r.key)}"><td><div class="h-name" style="--depth:${r.depth}"><input type="checkbox" data-hcompare="${esc(r.key)}" aria-label="Сравнить ${esc(r.label)}" ${state.hCompare.includes(r.key) ? 'checked' : ''}>${expandable ? `<button class="h-caret" data-action="h-toggle" data-value="${esc(r.key)}" aria-expanded="${!state.hClosed.includes(r.key)}" aria-label="Раскрыть ${esc(r.label)}">${state.hClosed.includes(r.key) ? '›' : '⌄'}</button>` : '<span class="h-indent"></span>'}<button class="h-row-link" data-action="h-select" data-value="${esc(r.key)}"><span>${r.kind === 'source' ? '<i class="h-source-dot ' + hybridScope(r.key).source + '"></i>' : ''}${esc(r.label)}</span><small>${r.kind === 'ad' ? sources[hybridScope(r.key).source] : r.kind === 'source' ? `${r.view.catalog.length} объявлений` : 'Кампания'}${r.view.partial ? ' · импорт неполный' : r.view.stale ? ' · устарело' : !r.view.catalog.length && !r.view.rows.length ? ' · нет данных' : ''}</small></button></div></td>${metrics.map(([key]) => `<td data-metric="${key}"><b>${hFormat(hybridValue(r.view, key), key)}</b>${hDelta(r.view, old, key)}</td>`).join('')}</tr>`;
      })
      .join('') ||
    '<tr><td colspan="6"><div class="empty"><h3>Ничего не найдено</h3><p>Измените поиск или источник.</p></div></td></tr>'
  }</tbody><tfoot><tr><th>Итого без повторного счёта</th>${metrics.map(([key]) => `<td>${hFormat(hybridValue(whole, key), key)}</td>`).join('')}</tr></tfoot></table></div>
  <div class="h-table-note"><span class="h-swipe">Показатели можно прокрутить вправо →</span>Сортировка работает внутри групп. Прочерк — неизвестно, 0 — настоящий ноль.${state.hSet === 'ads' ? ' Контакты Авито не равны обращениям.' : ' ¹ Расход / уникальный связанный заказ, не CAC. ² Накопленные оплаты.'} Срезы объявлений могут пересекаться; общий итог не складывает их деньги.</div>${state.hCompare.length ? `<div class="h-selection">Выбрано для сравнения: ${state.hCompare.length} ${btn('К сравнению ↓', 'h-comparison')}${btn('Очистить', 'h-clear')}</div>` : ''}<p class="h-notice" role="status">${esc(state.hNotice || '')}</p></div>
  <aside class="h-investigation">${v ? `<div class="h-section-head"><div><span class="eyebrow">ВЫБРАННАЯ СТРОКА</span><h2>${esc(chosen.label)}</h2></div></div>${hQuality(v)}<div class="h-mini"><span>Заказы<b>${v.connected.length}</b></span><span>Оплаты<b>${money(v.paidTotal)}</b></span></div>${hTraffic(v)}<h3>Воронка обращений</h3>${hFunnel(v)}<p class="h-unit">На всех этапах считаем обращения: два заказа из одного обращения не удваивают конверсию. Контакты Авито в эту цепочку не включены.</p><div class="h-loss-buttons">${btn(`${v.lost} потеряно`, 'h-stage', 'lost', state.hStage === 'lost' ? 'active' : '')}${btn(`${v.pending} в работе`, 'h-stage', 'pending', state.hStage === 'pending' ? 'active' : '')}</div><div class="h-section-head"><h3>Обращения · ${filteredLeads.length}</h3>${state.hStage !== 'all' ? btn('Все', 'h-stage', 'all') : ''}</div><div class="h-leads">${filteredLeads.map((l) => `<button data-action="lead" data-value="${l.id}" class="${state.focus === l.id ? 'active' : ''}"><span>${l.id} · ${esc(customer(l.customer).name.replace('Демо · ', ''))}</span><small>${l.status} · ${l.response == null ? 'ответ неизвестен' : l.response + ' мин до ответа'} →</small></button>`).join('') || '<p>На этом этапе обращений нет.</p>'}</div>` : '<div class="empty"><h3>Нет строк для исследования</h3><p>Сбросьте поиск или измените источник.</p></div>'}</aside></section>
  ${hComparison(allRows)}${v && state.focus ? `<div class="h-details">${inspector(v)}</div>` : ''}<details class="h-method"><summary>Как читать эффективность и сравнение</summary><div><p><b>В заказ</b> — доля обращений хотя бы с одним подтверждённым заказом. Квалификация — отметка о соответствии запроса профилю. Источник первого привлечения и источник заказа показаны в карточке отдельно.</p><p><b>Сравнение</b> — предыдущие равные 7 дней: для 25–31.08 это 18–24.08, для 01–07.09 это 25–31.08. У 18–24.08 предыдущего среза нет. Проценты — изменение показателя, не оценка «хорошо/плохо». Для незрелой недели выводы о конечной экономике заблокированы.</p><p><b>Оплаты</b> — уникальные платежи связанных заказов к 09.09, а не выручка периода. Процент изменения накопленных оплат не показываем: возраст когорт различается. Сумма заказа и расчётная прибыль — отдельные показатели. ROMI недоступен: неизвестен полный состав затрат. Кампании — учебные группы объявлений, не подключённый рекламный кабинет.</p><p><b>Полнота</b> — расходы Директа неполные, VK устарел, неизвестная связь исключена из денег. Поиск действительно ограничивает таблицу, итог, воронку и сравнение. Все данные вымышлены.</p></div></details></main></div>`;
}
function render() {
  if (state.concept === 'simple') {
    mountReal(app);
    return;
  }
  if (state.concept === 'performance-demo') {
    mountPerformance(app);
    return;
  }
  if (state.concept === 'simple-archive') {
    mountSimple(app);
    return;
  }
  const focused = document.activeElement;
  state = normalizeState(state);
  const v = select(state),
    c = concepts.find((c) => c.id === state.concept);
  const available = ads.filter(
    (a) => state.source === 'all' || a.source === state.source,
  );
  document.title = `${state.concept === 'hybrid' ? 'Эффективность источников' : c?.name || 'Сравнение'} · Аналитика Мастерской`;
  app.innerHTML =
    state.concept === 'hybrid'
      ? hybridPage()
      : `<header class="brandbar"><a href="#" data-action="concept" data-value="compare" class="brand"><span class="brandmark">М</span><span>МАСТЕРСКАЯ<small>Лаборатория аналитики</small></span></a><span class="demo-pill">ВЫМЫШЛЕННЫЕ ДАННЫЕ</span>${btn('Сравнить концепции ↗', 'concept', 'compare', 'compare-button')}</header>
    <nav class="concept-nav" aria-label="Пять концепций">${concepts.map((item) => `<button data-action="concept" data-value="${item.id}" class="${state.concept === item.id ? 'active' : ''}" aria-current="${state.concept === item.id ? 'page' : 'false'}"><span>${item.n}</span><div><b>${item.name}</b><small>${item.short}</small></div></button>`).join('')}</nav>
    <main class="theme-${state.concept}"><div class="demo-banner"><span>ДЕМО</span> Все числа, компании, обращения и связи здесь вымышлены. В рабочем модуле подключён Авито; Директ, VK, Telegram, сайты и сквозные связи пока не подключены.</div>
    ${c ? `<div class="page-heading"><div><span class="eyebrow">${c.n} / ${c.name}</span><h1>${c.title}</h1><p>${c.desc}</p></div><details class="about-concept"><summary>Об этом подходе</summary><p><b>Сценарий:</b> ${c.scenario}</p><p>${c.strength}</p><p><b>Ограничение:</b> ${c.limit}</p><p><b>Нужны:</b> ${c.need}</p></details></div>` : ''}
    <section class="context-panel" aria-label="Общий контекст исследования"><div class="filters"><label>Источник обращения<select id="source"><option value="all" ${state.source === 'all' ? 'selected' : ''}>Все источники</option>${Object.entries(
      sources,
    )
      .map(
        ([id, name]) =>
          `<option value="${id}" ${state.source === id ? 'selected' : ''}>${name}</option>`,
      )
      .join(
        '',
      )}</select></label><label>Объявление<select id="ad"><option value="all">Все объявления</option>${available.map((a) => `<option value="${a.id}" ${state.ad === a.id ? 'selected' : ''}>${esc(a.title)}</option>`).join('')}</select></label><label>Неделя обращения<select id="period">${Object.entries(
      periods,
    )
      .map(
        ([id, p]) =>
          `<option value="${id}" ${state.period === id ? 'selected' : ''}>${p.label}</option>`,
      )
      .join(
        '',
      )}</select></label>${btn('Сбросить', 'reset', '', 'reset')}</div><div class="context-line"><span>${sourceLabel(state.source)} → ${ads.find((a) => a.id === state.ad)?.title || 'все объявления'} · ${periods[state.period].label}</span><b>На 09.09.2026</b></div>${totals(v)}</section>
    ${state.concept === 'compare' ? comparePage() : { map, desk, story, matrix, actions }[state.concept](v)}
    <footer class="panel definitions"><details><summary>Что означают числа и ограничения</summary><div class="definition-grid"><p><b>Нет данных ≠ 0.</b> Прочерк означает отсутствие значения. В «Табличках для офиса» расходы и контакты действительно равны нулю в учебном отчёте.</p><p><b>Неполный импорт.</b> У Директа неизвестны расходы. Известные части не выдаются за полную сумму. У VK устаревший снимок; числа относятся к выбранному историческому периоду.</p><p><b>Одна сумма — один раз.</b> Заказы и платежи считаются по уникальным идентификаторам через подтверждённые связи. Срезы разных объявлений могут пересекаться и не складываются.</p><p><b>Деньги и прибыль.</b> Сумма заказа, накопленные оплаты и расчётная прибыль различаются. Рекламные расходы кабинета не складываются с пополнениями или выплатами из кассы. Бонусы не превращаются в деньги.</p><p><b>Источник.</b> Фильтр относится к конкретному обращению. Первое привлечение клиента и источник заказа показаны отдельно. Повторное обращение не означает нового клиента.</p><p><b>Границы периода.</b> Итог — когорта обращений за неделю с накопленными заказами и оплатами к 09.09. Матрица ограничивает результат первыми 7 днями. Малая выборка — меньше 10, учебный порог, не критерий статистической значимости.</p></div></details><p>Пять концепций · локальный прототип · без подключения к рабочим данным</p></footer></main>`;
  const persist = { ...state };
  try {
    sessionStorage.setItem(
      'analytics-concepts-context',
      JSON.stringify(persist),
    );
  } catch {
    /* Private mode may disable storage; navigation still works. */
  }
  history.replaceState(
    null,
    '',
    '#' +
      new URLSearchParams({
        concept: state.concept,
        source: state.source,
        ad: state.ad,
        period: state.period,
        ...(state.focus ? { focus: state.focus } : {}),
        ...(state.concept === 'hybrid'
          ? { hSelected: state.hSelected, hGroup: state.hGroup }
          : {}),
      }),
  );
  const nextFocus = focused?.id
    ? document.getElementById(focused.id)
    : focused?.dataset?.action
      ? [...app.querySelectorAll('[data-action]')].find(
          (el) =>
            el.dataset.action === focused.dataset.action &&
            el.dataset.value === focused.dataset.value,
        )
      : focused?.dataset?.hcompare
        ? [...app.querySelectorAll('[data-hcompare]')].find(
            (el) => el.dataset.hcompare === focused.dataset.hcompare,
          )
        : focused?.dataset?.compare
          ? [...app.querySelectorAll('[data-compare]')].find(
              (el) => el.dataset.compare === focused.dataset.compare,
            )
          : null;
  nextFocus?.focus({ preventScroll: true });
}
function focusEvidence() {
  document
    .querySelector('#evidence')
    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
app.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  event.preventDefault();
  const action = target.dataset.action,
    value = target.dataset.value;
  if (action.startsWith('h-')) {
    if (action === 'h-select') {
      state.hSelected = value;
      state.hStage = 'all';
      state.focus = null;
      state.order = null;
    }
    if (action === 'h-stage') {
      state.hStage = value;
      state.focus = null;
      state.order = null;
    }
    if (action === 'h-set') state.hSet = value;
    if (action === 'h-direction')
      state.hDir = state.hDir === 'desc' ? 'asc' : 'desc';
    if (action === 'h-sort') {
      state.hDir =
        state.hSort === value && state.hDir === 'desc' ? 'asc' : 'desc';
      state.hSort = value;
    }
    if (action === 'h-toggle')
      state.hClosed = state.hClosed.includes(value)
        ? state.hClosed.filter((k) => k !== value)
        : [...state.hClosed, value];
    if (action === 'h-expand')
      state.hClosed = state.hClosed.length
        ? []
        : hybridRows(state, false)
            .filter((r) => r.kind !== 'ad')
            .map((r) => r.key);
    if (action === 'h-clear') {
      state.hCompare = [];
      state.hNotice = '';
    }
    if (action === 'h-reset')
      state = {
        ...defaultState,
        ...hybridDefaults,
        concept: 'hybrid',
        source: 'all',
      };
    if (action === 'h-comparison') {
      document
        .querySelector('#h-comparison')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    render();
    if (action === 'h-select' && window.innerWidth <= 800)
      document
        .querySelector('.h-investigation')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (action === 'concept') {
    state.concept = value;
    if (value === 'hybrid') {
      state.source = 'all';
      state.ad = 'all';
      state.focus = null;
    }
    render();
    window.scrollTo(0, 0);
    return;
  }
  if (action === 'ad') {
    state.ad = value;
    state.focus = null;
    state.order = null;
    state.stage = 'leads';
  }
  if (action === 'lead') {
    state.focus = value;
    state.order = null;
  }
  if (action === 'order') state.order = value;
  if (action === 'stage') state.stage = value;
  if (action === 'mapOrder') {
    state.order = value;
    state.focus = select(state).rows.find((l) =>
      links.some((e) => e.lead === l.id && e.order === value && e.confirmed),
    )?.id;
  }
  if (action === 'cell') {
    [state.source, state.period] = value.split(':');
    state.focus = null;
    state.order = null;
  }
  if (action === 'signal') {
    activeSignal = value;
    state.focus = null;
    state.order = null;
  }
  if (action === 'reset') state = { ...defaultState, concept: state.concept };
  if (action === 'clearCompare') state.compare = [];
  if (action === 'save') {
    try {
      localStorage.setItem('analytics-concepts-saved', JSON.stringify(state));
      notice = 'Исследование сохранено.';
    } catch {
      notice = 'Браузер запретил сохранение. Контекст доступен в ссылке.';
    }
  }
  if (action === 'restore') {
    try {
      const saved = JSON.parse(
        localStorage.getItem('analytics-concepts-saved') || 'null',
      );
      if (saved) {
        state = normalizeState({ ...saved, concept: 'desk' });
        notice = 'Сохранённое исследование восстановлено.';
      } else notice = 'Сохранённых исследований пока нет.';
    } catch {
      notice = 'Не удалось прочитать сохранённый контекст.';
    }
  }
  render();
  if (['lead', 'order', 'mapOrder'].includes(action)) focusEvidence();
});
app.addEventListener('change', (event) => {
  const el = event.target;
  if (el.dataset.hcompare) {
    const key = el.dataset.hcompare,
      kind = key.split(':')[0];
    if (!el.checked) state.hCompare = state.hCompare.filter((k) => k !== key);
    else {
      if (state.hCompare.length && state.hCompare[0].split(':')[0] !== kind) {
        state.hCompare = [];
        state.hNotice =
          'Сравнение переключено на один уровень: ' +
          { source: 'источники', campaign: 'кампании', ad: 'объявления' }[
            kind
          ] +
          '.';
      }
      if (state.hCompare.length < 3) state.hCompare = [...state.hCompare, key];
      else
        state.hNotice =
          'Можно сравнить до трёх строк. Снимите один флажок, чтобы добавить другую.';
    }
    render();
    return;
  }
  if (['hGroup', 'hSort', 'hPrevious'].includes(el.id)) {
    state[el.id] = el.id === 'hPrevious' ? el.checked : el.value;
    render();
    return;
  }
  if (el.dataset.compare) {
    const id = el.dataset.compare;
    state.compare = el.checked
      ? [...state.compare.filter((x) => x !== id).slice(-1), id]
      : state.compare.filter((x) => x !== id);
    render();
    return;
  }
  if (['source', 'ad', 'period', 'lens'].includes(el.id)) {
    state[el.id] = el.value;
    if (el.id === 'source') {
      state.ad = 'all';
      state.compare = [];
      state.hCompare = [];
    }
    if (el.id !== 'lens') {
      state.focus = null;
      state.order = null;
    }
    render();
  }
});
app.addEventListener('submit', (event) => {
  if (event.target.id !== 'h-search-form') return;
  event.preventDefault();
  state.hSearch = document.querySelector('#hSearch').value.trim();
  state.hCompare = [];
  state.focus = null;
  state.order = null;
  render();
});
window.addEventListener('hashchange', () => {
  state = normalizeState({
    ...state,
    ...Object.fromEntries(new URLSearchParams(location.hash.slice(1))),
  });
  render();
});
render();
