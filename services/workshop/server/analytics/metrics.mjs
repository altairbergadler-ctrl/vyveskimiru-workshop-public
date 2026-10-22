import {
  AnalyticsError,
  definitions,
  connections,
  isDate,
  shiftDate,
  METRIC_VERSION,
} from './contracts.mjs';

const within = (date, p) => isDate(date) && date >= p.from && date <= p.to;
const cancelled = (order) => order.status === 'Отменён';
const closed = (order) =>
  ['Сдан', 'Отменён', 'Выполненная'].includes(order.status);
const clean = (value) =>
  String(value ?? '')
    .trim()
    .slice(0, 300);
const numeric = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
// Fixed-point additions preserve source cents; unavailable formula values never become zero.
export function cents(value) {
  if (numeric(value) === null) return null;
  const scaled = Math.round(value * 100);
  return Number.isSafeInteger(scaled) &&
    Math.abs(scaled / 100 - value) < 0.000001
    ? scaled
    : null;
}
export function sumMoney(rows, select) {
  let result = 0;
  for (const row of rows) {
    const value = cents(select(row));
    if (value === null || !Number.isSafeInteger(result + value)) return null;
    result += value;
  }
  return result / 100;
}
const difference = (a, b) =>
  a === null || b === null ? null : sumMoney([a, -b], (value) => value);
