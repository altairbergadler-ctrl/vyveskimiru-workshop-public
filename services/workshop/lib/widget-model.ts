export type WidgetKind =
  | 'deadlines'
  | 'ready'
  | 'waiting'
  | 'installations'
  | 'pickup'
  | 'crm'
  | 'stock'
  | 'debt'
  | 'transactions'
  | 'favorites'
  | 'week'
  | 'consumption'
  | 'cashflow'
  | 'actions';
export type Widget = {
  id: string;
  kind: WidgetKind;
  size: 'compact' | 'expanded';
  days: number;
  filter: string;
  owner: string;
  category: string;
  account: string;
  showUndated: boolean;
  photos: boolean;
  month: string;
  pinned: string[];
  actions: string[];
};
export type WidgetLayout = { version: 1; widgets: Widget[] };
export type BoardOrder = {
  id: string;
  title: string;
  client: string;
  manager: string;
  status: string;
  dueDate: string | null;
  manufacturingDone: boolean;
  debt: number;
  amount: number;
  paid: number;
  production: { name: string; done: boolean; product: string }[];
  installations: {
    id: string;
    date: string;
    time: string;
    status: string;
    address: string;
    assignee: string;
    contact: string;
    phone: string;
  }[];
};
export type BoardData = {
  orders: BoardOrder[];
  statuses: string[];
  updatedAt: string;
  warnings: string[];
};
export type StockItem = {
  sku: string;
  name: string;
  category: string;
  unit: string;
  stock: number;
  reserved: number;
  minStock: number;
  location: string;
  photoUrl?: string | null;
  used: Record<number, number>;
};
export type StockData = {
  items: StockItem[];
  today: string;
  refreshedAt: string;
};
export type WidgetTransaction = {
  id: string;
  type: 'income' | 'expense';
  date: string;
  amount: number;
  description: string;
  account: string;
  orderNumber: string | null;
};
export const catalog: {
  kind: WidgetKind;
  title: string;
  description: string;
  group: string;
  disabled?: boolean;
}[] = [
  {
    kind: 'deadlines',
    title: 'Заказы по срокам',
    description: 'Ближайшие сроки, задержки и заказы без даты',
    group: 'Работа',
  },
  {
    kind: 'ready',
    title: 'Можно запускать',
    description: 'Этапы, для которых выполнены зависимости',
    group: 'Работа',
  },
  {
    kind: 'waiting',
    title: 'Что задерживает производство',
    description: 'Ожидающие этапы и причины ожидания',
    group: 'Работа',
  },
  {
    kind: 'installations',
    title: 'Ближайшие монтажи',
    description: 'Назначенные выезды и согласование',
    group: 'Работа',
  },
  {
    kind: 'pickup',
    title: 'Готово к выдаче',
    description: 'Готовые заказы и остатки оплаты',
    group: 'Работа',
  },
  {
    kind: 'crm',
    title: 'Задачи CRM',
    description: 'CRM временно отключена. Возвращение — отдельный этап.',
    group: 'Работа',
    disabled: true,
  },
  {
    kind: 'stock',
    title: 'Материалы к пополнению',
    description: 'Свободный остаток, резерв и минимум',
    group: 'Склад',
  },
  {
    kind: 'debt',
    title: 'Остатки оплаты',
    description: 'Клиенты и заказы с положительным остатком',
    group: 'Финансы',
  },
  {
    kind: 'transactions',
    title: 'Последние операции',
    description: 'Доходы и расходы с фильтром по счёту',
    group: 'Финансы',
  },
  {
    kind: 'favorites',
    title: 'Избранные заказы',
    description: 'Закреплённые заказы, этапы и оплата',
    group: 'Работа',
  },
  {
    kind: 'week',
    title: 'План недели',
    description: 'Сроки заказов, этапы и выездные монтажи',
    group: 'Работа',
  },
  {
    kind: 'consumption',
    title: 'Расход материалов',
    description: 'Выдачи на заказы за 7, 30 или 90 дней',
    group: 'Склад',
  },
  {
    kind: 'cashflow',
    title: 'Денежный поток',
    description: 'Доходы и расходы по дням месяца',
    group: 'Финансы',
  },
  {
    kind: 'actions',
    title: 'Быстрые действия',
    description: 'Оплата, расход, выдача материала и новый заказ',
    group: 'Работа',
  },
];
export const quickActions = [
  ['income', 'Добавить доход'],
  ['expense', 'Денежный расход'],
  ['issue', 'Выдать материал'],
  ['order', 'Создать заказ'],
] as const;
export function newWidget(
  kind: WidgetKind,
  id: string = globalThis.crypto.randomUUID(),
): Widget {
  return {
    id,
    kind,
    size: ['deadlines', 'ready', 'week', 'cashflow'].includes(kind)
      ? 'expanded'
      : 'compact',
    days: kind === 'consumption' ? 30 : 7,
    filter: kind === 'stock' ? 'low' : 'all',
    owner: '',
    category: '',
    account: '',
    showUndated: true,
    photos: true,
    month: '',
    pinned: [],
    actions: quickActions.map(([key]) => key),
  };
}
export function defaultLayout(): WidgetLayout {
  return {
    version: 1,
    widgets: (
      [
        'deadlines',
        'installations',
        'ready',
        'stock',
        'pickup',
        'actions',
      ] as WidgetKind[]
    ).map((kind, i) => newWidget(kind, `default-${i}`)),
  };
}
// Only presentation preferences are persisted, never records, amounts or credentials.
export function parseLayout(raw: string | null): WidgetLayout {
  if (!raw) return defaultLayout();
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || !Array.isArray(parsed.widgets))
      return defaultLayout();
    const ids = new Set<string>();
    const widgets: Widget[] = [];
    for (const entry of parsed.widgets.slice(0, 24)) {
      if (
        !entry ||
        !catalog.some((c) => c.kind === entry.kind && !c.disabled) ||
        typeof entry.id !== 'string' ||
        !/^[\w-]{1,80}$/.test(entry.id) ||
        ids.has(entry.id)
      )
        continue;
      ids.add(entry.id);
      const clean = newWidget(entry.kind, entry.id);
      clean.size = entry.size === 'compact' ? 'compact' : 'expanded';
      clean.days = [7, 30, 90].includes(entry.days) ? entry.days : clean.days;
      for (const key of ['filter', 'owner', 'category', 'account'] as const)
        clean[key] =
          typeof entry[key] === 'string'
            ? entry[key].slice(0, 160)
            : clean[key];
      clean.month =
        typeof entry.month === 'string' &&
        /^\d{4}-(0[1-9]|1[0-2])$/.test(entry.month)
          ? entry.month
          : '';
      clean.showUndated = entry.showUndated !== false;
      clean.photos = entry.photos !== false;
      clean.pinned = Array.isArray(entry.pinned)
        ? [
            ...new Set<string>(
              entry.pinned.filter(
                (v: unknown) => typeof v === 'string' && v.length <= 100,
              ),
            ),
          ].slice(0, 20)
        : [];
      clean.actions = Array.isArray(entry.actions)
        ? [
            ...new Set<string>(
              entry.actions.filter((v: string) =>
                quickActions.some(([key]) => key === v),
              ),
            ),
          ]
        : clean.actions;
      widgets.push(clean);
    }
    return { version: 1, widgets };
  } catch {
    return defaultLayout();
  }
}
export function moveWidget(
  layout: WidgetLayout,
  id: string,
  target: number,
): WidgetLayout {
  const from = layout.widgets.findIndex((w) => w.id === id);
  if (
    from < 0 ||
    target < 0 ||
    target >= layout.widgets.length ||
    from === target
  )
    return layout;
  const widgets = [...layout.widgets];
  const [widget] = widgets.splice(from, 1);
  widgets.splice(target, 0, widget);
  return { ...layout, widgets };
}
export function localDay(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function shiftDay(day: string, offset: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
export function deadlineOrders(
  orders: BoardOrder[],
  widget: Widget,
  today: string,
) {
  return orders
    .filter(
      (o) => !o.manufacturingDone && !['Сдан', 'Отменён'].includes(o.status),
    )
    .filter((o) => !widget.owner || o.manager === widget.owner)
    .filter((o) => {
      if (widget.filter === 'undated') return !o.dueDate;
      if (widget.filter === 'overdue') return !!o.dueDate && o.dueDate < today;
      if (!o.dueDate) return widget.showUndated;
      return o.dueDate <= shiftDay(today, widget.days - 1);
    })
    .sort(
      (a, b) =>
        (a.dueDate || '9999').localeCompare(b.dueDate || '9999') ||
        a.id.localeCompare(b.id, 'ru'),
    );
}
export function freeStock(item: StockItem) {
  return Math.max(item.stock - item.reserved, 0);
}
export function stockItems(items: StockItem[], widget: Widget) {
  return items
    .filter((i) => !widget.category || i.category === widget.category)
    .filter((i) =>
      widget.kind === 'consumption'
        ? (i.used[widget.days] || 0) > 0
        : widget.filter !== 'low' || freeStock(i) <= i.minStock,
    )
    .sort((a, b) =>
      widget.kind === 'consumption'
        ? a.unit.localeCompare(b.unit, 'ru') ||
          (b.used[widget.days] || 0) - (a.used[widget.days] || 0)
        : freeStock(a) / Math.max(a.minStock, 1) -
          freeStock(b) / Math.max(b.minStock, 1),
    );
}
export function debtGroups(orders: BoardOrder[], widget: Widget) {
  const groups = new Map<string, BoardOrder[]>();
  for (const o of orders) {
    if (!(o.debt > 0) || (widget.filter === 'delivered' && o.status !== 'Сдан'))
      continue;
    const key = o.client || 'Клиент не указан';
    groups.set(key, [...(groups.get(key) || []), o]);
  }
  return [...groups]
    .map(([client, list]) => ({
      client,
      orders: list,
      total: list.reduce((n, o) => n + o.debt, 0),
    }))
    .sort((a, b) => b.total - a.total);
}
export function installationRows(
  orders: BoardOrder[],
  widget: Widget,
  today: string,
) {
  return orders
    .filter((o) => o.status !== 'Отменён')
    .flatMap((order) =>
      (order.installations || []).map((installation) => ({
        order,
        installation,
      })),
    )
    .filter(
      ({ installation: i }) =>
        !['Выполнен', 'Отменён'].includes(i.status) &&
        (!widget.owner || i.assignee === widget.owner),
    )
    .filter(({ installation: i }) =>
      widget.filter === 'unassigned'
        ? i.status === 'На согласовании'
        : !i.date
          ? widget.showUndated
          : i.date <= shiftDay(today, widget.days - 1),
    )
    .sort(
      (a, b) =>
        (a.installation.date || '9999').localeCompare(
          b.installation.date || '9999',
        ) ||
        (a.installation.time || '').localeCompare(b.installation.time || ''),
    );
}
export function transactionRows(rows: WidgetTransaction[], widget: Widget) {
  return rows
    .filter((t) => !widget.account || t.account === widget.account)
    .filter(
      (t) =>
        widget.filter === 'all' ||
        !['income', 'expense'].includes(widget.filter) ||
        t.type === widget.filter,
    )
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}
export function cashflowRows(rows: WidgetTransaction[], month: string) {
  const count = new Date(
    Number(month.slice(0, 4)),
    Number(month.slice(5)),
    0,
  ).getDate();
  const days = Array.from({ length: count }, (_, index) => ({
    date: `${month}-${String(index + 1).padStart(2, '0')}`,
    day: index + 1,
    income: 0,
    expense: 0,
  }));
  for (const t of rows) {
    const index = Number(t.date.slice(8)) - 1;
    if (t.date.startsWith(`${month}-`) && days[index])
      days[index][t.type] += t.amount;
  }
  return days;
}
export function orderHref(id: string, tab = 'overview') {
  return `/kanban/?order=${encodeURIComponent(id)}&tab=${encodeURIComponent(tab)}`;
}
