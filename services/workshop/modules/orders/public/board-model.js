const ARCHIVED_STATUSES = new Set(['Сдан']);
const ARCHIVABLE_STATUSES = new Set(['Готов к выдаче', 'Монтаж']);
const statusOf = value => typeof value?.status === 'string' ? value.status.trim() : '';

const COMMENT_SEPARATOR = '\n\nКОММЕНТАРИЙ К ЗАКАЗУ\n';
export function orderCommentParts(value) {
  const raw = typeof value === 'string' ? value : '';
  if (!raw.startsWith('ПРОДУКЦИЯ\n1. ')) return { original: '', comment: raw };
  const index = raw.indexOf(COMMENT_SEPARATOR);
  return index < 0 ? { original: raw, comment: '' }
    : { original: raw.slice(0, index), comment: raw.slice(index + COMMENT_SEPARATOR.length) };
}
export function replaceOrderComment(value, comment) {
  const { original } = orderCommentParts(value);
  return original ? original + (comment ? COMMENT_SEPARATOR + comment : '') : comment;
}

/** Every order belongs to exactly one workspace, including unfamiliar statuses. */
export function orderZone(order) {
  const status = statusOf(order);
  if (status === 'Отменён') return 'cancelled';
  if (ARCHIVED_STATUSES.has(status)) return 'archive';
  if (status === 'Монтаж') return 'installation';
  if (status === 'Готов к выдаче' && Array.isArray(order?.installations) &&
      order.installations.some(installation => installation && typeof installation === 'object' &&
        !Array.isArray(installation) && statusOf(installation) !== 'Отменён')) return 'installation';
  return 'board';
}

export function canArchiveOrder(order) {
  return ARCHIVABLE_STATUSES.has(statusOf(order));
}
