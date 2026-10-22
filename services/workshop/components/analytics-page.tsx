import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  BarChart3,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Download,
  ExternalLink,
  Link2,
  RefreshCw,
  Search,
  Unplug,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  analyticsCsv,
  analyticsDate as date,
  analyticsMoney as money,
  analyticsToday,
  dateShift,
  type AnalyticsReport,
  type MetricDefinition,
} from '@/lib/analytics';
import { AdvertisingAnalytics } from './advertising-analytics';
import { InquiryMatching } from './inquiry-matching';
import { AnalyticsAvito } from './analytics-avito';
import './analytics-page.css';

const tabs = [
  { id: 'overview', label: 'Обзор' },
  { id: 'finance', label: 'Деньги' },
  { id: 'orders', label: 'Заказы' },
  { id: 'acquisition', label: 'Источники' },
  { id: 'inquiries', label: 'Обращения и заказы' },
  { id: 'funnel', label: 'Воронка' },
  { id: 'operations', label: 'Производство и склад' },
  { id: 'quality', label: 'Качество данных' },
] as const;
type Tab = (typeof tabs)[number]['id'];
type Range = { from: string; to: string };
const initialRange = (): Range => {
  const today = analyticsToday();
  return { from: `${today.slice(0, 7)}-01`, to: today };
};
const number = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('ru-RU');
const stamp = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Europe/Moscow',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(value))
    : 'Ещё не получены';
