import { useEffect, useRef, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { analyticsDate, analyticsMoney } from '@/lib/analytics';

type Period = { dateFrom: string; dateTo: string };
type Report = Period & {
  loadedAt: string;
  sourceTimestamp: string;
  importId: string;
  payloadHash: string;
  metricVersion: string;
  groups: { metrics: Record<string, number | null> }[];
};
type View = {
  enabled: boolean;
  automatic: boolean;
  busy: boolean;
  state: string;
  report: Report | null;
  defaultPeriod: Period;
  earliestDate: string;
  lastAttempt: { at: string; code: string | null } | null;
  retryAfterSeconds: number;
};
const labels: [string, string, boolean][] = [
  ['impressions', 'Показы', false],
  ['views', 'Просмотры', false],
  ['contacts', 'Контакты Авито', false],
  ['spending', 'Расходы деньгами', true],
  ['contactsShowPhone', 'Посмотрели телефон', false],
  ['contactsMessenger', 'Написали в чат', false],
  ['favorites', 'В избранное', false],
  ['presenceSpending', 'Размещение и целевые действия', true],
  ['promoSpending', 'Продвижение', true],
  ['allSpending', 'Всего с бонусами', true],
  ['spendingBonus', 'Списано бонусов · единицы Авито', false],
];
const stamp = (value: string) =>
  new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
const initialPeriod = (): Period => {
  const dateTo = new Date().toISOString().slice(0, 10);
  return { dateFrom: dateTo.slice(0, 8) + '01', dateTo };
};
export function AnalyticsAvito() {
  const [period, setPeriod] = useState(initialPeriod);
  const [draft, setDraft] = useState(initialPeriod);
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [version, setVersion] = useState(0);
  const [retryAt, setRetryAt] = useState(0);
  const [clock, setClock] = useState(Date.now);
  const seconds = Math.max(0, Math.ceil((retryAt - clock) / 1000));
  const serial = useRef(0);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController(),
      id = ++serial.current;
    operation.current?.abort();
    operation.current = controller;
    void fetch('/api/analytics/avito?' + new URLSearchParams(period), {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok)
          throw new Error(value.error || 'Не удалось получить отчёт Авито.');
        if (serial.current === id) {
          setView(value);
          setRetryAt(Date.now() + value.retryAfterSeconds * 1000);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted && serial.current === id)
          setError(e.message);
      })
      .finally(() => {
        if (serial.current === id) setBusy(false);
      });
    return () => controller.abort();
  }, [period, version]);
  const refresh = async () => {
    const id = ++serial.current,
      controller = operation.current;
    if (!controller || controller.signal.aborted) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/analytics/avito', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(period),
      });
      const value = await response.json();
      if (serial.current !== id) return;
      if (value.retryAfterSeconds)
        setRetryAt(Date.now() + value.retryAfterSeconds * 1000);
      if (!response.ok) {
        setView((old) =>
          old ? { ...old, state: old.report ? 'stale' : 'unavailable' } : old,
        );
        throw new Error(value.error || 'Не удалось обновить Авито.');
      }
      setView(value);
    } catch (e) {
      if (!controller.signal.aborted && serial.current === id)
        setError(e instanceof Error ? e.message : 'Не удалось обновить Авито.');
    } finally {
      if (serial.current === id) setBusy(false);
    }
  };
  const report = view?.report,
    metrics = report?.groups[0]?.metrics || {};
  const exportReport = () => {
    if (!report) return;
    const rows = [
      ['Авито', report.dateFrom, report.dateTo],
      ['Загружено', report.loadedAt],
      ['Версия', report.metricVersion],
      ['Загрузка', report.importId],
      ['Контрольная сумма', report.payloadHash],
      [
        'Ограничение',
        'Контакты Авито не являются заявками мастерской. Налоговая база не определена.',
      ],
      ['Показатель', 'Значение', 'Единица'],
      ...labels.map(([key, label, money]) => [
        label,
        metrics[key] == null ? '' : money ? metrics[key]! / 100 : metrics[key]!,
        money
          ? 'RUB'
          : key === 'spendingBonus'
            ? 'единицы Авито'
            : 'количество',
      ]),
    ];
    const csv =
      '\uFEFF' +
      rows
        .map((row) =>
          row.map((v) => '"' + String(v).replaceAll('"', '""') + '"').join(';'),
        )
        .join('\r\n');
    const url = URL.createObjectURL(
      new Blob([csv], { type: 'text/csv;charset=utf-8' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `avito-${report.dateFrom}-${report.dateTo}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section
      className="an-panel an-avito"
      id="avito-report"
      aria-label="Отчёт Авито"
    >
      <div className="an-panel-head">
        <div>
          <h2>Авито · свой кабинет</h2>
          <p>Просмотры, контакты и расходы по данным Авито.</p>
        </div>
        <span className="an-avito-state">
          {busy
            ? 'Загрузка…'
            : !view?.enabled
              ? 'Не подключён'
              : view.state === 'ready'
                ? 'Данные получены'
                : report
                  ? 'Сохранённый отчёт'
                  : 'Ожидает загрузки'}
        </span>
      </div>
      <p className="an-explainer">
        Свой период Авито — до 31 дня. Верхний фильтр относится к отчётам
        мастерской. Конечная дата ограничена текущим днём UTC; часовой пояс
        отчёта кабинета ещё не подтверждён.
      </p>
      <form
        className="an-avito-form"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          setView(null);
          setPeriod({ ...draft });
        }}
      >
        <label>
          С{' '}
          <input
            aria-label="Авито: начало периода"
            type="date"
            required
            value={draft.dateFrom}
            min={view?.earliestDate}
            max={view?.defaultPeriod.dateTo}
            onChange={(e) => setDraft({ ...draft, dateFrom: e.target.value })}
          />
        </label>
        <label>
          По{' '}
          <input
            aria-label="Авито: конец периода"
            type="date"
            required
            value={draft.dateTo}
            min={draft.dateFrom}
            max={view?.defaultPeriod.dateTo}
            onChange={(e) => setDraft({ ...draft, dateTo: e.target.value })}
          />
        </label>
        <Button type="submit" variant="outline">
          Показать Авито
        </Button>
        <Button
          type="button"
          disabled={busy || !view?.enabled || seconds > 0}
          onClick={() => void refresh()}
        >
          <RefreshCw size={15} />
          {seconds > 0 ? `Обновление через ${seconds} с` : 'Загрузить из Авито'}
        </Button>
      </form>
      {error && (
        <div className="an-error" role="alert">
          <p>{error}</p>
          <button
            type="button"
            className="an-text-button"
            onClick={() => {
              setBusy(true);
              setError('');
              setView(null);
              setVersion((v) => v + 1);
            }}
          >
            Повторить чтение
          </button>
        </div>
      )}
      {view?.lastAttempt?.code && !error && (
        <output className="an-explainer">
          Последняя загрузка не завершилась.{' '}
          {report
            ? 'Показаны ранее сохранённые данные.'
            : 'Показатели пока недоступны.'}
        </output>
      )}
      {report && (
        <>
          <div className="an-avito-meta">
            <strong>
              {analyticsDate(report.dateFrom)} — {analyticsDate(report.dateTo)}
            </strong>
            <span>Получено {stamp(report.loadedAt)} МСК</span>
            <button
              type="button"
              className="an-text-button"
              onClick={exportReport}
            >
              <Download size={14} /> CSV Авито
            </button>
          </div>
          {view?.state === 'stale' && (
            <p className="an-explainer">
              Отчёт требует обновления. Дата последней успешной загрузки указана
              выше.
            </p>
          )}
          <div className="an-avito-metrics">
            {labels.map(([key, label, money]) => (
              <div key={key} data-avito-metric={key}>
                <span>{label}</span>
                <strong>
                  {metrics[key] == null
                    ? '—'
                    : money
                      ? analyticsMoney(metrics[key]! / 100)
                      : metrics[key]!.toLocaleString('ru-RU')}
                </strong>
                {metrics[key] == null && (
                  <small>Авито не вернул показатель</small>
                )}
              </div>
            ))}
          </div>
          <details>
            <summary>Как читать эти показатели</summary>
            <p>
              Контакты — действия по правилам Авито: просмотр телефона,
              сообщение и другие обращения. Один человек может учитываться в
              разные дни. Телефон и чат пересекаются, их нельзя складывать.
            </p>
            <p>
              Расходы деньгами, бонусы и общий расход показаны отдельно. Расходы
              кабинета не прибавляются к оплатам рекламы в Google. Единица
              бонусов сохранена как в ответе Авито, без пересчёта в рубли;
              налоговая база не определена. ROMI и стоимость заявки мастерской
              появятся после связи обращений с заказами.
            </p>
            <p>
              В отчёте сохранены исходные числовые показатели и дата получения;
              Авито может уточнять прошлые значения. CSV относится только к
              этому отчёту.
            </p>
          </details>
        </>
      )}
      {!report && !busy && !error && (
        <p className="an-empty">
          {view?.enabled
            ? 'За выбранный период ещё нет сохранённой загрузки. Нажмите «Загрузить из Авито».'
            : 'Подключение Авито на сервере ещё не включено.'}
        </p>
      )}
      <p className="an-explainer">
        {view?.automatic
          ? 'Текущий месяц обновляется автоматически каждые 6 часов. Прошлые периоды можно загрузить вручную.'
          : 'Обновление выполняется вручную.'}{' '}
        История успешных загрузок сохраняется.
      </p>
    </section>
  );
}
