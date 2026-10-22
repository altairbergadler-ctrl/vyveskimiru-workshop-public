import { AvitoError } from '../avito.mjs';
import { AnalyticsError, periodFrom } from './contracts.mjs';
import { matchInquiries } from './inquiry-matching.mjs';
export class InquiryService {
  constructor({ importer, readOrders, now = Date.now }) {
    Object.assign(this, { importer, readOrders, now });
    this.board = null;
    this.loadedAt = null;
    this.attemptAt = 0;
    this.flight = null;
    this.error = false;
  }
  async orders(force = false) {
    if (this.flight) return this.flight;
    if (
      this.attemptAt &&
      this.now() - this.attemptAt < (force ? 30000 : 300000)
    )
      return;
    this.attemptAt = this.now();
    this.flight = (async () => {
      try {
        const value = await this.readOrders();
        if (!Array.isArray(value?.orders)) throw new Error();
        this.board = value;
        this.loadedAt = new Date(this.now()).toISOString();
        this.error = false;
      } catch {
        this.error = true;
      }
    })();
    try {
      await this.flight;
    } finally {
      this.flight = null;
    }
  }
  async view(params) {
    if (
      [...params.keys()].some(
        (k) =>
          !['from', 'to', 'refresh', 'window', 'mode'].includes(k) ||
          params.getAll(k).length !== 1,
      )
    )
      throw new AvitoError('invalid', 400);
    const windowDays = Number(params.get('window') || 90),
      mode = params.get('mode') || 'all';
    if (
      ![14, 30, 90].includes(windowDays) ||
      !['strong', 'possible', 'all'].includes(mode)
    )
      throw new AvitoError('invalid', 400);
    const dates = new URLSearchParams(params);
    dates.delete('window');
    dates.delete('mode');
    const period = periodFrom(dates, new Date(this.now()));
    await this.orders(params.get('refresh') === '1');
    if (!this.board)
      throw new AnalyticsError(
        'MATCH_ORDERS',
        'Не удалось прочитать заказы. Повторите обновление.',
      );
    const source = this.importer.view();
    const report = matchInquiries({
      board: this.board,
      chats: source.chats,
      period,
      key: source.enabled ? this.importer.secret() : 'disabled',
      windowDays,
      mode,
      generatedAt: new Date(this.now()).toISOString(),
    });
    return {
      ...report,
      ordersLoadedAt: this.loadedAt,
      ordersStale: this.error,
      source: { ...source, chats: undefined },
      coverage: {
        loadedDialogs: source.chats.length,
        dialogsWithMessages: source.chats.filter((c) => c.signals).length,
        dialogsWithIncoming: source.chats.filter(
          (c) => c.signals?.incomingCount > 0,
        ).length,
        truncatedDialogs: source.chats.filter((c) => c.signals?.hasMore).length,
        staleDialogs: source.chats.filter(
          (c) => c.signals && c.signals.sourceUpdatedAt !== c.updatedAt,
        ).length,
      },
    };
  }
  async handle(request, response, url, json, body) {
    const headers = { 'Cache-Control': 'private, no-store' };
    try {
      if (url.pathname.endsWith('/import')) {
        if (request.method !== 'POST')
          return json(response, 405, { error: 'Метод недоступен.' }, headers);
        const input = await body(request, 1024);
        if (
          url.search ||
          !input ||
          typeof input !== 'object' ||
          Array.isArray(input) ||
          Object.keys(input).length
        )
          throw new AvitoError('invalid', 400);
        return json(response, 202, this.importer.start(), headers);
      }
      if (request.method !== 'GET')
        return json(response, 405, { error: 'Метод недоступен.' }, headers);
      return json(response, 200, await this.view(url.searchParams), headers);
    } catch (error) {
      const safe =
        error instanceof AvitoError || error instanceof AnalyticsError
          ? error
          : new AvitoError('storage');
      return json(
        response,
        safe.statusCode === 401 ? 502 : safe.statusCode,
        { error: safe.message, code: safe.code },
        headers,
      );
    }
  }
}
