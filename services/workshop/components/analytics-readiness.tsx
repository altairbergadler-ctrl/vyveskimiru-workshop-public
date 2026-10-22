import { useEffect, useRef, useState } from 'react';
import type { LiveReport } from '../lib/analytics-live';

export async function analyticsRequest<T>(
  url: string,
  input?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    method: input === undefined ? 'GET' : 'POST',
    cache: 'no-store',
    headers: input === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(45000)])
      : AbortSignal.timeout(45000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? 'Требуется заново войти на сайт.'
        : data.error || 'Не удалось получить данные.',
    );
  return data;
}
export default function AnalyticsReadiness({
  report,
  reload,
}: {
  report: LiveReport;
  reload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const d = report.dailyItems,
    active = Boolean(d?.job && ['queued', 'running'].includes(d.job.state));
  async function run(action: 'load' | 'refresh' | 'cancel') {
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError('');
    try {
      await analyticsRequest(
        '/api/analytics/avito/deep/daily' +
          (action === 'cancel' ? '/cancel' : ''),
        action === 'cancel'
          ? { jobId: d?.job?.id }
          : {
              dateFrom: report.period.from,
              dateTo: report.period.to,
              ...(action === 'refresh' ? { refresh: true } : {}),
            },
        controller.signal,
      );
      if (!controller.signal.aborted) await reload();
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error ? e.message : 'Не удалось запустить загрузку.',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <details className="al-card ar-readiness">
      <summary>Полнота данных и оценка прибыли</summary>
      <p>
        Прибыль временно оценивается как{' '}
        <strong>50% суммы заказа до рекламы</strong>. Реклама вычитается один
        раз. Фактические платежи и себестоимость сохранены.
      </p>
      <dl className="ac-values">
        <div>
          <dt>Расходы за период</dt>
          <dd>
            {report.summary.spendComplete
              ? 'Полный сохранённый отчёт'
              : 'Данных недостаточно для полного результата'}
          </dd>
        </div>
        <div>
          <dt>Расходы объявлений по дням</dt>
          <dd>
            {d ? `${d.completeDays} из ${d.expectedDays} дней` : 'Не загружены'}
          </dd>
        </div>
        <div>
          <dt>Связи с заказами</dt>
          <dd>
            {report.attribution
              ? `${report.attribution.links.length} подтверждены · ${report.attribution.pending.length} предложений`
              : 'Недоступны'}
          </dd>
        </div>
        <div>
          <dt>Первый ответ</dt>
          <dd>
            {report.responses
              ? report.responses.partial
                ? 'Охват ограничен'
                : 'Сбор завершён'
              : 'Нет данных'}
          </dd>
        </div>
      </dl>
      <p>
        Отсутствующий день или объявление не считается нулём. Часовой пояс
        исходной статистики Авито не подтверждён. Поздние пересчёты проверяются
        обновлением дней.
      </p>
      {active ? (
        <div>
          <output>
            Дни загружаются: {d?.job?.done} из {d?.job?.total}. Можно закрыть
            страницу — очередь продолжит работу.
          </output>
          <button disabled={busy} onClick={() => void run('cancel')}>
            Остановить загрузку дней
          </button>
        </div>
      ) : (
        <div className="ar-actions">
          <button
            disabled={busy || !report.avito.enabled}
            onClick={() => void run('load')}
          >
            Загрузить недостающие дни
          </button>
          <button
            disabled={busy || !report.avito.enabled}
            onClick={() => void run('refresh')}
          >
            Обновить все дни
          </button>
        </div>
      )}
      {d?.job?.state === 'partial' && (
        <p>
          Часть запросов не завершилась. Повтор загрузки использует уже
          сохранённые дни.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
