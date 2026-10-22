import {
  efficiency,
  sumKnown,
} from '../../server/analytics/advertising-metrics.mjs';

// Entirely fictional fixtures. Ad money follows the existing contract: integer kopecks.
export const sources = {
  avito: 'Авито',
  direct: 'Яндекс Директ',
  vk: 'VK',
  telegram: 'Telegram',
  site: 'Сайт',
  unknown: 'Неизвестный источник',
};
export const periods = {
  mature: {
    label: '25–31 авг · зрелая когорта',
    from: '2026-08-25',
    to: '2026-08-31',
    mature: true,
  },
  previous: {
    label: '18–24 авг · предыдущие 7 дней',
    from: '2026-08-18',
    to: '2026-08-24',
    mature: true,
  },
  recent: {
    label: '1–7 сен · ещё созревает',
    from: '2026-09-01',
    to: '2026-09-07',
    mature: false,
  },
};
export const ads = [
  {
    id: 'a1',
    source: 'avito',
    title: 'Вывески для небольших кафе',
    campaign: 'Вывески / локальный бизнес',
    state: 'ready',
    metrics: { impressions: 12600, views: 630, contacts: 21, spending: 840000 },
    previous: {
      impressions: 11800,
      views: 590,
      contacts: 16,
      spending: 800000,
    },
  },
  {
    id: 'a2',
    source: 'avito',
    title: 'Объёмные буквы с монтажом',
    campaign: 'Вывески / локальный бизнес',
    state: 'ready',
    metrics: { impressions: 9100, views: 410, contacts: 10, spending: 720000 },
    previous: { impressions: 9600, views: 450, contacts: 12, spending: 660000 },
  },
  {
    id: 'a3',
    source: 'avito',
    title: 'Таблички для офиса',
    campaign: 'Интерьер / малые тиражи',
    state: 'ready',
    metrics: { impressions: 1400, views: 80, contacts: 0, spending: 0 },
    previous: { impressions: 1300, views: 70, contacts: 0, spending: 0 },
  },
  {
    id: 'd1',
    source: 'direct',
    title: 'Наружная реклама · поиск',
    campaign: 'Поиск / город',
    state: 'partial',
    metrics: { impressions: 7200, views: 310, contacts: null, spending: null },
    previous: {
      impressions: 8000,
      views: 340,
      contacts: null,
      spending: 920000,
    },
  },
  {
    id: 'v1',
    source: 'vk',
    title: 'Оформление витрин',
    campaign: 'Сообщества / предприниматели',
    state: 'stale',
    metrics: {
      impressions: 4500,
      views: 230,
      contacts: null,
      spending: 360000,
    },
    previous: {
      impressions: 4300,
      views: 210,
      contacts: null,
      spending: 330000,
    },
  },
];
export const customers = [
  { id: 'c1', name: 'Демо · Кафе «Маяк»', first: 'avito' },
  { id: 'c2', name: 'Демо · Студия «Лён»', first: 'avito' },
  { id: 'c3', name: 'Демо · Пекарня «Слой»', first: 'direct' },
  { id: 'c4', name: 'Демо · Цветы «Ирис»', first: 'vk' },
  { id: 'c5', name: 'Демо · Бюро «Точка»', first: 'unknown' },
];
const lead = (
  id,
  customer,
  ad,
  date,
  status,
  response,
  qualified,
  repeat,
  reason = '',
) => ({
  id,
  customer,
  ad,
  source: ads.find((a) => a.id === ad)?.source || 'unknown',
  date,
  status,
  response,
  qualified,
  repeat,
  reason,
});
export const leads = [
  lead('L01', 'c1', 'a1', '2026-08-25', 'Заказ', 12, true, true),
  lead('L02', 'c1', 'a2', '2026-08-26', 'Заказ', 35, true, true),
  lead(
    'L03',
    'c2',
    'a1',
    '2026-08-27',
    'Потеря',
    180,
    true,
    true,
    'Клиент выбрал срок короче нашего; причина записана менеджером',
  ),
  lead('L04', 'c3', 'd1', '2026-08-28', 'Заказ', 18, true, true),
  lead(
    'L05',
    'c4',
    'v1',
    '2026-08-29',
    'Уточнение',
    95,
    false,
    true,
    'Не хватает размеров витрины',
  ),
  lead(
    'L06',
    'c5',
    null,
    '2026-08-29',
    'Спорная связь',
    null,
    true,
    false,
    'Совпадает название; контакта для проверки нет',
  ),
  lead('L07', 'c3', 'a2', '2026-08-30', 'Заказ', 22, true, true),
  lead(
    'L08',
    'c2',
    'a2',
    '2026-08-31',
    'Потеря',
    9,
    false,
    true,
    'Запрос вне нашего профиля',
  ),
  lead('P01', 'c1', 'a1', '2026-08-18', 'Заказ', 20, true, false),
  lead(
    'P02',
    'c2',
    'a2',
    '2026-08-20',
    'Потеря',
    120,
    true,
    false,
    'Не согласован бюджет',
  ),
  lead('P03', 'c3', 'd1', '2026-08-22', 'Уточнение', 45, true, false),
  lead(
    'P04',
    'c4',
    'v1',
    '2026-08-24',
    'Потеря',
    30,
    false,
    false,
    'Нет подходящей технологии',
  ),
  lead('N01', 'c1', 'a1', '2026-09-02', 'Уточнение', 15, true, true),
  lead('N02', 'c2', 'a2', '2026-09-05', 'Ожидает ответа', null, false, true),
  lead('N03', 'c3', 'd1', '2026-09-07', 'Уточнение', 40, true, true),
];
export const orders = [
  {
    id: 'O101',
    customer: 'c1',
    source: 'avito',
    date: '2026-08-27',
    amount: 12000000,
    profit: 3200000,
    status: 'В производстве',
  },
  {
    id: 'O102',
    customer: 'c3',
    source: 'direct',
    date: '2026-08-29',
    amount: 8000000,
    profit: 2100000,
    status: 'Готов',
  },
  {
    id: 'O103',
    customer: 'c3',
    source: 'direct',
    date: '2026-08-30',
    amount: 4000000,
    profit: null,
    status: 'Согласование',
  },
  {
    id: 'O104',
    customer: 'c3',
    source: 'avito',
    date: '2026-08-31',
    amount: 6000000,
    profit: 1500000,
    status: 'В производстве',
  },
  {
    id: 'O100',
    customer: 'c1',
    source: 'avito',
    date: '2026-08-20',
    amount: 5000000,
    profit: 1000000,
    status: 'Завершён',
  },
];
export const links = [
  { lead: 'L01', order: 'O101', confirmed: true },
  { lead: 'L02', order: 'O101', confirmed: true },
  { lead: 'L04', order: 'O102', confirmed: true },
  { lead: 'L04', order: 'O103', confirmed: true },
  { lead: 'L07', order: 'O104', confirmed: true },
  { lead: 'L06', order: 'O101', confirmed: false },
  { lead: 'P01', order: 'O100', confirmed: true },
];
export const payments = [
  { id: 'T1', order: 'O101', date: '2026-08-28', amount: 6000000 },
  { id: 'T2', order: 'O101', date: '2026-09-04', amount: 3000000 },
  { id: 'T3', order: 'O102', date: '2026-08-30', amount: 8000000 },
  { id: 'T4', order: 'O104', date: '2026-09-03', amount: 3000000 },
  { id: 'T5', order: 'O100', date: '2026-08-24', amount: 5000000 },
];
export const orderEvents = {
  O101: [
    { date: '2026-08-27', stage: 'Макет согласован' },
    { date: '2026-08-28', stage: 'Передан в производство' },
  ],
  O102: [
    { date: '2026-08-29', stage: 'Макет согласован' },
    { date: '2026-08-31', stage: 'Изготовление завершено' },
  ],
  O103: [{ date: '2026-08-30', stage: 'Макет на согласовании' }],
  O104: [
    { date: '2026-08-31', stage: 'Макет согласован' },
    { date: '2026-09-02', stage: 'Передан в производство' },
  ],
  O100: [
    { date: '2026-08-20', stage: 'Макет согласован' },
    { date: '2026-08-24', stage: 'Заказ передан клиенту' },
  ],
};
export const defaultState = {
  concept: 'map',
  source: 'avito',
  ad: 'all',
  period: 'mature',
  focus: null,
  order: null,
  stage: 'leads',
  compare: [],
  lens: 'conversion',
  saved: false,
};
export function adMetrics(ad, period) {
  if (period === 'previous') return ad.previous;
  if (period === 'recent')
    return Object.fromEntries(
      Object.entries(ad.metrics).map(([k, v]) => [
        k,
        v == null ? null : Math.floor(v / 2),
      ]),
    );
  return ad.metrics;
}
export function select(state) {
  const period = periods[state.period];
  const matches = (a) =>
    (!state.campaign ||
      state.campaign === 'all' ||
      a.campaign === state.campaign) &&
    (!state.hSearch ||
      `${sources[a.source]} ${a.campaign} ${a.title}`
        .toLocaleLowerCase('ru')
        .includes(state.hSearch.toLocaleLowerCase('ru')));
  const catalog = ads.filter(
    (a) =>
      (state.source === 'all' || a.source === state.source) &&
      (state.ad === 'all' || a.id === state.ad) &&
      matches(a),
  );
  const rows = leads.filter(
    (l) =>
      l.date >= period.from &&
      l.date <= period.to &&
      (state.source === 'all' || l.source === state.source) &&
      (state.ad === 'all' || l.ad === state.ad) &&
      (((!state.campaign || state.campaign === 'all') && !state.hSearch) ||
        (l.ad
          ? catalog.some((a) => a.id === l.ad)
          : (!state.campaign || state.campaign === 'all') &&
            sources[l.source]
              .toLocaleLowerCase('ru')
              .includes(state.hSearch.toLocaleLowerCase('ru')))),
  );
  const edges = links.filter((e) => rows.some((l) => l.id === e.lead));
  const connected = orders.filter((o) =>
    edges.some((e) => e.confirmed && e.order === o.id),
  );
  const paid = payments.filter((p) => connected.some((o) => o.id === p.order));
  const metrics = Object.fromEntries(
    ['impressions', 'views', 'contacts', 'spending'].map((k) => [
      k,
      sumKnown(catalog.map((a) => adMetrics(a, state.period)[k])),
    ]),
  );
  const converted = rows.filter((l) =>
    edges.some((e) => e.lead === l.id && e.confirmed),
  ).length;
  return {
    catalog,
    rows,
    edges,
    connected,
    paid,
    metrics,
    rates: efficiency(metrics),
    converted,
    conversion: rows.length ? (converted / rows.length) * 100 : null,
    paidTotal: paid.reduce((s, p) => s + p.amount, 0),
    orderTotal: connected.reduce((s, o) => s + o.amount, 0),
    qualified: rows.filter((l) => l.qualified).length,
    lost: rows.filter((l) => l.status === 'Потеря').length,
    pending: rows.filter((l) => !['Потеря', 'Заказ'].includes(l.status)).length,
    spendOrder:
      period.mature && connected.length && metrics.spending != null
        ? metrics.spending / 100 / connected.length
        : null,
  };
}
export function normalizeState(input = {}) {
  const s = { ...defaultState, ...input };
  if (
    ![
      'map',
      'desk',
      'story',
      'matrix',
      'actions',
      'compare',
      'hybrid',
      'simple',
      'simple-archive',
      'performance-demo',
    ].includes(s.concept)
  )
    s.concept = 'map';
  if (!Object.hasOwn(sources, s.source) && s.source !== 'all')
    s.source = 'avito';
  if (!Object.hasOwn(periods, s.period)) s.period = 'mature';
  if (
    !ads.some(
      (a) => a.id === s.ad && (s.source === 'all' || a.source === s.source),
    )
  )
    s.ad = 'all';
  s.compare = Array.isArray(s.compare)
    ? s.compare.filter((id) => ads.some((a) => a.id === id)).slice(0, 2)
    : [];
  if (!['ads', 'leads', 'orders', 'payments'].includes(s.stage))
    s.stage = 'leads';
  if (!['conversion', 'quality', 'cost'].includes(s.lens))
    s.lens = 'conversion';
  if (s.concept !== 'hybrid') {
    s.campaign = 'all';
    s.hSearch = '';
  }
  const view = select(s);
  if (!view.rows.some((l) => l.id === s.focus)) s.focus = null;
  if (!view.connected.some((o) => o.id === s.order)) s.order = null;
  return s;
}

