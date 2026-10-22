import { AnalyticsError, periodFrom, isDate, shiftDate } from './contracts.mjs';
import { sumMoney, projectOrders } from './metrics.mjs';
import { attributedFacts } from './nightly-attribution.mjs';
import { categoryId } from './categories.mjs';
import { dailyItemsView } from './daily-items.mjs';

const avitoSource = (value) => /^(авито|avito)$/iu.test(String(value).trim());
const within = (date, period) =>
  isDate(date) && date >= period.from && date <= period.to;
const ratio = (a, b, scale = 1) =>
  a == null || b == null || b <= 0 ? null : (a / b) * scale;
const sum = (values) => sumMoney(values, (v) => v);
const subtract = (a, b) => (a == null || b == null ? null : sum([a, -b]));

export function orderService(order, catalog, mappings) {
  const products = catalog?.products || [];
  const manual = mappings.find(m => m.kind === 'order' && m.entityId === order.id);
  if (manual) return products.some(p => p.id === categoryId(catalog,manual.productId)) ? categoryId(catalog,manual.productId) : null;
  const ids = order.items.map(item => {
    const positions = (catalog?.positions || []).filter(p => p.sourcePosition === `position:${order.id}:${item.row}`);
    return positions.length === 1 && products.some(p => p.id === positions[0].productId) ? positions[0].productId : null;
  });
  return ids.length && ids.every(id => id && id === ids[0]) ? ids[0] : null;
}

