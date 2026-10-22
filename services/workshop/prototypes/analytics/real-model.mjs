// Read-only projection of existing authenticated reports. No speculative order attribution.
export function productFromNames(names, catalog = []) {
  const found = new Set(
    names.map((name) => {
      const matches = catalog.filter(
        (p) => p.name === String(name || '').trim(),
      );
      return matches.length === 1 ? matches[0].id : 'unknown';
    }),
  );
  return found.size === 1
    ? [...found][0]
    : found.size > 1
      ? 'mixed'
      : 'unknown';
}
function productFromItems(order, catalog) {
  const names = (order.items || []).map((item) => {
    const key = `position:${order.id}:${item.row}`;
    const links = (catalog.positions || []).filter(
      (p) => p.sourcePosition === key && p.name === item.name,
    );
    if (
      links.length === 1 &&
      catalog.products.some((p) => p.id === links[0].productId)
    )
      return links[0].productId;
    return productFromNames([item.name], catalog.products);
  });
  const ids = new Set(names);
  return ids.size === 1 ? [...ids][0] : ids.size > 1 ? 'mixed' : 'unknown';
}
const cents = (v) =>
  typeof v === 'number' &&
  Number.isFinite(v) &&
  Number.isSafeInteger(Math.round(v * 100))
    ? Math.round(v * 100)
    : null;
const whole = (v) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const sum = (rows, key) =>
  rows.length && rows.every((r) => r[key] != null)
    ? rows.reduce((s, r) => s + r[key], 0)
    : null;