export const hybridDefaults = {
  hGroup: 'source',
  hSet: 'result',
  hSort: 'spending',
  hDir: 'desc',
  hSelected: 'source:avito',
  hStage: 'all',
  hCompare: [],
  hClosed: [],
  hSearch: '',
  hPrevious: true,
  hNotice: '',
};
export function hybridScope(key) {
  if (key.startsWith('ad:')) {
    const a = ads.find((a) => a.id === key.slice(3));
    return a ? { source: a.source, ad: a.id, campaign: 'all' } : null;
  }
  if (key.startsWith('source:')) {
    const source = key.slice(7);
    return Object.hasOwn(sources, source)
      ? { source, ad: 'all', campaign: 'all' }
      : null;
  }
  if (key.startsWith('campaign:')) {
    const a = ads.find((a) => `${a.source}:${a.campaign}` === key.slice(9));
    return a ? { source: a.source, ad: 'all', campaign: a.campaign } : null;
  }
  return null;
}
export function hybridSlice(state, key = null, period = state.period) {
  const scope = key
    ? hybridScope(key)
    : { source: state.source, ad: 'all', campaign: 'all' };
  if (!scope) return null;
  const v = select({ ...state, ...scope, period });
  const paidLeadIds = v.rows
    .filter((l) =>
      v.edges.some(
        (e) =>
          e.confirmed &&
          e.lead === l.id &&
          v.paid.some((p) => p.order === e.order),
      ),
    )
    .map((l) => l.id);
  return {
    ...v,
    paidLeadIds,
    quality: v.rows.length ? (v.qualified / v.rows.length) * 100 : null,
    repeat: v.rows.filter((l) => l.repeat).length,
    previousPeriod:
      period === 'mature' ? 'previous' : period === 'recent' ? 'mature' : null,
    stale: v.catalog.some((a) => a.state === 'stale'),
    partial: v.catalog.some((a) => a.state === 'partial'),
  };
}
export function hybridValue(v, key) {
  return {
    spending: v.metrics.spending,
    impressions: v.metrics.impressions,
    views: v.metrics.views,
    contacts: v.metrics.contacts,
    costContact: v.rates.costContact,
    leads: v.rows.length,
    conversion: v.conversion,
    cost: v.spendOrder,
    paid: v.paidTotal,
    quality: v.quality,
    repeat: v.repeat,
    lost: v.lost,
    orders: v.connected.length,
  }[key];
}
export function hybridRows(state, visibleOnly = true) {
  const global = hybridSlice(state),
    rows = [];
  const sorter = (a, b) => {
    if (state.hSort === 'name')
      return (
        a.label.localeCompare(b.label, 'ru') * (state.hDir === 'asc' ? 1 : -1)
      );
    const av = hybridValue(a.view, state.hSort),
      bv = hybridValue(b.view, state.hSort);
    if (av == null)
      return bv == null ? a.label.localeCompare(b.label, 'ru') : 1;
    if (bv == null) return -1;
    return (
      (av - bv) * (state.hDir === 'asc' ? 1 : -1) ||
      a.label.localeCompare(b.label, 'ru')
    );
  };
  const make = (key, label, kind, depth) => ({
    key,
    label,
    kind,
    depth,
    view: hybridSlice(state, key),
  });
  const sourceRows = Object.keys(sources)
    .filter(
      (s) =>
        (state.source === 'all' || state.source === s) &&
        (!state.hSearch ||
          global.catalog.some((a) => a.source === s) ||
          global.rows.some((l) => l.source === s)),
    )
    .map((s) => make('source:' + s, sources[s], 'source', 0))
    .sort(sorter);
  if (state.hGroup === 'ads') {
    return [
      ...global.catalog.map((a) => make('ad:' + a.id, a.title, 'ad', 0)),
      ...sourceRows
        .filter((s) => s.view.rows.some((l) => !l.ad))
        .map((s) => ({ ...s, label: 'Без объявления · ' + s.label })),
    ].sort(sorter);
  }
  for (const source of sourceRows) {
    rows.push(source);
    if (visibleOnly && state.hClosed.includes(source.key)) continue;
    const catalog = global.catalog.filter(
      (a) => a.source === source.key.slice(7),
    );
    if (state.hGroup === 'campaign') {
      const campaigns = [...new Set(catalog.map((a) => a.campaign))]
        .map((c) =>
          make(`campaign:${source.key.slice(7)}:${c}`, c, 'campaign', 1),
        )
        .sort(sorter);
      for (const c of campaigns) {
        rows.push(c);
        if (visibleOnly && state.hClosed.includes(c.key)) continue;
        rows.push(
          ...catalog
            .filter((a) => a.campaign === c.label)
            .map((a) => make('ad:' + a.id, a.title, 'ad', 2))
            .sort(sorter),
        );
      }
    } else
      rows.push(
        ...catalog
          .map((a) => make('ad:' + a.id, a.title, 'ad', 1))
          .sort(sorter),
      );
  }
  return rows;
}
export function hybridLeadRows(v, stage) {
  return v.rows.filter(
    (l) =>
      stage === 'all' ||
      (stage === 'qualified' && l.qualified) ||
      (stage === 'ordered' &&
        v.edges.some((e) => e.confirmed && e.lead === l.id)) ||
      (stage === 'paid' && v.paidLeadIds.includes(l.id)) ||
      (stage === 'lost' && l.status === 'Потеря') ||
      (stage === 'pending' && !['Потеря', 'Заказ'].includes(l.status)),
  );
}