export function buildLiveReport({
  period,
  business,
  finance,
  catalog,
  ads,
  mappings,
  confirmedLinks = null,
  responses = null,
}) {
  const allOrders = business?.orders || [],
    clients = business?.clients;
  const avitoOrders = allOrders.filter((o) => avitoSource(o.source));
  const periodOrders = avitoOrders.filter(
    (o) => o.status !== 'Отменён' && within(o.createdDate, period),
  );
  const records = finance?.records || [];
  const payments = records.filter(
    (r) =>
      r.type === 'income' &&
      within(r.date, period) &&
      avitoOrders.some((o) => o.id === r.orderNumber),
  );
  const products = catalog?.products || [];
  const mapping = (kind, id) =>
    mappings.find((m) => m.kind === kind && m.entityId === id);
  const service = order => orderService(order, catalog, mappings);
  // Read the existing confirmed links; pending nightly suggestions are not facts.
  const confirmed = business && confirmedLinks !== null
    ? new Map(attributedFacts({links: confirmedLinks, orders: allOrders, records: finance?.records, period})
      .map(fact => [fact.itemId, fact]))
    : null;
  const orderRows = avitoOrders
    .filter(
      (o) =>
        within(o.createdDate, period) ||
        payments.some((p) => p.orderNumber === o.id),
    )
    .map((o) => ({
      id: o.id,
      title: o.title,
      client: o.client || '',
      date: o.createdDate,
      status: o.status,
      amount: o.amount,
      profit: o.profit,
      receipts: finance
        ? sumMoney(
            payments.filter((p) => p.orderNumber === o.id),
            (p) => p.amount,
          )
        : null,
      productId: service(o),
      mapping: mapping('order', o.id) || null,
      periodOrder: periodOrders.some((p) => p.id === o.id),
    }));
  const unassignedOrders = periodOrders.filter((o) => !service(o));
  const unassignedPayments = payments.filter(
    (p) => !service(avitoOrders.find((o) => o.id === p.orderNumber)),
  );
  const rows = (ads.rows || []).map((ad) => {
    const m = mapping('ad', ad.id),
      productId = products.some((p) => p.id === categoryId(catalog,m?.productId))
        ? categoryId(catalog,m.productId)
        : null;
    const fact = confirmed?.get(ad.id);
    const hasOrders = (fact?.orderIds.length ?? 0) > 0;
    const spend = ad.metrics?.spending == null ? null : ad.metrics.spending / 100;
    // Profit is tied to orders created in the period; payments may be for older orders.
    const profit = !confirmed ? null : fact?.orders > 0 ? fact.profit : 0;
    const result = subtract(profit, spend);
    return {
      id: ad.id,
      title: ad.title,
      status: ad.status,
      url: ad.url,
      productId,
      mapping: m || null,
      impressions: ad.metrics?.impressions ?? null,
      views: ad.metrics?.views ?? null,
      contacts: ad.metrics?.contacts ?? null,
      spend,
      contactRate: ad.rates?.contactRate ?? null,
      costContact: ad.rates?.costContact ?? null,
      receipts: hasOrders ? fact.receipts : null,
      orders: confirmed ? (fact?.orders ?? 0) : null,
      profit,
      result,
      romi: ratio(result, spend, 100),
      confirmedOrders: confirmed ? (fact?.orders ?? 0) : null,
      orderRate: fact?.orders > 0 ? ratio(fact.orders, ad.metrics?.contacts ?? null, 100) : null,
      firstResponseSeconds: responses?.items[ad.id]?.averageSeconds ?? null,
      responseStats: responses?.items[ad.id] ?? null,
      reason: !confirmed ? 'Данные заказов или подтверждённых связей недоступны'
        : spend == null ? 'Расходы Авито неизвестны'
        : !fact?.orders ? 'Нет подтверждённых заказов за период: результат равен минус расходам на рекламу; сопоставление может быть неполным'
        : profit == null ? 'Нет расчёта прибыли подтверждённого заказа'
        : 'По подтверждённым заказам; сопоставление может быть неполным',
    };
  });
  const serviceRows = products.map((product) => {
    const group = rows.filter((a) => a.productId === product.id);
    const orders = periodOrders.filter((o) => service(o) === product.id);
    const income = payments.filter(
      (p) =>
        service(avitoOrders.find((o) => o.id === p.orderNumber)) ===
        product.id,
    );
    const receipts =
      finance && business ? sumMoney(income, (p) => p.amount) : null;
    const profit = business ? sumMoney(orders, (o) => o.profit) : null;
    const contacts =
      group.length && group.every((a) => a.contacts != null)
        ? group.reduce((n, a) => n + a.contacts, 0)
        : null;
    const knownSpend = group.filter(a => a.spend != null);
    const spendComplete = ads.spendComplete === true && group.length > 0;
    const spend = knownSpend.length ? sumMoney(knownSpend, a => a.spend)
      : spendComplete ? 0 : null;
    return {
      ...product,
      adCount: group.length,
      contacts,
      orders: business ? orders.length : null,
      receipts,
      spend,
      spendComplete,
      result: spendComplete ? subtract(profit, spend) : null,
      profit,
    };
  });
  const sourceClients = clients?.filter((c) => avitoSource(c.source)) ?? null;
  const cohort =
    sourceClients?.filter((c) => within(c.createdDate, period)) ?? null;
  const cohortOrders = avitoOrders.filter(
    (o) =>
      o.status !== 'Отменён' &&
      isDate(o.createdDate) &&
      o.createdDate <= period.to &&
      cohort?.some(
        (c) => c.row === o.clientRow && o.createdDate >= c.createdDate,
      ),
  );
  const cohortPaid = new Set(
    cohortOrders
      .filter((o) =>
        records.some(
          (p) =>
            p.type === 'income' &&
            p.amount > 0 &&
            p.orderNumber === o.id &&
            isDate(p.date) &&
            p.date >= o.createdDate &&
            p.date <= period.to,
        ),
      )
      .map((o) => o.clientRow),
  );
  const spend =
    ads.summary?.spending == null ? null : ads.summary.spending / 100;
  const receipts =
    finance && business ? sumMoney(payments, (p) => p.amount) : null;
  const profit = business ? sumMoney(periodOrders, (o) => o.profit) : null;
  const spendComplete = ads.spendComplete === true && spend != null;
  const result = spendComplete ? subtract(profit, spend) : null;
  const linkedIds = new Set(confirmed ? [...confirmed.values()].flatMap(f => f.orderIds) : []);
  const allocated = finance && business && confirmed
    ? sumMoney(payments.filter(p => linkedIds.has(p.orderNumber)), p => p.amount)
    : null;
  return {
    period,
    responses: responses ? { ...responses, items: undefined, daily: undefined } : null,
    products: serviceRows,
    rows,
    orders: orderRows,
    clients:
      cohort?.map((c) => ({
        name: c.name,
        date: c.createdDate,
        orders: cohortOrders.filter((o) => o.clientRow === c.row).length,
      })) ?? null,
    summary: {
      spend,
      spendComplete,
      receipts,
      profit,
      result,
      romi: ratio(result, spend, 100),
      roas: spendComplete ? ratio(receipts, spend) : null,
      orders: business ? periodOrders.length : null,
      newClients: cohort?.length ?? null,
      contacts: ads.summary?.contacts ?? null,
      views: ads.summary?.views ?? null,
      impressions: ads.summary?.impressions ?? null,
      clientsWithOrders: cohort
        ? new Set(cohortOrders.map((o) => o.clientRow)).size
        : null,
      cohortOrders: cohort ? cohortOrders.length : null,
      paidClients: cohort && finance ? cohortPaid.size : null,
      allocated,
      unallocated: subtract(receipts, allocated),
      unassignedOrders: unassignedOrders.length,
      unassignedReceipts: sumMoney(unassignedPayments, (p) => p.amount),
    },
    quality: {
      missingClientDates:
        sourceClients?.filter((c) => !isDate(c.createdDate)).length ?? null,
      unknownOrderSources: allOrders.filter(
        (o) => within(o.createdDate, period) && !o.sourceKnown,
      ).length,
      unknownPaymentSource:
        finance && business
          ? sumMoney(
              records.filter(
                (r) =>
                  r.type === 'income' &&
                  within(r.date, period) &&
                  !allOrders.some(
                    (o) => o.id === r.orderNumber && o.sourceKnown,
                  ),
              ),
              (r) => r.amount,
            )
          : null,
      issues: business?.issues || [],
    },
    daily: Array.from({ length: period.days }, (_, i) => {
      const date = shiftDate(period.from, i),
        ad = ads.daily?.find((d) => d.date === date);
      return {
        date,
        responseSecondsTotal: responses?.indexedChats ? (responses.daily[date]?.secondsTotal ?? 0) : null,
        responseAnswered: responses?.indexedChats ? (responses.daily[date]?.answered ?? 0) : null,
        responseWaiting: responses?.indexedChats ? (responses.daily[date]?.waiting ?? 0) : null,
        receipts:
          finance && business
            ? sumMoney(
                payments.filter((p) => p.date === date),
                (p) => p.amount,
              )
            : null,
        spend: ad?.metrics?.spending == null ? null : ad.metrics.spending / 100,
        contacts: ad?.metrics?.contacts ?? null,
        impressions: ad?.metrics?.impressions ?? null,
        views: ad?.metrics?.views ?? null,
        orders: business ? periodOrders.filter((o) => o.createdDate === date).length : null,
        profit: business ? sumMoney(periodOrders.filter((o) => o.createdDate === date), (o) => o.profit) : null,
      };
    }),
    avito: {
      enabled: ads.enabled,
      loadedAt: ads.loadedAt ?? null,
      stale: ads.stale ?? false,
      reported: ads.reportedItems ?? 0,
      inventory: ads.inventoryItems ?? 0,
      withoutStats: ads.coverage?.withoutStats ?? 0,
      jobs: (ads.jobs || [])
        .filter((j) => j.from === period.from && j.to === period.to)
        .slice(0, 1),
      failures: ads.failures?.length ?? 0,
    },
  };
}

