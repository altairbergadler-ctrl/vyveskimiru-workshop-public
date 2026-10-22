/* oxlint-disable next/no-img-element -- Existing private warehouse photos. */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown,
  ArrowUp,
  Boxes,
  CalendarDays,
  Check,
  ChevronRight,
  CircleAlert,
  GripVertical,
  LayoutGrid,
  Plus,
  RefreshCw,
  Settings2,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type {
  ProductionData,
  ProductionTask,
} from '@/components/production-page';
import { useWidgetSource } from '@/hooks/use-widget-source';
import { useWidgetPacking } from '@/hooks/use-widget-packing';
import { useWidgetDrag } from '@/hooks/use-widget-drag';
import {
  cashflowRows,
  catalog,
  deadlineOrders,
  debtGroups,
  defaultLayout,
  freeStock,
  installationRows,
  localDay,
  moveWidget,
  newWidget,
  orderHref,
  parseLayout,
  quickActions,
  shiftDay,
  stockItems,
  transactionRows,
  type BoardData,
  type BoardOrder,
  type StockData,
  type Widget,
  type WidgetKind,
  type WidgetLayout,
  type WidgetTransaction,
} from '@/lib/widget-model';
import './home-widgets.css';

type Props = {
  revision: number;
  production: ProductionData | null;
  productionError: string;
  productionLoading: boolean;
  updatingRow: number | null;
  transactions: WidgetTransaction[];
  transactionsLoaded: boolean;
  financeError: string;
  financeLoading: boolean;
  financeUpdatedAt: string;
  onRefreshFinance: () => void;
  onRefreshProduction: () => void;
  onToggleProduction: (task: ProductionTask, completed: boolean) => void;
  onProduction: (query?: string) => void;
  onWarehouse: (sku?: string, refill?: boolean) => void;
  onIncome: (orderId?: string) => void;
  onExpense: (issue?: boolean) => void;
  onTransaction: (id: string) => void;
  onJournal: () => void;
};
const money = (value: number) =>
  new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(value);
const qty = (value: number) =>
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
const date = (value: string | null | undefined) =>
  value && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Intl.DateTimeFormat('ru-RU', {
        day: 'numeric',
        month: 'short',
      }).format(new Date(`${value}T12:00:00`))
    : 'Без даты';
const time = (value: string) =>
  value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat('ru-RU', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(value))
    : '';
const title = (kind: WidgetKind) =>
  catalog.find((item) => item.kind === kind)!.title;
