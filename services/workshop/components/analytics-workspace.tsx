import { useRef, useState, type ReactNode } from 'react';
import type { LiveAd, LiveReport } from '../lib/analytics-live';
import { ratio } from '../lib/analytics-series';
import AnalyticsChart from './analytics-chart';
import AnalyticsAttribution from './analytics-attribution';
import AnalyticsMaterials from './analytics-materials';
import { responseTime } from '../lib/response-time';

type Order = LiveReport['orders'][number];
type Entity = 'ad' | 'order' | 'category';
const adColumns = [
  { key: 'title', label: 'Объявление', note: '' },
  { key: 'contacts', label: 'Контакты', note: '' },
  { key: 'confirmedOrders', label: 'Заказы', note: 'Подтверждённые' },
  { key: 'orderRate', label: 'Заказы / контакты', note: 'По подтверждённым связям' },
  { key: 'spend', label: 'Расходы', note: '' },
  { key: 'receipts', label: 'Поступило', note: 'По подтверждённым связям' },
  { key: 'result', label: 'Прибыль после рекламы', note: 'По подтверждённым заказам' },
  { key: 'firstResponseSeconds', label: 'Первый ответ', note: 'Среднее время' },
] as const;
type AdSort = typeof adColumns[number]['key'];
const number = (n: number | null | undefined, digits = 0) =>
  n == null
    ? '—'
    : n.toLocaleString('ru-RU', { maximumFractionDigits: digits });
const money = (n: number | null | undefined) =>
  n == null ? '—' : `${number(n)} ₽`;
const percent = (n: number | null) => (n == null ? '—' : `${number(n, 1)}%`);
const sumKnown = (values: (number | null)[]) =>
  !values.length || values.some(n => n == null)
    ? null
    : Math.round(values.reduce<number>((sum, n) => sum + n!, 0) * 100) / 100;
const tone = (n: number | null) =>
  n == null ? '' : n < 0 ? 'ac-negative' : 'ac-positive';
