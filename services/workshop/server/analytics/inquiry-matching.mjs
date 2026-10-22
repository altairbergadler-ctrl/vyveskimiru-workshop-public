import {
  normalPhone,
  normalText,
  words,
  productGroups,
  digest,
} from '../avito-inquiries.mjs';
import { AnalyticsError, isDate } from './contracts.mjs';
const businessCalendar = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const DAY = 86400000;
const sum = (rows, key) => {
  if (
    rows.some(
      (r) => r[key] == null || !Number.isSafeInteger(Math.round(r[key] * 100)),
    )
  )
    return null;
  const cents = rows.reduce((n, r) => n + BigInt(Math.round(r[key] * 100)), 0n);
  return cents > BigInt(Number.MAX_SAFE_INTEGER) ||
    cents < BigInt(Number.MIN_SAFE_INTEGER)
    ? null
    : Number(cents) / 100;
};
const money = (v) =>
  typeof v === 'number' &&
  Number.isFinite(v) &&
  Number.isSafeInteger(Math.round(v * 100))
    ? v
    : null;
const uniq = (a) => [...new Set(a)];
const rank = { strong: 3, possible: 2, weak: 1 };
function prepareOrder(o, key) {
  const contacts = o.contacts || [],
    sources = uniq(
      contacts.map((c) => String(c.source || '').trim()).filter(Boolean),
    );
  const names = uniq(
    [o.client, ...contacts.map((c) => c.name)].map(normalText).filter(Boolean),
  );
  const phones = uniq(
    contacts.flatMap((c) => {
      const whole = normalPhone(c.phone);
      return whole
        ? [whole]
        : (
            String(c.phone || '').match(
              /(?:\+?7|8)[\s().-]*(?:\d[\s().-]*){10}/gu,
            ) || []
          )
            .map(normalPhone)
            .filter(Boolean);
    }),
  );
  const emails = uniq(
    contacts.flatMap(
      (c) =>
        String(c.email || '')
          .toLowerCase()
          .match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gu) || [],
    ),
  );
  const topic = [o.title, ...(o.items || []).map((i) => i.name)].join(' ');
  return {
    public: {
      id: String(o.id),
      title: String(o.title || ''),
      client: String(o.client || ''),
      createdDate: o.createdDate || null,
      status: o.status || '',
      amount: money(o.amount),
      paid: money(o.paid),
      profit: money(o.profit),
      manualSource: sources.length === 1 ? sources[0] : null,
    },
    names,
    phones: phones.map((v) => digest(key, 'phone', v)),
    emails: emails.map((v) => digest(key, 'email', v)),
    terms: words(topic).map((v) => digest(key, 'word', v)),
    products: productGroups(topic),
  };
}
function prepareChat(chat, key, dayOf) {
  const signals = chat.signals || {};
  return {
    ...chat,
    matchingDates: uniq(
      [...(signals.incomingDates || []), chat.createdAt].map(dayOf),
    ),
    matchingNames: chat.users.map((u) => normalText(u.name)).filter(Boolean),
    matchingTerms: new Set([
      ...(signals.terms || []),
      ...words(chat.itemTitle).map((v) => digest(key, 'word', v)),
    ]),
    matchingProducts: uniq([
      ...(signals.products || []),
      ...productGroups(chat.itemTitle),
    ]),
  };
}
function candidate(order, chat, windowDays) {
  const s = chat.signals || {},
    p = order.public,
    why = [];
  const add = (code, label, score, family) =>
    why.push({ code, label, score, family });
  const explicit = (s.orderRefs || []).includes(p.id.toLowerCase());
  const dates = chat.matchingDates;
  const distances = isDate(p.createdDate)
    ? dates
        .map((d) => ({
          date: d,
          days: (Date.parse(p.createdDate) - Date.parse(d)) / DAY,
        }))
        .filter((v) => v.days >= -14 && v.days <= windowDays)
        .sort((a, b) => Math.abs(a.days) - Math.abs(b.days))
    : [];
  const nearest = distances[0];
  if (!nearest && !explicit) return null;
  if (explicit)
    add(
      'order_reference',
      'В переписке упомянут такой номер заказа',
      82,
      'reference',
    );
  const phone = order.phones.some((v) => (s.phones || []).includes(v));
  const email = order.emails.some((v) => (s.emails || []).includes(v));
  if (phone)
    add(
      'phone',
      'Телефон клиента совпал с телефоном во входящем сообщении',
      60,
      'identity',
    );
  if (email)
    add(
      'email',
      'Email клиента совпал с email во входящем сообщении',
      60,
      'identity',
    );
  const names = chat.matchingNames;
  const fullName = names.some(
    (n) => n.split(' ').length >= 2 && order.names.includes(n),
  );
  const shortName = names.some(
    (n) =>
      n.length >= 4 &&
      order.names.some((v) => v === n || v.split(' ').includes(n)),
  );
  if (fullName)
    add(
      'full_name',
      'Совпадает имя или название клиента; возможны тёзки',
      30,
      'name',
    );
  else if (shortName)
    add('name', 'Похоже имя собеседника; слабый признак', 10, 'name');
  const chatTerms = chat.matchingTerms;
  const common = order.terms.filter((v) => chatTerms.has(v)).length;
  const groups = chat.matchingProducts;
  if (common)
    add(
      'topic_words',
      'Совпадают слова из названия работ и темы переписки',
      Math.min(24, common * 8),
      'topic',
    );
  if (order.products.some((v) => groups.includes(v)))
    add('product_type', 'Совпадает вид работ или объявления', 10, 'topic');
  if (nearest) {
    if (nearest.days >= 0)
      add(
        'before_order',
        nearest.days === 0
          ? 'Обращение и заказ в один день'
          : `Обращение за ${nearest.days} дн. до заказа`,
        nearest.days <= 3 ? 12 : nearest.days <= 14 ? 8 : 3,
        'time',
      );
    else
      add(
        'after_order',
        `Сообщение на ${Math.abs(nearest.days)} дн. позже заказа; могло быть сопровождением`,
        2,
        'time',
      );
  }
  const avito =
    normalText(p.manualSource).includes('авито') ||
    normalText(p.manualSource).includes('avito');
  if (avito)
    add(
      'manual_source',
      'В карточке клиента указан источник Авито',
      7,
      'channel',
    );
  if (p.manualSource && !avito)
    add(
      'source_conflict',
      'В карточке клиента указан другой источник; связь требует проверки',
      0,
      'warning',
    );
  if (
    !explicit &&
    !phone &&
    !email &&
    !fullName &&
    ((!shortName && !why.some((e) => e.family === 'topic')) ||
      !nearest ||
      nearest.days < 0)
  )
    return null;
  const families = new Set(why.filter((e) => e.score > 0).map((e) => e.family));
  const score = why.reduce((n, e) => n + e.score, 0);
  if (score < 18 || (!explicit && families.size < 2)) return null;
  const level =
    (explicit || ((phone || email) && nearest && nearest.days >= 0)) &&
    score >= 70
      ? 'strong'
      : score >= 45
        ? 'possible'
        : 'weak';
  return {
    chatId: chat.id,
    itemId: chat.itemId,
    itemTitle: chat.itemTitle,
    person: chat.users.map((u) => u.name).join(', ') || 'Собеседник Авито',
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    signalsAt: chat.signalsAt,
    level,
    score,
    reasons: why.map(({ code, label }) => ({ code, label })),
    anchorDate: nearest?.date || null,
    afterOrder: Boolean(nearest && nearest.days < 0),
    messagesLimited: Boolean(s.hasMore),
    messagesMissing: !chat.signals,
    signalsStale: Boolean(chat.signals && s.sourceUpdatedAt !== chat.updatedAt),
    messagesRead: s.messageCount ?? null,
    incomingObserved: s.incomingCount ?? null,
    confirmed: false,
  };
}
export function matchInquiries({
  board,
  chats,
  period,
  key,
  windowDays = 90,
  mode = 'possible',
  generatedAt = new Date().toISOString(),
}) {
  if (!board || !Array.isArray(board.orders))
    throw new AnalyticsError('MATCH_ORDERS', 'Заказы временно недоступны.');
  const ids = board.orders.map((o) => String(o.id || ''));
  if (ids.some((v) => !v) || new Set(ids).size !== ids.length)
    throw new AnalyticsError(
      'MATCH_ORDER_IDS',
      'Номера заказов неоднозначны. Сопоставление приостановлено.',
    );
  const prepared = board.orders
    .filter(
      (o) =>
        isDate(o.createdDate) &&
        o.createdDate >= period.from &&
        o.createdDate <= period.to,
    )
    .map((o) => prepareOrder(o, key));
  const days = new Map();
  const dayOf = (stamp) => {
    if (!days.has(stamp))
      days.set(stamp, businessCalendar.format(new Date(stamp)));
    return days.get(stamp);
  };
  const preparedChats = chats.map((c) => prepareChat(c, key, dayOf));
  const rows = prepared.map((order) => {
    const all = preparedChats
      .map((c) => candidate(order, c, windowDays))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.chatId.localeCompare(b.chatId));
    const candidates = all.slice(0, 5),
      first = candidates[0],
      ambiguous = Boolean(
        first && candidates[1] && first.score - candidates[1].score < 12,
      );
    const suggested =
      first &&
      !ambiguous &&
      rank[first.level] >= rank[mode === 'all' ? 'weak' : mode]
        ? first
        : null;
    return {
      ...order.public,
      candidates,
      totalCandidates: all.length,
      ambiguous,
      suggestedChatId: suggested?.chatId || null,
      state: suggested
        ? 'suggested'
        : candidates.length
          ? 'review'
          : order.public.manualSource
            ? 'source_only'
            : 'unknown',
    };
  });
  const accepted = rows.filter((r) => r.status !== 'Отменён'),
    suggested = accepted.filter((r) => r.suggestedChatId);
  const byItem = [...new Set(suggested.map((r) => r.candidates[0].itemId))]
    .map((itemId) => {
      const itemRows = suggested.filter(
          (r) => r.candidates[0].itemId === itemId,
        ),
        item = itemRows[0].candidates[0];
      return {
        itemId,
        title: item.itemTitle,
        orders: itemRows.length,
        amount: sum(itemRows, 'amount'),
        paid: sum(itemRows, 'paid'),
        profit: sum(itemRows, 'profit'),
        strong: itemRows.filter((r) => r.candidates[0].level === 'strong')
          .length,
        estimated: true,
      };
    })
    .sort((a, b) => b.orders - a.orders);
  const dialogs = chats
    .map((c) => ({
      id: c.id,
      itemId: c.itemId,
      itemTitle: c.itemTitle,
      person: c.users.map((u) => u.name).join(', ') || 'Собеседник Авито',
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      incomingObserved: c.signals?.incomingCount ?? null,
      messagesRead: c.signals?.messageCount ?? null,
      messagesLimited: Boolean(c.signals?.hasMore),
      possibleOrders: rows
        .filter((r) => r.candidates.some((v) => v.chatId === c.id))
        .map((r) => r.id),
      suggestedOrders: rows
        .filter((r) => r.suggestedChatId === c.id)
        .map((r) => r.id),
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    modelVersion: 'inquiry-order-candidates-v2',
    generatedAt,
    period: { from: period.from, to: period.to },
    windowDays,
    mode,
    rows,
    dialogs,
    byItem,
    summary: {
      orders: accepted.length,
      dialogs: chats.length,
      withCandidates: accepted.filter((r) => r.candidates.length).length,
      suggested: suggested.length,
      strong: suggested.filter((r) => r.candidates[0].level === 'strong')
        .length,
      ambiguous: accepted.filter((r) => r.ambiguous).length,
      sourceOnly: accepted.filter((r) => r.state === 'source_only').length,
      unknown: accepted.filter((r) => r.state === 'unknown').length,
      suggestedAmount: sum(suggested, 'amount'),
      suggestedPaid: sum(suggested, 'paid'),
      suggestedProfit: sum(suggested, 'profit'),
      cancelled: rows.length - accepted.length,
      ordersWithoutDate: board.orders.filter((o) => !isDate(o.createdDate))
        .length,
    },
    limitations: [
      'Все связи предварительные: баллы служат ранжированию, а не вероятности сделки. Подтверждённых связей этот отчёт не создаёт.',
      'Один диалог может сопровождать несколько заказов. Диалоги не равны уникальным людям или отдельным заявкам.',
      'Показываем до пяти кандидатов на заказ. Близкие по силе варианты требуют проверки и не входят в оценку денег.',
      'Каждый неотменённый заказ входит в оценку не более одного раза. Сумма и оплачено — значения заказа из Google, не доказанная выручка объявления.',
      'Источник клиента и совпадение имени не доказывают источник конкретного заказа. Общие телефоны и повторные обращения могут давать ошибки.',
      'В режиме всех предположений достаточно имени и близкой даты либо вида работ и даты. Такие слабые кандидаты могут относиться к другому человеку; проверьте переписку.',
      'Звонки, другие площадки, вложения и голосовые сообщения здесь не сопоставляются. Учитывается ограниченная доступная история текстов.',
      'Изменения заказа в Google могут менять кандидатов. Финансовые строки, источники клиента и связи в Google не переписываются.',
    ],
  };
}