const boardKinds = new Set<WidgetKind>([
  'deadlines',
  'installations',
  'pickup',
  'debt',
  'favorites',
  'week',
]);
const financialKinds = new Set<WidgetKind>(['transactions', 'cashflow']);
const stockKinds = new Set<WidgetKind>(['stock', 'consumption']);
function OrderLink({
  order,
  tab,
  children,
}: {
  order: BoardOrder;
  tab?: string;
  children?: React.ReactNode;
}) {
  return (
    <a className="hw-order-link" href={orderHref(order.id, tab)}>
      {children || `№${order.id} · ${order.title || 'Заказ без названия'}`}
      <ChevronRight size={14} />
    </a>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="hw-empty">{children}</p>;
}
function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <label className="hw-field">
      <span>{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map(([id, text]) => (
          <option key={id} value={id}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function HomeWidgets(props: Props) {
  const [profile, setProfile] = useState(() =>
    window.matchMedia('(max-width: 767px)').matches ? 'mobile' : 'desktop',
  );
  const storageKey = `workshop.home.widgets.v1.${profile}`;
  const [storageError, setStorageError] = useState('');
  const [layout, setLayout] = useState<WidgetLayout>(() => {
    try {
      return parseLayout(localStorage.getItem(storageKey));
    } catch {
      return defaultLayout();
    }
  });
  const [editing, setEditing] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [legacyCashflow, setLegacyCashflow] = useState(false);
  const [legacyChart, setLegacyChart] = useState(() =>
    newWidget('cashflow', 'legacy-cashflow'),
  );
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('Все');
  const [undo, setUndo] = useState<WidgetLayout | null>(null);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [notice, setNotice] = useState('');
  const [selectedTask, setSelectedTask] = useState<ProductionTask | null>(null);
  const [weekOffset, setWeekOffset] = useState<Record<string, number>>({});
  const gridRef = useWidgetPacking(
    layout.widgets.map((widget) => widget.id).join('|'),
  );
  const financeRefresh = useRef(props.onRefreshFinance);
  useEffect(() => {
    financeRefresh.current = props.onRefreshFinance;
  }, [props.onRefreshFinance]);
  const needBoard =
    layout.widgets.some((w) => boardKinds.has(w.kind)) || !!settingsId;
  const needStock = layout.widgets.some((w) => stockKinds.has(w.kind));
  const needFinance =
    legacyCashflow || layout.widgets.some((w) => financialKinds.has(w.kind));
  const board = useWidgetSource<BoardData>(
    '/kanban/api/board',
    'orders',
    needBoard,
    props.revision,
  );
  const warehouse = useWidgetSource<StockData>(
    '/api/warehouse',
    'items',
    needStock,
    props.revision,
  );
  const orders = board.data?.orders || [];
  const tasks = props.production?.tasks || [];
  const today = localDay(); // Same browser calendar as the existing order board.
  useEffect(() => {
    // Existing bookmarked chart links also work when no chart is in this layout.
    const revealChart = () => {
      if (window.location.hash === '#cashflow') setLegacyCashflow(true);
    };
    queueMicrotask(revealChart);
    window.addEventListener('hashchange', revealChart);
    return () => window.removeEventListener('hashchange', revealChart);
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const change = () => {
      const next = media.matches ? 'mobile' : 'desktop';
      setProfile(next);
      try {
        setLayout(
          parseLayout(localStorage.getItem(`workshop.home.widgets.v1.${next}`)),
        );
      } catch {
        setLayout(defaultLayout());
        setStorageError(
          'Настройки недоступны. Изменения сохранятся только до закрытия страницы.',
        );
      }
      setUndo(null);
      setSettingsId(null);
      setDetailId(null);
    };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (!needFinance) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') financeRefresh.current();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [needFinance]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === storageKey && !editing && !settingsId) {
        setLayout(parseLayout(event.newValue));
        setUndo(null);
      }
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [storageKey, editing, settingsId]);
  const commit = (next: WidgetLayout) => {
    setNotice('');
    setUndo(layout);
    setLayout(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setStorageError('');
    } catch {
      setStorageError(
        'Не удалось сохранить настройки на устройстве. До закрытия страницы они продолжат работать.',
      );
    }
  };
  const drag = useWidgetDrag((id, targetId) => {
    const index = layout.widgets.findIndex((widget) => widget.id === targetId);
    if (editing && index >= 0) commit(moveWidget(layout, id, index));
  });
  const update = (id: string, patch: Partial<Widget>) => {
    if (id === 'legacy-cashflow') {
      setLegacyChart((previous) => ({ ...previous, ...patch }));
      return;
    }
    commit({
      ...layout,
      widgets: layout.widgets.map((w) =>
        w.id === id ? { ...w, ...patch } : w,
      ),
    });
  };
  const add = (kind: WidgetKind, from?: Widget) => {
    if (layout.widgets.length >= 24) {
      setNotice(
        'На главной уже 24 виджета. Уберите ненужный, чтобы добавить новый.',
      );
      return;
    }
    const widget = from
      ? { ...from, id: crypto.randomUUID() }
      : newWidget(kind);
    commit({ ...layout, widgets: [...layout.widgets, widget] });
    setNotice(`Добавлен: ${title(kind)}`);
  };
  const remove = (id: string) => {
    commit({ ...layout, widgets: layout.widgets.filter(widget => widget.id !== id) });
    if (settingsId === id) setSettingsId(null);
    if (detailId === id) setDetailId(null);
    setNotice('Виджет убран');
  };
  const settings = layout.widgets.find((w) => w.id === settingsId);
  const detail =
    layout.widgets.find((w) => w.id === detailId) ||
    (legacyCashflow ? legacyChart : undefined);
  const activeTask = selectedTask
    ? tasks.find((t) => t.key === selectedTask.key)
    : undefined;
  const resources = (w: Widget) => {
    const states: {
      hasData: boolean;
      loading: boolean;
      error: string;
      updatedAt: string;
      refresh: () => void;
    }[] = [];
    if (boardKinds.has(w.kind))
      states.push({ hasData: !!board.data, ...board });
    if (stockKinds.has(w.kind))
      states.push({ hasData: !!warehouse.data, ...warehouse });
    if (['ready', 'waiting', 'week'].includes(w.kind))
      states.push({
        hasData: !!props.production,
        loading: props.productionLoading,
        error: props.productionError,
        updatedAt: props.production?.refreshedAt || '',
        refresh: props.onRefreshProduction,
      });
    if (financialKinds.has(w.kind))
      states.push({
        hasData: props.transactionsLoaded,
        loading: props.financeLoading,
        error: props.financeError,
        updatedAt: props.financeUpdatedAt,
        refresh: props.onRefreshFinance,
      });
    return states;
  };
  const renderFilters = (w: Widget) => (
    <div className="hw-filters">
      {w.kind === 'deadlines' && (
        <>
          <Select
            label="Сроки"
            value={w.filter}
            options={[
              ['all', 'Ближайшие'],
              ['overdue', 'Просрочены'],
              ['undated', 'Без срока'],
            ]}
            onChange={(filter) => update(w.id, { filter })}
          />
          <Select
            label="Период"
            value={String(w.days)}
            options={[
              ['7', '7 дней'],
              ['30', '30 дней'],
              ['90', '90 дней'],
            ]}
            onChange={(days) => update(w.id, { days: Number(days) })}
          />
        </>
      )}
      {['ready', 'waiting'].includes(w.kind) && (
        <Select
          label="План"
          value={w.filter}
          options={[
            ['all', 'Все даты'],
            ['today', 'Сегодня'],
            ['week', '7 дней'],
          ]}
          onChange={(filter) => update(w.id, { filter })}
        />
      )}
      {w.kind === 'installations' && (
        <Select
          label="Монтажи"
          value={w.filter}
          options={[
            ['all', 'Ближайшие'],
            ['unassigned', 'На согласовании'],
          ]}
          onChange={(filter) => update(w.id, { filter })}
        />
      )}
      {w.kind === 'debt' && (
        <Select
          label="Заказы"
          value={w.filter}
          options={[
            ['all', 'Все с остатком'],
            ['delivered', 'Только сданные'],
          ]}
          onChange={(filter) => update(w.id, { filter })}
        />
      )}
      {w.kind === 'transactions' && (
        <Select
          label="Операции"
          value={w.filter}
          options={[
            ['all', 'Все'],
            ['income', 'Доходы'],
            ['expense', 'Расходы'],
          ]}
          onChange={(filter) => update(w.id, { filter })}
        />
      )}
      {w.kind === 'consumption' && (
        <Select
          label="Расход за"
          value={String(w.days)}
          options={[
            ['7', '7 дней'],
            ['30', '30 дней'],
            ['90', '90 дней'],
          ]}
          onChange={(days) => update(w.id, { days: Number(days) })}
        />
      )}
    </div>
  );

  function renderContent(w: Widget, full = false): React.ReactNode {
    const limit = full ? Infinity : w.size === 'compact' ? 3 : 6;
    const list = <T,>(
      rows: T[],
      render: (row: T, i: number) => React.ReactNode,
      empty: string,
    ) => (
      <>
        {rows.length ? (
          <div className="hw-list">{rows.slice(0, limit).map(render)}</div>
        ) : (
          <Empty>{empty}</Empty>
        )}
        {rows.length > limit && (
          <button className="hw-more" onClick={() => setDetailId(w.id)}>
            Показать все: {rows.length}
            <ChevronRight size={15} />
          </button>
        )}
      </>
    );
    if (
      w.kind === 'deadlines' ||
      w.kind === 'pickup' ||
      w.kind === 'favorites'
    ) {
      const rows =
        w.kind === 'deadlines'
          ? deadlineOrders(orders, w, today)
          : w.kind === 'pickup'
            ? orders.filter(
                (o) =>
                  o.status === 'Готов к выдаче' &&
                  (!w.owner || w.owner === o.manager),
              )
            : w.pinned.flatMap((id) => orders.filter((o) => o.id === id));
      return (
        <>
          {list(
            rows,
            (o) => (
              <div key={o.id} className="hw-row">
                <div className="hw-row-main">
                  <OrderLink order={o} />
                  <p>{o.client || 'Клиент не указан'}</p>
                  <div className="hw-meta">
                    <span className="hw-badge">
                      {o.status || 'Без статуса'}
                    </span>
                    <span
                      className={
                        !o.manufacturingDone && !!o.dueDate && o.dueDate < today
                          ? 'hw-danger-text'
                          : ''
                      }
                    >
                      {o.dueDate ? `Срок: ${date(o.dueDate)}` : 'Срок не задан'}
                    </span>
                  </div>
                  {w.kind === 'favorites' && (
                    <p>
                      {
                        o.production.filter(
                          (p) => p.name !== 'Монтаж' && p.done,
                        ).length
                      }{' '}
                      из{' '}
                      {o.production.filter((p) => p.name !== 'Монтаж').length}{' '}
                      этапов изготовления
                    </p>
                  )}
                  {w.kind !== 'deadlines' && (
                    <p>
                      {o.debt > 0
                        ? `Остаток оплаты: ${money(o.debt)}`
                        : o.debt < 0
                          ? `Переплата: ${money(-o.debt)}`
                          : 'Оплачено'}
                    </p>
                  )}
                </div>
                {w.kind === 'pickup' && o.debt > 0 && (
                  <button
                    className="hw-small"
                    disabled={!!board.error || o.status === 'Отменён'}
                    onClick={() => props.onIncome(o.id)}
                  >
                    Принять оплату
                  </button>
                )}
              </div>
            ),
            w.kind === 'favorites'
              ? 'Закрепите нужные заказы через настройки виджета.'
              : 'Заказов по этим условиям нет.',
          )}
          {w.kind === 'favorites' && (
            <button
              className="hw-more"
              onClick={() => {
                setDetailId(null);
                setSettingsId(w.id);
              }}
            >
              <Star size={15} />
              Выбрать заказы
            </button>
          )}
        </>
      );
    }
    if (w.kind === 'ready' || w.kind === 'waiting') {
      const rows = tasks
        .filter(
          (t) =>
            !t.completed &&
            t.stage !== 'Монтаж' &&
            (w.kind === 'ready'
              ? t.availability === 'можно'
              : t.availability === 'ждёт'),
        )
        .filter((t) => !w.owner || t.assignee === w.owner)
        .filter((t) =>
          w.filter === 'today'
            ? t.plannedDate === props.production?.today
            : w.filter === 'week'
              ? !!t.plannedDate &&
                t.plannedDate >= props.production!.today &&
                t.plannedDate < shiftDay(props.production!.today, 7)
              : true,
        )
        .sort((a, b) =>
          (a.plannedDate || '9999').localeCompare(b.plannedDate || '9999'),
        );
      return list(
        rows,
        (t) => (
          <div className="hw-row" key={t.key}>
            <div className="hw-row-main">
              <button
                className="hw-text-button"
                onClick={() => setSelectedTask(t)}
              >
                {t.stage}
                <ChevronRight size={14} />
              </button>
              <p>
                №{t.orderNumber} · {t.item || t.orderName}
              </p>
              <div className="hw-meta">
                <span>{t.assignee || 'Исполнитель не назначен'}</span>
                <span>План: {date(t.plannedDate)}</span>
              </div>
              {w.kind === 'waiting' ? (
                <p className="hw-waiting">
                  Ждёт:{' '}
                  {t.waitingFor.join(', ') ||
                    'предыдущие этапы — уточните в карточке'}
                </p>
              ) : (
                <span className="hw-badge hw-green">Доступен к выполнению</span>
              )}
            </div>
            <button className="hw-small" onClick={() => setSelectedTask(t)}>
              Открыть
            </button>
          </div>
        ),
        w.kind === 'ready'
          ? 'Доступных этапов по этим условиям нет.'
          : 'Ожидающих этапов по этим условиям нет.',
      );
    }
    if (w.kind === 'installations')
      return list(
        installationRows(orders, w, today),
        ({ order: o, installation: i }, index) => (
          <div className="hw-row" key={`${o.id}-${i.id}-${index}`}>
            <div className="hw-date">
              <b>{date(i.date)}</b>
              <span>{i.time || 'Без времени'}</span>
            </div>
            <div className="hw-row-main">
              <OrderLink order={o} />
              <span className="hw-badge">{i.status}</span>
              <p>{i.address || 'Адрес не указан'}</p>
              <p>{i.assignee || 'Исполнитель не назначен'}</p>
            </div>
          </div>
        ),
        'Ближайших монтажей по этим условиям нет.',
      );
    if (stockKinds.has(w.kind)) {
      const rows = stockItems(warehouse.data?.items || [], w);
      return (
        <>
          {list(
            rows,
            (item) => (
              <div className="hw-row" key={item.sku}>
                {w.photos && item.photoUrl && (
                  <img
                    src={item.photoUrl}
                    loading="lazy"
                    alt=""
                    className="hw-photo"
                  />
                )}
                <div className="hw-row-main">
                  <button
                    className="hw-text-button"
                    onClick={() => props.onWarehouse(item.sku)}
                  >
                    {item.name}
                    <ChevronRight size={14} />
                  </button>
                  {w.kind === 'consumption' ? (
                    <p className="hw-quantity">
                      Выдано: {qty(item.used[w.days] || 0)} {item.unit}
                    </p>
                  ) : (
                    <>
                      <p
                        className={
                          freeStock(item) <= item.minStock
                            ? 'hw-danger-text'
                            : ''
                        }
                      >
                        Свободно: {qty(freeStock(item))} {item.unit}
                      </p>
                      <p>
                        Резерв: {qty(item.reserved)} · минимум:{' '}
                        {qty(item.minStock)} {item.unit}
                      </p>
                      {(w.size === 'expanded' || full) && (
                        <p>
                          {item.sku} · {item.location || 'Место не указано'}
                        </p>
                      )}
                    </>
                  )}
                </div>
                {w.kind === 'stock' && (
                  <button
                    className="hw-small"
                    disabled={!!warehouse.error}
                    onClick={() => props.onWarehouse(item.sku, true)}
                  >
                    Пополнить
                  </button>
                )}
              </div>
            ),
            w.kind === 'consumption'
              ? 'Выдач на заказы за этот период нет.'
              : 'Материалов по этим условиям нет.',
          )}
          <p className="hw-footnote">
            {w.kind === 'consumption'
              ? 'Только выдачи на заказы. Разные единицы не суммируются.'
              : 'Свободно = остаток − резерв, не меньше нуля.'}
          </p>
        </>
      );
    }
    if (w.kind === 'debt') {
      const groups = debtGroups(orders, w);
      return (
        <>
          <div className="hw-total">
            <span>Остаток по выбранным заказам</span>
            <b>{money(groups.reduce((n, g) => n + g.total, 0))}</b>
          </div>
          {list(
            groups,
            (group) => (
              <div className="hw-debt-group" key={group.client}>
                <div className="hw-between">
                  <b>{group.client}</b>
                  <b>{money(group.total)}</b>
                </div>
                {group.orders.map((o) => (
                  <div className="hw-row" key={o.id}>
                    <div className="hw-row-main">
                      <OrderLink order={o} tab="finance" />
                      <p>
                        {o.status} · {money(o.debt)}
                      </p>
                    </div>
                    <button
                      className="hw-small"
                      disabled={!!board.error || o.status === 'Отменён'}
                      onClick={() => props.onIncome(o.id)}
                    >
                      Оплата
                    </button>
                  </div>
                ))}
              </div>
            ),
            'Положительных остатков оплаты нет.',
          )}
          <p className="hw-footnote">
            Остаток не означает просрочку. Переплаты других заказов его не
            уменьшают.
          </p>
        </>
      );
    }
    if (w.kind === 'transactions')
      return (
        <>
          {list(
            transactionRows(props.transactions, w),
            (t) => (
              <div className="hw-row" key={t.id}>
                <div className="hw-row-main">
                  <button
                    className="hw-text-button"
                    disabled={!!props.financeError}
                    onClick={() => props.onTransaction(t.id)}
                  >
                    {t.description || 'Операция без описания'}
                  </button>
                  <p>
                    {date(t.date)} · {t.account}
                    {t.orderNumber ? ` · №${t.orderNumber}` : ''}
                  </p>
                </div>
                <b className={t.type === 'income' ? 'hw-green-text' : ''}>
                  {t.type === 'income' ? '+' : '−'}
                  {money(t.amount)}
                </b>
              </div>
            ),
            'Операций по этим условиям нет.',
          )}
          <button className="hw-more" onClick={props.onJournal}>
            Журнал операций
            <ChevronRight size={15} />
          </button>
        </>
      );
    if (w.kind === 'cashflow') {
      const month = w.month || today.slice(0, 7);
      const rows = cashflowRows(props.transactions, month);
      return (
        <>
          <label className="hw-field">
            <span>Месяц графика</span>
            <input
              aria-label="Месяц графика"
              type="month"
              min="2000-01"
              max="2100-12"
              value={month}
              onChange={(event) => {
                if (/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value))
                  update(w.id, { month: event.target.value });
              }}
            />
          </label>
          <figure
            className="hw-chart"
            aria-label={`Доходы и расходы за ${month}`}
          >
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <AreaChart
                data={rows}
                margin={{ top: 15, right: 10, bottom: 5, left: 0 }}
              >
                <CartesianGrid vertical={false} strokeDasharray="4 5" />
                <XAxis dataKey="day" tickLine={false} axisLine={false} />
                <YAxis
                  width={48}
                  tickFormatter={(v) => `${Number(v) / 1000}к`}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  formatter={(v) => money(Number(v))}
                  labelFormatter={(v) => `${v} · ${month}`}
                />
                <Area
                  type="linear"
                  name="Доходы"
                  dataKey="income"
                  stroke="#6d942c"
                  fill="#edf8d9"
                />
                <Area
                  type="linear"
                  name="Расходы"
                  dataKey="expense"
                  stroke="#c35642"
                  fill="#fff0ec"
                />
              </AreaChart>
            </ResponsiveContainer>
          </figure>
          <div className="hw-meta">
            <span className="hw-green-text">
              Доходы: {money(rows.reduce((n, r) => n + r.income, 0))}
            </span>
            <span>
              Расходы: {money(rows.reduce((n, r) => n + r.expense, 0))}
            </span>
          </div>
        </>
      );
    }
    if (w.kind === 'week') {
      const day = new Date(`${today}T12:00:00Z`).getUTCDay();
      const monday = shiftDay(
        today,
        -(day === 0 ? 6 : day - 1) + (weekOffset[w.id] || 0) * 7,
      );
      const events = [
        ...orders
          .filter(
            (o) =>
              !o.manufacturingDone &&
              o.dueDate &&
              !['Сдан', 'Отменён'].includes(o.status),
          )
          .map((o) => ({
            id: `o-${o.id}`,
            day: o.dueDate!,
            type: 'Срок сдачи',
            label: `№${o.id} · ${o.title}`,
            action: () => {
              window.location.href = orderHref(o.id);
            },
          })),
        ...orders
          .filter((o) => o.status !== 'Отменён')
          .flatMap((o) =>
            o.installations
              .filter(
                (i) => i.date && !['Выполнен', 'Отменён'].includes(i.status),
              )
              .map((i, index) => ({
                id: `i-${o.id}-${index}`,
                day: i.date,
                type: 'Монтаж',
                label: `${i.time ? `${i.time} · ` : ''}№${o.id} · ${i.address || o.title}`,
                action: () => {
                  window.location.href = orderHref(o.id);
                },
              })),
          ),
        ...tasks
          .filter((t) => !t.completed && t.stage !== 'Монтаж' && t.plannedDate)
          .map((t) => ({
            id: t.key,
            day: t.plannedDate!,
            type: 'Производство',
            label: `№${t.orderNumber} · ${t.stage}`,
            action: () => setSelectedTask(t),
          })),
      ].filter((event) => w.filter === 'all' || event.type === w.filter);
      return (
        <>
          <div className="hw-between hw-week-controls">
            <button
              aria-label="Предыдущая неделя"
              onClick={() =>
                setWeekOffset((old) => ({
                  ...old,
                  [w.id]: (old[w.id] || 0) - 1,
                }))
              }
            >
              ←
            </button>
            <button
              onClick={() => setWeekOffset((old) => ({ ...old, [w.id]: 0 }))}
            >
              {date(monday)} — {date(shiftDay(monday, 6))}
            </button>
            <button
              aria-label="Следующая неделя"
              onClick={() =>
                setWeekOffset((old) => ({
                  ...old,
                  [w.id]: (old[w.id] || 0) + 1,
                }))
              }
            >
              →
            </button>
          </div>
          <div
            className={
              w.size === 'expanded' || full ? 'hw-week expanded' : 'hw-week'
            }
          >
            {Array.from({ length: 7 }, (_, n) => shiftDay(monday, n)).map(
              (d) => (
                <div className={`hw-day ${d === today ? 'today' : ''}`} key={d}>
                  <b>
                    {date(d)} ·{' '}
                    {
                      ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'][
                        new Date(`${d}T12:00:00Z`).getUTCDay() === 0
                          ? 6
                          : new Date(`${d}T12:00:00Z`).getUTCDay() - 1
                      ]
                    }
                  </b>
                  {events
                    .filter((e) => e.day === d)
                    .map((e) => (
                      <button key={e.id} onClick={e.action}>
                        <span className="hw-badge">{e.type}</span>
                        <span>{e.label}</span>
                      </button>
                    ))}
                  {!events.some((e) => e.day === d) && (
                    <span className="hw-muted">Нет событий</span>
                  )}
                </div>
              ),
            )}
          </div>
          <p className="hw-footnote">
            Задачи CRM не включены: раздел отключён. Производство — по датам
            плана.
          </p>
        </>
      );
    }
    if (w.kind === 'actions')
      return (
        <div className="hw-actions">
          {quickActions
            .filter(([key]) => w.actions.includes(key))
            .map(([key, label]) => (
              <button
                key={key}
                onClick={() => {
                  if (key === 'income') props.onIncome();
                  else if (key === 'expense') props.onExpense();
                  else if (key === 'issue') props.onExpense(true);
                  else window.location.href = '/kanban/?action=create';
                }}
              >
                <Plus size={20} />
                {label}
              </button>
            ))}
          {w.actions.length === 0 && (
            <Empty>Выберите действия в настройках виджета.</Empty>
          )}
        </div>
      );
    return <Empty>CRM временно отключена.</Empty>;
  }
  function body(w: Widget, full = false) {
    const sources = resources(w);
    const missing = sources.some((s) => !s.hasData);
    const failed = sources.filter((s) => s.error);
    return (
      <>
        {renderFilters(w)}
        {failed.length > 0 && (
          <output className="hw-source-error">
            <CircleAlert size={16} />
            <div>
              {failed.map((s, i) => (
                <p key={i}>{s.error}</p>
              ))}
              {!missing && (
                <p>
                  Показаны ранее загруженные данные. Действия сохранения
                  ограничены.
                </p>
              )}
              <button onClick={() => failed.forEach((s) => s.refresh())}>
                Повторить
              </button>
            </div>
          </output>
        )}
        {missing
          ? !failed.length && (
              <div className="hw-skeleton" aria-label="Загрузка виджета">
                <span />
                <span />
                <span />
              </div>
            )
          : renderContent(w, full)}
        {boardKinds.has(w.kind) && !!board.data?.warnings.length && (
          <details className="hw-data-warning">
            <summary>Замечания к данным: {board.data.warnings.length}</summary>
            {board.data.warnings.map((warning, i) => (
              <p key={i}>{warning}</p>
            ))}
          </details>
        )}
      </>
    );
  }

  return (
    <section
      className="widget-workspace"
      aria-label="Виджеты главной"
      id="widgets"
    >
      <header className="hw-toolbar">
        <div>
          <h2>Моя главная</h2>
          <p>
            {editing
              ? 'Перемещайте блоки и выбирайте нужное содержимое'
              : 'Заказы, производство и склад под рукой'}
          </p>
        </div>
        <div className="hw-toolbar-buttons">
          <button
            onClick={() => {
              setEditing(!editing);
              setResetConfirm(false);
            }}
            className={editing ? 'hw-primary' : ''}
          >
            {editing ? <Check size={17} /> : <Settings2 size={17} />}
            {editing ? 'Готово' : 'Настроить'}
          </button>
          <button className="hw-primary" onClick={() => setCatalogOpen(true)}>
            <Plus size={17} />
            Добавить виджет
          </button>
        </div>
      </header>
      {storageError && (
        <output className="hw-source-error">{storageError}</output>
      )}
      {(notice || undo) && (
        <output className="hw-notice">
          <span>{notice || 'Настройки сохранены'}</span>
          {undo && (
            <button
              onClick={() => {
                const previous = undo;
                commit(previous);
                setUndo(null);
                setNotice('Изменение отменено');
              }}
            >
              Отменить последнее
            </button>
          )}
          <button
            aria-label="Скрыть уведомление"
            onClick={() => {
              setNotice('');
              setUndo(null);
            }}
          >
            <X size={15} />
          </button>
        </output>
      )}
      {editing && (
        <div className="hw-edit-tools">
          <span>
            Раскладка: {profile === 'mobile' ? 'телефон' : 'компьютер'} ·
            сохраняется на этом устройстве
          </span>
          {resetConfirm ? (
            <span>
              Вернуть стандартный набор?{' '}
              <button
                onClick={() => {
                  commit(defaultLayout());
                  setResetConfirm(false);
                }}
              >
                Да, сбросить
              </button>
              <button onClick={() => setResetConfirm(false)}>Отмена</button>
            </span>
          ) : (
            <button onClick={() => setResetConfirm(true)}>
              Стандартный набор
            </button>
          )}
        </div>
      )}
      {drag.preview &&
        createPortal(
          <div
            className="hw-drag-preview"
            aria-hidden="true"
            style={{
              left: drag.preview.x - drag.preview.offsetX,
              top: drag.preview.y - drag.preview.offsetY,
              width: drag.preview.width,
              height: drag.preview.height,
            }}
          >
            <span>
              <GripVertical size={18} />
              {layout.widgets
                .filter((widget) => widget.id === drag.preview!.id)
                .map((widget) => title(widget.kind))[0] || 'Виджет'}
            </span>
          </div>,
          document.body,
        )}
      <div className="hw-grid" ref={gridRef}>
        {layout.widgets.map((w, index) => {
          const sources = resources(w);
          const stamp = sources
            .map((s) => s.updatedAt)
            .filter(Boolean)
            .sort()[0];
          return (
            <article
              data-widget-id={w.id}
              data-widget-kind={w.kind}
              className={`hw-card ${w.size === 'expanded' ? 'expanded' : ''} ${['week', 'cashflow'].includes(w.kind) && w.size === 'expanded' ? 'hw-wide' : ''} ${editing ? 'editing' : ''} ${drag.preview?.id === w.id ? 'hw-dragging' : ''} ${drag.targetId === w.id && drag.preview?.id !== w.id ? 'hw-drop-target' : ''}`}
              key={w.id}
            >
              <header className="hw-card-header">
                <div className="hw-heading">
                  {editing && (
                    <button
                      className="hw-grip"
                      type="button"
                      aria-label={`Переместить: ${title(w.kind)}`}
                      onPointerDown={(event) => drag.start(event, w.id)}
                      onPointerCancel={drag.cancel}
                      onLostPointerCapture={drag.cancel}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') drag.cancel();
                        if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
                          event.preventDefault();
                          commit(
                            moveWidget(
                              layout,
                              w.id,
                              Math.max(
                                0,
                                Math.min(
                                  layout.widgets.length - 1,
                                  index + (event.key === 'ArrowUp' ? -1 : 1),
                                ),
                              ),
                            ),
                          );
                        }
                      }}
                      title="Перетащить виджет"
                    >
                      <GripVertical size={18} />
                    </button>
                  )}
                  <span className="hw-widget-icon">
                    {stockKinds.has(w.kind) ? (
                      <Boxes size={18} />
                    ) : w.kind === 'favorites' ? (
                      <Star size={18} />
                    ) : w.kind === 'week' ? (
                      <CalendarDays size={18} />
                    ) : (
                      <LayoutGrid size={18} />
                    )}
                  </span>
                  <h3>{title(w.kind)}</h3>
                </div>
                <div className="hw-card-actions">
                  <button
                    className="hw-icon-button"
                    aria-label={`Настройки: ${title(w.kind)}`}
                    onClick={() => setSettingsId(w.id)}
                  >
                    <Settings2 size={17} />
                  </button>
                  <button type="button" className="hw-icon-button" title="Убрать с главной"
                    aria-label={`Убрать с главной: ${title(w.kind)}`} onClick={() => remove(w.id)}>
                    <X size={17} />
                  </button>
                </div>
              </header>
              {editing && (
                <div className="hw-position-tools">
                  <button
                    disabled={index === 0}
                    onClick={() => commit(moveWidget(layout, w.id, index - 1))}
                  >
                    <ArrowUp size={14} />
                    Выше
                  </button>
                  <button
                    disabled={index === layout.widgets.length - 1}
                    onClick={() => commit(moveWidget(layout, w.id, index + 1))}
                  >
                    <ArrowDown size={14} />
                    Ниже
                  </button>
                  <button
                    onClick={() =>
                      update(w.id, {
                        size: w.size === 'compact' ? 'expanded' : 'compact',
                      })
                    }
                  >
                    {w.size === 'compact' ? 'Расширить' : 'Компактнее'}
                  </button>
                  <button
                    aria-label={`Убрать: ${title(w.kind)}`}
                    onClick={() => remove(w.id)}
                  >
                    <Trash2 size={14} />
                    Убрать
                  </button>
                </div>
              )}
              <div className="hw-card-body">{body(w)}</div>
              {sources.length > 0 && (
                <footer className="hw-card-footer">
                  <span>
                    {sources.some((s) => s.loading)
                      ? 'Обновляем…'
                      : stamp
                        ? `Данные на ${time(stamp)}`
                        : 'Данные ещё не загружены'}
                  </span>
                  <button
                    aria-label={`Обновить: ${title(w.kind)}`}
                    disabled={sources.some((s) => s.loading)}
                    onClick={() => sources.forEach((s) => s.refresh())}
                  >
                    <RefreshCw size={14} />
                  </button>
                </footer>
              )}
            </article>
          );
        })}
      </div>
      {!layout.widgets.length && (
        <div className="hw-empty-dashboard">
          <LayoutGrid size={28} />
          <h3>Соберите свою главную</h3>
          <p>Добавьте виджеты из каталога или верните стандартный набор.</p>
          <button className="hw-primary" onClick={() => setCatalogOpen(true)}>
            Добавить виджет
          </button>
          <button onClick={() => commit(defaultLayout())}>
            Стандартный набор
          </button>
        </div>
      )}
      <Dialog open={catalogOpen} onOpenChange={setCatalogOpen}>
        <DialogContent className="hw-dialog sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Добавить виджет</DialogTitle>
            <DialogDescription>
              Один виджет можно добавить несколько раз с разными фильтрами.{' '}
              {layout.widgets.length} из 24.
            </DialogDescription>
          </DialogHeader>
          <input
            className="hw-search"
            aria-label="Найти виджет"
            placeholder="Найти виджет…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="hw-tabs">
            {['Все', 'Работа', 'Склад', 'Финансы'].map((group) => (
              <button
                aria-pressed={category === group}
                key={group}
                onClick={() => setCategory(group)}
              >
                {group}
              </button>
            ))}
          </div>
          <div className="hw-catalog">
            {catalog
              .filter(
                (c) =>
                  (category === 'Все' || c.group === category) &&
                  `${c.title} ${c.description}`
                    .toLocaleLowerCase('ru')
                    .includes(query.toLocaleLowerCase('ru')),
              )
              .map((c) => (
                <div key={c.kind} className={c.disabled ? 'disabled' : ''}>
                  <div>
                    <h3>{c.title}</h3>
                    <p>{c.description}</p>
                    <small>
                      {layout.widgets.filter((w) => w.kind === c.kind).length
                        ? `На главной: ${layout.widgets.filter((w) => w.kind === c.kind).length}`
                        : c.group}
                    </small>
                  </div>
                  <button
                    disabled={c.disabled || layout.widgets.length >= 24}
                    aria-label={`Добавить: ${c.title}`}
                    onClick={() => add(c.kind)}
                  >
                    {c.disabled ? 'Недоступно' : <Plus size={20} />}
                  </button>
                </div>
              ))}
          </div>
          <button className="hw-primary" onClick={() => setCatalogOpen(false)}>
            Готово
          </button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!settings}
        onOpenChange={(open) => {
          if (!open) setSettingsId(null);
        }}
      >
        <DialogContent className="hw-dialog sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {settings
                ? `Настройки: ${title(settings.kind)}`
                : 'Настройки виджета'}
            </DialogTitle>
            <DialogDescription>
              Изменения сохраняются сразу, отдельно для телефона и компьютера.
            </DialogDescription>
          </DialogHeader>
          {settings && (
            <div className="hw-settings">
              <Select
                label="Размер"
                value={settings.size}
                options={[
                  ['compact', 'Компактный · 3 строки'],
                  ['expanded', 'Расширенный · 6 строк'],
                ]}
                onChange={(size) =>
                  update(settings.id, { size: size as Widget['size'] })
                }
              />
              {renderFilters(settings)}
              {[
                'deadlines',
                'pickup',
                'ready',
                'waiting',
                'installations',
              ].includes(settings.kind) && (
                <Select
                  label={
                    ['deadlines', 'pickup'].includes(settings.kind)
                      ? 'Менеджер'
                      : 'Исполнитель'
                  }
                  value={settings.owner}
                  options={[
                    ['', 'Все'],
                    ...[
                      ...new Set([
                        settings.owner,
                        ...(['deadlines', 'pickup'].includes(settings.kind)
                          ? orders.map((o) => o.manager)
                          : settings.kind === 'installations'
                            ? orders.flatMap((o) =>
                                o.installations.map((i) => i.assignee),
                              )
                            : tasks.map((t) => t.assignee || '')),
                      ]),
                    ]
                      .filter(Boolean)
                      .sort()
                      .map((v) => [v, v] as [string, string]),
                  ]}
                  onChange={(owner) => update(settings.id, { owner })}
                />
              )}
              {['deadlines', 'installations'].includes(settings.kind) && (
                <label className="hw-check">
                  <input
                    type="checkbox"
                    checked={settings.showUndated}
                    onChange={(e) =>
                      update(settings.id, { showUndated: e.target.checked })
                    }
                  />
                  Показывать без даты
                </label>
              )}
              {settings.kind === 'installations' && (
                <Select
                  label="Горизонт"
                  value={String(settings.days)}
                  options={[
                    ['7', '7 дней'],
                    ['30', '30 дней'],
                    ['90', '90 дней'],
                  ]}
                  onChange={(days) =>
                    update(settings.id, { days: Number(days) })
                  }
                />
              )}
              {stockKinds.has(settings.kind) && (
                <>
                  <Select
                    label="Категория"
                    value={settings.category}
                    options={[
                      ['', 'Все категории'],
                      ...[
                        ...new Set([
                          settings.category,
                          ...(warehouse.data?.items || []).map(
                            (i) => i.category,
                          ),
                        ]),
                      ]
                        .filter(Boolean)
                        .sort()
                        .map((v) => [v, v] as [string, string]),
                    ]}
                    onChange={(value) =>
                      update(settings.id, { category: value })
                    }
                  />
                  <label className="hw-check">
                    <input
                      type="checkbox"
                      checked={settings.photos}
                      onChange={(e) =>
                        update(settings.id, { photos: e.target.checked })
                      }
                    />
                    Показывать фото
                  </label>
                  {settings.kind === 'stock' && (
                    <label className="hw-check">
                      <input
                        type="checkbox"
                        checked={settings.filter === 'low'}
                        onChange={(e) =>
                          update(settings.id, {
                            filter: e.target.checked ? 'low' : 'all',
                          })
                        }
                      />
                      Только на минимуме и ниже
                    </label>
                  )}
                </>
              )}
              {settings.kind === 'transactions' && (
                <Select
                  label="Счёт"
                  value={settings.account}
                  options={[
                    ['', 'Все счета'],
                    ...[
                      ...new Set([
                        settings.account,
                        ...props.transactions.map((t) => t.account),
                      ]),
                    ]
                      .filter(Boolean)
                      .map((v) => [v, v] as [string, string]),
                  ]}
                  onChange={(account) => update(settings.id, { account })}
                />
              )}
              {settings.kind === 'week' && (
                <Select
                  label="События"
                  value={settings.filter}
                  options={[
                    ['all', 'Все события'],
                    ['Срок сдачи', 'Сроки сдачи'],
                    ['Производство', 'Производство'],
                    ['Монтаж', 'Монтажи'],
                  ]}
                  onChange={(filter) => update(settings.id, { filter })}
                />
              )}
              {settings.kind === 'favorites' && (
                <div className="hw-pin-list">
                  <p>Закрепить до 20 заказов</p>
                  {board.error && (
                    <p className="hw-danger-text">{board.error}</p>
                  )}
                  {board.loading && !board.data && <p>Загружаем заказы…</p>}
                  {orders.map((o) => (
                    <label className="hw-check" key={o.id}>
                      <input
                        type="checkbox"
                        checked={settings.pinned.includes(o.id)}
                        disabled={
                          !settings.pinned.includes(o.id) &&
                          settings.pinned.length >= 20
                        }
                        onChange={(e) =>
                          update(settings.id, {
                            pinned: e.target.checked
                              ? [...settings.pinned, o.id]
                              : settings.pinned.filter((id) => id !== o.id),
                          })
                        }
                      />
                      №{o.id} · {o.title} · {o.client}
                    </label>
                  ))}
                </div>
              )}
              {settings.kind === 'actions' &&
                quickActions.map(([key, label]) => (
                  <label key={key} className="hw-check">
                    <input
                      type="checkbox"
                      checked={settings.actions.includes(key)}
                      onChange={(e) =>
                        update(settings.id, {
                          actions: e.target.checked
                            ? [...settings.actions, key]
                            : settings.actions.filter((a) => a !== key),
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
              <div className="hw-toolbar-buttons">
                <button type="button" onClick={() => remove(settings.id)}>
                  <Trash2 size={16} />
                  Убрать с главной
                </button>
                <button
                  onClick={() => add(settings.kind, settings)}
                  disabled={layout.widgets.length >= 24}
                >
                  <Plus size={16} />
                  Добавить ещё такой
                </button>
                <button
                  className="hw-primary"
                  onClick={() => setSettingsId(null)}
                >
                  Готово
                </button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!detail}
        onOpenChange={(open) => {
          if (!open) {
            setDetailId(null);
            setLegacyCashflow(false);
          }
        }}
      >
        <DialogContent className="hw-dialog sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>
              {detail ? title(detail.kind) : 'Подробности'}
            </DialogTitle>
            <DialogDescription>
              Все записи по фильтрам этого виджета.
            </DialogDescription>
          </DialogHeader>
          {detail && body(detail, true)}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!selectedTask}
        onOpenChange={(open) => {
          if (!open) setSelectedTask(null);
        }}
      >
        <DialogContent className="hw-dialog sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {activeTask?.stage || 'Производственный этап'}
            </DialogTitle>
            <DialogDescription>
              {activeTask
                ? `№${activeTask.orderNumber} · ${activeTask.item || activeTask.orderName}`
                : 'Этап изменён или отсутствует. Обновите производство.'}
            </DialogDescription>
          </DialogHeader>
          {activeTask && (
            <>
              <p>
                {activeTask.assignee || 'Исполнитель не назначен'} · план:{' '}
                {date(activeTask.plannedDate)}
              </p>
              <p>{activeTask.comment}</p>
              {!!activeTask.waitingFor.length && (
                <div>
                  <p>Ждёт: {activeTask.waitingFor.join(', ')}</p>
                  {tasks
                    .filter(
                      (t) =>
                        t.orderNumber === activeTask.orderNumber &&
                        t.item === activeTask.item &&
                        activeTask.waitingFor.includes(t.stage) &&
                        !t.completed,
                    )
                    .map((t) => (
                      <button
                        className="hw-more"
                        key={t.key}
                        onClick={() => setSelectedTask(t)}
                      >
                        Открыть: {t.stage}
                        <ChevronRight size={15} />
                      </button>
                    ))}
                </div>
              )}
              {props.productionError && (
                <p role="alert" className="hw-danger-text">
                  {props.productionError}
                </p>
              )}
              <div className="hw-toolbar-buttons">
                <button
                  onClick={() => {
                    setSelectedTask(null);
                    props.onProduction(activeTask.orderNumber);
                  }}
                >
                  В производство
                </button>
                <button
                  className="hw-primary"
                  disabled={
                    !!props.productionError ||
                    props.updatingRow !== null ||
                    (!activeTask.completed && !activeTask.canComplete)
                  }
                  onClick={() =>
                    props.onToggleProduction(activeTask, !activeTask.completed)
                  }
                >
                  {props.updatingRow === activeTask.row
                    ? 'Сохраняем…'
                    : activeTask.completed
                      ? 'Снять выполнение'
                      : 'Отметить готовым'}
                </button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
