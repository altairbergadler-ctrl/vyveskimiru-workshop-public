import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  analyticsMoney as money,
  analyticsDate as date,
} from '@/lib/analytics';
import {
  inquiryCsv,
  type InquiryReport,
  type InquiryOrder,
  type InquiryCandidate,
} from '@/lib/inquiries';
import './inquiry-matching.css';
const labels = {
  strong: 'Сильное совпадение',
  possible: 'Возможная связь',
  weak: 'Слабое предположение',
};
const stamp = (v: string | null | undefined) =>
  v
    ? new Date(v).toLocaleString('ru-RU', {
        timeZone: 'Europe/Moscow',
        dateStyle: 'short',
        timeStyle: 'short',
      })
    : 'Ещё не получены';
function OrderLink({ row }: { row: Pick<InquiryOrder, 'id' | 'title'> }) {
  return (
    <a
      className="an-link"
      href={'/kanban/?order=' + encodeURIComponent(row.id)}
    >
      № {row.id} · {row.title}
    </a>
  );
}
function Evidence({ candidate: c }: { candidate: InquiryCandidate }) {
  return (
    <article className={'im-candidate im-' + c.level}>
      <div className="im-line">
        <strong>{c.person}</strong>
        <span className="im-badge">{labels[c.level]} · не подтверждено</span>
      </div>
      <p>
        {c.itemTitle} <small>№ {c.itemId}</small>
      </p>
      <ul>
        {c.reasons.map((r) => (
          <li key={r.code}>{r.label}</li>
        ))}
      </ul>
      <small>
        Диалог создан: {stamp(c.createdAt)} · Сообщения получены:{' '}
        {stamp(c.signalsAt)}
      </small>
      {(c.messagesLimited || c.messagesMissing || c.signalsStale) && (
        <p className="im-warning">
          {c.messagesMissing ? 'Сообщения ещё не загружены. ' : ''}
          {c.messagesLimited
            ? 'Доступна только последняя часть переписки. '
            : ''}
          {c.signalsStale ? 'После чтения сообщений диалог обновился. ' : ''}
        </p>
      )}
    </article>
  );
}
export function InquiryMatching({
  period,
}: {
  period: { from: string; to: string };
}) {
  const [mode, setMode] = useState('all'),
    [windowDays, setWindow] = useState('90'),
    [report, setReport] = useState<InquiryReport | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [starting, setStarting] = useState(false);
  const [tab, setTab] = useState('orders'),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all'),
    [page, setPage] = useState(1),
    [opened, setOpened] = useState<string | null>(null),
    [dialogQuery, setDialogQuery] = useState('');
  const generation = useRef(0),
    controller = useRef<AbortController | null>(null);
  const params = new URLSearchParams({
    ...period,
    window: windowDays,
    mode,
  }).toString();
  const valid =
    report?.period.from === period.from &&
    report.period.to === period.to &&
    report.mode === mode &&
    String(report.windowDays) === windowDays
      ? report
      : null;
  const refreshRef = useRef<(force?: boolean) => Promise<void>>(async () => {});
  useEffect(() => {
    let disposed = false;
    async function load(force = false) {
      const id = ++generation.current;
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      setLoading(true);
      try {
        const response = await fetch(
          '/api/analytics/inquiries?' + params + (force ? '&refresh=1' : ''),
          { cache: 'no-store', signal: abort.signal },
        );
        const value = await response.json();
        if (!response.ok)
          throw new Error(value.error || 'Не удалось сопоставить обращения.');
        if (!disposed && id === generation.current) {
          setReport(value);
          setError('');
        }
      } catch (e) {
        if (!disposed && id === generation.current && !abort.signal.aborted)
          setError(
            e instanceof Error ? e.message : 'Не удалось получить данные.',
          );
      } finally {
        if (!disposed && id === generation.current) setLoading(false);
      }
    }
    refreshRef.current = load;
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => {
      disposed = true;
      clearInterval(timer);
      controller.current?.abort();
    };
  }, [params]);
  async function importChats() {
    setStarting(true);
    setError('');
    try {
      const r = await fetch('/api/analytics/inquiries/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const v = await r.json();
      if (!r.ok) throw new Error(v.error || 'Не удалось запустить загрузку.');
      await refreshRef.current();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Не удалось запустить загрузку.',
      );
    } finally {
      setStarting(false);
    }
  }
  const rows = useMemo(
    () =>
      valid?.rows.filter(
        (r) =>
          (filter === 'all' ||
            filter === r.state ||
            (filter === 'ambiguous' && r.ambiguous)) &&
          [
            r.id,
            r.title,
            r.client,
            r.manualSource,
            ...r.candidates.map((c) => c.person),
          ]
            .join(' ')
            .toLowerCase()
            .includes(query.toLowerCase()),
      ) || [],
    [valid, filter, query],
  );
  const safePage = Math.min(page, Math.max(1, Math.ceil(rows.length / 20))),
    selected = valid?.rows.find((r) => r.id === opened);
  const active = valid?.source.jobs.find((j) =>
    ['queued', 'running'].includes(j.state),
  );
  const exportCsv = () => {
    if (!valid) return;
    const url = URL.createObjectURL(
      new Blob([inquiryCsv(valid, rows)], { type: 'text/csv;charset=utf-8' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download =
      'Предварительные-связи-' + period.from + '-' + period.to + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section
      className="an-panel im-root"
      aria-label="Связи обращений с заказами"
    >
      <div className="an-panel-head">
        <div>
          <span className="an-eyebrow">Предварительная сквозная аналитика</span>
          <h2>Обращения и заказы</h2>
          <p>
            Находим возможные связи по перепискам Авито и данным заказов. Каждая
            связь требует проверки.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={
            starting || Boolean(active) || valid?.source.enabled === false
          }
          onClick={() => void importChats()}
        >
          {active
            ? 'Загрузка диалогов продолжается'
            : starting
              ? 'Запускаем…'
              : 'Обновить обращения Авито'}
        </Button>
      </div>
      <div className="im-toolbar">
        <label>
          Какие связи учитывать
          <select
            aria-label="Уровень предварительных связей"
            value={mode}
            onChange={(e) => {
              setMode(e.target.value);
              setPage(1);
            }}
          >
            <option value="all">Включая слабые предположения</option>
            <option value="possible">Возможные и сильные</option>
            <option value="strong">Только сильные совпадения</option>
          </select>
        </label>
        <label>
          Обращение до заказа
          <select
            aria-label="Окно поиска обращений"
            value={windowDays}
            onChange={(e) => setWindow(e.target.value)}
          >
            <option value="14">До 14 дней</option>
            <option value="30">До 30 дней</option>
            <option value="90">До 90 дней</option>
          </select>
        </label>
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => void refreshRef.current(true)}
        >
          Перечитать заказы
        </Button>
      </div>
      <p className="im-help">
        Период сверху выбирает заказы по дате создания. Переписки ищем в
        выбранном окне до заказа и до 14 дней после него; позднее сообщение
        может быть сопровождением.
      </p>
      {error && (
        <p className="an-error" role="alert">
          {error}
          {valid ? ' Показан предыдущий результат с его временем.' : ''}
        </p>
      )}
      {!valid && (
        <p className="an-empty">
          {loading
            ? 'Сопоставляем обращения и заказы…'
            : 'Отчёт недоступен для выбранных условий.'}
        </p>
      )}
      {valid && (
        <>
          <p className="im-warning">
            <strong>Это оценка, не подтверждённая атрибуция.</strong> Суммы ниже
            относятся к заказам с выбранным кандидатом. Они не доказывают
            выручку от объявления и не используются для расчёта окупаемости.
          </p>
          <div className="im-line im-help">
            <span>
              Заказы: {stamp(valid.ordersLoadedAt)} МСК
              {valid.ordersStale ? ' · чтение не обновилось' : ''}
            </span>
            <span>
              {valid.source.automatic
                ? 'Автозагрузка переписок: раз в 30 минут с учётом квот'
                : 'Автозагрузка выключена'}
            </span>
          </div>
          {active && (
            <output className="im-progress">
              <strong>
                Загрузка: {active.done} / {active.total}
              </strong>
              <progress value={active.done} max={Math.max(1, active.total)} />
              <small>Совпадения дополняются по мере чтения переписок.</small>
            </output>
          )}
          {!valid.source.enabled && (
            <p className="im-warning">
              Авито не подключён. Доступен только источник из карточки клиента.
            </p>
          )}
          <div className="im-kpis">
            {[
              ['Заказы за период', valid.summary.orders, 'Без отменённых'],
              [
                'Диалоги мастерской',
                valid.summary.dialogs,
                'Не равны отдельным заявкам или людям',
              ],
              [
                'Предварительно связаны',
                valid.summary.suggested,
                'По одному основному кандидату на заказ',
              ],
              [
                'Неоднозначные',
                valid.summary.ambiguous,
                'Близкие варианты исключены из сумм',
              ],
              [
                'Сумма выбранных заказов',
                money(valid.summary.suggestedAmount),
                'Оценка связи, не выручка объявления',
              ],
              [
                'Оплачено по этим заказам',
                money(valid.summary.suggestedPaid),
                'Накопленное значение из Google',
              ],
            ].map(([label, value, note]) => (
              <article key={String(label)}>
                <span>{label}</span>
                <strong>{value}</strong>
                <small>{note}</small>
              </article>
            ))}
          </div>
          <nav className="im-tabs" aria-label="Сопоставление обращений">
            {[
              ['orders', 'Заказы и кандидаты'],
              ['dialogs', 'Диалоги Авито'],
              ['advertising', 'По объявлениям'],
              ['quality', 'Основания и полнота'],
            ].map(([id, label]) => (
              <button
                key={id}
                aria-current={tab === id ? 'page' : undefined}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </nav>
          {tab === 'orders' && (
            <>
              <div className="im-toolbar">
                <input
                  aria-label="Поиск связей заказов"
                  placeholder="Заказ, клиент, собеседник"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPage(1);
                  }}
                />
                <select
                  aria-label="Состояние связи"
                  value={filter}
                  onChange={(e) => {
                    setFilter(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="all">Все заказы</option>
                  <option value="suggested">Есть основной кандидат</option>
                  <option value="review">Нужна проверка вариантов</option>
                  <option value="ambiguous">Неоднозначные</option>
                  <option value="source_only">Только источник клиента</option>
                  <option value="unknown">Связей не найдено</option>
                </select>
                <Button variant="outline" onClick={exportCsv}>
                  CSV выбранных заказов ({rows.length})
                </Button>
              </div>
              <p className="im-help">
                Фильтры списка не меняют сводку. Режим связи сверху меняет
                оценку. В CSV каждый заказ записывается один раз.
              </p>
              <div className="im-table-wrap">
                <table className="im-table">
                  <thead>
                    <tr>
                      <th>Заказ</th>
                      <th>Источник клиента</th>
                      <th>Основной кандидат</th>
                      <th>Сумма заказа</th>
                      <th>Проверка</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice((safePage - 1) * 20, safePage * 20).map((r) => (
                      <tr key={r.id}>
                        <td>
                          <OrderLink row={r} />
                          <small>
                            {r.client} · {date(r.createdDate || '')} ·{' '}
                            {r.status}
                          </small>
                        </td>
                        <td>{r.manualSource || 'Не указан'}</td>
                        <td>
                          {r.suggestedChatId ? (
                            <>
                              <strong>{r.candidates[0].person}</strong>
                              <small>{labels[r.candidates[0].level]}</small>
                              <small>{r.candidates[0].itemTitle}</small>
                            </>
                          ) : r.ambiguous ? (
                            'Несколько близких вариантов'
                          ) : r.candidates.length ? (
                            'Кандидаты ниже выбранного уровня'
                          ) : (
                            'Не найден'
                          )}
                          <small>
                            {r.status === 'Отменён'
                              ? 'Отменённый заказ исключён из сумм'
                              : ''}
                          </small>
                        </td>
                        <td>{money(r.amount)}</td>
                        <td>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setOpened(opened === r.id ? null : r.id)
                            }
                            aria-expanded={opened === r.id}
                          >
                            Кандидаты ({r.totalCandidates})
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!rows.length && (
                <p className="an-empty">Заказов по выбранным условиям нет.</p>
              )}
              <div className="im-line">
                <Button
                  variant="outline"
                  disabled={safePage <= 1}
                  onClick={() => setPage(safePage - 1)}
                >
                  Назад
                </Button>
                <span>
                  {safePage} / {Math.max(1, Math.ceil(rows.length / 20))}
                </span>
                <Button
                  variant="outline"
                  disabled={safePage * 20 >= rows.length}
                  onClick={() => setPage(safePage + 1)}
                >
                  Далее
                </Button>
              </div>
              {selected && (
                <section
                  className="im-detail"
                  aria-label="Кандидаты выбранного заказа"
                >
                  <div className="im-line">
                    <h3>Кандидаты для заказа № {selected.id}</h3>
                    <Button variant="ghost" onClick={() => setOpened(null)}>
                      Закрыть
                    </Button>
                  </div>
                  <OrderLink row={selected} />
                  <p>
                    Клиент: {selected.client}. Оплачено по заказу:{' '}
                    {money(selected.paid)}. Оценочная прибыль заказа:{' '}
                    {money(selected.profit)}.
                  </p>
                  {selected.ambiguous && (
                    <p className="im-warning">
                      Кандидаты близки по силе. Основная связь не выбрана, заказ
                      не включён в оценку денег.
                    </p>
                  )}
                  {selected.candidates.map((c) => (
                    <div key={c.chatId}>
                      <Evidence candidate={c} />
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setDialogQuery(c.chatId);
                          setTab('dialogs');
                        }}
                      >
                        Показать диалог
                      </Button>
                    </div>
                  ))}
                  {!selected.candidates.length && (
                    <p className="an-empty">
                      Недостаточно признаков для связи с конкретной перепиской.
                      Источник клиента: {selected.manualSource || 'не указан'}.
                    </p>
                  )}
                </section>
              )}
            </>
          )}
          {tab === 'dialogs' && (
            <>
              <div className="im-toolbar">
                <input
                  aria-label="Поиск диалогов Авито"
                  placeholder="Собеседник или объявление"
                  value={dialogQuery}
                  onChange={(e) => setDialogQuery(e.target.value)}
                />
                <Button variant="ghost" onClick={() => setDialogQuery('')}>
                  Все диалоги
                </Button>
                <a
                  className="an-link"
                  href="https://www.avito.ru/profile/messenger"
                  target="_blank"
                  rel="noreferrer"
                >
                  Открыть переписки в Авито ↗
                </a>
              </div>
              <p className="im-help">
                Показаны первые 100 подходящих диалогов. Поиск работает по всем
                загруженным. Переписки покупателя по чужим объявлениям
                исключены.
              </p>
              {valid.dialogs
                .filter((d) =>
                  [d.id, d.person, d.itemTitle]
                    .join(' ')
                    .toLowerCase()
                    .includes(dialogQuery.toLowerCase()),
                )
                .slice(0, 100)
                .map((d) => (
                  <article className="im-dialog" key={d.id}>
                    <strong>{d.person}</strong>
                    <p>
                      {d.itemTitle} · № {d.itemId}
                    </p>
                    <small>
                      Создан: {stamp(d.createdAt)} · Последнее обновление:{' '}
                      {stamp(d.updatedAt)}
                    </small>
                    <p>
                      Прочитано сообщений: {d.messagesRead ?? 'пока нет данных'}{' '}
                      · Входящих: {d.incomingObserved ?? 'неизвестно'}
                      {d.messagesLimited ? ' · история неполная' : ''}
                    </p>
                    <div className="im-line">
                      {d.possibleOrders.length ? (
                        d.possibleOrders.map((id) => (
                          <Button
                            variant="outline"
                            size="sm"
                            key={id}
                            onClick={() => {
                              setTab('orders');
                              setOpened(id);
                            }}
                          >
                            Возможный заказ № {id}
                          </Button>
                        ))
                      ) : (
                        <small>
                          Подходящих заказов в выбранном периоде не найдено.
                        </small>
                      )}
                    </div>
                  </article>
                ))}
            </>
          )}
          {tab === 'advertising' && (
            <>
              <h3>Оценка связей по объявлениям</h3>
              <p className="im-warning">
                Здесь только выбранные предварительные связи. Неоднозначные и
                отменённые заказы исключены; это не доказанная эффективность
                рекламы.
              </p>
              <div className="im-table-wrap">
                <table className="im-table">
                  <thead>
                    <tr>
                      <th>Объявление</th>
                      <th>Заказов-кандидатов</th>
                      <th>Сильных совпадений</th>
                      <th>Сумма заказов</th>
                      <th>Оплачено по заказам</th>
                      <th>Оценочная прибыль заказов</th>
                    </tr>
                  </thead>
                  <tbody>
                    {valid.byItem.map((r) => (
                      <tr key={r.itemId}>
                        <td>
                          {r.title}
                          <small>№ {r.itemId}</small>
                        </td>
                        <td>{r.orders}</td>
                        <td>{r.strong}</td>
                        <td>{money(r.amount)}</td>
                        <td>{money(r.paid)}</td>
                        <td>{money(r.profit)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!valid.byItem.length && (
                <p className="an-empty">
                  Нет однозначно выбранных кандидатов для этого режима.
                  Возможные варианты можно проверить в заказах.
                </p>
              )}
            </>
          )}
          {tab === 'quality' && (
            <>
              <h3>Что удалось прочитать</h3>
              <p>
                Диалогов: {valid.coverage.loadedDialogs}; с сообщениями:{' '}
                {valid.coverage.dialogsWithMessages}; с найденными входящими:{' '}
                {valid.coverage.dialogsWithIncoming}; с неполной историей:{' '}
                {valid.coverage.truncatedDialogs}; изменившихся после чтения:{' '}
                {valid.coverage.staleDialogs}.
              </p>
              <p>
                Заказов без даты: {valid.summary.ordersWithoutDate}. Они не
                включены в период. Сильных основных кандидатов:{' '}
                {valid.summary.strong}; только источник клиента:{' '}
                {valid.summary.sourceOnly}; без связи: {valid.summary.unknown}.
              </p>
              <p>
                До 100 последних сообщений на диалог, до 250 новых или
                изменившихся диалогов за проход. История ограничена доступным
                списком Авито и 270 днями активности.
              </p>
              <h3>Последние загрузки</h3>
              {valid.source.jobs.map((j) => (
                <div className="im-job" key={j.id}>
                  <strong>{stamp(j.createdAt)}</strong>
                  <span>
                    {j.state === 'done'
                      ? 'Готово'
                      : j.state === 'partial'
                        ? 'Неполная загрузка'
                        : j.state === 'running'
                          ? 'Загружается'
                          : 'В очереди'}{' '}
                    · {j.done}/{j.total} · ошибок {j.failed}
                    {j.limited ? ' · достигнут предел одного прохода' : ''}
                  </span>
                </div>
              ))}
              {!!valid.source.errors?.length && (
                <p className="im-warning">
                  В последней загрузке есть ограничения или ошибки. Последние
                  успешно полученные сведения сохранены; их время показано
                  отдельно.
                </p>
              )}
              <h3>Как читать результат</h3>
              <ul>
                {valid.limitations.map((v) => (
                  <li key={v}>{v}</li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
