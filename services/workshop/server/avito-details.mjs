// Public Avito item/promotion contracts inspected 2026-09-09. Projections exclude profile/contact data.
const fail = () => {
  const error = new Error('AVITO_DETAIL_SCHEMA');
  error.code = 'schema';
  throw error;
};
const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : fail();
export const sourceId = (value) =>
  /^[1-9]\d{0,15}$/.test(String(value)) && Number.isSafeInteger(Number(value))
    ? String(value)
    : fail();
const text = (value, max = 1000) =>
  typeof value === 'string' && value.length <= max ? value : fail();
const number = (value) =>
  value == null
    ? null
    : Number.isSafeInteger(value) && value >= 0
      ? value
      : fail();
const date = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  new Date(value).toISOString().slice(0, 10) === value
    ? value
    : fail();
const timestamp = (value) =>
  value == null
    ? null
    : typeof value === 'string' &&
        value.length < 80 &&
        Number.isFinite(Date.parse(value))
      ? value
      : fail();
const list = (value, max) =>
  Array.isArray(value) && value.length <= max ? value : fail();
export function listingFields(item) {
  let url = null;
  if (item.url) {
    try {
      const parsed = new URL(item.url);
      if (
        parsed.protocol === 'https:' &&
        ['avito.ru', 'www.avito.ru'].includes(parsed.hostname) &&
        !parsed.username &&
        !parsed.password
      )
        url = parsed.origin + parsed.pathname;
    } catch {
      /* never return an untrusted URL */
    }
  }
  return {
    price: number(item.price),
    category: item.category
      ? { id: sourceId(item.category.id), name: text(item.category.name, 200) }
      : null,
    url,
  };
}
export function detailInput(input, max = 200) {
  object(input);
  const ids = list(input.itemIds, max).map(sourceId);
  if (!ids.length || new Set(ids).size !== ids.length) fail();
  return ids;
}
export function parseTraffic(value, request) {
  object(value);
  if (value.errors && Object.keys(value.errors).length) fail();
  const allowed = new Set(request.itemIds.map(String)),
    seen = new Set();
  const items = list(object(value.result).items, 200).map((row) => {
    object(row);
    const id = sourceId(row.itemId);
    if (!allowed.has(id) || seen.has(id)) fail();
    seen.add(id);
    const dates = new Set();
    const days = list(row.stats, 270).map((row) => {
      object(row);
      const day = date(row.date);
      if (dates.has(day) || day < request.dateFrom || day > request.dateTo)
        fail();
      dates.add(day);
      return {
        date: day,
        views: number(row.uniqViews),
        contacts: number(row.uniqContacts),
        favorites: number(row.uniqFavorites),
      };
    });
    return { id, days: days.sort((a, b) => a.date.localeCompare(b.date)) };
  });
  return {
    items,
    missingIds: [...allowed].filter((id) => !seen.has(id)),
    definition: 'v1_daily_unique',
    emptyDaysAreUnknown: true,
  };
}
export function parseCalls(value, request) {
  const allowed = new Set(request.itemIds.map(String)),
    seen = new Set();
  const items = list(object(object(value).result).items, 2000).map((row) => {
    object(row);
    const id = String(row.itemId);
    if (id !== '0' && !allowed.has(id)) fail();
    const employeeId = number(row.employeeId);
    if (employeeId === null) fail();
    const key = id + ':' + employeeId;
    if (seen.has(key)) fail();
    seen.add(key);
    const days = list(row.days ?? [], 270).map((row) => {
      const day = date(row.date);
      if (day < request.dateFrom || day > request.dateTo) fail();
      const calls = number(row.calls),
        answered = number(row.answered),
        fresh = number(row.new),
        newAnswered = number(row.newAnswered);
      if (
        (answered != null && calls != null && answered > calls) ||
        (newAnswered != null && fresh != null && newAnswered > fresh)
      )
        fail();
      return { date: day, calls, answered, new: fresh, newAnswered };
    });
    if (new Set(days.map((d) => d.date)).size !== days.length) fail();
    return { id, employeeId, days };
  });
  return { items, emptyDaysAreUnknown: true };
}
export function parseServices(value, request) {
  object(value);
  const allowed = new Set(request.itemIds.map(String)),
    seen = new Set();
  const items = list(value.items ?? [], 100).map((row) => {
    const id = sourceId(row.itemId);
    if (!allowed.has(id) || seen.has(id)) fail();
    seen.add(id);
    const services = list(row.services ?? [], 100).map((s) => ({
      slug: text(s.slug, 100),
      name: text(s.name, 300),
      startDate: timestamp(s.startDate),
      endDate: timestamp(s.endDate),
    }));
    return {
      id,
      services: services.sort((a, b) =>
        (a.slug + (a.startDate || '')).localeCompare(
          b.slug + (b.startDate || ''),
        ),
      ),
      servicesExplicit: Array.isArray(row.services),
    };
  });
  const errors = list(value.errors ?? [], 100).map((e) => ({
    id: sourceId(e.itemId),
    code: number(e.errorCode),
  }));
  if (errors.some((e) => !allowed.has(e.id))) fail();
  return {
    items,
    errors,
    missingIds: [...allowed].filter((id) => !seen.has(id)),
  };
}
export function parseItemInfo(value, id) {
  object(value);
  const status = text(value.status, 40);
  if (
    ![
      'active',
      'removed',
      'old',
      'blocked',
      'rejected',
      'not_found',
      'another_user',
    ].includes(status)
  )
    fail();
  if (status === 'another_user') fail();
  const vas = list(value.vas ?? [], 100).map((v) => ({
    id: text(v.vas_id, 100),
    finishTime: timestamp(v.finish_time),
    schedule: list(v.schedule ?? [], 100)
      .map(timestamp)
      .sort((a, b) => String(a).localeCompare(String(b))),
  }));
  return {
    id,
    status,
    startTime: timestamp(value.start_time),
    finishTime: timestamp(value.finish_time),
    vas: vas.sort((a, b) => a.id.localeCompare(b.id)),
    vasExplicit: Array.isArray(value.vas),
  };
}
