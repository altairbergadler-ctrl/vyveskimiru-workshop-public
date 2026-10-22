import crypto from 'node:crypto';
import {
  AnalyticsError,
  periodFrom,
  definitions,
  connections,
} from './contracts.mjs';
import {
  buildReport,
  projectFinance,
  projectOrders,
  projectProduction,
  projectWarehouse,
} from './metrics.mjs';

const catalog = {
  finance: ['Деньги', projectFinance],
  orders: ['Заказы и клиенты', projectOrders],
  production: ['Производство', projectProduction],
  warehouse: ['Склад', projectWarehouse],
};
// Read projections only. No writer, token, external ad request or second business database.
// Single-flight cache bounds Google reads independently of the number of open tabs/filters.
export class AnalyticsService {
  constructor({
    readers,
    connectionReader = () => ({}),
    now = () => new Date(),
    ttlMs = 300_000,
    cooldownMs = 30_000,
    sourceIds = Object.keys(catalog),
  }) {
    this.readers = readers;
    this.connectionReader = connectionReader;
    this.now = now;
    this.ttlMs = ttlMs;
    this.cooldownMs = cooldownMs;
    this.catalog = Object.fromEntries(
      Object.entries(catalog).filter(([id]) => sourceIds.includes(id)),
    );
    this.lastAttempt = null;
    this.inFlight = null;
    this.snapshotId = null;
    this.sources = Object.fromEntries(
      Object.entries(this.catalog).map(([id, [label]]) => [
        id,
        {
          id,
          label,
          state: 'unavailable',
          startedAt: null,
          loadedAt: null,
          checkedAt: null,
          data: null,
          code: null,
        },
      ]),
    );
  }
  async refresh(force = false) {
    if (this.inFlight) return this.inFlight;
    if (
      this.lastAttempt !== null &&
      this.now().getTime() - this.lastAttempt <
        (force ? this.cooldownMs : this.ttlMs)
    )
      return;
    this.lastAttempt = this.now().getTime();
    this.inFlight = this.load().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }
  async load() {
    const results = await Promise.all(
      Object.entries(this.catalog).map(async ([id, [, project]]) => {
        const old = this.sources[id],
          startedAt = this.now().toISOString();
        try {
          const data = project(await this.readers[id]());
          return [
            id,
            {
              ...old,
              data,
              state: 'ready',
              startedAt,
              loadedAt: this.now().toISOString(),
              checkedAt: this.now().toISOString(),
              code: null,
            },
          ];
        } catch (error) {
          return [
            id,
            {
              ...old,
              state: old.data ? 'stale' : 'unavailable',
              checkedAt: this.now().toISOString(),
              code:
                error instanceof AnalyticsError
                  ? error.code
                  : 'ANALYTICS_SOURCE_UNAVAILABLE',
            },
          ];
        }
      }),
    );
    // Publish the whole attempt together; a failed source retains its last successful data and timestamp.
    this.sources = Object.fromEntries(results);
    this.snapshotId = crypto.randomUUID();
  }
  async report(params) {
    const period = periodFrom(params, this.now());
    await this.refresh(params.get('refresh') === '1');
    const result = buildReport(
      this.sources,
      period,
      this.snapshotId,
      this.now().toISOString(),
    );
    result.acquisition.connections = this.connections();
    result.refreshAfterSeconds = Math.max(
      0,
      Math.ceil(
        (this.cooldownMs - (this.now().getTime() - this.lastAttempt)) / 1000,
      ),
    );
    return result;
  }
  connections() {
    const overrides = this.connectionReader();
    return connections.map((c) => ({ ...c, ...overrides[c.id] }));
  }
  status() {
    return {
      initialized: Boolean(this.snapshotId),
      loading: Boolean(this.inFlight),
      sources: Object.values(this.sources).map(
        ({ id, state, loadedAt, code }) => ({ id, state, loadedAt, code }),
      ),
    };
  }
  async handle(request, response, url, json) {
    if (request.method !== 'GET')
      return json(
        response,
        405,
        { error: 'Аналитика доступна только для чтения.' },
        { Allow: 'GET' },
      );
    if (url.pathname === '/api/analytics/metric-definitions')
      return json(response, 200, { definitions });
    if (url.pathname === '/api/analytics/connections')
      return json(response, 200, { connections: this.connections() });
    if (url.pathname !== '/api/analytics/overview')
      return json(response, 404, { error: 'Отчёт не найден.' });
    try {
      return json(response, 200, await this.report(url.searchParams));
    } catch (error) {
      const safe =
        error instanceof AnalyticsError
          ? error
          : new AnalyticsError(
              'ANALYTICS_UNAVAILABLE',
              'Не удалось подготовить отчёт. Попробуйте обновить его.',
            );
      return json(response, safe.statusCode, {
        error: safe.message,
        code: safe.code,
      });
    }
  }
}
