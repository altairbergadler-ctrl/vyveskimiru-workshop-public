export type MoneyTotals = {
  income: number | null;
  expense: number | null;
  net: number | null;
  operations: number;
  measurements: number | null;
  advertisingPayments: number | null;
};
export type OrderTotals = {
  count: number;
  cancelled: number;
  amount: number | null;
  profit: number | null;
  paid: number | null;
  average: number | null;
};
export type AnalyticsOrder = {
  id: string;
  title: string;
  status: string;
  createdDate: string;
  dueDate: string;
  amount: number | null;
  paid: number | null;
  debt: number | null;
  profit: number | null;
  source: string;
  sourceKnown: boolean;
};
export type AnalyticsConnection = {
  id: string;
  name: string;
  short: string;
  kind: string;
  planned: string;
  requires: string;
  state: 'not_connected' | 'connected' | 'not_loaded' | 'stale' | 'unavailable';
};
export type MetricDefinition = {
  id: string;
  label: string;
  unit: string;
  basis: string;
  rule: string;
  source: string;
};
export type AnalyticsReport = {
  metricVersion: string;
  snapshotId: string;
  generatedAt: string;
  currency: string;
  taxBasis: string;
  refreshAfterSeconds: number;
  period: {
    from: string;
    to: string;
    days: number;
    today: string;
    timeZone: string;
    previous: { from: string; to: string };
  };
  sources: {
    id: string;
    label: string;
    state: 'ready' | 'stale' | 'unavailable';
    startedAt: string | null;
    loadedAt: string | null;
    checkedAt: string | null;
    code: string | null;
  }[];
  overview: {
    finance: MoneyTotals | null;
    previousFinance: MoneyTotals | null;
    orders: OrderTotals | null;
    previousOrders: OrderTotals | null;
    current: {
      activeOrders: number;
      overdueOrders: number;
      debt: number | null;
      overpayments: number | null;
    } | null;
  };
  finance: {
    daily: (MoneyTotals & { date: string })[];
    categories: { label: string; amount: number | null; count: number }[];
    accounts: (MoneyTotals & { label: string })[];
    transactions: {
      id: string;
      date: string;
      type: 'income' | 'expense';
      amount: number;
      category: string;
      account: string;
      orderNumber: string | null;
    }[];
  };
  orders: {
    rows: AnalyticsOrder[];
    statuses: { label: string; count: number }[];
    statusesTotal: number;
    products: { label: string; amount: number | null; orders: number }[];
  };
  acquisition: {
    connections: AnalyticsConnection[];
    manualSources: {
      label: string;
      orders: number;
      amount: number | null;
      profit: number | null;
      known: boolean;
    }[];
    advertising: null;
    leads: null;
    romi: null;
  };
  operations: {
    production: { open: number; ready: number; overdue: number } | null;
    warehouse: {
      total: number;
      attention: number;
      belowMinimum: number;
      incomplete: number;
      rows: {
        sku: string;
        name: string;
        stock: number | null;
        minStock: number | null;
        reserved: number | null;
        unit: string;
      }[];
    } | null;
    overdueOrders:
      | { id: string; title: string; dueDate: string; debt: number | null }[]
      | null;
    installations: { label: string; count: number }[] | null;
  };
  quality: {
    issues: { code: string; message: string; count?: number }[];
    sourceCoverage: { known: number; total: number; percent: number | null };
    limitations: string[];
  };
  definitions: MetricDefinition[];
};
export const analyticsMoney = (value: number | null | undefined) =>
  value == null
    ? '—'
    : new Intl.NumberFormat('ru-RU', {
        style: 'currency',
        currency: 'RUB',
        maximumFractionDigits: 2,
      }).format(value);
export const analyticsDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value.slice(8)}.${value.slice(5, 7)}.${value.slice(0, 4)}`
    : '—';
export const analyticsToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
export const dateShift = (value: string, days: number) =>
  new Date(Date.parse(value) + days * 86_400_000).toISOString().slice(0, 10);
const csvCell = (value: unknown) => {
  let result =
    typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  // Text that spreadsheet apps could execute is always escaped, including leading whitespace.
  if (typeof value !== 'number' && /^[\s\uFEFF]*[=+@\-\t\r]/u.test(result))
    result = `'${result}`;
  return `"${result.replaceAll('"', '""')}"`;
};
export function analyticsCsv(report: AnalyticsReport) {
  const rows: unknown[][] = [
    ['Мастерская · Аналитика'],
    ['Период', report.period.from, report.period.to],
    ['Сравнение', report.period.previous.from, report.period.previous.to],
    ['Версия показателей', report.metricVersion],
    ['Снимок', report.snapshotId],
    ['Сформировано', report.generatedAt],
    ['Валюта', 'RUB'],
    ['Налоговая база', 'Как в Google; не определена отдельно'],
    ...report.sources.map((s) => ['Источник', s.label, s.state, s.loadedAt]),
    ...report.quality.issues.map((i) => ['Предупреждение', i.message, i.count]),
    ...report.quality.limitations.map((text) => ['Ограничение', text]),
    [],
    ['Показатель', 'Значение', 'Основание'],
    ['Поступления', report.overview.finance?.income, 'Дата платежа'],
    ['Выплаты', report.overview.finance?.expense, 'Дата расхода'],
    ['Денежный поток', report.overview.finance?.net, 'Даты операций'],
    [
      'Новые заказы',
      report.overview.orders?.count,
      'Дата заказа; кроме отменённых',
    ],
    [
      'Сумма новых заказов',
      report.overview.orders?.amount,
      'Текущее значение формулы',
    ],
    [
      'Оценочная прибыль новых заказов',
      report.overview.orders?.profit,
      'Оценка: 50% суммы заказа до рекламы',
    ],
    [
      'Долг по всем заказам',
      report.overview.current?.debt,
      'Текущее состояние; вне периода',
    ],
    [],
    ['Денежные операции'],
    ['Дата', 'Тип', 'Категория', 'Сумма', 'Счёт', 'Заказ', 'ID'],
    ...report.finance.transactions.map((t) => [
      t.date,
      t.type === 'income' ? 'Приход' : 'Расход',
      t.category,
      t.amount,
      t.account,
      t.orderNumber,
      t.id,
    ]),
    [],
    ['Заказы по дате создания'],
    [
      'Номер',
      'Название',
      'Дата заказа',
      'Текущий статус',
      'Сумма',
      'Оплачено всего',
      'Долг',
      'Оценочная прибыль',
      'Источник клиента',
    ],
    ...report.orders.rows.map((o) => [
      o.id,
      o.title,
      o.createdDate,
      o.status,
      o.amount,
      o.paid,
      o.debt,
      o.profit,
      o.source,
    ]),
    [],
    ['Определения'],
    ...report.definitions.map((d) => [d.label, d.basis, d.rule, d.source]),
  ];
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(';')).join('\r\n');
}
