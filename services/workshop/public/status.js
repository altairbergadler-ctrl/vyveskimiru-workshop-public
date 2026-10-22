const labels = { orders: 'Заказы', production: 'Производство', warehouse: 'Склад' };
async function refresh() {
  const button = document.querySelector('#refresh'); button.disabled = true;
  const message = document.querySelector('#message');
  try {
    const response = await fetch('/api/diagnostics', { cache: 'no-store' });
    if (response.status === 401) throw new Error('Сначала войдите в приложение по ссылке выше.');
    if (!response.ok) throw new Error('Не удалось получить состояние приложения. Попробуйте ещё раз.');
    const data = await response.json();
    const finance = data.finance;
    const states = [{ title: 'Финансы', ok: !finance.last_error && !finance.pending && !finance.invalidRows && Boolean(finance.last_success_at),
      at: finance.last_success_at }, ...Object.entries(labels).map(([key, title]) => ({ title, ok: data.checks?.[key]?.ok === true && (key !== 'warehouse' || !data.warehousePending?.length), at: data.checks?.[key]?.checkedAt })),
      { title: 'Структура таблицы', ok: data.sheetsContract?.ok === true, at: data.sheetsContract?.checkedAt }];
    const cards = document.querySelector('#cards'); cards.replaceChildren();
    for (const state of states) {
      const card = document.createElement('div'); card.className = 'card';
      const title = document.createElement('strong'); title.textContent = state.title;
      const ok = state.ok && data.sheetsContract?.ok === true;
      const status = document.createElement('p'); status.className = ok ? 'ok' : 'bad'; status.textContent = ok ? 'Работает' : 'Требуется проверка';
      const stamp = document.createElement('small'); stamp.textContent = state.at ? new Date(state.at).toLocaleString('ru-RU') : 'Проверка ещё не завершена';
      card.append(title, status, stamp); cards.append(card);
    }
    message.textContent = finance.pending ? `Неподтверждённых операций: ${finance.pending}. Сохраняйте исходную форму до проверки результата.` : 'Все финансовые записи подтверждены. CRM остаётся отключённой.';
    if (data.sheetsContract?.ok === false) message.textContent = 'Проверка структуры таблицы не пройдена. Новые записи приостановлены.' + (finance.pending ? ` Неподтверждённых операций: ${finance.pending}. Сохраняйте исходную форму до проверки результата.` : '');
    if (data.warehousePending?.length) message.textContent += ` Неподтверждённых пополнений склада: ${data.warehousePending.length}. Откройте исходную форму пополнения и проверьте результат.`;
    const errors = document.querySelector('#errors'); errors.replaceChildren();
    for (const event of data.activeFailures || []) {
      const li = document.createElement('li'); li.textContent = `${new Date(event.at).toLocaleString('ru-RU')} · ${event.route} · ошибка ${event.status} · номер ${event.requestId}`; errors.append(li);
    }
    if (!errors.children.length) { const li = document.createElement('li'); li.textContent = 'Незакрытых ошибок запросов нет.'; errors.append(li); }
    document.querySelector('#details').textContent = JSON.stringify({ version: data.version, sheetsContract: data.sheetsContract, pendingCommands: data.pendingCommands, warehousePending: data.warehousePending, events: data.events }, null, 2);
    document.querySelector('#time').textContent = new Date().toLocaleTimeString('ru-RU');
  } catch (error) { message.textContent = error.message; } finally { button.disabled = false; }
}
document.querySelector('#refresh').addEventListener('click', refresh);
void refresh();
