export type AdMetrics = Record<string, number | null>;
export const adColumns: { key: string; label: string; money?: boolean }[] = [
  { key: 'impressions', label: 'Показы' },
  { key: 'views', label: 'Просмотры' },
  { key: 'contacts', label: 'Контакты' },
  { key: 'favorites', label: 'Добавления в избранное' },
  { key: 'contactsShowPhone', label: 'Посмотрели телефон' },
  { key: 'contactsMessenger', label: 'Написали в чат' },
  {
    key: 'contactsShowPhoneAndMessenger',
    label: 'Телефон и чат — пересечение',
  },
  { key: 'contactsSbcDiscount', label: 'Отклики на скидку' },
  { key: 'spending', label: 'Расходы деньгами', money: true },
  { key: 'spendingBonus', label: 'Бонусы — единицы Авито' },
  { key: 'allSpending', label: 'Расходы с бонусами', money: true },
  {
    key: 'presenceSpending',
    label: 'Размещение и целевые действия',
    money: true,
  },
  { key: 'promoSpending', label: 'Продвижение', money: true },
  { key: 'restSpending', label: 'Остальные расходы', money: true },
  { key: 'commission', label: 'Комиссия', money: true },
  { key: 'activeItems', label: 'Активные объявления по правилам Авито' },
  { key: 'newActiveItems', label: 'Новые и опубликованные заново' },
  { key: 'oldActiveItems', label: 'Активны с прошлого периода' },
];
export type AdRates = {
  ctr: number | null;
  contactRate: number | null;
  costView: number | null;
  costContact: number | null;
  favoriteRate: number | null;
  promotionShare: number | null;
};
export type AdDelta = { absolute: number; percent: number | null } | null;
export type AdDay = {
  date: string;
  views: number | null;
  contacts: number | null;
  favorites: number | null;
};
export type AdEvent = {
  id: number;
  kind: string;
  observedAt: string;
  previousObservedAt: string | null;
  fields: string[];
  value: Record<string, unknown>;
  previousValue?: Record<string, unknown> | null;
  hash?: string;
  itemId?: string;
};
export type AdRow = {
  id: string;
  title: string;
  status: string;
  price: number | null;
  category: { id: string; name: string } | null;
  url: string | null;
  inInventory: boolean;
  metrics: AdMetrics | null;
  previous: AdMetrics | null;
  rates: AdRates;
  previousRates: AdRates;
  signals: { code: string; label: string; level: string }[];
  change: { spending: AdDelta; contacts: AdDelta; costContact: AdDelta };
  days: AdDay[];
  previousDays: AdDay[];
  trafficCoverage: number;
  calls: {
    calls: number | null;
    answered: number | null;
    new: number | null;
    reportedDays: number;
  };
  services:
    | {
        slug: string;
        name: string;
        startDate: string | null;
        endDate: string | null;
      }[]
    | null;
  servicesObservedAt: string | null;
  info: {
    startTime: string | null;
    finishTime: string | null;
    status: string;
    vas: { id: string; finishTime: string | null; schedule: string[] }[];
  } | null;
  observedAt: string | null;
  notes: {
    id: string;
    itemId: string;
    date: string;
    text: string;
    createdAt: string;
    comparison: {
      before: AdWindow;
      after: AdWindow;
      views: AdDelta;
      contacts: AdDelta;
      causal: false;
    } | null;
  }[];
};
export type AdWindow = {
  from: string;
  to: string;
  knownDays: number;
  expectedDays: number;
  complete: boolean;
  views: number | null;
  contacts: number | null;
};
export type AdvertisingReport = {
  enabled: boolean;
  metricVersion: string;
  generatedAt: string;
  period: {
    dateFrom: string;
    dateTo: string;
    days: number;
    previous: { dateFrom: string; dateTo: string };
  };
  automatic: boolean;
  intervalMinutes: number;
  rows: AdRow[];
  summary: AdMetrics | null;
  rates: AdRates;
  noContactsSpend: number | null;
  reportedItems: number;
  inventoryItems: number;
  inventoryAt: string | null;
  loadedAt: string | null;
  previousLoadedAt: string | null;
  previousSourceState: 'ready' | 'unloaded' | 'no_rows';
  daily: {
    date: string | null;
    sourceKey: string;
    metrics: AdMetrics;
    rates: AdRates;
  }[];
  dailyLoadedAt: string | null;
  events: AdEvent[];
  jobs: {
    id: string;
    from: string;
    to: string;
    createdAt: string;
    finishedAt: string | null;
    state: string;
    total: number;
    done: number;
    failed: number;
  }[];
  failures: {
    kind: string;
    code: string;
    state: string;
    retryAt: string;
    jobId: string;
  }[];
  history: {
    id: string;
    kind: string;
    from: string;
    to: string;
    loadedAt: string;
    hash: string;
    runId: string;
  }[];
  coverage: {
    withoutStats: number;
    trafficItems: number;
    trafficMissingDays: number;
    callsWithDays: number;
  };
  limitations: string[];
  stale: boolean;
};
const cell = (value: unknown) => {
  let v =
    typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  if (typeof value === 'string' && /^[\s\uFEFF]*[=+@\-\t\r]/u.test(v))
    v = "'" + v;
  return '"' + v.replaceAll('"', '""') + '"';
};
export function advertisingCsv(report: AdvertisingReport, rows = report.rows) {
  const data: unknown[][] = [
    ['Авито · эффективность объявлений'],
    ['Период', report.period.dateFrom, report.period.dateTo],
    [
      'Сравнение',
      report.period.previous.dateFrom,
      report.period.previous.dateTo,
    ],
    ['Загружено', report.loadedAt],
    ['Версия', report.metricVersion],
    ['Основание', 'По строкам отчёта Авито; не доход мастерской'],
    ...report.limitations.map((l) => ['Ограничение', l]),
    [],
    [
      'ID',
      'Объявление',
      'Статус',
      'Показы',
      'Просмотры',
      'Контакты',
      'Расходы, RUB',
      'CTR, %',
      'Конверсия в контакт, %',
      'Цена просмотра, RUB',
      'Цена контакта, RUB',
      'Продвижение, RUB',
      'Контакты прежде',
      'Расходы прежде, RUB',
      'Сигналы',
      ...adColumns.map((c) => c.label + (c.money ? ', RUB' : '')),
    ],
    ...rows.map((r) => [
      r.id,
      r.title,
      r.status,
      r.metrics?.impressions,
      r.metrics?.views,
      r.metrics?.contacts,
      r.metrics?.spending == null ? null : r.metrics.spending / 100,
      r.rates.ctr,
      r.rates.contactRate,
      r.rates.costView,
      r.rates.costContact,
      r.metrics?.promoSpending == null ? null : r.metrics.promoSpending / 100,
      r.previous?.contacts,
      r.previous?.spending == null ? null : r.previous.spending / 100,
      r.signals.map((s) => s.label).join(' / '),
      ...adColumns.map((c) =>
        r.metrics?.[c.key] == null
          ? null
          : c.money
            ? r.metrics[c.key]! / 100
            : r.metrics[c.key],
      ),
    ]),
  ];
  return '\uFEFF' + data.map((row) => row.map(cell).join(';')).join('\r\n');
}
export function advertisingHistoryCsv(rows: AdEvent[]) {
  return (
    '\uFEFF' +
    [
      [
        'Проверка',
        'Вид',
        'Предыдущая проверка',
        'Изменились поля',
        'Состояние',
        'SHA256',
      ],
      ...rows.map((r) => [
        r.observedAt,
        r.kind,
        r.previousObservedAt,
        r.fields.join(', '),
        JSON.stringify(r.value),
        r.hash,
      ]),
    ]
      .map((row) => row.map(cell).join(';'))
      .join('\r\n')
  );
}