const safeAmount = (value) => (cents(value) === null ? null : value);
const issue = (code, message, count) => ({
  code,
  message,
  ...(count === undefined ? {} : { count }),
});
export function projectFinance(value) {
  if (!Array.isArray(value?.records) || value.missingIds?.length)
    throw new AnalyticsError(
      'ANALYTICS_FINANCE_INCOMPLETE',
      'Не подтверждены все финансовые записи.',
    );
  const seen = new Set();
  const records = value.records.map((row) => {
    if (
      !row.id ||
      seen.has(row.id) ||
      !isDate(row.date) ||
      !['income', 'expense'].includes(row.type) ||
      cents(row.amount) === null
    )
      throw new AnalyticsError(
        'ANALYTICS_FINANCE_INVALID',
        'Не удалось проверить финансовые записи.',
      );
    seen.add(row.id);
    return {
      id: clean(row.id),
      date: row.date,
      type: row.type,
      amount: row.amount,
      category: clean(row.category),
      account: clean(row.account),
      orderNumber: row.orderNumber ? clean(row.orderNumber) : null,
    };
  });
  return { records };
}
export function projectOrders(board) {
  if (!Array.isArray(board?.orders) || !Array.isArray(board.statuses))
    throw new AnalyticsError(
      'ANALYTICS_ORDERS_INVALID',
      'Не удалось проверить список заказов.',
    );
  const seen = new Set(),
    issues = [];
  const orders = board.orders.map((order) => {
    if (!order.id || seen.has(order.id))
      throw new AnalyticsError(
        'ANALYTICS_ORDER_ID',
        'Номера заказов отсутствуют или повторяются.',
      );
    seen.add(order.id);
    const source =
      order.contacts?.length === 1 ? clean(order.contacts[0].source) : '';
    return {
      id: clean(order.id),
      title: clean(order.title),
      client: clean(order.client),
      status: clean(order.status),
      createdDate: clean(order.createdDate),
      dueDate: clean(order.dueDate),
      amount: safeAmount(order.amount),
      paid: safeAmount(order.paid),
      debt: safeAmount(order.debt),
      profit: safeAmount(order.profit),
      source: source || 'Не определён',
      sourceKnown: Boolean(source),
      clientRow: order.contacts?.length === 1 ? order.contacts[0].edit?.record?.rowNumber ?? null : null,
      items: (order.items || []).map((item) => ({
        row: Number.isSafeInteger(item.row) ? item.row : null,
        name: clean(item.name),
        quantity: numeric(item.quantity),
        unit: clean(item.unit),
        amount: safeAmount(item.amount),
      })),
      installations: (order.installations || []).map((item) => ({
        status: clean(item.status),
        date: clean(item.date),
      })),
    };
  });
  const missingDates = orders.filter((o) => !isDate(o.createdDate)).length;
  if (missingDates)
    issues.push(
      issue(
        'order_dates',
        'Заказы без корректной даты не включены в отчёты за период.',
        missingDates,
      ),
    );
  const missingMoney = orders.filter((o) =>
    ['amount', 'paid', 'debt', 'profit'].some((key) => o[key] === null),
  ).length;
  if (missingMoney)
    issues.push(
      issue(
        'order_formulas',
        'Некоторые денежные итоги заказов недоступны. Зависимые суммы показаны прочерком.',
        missingMoney,
      ),
    );
  if (board.warnings?.length)
    issues.push(
      issue(
        'board_warnings',
        'В исходной доске есть предупреждения о связях или структуре. Проверьте раздел «Заказы».',
        board.warnings.length,
      ),
    );
  return { orders, statuses: board.statuses.map(clean), issues, clients: board.analyticsClients ?? null };
}
export function projectProduction(value) {
  if (!Array.isArray(value?.tasks))
    throw new AnalyticsError(
      'ANALYTICS_PRODUCTION_INVALID',
      'Не удалось проверить производство.',
    );
  return {
    today: value.today,
    tasks: value.tasks.map((task) => ({
      orderId: clean(task.orderNumber),
      completed: Boolean(task.completed),
      ready: task.availability === 'можно',
      overdue: Boolean(task.overdue),
    })),
  };
}
export function projectWarehouse(value) {
  if (!Array.isArray(value?.items))
    throw new AnalyticsError(
      'ANALYTICS_WAREHOUSE_INVALID',
      'Не удалось проверить склад.',
    );
  return {
    items: value.items.map((item) => ({
      sku: clean(item.sku),
      name: clean(item.name),
      stock: numeric(item.stock),
      minStock: numeric(item.minStock),
      reserved: numeric(item.reserved),
      unit: clean(item.unit),
    })),
  };
}
function financeTotals(records, p) {
  const rows = records.filter((row) => within(row.date, p));
  const income = rows.filter((r) => r.type === 'income'),
    expense = rows.filter((r) => r.type === 'expense');
  const incoming = sumMoney(income, (r) => r.amount),
    outgoing = sumMoney(expense, (r) => r.amount);
  return {
    income: incoming,
    expense: outgoing,
    net: difference(incoming, outgoing),
    operations: rows.length,
    measurements: sumMoney(
      income.filter((r) => r.category === 'Замеры' && !r.orderNumber),
      (r) => r.amount,
    ),
    advertisingPayments: sumMoney(
      expense.filter((r) => r.category === 'Реклама и продвижение'),
      (r) => r.amount,
    ),
  };
}
function orderTotals(orders, p) {
  const cohort = orders.filter((o) => within(o.createdDate, p)),
    accepted = cohort.filter((o) => !cancelled(o));
  const amount = sumMoney(accepted, (o) => o.amount);
  return {
    count: accepted.length,
    cancelled: cohort.length - accepted.length,
    amount,
    profit: sumMoney(accepted, (o) => o.profit),
    paid: sumMoney(accepted, (o) => o.paid),
    average:
      amount === null || !accepted.length
        ? null
        : Math.round((amount * 100) / accepted.length) / 100,
  };
}
function groups(rows, key, transform) {
  const result = new Map();
  for (const row of rows) {
    const label = key(row) || 'Не указан';
    if (!result.has(label)) result.set(label, []);
    result.get(label).push(row);
  }
  return [...result.entries()].map(([label, items]) => ({
    label,
    ...transform(items),
  }));
}
export function buildReport(sources, period, snapshotId, generatedAt) {
  const finance = sources.finance.data,
    business = sources.orders.data,
    production = sources.production.data,
    warehouse = sources.warehouse.data;
  const records = finance?.records || [],
    orders = business?.orders || [];
  const selected = orders.filter((o) => within(o.createdDate, period)),
    accepted = selected.filter((o) => !cancelled(o));
  const periodRecords = records.filter((r) => within(r.date, period));
  const sourceRows = groups(
    accepted,
    (o) => o.source,
    (rows) => ({
      orders: rows.length,
      amount: sumMoney(rows, (r) => r.amount),
      profit: sumMoney(rows, (r) => r.profit),
      known: rows.every((r) => r.sourceKnown),
    }),
  );
  const knownCount = accepted.filter((o) => o.sourceKnown).length;
  const active = orders.filter((o) => !closed(o)),
    nonCancelled = orders.filter((o) => !cancelled(o));
  const validDebts = nonCancelled.every((o) => o.debt !== null);
  const pendingTasks =
    production?.tasks.filter(
      (t) => !t.completed && active.some((o) => o.id === t.orderId),
    ) || [];
  const issues = [...(business?.issues || [])];
  const orphanPayments = records.filter(
    (r) => r.orderNumber && !orders.some((o) => o.id === r.orderNumber),
  );
  if (finance && business && orphanPayments.length)
    issues.push(
      issue(
        'orphan_finance',
        'Есть операции со ссылкой на отсутствующий заказ. Денежные суммы сохранены отдельно от заказов.',
        orphanPayments.length,
      ),
    );
  if (accepted.some((o) => !o.sourceKnown))
    issues.push(
      issue(
        'unknown_source',
        'Источник клиента заполнен или связан не для всех новых заказов.',
        accepted.length - knownCount,
      ),
    );
  for (const source of Object.values(sources))
    if (source.state !== 'ready')
      issues.push(
        issue(
          source.id,
          source.state === 'stale'
            ? `${source.label}: показаны ранее полученные данные. Обновление не подтверждено.`
            : `${source.label}: данные пока недоступны.`,
        ),
      );
  const daily = [];
  if (finance)
    for (let date = period.from; date <= period.to; date = shiftDate(date, 1))
      daily.push({ date, ...financeTotals(records, { from: date, to: date }) });
  const statusRows = business
    ? [
        ...new Set([...business.statuses, ...selected.map((o) => o.status)]),
      ].map((status) => ({
        label: status || 'Без статуса',
        count: selected.filter((o) => o.status === status).length,
      }))
    : [];
  const statusesTotal = statusRows.reduce((n, row) => n + row.count, 0);
  const lowStock =
    warehouse?.items.filter(
      (i) =>
        i.stock === null ||
        i.minStock === null ||
        i.reserved === null ||
        i.stock - i.reserved < i.minStock,
    ) || [];
  const missingStock = warehouse?.items.filter(
    (i) => i.stock === null || i.minStock === null || i.reserved === null,
  ).length;
  if (missingStock)
    issues.push(
      issue(
        'warehouse_numbers',
        'У материалов не заполнены или некорректны остаток, минимум или резерв. Они включены в список проверки склада.',
        missingStock,
      ),
    );
  return {
    metricVersion: METRIC_VERSION,
    snapshotId,
    generatedAt,
    period,
    currency: 'RUB',
    taxBasis: 'source_unspecified',
    sources: Object.values(sources).map(({ data: _data, ...source }) => source),
    quality: {
      issues,
      sourceCoverage: {
        known: knownCount,
        total: accepted.length,
        percent: accepted.length
          ? Math.round((knownCount * 100) / accepted.length)
          : null,
      },
      limitations: [
        'Календарные даты Google сохраняются без сдвига часового пояса. Сегодня и границы периода — по Москве.',
        'История ограничена текущими строками Google: удалённые записи и прошлые версии формул не восстанавливаются.',
        'Несколько листов читаются последовательно или параллельно; это не атомарный снимок Google.',
        'Источник клиента не равен подтверждённому источнику рекламы. Реестр обращений и история стадий ещё не подключены.',
      ],
    },
    overview: {
      finance: finance ? financeTotals(records, period) : null,
      previousFinance: finance ? financeTotals(records, period.previous) : null,
      orders: business ? orderTotals(orders, period) : null,
      previousOrders: business ? orderTotals(orders, period.previous) : null,
      current: business
        ? {
            activeOrders: active.length,
            overdueOrders: active.filter(
              (o) => isDate(o.dueDate) && o.dueDate < period.today,
            ).length,
            debt: validDebts
              ? sumMoney(
                  nonCancelled.filter((o) => o.debt > 0),
                  (o) => o.debt,
                )
              : null,
            overpayments: validDebts
              ? sumMoney(
                  nonCancelled.filter((o) => o.debt < 0),
                  (o) => -o.debt,
                )
              : null,
          }
        : null,
    },
    finance: {
      daily,
      categories: groups(
        periodRecords.filter((r) => r.type === 'expense'),
        (r) => r.category,
        (rows) => ({
          amount: sumMoney(rows, (r) => r.amount),
          count: rows.length,
        }),
      ).sort((a, b) => (b.amount || 0) - (a.amount || 0)),
      accounts: groups(
        periodRecords,
        (r) => r.account,
        (rows) => financeTotals(rows, period),
      ),
      transactions: periodRecords
        .slice()
        .sort((a, b) => b.date.localeCompare(a.date)),
    },
    orders: {
      rows: selected
        .slice()
        .sort(
          (a, b) =>
            b.createdDate.localeCompare(a.createdDate) ||
            a.id.localeCompare(b.id, 'ru', { numeric: true }),
        ),
      statuses: statusRows,
      statusesTotal,
      products: groups(
        accepted.flatMap((o) => o.items.map((i) => ({ ...i, orderId: o.id }))),
        (i) => i.name,
        (rows) => ({
          amount: sumMoney(rows, (r) => r.amount),
          orders: new Set(rows.map((r) => r.orderId)).size,
        }),
      ),
    },
    acquisition: {
      connections,
      manualSources: sourceRows.sort((a, b) => b.orders - a.orders),
      advertising: null,
      leads: null,
      romi: null,
    },
    operations: {
      production:
        production && business
          ? {
              open: pendingTasks.length,
              ready: pendingTasks.filter((t) => t.ready).length,
              overdue: pendingTasks.filter((t) => t.overdue).length,
            }
          : null,
      warehouse: warehouse
        ? {
            total: warehouse.items.length,
            attention: lowStock.length,
            belowMinimum: lowStock.filter(i => i.stock !== null && i.minStock !== null && i.reserved !== null).length,
            incomplete: missingStock || 0,
            rows: lowStock,
          }
        : null,
      overdueOrders: business
        ? active
            .filter((o) => isDate(o.dueDate) && o.dueDate < period.today)
            .map((o) => ({
              id: o.id,
              title: o.title,
              dueDate: o.dueDate,
              debt: o.debt,
            }))
        : null,
      installations: business
        ? groups(
            active.flatMap((o) => o.installations),
            (i) => i.status,
            (rows) => ({ count: rows.length }),
          )
        : null,
    },
    definitions,
  };
}