export class LiveAnalytics {
  constructor({
    analytics,
    base,
    deep,
    readProducts,
    readOrders,
    runCommand,
    attribution,
    responseTimes,
    now = () => new Date(),
  }) {
    Object.assign(this, {
      analytics,
      base,
      deep,
      readProducts,
      readOrders,
      runCommand,
      attribution,
      responseTimes,
      now,
    });
    this.catalog = null;
    this.catalogAt = null;
    this.catalogAttempt = 0;
    this.catalogFlight = null;
    this.catalogState = 'unavailable';
  }
  storage() {
    const db = this.base.storage();
    db.exec(`CREATE TABLE IF NOT EXISTS analytics_service_links(account TEXT NOT NULL,kind TEXT NOT NULL,entity_id TEXT NOT NULL,product_id TEXT,revision INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(account,kind,entity_id));
      CREATE TABLE IF NOT EXISTS analytics_service_link_history(id INTEGER PRIMARY KEY AUTOINCREMENT,account TEXT NOT NULL,kind TEXT NOT NULL,entity_id TEXT NOT NULL,product_id TEXT,revision INTEGER NOT NULL,updated_at TEXT NOT NULL);`);
    return db;
  }
  mappings() {
    return this.storage()
      .prepare(
        'SELECT kind,entity_id AS entityId,product_id AS productId,revision,updated_at AS updatedAt FROM analytics_service_links WHERE account=?',
      )
      .all(this.base.namespace());
  }
  async loadCatalog(force = false) {
    if (this.catalogFlight) return this.catalogFlight;
    if (this.now().getTime() - this.catalogAttempt < (force ? 30000 : 300000))
      return;
    this.catalogAttempt = this.now().getTime();
    this.catalogFlight = (async () => {
      try {
        const catalog = await this.runCommand(() => this.readProducts());
        if (!['production-routes','analytics-categories'].includes(catalog.source)) throw new Error();
        this.catalog = catalog;
        this.catalogAt = this.now().toISOString();
        this.catalogState = 'ready';
      } catch {
        this.catalogState = this.catalog ? 'stale' : 'unavailable';
      }
    })().finally(() => {
      this.catalogFlight = null;
    });
    return this.catalogFlight;
  }
  async report(params) {
    const period = periodFrom(params, this.now());
    // Use the same bounded provider policy as the existing Avito importer.
    const ads = this.deep.view({ dateFrom: period.from, dateTo: period.to });
    await Promise.all([
      this.analytics.refresh(params.get('refresh') === '1'),
      this.loadCatalog(params.get('refresh') === '1'),
    ]);
    const attribution = this.attribution?.view() ?? null;
    return {
      ...buildLiveReport({
        period,
        business: this.analytics.sources.orders.data,
        finance: this.analytics.sources.finance.data,
        catalog: this.catalog,
        ads,
        mappings: this.mappings(),
        confirmedLinks: attribution?.links ?? null,
        responses: this.responseTimes?.view(period) ?? null,
      }),
      generatedAt: this.now().toISOString(),
      dailyItems: this.deep?.db ? dailyItemsView(this.deep,{dateFrom:period.from,dateTo:period.to}) : null,
      serviceAutomation: this.serviceAutomation?.view() ?? null,
      adServiceAutomation: this.adServiceAutomation?.view() ?? null,
      attribution: attribution ? {
        ...attribution,
        facts: this.analytics.sources.orders.data ? attributedFacts({links:attribution.links,
          orders:this.analytics.sources.orders.data.orders,records:this.analytics.sources.finance.data?.records,period}) : [],
      } : null,
      sources: [
        ...['orders', 'finance'].map((k) => {
          const s = this.analytics.sources[k];
          return { label: s.label, state: s.state, loadedAt: s.loadedAt };
        }),
        { label: 'Услуги', state: this.catalogState, loadedAt: this.catalogAt },
      ],
    };
  }
  // Host runs writes in the shared command queue. This method never enqueues inside it.
  async save(input) {
    if (
      !input ||
      Object.keys(input).some(
        (k) =>
          !['kind', 'entityId', 'productId', 'expectedRevision'].includes(k),
      ) ||
      !['ad', 'order'].includes(input.kind) ||
      typeof input.entityId !== 'string' ||
      !input.entityId ||
      input.entityId.length > 160 ||
      !(input.productId === null || typeof input.productId === 'string') ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    )
      throw new AnalyticsError(
        'LINK_INVALID',
        'Некорректная связь услуги.',
        400,
      );
    const products = await this.readProducts();
    if (!['production-routes','analytics-categories'].includes(products.source))
      throw new AnalyticsError(
        'CATALOG_UNAVAILABLE',
        'Не удалось прочитать услуги. Повторите позже.',
      );
    if (
      input.productId !== null &&
      !products.products.some((p) => p.id === input.productId)
    )
      throw new AnalyticsError(
        'PRODUCT_MISSING',
        'Услуга уже недоступна. Обновите страницу.',
        409,
      );
    const exists =
      input.kind === 'ad'
        ? this.deep
            .view(this.base.currentPeriod())
            .rows.some((a) => a.id === input.entityId)
        : projectOrders(await this.readOrders()).orders.some(
            (o) => o.id === input.entityId && avitoSource(o.source),
          );
    if (!exists)
      throw new AnalyticsError(
        'ENTITY_MISSING',
        'Объявление или заказ уже недоступны. Обновите страницу.',
        409,
      );
    const db = this.storage(),
      account = this.base.namespace();
    return db.transaction(() => {
      const old = db
        .prepare(
          'SELECT * FROM analytics_service_links WHERE account=? AND kind=? AND entity_id=?',
        )
        .get(account, input.kind, input.entityId);
      if (old && old.product_id === input.productId)
        return { saved: true, revision: old.revision };
      if ((old?.revision ?? 0) !== input.expectedRevision)
        throw new AnalyticsError(
          'LINK_CONFLICT',
          'Связь изменилась в другой вкладке. Обновите данные и выберите услугу заново.',
          409,
        );
      const revision = (old?.revision ?? 0) + 1,
        at = this.now().toISOString();
      const values = [
        account,
        input.kind,
        input.entityId,
        input.productId,
        revision,
        at,
      ];
      db.prepare(
        'INSERT INTO analytics_service_links VALUES(?,?,?,?,?,?) ON CONFLICT(account,kind,entity_id) DO UPDATE SET product_id=excluded.product_id,revision=excluded.revision,updated_at=excluded.updated_at',
      ).run(...values);
      db.prepare(
        'INSERT INTO analytics_service_link_history(account,kind,entity_id,product_id,revision,updated_at) VALUES(?,?,?,?,?,?)',
      ).run(...values);
      return { saved: true, revision };
    })();
  }
  async handle(request, response, url, json, body) {
    try {
      if (request.method === 'PUT' && url.pathname === '/api/analytics/live/attribution' && !url.search && this.attribution)
        return json(response,200,await this.attribution.decide(await body(request,4096)));
      if (request.method === 'GET' && url.pathname === '/api/analytics/live')
        return json(response, 200, await this.report(url.searchParams));
      if (
        request.method === 'PUT' &&
        url.pathname === '/api/analytics/live/links' &&
        !url.search
      )
        return json(response, 200, await this.save(await body(request, 4096)));
      return json(response, 405, { error: 'Метод недоступен.' });
    } catch (e) {
      return json(response, e.statusCode || 503, {
        error:
          e instanceof AnalyticsError
            ? e.message
            : 'Не удалось загрузить аналитику. Проверьте период и повторите.',
        code: e.code || 'LIVE_UNAVAILABLE',
      });
    }
  }
}