export function realModel(adReport, business, inquiries, routeCatalog = null) {
  const catalogAvailable =
    Array.isArray(routeCatalog?.products) &&
    routeCatalog.source !== 'unavailable';
  const catalog = {
    products: catalogAvailable ? routeCatalog.products : [],
    positions: routeCatalog?.positions || [],
  };
  const products = Object.fromEntries([
    ...catalog.products.map((p) => [p.id, p.name]),
    ['mixed', 'Несколько видов'],
    ['unknown', 'Без привязки к продукции'],
  ]);
  const period = {
    from: adReport?.period?.dateFrom,
    to: adReport?.period?.dateTo,
  };
  const ads = (adReport?.rows || []).map((a) => ({
    id: String(a.id),
    title: String(a.title || `Объявление ${a.id}`),
    product: catalog.products.some((p) => p.id === a.productId)
      ? a.productId
      : 'unknown',
    views: whole(a.metrics?.views),
    contacts: whole(a.metrics?.contacts),
    spend: whole(a.metrics?.spending),
    inInventory: a.inInventory !== false,
  }));
  const sourceState = business?.sources?.find((s) => s.id === 'orders');
  const ordersAvailable =
    Array.isArray(business?.orders?.rows) &&
    sourceState?.state !== 'unavailable';
  const orders = (ordersAvailable ? business.orders.rows : [])
    .filter((o) => o.status !== 'Отменён')
    .map((o) => ({
      id: String(o.id),
      title: String(o.title || `Заказ ${o.id}`),
      date: o.createdDate,
      status: o.status,
      product: productFromItems(o, catalog),
      amount: cents(o.amount),
      paid: cents(o.paid),
      customerSourceHint: o.sourceKnown ? o.source : null,
    }));
  const dialogs = (inquiries?.dialogs || [])
    .filter((d) => {
      const date = String(d.createdAt || '').slice(0, 10);
      return (
        date >= period.from &&
        date <= period.to &&
        typeof d.incomingObserved === 'number' &&
        d.incomingObserved > 0
      );
    })
    .map((d) => ({
      id: String(d.id),
      ad: d.itemId == null ? null : String(d.itemId),
      date: String(d.createdAt).slice(0, 10),
      limited: Boolean(d.messagesLimited),
    }));
  const periods = [
    ...new Map(
      (adReport?.history || [])
        .filter((s) => s.kind === 'items')
        .map((s) => [`${s.from}|${s.to}`, { from: s.from, to: s.to }]),
    ).values(),
  ].slice(0, 8);
  return {
    period,
    products,
    catalogAvailable,
    ads,
    orders,
    dialogs,
    periods,
    ordersAvailable,
    dialogsAvailable: Array.isArray(inquiries?.dialogs),
    advertisingAvailable: adReport?.enabled === true,
    loadedAt: adReport?.loadedAt,
    ordersLoadedAt: sourceState?.loadedAt,
    ordersStale: sourceState?.state === 'stale',
    stale: adReport?.stale,
    coverage: adReport?.coverage,
    dialogCoverage: inquiries?.coverage,
    errors: [],
    candidatesIgnored: true,
  };
}
export function realSlice(
  model,
  { product = 'all', ad = 'all', query = '' } = {},
) {
  const ads = model.ads.filter(
    (a) =>
      (product === 'all' || a.product === product) &&
      (ad === 'all' || a.id === ad) &&
      (!query ||
        a.title
          .toLocaleLowerCase('ru')
          .includes(query.toLocaleLowerCase('ru'))),
  );
  const ids = new Set(ads.map((a) => a.id));
  const dialogs = model.dialogs.filter(
    (d) => (ad === 'all' && product === 'all' && !query) || ids.has(d.ad),
  );
  // Order products are independent of ad-title classification; no relation is invented.
  const businessVisible = ad === 'all' && !query;
  const orders = businessVisible
    ? model.orders.filter((o) => product === 'all' || o.product === product)
    : [];
  const spend = sum(ads, 'spend'),
    contacts = sum(ads, 'contacts'),
    views = sum(ads, 'views');
  const paid =
    model.ordersAvailable && businessVisible
      ? orders.length
        ? sum(orders, 'paid')
        : 0
      : null;
  return {
    ads,
    dialogs,
    orders,
    spend,
    known: Object.fromEntries(
      ['spend', 'contacts', 'views'].map((key) => [
        key,
        sum(
          ads.filter((a) => a[key] != null),
          key,
        ),
      ]),
    ),
    contacts,
    views,
    paid,
    costContact: spend != null && contacts > 0 ? spend / contacts : null,
    contactRate:
      views > 0 && contacts != null ? (contacts / views) * 100 : null,
    businessVisible,
    ordersAvailable: model.ordersAvailable,
    attributedOrders: null,
    cpo: null,
    romi: null,
    salesFunnel: [
      model.dialogsAvailable ? dialogs.length : null,
      null,
      null,
      null,
      null,
    ],
    orderFunnel:
      model.ordersAvailable && businessVisible
        ? [
            orders.length,
            orders.some((o) => o.paid == null)
              ? null
              : orders.filter((o) => o.paid > 0).length,
            orders.some((o) => o.paid == null || o.amount == null)
              ? null
              : orders.filter((o) => o.amount > 0 && o.paid >= o.amount).length,
          ]
        : [null, null, null],
  };
}
export function realRows(model, tab, filter = {}) {
  if (tab === 'source') {
    const all = realSlice(model, filter);
    return [
      {
        id: 'avito',
        label: 'Авито',
        ...all,
        orders: [],
        paid: null,
        businessVisible: false,
        orderFunnel: [null, null, null],
      },
      {
        id: 'unattributed',
        label: 'Заказы без подтверждённого источника',
        ...all,
        ads: [],
        dialogs: [],
        views: null,
        contacts: null,
        spend: null,
        costContact: null,
        contactRate: null,
        salesFunnel: [null, null, null, null, null],
        known: { spend: null, contacts: null, views: null },
      },
    ];
  }
  if (tab === 'ad')
    return realSlice(model, filter).ads.map((a) => ({
      id: a.id,
      label: a.title,
      product: a.product,
      ...realSlice(model, { ...filter, ad: a.id }),
    }));
  return Object.entries(model.products)
    .map(([id, label]) => ({
      id,
      label,
      ...realSlice(model, { ...filter, product: id }),
    }))
    .filter(
      (r) =>
        (!filter.product ||
          filter.product === 'all' ||
          filter.product === r.id) &&
        (r.ads.length ||
          r.orders.length ||
          (r.id !== 'unknown' && r.id !== 'mixed' && !filter.query)),
    );
}
