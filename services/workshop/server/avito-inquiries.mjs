import crypto from 'node:crypto';
const fail = () => {
  throw new Error('Invalid messenger response');
};
const object = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail();
  return v;
};
export const chatId = (v) => {
  if (
    typeof v !== 'string' ||
    !v ||
    v.length > 200 ||
    v.split('').some((c) => c.charCodeAt(0) <= 32 || '/\\?#'.includes(c))
  )
    fail();
  return v;
};
const id = (v) => {
  if (!/^[1-9]\d{0,15}$/.test(String(v)) || !Number.isSafeInteger(Number(v)))
    fail();
  return String(v);
};
const string = (v, n) => {
  if (v == null) return '';
  if (typeof v !== 'string' || v.length > n || v.includes('\0')) fail();
  return v;
};
const time = (v) => {
  if (!Number.isSafeInteger(v) || v < 0 || v > 8640000000000) fail();
  return new Date(v * 1000).toISOString();
};
const more = (value, count) => {
  if (
    value?.meta?.has_more !== undefined &&
    typeof value.meta.has_more !== 'boolean'
  )
    fail();
  return value?.meta?.has_more ?? count === 100;
};
export function parseChats(value, account) {
  object(value);
  if (!Array.isArray(value.chats) || value.chats.length > 100) fail();
  const seen = new Set(),
    chats = [];
  for (const row of value.chats) {
    object(row);
    const key = chatId(row.id);
    if (seen.has(key)) fail();
    seen.add(key);
    if (
      row.context?.type !== 'item' ||
      String(row.context.value?.user_id) !== String(account)
    )
      continue;
    const item = object(row.context.value);
    if (!Array.isArray(row.users) || row.users.length > 20) fail();
    const users = row.users
      .filter((u) => String(u.id) !== String(account))
      .map((u) => ({ id: id(u.id), name: string(u.name, 300) }));
    chats.push({
      id: key,
      itemId: id(item.id),
      itemTitle: string(item.title, 1000),
      createdAt: time(row.created),
      updatedAt: time(row.updated),
      users,
      lastMessageId: row.last_message?.id ? chatId(row.last_message.id) : null,
    });
  }
  return {
    chats,
    received: value.chats.length,
    excluded: value.chats.length - chats.length,
    hasMore: more(value, value.chats.length),
  };
}
// Media is opt-in: analytics keeps its existing text-only, bounded storage contract.
export function avitoMessageMedia(row) {
  if (row.type === 'image') {
    const sizes = row.content?.image?.sizes;
    const variants =
      sizes && typeof sizes === 'object' && !Array.isArray(sizes)
        ? Object.entries(sizes)
            .slice(0, 30)
            .filter(
              ([k, v]) =>
                /^\d{1,5}x\d{1,5}$/.test(k) &&
                typeof v === 'string' &&
                v.length <= 8192,
            )
            .map(([k, url]) => ({
              area: k
                .split('x')
                .map(Number)
                .reduce((a, b) => a * b),
              url,
            }))
            .sort((a, b) => a.area - b.area)
        : [];
    return [
      {
        partId: '1',
        kind: 'image',
        name: 'Фото',
        url: variants.at(-1)?.url || '',
        preview:
          variants.find((v) => v.area >= 140 * 105)?.url ||
          variants[0]?.url ||
          '',
      },
    ];
  }
  if (row.type === 'voice')
    return [
      {
        partId: '1',
        kind: 'audio',
        name: 'Голосовое сообщение',
        voiceId:
          typeof row.content?.voice?.voice_id === 'string' &&
          row.content.voice.voice_id.length <= 200
            ? row.content.voice.voice_id
            : '',
      },
    ];
  if (row.type === 'file')
    return [
      {
        partId: '1',
        kind: 'file',
        name: 'Файл',
        unavailable:
          'Авито не передаёт файл через это подключение. Откройте исходный чат.',
      },
    ];
  return [];
}
export function parseMessages(value, { includeMedia = false } = {}) {
  const rows = Array.isArray(value) ? value : object(value).messages;
  if (!Array.isArray(rows) || rows.length > 100) fail();
  const seen = new Set();
  const messages = rows.map((row) => {
    object(row);
    const key = chatId(row.id);
    if (seen.has(key)) fail();
    seen.add(key);
    if (!['in', 'out'].includes(row.direction)) fail();
    return {
      id: key,
      createdAt: time(row.created),
      direction: row.direction,
      type: string(row.type, 40),
      text: row.type === 'text' ? string(row.content?.text, 32000) : '',
      ...(includeMedia ? { media: avitoMessageMedia(row) } : {}),
    };
  });
  return { messages, hasMore: more(value, messages.length) };
}
export function normalPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10) digits = '7' + digits;
  if (digits.length === 11 && digits[0] === '8') digits = '7' + digits.slice(1);
  return /^7\d{10}$/.test(digits) ? digits : null;
}
export const normalText = (v) =>
  String(v || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
const stop = new Set(
  'здравствуйте добрый спасибо пожалуйста можно нужно нужна нужен хочу будет есть есть изготовление изготовить реклама рекламный заказ заказа размер размеры рублей руб стоимость цена метр метров сегодня завтра давайте сделать печать можно какой какие чтобы только адрес телефон номер файл макет готовый здравствуйте вывески вывеска баннер баннера наклейки наклейка таблички табличка'.split(
    ' ',
  ),
);
export const words = (v) =>
  [
    ...new Set(
      normalText(v)
        .split(' ')
        .filter((w) => w.length >= 5 && !stop.has(w) && !/^\d+$/.test(w)),
    ),
  ].slice(0, 120);
export const productGroups = (v) => {
  const s = normalText(v);
  return [
    'баннер',
    'вывес',
    'наклей',
    'таблич',
    'стенд',
    'букв',
    'пленк',
    'визит',
    'штендер',
    'плакат',
  ].filter((w) => s.includes(w));
};
export const digest = (key, type, value) =>
  crypto
    .createHmac('sha256', key)
    .update(type + ':' + value)
    .digest('hex');
export function messageSignals(messages, key, hasMore = false) {
  const phones = new Set(),
    emails = new Set(),
    refs = new Set(),
    terms = new Set(),
    products = new Set(),
    dates = new Set();
  let incoming = 0;
  for (const m of messages) {
    if (m.type === 'system') continue;
    for (const match of m.text.matchAll(
      /заказ(?:а|у|ом)?[\s.:]*(?:№|#)\s*([a-zа-я0-9][a-zа-я0-9/-]{0,29})/giu,
    ))
      refs.add(match[1].toLowerCase());
    if (m.direction !== 'in') continue;
    incoming++;
    dates.add(m.createdAt);
    for (const raw of m.text.match(
      /(?<!\d)(?:\+?7|8)[\s().-]*(?:\d[\s().-]*){10}(?!\d)/gu,
    ) || []) {
      const n = normalPhone(raw);
      if (n) phones.add(digest(key, 'phone', n));
    }
    for (const raw of m.text.match(
      /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/giu,
    ) || [])
      emails.add(digest(key, 'email', raw.toLowerCase()));
    for (const word of words(m.text)) terms.add(digest(key, 'word', word));
    for (const group of productGroups(m.text)) products.add(group);
  }
  return {
    phones: [...phones].sort((a, b) => a.localeCompare(b)),
    emails: [...emails].sort((a, b) => a.localeCompare(b)),
    orderRefs: [...refs].slice(0, 100).sort((a, b) => a.localeCompare(b)),
    terms: [...terms].slice(0, 600).sort((a, b) => a.localeCompare(b)),
    products: [...products].sort((a, b) => a.localeCompare(b)),
    incomingDates: [...dates].sort((a, b) => a.localeCompare(b)),
    incomingCount: incoming,
    messageCount: messages.length,
    hasMore,
  };
}