function delta(
  current: number | null | undefined,
  previous: number | null | undefined,
) {
  if (current == null || previous == null) return 'Сравнение недоступно';
  if (previous === 0)
    return current === 0 ? 'Без изменений' : 'В прошлом периоде — 0';
  const percent = ((current - previous) / Math.abs(previous)) * 100;
  return `${percent > 0 ? '+' : ''}${percent.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}% к предыдущему периоду`;
}
function Empty({ children }: { children: ReactNode }) {
  return <p className="an-empty">{children}</p>;
}
function Panel({
  title,
  note,
  action,
  children,
}: {
  title: string;
  note?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="an-panel">
      <div className="an-panel-head">
        <div>
          <h2>{title}</h2>
          {note && <p>{note}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
function OrderLink({ id, children }: { id: string; children?: ReactNode }) {
  return (
    <a className="an-link" href={`/kanban/?order=${encodeURIComponent(id)}`}>
      {children || `№ ${id}`}
      <ExternalLink size={12} aria-hidden="true" />
    </a>
  );
}
function Pager({
  page,
  total,
  onPage,
}: {
  page: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / 20));
  return (
    <div className="an-pager">
      <span>
        {total
          ? `${(page - 1) * 20 + 1}–${Math.min(page * 20, total)} из ${total}`
          : '0 записей'}
      </span>
      <div>
        <Button
          size="icon-sm"
          variant="outline"
          aria-label="Предыдущая страница"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft />
        </Button>
        <span>
          {page} / {pages}
        </span>
        <Button
          size="icon-sm"
          variant="outline"
          aria-label="Следующая страница"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
function MoneyChart({ report }: { report: AnalyticsReport }) {
  const [selected, setSelected] = useState<string | null>(null);
  const daily = report.finance.daily;
  // Long periods use calendar months; values are still sums of the displayed daily facts.
  const chart = useMemo(() => {
    const grouped = new Map<
      string,
      { date: string; income: number; expense: number; valid: boolean }
    >();
    for (const row of daily) {
      const key = daily.length > 62 ? row.date.slice(0, 7) : row.date;
      const value = grouped.get(key) || {
        date: key,
        income: 0,
        expense: 0,
        valid: true,
      };
      value.income += Math.round((row.income || 0) * 100);
      value.expense += Math.round((row.expense || 0) * 100);
      value.valid = value.valid && row.income !== null && row.expense !== null;
      grouped.set(key, value);
    }
    return [...grouped.values()].map((v) => ({
      ...v,
      income: v.income / 100,
      expense: v.expense / 100,
    }));
  }, [daily]);
  if (!report.overview.finance)
    return <Empty>Денежные данные пока недоступны.</Empty>;
  const max = Math.max(1, ...chart.flatMap((row) => [row.income, row.expense]));
  const current = chart.find((row) => row.date === selected) || chart.at(-1);
  return (
    <>
      <div className="an-legend">
        <span>
          <i className="an-income-dot" />
          Поступления
        </span>
        <span>
          <i className="an-expense-dot" />
          Выплаты
        </span>
        <small>{daily.length > 62 ? 'По месяцам' : 'По дням'} · ₽</small>
      </div>
      <fieldset className="an-chart" aria-label="Денежный поток по датам">
        <div className="an-chart-scale" aria-hidden="true">
          <span>{money(max)}</span>
          <span>{money(max / 2)}</span>
          <span>0</span>
        </div>
        <div className="an-bars">
          {chart.map((row) => (
            <button
              key={row.date}
              type="button"
              onClick={() => setSelected(row.date)}
              className={`an-bar-pair ${current?.date === row.date ? 'is-selected' : ''}`}
              aria-label={`${row.date}: поступления ${money(row.valid ? row.income : null)}, выплаты ${money(row.valid ? row.expense : null)}`}
              title={`${row.date}: ${money(row.income)} / ${money(row.expense)}`}
            >
              <span
                className="an-income-bar"
                style={{ height: `${(row.income / max) * 100}%` }}
              />
              <span
                className="an-expense-bar"
                style={{ height: `${(row.expense / max) * 100}%` }}
              />
            </button>
          ))}
        </div>
      </fieldset>
      <div className="an-chart-dates">
        <span>{date(report.period.from)}</span>
        <span>{date(report.period.to)}</span>
      </div>
      {current && (
        <div className="an-chart-detail" aria-live="polite">
          <strong>
            {current.date.length === 7
              ? `${current.date.slice(5)}.${current.date.slice(0, 4)}`
              : date(current.date)}
          </strong>
          <span>
            Приход <b>{money(current.valid ? current.income : null)}</b>
          </span>
          <span>
            Расход <b>{money(current.valid ? current.expense : null)}</b>
          </span>
        </div>
      )}
      {!report.overview.finance.operations && (
        <p className="an-note">За выбранный период денежных операций нет.</p>
      )}
    </>
  );
}

export default function AnalyticsPage({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<Tab>('overview');
  const [range, setRange] = useState<Range>(initialRange),
    [draft, setDraft] = useState<Range>(initialRange);
  const [customPeriod, setCustomPeriod] = useState(false);
  const [report, setReport] = useState<AnalyticsReport | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const [periodError, setPeriodError] = useState(''),
    [retry, setRetry] = useState(0),
    [definition, setDefinition] = useState<MetricDefinition | null>(null);
  const [query, setQuery] = useState(''),
    [status, setStatus] = useState('all'),
    [source, setSource] = useState('all'),
    [page, setPage] = useState(1),
    [ledgerPage, setLedgerPage] = useState(1);
  const [connection, setConnection] = useState<string | null>(null);
  const refreshRequested = useRef(false);
  const [cooldownUntil, setCooldownUntil] = useState(0),
    [clock, setClock] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    queueMicrotask(() => {
      if (alive) {
        setLoading(true);
        setError('');
      }
    });
    const params = new URLSearchParams(range);
    if (refreshRequested.current) params.set('refresh', '1');
    refreshRequested.current = false;
    void fetch(`/api/analytics/overview?${params}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const value = (await response.json()) as AnalyticsReport & {
          error?: string;
        };
        if (!response.ok || !value.metricVersion)
          throw new Error(
            response.status === 401
              ? 'Сессия завершена. Войдите в Мастерскую заново.'
              : value.error || 'Не удалось получить аналитику.',
          );
        if (alive) {
          setReport(value);
          setCooldownUntil(Date.now() + value.refreshAfterSeconds * 1000);
        }
      })
      .catch((e: unknown) => {
        if (alive)
          setError(
            e instanceof Error ? e.message : 'Не удалось получить аналитику.',
          );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [range, retry]);
  const visible =
    report?.period.from === range.from && report.period.to === range.to
      ? report
      : null;
  const data = visible;
  function switchTab(next: Tab) {
    setTab(next);
    setPage(1);
    setLedgerPage(1);
  }
  function setPreset(kind: 'month' | 'previous' | '30' | '90' | 'year') {
    const today = analyticsToday();
    const next = { from: `${today.slice(0, 7)}-01`, to: today };
    if (kind === 'previous') {
      next.to = dateShift(next.from, -1);
      next.from = `${next.to.slice(0, 7)}-01`;
    }
    if (kind === '30' || kind === '90')
      next.from = dateShift(today, -(Number(kind) - 1));
    if (kind === 'year') next.from = `${today.slice(0, 4)}-01-01`;
    setDraft(next);
    setRange(next);
    setPage(1);
    setLedgerPage(1);
    setPeriodError('');
  }
  function applyRange() {
    const days =
      (Date.parse(draft.to) - Date.parse(draft.from)) / 86_400_000 + 1;
    if (
      !draft.from ||
      !draft.to ||
      !Number.isFinite(days) ||
      days < 1 ||
      days > 366 ||
      draft.from < '2000-01-01' ||
      draft.to > analyticsToday()
    ) {
      setPeriodError('Выберите от 1 до 366 дней, не позднее сегодня.');
      return;
    }
    setRange({ ...draft });
    setPage(1);
    setLedgerPage(1);
    setPeriodError('');
    setCustomPeriod(false);
  }
  function exportReport() {
    if (!data) return;
    const url = URL.createObjectURL(
      new Blob([analyticsCsv(data)], { type: 'text/csv;charset=utf-8' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `Мастерская-аналитика-${data.period.from}-${data.period.to}.csv`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const rows = useMemo(
    () =>
      (data?.orders.rows || []).filter(
        (o) =>
          (status === 'all' || o.status === status) &&
          (source === 'all' || o.source === source) &&
          `${o.id} ${o.title}`
            .toLocaleLowerCase('ru')
            .includes(query.toLocaleLowerCase('ru')),
      ),
    [data, status, source, query],
  );
  const safePage = Math.min(page, Math.max(1, Math.ceil(rows.length / 20)));
  const finance = data?.overview.finance,
    previous = data?.overview.previousFinance,
    orders = data?.overview.orders,
    previousOrders = data?.overview.previousOrders,
    current = data?.overview.current;
  const pendingSource = data?.acquisition.connections.find(
    (c) => c.id === connection,
  );
  const problems = data?.quality.issues.length || 0;
  const wait = Math.max(0, Math.ceil((cooldownUntil - clock) / 1000));
  function metric(
    id: string,
    label: string,
    value: string,
    note: string,
    detailTab: Tab,
    accent = false,
  ) {
    return (
      <div className={`an-metric ${accent ? 'an-metric-accent' : ''}`}>
        <div className="an-metric-label">
          <span>{label}</span>
          <button
            type="button"
            aria-label={`Как считается: ${label}`}
            onClick={() =>
              setDefinition(data?.definitions.find((d) => d.id === id) || null)
            }
          >
            <CircleHelp size={15} />
          </button>
        </div>
        <button
          className="an-metric-value"
          type="button"
          onClick={() => switchTab(detailTab)}
          aria-label={`Детализация: ${label}`}
        >
          <strong>{value}</strong>
          <ArrowUpRight size={19} />
        </button>
        <p>{note}</p>
      </div>
    );
  }
  const statusPanel = data && (
    <Panel
      title="Текущие статусы заказов"
      note="Заказы, созданные в выбранном периоде; включая отменённые."
    >
      {data.overview.orders ? (
        <>
          <div className="an-status-list">
            {data.orders.statuses.map((row, index) => (
              <button
                type="button"
                className="an-status-row"
                key={row.label}
                onClick={() => {
                  setStatus(row.label === 'Без статуса' ? '' : row.label);
                  setSource('all');
                  setQuery('');
                  switchTab('orders');
                }}
              >
                <span className="an-status-name">
                  <i>{String(index + 1).padStart(2, '0')}</i>
                  {row.label}
                </span>
                <span className="an-track">
                  <i
                    style={{
                      width: `${data.orders.statusesTotal ? (row.count / data.orders.statusesTotal) * 100 : 0}%`,
                    }}
                  />
                </span>
                <b>{row.count}</b>
                <ChevronRight size={14} />
              </button>
            ))}
          </div>
          {!data.orders.statusesTotal && (
            <Empty>В этом периоде нет заказов.</Empty>
          )}
        </>
      ) : (
        <Empty>Данные заказов недоступны.</Empty>
      )}
      <p className="an-note">
        Статусы показывают состояние сейчас. По ним нельзя восстановить переходы
        и конверсию между этапами.
      </p>
    </Panel>
  );
  return (
    <div className="analytics-page">
      <header className="an-header">
        <div>
          <button className="an-back" type="button" onClick={onBack}>
            <ChevronLeft size={15} />
            Мастерская
          </button>
          <p className="an-eyebrow">ОТ ДЕНЕГ К РЕЗУЛЬТАТУ</p>
          <h1>
            Аналитика
            <span className="an-title-dot" />
          </h1>
          <p className="an-subtitle">
            Бизнес, реклама и работа мастерской в одном месте
          </p>
        </div>
        <div className="an-header-actions">
          <a href="/analytics/live/" className="an-back">Авито: деньги и объявления ↗</a>
          <Button
            variant="outline"
            onClick={exportReport}
            disabled={!data || loading}
          >
            <Download size={16} />
            Экспорт периода
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              refreshRequested.current = true;
              setRetry((n) => n + 1);
            }}
            disabled={loading || wait > 0}
            aria-label="Обновить аналитику"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Загрузка' : wait ? `${wait} с` : 'Обновить'}
          </Button>
        </div>
      </header>
      <section className="an-filter-panel" aria-label="Период аналитики">
        <div className="an-presets">
          <button type="button" onClick={() => setPreset('month')}>
            Этот месяц
          </button>
          <button type="button" onClick={() => setPreset('previous')}>
            Прошлый месяц
          </button>
          <button type="button" onClick={() => setPreset('30')}>
            30 дней
          </button>
          <button type="button" onClick={() => setPreset('90')}>
            90 дней
          </button>
          <button type="button" onClick={() => setPreset('year')}>
            Этот год
          </button>
        </div>
        <button
          className="an-custom-toggle"
          type="button"
          aria-expanded={customPeriod}
          onClick={() => setCustomPeriod((value) => !value)}
        >
          Свой период <ChevronRight size={13} />
        </button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            applyRange();
          }}
          className={`an-date-fields ${customPeriod ? 'is-open' : ''}`}
        >
          <label>
            С
            <input
              aria-label="Начало периода"
              type="date"
              value={draft.from}
              max={analyticsToday()}
              min="2000-01-01"
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
              required
            />
          </label>
          <label>
            По
            <input
              aria-label="Конец периода"
              type="date"
              value={draft.to}
              max={analyticsToday()}
              min="2000-01-01"
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
              required
            />
          </label>
          <Button type="submit" variant="outline">
            Показать
          </Button>
        </form>
        {periodError && (
          <p role="alert" className="an-error">
            {periodError}
          </p>
        )}
        <div className="an-period-info">
          <strong>
            {date(range.from)} — {date(range.to)}
          </strong>
          {data && (
            <span>
              Сравнение: {date(data.period.previous.from)} —{' '}
              {date(data.period.previous.to)} · Москва
            </span>
          )}
        </div>
      </section>
      <nav className="an-tabs" aria-label="Разделы аналитики">
        {tabs.map((t) => (
          <button
            type="button"
            key={t.id}
            aria-current={tab === t.id ? 'page' : undefined}
            onClick={() => switchTab(t.id)}
          >
            {t.label}
            {t.id === 'quality' && problems > 0 && <span>{problems}</span>}
          </button>
        ))}
      </nav>
      {error && (
        <div className="an-alert an-alert-error" role="alert">
          <span>
            {error}
            {data && ' Ниже — предыдущий отчёт.'}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRetry((n) => n + 1)}
          >
            Повторить
          </Button>
        </div>
      )}
      {loading && (
        <output className="an-loading">
          <RefreshCw size={17} className="animate-spin" />
          Готовим отчёт из Google Таблицы…
        </output>
      )}
      {data && (
        <div
          className={`an-content ${loading ? 'an-content-loading' : ''}`}
          aria-busy={loading}
        >
          {data.sources.some((s) => s.state !== 'ready') && (
            <output className="an-alert">
              <span>
                Часть данных не обновилась. Проверьте даты загрузки перед
                сравнением.
              </span>
              <button type="button" onClick={() => switchTab('quality')}>
                Проверить источники <ChevronRight size={14} />
              </button>
            </output>
          )}
          {data.quality.issues.some((i) =>
            [
              'order_dates',
              'order_formulas',
              'board_warnings',
              'orphan_finance',
            ].includes(i.code),
          ) && (
            <output className="an-alert">
              <span>
                В исходных данных есть пропуски или неоднозначные связи. Часть
                показателей может быть неполной.
              </span>
              <button type="button" onClick={() => switchTab('quality')}>
                Посмотреть ограничения <ChevronRight size={14} />
              </button>
            </output>
          )}
          {tab === 'overview' && (
            <>
              <div className="an-section-kicker">
                <span>Деньги за период</span>
                <small>По датам платежей и расходов</small>
              </div>
              <div className="an-metrics">
                {metric(
                  'income',
                  'Поступления',
                  money(finance?.income),
                  delta(finance?.income, previous?.income),
                  'finance',
                  true,
                )}
                {metric(
                  'expense',
                  'Выплаты',
                  money(finance?.expense),
                  delta(finance?.expense, previous?.expense),
                  'finance',
                )}
                {metric(
                  'net',
                  'Денежный поток',
                  money(finance?.net),
                  'Поступления минус выплаты',
                  'finance',
                )}
                {metric(
                  'orders',
                  'Новые заказы',
                  number(orders?.count),
                  delta(orders?.count, previousOrders?.count),
                  'orders',
                )}
              </div>
              <div className="an-two-columns">
                <Panel
                  title="Движение денег"
                  note="Нажмите на столбик, чтобы посмотреть сумму за дату."
                  action={
                    <button
                      type="button"
                      className="an-text-button"
                      onClick={() => switchTab('finance')}
                    >
                      Все операции <ArrowUpRight size={15} />
                    </button>
                  }
                >
                  <MoneyChart report={data} />
                </Panel>
                <Panel
                  title="Результат новых заказов"
                  note="Текущие значения заказов, созданных в периоде."
                >
                  <dl className="an-summary-list">
                    <div>
                      <dt>Сумма заказов</dt>
                      <dd>{money(orders?.amount)}</dd>
                    </div>
                    <div>
                      <dt>Оценочная прибыль · 50%</dt>
                      <dd>{money(orders?.profit)}</dd>
                    </div>
                    <div>
                      <dt>Средняя сумма заказа</dt>
                      <dd>{money(orders?.average)}</dd>
                    </div>
                    <div>
                      <dt>Отменено заказов</dt>
                      <dd>{number(orders?.cancelled)}</dd>
                    </div>
                  </dl>
                  <p className="an-note">
                    Отменённые заказы исключены из сумм. Оценочная прибыль —
                    50% суммы заказа до рекламы. Исходные затраты сохранены.
                  </p>
                  <button
                    type="button"
                    className="an-text-button"
                    onClick={() => switchTab('orders')}
                  >
                    Открыть заказы <ArrowUpRight size={15} />
                  </button>
                </Panel>
              </div>
              <div className="an-two-columns">
                <Panel
                  title="Требует внимания сейчас"
                  note="Все заказы, независимо от выбранного периода."
                >
                  <div className="an-current-grid">
                    <div>
                      <b>{number(current?.activeOrders)}</b>
                      <span>незавершённых заказов</span>
                    </div>
                    <div>
                      <b>{number(current?.overdueOrders)}</b>
                      <span>заказов после срока сдачи</span>
                    </div>
                  </div>
                  <dl className="an-summary-list">
                    <div>
                      <dt>Положительный долг</dt>
                      <dd>{money(current?.debt)}</dd>
                    </div>
                    <div>
                      <dt>Переплаты отдельно</dt>
                      <dd>{money(current?.overpayments)}</dd>
                    </div>
                  </dl>
                  <button
                    type="button"
                    className="an-text-button"
                    onClick={() => switchTab('operations')}
                  >
                    Производство и склад <ArrowUpRight size={15} />
                  </button>
                </Panel>
                <Panel
                  title="Источники обращений"
                  note="Состояние рекламных кабинетов — в разделе «Источники»."
                >
                  <div className="an-provider-strip">
                    {data.acquisition.connections.slice(0, 4).map((c) => (
                      <span key={c.id} title={c.name}>
                        {c.short}
                      </span>
                    ))}
                  </div>
                  <p className="an-explainer">
                    В источниках доступны отдельные отчёты рекламных кабинетов.
                    Ниже — заполненность источника у клиентов в Google.
                  </p>
                  <div className="an-coverage">
                    <strong>
                      {data.quality.sourceCoverage.percent == null
                        ? '—'
                        : `${data.quality.sourceCoverage.percent}%`}
                    </strong>
                    <span>новых заказов с известным источником клиента</span>
                  </div>
                  <button
                    type="button"
                    className="an-text-button"
                    onClick={() => switchTab('acquisition')}
                  >
                    Перейти к источникам <ArrowUpRight size={15} />
                  </button>
                </Panel>
              </div>
            </>
          )}
          {tab === 'finance' && (
            <>
              <div className="an-metrics">
                {metric(
                  'income',
                  'Поступления',
                  money(finance?.income),
                  delta(finance?.income, previous?.income),
                  'finance',
                  true,
                )}
                {metric(
                  'expense',
                  'Выплаты',
                  money(finance?.expense),
                  delta(finance?.expense, previous?.expense),
                  'finance',
                )}
                {metric(
                  'net',
                  'Денежный поток',
                  money(finance?.net),
                  'Не является прибылью',
                  'finance',
                )}
                {metric(
                  'advertisingPayments',
                  'Оплачено за рекламу',
                  money(finance?.advertisingPayments),
                  'По категории денежных расходов',
                  'acquisition',
                )}
              </div>
              <Panel
                title="Поступления и выплаты"
                note={`В поступления включены замеры: ${money(finance?.measurements)}.`}
              >
                <MoneyChart report={data} />
              </Panel>
              <div className="an-two-columns">
                <Panel
                  title="На что ушли деньги"
                  note="Категории расходов из Google."
                >
                  {data.finance.categories.length ? (
                    <div className="an-ranking">
                      {data.finance.categories.map((row) => (
                        <div key={row.label}>
                          <span>
                            {row.label}
                            <small>{row.count} операций</small>
                          </span>
                          <b>{money(row.amount)}</b>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Empty>
                      {finance
                        ? 'Расходов за период нет.'
                        : 'Расходы недоступны.'}
                    </Empty>
                  )}
                </Panel>
                <Panel
                  title="По счетам"
                  note="Движение за период, без начальных остатков."
                >
                  {data.finance.accounts.length ? (
                    <div className="an-account-list">
                      {data.finance.accounts.map((row) => (
                        <div key={row.label}>
                          <h3>{row.label}</h3>
                          <dl className="an-summary-list">
                            <div>
                              <dt>Приход</dt>
                              <dd>{money(row.income)}</dd>
                            </div>
                            <div>
                              <dt>Расход</dt>
                              <dd>{money(row.expense)}</dd>
                            </div>
                            <div>
                              <dt>Разница</dt>
                              <dd>{money(row.net)}</dd>
                            </div>
                          </dl>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Empty>
                      {finance
                        ? 'Операций за период нет.'
                        : 'Данные недоступны.'}
                    </Empty>
                  )}
                </Panel>
              </div>
              <Panel
                title="Операции за период"
                note="Подтверждённые приходы и расходы; каждая операция учтена один раз."
              >
                <div className="an-ledger">
                  {data.finance.transactions
                    .slice((ledgerPage - 1) * 20, ledgerPage * 20)
                    .map((row) => (
                      <div className="an-ledger-row" key={row.id}>
                        <span
                          className={`an-ledger-icon ${row.type === 'income' ? 'is-income' : ''}`}
                        >
                          {row.type === 'income' ? (
                            <ArrowDownLeft size={17} />
                          ) : (
                            <ArrowUpRight size={17} />
                          )}
                        </span>
                        <div>
                          <strong>
                            {row.category ||
                              (row.type === 'income' ? 'Приход' : 'Расход')}
                          </strong>
                          <small>
                            {date(row.date)} · {row.account}
                            {row.orderNumber && (
                              <>
                                {' '}
                                · <OrderLink id={row.orderNumber} />
                              </>
                            )}
                          </small>
                        </div>
                        <b>
                          {row.type === 'expense' ? '−' : '+'}
                          {money(row.amount)}
                        </b>
                      </div>
                    ))}
                </div>
                {!data.finance.transactions.length && (
                  <Empty>
                    {finance
                      ? 'В этом периоде нет операций.'
                      : 'Операции недоступны.'}
                  </Empty>
                )}
                <Pager
                  page={ledgerPage}
                  total={data.finance.transactions.length}
                  onPage={setLedgerPage}
                />
              </Panel>
            </>
          )}
          {tab === 'orders' && (
            <>
              <div className="an-metrics">
                {metric(
                  'orders',
                  'Новые заказы',
                  number(orders?.count),
                  'Кроме отменённых',
                  'orders',
                  true,
                )}
                {metric(
                  'orderAmount',
                  'Сумма заказов',
                  money(orders?.amount),
                  'Текущее значение формулы',
                  'orders',
                )}
                {metric(
                  'profit',
                  'Оценочная прибыль',
                  money(orders?.profit),
                  'Оценка: 50% суммы до рекламы',
                  'orders',
                )}
                {metric(
                  'debt',
                  'Долг по всем заказам',
                  money(current?.debt),
                  'Сейчас · независимо от периода',
                  'operations',
                )}
              </div>
              <Panel
                title="Заказы, созданные в периоде"
                note="Оплаты, долг и прибыль — накопленные значения на момент чтения. Карточки выше относятся ко всему периоду; фильтры ниже меняют список."
              >
                <div className="an-order-filters">
                  <label className="an-search">
                    <Search size={16} />
                    <input
                      aria-label="Поиск заказов в аналитике"
                      placeholder="Номер или название"
                      value={query}
                      onChange={(e) => {
                        setQuery(e.target.value);
                        setPage(1);
                      }}
                    />
                  </label>
                  <select
                    aria-label="Статус заказа"
                    value={status}
                    onChange={(e) => {
                      setStatus(e.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="all">Все статусы</option>
                    {[...new Set(data.orders.rows.map((o) => o.status))].map(
                      (s) => (
                        <option key={s} value={s}>
                          {s || 'Без статуса'}
                        </option>
                      ),
                    )}
                  </select>
                  <select
                    aria-label="Источник клиента"
                    value={source}
                    onChange={(e) => {
                      setSource(e.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="all">Все источники</option>
                    {[...new Set(data.orders.rows.map((o) => o.source))].map(
                      (s) => (
                        <option key={s}>{s}</option>
                      ),
                    )}
                  </select>
                  {(query || status !== 'all' || source !== 'all') && (
                    <button
                      type="button"
                      className="an-text-button"
                      onClick={() => {
                        setQuery('');
                        setStatus('all');
                        setSource('all');
                      }}
                    >
                      Сбросить
                    </button>
                  )}
                </div>
                <div className="an-order-table">
                  <div className="an-order-table-head">
                    <span>Заказ / дата</span>
                    <span>Статус / источник клиента</span>
                    <span>Сумма</span>
                    <span>Оплачено всего</span>
                    <span>Долг</span>
                    <span>Оценочная прибыль</span>
                  </div>
                  {rows.slice((safePage - 1) * 20, safePage * 20).map((o) => (
                    <article className="an-order-row" key={o.id}>
                      <div className="an-order-title">
                        <OrderLink id={o.id}>
                          № {o.id} · {o.title}
                        </OrderLink>
                        <small>{date(o.createdDate)}</small>
                      </div>
                      <div className="an-order-state">
                        <span className="an-tag">
                          {o.status || 'Без статуса'}
                        </span>
                        <small>{o.source}</small>
                      </div>
                      <div>
                        <small>Сумма</small>
                        <b>{money(o.amount)}</b>
                      </div>
                      <div>
                        <small>Оплачено всего</small>
                        <b>{money(o.paid)}</b>
                      </div>
                      <div>
                        <small>Долг</small>
                        <b>{money(o.debt)}</b>
                      </div>
                      <div>
                        <small>Оценочная прибыль</small>
                        <b>{money(o.profit)}</b>
                      </div>
                    </article>
                  ))}
                </div>
                {!rows.length && (
                  <Empty>
                    {orders
                      ? 'Заказов с такими условиями нет.'
                      : 'Данные заказов недоступны.'}
                  </Empty>
                )}
                <Pager page={safePage} total={rows.length} onPage={setPage} />
              </Panel>
              <Panel
                title="Изделия в новых заказах"
                note="Суммы позиций из Google. Общие расходы и прибыль заказа между изделиями не распределяются."
              >
                {data.orders.products.length ? (
                  <div className="an-ranking">
                    {data.orders.products.map((row) => (
                      <div key={row.label}>
                        <span>
                          {row.label}
                          <small>В {row.orders} заказах</small>
                        </span>
                        <b>{money(row.amount)}</b>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Empty>
                    Позиции за выбранный период отсутствуют или недоступны.
                  </Empty>
                )}
              </Panel>
            </>
          )}
          {tab === 'inquiries' && <InquiryMatching period={range} />}
          {tab === 'acquisition' && (
            <>
              <Panel
                title="Реклама и сайты"
                note="Состояние подключений и отчёты рекламных кабинетов и сайтов."
              >
                <div className="an-connections">
                  {data.acquisition.connections.map((c) => (
                    <article key={c.id} className="an-connection">
                      <div className="an-connection-top">
                        <span className="an-provider-logo">{c.short}</span>
                        <span className="an-disconnected">
                          <Unplug size={12} />
                          {c.state === 'not_connected'
                            ? 'Не подключён'
                            : c.state === 'connected'
                              ? 'Данные получены'
                              : 'Настроен · см. отчёт'}
                        </span>
                      </div>
                      <h3>{c.name}</h3>
                      <span className="an-connection-kind">{c.kind}</span>
                      <p>{c.planned}</p>
                      <button
                        type="button"
                        className="an-text-button"
                        onClick={() =>
                          c.id === 'avito' && c.state !== 'not_connected'
                            ? document
                                .getElementById('avito-report')
                                ?.scrollIntoView({ behavior: 'smooth' })
                            : setConnection(c.id)
                        }
                      >
                        {c.id === 'avito' && c.state !== 'not_connected'
                          ? 'Открыть отчёт'
                          : 'Что нужно для подключения'}{' '}
                        <ChevronRight size={14} />
                      </button>
                    </article>
                  ))}
                </div>
              </Panel>
              <AdvertisingAnalytics />
              <Button variant="outline" onClick={()=>switchTab('inquiries')}>Найти связи обращений с заказами</Button>
              <details>
                <summary className="an-text-button">
                  Краткая сводка кабинета
                </summary>
                <AnalyticsAvito />
              </details>
              <div className="an-ad-metrics">
                {[
                  'Общий расход всех кабинетов',
                  'Заявки мастерской из рекламы',
                  'Цена обращения',
                  'ROMI',
                ].map((label) => (
                  <div key={label}>
                    <span>{label}</span>
                    <strong>—</strong>
                    <small>Нужны все источники и связь с заказами</small>
                  </div>
                ))}
              </div>
              <Panel
                title="Источники клиентов в Google"
                note="Ручной источник клиента; не рекламная атрибуция. Нажмите на строку, чтобы увидеть связанные заказы."
              >
                <div className="an-source-top">
                  <div className="an-coverage">
                    <strong>
                      {data.quality.sourceCoverage.percent == null
                        ? '—'
                        : `${data.quality.sourceCoverage.percent}%`}
                    </strong>
                    <span>
                      {data.quality.sourceCoverage.known} из{' '}
                      {data.quality.sourceCoverage.total} новых заказов с
                      известным источником
                    </span>
                  </div>
                  <p>
                    Оплачено за рекламу:{' '}
                    <b>{money(finance?.advertisingPayments)}</b>
                    <small>
                      Денежные расходы за период. Не складываются со списаниями
                      кабинетов.
                    </small>
                  </p>
                </div>
                <div className="an-source-table">
                  <div className="an-source-head">
                    <span>Источник клиента</span>
                    <span>Заказы</span>
                    <span>Сумма заказов</span>
                    <span>Оценочная прибыль</span>
                  </div>
                  {data.acquisition.manualSources.map((row) => (
                    <button
                      type="button"
                      key={row.label}
                      className="an-source-row"
                      onClick={() => {
                        setSource(row.label);
                        setStatus('all');
                        setQuery('');
                        switchTab('orders');
                      }}
                    >
                      <span>
                        <i
                          className={
                            row.known ? 'an-known-dot' : 'an-unknown-dot'
                          }
                        />
                        {row.label}
                      </span>
                      <span>
                        <small>Заказы</small>
                        <b>{row.orders}</b>
                      </span>
                      <span>
                        <small>Сумма</small>
                        <b>{money(row.amount)}</b>
                      </span>
                      <span>
                        <small>Прибыль</small>
                        <b>{money(row.profit)}</b>
                      </span>
                    </button>
                  ))}
                </div>
                {!data.acquisition.manualSources.length && (
                  <Empty>
                    Нет заказов за период или источник заказов недоступен.
                  </Empty>
                )}
              </Panel>
            </>
          )}
          {tab === 'funnel' && (
            <>
              <Panel
                title="От первого контакта до результата"
                note="Для сквозной воронки нужны обращения и подтверждённые связи с заказами."
              >
                <div className="an-funnel-flow">
                  {[
                    { label: 'Посещения', hint: 'Сайты и счётчики' },
                    { label: 'Обращения', hint: 'Формы, звонки и чаты' },
                    { label: 'Квалификация', hint: 'Реестр обращений' },
                    { label: 'Заказ', hint: 'Связь с обращением' },
                    { label: 'Оплата', hint: 'Связь с заказом' },
                  ].map((stage, i) => (
                    <div key={stage.label}>
                      <span>{String(i + 1).padStart(2, '0')}</span>
                      <h3>{stage.label}</h3>
                      <strong>—</strong>
                      <small>{stage.hint}</small>
                    </div>
                  ))}
                </div>
                <p className="an-note">
                  Реестр обращений ещё не создан. Количество заказов и денежных
                  операций само по себе не даёт конверсию из обращения в
                  продажу.
                </p>
                <button
                  type="button"
                  className="an-text-button"
                  onClick={() => switchTab('acquisition')}
                >
                  Посмотреть источники <Link2 size={15} />
                </button>
              </Panel>
              {statusPanel}
            </>
          )}
          {tab === 'operations' && (
            <>
              <div className="an-section-kicker">
                <span>Состояние сейчас</span>
                <small>Не ограничено выбранным периодом</small>
              </div>
              <div className="an-metrics">
                {metric(
                  'debt',
                  'Долг по всем заказам',
                  money(current?.debt),
                  'Положительный долг, без отменённых',
                  'orders',
                  true,
                )}
                <div className="an-metric">
                  <span>Заказов после срока</span>
                  <strong>{number(current?.overdueOrders)}</strong>
                  <p>Все незавершённые заказы</p>
                </div>
                <div className="an-metric">
                  <span>Этапов в работе</span>
                  <strong>{number(data.operations.production?.open)}</strong>
                  <p>Незавершённые этапы активных заказов</p>
                </div>
                <div className="an-metric">
                  <span>Материалов ниже минимума</span>
                  <strong>
                    {number(data.operations.warehouse?.belowMinimum)}
                  </strong>
                  <p>
                    {data.operations.warehouse
                      ? `Не хватает данных для проверки: ${data.operations.warehouse.incomplete}`
                      : 'Данные склада недоступны'}
                  </p>
                </div>
              </div>
              <div className="an-two-columns">
                <Panel
                  title="Производство"
                  note="Этапы незавершённых заказов из действующего модуля."
                  action={
                    <a className="an-text-button" href="/production/">
                      Открыть <ExternalLink size={15} />
                    </a>
                  }
                >
                  <dl className="an-summary-list">
                    <div>
                      <dt>Незавершённых этапов</dt>
                      <dd>{number(data.operations.production?.open)}</dd>
                    </div>
                    <div>
                      <dt>Готовы по зависимостям</dt>
                      <dd>{number(data.operations.production?.ready)}</dd>
                    </div>
                    <div>
                      <dt>Просроченные этапы</dt>
                      <dd>{number(data.operations.production?.overdue)}</dd>
                    </div>
                  </dl>
                  <p className="an-note">
                    Готовность по зависимостям не означает назначение мастера
                    или наличие материалов.
                  </p>
                </Panel>
                <Panel
                  title="Монтажи"
                  note="Текущие статусы монтажей незавершённых заказов."
                >
                  {data.operations.installations?.length ? (
                    <dl className="an-summary-list">
                      {data.operations.installations.map((row) => (
                        <div key={row.label}>
                          <dt>{row.label}</dt>
                          <dd>{row.count}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <Empty>
                      {data.operations.installations
                        ? 'Монтажей у незавершённых заказов нет.'
                        : 'Данные монтажей недоступны.'}
                    </Empty>
                  )}
                </Panel>
              </div>
              <Panel
                title="Заказы после срока сдачи"
                note="Срок уже прошёл, заказ ещё не сдан и не отменён."
              >
                {data.operations.overdueOrders?.length ? (
                  <div className="an-ranking">
                    {data.operations.overdueOrders.map((row) => (
                      <div key={row.id}>
                        <span>
                          <OrderLink id={row.id}>
                            № {row.id} · {row.title}
                          </OrderLink>
                          <small>Срок {date(row.dueDate)}</small>
                        </span>
                        <b>
                          {money(row.debt)}
                          <small>долг</small>
                        </b>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Empty>
                    {data.operations.overdueOrders
                      ? 'Таких заказов сейчас нет.'
                      : 'Заказы недоступны.'}
                  </Empty>
                )}
              </Panel>
              <Panel
                title="Склад: остатки и качество данных"
                note="Доступно = остаток минус резерв. Материалы с неполными значениями также требуют проверки."
                action={
                  <a href="/#warehouse" className="an-text-button">
                    Открыть склад <ExternalLink size={15} />
                  </a>
                }
              >
                <div className="an-stock-list">
                  {data.operations.warehouse?.rows.map((item) => (
                    <div key={item.sku}>
                      <span>
                        <strong>{item.name}</strong>
                        <small>{item.sku}</small>
                      </span>
                      <span>
                        Доступно{' '}
                        <b>
                          {item.stock == null || item.reserved == null
                            ? '—'
                            : number(item.stock - item.reserved)}{' '}
                          {item.unit}
                        </b>
                        <small>
                          Минимум {number(item.minStock)} {item.unit}
                        </small>
                      </span>
                    </div>
                  ))}
                </div>
                {!data.operations.warehouse?.rows.length && (
                  <Empty>
                    {data.operations.warehouse
                      ? 'Все прочитанные материалы выше минимума или равны ему.'
                      : 'Склад недоступен.'}
                  </Empty>
                )}
              </Panel>
            </>
          )}
          {tab === 'quality' && (
            <>
              <Panel
                title="Свежесть источников"
                note="Дата успешного чтения показана отдельно для каждого источника. Рекламные данные ещё не загружались."
              >
                <div className="an-quality-sources">
                  {data.sources.map((s) => (
                    <article key={s.id}>
                      <div>
                        <span
                          className={`an-state-icon ${s.state === 'ready' ? 'is-ready' : ''}`}
                        >
                          {s.state === 'ready' ? (
                            <Check size={16} />
                          ) : (
                            <CircleHelp size={16} />
                          )}
                        </span>
                        <strong>{s.label}</strong>
                        <span
                          className={`an-tag ${s.state === 'ready' ? 'an-tag-ready' : ''}`}
                        >
                          {s.state === 'ready'
                            ? 'Прочитано'
                            : s.state === 'stale'
                              ? 'Устарело'
                              : 'Недоступно'}
                        </span>
                      </div>
                      <dl>
                        <div>
                          <dt>Данные получены</dt>
                          <dd>{stamp(s.loadedAt)}</dd>
                        </div>
                        <div>
                          <dt>Последняя попытка</dt>
                          <dd>{stamp(s.checkedAt)}</dd>
                        </div>
                      </dl>
                    </article>
                  ))}
                </div>
              </Panel>
              <Panel
                title="Проверки и ограничения"
                note="Прочерк означает отсутствие подтверждённого значения; ноль означает отсутствие активности в прочитанных данных."
              >
                {data.quality.issues.length ? (
                  <ul className="an-issue-list">
                    {data.quality.issues.map((i) => (
                      <li key={i.code}>
                        <CircleHelp size={16} />
                        <span>
                          {i.message}
                          {i.count !== undefined && <b> Записей: {i.count}.</b>}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="an-success">
                    <Check size={17} />В доступных данных текущие проверки не
                    нашли проблем.
                  </p>
                )}
                <ul className="an-limitations">
                  {data.quality.limitations.map((text) => (
                    <li key={text}>{text}</li>
                  ))}
                </ul>
                <p className="an-note">
                  Проверки не заменяют сверку учёта. Доходность рекламы, точный
                  CAC и LTV появятся после подключения данных и устойчивых
                  связей клиентов.
                </p>
              </Panel>
              <Panel
                title="Как считаются показатели"
                note="Единые определения для карточек, детализации и выгрузки."
              >
                <div className="an-definitions">
                  {data.definitions.map((d) => (
                    <details key={d.id}>
                      <summary>
                        {d.label}
                        <span>{d.basis}</span>
                      </summary>
                      <p>{d.rule}</p>
                      <small>Источник: {d.source}</small>
                    </details>
                  ))}
                </div>
              </Panel>
            </>
          )}
          <footer className="an-footer">
            <span>
              <BarChart3 size={14} />
              Google Таблица · только подтверждённые данные
            </span>
            <button type="button" onClick={() => switchTab('quality')}>
              Данные от{' '}
              {stamp(
                data.sources
                  .map((s) => s.loadedAt)
                  .filter((s): s is string => Boolean(s))
                  .sort()[0] || null,
              )}{' '}
              · источники и определения <ChevronRight size={13} />
            </button>
          </footer>
        </div>
      )}
      <Dialog
        open={Boolean(definition)}
        onOpenChange={(open) => {
          if (!open) setDefinition(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{definition?.label}</DialogTitle>
            <DialogDescription>{definition?.basis}</DialogDescription>
          </DialogHeader>
          <p className="text-sm leading-relaxed">{definition?.rule}</p>
          <p className="text-xs text-muted-foreground">
            Источник: {definition?.source}
          </p>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(pendingSource)}
        onOpenChange={(open) => {
          if (!open) setConnection(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pendingSource?.name}</DialogTitle>
            <DialogDescription>Источник пока не подключён.</DialogDescription>
          </DialogHeader>
          <p className="text-sm leading-relaxed">{pendingSource?.requires}</p>
          <p className="text-sm text-muted-foreground">
            После подключения здесь будут показаны доступные показатели, дата
            загрузки и полнота отчёта. Загруженных отчётов пока нет.
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
