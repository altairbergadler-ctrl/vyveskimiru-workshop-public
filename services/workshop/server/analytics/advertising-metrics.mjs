const DAY = 86400000;
export function sumKnown(values) {
  if (
    !values.length ||
    values.some((v) => v == null || !Number.isSafeInteger(v))
  )
    return null;
  const n = values.reduce((a, b) => a + b, 0);
  return Number.isSafeInteger(n) ? n : null;
}
const ratio = (a, b, factor = 1) =>
  a == null || b == null || b <= 0
    ? null
    : Math.round((a / b) * factor * 10000) / 10000;
export function efficiency(m = {}) {
  return {
    ctr: ratio(m.views, m.impressions, 100),
    contactRate: ratio(m.contacts, m.views, 100),
    costView: ratio(m.spending, m.views, 0.01),
    costContact: ratio(m.spending, m.contacts, 0.01),
    favoriteRate: ratio(m.favorites, m.views, 100),
    promotionShare: ratio(m.promoSpending, m.spending, 100),
  };
}
const delta = (a, b) =>
  a == null || b == null
    ? null
    : {
        absolute: a - b,
        percent:
          b === 0 ? null : Math.round(((a - b) / Math.abs(b)) * 10000) / 100,
      };
const json = (row) => (row ? JSON.parse(row.payload) : null);
export function beforeAfter(days, eventDate, today, window = 7) {
  const point = Date.parse(eventDate);
  if (!Number.isFinite(point)) return null;
  const side = (offset) => {
    const dates = Array.from({ length: window }, (_, i) =>
      new Date(point + (offset + i) * DAY).toISOString().slice(0, 10),
    );
    const rows = dates.map((date) => days.find((row) => row.date === date));
    const complete = rows.every(
      (row, i) =>
        row && dates[i] < today && row.views != null && row.contacts != null,
    );
    return {
      from: dates[0],
      to: dates.at(-1),
      knownDays: rows.filter(
        (r, i) =>
          r && dates[i] < today && r.views != null && r.contacts != null,
      ).length,
      expectedDays: window,
      complete,
      views: complete ? sumKnown(rows.map((r) => r.views)) : null,
      contacts: complete ? sumKnown(rows.map((r) => r.contacts)) : null,
    };
  };
  const before = side(-window),
    after = side(1);
  return {
    before,
    after,
    views: delta(after.views, before.views),
    contacts: delta(after.contacts, before.contacts),
    causal: false,
  };
}
export function buildAdvertisingReport({
  period,
  snapshots,
  versions,
  jobs,
  failures,
  notes,
  now,
  automatic,
  history = [],
}) {
  const days =
    (Date.parse(period.dateTo) - Date.parse(period.dateFrom)) / DAY + 1;
  const previous = {
    dateFrom: new Date(Date.parse(period.dateFrom) - days * DAY)
      .toISOString()
      .slice(0, 10),
    dateTo: new Date(Date.parse(period.dateFrom) - DAY)
      .toISOString()
      .slice(0, 10),
  };
  const latest = (kind, p) =>
    snapshots.find(
      (s) =>
        s.kind === kind &&
        (!p || (s.date_from === p.dateFrom && s.date_to === p.dateTo)),
    );
  const batch = (kind, p) => {
    const first = latest(kind, p);
    return first
      ? snapshots
          .filter(
            (s) =>
              s.kind === kind &&
              s.run_id === first.run_id &&
              s.date_from === first.date_from &&
              s.date_to === first.date_to,
          )
          .flatMap((s) => json(s).items || [])
      : [];
  };
  const inventory = latest('inventory'),
    itemsSnapshot = latest('items', period),
    oldSnapshot = latest('items', previous);
  const current = json(itemsSnapshot),
    old = json(oldSnapshot),
    catalog = json(inventory)?.items || [];
  const allIds = new Set([
    ...catalog.map((i) => i.id),
    ...(current?.groups || []).map((g) => g.sourceGroupId),
  ]);
  const traffic = batch('traffic', period),
    priorTraffic = batch('traffic', previous),
    calls = batch('calls', period);
  const latestVersion = (id, kind) =>
    versions.find((v) => v.item_id === id && v.kind === kind);
  const rows = [...allIds].map((id) => {
    const item = catalog.find((i) => i.id === id) || {
      id,
      title: `Объявление №${id}`,
      status: 'unknown',
      price: null,
      category: null,
      url: null,
    };
    const m =
        current?.groups.find((g) => g.sourceGroupId === id)?.metrics || null,
      prev = old?.groups.find((g) => g.sourceGroupId === id)?.metrics || null;
    const rates = efficiency(m || {}),
      previousRates = efficiency(prev || {}),
      signals = [];
    if (m?.spending > 0 && m.contacts === 0)
      signals.push({
        code: 'spend_no_contacts',
        label: 'Расходы без контактов',
        level: 'attention',
      });
    if (m?.impressions >= 100 && m.views === 0)
      signals.push({
        code: 'no_views',
        label: 'Показы без просмотров',
        level: 'attention',
      });
    if (m?.views >= 20 && m.contacts === 0)
      signals.push({
        code: 'no_contacts',
        label: 'Просмотры без контактов',
        level: 'attention',
      });
    if (m?.contacts != null && m.contacts < 5)
      signals.push({
        code: 'small_sample',
        label: 'Мало контактов для уверенного сравнения',
        level: 'info',
      });
    if (
      m?.contacts >= 5 &&
      prev?.contacts >= 5 &&
      rates.costContact != null &&
      previousRates.costContact != null &&
      rates.costContact > previousRates.costContact * 1.25
    )
      signals.push({
        code: 'cost_up',
        label: 'Контакт подорожал более чем на 25%',
        level: 'attention',
      });
    const itemCalls = calls.filter((c) => c.id === id).flatMap((c) => c.days),
      service = latestVersion(id, 'services'),
      info = latestVersion(id, 'info');
    const itemDays = [...(traffic.find((t) => t.id === id)?.days || [])],
      olderDays = priorTraffic.find((t) => t.id === id)?.days || [];
    const observation = latestVersion(id, 'inventory');
    return {
      ...item,
      inInventory: catalog.some((i) => i.id === id),
      metrics: m,
      previous: prev,
      rates,
      previousRates,
      signals,
      change: {
        spending: delta(m?.spending, prev?.spending),
        contacts: delta(m?.contacts, prev?.contacts),
        costContact: delta(rates.costContact, previousRates.costContact),
      },
      days: itemDays,
      previousDays: olderDays,
      trafficCoverage: itemDays.length,
      calls: {
        calls: sumKnown(itemCalls.map((d) => d.calls)),
        answered: sumKnown(itemCalls.map((d) => d.answered)),
        new: sumKnown(itemCalls.map((d) => d.new)),
        reportedDays: new Set(itemCalls.map((d) => d.date)).size,
        days: itemCalls,
      },
      services: json(service)?.services ?? null,
      servicesObservedAt: service?.observed_at || null,
      info: json(info),
      observedAt: observation?.observed_at || null,
      notes: notes
        .filter((n) => n.itemId === id)
        .map((n) => ({
          ...n,
          comparison: beforeAfter(
            [...olderDays, ...itemDays],
            n.date,
            new Date(now).toISOString().slice(0, 10),
          ),
        })),
    };
  });
  const reported = rows.filter((r) => r.metrics);
  const aggregate = (key) => sumKnown(reported.map((r) => r.metrics[key]));
  const summary = current
    ? {
        impressions: aggregate('impressions'),
        views: aggregate('views'),
        contacts: aggregate('contacts'),
        spending: aggregate('spending'),
        promoSpending: aggregate('promoSpending'),
        favorites: aggregate('favorites'),
      }
    : null;
  // Completeness belongs to the selected provider report, not the lifetime catalog.
  // Keep missing item metrics null even when the aggregate report is complete.
  const spendComplete = Boolean(
    current?.dateFrom === period.dateFrom &&
    current?.dateTo === period.dateTo &&
    current?.grouping === 'item' &&
    current?.pagination?.complete === true &&
    current.pagination.offset === 0 &&
    current.pagination.nextOffset === null &&
    current.pagination.total === current.groups.length &&
    new Set(current.groups.map(g => g.sourceGroupId)).size === current.groups.length &&
    summary?.spending != null
  );
  const costRows = reported.filter(
    (r) => r.metrics.spending > 0 && r.metrics.contacts === 0,
  );
  const noContactsSpend = reported.some(
    (r) => r.metrics.spending != null && r.metrics.contacts != null,
  )
    ? costRows.length
      ? sumKnown(costRows.map((r) => r.metrics.spending))
      : 0
    : null;
  const daySource = latest('account_days', period),
    daily =
      json(daySource)
        ?.groups.map((g) => {
          const id = Number(g.sourceGroupId),
            date =
              Number.isSafeInteger(id) && id >= 0 && id <= 8640000000000
                ? new Date(id * 1000).toISOString().slice(0, 10)
                : null;
          const verifiedLabel =
            date &&
            id % 86400 === 0 &&
            date >= period.dateFrom &&
            date <= period.dateTo;
          return {
            date: verifiedLabel ? date : null,
            sourceKey: g.sourceGroupId,
            metrics: g.metrics,
            rates: efficiency(g.metrics),
          };
        })
        .sort((a, b) =>
          (a.date || a.sourceKey).localeCompare(b.date || b.sourceKey),
        ) || [];
  const events = versions
    .filter((v) => JSON.parse(v.changed_fields).length)
    .slice(0, 300)
    .map((v) => ({
      id: v.id,
      itemId: v.item_id,
      kind: v.kind,
      observedAt: v.observed_at,
      previousObservedAt: v.previous_observed_at,
      fields: JSON.parse(v.changed_fields),
      value: json(v),
    }));
  return {
    enabled: true,
    metricVersion: 'avito-effectiveness-v1',
    generatedAt: new Date(now).toISOString(),
    period: {
      dateFrom: period.dateFrom,
      dateTo: period.dateTo,
      days,
      previous,
    },
    automatic,
    intervalMinutes: 15,
    rows,
    summary,
    spendComplete,
    rates: efficiency(summary || {}),
    noContactsSpend,
    reportedItems: reported.length,
    inventoryItems: catalog.length,
    inventoryAt: inventory?.loaded_at || null,
    loadedAt: itemsSnapshot?.loaded_at || null,
    previousLoadedAt: oldSnapshot?.loaded_at || null,
    previousSourceState: !oldSnapshot
      ? 'unloaded'
      : old?.groups.length
        ? 'ready'
        : 'no_rows',
    daily,
    dailyLoadedAt: daySource?.loaded_at || null,
    events,
    notes,
    jobs: jobs.map((j) => ({
      id: j.id,
      from: j.date_from,
      to: j.date_to,
      createdAt: j.created_at,
      finishedAt: j.finished_at,
      state: j.state,
      total: j.total,
      done: j.done,
      failed: j.failed,
    })),
    failures: failures.map((f) => ({
      kind: f.kind,
      code: f.code,
      state: f.state,
      retryAt: new Date(f.next_at).toISOString(),
      jobId: f.run_id,
    })),
    history: history.map((s) => ({
      id: s.id,
      kind: s.kind,
      from: s.date_from,
      to: s.date_to,
      loadedAt: s.loaded_at,
      hash: s.hash,
      runId: s.run_id,
    })),
    coverage: {
      withoutStats: catalog.filter((i) => !reported.some((r) => r.id === i.id))
        .length,
      trafficItems: traffic.length,
      trafficMissingDays: rows.reduce(
        (n, r) => n + Math.max(0, days - r.days.length),
        0,
      ),
      callsWithDays: rows.filter((r) => r.calls.reportedDays).length,
    },
    limitations: [
      'Контакты и уникальные показатели считаются по правилам Авито, не по клиентам мастерской.',
      'Расходы относятся к кабинету и не складываются с выплатами рекламы в Google. Доход/ROMI требуют связи с заказами.',
      'Отсутствующие строки и дни не заменяются нулями. Статистика v1 по дням и v2 за период имеют разные определения.',
      'Изменения обнаруживаются между проверками. Редактирования между ними могут быть пропущены; прошлые тексты и фотографии API не возвращает.',
      'Дни графика — календарные ключи отчёта Авито; часовой пояс кабинета не подтверждён.',
      'Сравнение до/после описывает наблюдения и не доказывает причинный эффект продвижения.',
    ],
    stale: Boolean(
      itemsSnapshot &&
      (now - Date.parse(itemsSnapshot.loaded_at) > 30 * 60_000 ||
        failures.some(
          (f) =>
            ['items', 'inventory'].includes(f.kind) &&
            jobs.some(
              (j) =>
                j.id === f.run_id &&
                j.date_from === period.dateFrom &&
                j.date_to === period.dateTo &&
                j.created_at >= itemsSnapshot.loaded_at,
            ),
        )),
    ),
  };
}
