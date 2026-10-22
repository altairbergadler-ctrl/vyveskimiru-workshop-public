import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Download,
  ExternalLink,
  RefreshCw,
  Search,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  analyticsDate as date,
  analyticsMoney as money,
} from '@/lib/analytics';
import {
  adColumns,
  advertisingCsv,
  advertisingHistoryCsv,
  type AdvertisingReport,
  type AdEvent,
  type AdRow,
} from '@/lib/advertising';
import './advertising-analytics.css';
const number = (value: number | null | undefined) =>
  value == null
    ? '—'
    : value.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const rub = (minor: number | null | undefined) =>
  minor == null ? '—' : money(minor / 100);
const percent = (value: number | null | undefined) =>
  value == null ? '—' : number(value) + '%';
const stamp = (value: string | null | undefined) =>
  value
    ? new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })
    : 'Ещё не загружено';
const today = () => new Date().toISOString().slice(0, 10);
const initial = () => ({
  dateFrom: today().slice(0, 8) + '01',
  dateTo: today(),
});
const kinds: Record<string, string> = {
  inventory: 'Список объявлений',
  items: 'Эффективность за период',
  traffic: 'Дни по объявлениям',
  calls: 'Звонки',
  services: 'Продвижение',
  info: 'Публикация и поднятия',
  account_days: 'Дни кабинета',
};
const statuses: Record<string, string> = {
  active: 'Активно',
  removed: 'Снято',
  old: 'Истекло',
  blocked: 'Заблокировано',
  rejected: 'Отклонено',
  unknown: 'Нет в текущем списке',
  not_found: 'Не найдено',
};
const fields: Record<string, string> = {
  title: 'Заголовок',
  price: 'Цена',
  status: 'Статус',
  category: 'Категория',
  url: 'Ссылка',
  services: 'Услуги продвижения',
  servicesExplicit: 'Состав ответа об услугах',
  startTime: 'Начало публикации',
  finishTime: 'Окончание публикации',
  vas: 'Поднятия и расписание',
  vasExplicit: 'Состав ответа о поднятиях',
};
const kindLabel = (kind: string) =>
  kind.startsWith('items:')
    ? 'Показатели за ' + kind.slice(6).replace(':', ' — ')
    : kind.startsWith('traffic:')
      ? 'Дневные показатели'
      : kinds[kind] || kind;
const fieldLabel = (field: string) =>
  field.startsWith('metrics.')
    ? adColumns.find((c) => c.key === field.slice(8))?.label || field
    : fields[field] || field;
