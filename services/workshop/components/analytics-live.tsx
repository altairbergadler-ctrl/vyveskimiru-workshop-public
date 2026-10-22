import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, RefreshCw } from 'lucide-react';
import type { LiveReport } from '../lib/analytics-live';
import AnalyticsWorkspace from './analytics-workspace';
import AnalyticsReadiness from './analytics-readiness';
import './analytics-live.css';
import './analytics-workspace.css';
import './analytics-readiness.css';

const count = (n: number | null | undefined, digits = 0) =>
  n == null
    ? '—'
    : n.toLocaleString('ru-RU', { maximumFractionDigits: digits });
const money = (n: number | null | undefined) =>
  n == null ? '—' : `${count(n, 0)} ₽`;
const stamp = (s: string | null) =>
  s
    ? new Date(s).toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'ещё не загружено';
const today = () => new Date().toISOString().slice(0, 10);
export default function AnalyticsLive({
  onBack,
}: { onBack?: () => void } = {}) {
  const [dateBounds] = useState(() => ({
    today: today(),
    earliest: new Date(Date.now() - 269 * 86400000).toISOString().slice(0, 10),
  }));
  const [period, setPeriod] = useState({
    from: `${dateBounds.today.slice(0, 7)}-01`,
    to: dateBounds.today,
  });
  const [draft, setDraft] = useState(period),
    [report, setReport] = useState<LiveReport | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [locked, setLocked] = useState(false),
    [pin, setPin] = useState(''),
    [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false);
  const sequence = useRef(0),
    controller = useRef<AbortController | null>(null);
  // A failed or delayed import must not be resubmitted on every polling GET.
  const requestedPeriods = useRef(new Set<string>());
  const cancelLoad = useCallback(() => {
    sequence.current++;
    controller.current?.abort();
  }, []);
  const load = useCallback(
    async (force = false) => {
      const seq = ++sequence.current;
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      setLoading(true);
      setError('');
      try {
        const params = new URLSearchParams({
          ...period,
          ...(force ? { refresh: '1' } : {}),
        });
        const r = await fetch(`/api/analytics/live?${params}`, {
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(45_000)]),
          cache: 'no-store',
        });
        if (r.status === 401) {
          setLocked(true);
          setReport(null);
          return;
        }
        const data: LiveReport & { error?: string } = await r.json();
        if (!r.ok)
          throw new Error(data.error || 'Не удалось загрузить данные.');
        if (seq === sequence.current) {
          setReport(data);
          setLocked(false);
          const key = `${period.from}:${period.to}`;
          if (data.avito.enabled && !data.avito.loadedAt &&
              !data.avito.jobs.length && !requestedPeriods.current.has(key)) {
            requestedPeriods.current.add(key);
            const started = await fetch('/api/analytics/avito/deep', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ dateFrom: period.from, dateTo: period.to }),
              signal: AbortSignal.any([abort.signal, AbortSignal.timeout(45_000)]),
            });
            if (seq !== sequence.current) return;
            if (started.status === 401) {
              setLocked(true);
              setReport(null);
              return;
            }
            const result = await started.json();
            if (seq !== sequence.current) return;
            if (!started.ok) throw new Error(result.error || 'Не удалось запустить загрузку Авито. Нажмите «Обновить данные», чтобы повторить.');
            setReport({ ...data, avito: { ...data.avito,
              jobs: [{ state: 'queued', done: 0, total: 0, failed: 0 }],
            } });
          }
        }
      } catch (e) {
        if (seq === sequence.current && !abort.signal.aborted)
          setError(
            e instanceof Error && e.name === 'TimeoutError'
              ? 'Загрузка аналитики заняла слишком много времени. Повторите попытку.'
              : e instanceof Error
                ? e.message
                : 'Ошибка загрузки.',
          );
      } finally {
        if (seq === sequence.current) setLoading(false);
      }
    },
    [period],
  );
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => {
      clearTimeout(timer);
      cancelLoad();
    };
  }, [load, cancelLoad]);
  const busyImport = report?.avito.jobs.some((j) =>
    ['queued', 'running'].includes(j.state),
  );
  const busyDaily = report?.dailyItems?.job && ['queued','running'].includes(report.dailyItems.job.state);
  useEffect(() => {
    if (locked || saving) return;
    const timer = setInterval(
      () => {
        if (document.visibilityState === 'visible') void load();
      },
      busyImport || busyDaily ? 15000 : 60000,
    );
    return () => clearInterval(timer);
  }, [load, locked, saving, busyImport, busyDaily]);
  async function login(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const r = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setPin('');
      setLocked(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось войти.');
    } finally {
      setSaving(false);
    }
  }
  async function refresh() {
    setSaving(true);
    setNotice('');
    setError('');
    requestedPeriods.current.add(`${period.from}:${period.to}`);
    try {
      const r = await fetch('/api/analytics/avito/deep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dateFrom: period.from, dateTo: period.to }),
        signal: AbortSignal.timeout(45_000),
      });
      const data = await r.json();
      if (r.status === 401) {
        setLocked(true);
        setReport(null);
        return;
      }
      if (!r.ok) throw new Error(data.error || 'Не удалось обновить Авито.');
      await load(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось обновить.');
    } finally {
      setSaving(false);
    }
  }
  async function save(
    kind: 'ad' | 'order',
    entityId: string,
    productId: string,
    expectedRevision: number,
  ) {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const r = await fetch('/api/analytics/live/links', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind,
          entityId,
          productId: productId || null,
          expectedRevision,
        }),
      });
      const data = await r.json();
      if (r.status === 401) {
        setLocked(true);
        setReport(null);
        return;
      }
      if (!r.ok) throw new Error(data.error || 'Не удалось сохранить связь.');
      setNotice('Категория сохранена. Распределение пересчитано.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить.');
    } finally {
      setSaving(false);
    }
  }
  const serviceName = (id: string) => {
    const p = report?.products.find((p) => p.id === id);
    return p
      ? `${p.name}${report!.products.filter((v) => v.name === p.name).length > 1 ? ` · маршрут ${report!.products.filter((v) => v.name === p.name).findIndex((v) => v.id === id) + 1}` : ''}`
      : '';
  };
  function serviceSelect(
    kind: 'ad' | 'order',
    row: {
      id: string;
      title: string;
      productId: string | null;
      mapping: { revision: number } | null;
    },
  ) {
    const automation =
      kind === 'ad' ? report?.adServiceAutomation : report?.serviceAutomation;
    const autoAssigned =
      kind === 'ad'
        ? report?.adServiceAutomation?.assignments.some(
            (a) =>
              a.adId === row.id &&
              a.productId === row.productId &&
              a.revision === row.mapping?.revision,
          )
        : report?.serviceAutomation?.assignments.some(
            (a) =>
              a.orderId === row.id &&
              a.productId === row.productId &&
              a.revision === row.mapping?.revision,
          );
    const unresolved =
      !row.productId && !row.mapping
        ? automation?.unresolved?.find((a) => a.entityId === row.id)
        : null;
    const reasons: Record<string, string> = {
      mixed: 'Товары из разных категорий — выберите вручную',
      ambiguous: 'Подходят несколько категорий — выберите вручную',
      insufficient: 'Недостаточно описания для автоподбора',
      no_match: 'В справочнике нет подходящей категории',
    };
    return (
      <>
        <select
          aria-label={`Категория: ${row.title}`}
          value={row.productId || ''}
          disabled={saving || loading || !report?.products.length}
          onChange={(e) =>
            void save(kind, row.id, e.target.value, row.mapping?.revision ?? 0)
          }
        >
          <option value="">Выберите категорию</option>
          {report?.products.map((p) => (
            <option key={p.id} value={p.id}>
              {serviceName(p.id)}
            </option>
          ))}
        </select>
        {autoAssigned && (
          <small style={{ display: 'block' }}>
            Подобрано автоматически · можно изменить
          </small>
        )}
        {unresolved && (
          <small style={{ display: 'block' }}>
            {reasons[unresolved.reason] || 'Выберите категорию вручную'}
          </small>
        )}
      </>
    );
  }
  async function decide(id: string, action: 'confirm' | 'reject' | 'unlink') {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/analytics/live/attribution', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      });
      if (response.status === 401) {
        setLocked(true);
        setReport(null);
        return;
      }
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || 'Не удалось сохранить связь.');
      await load();
      setNotice('Связь обновлена.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка сохранения.');
    } finally {
      setSaving(false);
    }
  }
  const stale =
    report?.sources.some((s) => s.state !== 'ready') || report?.avito.stale;
  return (
    <div className="analytics-live">
      <div className="al-shell">
        <header className="al-header">
          <a
            href="/"
            className="al-back"
            onClick={
              onBack
                ? (e) => {
                    e.preventDefault();
                    onBack();
                  }
                : undefined
            }
          >
            <ArrowLeft size={17} /> Мастерская
          </a>
          <span className="al-pill">Авито · живые данные</span>
        </header>
        <div className="al-heading">
          <h1>
            Аналитика <small>Авито</small>
          </h1>
        </div>
        {locked ? (
          <section className="al-card al-login">
            <h2>Вход в Мастерскую</h2>
            <p>Используйте обычный PIN сайта.</p>
            <form onSubmit={(e) => void login(e)}>
              <label>
                PIN-код
                <input
                  type="password"
                  inputMode="numeric"
                  autoComplete="current-password"
                  maxLength={4}
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                />
              </label>
              <button
                className="al-primary"
                disabled={saving || pin.length !== 4}
              >
                Войти
              </button>
            </form>
            {error && <p role="alert">{error}</p>}
          </section>
        ) : (
          <>
            <div className="al-toolbar">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  cancelLoad();
                  setReport(null);
                  setPeriod({ ...draft });
                  setNotice('');
                }}
              >
                <label>
                  С
                  <input
                    type="date"
                    aria-label="Начало периода"
                    value={draft.from}
                    max={draft.to}
                    min={dateBounds.earliest}
                    onChange={(e) =>
                      setDraft({ ...draft, from: e.target.value })
                    }
                    required
                  />
                </label>
                <label>
                  По
                  <input
                    type="date"
                    aria-label="Конец периода"
                    value={draft.to}
                    min={draft.from}
                    max={dateBounds.today}
                    onChange={(e) => setDraft({ ...draft, to: e.target.value })}
                    required
                  />
                </label>
                <button disabled={saving || loading}>Показать</button>
              </form>
              <button
                onClick={() => void refresh()}
                disabled={saving || loading || busyImport}
              >
                <RefreshCw size={15} className={loading || busyImport ? 'al-spin' : ''} />
                {busyImport ? 'Авито обновляется…' : 'Обновить данные'}
              </button>
            </div>
            {error && (
              <div className="al-message al-error" role="alert">
                {error}
                <button onClick={() => void load(true)}>
                  Повторить загрузку
                </button>
              </div>
            )}
            {notice && (
              <output className="al-message">
                <Check size={16} />
                {notice}
              </output>
            )}
            {!report ? (
              <section className="al-card al-empty">
                {loading
                  ? 'Загружаем Авито и таблицу…'
                  : 'Данные пока не загружены.'}
              </section>
            ) : (
              <>
                <div className="al-fresh">
                  <span className={`al-dot ${stale ? 'warning' : ''}`} />
                  <span>
                    Авито: {stamp(report.avito.loadedAt)} · Таблица:{' '}
                    {stamp(
                      report.sources.find((s) => s.label === 'Заказы и клиенты')
                        ?.loadedAt ?? null,
                    )}
                  </span>
                  <span>
                    {report.avito.reported} из {report.avito.inventory}{' '}
                    объявлений со статистикой
                  </span>
                </div>
                <AnalyticsReadiness key={`${period.from}:${period.to}`} report={report} reload={()=>load()} />
                {busyImport ? (
                  <output className="al-message">
                    Загружаем статистику Авито за выбранный период.
                    {report.avito.jobs[0].total > 0 &&
                      ` Выполнено ${Math.floor(report.avito.jobs[0].done / report.avito.jobs[0].total * 100)}%.`}
                    {' '}Загрузка может занять несколько минут. Данные появятся автоматически.
                  </output>
                ) : report.avito.jobs[0]?.state === 'partial' ? (
                  <output className="al-message al-warning">
                    Не все данные Авито удалось загрузить. Нажмите «Обновить данные», чтобы повторить.
                  </output>
                ) : (stale || !report.avito.loadedAt) && (
                  <p className="al-message al-warning">
                    {!report.avito.loadedAt
                      ? loading
                        ? 'Подготавливаем загрузку статистики Авито за выбранный период…'
                        : 'Статистика Авито за этот период ещё не загружена. Нажмите «Обновить данные».'
                      : 'Часть данных не обновилась. Ниже показан последний доступный снимок; проверьте время загрузки.'}
                  </p>
                )}
                <AnalyticsWorkspace
                  report={report}
                  serviceSelect={serviceSelect}
                  busy={saving || loading}
                  decide={decide}
                />
                <details className="al-card al-quality">
                  <summary>Полнота данных и правила расчёта</summary>
                  <ul>
                    <li>
                      Общие итоги канала — клиенты с источником «Авито». Строки объявлений — подтверждённые связи с заказами независимо от источника клиента.
                      Заказов с неизвестным источником за период:{' '}
                      {report.quality.unknownOrderSources}.
                    </li>
                    <li>
                      Поступления без определённого источника:{' '}
                      {money(report.quality.unknownPaymentSource)}. Они не
                      отнесены к Авито.
                    </li>
                    <li>
                      Клиентов Авито без корректной даты добавления:{' '}
                      {count(report.quality.missingClientDates)}. Они не входят
                      в число новых клиентов.
                    </li>
                    <li>
                      Объявлений без статистики периода:{' '}
                      {report.avito.withoutStats}. Отсутствующие значения
                      показаны прочерком.
                    </li>
                    <li>
                      ROMI = (оценочная прибыль заказов − расходы Авито) / расходы
                      Авито × 100%. Поступления на рубль рекламы = полученные
                      деньги / расходы Авито. Это показатели одного периода, не
                      доказанная окупаемость конкретной кампании. При неполных
                      расходах итоговые прибыль, ROMI и поступления на рубль рекламы
                      не рассчитываются. Прибыль временно оценивается как 50% суммы заказа до рекламы. Это не фактическая прибыль; платежи и себестоимость не изменены.
                    </li>
                    <li>
                      Категория служит для группировки и не распределяет деньги
                      между объявлениями. Заказы, поступления, прибыль и ROMI
                      объявления учитывают только подтверждённые связи.
                      Новые предложения ночного агента ждут подтверждения.
                    </li>
                    <li>
                      Даты таблицы — бизнес-даты. Часовой пояс отчётов кабинета
                      Авито отдельно не подтверждён. Воронки Авито и новых
                      клиентов показываются отдельно.
                    </li>
                    {report.quality.issues.map((i, index) => (
                      <li key={index}>{i.message}</li>
                    ))}
                  </ul>
                </details>
              </>
            )}
          </>
        )}
        <footer className="al-footer">
          Мастерская · Авито и Google Таблица{' '}
          <a
            href="/"
            onClick={
              onBack
                ? (e) => {
                    e.preventDefault();
                    onBack();
                  }
                : undefined
            }
          >
            К главной
          </a>
        </footer>
      </div>
    </div>
  );
}
