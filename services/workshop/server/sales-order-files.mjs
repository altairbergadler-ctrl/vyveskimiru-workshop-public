import { SalesError, salesHash } from './sales-desk.mjs';
import { salesOrderRequestId } from './sales-order.mjs';
import { verifiedOrderCreation } from '../modules/orders/server/creation.mjs';

// This receipt continues the existing, human-confirmed order creation. It never
// creates an order, edits finance, or collects correspondence in the background.
export class SalesOrderFiles {
  constructor({ desk, sources, mediaStore, creationDirectory, readOrders }) {
    Object.assign(this, {
      desk,
      sources,
      mediaStore,
      creationDirectory,
      readOrders,
    });
    this.flights = new Map();
    desk.db.exec(
      'CREATE TABLE IF NOT EXISTS sales_order_transfers(note_id TEXT PRIMARY KEY,order_id TEXT NOT NULL,data TEXT NOT NULL)',
    );
  }
  step(input) {
    if (typeof input?.noteId !== 'string' || typeof input?.orderId !== 'string')
      throw new SalesError(
        'SALES_INPUT',
        'Выберите карточку и созданный заказ.',
      );
    const key = JSON.stringify([input.noteId, input.orderId]);
    if (this.flights.has(key)) return this.flights.get(key);
    const flight = this.run(input).finally(() => this.flights.delete(key));
    this.flights.set(key, flight);
    return flight;
  }
  async run({ noteId, orderId }) {
    const desk = this.desk,
      options = { journalDir: this.creationDirectory };
    if (
      !this.mediaStore ||
      verifiedOrderCreation(salesOrderRequestId(noteId, options), options) !==
        orderId
    )
      throw new SalesError(
        'SALES_ORDER_UNCONFIRMED',
        'Сначала подтвердите создание заказа из этой карточки.',
        409,
      );
    if (!(await this.readOrders()).orders.some((o) => String(o.id) === orderId))
      throw new SalesError('SALES_ORDER_NOT_FOUND', 'Заказ не найден.', 404);
    let note = desk.note(noteId);
    if (note.orderId && note.orderId !== orderId)
      throw new SalesError(
        'SALES_ORDER_LINKED',
        'Карточка связана с другим заказом.',
        409,
      );
    const row = desk.db
      .prepare('SELECT * FROM sales_order_transfers WHERE note_id=?')
      .get(noteId);
    if (row && row.order_id !== orderId)
      throw new SalesError(
        'SALES_ORDER_LINKED',
        'Перенос файлов уже начат в другой заказ.',
        409,
      );
    const progress = row
      ? JSON.parse(row.data)
      : {
          entries: [
            ...desk
              .files(noteId)
              .map((f) => ({ kind: 'manual', id: f.id, hash: f.hash })),
            ...desk
              .events(noteId)
              .filter(
                (e) =>
                  e.source !== 'avito' ||
                  ['image', 'voice', 'file'].includes(e.type),
              )
              .map((e) => ({
                kind: 'event',
                id: e.id,
                version: e.version,
                revision: e.revision,
              })),
          ],
          cursor: 0,
          attached: 0,
          unavailable: [],
        };
    progress.retry ||= [];
    // A finished attempt may be resumed from any tab using the durable receipt.
    // Only temporary failures are retried; other files are never held behind them.
    if (progress.cursor >= progress.entries.length && progress.retry.length) {
      progress.entries = progress.retry;
      progress.retry = [];
      progress.cursor = 0;
    }
    const save = () =>
      desk.db
        .prepare(
          'INSERT INTO sales_order_transfers VALUES(?,?,?) ON CONFLICT(note_id) DO UPDATE SET data=excluded.data',
        )
        .run(noteId, orderId, JSON.stringify(progress));
    // Linking and the first durable manifest are one SQLite transaction.
    // A storage failure cannot leave a linked order with no resumable status.
    desk.db.transaction(() => {
      if (!note.orderId) {
        desk.writable(note);
        desk.command({
          requestId: 'order-link-' + noteId + '-' + orderId,
          action: 'note.update',
          data: { id: noteId, revision: note.revision, patch: { orderId } },
        });
        note = desk.note(noteId);
      }
      if (!row) save();
    })();
    const item = progress.entries[progress.cursor];
    if (item) {
      const current = () =>
        item.kind === 'manual'
          ? desk
              .files(noteId)
              .find((f) => f.id === item.id && f.hash === item.hash)
          : desk
              .events(noteId)
              .find(
                (e) =>
                  e.id === item.id &&
                  e.version === item.version &&
                  e.revision === item.revision &&
                  !e.deleted,
              );
      const valid = () => {
        const latest = desk.note(noteId);
        return (
          !latest.trashedAt && latest.orderId === orderId && Boolean(current())
        );
      };
      const unavailable = (reason, partId = '') => {
        if (
          !progress.unavailable.some(
            (f) => f.id === item.id && f.partId === partId,
          )
        )
          progress.unavailable.push({ id: item.id, partId, reason });
      };
      const retry = (error) => {
        if (!valid()) unavailable('Связь или источник изменились.');
        else if (!progress.retry.some((e) => e.id === item.id))
          progress.retry.push({
            ...item,
            code:
              typeof error.code === 'string'
                ? error.code
                : 'TRANSFER_UNAVAILABLE',
          });
      };
      if (!valid()) unavailable('Связь или источник изменились.');
      else
        try {
          const parts =
            item.kind === 'manual'
              ? [{ partId: 'manual', name: current().name, available: true }]
              : (await this.sources.media.event(item.id)).media;
          if (!parts.length && item.kind === 'event')
            unavailable('Источник не передал файл.');
          for (const part of parts) {
            try {
              const key = salesHash([
                'sales',
                orderId,
                noteId,
                item.id,
                part.partId,
              ]);
              if (await this.mediaStore.attachment(orderId, key)) continue;
              if (!part.available) {
                unavailable(
                  part.reason || 'Источник не передал файл.',
                  part.partId,
                );
                continue;
              }
              let file;
              try {
                file =
                  item.kind === 'manual'
                    ? desk.storedFile(item.id)
                    : await this.sources.media.file(
                        new URLSearchParams({
                          eventId: item.id,
                          partId: part.partId,
                        }),
                        { stream: true },
                      );
                await this.mediaStore.addAttachment(orderId, {
                  ...file,
                  salesSource: { key, noteId },
                  validateSource: valid,
                });
                progress.attached++;
                save();
              } finally {
                await file?.dispose?.();
              }
            } catch (error) {
              retry(error);
            }
          }
        } catch (error) {
          retry(error);
        }
      progress.cursor++;
      save();
    }
    return {
      done: progress.cursor >= progress.entries.length,
      processed: progress.cursor,
      total: progress.entries.length,
      attached: (await this.mediaStore.list(orderId)).items.filter(
        (f) => f.salesSource?.noteId === noteId,
      ).length,
      unavailable: progress.unavailable.length,
      pending: progress.retry.length,
    };
  }
}