const historyValue = (event: AdEvent, field: string, previous = false) => {
  const row = previous ? event.previousValue : event.value;
  let value = row?.[field];
  if (field.startsWith('metrics.'))
    value = (row?.metrics as Record<string, unknown> | undefined)?.[
      field.slice(8)
    ];
  if (value == null) return '—';
  if (typeof value === 'number')
    return field === 'price'
      ? money(value)
      : adColumns.find((c) => 'metrics.' + c.key === field)?.money
        ? rub(value)
        : number(value);
  if (typeof value === 'string')
    return field === 'status' ? statuses[value] || value : value;
  if (Array.isArray(value)) return value.length + ' записей';
  return 'состояние обновлено';
};
const save = (text: string, name: string) => {
  const url = URL.createObjectURL(
    new Blob([text], { type: 'text/csv;charset=utf-8' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
function Value({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}
function Signals({ row }: { row: AdRow }) {
  return (
    <span className="ad-signals">
      {row.signals.length
        ? row.signals.map((s) => (
            <span
              key={s.code}
              className={s.level === 'attention' ? 'ad-attention' : ''}
            >
              {s.label}
            </span>
          ))
        : row.metrics
          ? 'Без этих сигналов'
          : 'Нет статистики за период'}
    </span>
  );
}
export function AdvertisingAnalytics() {
  const [period, setPeriod] = useState(initial),
    [draft, setDraft] = useState(initial),
    [data, setData] = useState<AdvertisingReport | null>(null),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0),
    [syncing, setSyncing] = useState(false);
  const [tab, setTab] = useState('items'),
    [search, setSearch] = useState(''),
    [status, setStatus] = useState('all'),
    [signal, setSignal] = useState('all'),
    [sort, setSort] = useState('spending'),
    [page, setPage] = useState(0),
    [selected, setSelected] = useState<string | null>(null);
  const [history, setHistory] = useState<AdEvent[]>([]),
    [cursor, setCursor] = useState<number | null>(null),
    [historyError, setHistoryError] = useState(''),
    [historyBusy, setHistoryBusy] = useState(false);
  const [note, setNote] = useState(''),
    [noteDate, setNoteDate] = useState(today),
    [noteError, setNoteError] = useState('');
  const noteId = useRef(crypto.randomUUID());
  const generation = useRef(0),
    historyGeneration = useRef(0);
  const valid =
    data &&
    data.period.dateFrom === period.dateFrom &&
    data.period.dateTo === period.dateTo
      ? data
      : null;
  useEffect(() => {
    const controller = new AbortController(),
      id = ++generation.current;
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const response = await fetch(
          '/api/analytics/avito/deep?' + new URLSearchParams(period),
          { signal: controller.signal, cache: 'no-store' },
        );
        const result = await response.json();
        if (!response.ok)
          throw new Error(
            result.error || 'Не удалось прочитать рекламную аналитику.',
          );
        if (id === generation.current) {
          setData(result);
          setError('');
        }
      } catch (e) {
        if (!controller.signal.aborted && id === generation.current)
          setError(
            e instanceof Error ? e.message : 'Не удалось прочитать отчёт.',
          );
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [period, revision]);
  const rows = useMemo(() => {
    const source = (valid?.rows || []).filter(
      (r) =>
        (status === 'all' || r.status === status) &&
        (signal === 'all' ||
          (signal === 'missing' && !r.metrics) ||
          r.signals.some((s) => s.code === signal)) &&
        `${r.title} ${r.id} ${r.category?.name || ''}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    );
    const value = (r: AdRow) =>
      sort === 'costContact'
        ? r.rates.costContact
        : sort === 'ctr'
          ? r.rates.ctr
          : r.metrics?.[sort];
    return source.sort((a, b) => {
      const av = value(a),
        bv = value(b);
      return av == null
        ? bv == null
          ? a.id.localeCompare(b.id)
          : 1
        : bv == null
          ? -1
          : sort === 'costContact'
            ? av - bv
            : bv - av;
    });
  }, [valid, status, signal, search, sort]);
  const item = valid?.rows.find((r) => r.id === selected);
  const launch = async () => {
    setSyncing(true);
    setError('');
    try {
      const response = await fetch('/api/analytics/avito/deep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(period),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || 'Не удалось запустить загрузку.');
      setRevision((r) => r + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки.');
    } finally {
      setSyncing(false);
    }
  };
  const readHistory = async (id: string, before?: number) => {
    const version = ++historyGeneration.current;
    setHistoryBusy(true);
    setHistoryError('');
    try {
      const params = new URLSearchParams({
        itemId: id,
        ...(before ? { before: String(before) } : {}),
      });
      const response = await fetch(
        '/api/analytics/avito/deep/history?' + params,
        { cache: 'no-store' },
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error || 'Не удалось прочитать историю.');
      if (version === historyGeneration.current) {
        setHistory((h) => (before ? [...h, ...value.rows] : value.rows));
        setCursor(value.nextBefore);
      }
    } catch (e) {
      if (version === historyGeneration.current)
        setHistoryError(e instanceof Error ? e.message : 'История недоступна.');
    } finally {
      if (version === historyGeneration.current) setHistoryBusy(false);
    }
  };
  const open = (id: string) => {
    setSelected(id);
    setHistory([]);
    setCursor(null);
    setNote('');
    setNoteError('');
    noteId.current = crypto.randomUUID();
    void readHistory(id);
  };
  const addNote = async () => {
    if (!item) return;
    setNoteError('');
    try {
      const response = await fetch('/api/analytics/avito/deep/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: noteId.current,
          itemId: item.id,
          date: noteDate,
          text: note,
        }),
      });
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error || 'Не удалось сохранить отметку.');
      setNote('');
      noteId.current = crypto.randomUUID();
      setRevision((r) => r + 1);
    } catch (e) {
      setNoteError(e instanceof Error ? e.message : 'Отметка не сохранена.');
    }
  };
  const active = valid?.jobs.find((j) =>
    ['running', 'queued'].includes(j.state),
  );
  return (
    <section
      className="an-panel ad-root"
      id="avito-effectiveness"
      aria-label="Эффективность Авито"
    >
      <div className="an-panel-head">
        <div>
          <p className="ad-eyebrow">РЕКЛАМНАЯ АНАЛИТИКА</p>
          <h2>Авито · эффективность объявлений</h2>
          <p>
            От расходов и контактов — к каждому объявлению, продвижению и
            изменению.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={
            !valid?.enabled ||
            syncing ||
            Boolean(
              active &&
              active.from === period.dateFrom &&
              active.to === period.dateTo,
            )
          }
          onClick={() => void launch()}
        >
          <RefreshCw size={15} />
          {active ? 'Загрузка продолжается' : 'Обновить детализацию'}
        </Button>
      </div>
      <form
        className="an-avito-form"
        onSubmit={(e) => {
          e.preventDefault();
          setSelected(null);
          setPage(0);
          setPeriod({ ...draft });
        }}
      >
        <label>
          С{' '}
          <input
            aria-label="Реклама: начало периода"
            type="date"
            required
            value={draft.dateFrom}
            max={today()}
            onChange={(e) => setDraft({ ...draft, dateFrom: e.target.value })}
          />
        </label>
        <label>
          По{' '}
          <input
            aria-label="Реклама: конец периода"
            type="date"
            required
            value={draft.dateTo}
            min={draft.dateFrom}
            max={today()}
            onChange={(e) => setDraft({ ...draft, dateTo: e.target.value })}
          />
        </label>
        <Button variant="outline" type="submit">
          Показать детализацию
        </Button>
        <span className="ad-presets">
          {[7, 30, 90, 270].map((n) => (
            <button
              type="button"
              key={n}
              onClick={() => {
                const p = {
                  dateFrom: new Date(Date.parse(today()) - (n - 1) * 86400000)
                    .toISOString()
                    .slice(0, 10),
                  dateTo: today(),
                };
                setDraft(p);
                setPeriod(p);
                setSelected(null);
                setPage(0);
              }}
            >
              {n} дней
            </button>
          ))}
        </span>
      </form>
      {error && (
        <div className="an-error" role="alert">
          {error}
          <button type="button" onClick={() => setRevision((v) => v + 1)}>
            Повторить чтение
          </button>
        </div>
      )}
      {!valid && !error && (
        <p className="an-empty">Читаем рекламную аналитику…</p>
      )}
      {valid && !valid.enabled && (
        <p className="an-empty">Подключение Авито ещё не включено.</p>
      )}
      {valid?.enabled && (
        <>
          <div className="ad-meta">
            <span>
              {date(period.dateFrom)} — {date(period.dateTo)}
            </span>
            <span>
              Сравнение: {date(valid.period.previous.dateFrom)} —{' '}
              {date(valid.period.previous.dateTo)}
            </span>
            <span>
              Данные: {stamp(valid.loadedAt)} МСК
              {valid.stale ? ' · требуют обновления' : ''}
            </span>
          </div>
          {active && (
            <output className="ad-job">
              <strong>
                Собираем детализацию: {active.done} из {active.total} шагов
              </strong>
              <span>
                Объявления и их история появляются по мере загрузки. Ограничения
                Авито могут потребовать несколько минут.
              </span>
              <progress value={active.done} max={Math.max(1, active.total)} />
            </output>
          )}
          <div className="an-avito-metrics ad-kpis">
            <Value
              label="Расходы по объявлениям"
              value={rub(valid.summary?.spending)}
              note={`${valid.reportedItems} объявлений в отчёте`}
            />
            <Value
              label="Контакты Авито"
              value={number(valid.summary?.contacts)}
              note="По правилам кабинета, не заявки мастерской"
            />
            <Value
              label="Цена контакта"
              value={money(valid.rates.costContact)}
              note="Расходы деньгами / контакты"
            />
            <Value
              label="Расходы без контактов"
              value={rub(valid.noContactsSpend)}
              note="Для проверки; не доказанный убыток"
            />
            <Value
              label="Показы → просмотры"
              value={percent(valid.rates.ctr)}
            />
            <Value
              label="Просмотры → контакты"
              value={percent(valid.rates.contactRate)}
            />
            <Value label="Цена просмотра" value={money(valid.rates.costView)} />
            <Value
              label="Объявления в кабинете"
              value={number(valid.inventoryItems)}
              note={`${valid.coverage.withoutStats} без строки статистики`}
            />
          </div>
          <nav className="ad-tabs" aria-label="Рекламные отчёты">
            {[
              ['items', 'Объявления'],
              ['daily', 'Динамика по дням'],
              ['changes', 'Изменения'],
              ['journal', 'Журнал загрузок'],
              ['quality', 'Полнота данных'],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={tab === key ? 'active' : ''}
                onClick={() => {
                  setTab(key);
                  setSelected(null);
                }}
              >
                {label}
              </button>
            ))}
          </nav>
          {tab === 'items' && !item && (
            <>
              <div className="ad-filters">
                <label className="ad-search">
                  <Search size={16} />
                  <input
                    aria-label="Поиск рекламного объявления"
                    placeholder="Название, номер или категория"
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setPage(0);
                    }}
                  />
                </label>
                <select
                  aria-label="Статус объявления"
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value);
                    setPage(0);
                  }}
                >
                  <option value="all">Все статусы</option>
                  {Object.entries(statuses).map(([s, label]) => (
                    <option key={s} value={s}>
                      {label}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Сигналы эффективности"
                  value={signal}
                  onChange={(e) => {
                    setSignal(e.target.value);
                    setPage(0);
                  }}
                >
                  <option value="all">Все объявления</option>
                  <option value="spend_no_contacts">
                    Расходы без контактов
                  </option>
                  <option value="no_views">Показы без просмотров</option>
                  <option value="no_contacts">Просмотры без контактов</option>
                  <option value="cost_up">Контакт подорожал</option>
                  <option value="missing">Нет статистики</option>
                </select>
                <select
                  aria-label="Сортировка объявлений"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                >
                  <option value="spending">По расходам</option>
                  <option value="contacts">По контактам</option>
                  <option value="costContact">Дешёвый контакт сначала</option>
                  <option value="views">По просмотрам</option>
                  <option value="ctr">По CTR</option>
                </select>
                <button
                  className="an-text-button"
                  type="button"
                  onClick={() =>
                    save(
                      advertisingCsv(valid, rows),
                      'avito-items-' + period.dateFrom + '.csv',
                    )
                  }
                >
                  <Download size={14} />
                  CSV выбранных строк ({rows.length})
                </button>
              </div>
              <p className="ad-help">
                Сводка выше относится ко всему отчёту; фильтры и CSV ниже — к
                выбранным объявлениям. Цена контакта не равна стоимости нового
                клиента.
              </p>
              {valid.previousSourceState === 'no_rows' && (
                <p className="ad-help">
                  За предыдущий период Авито не вернул строк статистики.
                  Сравнение недоступно; пропуски не означают нулевые расходы или
                  контакты.
                </p>
              )}
              <div className="ad-table-wrap">
                <table className="ad-table">
                  <thead>
                    <tr>
                      <th>Объявление</th>
                      <th>Расходы</th>
                      <th>Показы</th>
                      <th>Просмотры</th>
                      <th>Контакты</th>
                      <th>Цена контакта</th>
                      <th>Изменение цены контакта</th>
                      <th>Сигналы</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(page * 20, page * 20 + 20).map((row) => (
                      <tr key={row.id}>
                        <td>
                          <button
                            type="button"
                            className="ad-item-link"
                            onClick={() => open(row.id)}
                          >
                            {row.title}
                          </button>
                          <small>
                            №{row.id} · {statuses[row.status] || row.status}
                          </small>
                        </td>
                        <td>{rub(row.metrics?.spending)}</td>
                        <td>{number(row.metrics?.impressions)}</td>
                        <td>{number(row.metrics?.views)}</td>
                        <td>{number(row.metrics?.contacts)}</td>
                        <td>{money(row.rates.costContact)}</td>
                        <td>
                          {row.change.costContact?.percent == null
                            ? '—'
                            : `${row.change.costContact.percent > 0 ? '+' : ''}${percent(row.change.costContact.percent)}`}
                        </td>
                        <td>
                          <Signals row={row} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!rows.length && (
                <p className="an-empty">
                  Объявления для этих фильтров ещё не найдены. Загрузите
                  детализацию периода или измените фильтры.
                </p>
              )}
              <div className="ad-pagination">
                <Button
                  variant="outline"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Назад
                </Button>
                <span>
                  {page + 1} / {Math.max(1, Math.ceil(rows.length / 20))}
                </span>
                <Button
                  variant="outline"
                  disabled={(page + 1) * 20 >= rows.length}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Далее
                </Button>
              </div>
            </>
          )}
          {tab === 'items' && item && (
            <div
              className="ad-detail"
              aria-label="Карточка рекламного объявления"
            >
              <button
                type="button"
                className="an-text-button"
                onClick={() => setSelected(null)}
              >
                <ArrowLeft size={15} />К объявлениям
              </button>
              <div className="ad-detail-title">
                <div>
                  <h3>{item.title}</h3>
                  <p>
                    №{item.id} · {statuses[item.status] || item.status} · Цена в
                    объявлении: {money(item.price)}
                  </p>
                </div>
                {item.url && (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="an-text-button"
                  >
                    Открыть на Авито <ExternalLink size={14} />
                  </a>
                )}
              </div>
              <Signals row={item} />
              <div className="an-avito-metrics">
                <Value
                  label="Расходы"
                  value={rub(item.metrics?.spending)}
                  note={`Прежде: ${rub(item.previous?.spending)}`}
                />
                <Value
                  label="Контакты"
                  value={number(item.metrics?.contacts)}
                  note={`Прежде: ${number(item.previous?.contacts)}`}
                />
                <Value
                  label="Цена контакта"
                  value={money(item.rates.costContact)}
                  note={`Прежде: ${money(item.previousRates.costContact)}`}
                />
                <Value
                  label="CTR / конверсия в контакт"
                  value={`${percent(item.rates.ctr)} / ${percent(item.rates.contactRate)}`}
                />
                <Value
                  label="Размещение и целевые действия"
                  value={rub(item.metrics?.presenceSpending)}
                />
                <Value
                  label="Продвижение"
                  value={rub(item.metrics?.promoSpending)}
                />
                <Value
                  label="Прочие расходы / комиссия"
                  value={`${rub(item.metrics?.restSpending)} / ${rub(item.metrics?.commission)}`}
                />
                <Value
                  label="Звонки / отвеченные"
                  value={`${number(item.calls.calls)} / ${number(item.calls.answered)}`}
                  note={
                    item.calls.reportedDays
                      ? `${item.calls.reportedDays} дней с данными`
                      : 'Авито не вернул дни звонков'
                  }
                />
              </div>
              <h3>Все показатели объявления</h3>
              <div className="ad-table-wrap">
                <table className="ad-table">
                  <thead>
                    <tr>
                      <th>Показатель</th>
                      <th>Выбранный период</th>
                      <th>Предыдущий период</th>
                    </tr>
                  </thead>
                  <tbody>
                    {adColumns.map((c) => (
                      <tr key={c.key}>
                        <td>{c.label}</td>
                        <td>
                          {c.money
                            ? rub(item.metrics?.[c.key])
                            : number(item.metrics?.[c.key])}
                        </td>
                        <td>
                          {c.money
                            ? rub(item.previous?.[c.key])
                            : number(item.previous?.[c.key])}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h3>Публикация и продвижение</h3>
              <p className="ad-help">
                Начало публикации: {stamp(item.info?.startTime)} · Окончание:{' '}
                {stamp(item.info?.finishTime)}. Это даты публикации, не время
                редактирования.
              </p>
              {item.services?.length ? (
                item.services.map((s, i) => (
                  <p className="ad-promotion" key={s.slug + i}>
                    <strong>{s.name}</strong> · {stamp(s.startDate)} —{' '}
                    {stamp(s.endDate)}
                  </p>
                ))
              ) : (
                <p className="ad-help">
                  В последней проверке активные услуги не перечислены. Это не
                  означает, что продвижение никогда не применялось.
                </p>
              )}
              {item.info?.vas.map((v, i) => (
                <p className="ad-help" key={v.id + i}>
                  Услуга {v.id} · до {stamp(v.finishTime)} · следующие
                  применения:{' '}
                  {v.schedule.map(stamp).join(', ') || 'не возвращены'}
                </p>
              ))}
              <h3>Дневная статистика объявления</h3>
              <p className="ad-help">
                Дневные уникальные просмотры, контакты и избранное. Пропуск дня
                означает отсутствие строки ответа; он не превращается в ноль.
                Расходы этого объявления доступны за выбранный период выше.
              </p>
              <div className="ad-table-wrap">
                <table className="ad-table">
                  <thead>
                    <tr>
                      <th>Дата</th>
                      <th>Просмотры</th>
                      <th>Контакты</th>
                      <th>Избранное</th>
                    </tr>
                  </thead>
                  <tbody>
                    {item.days.map((d) => (
                      <tr key={d.date}>
                        <td>{date(d.date)}</td>
                        <td>{number(d.views)}</td>
                        <td>{number(d.contacts)}</td>
                        <td>{number(d.favorites)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h3>Отметить изменение и сравнить результат</h3>
              <p className="ad-help">
                Для текста, фотографий, акции или изменения бюджета, которые API
                не показывает. Отметка ничего не меняет в объявлении. Сравнение
                — по 7 полным дням до и после, без дня изменения; это
                наблюдение, не доказательство причины.
              </p>
              <form
                className="ad-note-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void addNote();
                }}
              >
                <input
                  type="date"
                  aria-label="Дата изменения объявления"
                  required
                  max={today()}
                  value={noteDate}
                  onChange={(e) => setNoteDate(e.target.value)}
                />
                <textarea
                  aria-label="Что изменилось в объявлении"
                  required
                  maxLength={1000}
                  placeholder="Например: заменили главное фото, изменили заголовок"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <Button type="submit">Сохранить отметку</Button>
              </form>
              {noteError && <p role="alert">{noteError}</p>}
              {item.notes.map((n) => (
                <div className="ad-note" key={n.id}>
                  <strong>{date(n.date)} · Ваша отметка</strong>
                  <p>{n.text}</p>
                  {n.comparison && (
                    <>
                      <p>
                        Дни для сравнения: до {n.comparison.before.knownDays}/7,
                        после {n.comparison.after.knownDays}/7.
                      </p>
                      <p>
                        Контакты: {number(n.comparison.before.contacts)} →{' '}
                        {number(n.comparison.after.contacts)} · Просмотры:{' '}
                        {number(n.comparison.before.views)} →{' '}
                        {number(n.comparison.after.views)}
                      </p>
                      {(!n.comparison.before.complete ||
                        !n.comparison.after.complete) && (
                        <small>
                          Для сравнения пока не хватает полных дней с данными.
                        </small>
                      )}
                    </>
                  )}
                </div>
              ))}
              <div className="ad-history-head">
                <h3>Каждая проверка и изменения</h3>
                <button
                  type="button"
                  className="an-text-button"
                  onClick={() =>
                    save(
                      advertisingHistoryCsv(history),
                      'avito-history-' + item.id + '.csv',
                    )
                  }
                >
                  <Download size={14} />
                  CSV загруженной истории
                </button>
              </div>
              <p className="ad-help">
                Изменение могло произойти между предыдущей и текущей проверкой.
                События до начала наблюдения и кратковременные правки между
                проверками могут отсутствовать.
              </p>
              {historyError && <p role="alert">{historyError}</p>}
              <ol className="ad-timeline">
                {history.map((h) => (
                  <li key={h.id}>
                    <strong>
                      {stamp(h.observedAt)} · {kindLabel(h.kind)}
                    </strong>
                    <p>
                      {h.fields.length
                        ? `Изменилось: ${h.fields.map((f) => fieldLabel(f)).join(', ')}`
                        : h.previousObservedAt
                          ? 'Проверено: изменений не обнаружено'
                          : 'Первое сохранённое состояние'}
                    </p>
                    {h.fields.map((f) => (
                      <p key={f}>
                        {fieldLabel(f)}: {historyValue(h, f, true)} →{' '}
                        {historyValue(h, f)}
                      </p>
                    ))}
                    {h.fields.length > 0 && (
                      <small>
                        Между {stamp(h.previousObservedAt)} и{' '}
                        {stamp(h.observedAt)}
                      </small>
                    )}
                    <p>
                      {typeof h.value.title === 'string' ? h.value.title : ''}
                      {typeof h.value.status === 'string'
                        ? ` · ${statuses[h.value.status] || h.value.status}`
                        : ''}
                      {typeof h.value.price === 'number'
                        ? ` · ${money(h.value.price)}`
                        : ''}
                    </p>
                  </li>
                ))}
              </ol>
              {historyBusy && <p>Читаем историю…</p>}
              {cursor && (
                <Button
                  variant="outline"
                  disabled={historyBusy}
                  onClick={() => void readHistory(item.id, cursor)}
                >
                  Загрузить ещё проверки
                </Button>
              )}
            </div>
          )}
          {tab === 'daily' && (
            <>
              <h3>Динамика кабинета</h3>
              <p className="ad-help">
                По дням отчёта Авито. Валюта — рубли. Начисления могут
                уточняться при следующих загрузках; неполные дни и пропуски не
                доказывают падение эффективности.
              </p>
              <div className="ad-chart" aria-label="Расходы кабинета по дням">
                {valid.daily.map((d) => (
                  <div
                    key={d.sourceKey}
                    title={`${date(d.date || '')} · ${rub(d.metrics.spending)}`}
                  >
                    <span
                      style={{
                        height: `${d.metrics.spending == null ? 0 : Math.max(2, (d.metrics.spending / Math.max(1, ...valid.daily.map((x) => x.metrics.spending || 0))) * 100)}px`,
                      }}
                    />
                    <small>{(d.date || d.sourceKey).slice(-5)}</small>
                  </div>
                ))}
              </div>
              <div className="ad-table-wrap">
                <table className="ad-table">
                  <thead>
                    <tr>
                      <th>День</th>
                      <th>Расходы</th>
                      <th>Показы</th>
                      <th>Просмотры</th>
                      <th>Контакты</th>
                      <th>CTR</th>
                      <th>Цена контакта</th>
                    </tr>
                  </thead>
                  <tbody>
                    {valid.daily.map((d) => (
                      <tr key={d.sourceKey}>
                        <td>
                          {d.date ? date(d.date) : 'Дата не подтверждена'}
                        </td>
                        <td>{rub(d.metrics.spending)}</td>
                        <td>{number(d.metrics.impressions)}</td>
                        <td>{number(d.metrics.views)}</td>
                        <td>{number(d.metrics.contacts)}</td>
                        <td>{percent(d.rates.ctr)}</td>
                        <td>{money(d.rates.costContact)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {tab === 'changes' && (
            <>
              <h3>Обнаруженные изменения</h3>
              <p className="ad-help">
                Заголовки, цены, статусы, публикации, услуги и расписание
                поднятий — с момента подключения наблюдения. История каждой
                проверки доступна в карточке объявления. Здесь показаны
                последние 300 изменений.
              </p>
              <ol className="ad-timeline">
                {valid.events.map((e) => (
                  <li key={e.id}>
                    <strong>{stamp(e.observedAt)}</strong>
                    <button
                      type="button"
                      className="an-text-button"
                      onClick={() => {
                        setTab('items');
                        if (e.itemId) open(e.itemId);
                      }}
                    >
                      {valid.rows.find((r) => r.id === e.itemId)?.title ||
                        `Объявление №${e.itemId}`}
                    </button>
                    <p>{e.fields.map((f) => fieldLabel(f)).join(', ')}</p>
                    <small>
                      Предыдущая проверка: {stamp(e.previousObservedAt)}
                    </small>
                  </li>
                ))}
              </ol>
              {!valid.events.length && (
                <p className="an-empty">
                  После начала наблюдения изменения ещё не обнаружены. Первое
                  состояние уже сохраняется в карточках.
                </p>
              )}
            </>
          )}
          {tab === 'journal' && (
            <>
              <h3>Загрузки и сохранённые версии</h3>
              <p className="ad-help">
                Обновление дописывает новую версию. Предыдущие состояния
                остаются в истории; незавершённая страница не становится полным
                отчётом. Ниже — 20 последних загрузок и 100 пакетов данных.
              </p>
              {valid.jobs.map((j) => (
                <div className="ad-job-line" key={j.id}>
                  <strong>
                    {date(j.from)} — {date(j.to)}
                  </strong>
                  <span>
                    {j.state === 'done'
                      ? 'Готово'
                      : j.state === 'partial'
                        ? 'Частично'
                        : j.state === 'running'
                          ? 'Загружается'
                          : 'В очереди'}{' '}
                    · {j.done}/{j.total}
                    {j.failed ? ` · ошибок: ${j.failed}` : ''}
                  </span>
                  <small>{stamp(j.createdAt)}</small>
                </div>
              ))}
              <div className="ad-table-wrap">
                <table className="ad-table">
                  <thead>
                    <tr>
                      <th>Получено</th>
                      <th>Источник</th>
                      <th>Период</th>
                      <th>Версия</th>
                    </tr>
                  </thead>
                  <tbody>
                    {valid.history.map((h) => (
                      <tr key={h.id}>
                        <td>{stamp(h.loadedAt)}</td>
                        <td>{kinds[h.kind] || h.kind}</td>
                        <td>
                          {h.from
                            ? `${date(h.from)} — ${date(h.to)}`
                            : 'Текущее состояние'}
                        </td>
                        <td>
                          <code title={h.hash}>{h.hash.slice(0, 10)}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {tab === 'quality' && (
            <>
              <h3>Что известно и чего пока не хватает</h3>
              <ul className="ad-quality">
                <li>
                  {valid.reportedItems} объявлений со статистикой;{' '}
                  {valid.inventoryItems} в последнем полном списке.
                </li>
                <li>
                  {valid.coverage.withoutStats} объявлений без строки статистики
                  за период. Расходы и контакты для них неизвестны.
                </li>
                <li>
                  {valid.coverage.trafficItems} объявлений в дневном ответе;
                  пропущено {valid.coverage.trafficMissingDays} сочетаний
                  «объявление × день».
                </li>
                <li>
                  {valid.coverage.callsWithDays} объявлений с возвращёнными
                  днями звонков. Если дней нет, звонки не объявляются нулевыми.
                </li>
                {valid.limitations.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              {valid.failures.map((f, i) => (
                <p className="ad-help" key={f.jobId + f.kind + i}>
                  {kinds[f.kind] || f.kind}:{' '}
                  {f.code === 'rate_limit'
                    ? 'ожидание разрешённого запроса Авито'
                    : f.code === 'forbidden'
                      ? 'Авито не разрешил доступ'
                      : f.code === 'schema'
                        ? 'ответ требует проверки формата'
                        : 'загрузка не завершилась'}{' '}
                  ·{' '}
                  {f.state === 'queued'
                    ? `повтор после ${stamp(f.retryAt)}`
                    : 'см. журнал загрузок'}
                </p>
              ))}
            </>
          )}
          <p className="ad-footer">
            {valid.automatic
              ? `Текущий месяц и состояния объявлений проверяются каждые ${valid.intervalMinutes} минут. Другие периоды загружаются кнопкой обновления.`
              : 'Проверки запускаются вручную.'}{' '}
            История начинается с первой сохранённой проверки.
          </p>
        </>
      )}
    </section>
  );
}
