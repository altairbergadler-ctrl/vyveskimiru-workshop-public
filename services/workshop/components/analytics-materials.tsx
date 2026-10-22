import { useEffect, useRef, useState } from 'react';
import { analyticsRequest } from './analytics-readiness';

type MaterialView = {
  contentVersion: number;
  content: { text: string; photos: string[]; observedAt: string } | null;
  chats: { id: string; firstIn: string | null; state: string }[];
  notes: {
    id: string;
    date: string;
    text: string;
    comparison?: {
      before: {
        knownDays: number;
        views: number | null;
        contacts: number | null;
      };
      after: {
        knownDays: number;
        views: number | null;
        contacts: number | null;
      };
    };
  }[];
  excerpts: {
    id: string;
    chatId: string;
    messageId: string;
    messageAt: string;
    excerpt: string;
  }[];
};
type Message = {
  id: string;
  createdAt: string;
  direction: string;
  text: string;
};
type Page = {
  token: string;
  messages: Message[];
  nextOffset: number | null;
  historyLimited: boolean;
};
type Day = {
  date: string;
  spend: number | null;
  views: number | null;
  contacts: number | null;
};
type History = {
  rows: {
    id: number;
    kind: string;
    observedAt: string;
    fields: string[];
    value?: { text?: string; photos?: string[] };
  }[];
  nextBefore: number | null;
};
const stamp = (value: string) => new Date(value).toLocaleString('ru-RU');
export default function AnalyticsMaterials({
  itemId,
  from,
  to,
}: {
  itemId: string;
  from: string;
  to: string;
}) {
  const [view, setView] = useState<MaterialView | null>(null),
    [days, setDays] = useState<Day[]>([]),
    [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const [text, setText] = useState(''),
    [editVersion, setEditVersion] = useState(0),
    [photos, setPhotos] = useState(''),
    [note, setNote] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [chat, setChat] = useState(''),
    [page, setPage] = useState<Page | null>(null),
    [selected, setSelected] = useState<Message | null>(null);
  const [range, setRange] = useState({ start: 0, end: 0 }),
    [reviewed, setReviewed] = useState(false);
  const controller = useRef<AbortController | null>(null),
    saveId = useRef(crypto.randomUUID()),
    noteId = useRef(crypto.randomUUID());
  useEffect(() => {
    const c = new AbortController();
    controller.current = c;
    Promise.all([
      analyticsRequest<MaterialView>(
        `/api/analytics/materials?${new URLSearchParams({ itemId, dateFrom: from, dateTo: to })}`,
        undefined,
        c.signal,
      ),
      analyticsRequest<{ days: Day[] }>(
        `/api/analytics/avito/deep/daily?${new URLSearchParams({ itemId, dateFrom: from, dateTo: to })}`,
        undefined,
        c.signal,
      ),
      analyticsRequest<History>(
        `/api/analytics/avito/deep/history?itemId=${encodeURIComponent(itemId)}`,
        undefined,
        c.signal,
      ),
    ])
      .then(([v, d, h]) => {
        if (c.signal.aborted) return;
        setView(v);
        setEditVersion(v.contentVersion);
        setText(v.content?.text ?? '');
        setPhotos(v.content?.photos.join('\n') ?? '');
        setDays(d.days);
        setHistory(h);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [itemId, from, to]);
  async function reload() {
    const result = await analyticsRequest<MaterialView>(
      `/api/analytics/materials?${new URLSearchParams({ itemId, dateFrom: from, dateTo: to })}`,
      undefined,
      controller.current?.signal,
    );
    if (!controller.current?.signal.aborted) setView(result);
    return result;
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      if (!controller.current?.signal.aborted)
        setError(e instanceof Error ? e.message : 'Ошибка запроса.');
    } finally {
      if (!controller.current?.signal.aborted) setBusy(false);
    }
  }
  async function readPage(offset: number) {
    const value = await analyticsRequest<Page>(
      '/api/analytics/materials/page',
      { itemId, chatId: chat, offset },
      controller.current?.signal,
    );
    if (controller.current?.signal.aborted) return;
    setPage(value);
    setSelected(null);
    setReviewed(false);
  }
  return (
    <div className="ar-materials">
      {error && <p role="alert">{error}</p>}
      {notice && <output>{notice}</output>}
      <details>
        <summary>Расходы по дням</summary>
        <p>
          Прочерк означает отсутствие подтверждённой строки, а не нулевой
          расход.
        </p>
        <div className="ar-table">
          <table>
            <thead>
              <tr>
                <th>День</th>
                <th>Расход, ₽</th>
                <th>Просмотры</th>
                <th>Контакты</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.date}>
                  <td data-label="День">{d.date}</td>
                  <td data-label="Расход, ₽">
                    {d.spend?.toLocaleString('ru-RU') ?? '—'}
                  </td>
                  <td data-label="Просмотры">{d.views ?? '—'}</td>
                  <td data-label="Контакты">{d.contacts ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <details>
        <summary>История и отметки</summary>
        <p>
          Наблюдения показывают изменения между проверками. Они не доказывают
          влияние правки на результат рекламы.
        </p>
        {(history?.rows ?? [])
          .filter((r) => r.fields.length || r.kind === 'content')
          .map((r) => (
            <div key={r.id}>
              <p>
                {stamp(r.observedAt)} ·{' '}
                {r.kind === 'content'
                  ? 'Ручной снимок содержания'
                  : r.fields.join(', ')}
              </p>
              {r.kind === 'content' && (
                <details>
                  <summary>Содержание снимка</summary>
                  <blockquote>{r.value?.text}</blockquote>
                  {r.value?.photos?.map((url, i) => (
                    <p key={url}>
                      <a href={url} target="_blank" rel="noreferrer">
                        Оригинал фото {i + 1}
                      </a>
                    </p>
                  ))}
                </details>
              )}
            </div>
          ))}
        {history?.nextBefore != null && (
          <button
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const h = await analyticsRequest<History>(
                  `/api/analytics/avito/deep/history?${new URLSearchParams({ itemId, before: String(history.nextBefore) })}`,
                  undefined,
                  controller.current?.signal,
                );
                if (!controller.current?.signal.aborted)
                  setHistory({
                    rows: [...history.rows, ...h.rows],
                    nextBefore: h.nextBefore,
                  });
              })
            }
          >
            Ещё наблюдения
          </button>
        )}
        {view?.notes.map((n) => (
          <div key={n.id}>
            <p>
              {n.date} · {n.text}
            </p>
            {n.comparison && (
              <small>
                Дней до / после: {n.comparison.before.knownDays}/7 ·{' '}
                {n.comparison.after.knownDays}/7.
                <br />
                Просмотры: {n.comparison.before.views ?? '—'} →{' '}
                {n.comparison.after.views ?? '—'}; контакты:{' '}
                {n.comparison.before.contacts ?? '—'} →{' '}
                {n.comparison.after.contacts ?? '—'}.
              </small>
            )}
          </div>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              await analyticsRequest(
                '/api/analytics/avito/deep/notes',
                { id: noteId.current, itemId, date, text: note },
                controller.current?.signal,
              );
              await reload();
              if (!controller.current?.signal.aborted) {
                setNote('');
                noteId.current = crypto.randomUUID();
                setNotice('Отметка сохранена.');
              }
            });
          }}
        >
          <label>
            Дата изменения
            <input
              type="date"
              required
              value={date}
              onChange={(e) => setDate(e.target.value)}
              disabled={busy}
            />
          </label>
          <label>
            Что изменилось
            <textarea
              value={note}
              required
              maxLength={1000}
              onChange={(e) => {
                setNote(e.target.value);
                noteId.current = crypto.randomUUID();
              }}
              disabled={busy}
            />
          </label>
          <button disabled={busy || !view}>Сохранить отметку</button>
        </form>
      </details>
      <details>
        <summary>Текст и фотографии</summary>
        <p>
          Автоматическое получение содержания не подтверждено. Здесь сохраняется
          ручной снимок с текущей датой. Фото — ссылки на оригиналы Авито; их
          доступность может измениться.
        </p>
        {view?.content && (
          <p>Последний ручной снимок: {stamp(view.content.observedAt)}</p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              const saved = await analyticsRequest<{ version: number }>(
                '/api/analytics/materials/content',
                {
                  id: saveId.current,
                  itemId,
                  text,
                  photos: photos
                    .split('\n')
                    .map((s) => s.trim())
                    .filter(Boolean),
                  expectedVersion: editVersion,
                },
                controller.current?.signal,
              );
              if (!controller.current?.signal.aborted) {
                setEditVersion(saved.version);
                saveId.current = crypto.randomUUID();
                setNotice('Ручной снимок сохранён.');
              }
              await reload();
            });
          }}
        >
          <label>
            Текст объявления
            <textarea
              maxLength={20000}
              aria-label="Текст объявления"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                saveId.current = crypto.randomUUID();
              }}
              disabled={busy}
            />
          </label>
          <label>
            Ссылки на фото Авито, по одной в строке
            <textarea
              value={photos}
              aria-label="Ссылки на фото Авито, по одной в строке"
              onChange={(e) => {
                setPhotos(e.target.value);
                saveId.current = crypto.randomUUID();
              }}
              disabled={busy}
              placeholder="https://…avito.st/…"
            />
          </label>
          <button disabled={busy || !view || (!text.trim() && !photos.trim())}>
            Сохранить снимок
          </button>
        </form>
        <div className="ar-photos">
          <button
            disabled={busy || !view}
            onClick={() =>
              void action(async () => {
                const fresh = await reload();
                if (controller.current?.signal.aborted) return;
                setText(fresh.content?.text ?? '');
                setPhotos(fresh.content?.photos.join('\n') ?? '');
                setEditVersion(fresh.contentVersion);
                saveId.current = crypto.randomUUID();
              })
            }
          >
            Заменить черновик сохранённым снимком
          </button>
          {view?.content?.photos.map((url) => (
            <a key={url} href={url} target="_blank" rel="noreferrer">
              <img
                src={url}
                alt="Фото объявления из ручного снимка"
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            </a>
          ))}
        </div>
      </details>
      <details>
        <summary>Фрагменты переписок</summary>
        <p>
          Полный архив не сохраняется. Чтение идёт по запросу с общими
          ограничениями Авито. Выберите только нужный фрагмент и проверьте
          отсутствие имён и контактов.
        </p>
        <a
          href="https://www.avito.ru/profile/messenger"
          target="_blank"
          rel="noreferrer"
        >
          Открыть переписки Авито ↗
        </a>
        <label>
          Диалог (доступно не более 100)
          <select
            value={chat}
            disabled={busy}
            onChange={(e) => {
              setChat(e.target.value);
              setPage(null);
              setSelected(null);
              setReviewed(false);
            }}
          >
            <option value="">Выберите диалог</option>
            {view?.chats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.firstIn?.slice(0, 10) ?? 'Дата неизвестна'} · {c.id}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={busy || !chat}
          onClick={() => void action(() => readPage(0))}
        >
          Прочитать сообщения
        </button>
        {page?.messages.map((m) => (
          <button
            className="ar-message"
            key={m.id}
            disabled={busy}
            onClick={() => {
              setSelected(m);
              setRange({ start: 0, end: Math.min(m.text.length, 2000) });
              setReviewed(false);
            }}
          >
            {stamp(m.createdAt)} ·{' '}
            {m.direction === 'in' ? 'Клиент' : 'Исходящее'}
            <span>{m.text}</span>
          </button>
        ))}
        {page?.nextOffset != null && (
          <button
            disabled={busy}
            onClick={() => void action(() => readPage(page.nextOffset!))}
          >
            Следующая страница
          </button>
        )}
        {page?.historyLimited && (
          <p>
            Достигнута граница доступной истории. Начало диалога может
            отсутствовать.
          </p>
        )}
        {selected && (
          <div>
            <label>
              Выделите нужный фрагмент
              <textarea
                readOnly
                value={selected.text}
                onSelect={(e) => {
                  const t = e.currentTarget;
                  setRange({ start: t.selectionStart, end: t.selectionEnd });
                  setReviewed(false);
                }}
              />
            </label>
            <blockquote>
              {selected.text.slice(range.start, range.end)}
            </blockquote>
            <label className="ar-check">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
              />
              Проверено: в выбранном фрагменте нет имён, контактов и других
              личных данных
            </label>
            <button
              disabled={
                busy ||
                !reviewed ||
                range.end <= range.start ||
                range.end - range.start > 2000
              }
              onClick={() =>
                void action(async () => {
                  await analyticsRequest(
                    '/api/analytics/materials/excerpt',
                    {
                      token: page?.token,
                      messageId: selected.id,
                      ...range,
                      reviewed,
                    },
                    controller.current?.signal,
                  );
                  await reload();
                  if (!controller.current?.signal.aborted) {
                    setReviewed(false);
                    setNotice('Проверенный фрагмент сохранён с источником.');
                  }
                })
              }
            >
              Сохранить выбранный фрагмент
            </button>
          </div>
        )}
        {view?.excerpts.map((x) => (
          <blockquote key={x.id}>
            {x.excerpt}
            <small>
              {stamp(x.messageAt)} · диалог {x.chatId} · сообщение {x.messageId}
            </small>
          </blockquote>
        ))}
        <p>
          Молчание клиента само по себе не устанавливает причину отказа.
          Классификация причин появится вместе с будущим аналитиком.
        </p>
      </details>
    </div>
  );
}
