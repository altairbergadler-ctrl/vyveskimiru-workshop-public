// Fictional, consistent demo cohort. Each inquiry has at most one attributed order.
export const performanceSources = {
  avito: 'Авито',
  direct: 'Яндекс',
  vk: 'VK',
  unknown: 'Не указан',
};
export const products = {
  signs: 'Вывески',
  letters: 'Объёмные буквы',
  plates: 'Таблички',
  windows: 'Оформление витрин',
  unknown: 'Не указан',
};
export const stages = [
  'Заявки',
  'Целевые',
  'Расчёт отправлен',
  'Заказ',
  'Есть оплата',
];
const specs = [
  [
    'a1',
    'avito',
    'signs',
    'Световые вывески для магазинов',
    18000,
    2400,
    [24, 18, 12, 6, 5],
    80000,
  ],
  [
    'a2',
    'avito',
    'letters',
    'Объёмные буквы с монтажом',
    14400,
    1800,
    [18, 12, 8, 3, 2],
    60000,
  ],
  [
    'a3',
    'avito',
    'plates',
    'Таблички и навигация для офиса',
    6500,
    1100,
    [22, 14, 11, 8, 7],
    12000,
  ],
  [
    'd1',
    'direct',
    'signs',
    'Вывеска под ключ · поиск',
    26000,
    1900,
    [20, 14, 9, 4, 3],
    95000,
  ],
  [
    'v1',
    'vk',
    'windows',
    'Оформление витрин к открытию',
    12000,
    1500,
    [16, 9, 5, 2, 1],
    45000,
  ],
  [
    'v2',
    'vk',
    'plates',
    'Таблички для небольших компаний',
    null,
    800,
    [9, 5, 3, 1, 1],
    16000,
  ],
];
export const performanceAds = specs.map(
  ([id, source, product, title, spend, views]) => ({
    id,
    source,
    product,
    title,
    spend: spend == null ? null : spend * 100,
    views,
  }),
);
export const performanceLeads = [];
export const performanceOrders = [];
for (const [ad, source, product, , spend, views, counts, amount] of specs) {
  void spend;
  void views;
  for (let i = 0; i < counts[0]; i++) {
    const rank = counts.reduce((s, n, k) => (i < n ? k : s), 0);
    const id = `${ad.toUpperCase()}-${String(i + 1).padStart(2, '0')}`;
    const lost = rank < 3 && i % 2 === 0;
    const lead = {
      id,
      source,
      product,
      ad,
      rank,
      lost,
      date: `2026-08-${25 + (i % 7)}`,
      customer: `Демо-компания ${id}`,
      reason: lost
        ? [
            'Запрос вне профиля',
            'Не согласован бюджет',
            'Выбрали другого подрядчика',
          ][rank]
        : null,
    };
    performanceLeads.push(lead);
    if (rank >= 3)
      performanceOrders.push({
        id: `З-${id}`,
        lead: id,
        source,
        product,
        ad,
        amount: amount * 100,
        paid:
          rank === 4 ? Math.round(amount * 100 * (i % 2 === 0 ? 1 : 0.5)) : 0,
      });
  }
}
performanceOrders.push(
  {
    id: 'З-201',
    lead: null,
    source: 'avito',
    product: 'letters',
    ad: null,
    amount: 4000000,
    paid: 2000000,
  },
  {
    id: 'З-202',
    lead: null,
    source: 'unknown',
    product: 'unknown',
    ad: null,
    amount: 2000000,
    paid: 1000000,
  },
);
export function performanceSlice(scope = {}) {
  const match = (x) =>
    ['source', 'product', 'ad'].every(
      (key) =>
        scope[key] == null ||
        scope[key] === 'all' ||
        (scope[key] === 'none' ? x[key] == null : x[key] === scope[key]),
    );
  const ads = performanceAds.filter((a) => match({ ...a, ad: a.id })),
    leads = performanceLeads.filter(match),
    orders = performanceOrders.filter(match);
  const funnel = stages.map(
    (_, rank) => leads.filter((l) => l.rank >= rank).length,
  );
  const spend =
    ads.length && ads.every((a) => a.spend != null)
      ? ads.reduce((s, a) => s + a.spend, 0)
      : null;
  const paid = orders.reduce((s, o) => s + o.paid, 0);
  const adOrders = orders.filter((o) => o.ad);
  const attributedPaid = adOrders.reduce((s, o) => s + o.paid, 0);
  const knownSpend = ads.reduce((s, a) => s + (a.spend || 0), 0);
  return {
    ads,
    leads,
    orders,
    adOrders,
    attributedPaid,
    funnel,
    spend,
    knownSpend,
    paid,
    views: ads.reduce((s, a) => s + a.views, 0),
    cpl: spend != null && leads.length ? spend / leads.length : null,
    cpo: spend != null && adOrders.length ? spend / adOrders.length : null,
    cr: leads.length ? (funnel[3] / leads.length) * 100 : null,
    payback: spend > 0 ? attributedPaid / spend : null,
    unlinked: orders.filter((o) => !o.lead),
    unassigned: orders.filter((o) => !o.ad),
    lost: leads.filter((l) => l.lost).length,
  };
}
export function performanceRows(group, filters = {}) {
  const catalog =
    group === 'source'
      ? Object.entries(performanceSources)
      : group === 'product'
        ? Object.entries(products)
        : [
            ...performanceAds.map((a) => [a.id, a.title]),
            ['none', 'Без объявления'],
          ];
  return catalog
    .map(([id, label]) => {
      if (filters[group] && filters[group] !== 'all' && filters[group] !== id)
        return null;
      const scope = { ...filters, [group]: id };
      return { id, label, scope, ...performanceSlice(scope) };
    })
    .filter((r) => r && (r.ads.length || r.leads.length || r.orders.length));
}
export function performanceSort(rows, key, descending) {
  return [...rows].sort((a, b) => {
    if (key === 'label')
      return a.label.localeCompare(b.label, 'ru') * (descending ? -1 : 1);
    const value = (r) =>
      key === 'leads' || key === 'orders' ? r[key].length : r[key];
    const av = value(a),
      bv = value(b);
    return av == null
      ? bv == null
        ? 0
        : 1
      : bv == null
        ? -1
        : (av - bv) * (descending ? -1 : 1);
  });
}
export function performanceStageRows(slice, rank, drop = false) {
  return slice.leads.filter((l) => (drop ? l.rank === rank : l.rank >= rank));
}
