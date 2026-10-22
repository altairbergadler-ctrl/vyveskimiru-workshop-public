import type { LiveReport } from '../lib/analytics-live';

const money = (n: number | null) =>
  n == null ? '—' : `${n.toLocaleString('ru-RU')} ₽`;
const states: Record<string, string> = {
  done: 'завершена',
  partial: 'завершена частично',
  failed: 'не завершена',
  interrupted: 'прервана',
  running: 'выполняется',
};
export default function AnalyticsAttribution({
  report,
  busy,
  decide,
}: {
  report: LiveReport;
  busy: boolean;
  decide: (
    id: string,
    action: 'confirm' | 'reject' | 'unlink',
  ) => Promise<void>;
}) {
  const data = report.attribution;
  if (!data?.enabled) return <p>Автосопоставление пока не включено.</p>;
  return (
    <section className="al-card al-attribution">
      <h2>Сопоставления заказов и объявлений</h2>
      <details>
        <summary>Ночная проверка и состояние загрузки</summary>
        <p>
          Проверка каждый день в 00:00 UTC+3 · GPT‑6 Luna · максимальное усилие.
          Повторно анализируются только изменившиеся переписки.
        </p>
        <p>
          {data.run
            ? `Проверка за ${data.run.day}: ${states[data.run.state] || data.run.state}. Разобрано: ${data.run.stats.analyzed ?? 0}; без изменений: ${data.run.stats.unchanged ?? 0}.`
            : 'Первая проверка запланирована на ближайшую полночь.'}
        </p>
        {!!data.run?.stats.failed && (
          <p>
            Не удалось разобрать: {data.run.stats.failed}. Неопределённые ответы
            не запускаются повторно для той же версии чата.
          </p>
        )}
        {!!data.run?.stats.deferred && (
          <p>В очереди на следующие ночи: {data.run.stats.deferred}.</p>
        )}
        {data.run?.stats.limited && (
          <p>
            Авито ограничил доступную глубину списка. Проверена только доступная
            история.
          </p>
        )}
      </details>
      <h3>Подтверждённые заказы и поступления</h3>
      <p>
        Заказы и прибыль — по дате заказа; поступления — по дате платежа в
        выбранном периоде. Эти суммы учитывают только подтверждённые связи.
        Неподтверждённые предложения не учитываются. Сопоставление может быть неполным.
      </p>
      {!data.links.length && <p>Подтверждённых связей пока нет.</p>}
      {data.facts.map((fact) => {
        const ad = report.rows.find((row) => row.id === fact.itemId);
        const result = ad?.result ?? null;
        return (
          <article
            key={fact.itemId}
            className="al-ad"
            style={{ display: 'block' }}
          >
            <strong>{fact.title}</strong>
            <p>
              № {fact.itemId} · Заказов: {fact.orders} · Поступило:{' '}
              {money(fact.orderIds.length ? fact.receipts : null)} · Прибыль подтверждённых заказов после
              рекламы: {money(result)}
            </p>
            {data.links
              .filter((link) => link.itemId === fact.itemId)
              .map((link) => (
                <div key={link.orderId} className="al-between">
                  <span>Заказ №{link.orderId}</span>
                  <button
                    disabled={busy}
                    onClick={() => void decide(link.suggestionId, 'unlink')}
                  >
                    Отменить связь
                  </button>
                </div>
              ))}
          </article>
        );
      })}
      <h3>Проверить связи · {data.pending.length}</h3>
      <p>
        Предложения агента не входят в денежные показатели до подтверждения.
        Один заказ можно связать только с одним объявлением.
      </p>
      <p>
        Сопоставляются тексты переписок. Фото, голосовые сообщения и звонки пока
        не разбираются.
      </p>
      {data.pending.map((suggestion) => (
        <article
          key={suggestion.id}
          className="al-ad"
          style={{ display: 'block', overflowWrap: 'anywhere' }}
        >
          <strong>
            Заказ №{suggestion.orderId} → {suggestion.itemTitle}
          </strong>
          <p>
            Объявление №{suggestion.itemId} · {suggestion.reasons.join('; ')}.
          </p>
          <details>
            <summary>Основания для проверки в Авито</summary>
            <p>Чат: {suggestion.chatId}</p>
            <p>Сообщения: {suggestion.messageIds.join(', ')}</p>
          </details>
          <div className="al-between">
            <button
              disabled={busy}
              onClick={() => void decide(suggestion.id, 'confirm')}
            >
              Подтвердить связь
            </button>
            <button
              disabled={busy}
              onClick={() => void decide(suggestion.id, 'reject')}
            >
              Не подходит
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
