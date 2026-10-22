const feedback = document.getElementById('status');
const summary = document.getElementById('message');
const attachments = document.getElementById('attachments');
let busy = false;
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function render(result) {
  summary.replaceChildren(); attachments.replaceChildren();
  const labels = { awaiting_key: 'Ждём ключ подключения почты', ready: 'Получение писем включено', syncing: 'Проверяем почту', error: 'Проверка почты не завершена' };
  summary.append(el('h2', labels[result.state] || 'Проверяем подключение'));
  summary.append(el('p', result.state === 'awaiting_key' ? 'После подключения письма будут поступать автоматически. Скачивать и переносить файлы вручную не нужно.' :
    `Ожидают разбора помощником: ${result.counts.review || 0} · Обработано писем: ${result.counts.done || 0} · Ошибок: ${result.counts.error || 0}`));
  summary.append(el('p', result.assistantMode === 'desktop'
    ? 'Разбор помощником: ежедневно в 10:00, 12:00, 13:00 и 20:00 (UTC+3). Для него компьютер и Codex должны быть включены. Получение писем на сервере работает независимо.'
    : 'Регулярный запуск помощника для разбора ещё не подключён.', 'muted'));
  if (result.lastSuccessAt) summary.append(el('p', `Последняя проверка почты: ${new Date(result.lastSuccessAt).toLocaleString('ru-RU')}`, 'muted'));
  if (result.lastError) summary.append(el('p', 'Получение писем будет повторено автоматически. Если ошибка сохраняется, нужно проверить подключение и свободное место.', 'error'));
  for (const mail of result.messages) {
    if (mail.error) attachments.append(el('p', 'Одно из писем требует проверки помощником.', 'error'));
    for (const item of mail.attachments || []) {
      const card = el('article');
      card.append(el('h2', item.name), el('p', `${mail.message?.subject || 'Без темы'} · ${mail.message?.from || ''}`, 'muted'));
      if (item.link) card.append(el('p', item.size ? `Яндекс Диск · ${(item.size / 1024 / 1024).toFixed(1)} МБ · оригинал сохранён` : 'Яндекс Диск · получение оригинала', 'muted'));
      if (item.state === 'imported') {
        const link = el('a', `В заказе №${item.orderId}`); link.href = `/kanban/?order=${encodeURIComponent(item.orderId)}&tab=media`; card.append(link);
        if (item.decision?.reason) card.append(el('p', item.decision.reason));
      } else if (item.state === 'review') card.append(el('p', item.error ? (item.link ? 'Файл требует проверки. Получение будет повторено автоматически; закрытая ссылка, папка или файл больше лимита потребуют внимания помощника.' : 'Требуется разбор прежней привязки или удаления.') : 'Ожидает разбора помощником.'));
      else card.append(el('p', item.note || 'Вложение пока не поддерживается.', 'muted'));
      attachments.append(card);
    }
  }
  if (!result.messages.length) attachments.append(el('p', 'Пока нет полученных макетов.', 'muted'));
}
async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const response = await fetch('/kanban/api/mail/queue', { credentials: 'same-origin' });
    if (!response.ok) throw new Error(response.status === 401 ? 'Войдите в Мастерскую через доску заказов.' : 'Не удалось получить состояние почты.');
    render(await response.json()); feedback.textContent = '';
  } catch (error) { feedback.textContent = error.message; }
  finally { busy = false; }
}
void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 30_000);
