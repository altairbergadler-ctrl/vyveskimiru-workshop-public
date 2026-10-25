import crypto from 'node:crypto';
import { simpleParser } from 'mailparser';
import { inspectMedia, MediaError } from './media.mjs';
import { diskLinks, MAX_LAYOUT_BYTES } from './mail-links.mjs';

export const MAX_EMAIL_BYTES = 96 * 1024 * 1024;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replaceAll('ё', 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const words = value => new Set(normalize(value).split(' ').filter(word => word.length > 2 && !['макет', 'итог', 'файл', 'заказ', 'режим', 'новый', 'cdr', 'pdf'].includes(word)));
const fail = (code, message, status = 400) => new MediaError(code, message, status);

// Mail text is evidence for suggestions only; it cannot authorize an import.
export function matchOrders(message, filename, orders) {
  const evidence = [message.subject, filename, message.text].map(normalize);
  const tokens = words(evidence.join(' '));
  return orders.map(order => {
    const id = normalize(order.id);
    const explicit = evidence.some(text => (` ${text} `).includes(` заказ ${id} `)) ||
      [message.subject, filename].some(text => new RegExp(`(?:№|#)\\s*${String(order.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(text));
    const title = normalize(order.title);
    const titleMatch = title.length > 5 && evidence.some(text => (` ${text} `).includes(` ${title} `));
    const overlap = [...words(`${order.title} ${order.client}`)].filter(word => tokens.has(word));
    const score = (explicit ? 100 : 0) + (titleMatch ? 40 : 0) + Math.min(overlap.length, 5) * 5;
    return { orderId: order.id, title: order.title, client: order.client, status: order.status, score,
      reasons: [explicit && 'Указан номер заказа', titleMatch && 'Совпало название заказа', overlap.length && `Общие слова: ${overlap.join(', ')}`].filter(Boolean) };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || String(a.orderId).localeCompare(String(b.orderId))).slice(0, 8);
}

export async function parseLayoutEmail(raw, { includeMedia = false } = {}) {
  if (!Buffer.isBuffer(raw) || !raw.length || raw.length > MAX_EMAIL_BYTES) throw fail('MAIL_SIZE', 'Письмо должно быть не больше 96 МБ.', 413);
  let mail;
  try { mail = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true, skipTextLinks: true }); }
  catch { throw fail('MAIL_INVALID', 'Не удалось прочитать письмо. Сохраните его в формате EML.'); }
  const senders = mail.from?.value || [];
  if (senders.length !== 1 || !senders[0].address || !mail.headers.has('content-type')) throw fail('MAIL_INVALID', 'В письме не найден один отправитель или описание содержимого.');
  if (mail.attachments.length > 50) throw fail('MAIL_ATTACHMENTS', 'В одном письме поддерживается до 50 вложений.', 413);
  const message = { messageId: String(mail.messageId || `sha256:${hash(raw)}`).slice(0, 512),
    from: senders[0].address.toLowerCase(), senderName: String(senders[0].name || '').slice(0, 256),
    subject: String(mail.subject || '').slice(0, 512), sentAt: mail.date && Number.isFinite(mail.date.getTime()) ? mail.date.toISOString() : null,
    text: String(mail.text || '').slice(0, 12_000), textTruncated: String(mail.text || '').length > 12_000,
    inReplyTo: String(mail.inReplyTo || '').slice(0, 512),
    references: (Array.isArray(mail.references) ? mail.references : mail.references ? [mail.references] : []).slice(-30).map(value => String(value).slice(0, 512)) };
  const attachments = mail.attachments.map((item, index) => {
    const name = String(item.filename || `Вложение ${index + 1}`).slice(0, 1000);
    const extension = name.split('.').at(-1).toLowerCase();
    const partId = String(index + 1);
    const result = { partId, name, size: item.size, supported: false, note: 'Этот формат пока не поддерживается.' };
    if (!['cdr', 'pdf'].includes(extension)) return result;
    if (item.content.length > (extension === 'cdr' ? MAX_LAYOUT_BYTES : 12 * 1024 * 1024)) return { ...result, note: extension === 'cdr' ? 'Размер больше 64 МБ.' : 'Размер больше 12 МБ.' };
    const contentType = extension === 'cdr' ? 'application/vnd.corel-draw' : 'application/pdf';
    try { inspectMedia(item.content, contentType); }
    catch { return { ...result, note: 'Содержимое файла не соответствует поддерживаемому формату.' }; }
    return { ...result, supported: true, contentType, bytes: item.content,
      note: extension === 'pdf' ? 'PDF: наличие векторных объектов нужно проверить отдельно.' : 'Исходник CorelDRAW. Предпросмотр не выполняется.' };
  });
  // MIME part IDs 1..50 never change. Linked files occupy the separate 51..99 range.
  const linked = diskLinks([mail.html || '', ...mail.attachments.filter(item => item.contentType === 'text/html').map(item => item.content.toString('utf8'))].join('\n'), mail.text);
  attachments.push(...linked.map((link, index) => ({ partId: String(51 + index), name: link.name, link, supported: true,
    note: 'Оригинал с Яндекс Диска. Получение и проверка выполняются автоматически.' })));
  return { message, attachments, ...(includeMedia ? { media: mail.attachments.map((item, index) => ({
    partId: String(index + 1), name: String(item.filename || `Вложение ${index + 1}`).slice(0, 1000),
    mime: item.contentType, size: item.content.length, bytes: item.content,
  })) } : {}) };
}

export function previewLayoutEmail(parsed, orders) {
  return { message: parsed.message, attachments: parsed.attachments.map(({ bytes: _bytes, ...item }) => ({ ...item,
    candidates: item.supported ? matchOrders(parsed.message, item.name, orders) : [] })),
    orders: orders.map(({ id, title, client, status }) => ({ id, title, client, status })) };
}

export function attachmentSource(message, partId) {
  return { key: hash(`${message.from}\n${message.messageId}\n${partId}`), from: message.from,
    messageId: message.messageId, partId, subject: message.subject, sentAt: message.sentAt };
}
