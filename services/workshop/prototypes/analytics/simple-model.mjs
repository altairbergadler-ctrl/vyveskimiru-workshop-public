import { ads, customers, leads, orders, links, payments } from './model.mjs';

export const simpleSources = {
  avito: 'Авито',
  direct: 'Яндекс',
  vk: 'VK',
  telegram: 'Telegram',
  other: 'Другое',
  unknown: 'Не указан',
};
export const simpleAds = ads;
export const simpleCustomers = customers;
const within = (x) => x.date >= '2026-08-25' && x.date <= '2026-08-31';
export const simpleLeads = leads
  .filter(within)
  .map((l) => ({ ...l, status: l.id === 'L06' ? 'Без заказа' : l.status }));
export function simpleSeed() {
  const attribution = { O101: 'a1', O102: 'd1', O103: 'd1', O104: 'a2' };
  const rows = orders
    .filter(within)
    .map((o) => ({ ...o, ad: attribution[o.id] }));
  rows.push(
    {
      id: 'O105',
      customer: 'c2',
      source: 'avito',
      ad: null,
      date: '2026-08-26',
      amount: 3000000,
      status: 'Завершён',
    },
    {
      id: 'O106',
      customer: 'c4',
      source: 'unknown',
      ad: null,
      date: '2026-08-28',
      amount: 2500000,
      status: 'Готов',
    },
    {
      id: 'O107',
      customer: 'c5',
      source: 'unknown',
      ad: null,
      date: '2026-08-30',
      amount: 1500000,
      status: 'Согласование',
    },
  );
  return {
    orders: rows,
    links: links
      .filter((l) => l.confirmed && rows.some((o) => o.id === l.order))
      .map(({ lead, order }) => ({ lead, order })),
    payments: [
      ...payments.filter((p) => rows.some((o) => o.id === p.order)),
      { id: 'T6', order: 'O105', date: '2026-08-29', amount: 3000000 },
      { id: 'T7', order: 'O106', date: '2026-09-02', amount: 1000000 },
    ],
  };
}
export function simplePaid(db, id) {
  return db.payments
    .filter((p) => p.order === id)
    .reduce((s, p) => s + p.amount, 0);
}
export function simpleRows(db, source = null) {
  const keys = source
    ? [...ads.filter((a) => a.source === source).map((a) => a.id), 'none']
    : Object.keys(simpleSources);
  return keys
    .map((key) => {
      const match = (x) =>
        source
          ? x.source === source && (x.ad || 'none') === key
          : x.source === key;
      const catalog = ads.filter((a) =>
        source ? a.id === key : a.source === key,
      );
      const costs = catalog.map((a) => a.metrics.spending);
      const rows = db.orders.filter(match);
      return {
        key,
        label: source
          ? ads.find((a) => a.id === key)?.title || 'Без объявления'
          : simpleSources[key],
        spending:
          costs.length && costs.every((v) => v != null)
            ? costs.reduce((s, v) => s + v, 0)
            : null,
        leads: simpleLeads.filter(match).length,
        orders: rows,
        paid: rows.reduce((s, o) => s + simplePaid(db, o.id), 0),
      };
    })
    .filter((r) => !source || r.key !== 'none' || r.orders.length || r.leads);
}
export function simpleAssign(db, ids, source) {
  if (
    !Object.hasOwn(simpleSources, source) ||
    !ids.length ||
    ids.some((id) => !db.orders.some((o) => o.id === id))
  )
    throw new Error('Выберите заказы и источник.');
  return {
    ...db,
    orders: db.orders.map((o) =>
      ids.includes(o.id)
        ? { ...o, source, ad: o.source === source ? o.ad : null }
        : o,
    ),
  };
}
export function simpleLink(db, leadId, orderId) {
  const lead = simpleLeads.find((l) => l.id === leadId);
  if (!lead || !db.orders.some((o) => o.id === orderId))
    throw new Error('Выберите обращение и заказ.');
  // One attribution per order. Existing conversations remain references, never duplicate money.
  return {
    ...db,
    orders: db.orders.map((o) =>
      o.id === orderId ? { ...o, source: lead.source, ad: lead.ad } : o,
    ),
    links: db.links.some((l) => l.lead === leadId && l.order === orderId)
      ? db.links
      : [...db.links, { lead: leadId, order: orderId }],
  };
}
export function simpleCreate(db, leadId, rawAmount) {
  const lead = simpleLeads.find((l) => l.id === leadId);
  const value = String(rawAmount).trim().replace(',', '.');
  if (!lead || !/^\d{1,8}(\.\d{1,2})?$/.test(value))
    throw new Error('Укажите сумму от 0,01 до 99 999 999,99 ₽.');
  const amount = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new Error('Сумма должна быть больше нуля.');
  const id =
    'D' +
    (Math.max(
      200,
      ...db.orders
        .filter((o) => /^D\d+$/.test(o.id))
        .map((o) => Number(o.id.slice(1))),
    ) +
      1);
  const order = {
    id,
    customer: lead.customer,
    source: lead.source,
    ad: lead.ad,
    date: '2026-08-31',
    amount,
    status: 'Новый',
  };
  return {
    ...db,
    orders: [...db.orders, order],
    links: [...db.links, { lead: leadId, order: id }],
  };
}
