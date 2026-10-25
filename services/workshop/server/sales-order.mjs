import crypto from 'node:crypto';
import { SalesError } from './sales-desk.mjs';
import { orderCreationState } from '../modules/orders/server/creation.mjs';

// A proposal for the existing order editor, never a financial write or a price calculation.
export function normalizeOrderDraft(value, allowedSources) {
  if (value == null) return null;
  const keys = [
    'title',
    'client',
    'description',
    'amount',
    'desiredDate',
    'items',
    'sources',
  ];
  const invalid = () => {
    throw new SalesError(
      'SALES_ORDER_DRAFT_INVALID',
      'Помощник вернул неполный формат заказа. Обновите саммари.',
      422,
    );
  };
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    invalid();
  const text = (v, max) => {
    if (v == null) return '';
    if (typeof v !== 'string' || v.length > max || v.includes('\0')) invalid();
    return v.trim();
  };
  const title = text(value.title, 250),
    client = text(value.client, 250),
    description = text(value.description, 8000);
  const amount = value.amount ?? null,
    desiredDate = value.desiredDate || '';
  if (
    amount !== null &&
    (!Number.isFinite(amount) || amount < 0 || amount > 1e10)
  )
    invalid();
  if (
    desiredDate &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(desiredDate) ||
      !Number.isFinite(Date.parse(desiredDate)) ||
      new Date(desiredDate).toISOString().slice(0, 10) !== desiredDate)
  )
    invalid();
  if (
    !Array.isArray(value.sources) ||
    value.sources.length > 6 ||
    value.sources.some((id) => !allowedSources.includes(id))
  )
    invalid();
  if (!Array.isArray(value.items) || value.items.length > 20) invalid();
  const items = value.items.map((item) => {
    if (
      !item ||
      Object.keys(item).some(
        (k) => !['name', 'description', 'quantity'].includes(k),
      )
    )
      invalid();
    const quantity = item.quantity ?? null;
    if (
      quantity !== null &&
      (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000000)
    )
      invalid();
    return {
      name: text(item.name, 300),
      description: text(item.description, 3000),
      quantity,
    };
  });
  return {
    title,
    client,
    description,
    amount,
    desiredDate,
    items,
    sources: [...new Set(value.sources)],
  };
}
export function salesOrderPrefill(desk, id, _summaryId, creationOptions) {
  const note = desk.detail(id),
    draft = note.summary?.orderDraft || {
      title: '',
      client: '',
      description: note.summary?.text || '',
      amount: null,
      desiredDate: '',
      items: [],
    };
  if (note.orderId)
    throw new SalesError(
      'SALES_ORDER_LINKED',
      'У карточки уже есть заказ №' + note.orderId,
      409,
    );
  if (note.trashedAt || ['archived', 'merged'].includes(note.status))
    throw new SalesError(
      'SALES_CLOSED',
      'Сначала верните карточку в работу.',
      409,
    );
  const title =
    draft.title ||
    note.summary?.requestTitle ||
    (note.titleEdited || !note.events.length ? note.title : '');
  const missing = [];
  if (!title) missing.push('название заказа');
  if (!(note.client || draft.client || note.channelClient))
    missing.push('клиент');
  if (
    !draft.items.length ||
    draft.items.some((item) => !item.name || !item.quantity)
  )
    missing.push('изделия и количество');
  const requestId = salesOrderRequestId(id, creationOptions);
  return {
    noteId: id,
    summaryId: note.summary?.jobId || '',
    requestId,
    values: {
      title,
      client: note.client || draft.client || note.channelClient || '',
      amountOverride: draft.amount ?? '',
      desiredDate: draft.desiredDate,
      comment: [
        draft.description,
        note.manual ? 'Заметки менеджера:\n' + note.manual : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
    configDraft: {
      items: draft.items.map((item) => ({
        type: 'custom',
        data: {
          name: item.name,
          description: item.description,
          qty: item.quantity == null ? '' : String(item.quantity),
        },
        parts: [],
        variants: [],
      })),
      editor: null,
      editingIndex: null,
      showCatalog: false,
    },
    missing,
    warning:
      (note.analysis?.state === 'error' ||
      !note.summary ||
      note.summary.watermark !== note.watermark
        ? 'Не удалось полностью обновить анализ. Проверьте доступные данные. '
        : '') +
      (note.contextWarning ? note.contextWarning + ' ' : '') +
      (missing.length ? 'Дополните: ' + missing.join(', ') + '. ' : '') +
      'Проверьте клиента, состав, цену и сроки. Заказ создаётся только после вашего подтверждения.',
  };
}

export function salesOrderRequestId(id, options) {
  // The canonical creation journal is the only authority for skipping an attempt.
  // Reserved/verified/unknown receipts keep their identity across lost sessions.
  for (let attempt = 0; attempt < 1000; attempt++) {
    const h = crypto
      .createHash('sha256')
      .update('sales-order:' + id + (attempt ? ':' + attempt : ''))
      .digest('hex');
    const requestId =
      h.slice(0, 8) +
      '-' +
      h.slice(8, 12) +
      '-5' +
      h.slice(13, 16) +
      '-8' +
      h.slice(17, 20) +
      '-' +
      h.slice(20, 32);
    if (orderCreationState(requestId, options) !== 'aborted') return requestId;
  }
  throw new SalesError(
    'SALES_ORDER_RETRY_LIMIT',
    'Слишком много прерванных попыток. Проверьте журнал создания заказа.',
    409,
  );
}