function Values({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="ac-values">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function AnalyticsWorkspace({
  report,
  serviceSelect,
  busy,
  decide,
}: {
  report: LiveReport;
  serviceSelect: (kind: 'ad' | 'order', row: LiveAd | Order) => ReactNode;
  busy: boolean;
  decide: (
    id: string,
    action: 'confirm' | 'reject' | 'unlink',
  ) => Promise<void>;
}) {
  const [tab, setTab] = useState('overview');
  const [selected, setSelected] = useState<{ kind: Entity; id: string } | null>(
    null,
  );
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [sort, setSort] = useState<AdSort>('spend');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  function sortBy(key: AdSort) {
    setDirection(key === sort ? (direction === 'asc' ? 'desc' : 'asc') : key === 'title' ? 'asc' : 'desc');
    setSort(key);
    setBatches(1);
  }
  const [batches, setBatches] = useState(1);
  const [detailOpen, setDetailOpen] = useState(false);
  const detailRef = useRef<HTMLElement>(null);
  const s = report.summary;
  const categories = report.products
    .map((p) => {
      const ads = report.rows.filter((a) => a.productId === p.id),
        orders = report.orders.filter((o) => o.productId === p.id);
      return {
        ...p,
        ads,
        orderRows: orders,
        reported: ads.filter((a) => a.spend != null).length,
        knownContacts: p.contacts,
      };
    })
    .sort((a, b) => (b.spend ?? -1) - (a.spend ?? -1));
  const ads = report.rows
    .filter(
      (a) =>
        (category === 'all' ||
          (category === 'unassigned'
            ? !a.productId
            : a.productId === category)) &&
        `${a.title} ${a.id}`
          .toLocaleLowerCase('ru')
          .includes(query.toLocaleLowerCase('ru')),
    )
    .sort((a, b) => {
      const left = a[sort], right = b[sort];
      // Unknown values stay last in both directions, including negative profit.
      if (left == null || right == null) {
        return left == null && right == null ? a.id.localeCompare(b.id) : left == null ? 1 : -1;
      }
      const comparison = typeof left === 'string' && typeof right === 'string'
        ? left.localeCompare(right, 'ru', { numeric: true })
        : Number(left) - Number(right);
      return comparison * (direction === 'asc' ? 1 : -1) || a.id.localeCompare(b.id);
    });
  const limit = tab === 'overview' ? 4 : 10,
    visibleCount = Math.min(batches * limit, ads.length);
  const active =
    selected ||
    ({ kind: 'ad', id: ads[0]?.id } as { kind: Entity; id: string });
  const ad =
    active.kind === 'ad'
      ? report.rows.find((a) => a.id === active.id)
      : undefined;
  const order =
    active.kind === 'order'
      ? report.orders.find((o) => o.id === active.id)
      : undefined;
  const cat =
    active.kind === 'category'
      ? categories.find((c) => c.id === active.id)
      : undefined;
  const links =
    report.attribution?.links.filter((link) =>
      ad ? link.itemId === ad.id : order ? link.orderId === order.id : false,
    ) || [];
  const fact = ad
    ? report.attribution?.facts.find((f) => f.itemId === ad.id)
    : undefined;
  function select(kind: Entity, id: string) {
    setSelected({ kind, id });
    setDetailOpen(true);
    if (window.innerWidth < 900)
      requestAnimationFrame(() =>
        detailRef.current?.scrollIntoView({
          block: 'nearest',
          behavior: 'smooth',
        }),
      );
  }
  function switchTab(id: string) {
    setTab(id);
    setBatches(1);
    setDetailOpen(false);
    if (id === 'categories' && categories[0])
      setSelected({ kind: 'category', id: categories[0].id });
    if (id === 'orders' && report.orders[0])
      setSelected({ kind: 'order', id: report.orders[0].id });
    if (id === 'ads') setSelected(null);
  }
  const categoryName = (id: string | null) =>
    report.products.find((p) => p.id === id)?.name || 'Без категории';
  function matching() {
    return (
      <>
        <h3>Подтверждённые связи</h3>
        {fact && (
          <Values
            rows={[
              ['Поступило за период', money(ad?.receipts)],
              ['Заказов за период', number(fact.orders)],
              [
                'Прибыль после рекламы',
                money(ad?.result),
              ],
            ]}
          />
        )}{' '}
        {links.map((link) => (
          <div className="ac-assignment" key={link.orderId}>
            <button
              className="ac-link"
              onClick={() => {
                if (ad) {
                  const o = report.orders.find((o) => o.id === link.orderId);
                  if (o) select('order', o.id);
                } else select('ad', link.itemId);
              }}
              disabled={
                !!ad && !report.orders.some((o) => o.id === link.orderId)
              }
            >
              {ad ? `Заказ № ${link.orderId}` : `Объявление № ${link.itemId}`}
            </button>
            {ad && !report.orders.some((o) => o.id === link.orderId) && (
              <small>Нет в списке заказов периода</small>
            )}
            <button
              className="ac-link"
              disabled={busy}
              onClick={() => void decide(link.suggestionId, 'unlink')}
            >
              Отменить связь
            </button>
          </div>
        ))}
        {!links.length && <small>Подтверждённых связей нет</small>}
        <button className="ac-link" onClick={() => switchTab('matching')}>
          Все сопоставления →
        </button>
      </>
    );
  }
  return (
    <div className="ac-workspace">
      <div className="ac-kpis">
        {[
          ['Поступило от клиентов', money(s.receipts), 'По датам платежей'],
          ['Расходы Авито', money(s.spend), s.spendComplete ? 'Полный отчёт за период' : 'Известная часть расходов'],
          [
            'Прибыль после рекламы',
            money(s.result),
            s.spendComplete ? 'По заказам канала; без накладных и налогов' : 'Нужен полный отчёт расходов за период',
          ],
          [
            'Поступления / 1 ₽ рекламы',
            s.roas == null ? '—' : `${number(s.roas, 2)} ₽`,
            `ROMI по прибыли: ${percent(s.romi)}`,
          ],
        ].map(([name, value, note]) => (
          <div key={name}>
            <small>{name}</small>
            <strong>{value}</strong>
            <small>{note}</small>
          </div>
        ))}
      </div>
      <p className="ac-scope">
        Общие итоги и график — весь канал Авито по источнику клиента.
        Таблица объявлений — только подтверждённые связи с заказами.
        Поступления канала без связи с объявлением: {money(s.unallocated)}.
      </p>
      <nav className="al-tabs" aria-label="Разделы аналитики">
        {[
          ['overview', 'Обзор'],
          ['ads', `Объявления · ${report.rows.length}`],
          ['categories', `Категории · ${categories.length}`],
          ['orders', `Заказы · ${report.orders.length}`],
          [
            'matching',
            `Сопоставления · ${report.attribution?.pending.length || 0} к проверке`,
          ],
        ].map(([id, label]) => (
          <button
            key={id}
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => switchTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {(tab === 'overview' || tab === 'ads') && report.responses && (
        <section className="ac-response-status" aria-label="Время первого ответа">
          <p><b>Первый ответ: {responseTime(report.responses.summary.averageSeconds)}</b>
            {' · '}{report.responses.summary.answered} диалогов с ответом · {report.responses.summary.waiting} без ответа</p>
          <p>Обновление в 09:00 и 18:00 МСК · {report.responses.state === 'failed' ? 'Проверка не удалась; показаны ранее полученные данные' : report.responses.state === 'running' ? 'Идёт обновление' : report.responses.loadedAt
            ? `Последняя проверка: ${new Date(report.responses.loadedAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} МСК`
            : 'Первая проверка ещё не завершена'}{!report.responses.enabled && ' · Автообновление выключено'}</p>
          {report.responses.partial && <p>Неполные данные: среднее по доступным диалогам.
            {report.responses.indexLimited && ' Достигнут предел обхода списка Авито.'}
            {report.responses.undated > 0 && ` Начало ${report.responses.undated} переписок недоступно.`}
            {report.responses.unverified > 0 && ` Не перепроверено: ${report.responses.unverified}.`}
            {report.responses.failed > 0 && ` Ошибок чтения: ${report.responses.failed}.`}
            {report.responses.stale && ' Ожидается свежая проверка.'}</p>}
          <details><summary>Как считается</summary><p>От первого сообщения клиента до первого ответа с нашей стороны,
            включая ночь и выходные. Диалог относится к дате первого обращения по Москве.
            Без ответа — отдельно, в среднее не входит. Системные сообщения и звонки исключены.
            Автоответы могут учитываться: отделить их от ответа человека пока нельзя.
            Отсутствие данных обозначается прочерком. Повторные сообщения не меняют первый ответ.</p></details>
        </section>
      )}
      {tab === 'overview' && <AnalyticsChart daily={report.daily} />}
      {tab === 'matching' ? (
        <AnalyticsAttribution report={report} busy={busy} decide={decide} />
      ) : (
        <div className="ac-layout">
          <div className="ac-tables">
            {(tab === 'overview' || tab === 'ads') && (
              <section>
                <div className="ac-section-head">
                  <h2>Эффективность объявлений</h2>
                  {tab === 'overview' && (
                    <button
                      className="ac-link"
                      onClick={() => switchTab('ads')}
                    >
                      Все {report.rows.length} →
                    </button>
                  )}
                </div>
                <div className="ac-tools">
                  <input
                    aria-label="Поиск объявления"
                    placeholder="Название или номер"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setBatches(1);
                    }}
                  />
                  <select
                    aria-label="Категория объявлений"
                    value={category}
                    onChange={(e) => {
                      setCategory(e.target.value);
                      setBatches(1);
                    }}
                  >
                    <option value="all">Все категории</option>
                    <option value="unassigned">Без категории</option>
                    {report.products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Сортировка объявлений"
                    value={`${sort}:${direction}`}
                    onChange={(e) => {
                      const [key, order] = e.target.value.split(':');
                      setSort(key as AdSort);
                      setDirection(order as 'asc' | 'desc');
                      setBatches(1);
                    }}
                  >
                    {adColumns.flatMap(({ key, label }) => ['desc', 'asc'].map(order => (
                      <option key={`${key}:${order}`} value={`${key}:${order}`}>
                        {label} {order === 'asc' ? '↑' : '↓'}
                      </option>
                    )))}
                  </select>
                </div>
                <div className="ac-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        {adColumns.map(({ key, label, note }) => (
                          <th key={key} scope="col" aria-sort={sort === key ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
                            <button type="button" className="ac-sort" onClick={() => sortBy(key)}>
                              {label} <span aria-hidden="true">{sort === key ? (direction === 'asc' ? '↑' : '↓') : '↕'}</span>
                              {note && <small>{note}</small>}
                            </button>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {ads.slice(0, visibleCount).map((a) => (
                        <tr
                          key={a.id}
                          className={ad?.id === a.id ? 'ac-selected' : ''}
                        >
                          <td>
                            <button
                              className="ac-row"
                              onClick={() => select('ad', a.id)}
                              aria-label={`Детали объявления ${a.id}`}
                            >
                              {a.title}
                            </button>
                            <small>
                              № {a.id} · {categoryName(a.productId)}
                            </small>
                          </td>
                          <td data-label="Контакты">{number(a.contacts)}</td>
                          <td data-label="Подтверждённые заказы">{number(a.confirmedOrders)}</td>
                          <td
                            data-label="Заказы / контакты"
                            title={
                              a.confirmedOrders == null
                                ? 'Данные подтверждённых заказов недоступны'
                                : a.confirmedOrders === 0
                                  ? 'Нет подтверждённых заказов за выбранный период. Сопоставление ещё может быть неполным.'
                                  : `Подтверждённых заказов за период: ${a.confirmedOrders}. Контактов: ${number(a.contacts)}.`
                            }
                          >
                            {percent(a.orderRate)}
                          </td>
                          <td data-label="Расходы">{money(a.spend)}</td>
                          <td data-label="Поступило">{money(a.receipts)}</td>
                          <td
                            data-label="Прибыль после рекламы"
                            className={tone(a.result)}
                            title={a.reason}
                          >
                            {money(a.result)}
                          </td>
                          <td data-label="Первый ответ" title={a.responseStats
                            ? `С ответом: ${a.responseStats.answered}; без ответа: ${a.responseStats.waiting}; начало недоступно: ${a.responseStats.unknown}`
                            : 'Нет диалогов с известным первым ответом за выбранный период'}>
                            {responseTime(a.firstResponseSeconds)}
                            {a.responseStats && <small>{a.responseStats.answered} с ответом · {a.responseStats.waiting} без ответа
                              {a.responseStats.unknown > 0 && ` · ${a.responseStats.unknown} неполных`}</small>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!ads.length && (
                  <p className="ac-empty">Объявления не найдены.</p>
                )}
                <div className="ac-load-more">
                  <small aria-live="polite">
                    Показано {visibleCount} из {ads.length}
                  </small>
                  {visibleCount < ads.length && (
                    <button onClick={() => setBatches((count) => count + 1)}>
                      Загрузить ещё
                    </button>
                  )}
                </div>
                <small>
                  Заказы и прибыль — по дате заказа; поступления — по дате платежа,
                  включая старые подтверждённые заказы. Заказы / контакты — отношение
                  за период, а не доля обратившихся, ставших покупателями. Учитываются
                  только подтверждённые связи; сопоставление может быть неполным.
                  При нуле подтверждённых заказов результат равен минус расходам
                  на рекламу. Прочерк в результате — недостаточно данных для расчёта.
                  Прибыль — оценка 50% суммы заказов минус реклама, без фактического учёта
                  расходов и налогов.
                </small>
                {tab === 'ads' && report.adServiceAutomation?.enabled && (
                  <details className="ac-automation">
                    <summary>Автоподбор категорий объявлений</summary>
                    <p>
                      Ежедневно в 00:00 UTC+3. Ручной выбор и очищение
                      сохраняются.
                    </p>
                    <p>
                      Назначено:{' '}
                      {report.adServiceAutomation.run?.stats.assigned ?? 0};
                      требуют выбора:{' '}
                      {report.adServiceAutomation.run?.stats.unresolved ?? 0};
                      ошибок:{' '}
                      {report.adServiceAutomation.run?.stats.failed ?? 0}.
                      Проверка:{' '}
                      {report.adServiceAutomation.run?.day ||
                        'ещё не выполнялась'}
                      .
                    </p>
                  </details>
                )}
              </section>
            )}
            {(tab === 'overview' || tab === 'categories') && (
              <section>
                <div className="ac-section-head">
                  <h2>Итоги по категориям заказов</h2>
                  {tab === 'overview' && (
                    <button
                      className="ac-link"
                      onClick={() => switchTab('categories')}
                    >
                      Все {categories.length} →
                    </button>
                  )}
                </div>
                <div className="ac-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Категория</th>
                        <th>Контакты</th>
                        <th>Расходы</th>
                        <th>Поступило</th>
                        <th>Прибыль*</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(tab === 'overview'
                        ? categories.slice(0, 4)
                        : categories
                      ).map((c) => (
                        <tr
                          key={c.id}
                          className={cat?.id === c.id ? 'ac-selected' : ''}
                        >
                          <td>
                            <button
                              className="ac-row"
                              onClick={() => select('category', c.id)}
                            >
                              {c.name}
                            </button>
                            <small>
                              {c.ads.length} объявл. · {number(c.orders)}{' '}
                              заказов · данные {c.reported}/{c.ads.length}
                            </small>
                          </td>
                          <td data-label="Контакты">
                            {number(c.knownContacts)}
                          </td>
                          <td data-label="Расходы">{money(c.spend)}{!c.spendComplete && c.spend != null && <small>Известная часть</small>}</td>
                          <td data-label="Поступило">{money(c.receipts)}</td>
                          <td
                            data-label="Прибыль после рекламы*"
                            className={tone(c.result)}
                          >
                            {money(c.result)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <small>
                  * Оценочная прибыль заказов категории минус расходы объявлений.
                  При неполных расходах прибыль и ROMI не рассчитываются.
                  Деньги — по категориям заказов канала, не по связям с объявлениями.
                </small>
              </section>
            )}
            {tab === 'orders' && (
              <section>
                <h2>Заказы и клиенты Авито</h2>
                <div className="ac-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Заказ / клиент</th>
                        <th>Сумма</th>
                        <th>Поступило</th>
                        <th>Оценочная прибыль</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.orders.map((o) => (
                        <tr
                          key={o.id}
                          className={order?.id === o.id ? 'ac-selected' : ''}
                        >
                          <td>
                            <button
                              className="ac-row"
                              onClick={() => select('order', o.id)}
                            >
                              № {o.id} · {o.title}
                            </button>
                            <small>
                              {o.date} · {o.client} ·{' '}
                              {categoryName(o.productId)}
                              {!o.periodOrder ? ' · вне заказов периода' : ''}
                            </small>
                          </td>
                          <td data-label="Сумма заказа">{money(o.amount)}</td>
                          <td data-label="Поступило за период">
                            {money(o.receipts)}
                          </td>
                          <td data-label="Оценочная прибыль">
                            {money(o.profit)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!report.orders.length && (
                  <p className="ac-empty">Заказов за период нет.</p>
                )}
                <details className="ac-automation">
                  <summary>Клиенты и автоподбор категорий</summary>
                  <Values
                    rows={[
                      ['Новые клиенты', number(s.newClients)],
                      ['Из них с заказами', number(s.clientsWithOrders)],
                      ['Из них оплатили', number(s.paidClients)],
                      ['Заказы новых клиентов', number(s.cohortOrders)],
                      [
                        'Без даты добавления',
                        number(report.quality.missingClientDates),
                      ],
                    ]}
                  />
                  <p>
                    Автоподбор ежедневно в 00:00 UTC+3; ручные назначения и
                    очищения сохраняются. Назначено:{' '}
                    {report.serviceAutomation?.run?.stats.assigned ?? 0};
                    требуют выбора:{' '}
                    {report.serviceAutomation?.run?.stats.unresolved ?? 0};
                    ошибок: {report.serviceAutomation?.run?.stats.failed ?? 0}.
                  </p>
                  {report.clients?.map((c) => (
                    <p key={c.name}>
                      {c.name} · {c.date} · заказов {c.orders}
                    </p>
                  ))}
                </details>
              </section>
            )}
          </div>
          <aside
            className="ac-detail"
            ref={detailRef}
            data-open={detailOpen}
            aria-label="Детализация выбранной строки"
          >
            <button
              className="ac-detail-toggle"
              aria-expanded={detailOpen}
              onClick={() => setDetailOpen(!detailOpen)}
            >
              {detailOpen ? 'Свернуть детали' : 'Детали выбранной строки'} ⌄
            </button>
            <div className="ac-detail-body">
              {ad && (
                <>
                  <small>ОБЪЯВЛЕНИЕ · ДЕТАЛИ</small>
                  <h3>{ad.title}</h3>
                  <small>
                    № {ad.id} ·{' '}
                    {ad.status === 'active'
                      ? 'Активно'
                      : ad.status === 'removed'
                        ? 'Снято'
                        : 'Неактивно'}
                  </small>
                  <label className="ac-category-label">
                    Категория / услуга{serviceSelect('ad', ad)}
                  </label>
                  <Values
                    rows={[
                      [
                        'Показы / просмотры',
                        `${number(ad.impressions)} / ${number(ad.views)}`,
                      ],
                      ['Контакты', number(ad.contacts)],
                      ['Расходы', money(ad.spend)],
                      ['Цена контакта', money(ad.costContact)],
                      ['Первый ответ · среднее', responseTime(ad.firstResponseSeconds)],
                      ['Диалоги с ответом / без ответа', ad.responseStats ? `${ad.responseStats.answered} / ${ad.responseStats.waiting}` : '—'],
                      ['Просмотр → контакт', percent(ad.contactRate)],
                    ]}
                  />
                  {matching()}
                  <Values rows={[
                    ['Оценочная прибыль заказов периода', money(ad.profit)],
                    ['ROMI по подтверждённым заказам', percent(ad.romi)],
                  ]} />
                  <small>{ad.reason}.</small>
                  {ad.url &&
                    /^https:\/\/([a-z0-9-]+\.)?avito\.ru\//i.test(ad.url) && (
                      <a
                        href={ad.url}
                        target="_blank"
                        rel="noreferrer"
                        className="ac-link"
                      >
                        Открыть на Авито ↗
                      </a>
                    )}
                  <AnalyticsMaterials key={`${ad.id}:${report.period.from}:${report.period.to}`} itemId={ad.id} from={report.period.from} to={report.period.to}/>
                </>
              )}
              {order && (
                <>
                  <small>ЗАКАЗ · ДЕТАЛИ</small>
                  <h3>
                    № {order.id} · {order.title}
                  </h3>
                  <small>
                    {order.client} · {order.date}
                  </small>
                  <label className="ac-category-label">
                    Категория / услуга{serviceSelect('order', order)}
                  </label>
                  <Values
                    rows={[
                      ['Сумма заказа', money(order.amount)],
                      ['Поступило за период', money(order.receipts)],
                      ['Оценочная прибыль', money(order.profit)],
                    ]}
                  />
                  {!order.periodOrder && (
                    <small>
                      Не входит в число заказов и прибыль выбранного периода.
                    </small>
                  )}
                  {matching()}
                </>
              )}
              {cat && (
                <>
                  <small>КАТЕГОРИЯ · ДЕТАЛИ</small>
                  <h3>{cat.name}</h3>
                  <small>
                    Статистика {cat.reported} из {cat.ads.length} объявлений
                  </small>
                  <Values
                    rows={[
                      [
                        'Показы / просмотры',
                        `${number(sumKnown(cat.ads.map((a) => a.impressions)))} / ${number(sumKnown(cat.ads.map((a) => a.views)))}`,
                      ],
                      ['Контакты', number(cat.knownContacts)],
                      [
                        'Цена контакта',
                        money(ratio(cat.spend, cat.knownContacts)),
                      ],
                      [cat.spendComplete ? 'Расходы рекламы' : 'Известные расходы рекламы', money(cat.spend)],
                      ['Заказы категории', number(cat.orders)],
                      ['Поступило', money(cat.receipts)],
                      ['Оценочная прибыль', money(cat.profit)],
                      ['Прибыль после рекламы', money(cat.result)],
                      [
                        'ROMI категории',
                        percent(ratio(cat.result, cat.spend, 100)),
                      ],
                    ]}
                  />
                  <h3>Состав категории</h3>
                  <button
                    className="ac-link"
                    onClick={() => {
                      setCategory(cat.id);
                      setQuery('');
                      switchTab('ads');
                    }}
                  >
                    Объявления категории · {cat.ads.length} →
                  </button>
                  {cat.ads
                    .slice()
                    .sort((a, b) => (b.spend ?? -1) - (a.spend ?? -1))
                    .slice(0, 3)
                    .map((a) => (
                      <div className="ac-assignment" key={a.id}>
                        <button
                          className="ac-link"
                          onClick={() => select('ad', a.id)}
                        >
                          № {a.id} · {a.title}
                        </button>
                        <small>{money(a.spend)}</small>
                      </div>
                    ))}
                  <h3>Заказы категории</h3>
                  {cat.orderRows.map((o) => (
                    <div className="ac-assignment" key={o.id}>
                      <button
                        className="ac-link"
                        onClick={() => select('order', o.id)}
                      >
                        № {o.id} · {o.title}
                      </button>
                      <small>
                        {money(o.receipts)}
                        {!o.periodOrder ? ' · заказ другого периода' : ''}
                      </small>
                    </div>
                  ))}
                  {!cat.orderRows.length && (
                    <small>
                      В выбранном периоде заказов и поступлений нет.
                    </small>
                  )}
                  <small>
                    Категория заказа может отличаться от категории связанного
                    объявления.
                  </small>
                </>
              )}
              {!ad && !order && !cat && (
                <p className="ac-empty">Выберите строку для детализации.</p>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
