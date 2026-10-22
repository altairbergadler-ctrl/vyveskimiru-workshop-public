import fs from 'node:fs';
import crypto from 'node:crypto';
import { listingFields, detailInput, parseTraffic, parseCalls, parseServices, parseItemInfo, sourceId } from './avito-details.mjs';
import { chatId, parseChats, parseMessages } from './avito-inquiries.mjs';

// Contract inspected 2026-09-08: https://www.avito.ru/web/1/openapi/info/{auth,item,user}
// Only the personal account read APIs below are exposed. No arbitrary URL or method.
export const AVITO_METRICS = Object.freeze({
  impressions: 'count', views: 'count', contacts: 'count', favorites: 'count',
  contactsShowPhone: 'count', contactsMessenger: 'count', contactsShowPhoneAndMessenger: 'count', contactsSbcDiscount: 'count',
  activeItems:'count', newActiveItems:'count', oldActiveItems:'count',
  spending: 'RUB_minor', spendingBonus: 'provider_bonus_units', allSpending: 'RUB_minor',
  presenceSpending: 'RUB_minor', promoSpending: 'RUB_minor', restSpending:'RUB_minor', commission:'RUB_minor',
});
const messages = {
  disabled: 'Подключение Авито выключено.',
  credentials: 'Нужен закрытый файл с client_id и client_secret Авито.',
  configuration: 'Проверьте настройки подключения Авито.',
  storage: 'Недоступен журнал ограничений запросов Авито.',
  invalid: 'Недопустимые параметры запроса Авито.',
  account_mismatch: 'Ключи Авито относятся к другому кабинету.',
  unauthorized: 'Авито отклонил авторизацию. Проверьте ключи и права доступа.',
  forbidden: 'Для этого метода Авито нет доступа. Проверьте права и условия кабинета.',
  unsupported: 'Метод Авито недоступен.',
  rate_limit: 'Нужно дождаться следующего разрешённого запроса Авито.',
  unavailable: 'Авито временно недоступен. Повторите запрос позже.',
  schema: 'Ответ Авито не соответствует проверенному формату. Данные не опубликованы.',
  response_size: 'Ответ Авито превышает допустимый размер.',
  closed: 'Подключение Авито останавливается.',
  incomplete: 'Авито вернул данные не для всех запрошенных объявлений.',
};

export class AvitoError extends Error {
  constructor(code, statusCode = 503, retryAfterSeconds = null) {
    super(messages[code] || messages.unavailable);
    this.name = 'AvitoError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function avitoConfig(env = process.env) {
  return { enabled: env.AVITO_ENABLED === 'true', credentialsFile: env.AVITO_CREDENTIALS_FILE || '',
    expectedAccountId: env.AVITO_ACCOUNT_ID || '' };
}

function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AvitoError('schema', 502);
  return value;
}
function hasControl(value) { return ['\r', '\n', '\0'].some(character => value.includes(character)); }
function accountId(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^[1-9]\d{0,15}$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new AvitoError('schema', 502);
  }
  return String(value);
}
function dateValue(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AvitoError('invalid', 400);
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new AvitoError('invalid', 400);
  return time;
}
function inputObject(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) {
    throw new AvitoError('invalid', 400);
  }
}

export function validateAvitoReport(input, now = Date.now(), maxDays = 31) {
  inputObject(input, ['dateFrom', 'dateTo', 'grouping', 'offset']);
  const start = dateValue(input.dateFrom), end = dateValue(input.dateTo);
  // This is the connector's bounded request policy, not a claim about the account's timezone.
  const today = Math.floor(now / 86400000) * 86400000;
  if (end < start || end - start > (Math.min(270, maxDays) - 1) * 86400000 || start < today - 269 * 86400000 || end > today) throw new AvitoError('invalid', 400);
  const grouping = input.grouping ?? 'day', offset = input.offset ?? 0;
  if (!['day', 'item', 'totals'].includes(grouping) || !Number.isSafeInteger(offset) || offset < 0 || offset > 99000 || offset % 1000) {
    throw new AvitoError('invalid', 400);
  }
  if (grouping !== 'item' && offset !== 0) throw new AvitoError('invalid', 400);
  return { dateFrom: input.dateFrom, dateTo: input.dateTo, grouping, limit: 1000, offset,
    metrics: Object.keys(AVITO_METRICS) };
}

export function parseAvitoReport(value, request, loadedAt) {
  const result = requireObject(requireObject(value).result);
  // A live empty period returns only timestamp. Missing rows are not zero-valued item metrics.
  const rowsOmitted = !Object.hasOwn(result, 'groupings') && !Object.hasOwn(result, 'dataTotalCount');
  const groupings = rowsOmitted ? [] : result.groupings;
  const total = rowsOmitted ? 0 : result.dataTotalCount;
  if (!Array.isArray(groupings) || groupings.length > request.limit || !Number.isSafeInteger(total)
      || total < 0 || typeof result.timestamp !== 'string' || result.timestamp.length > 80) throw new AvitoError('schema', 502);
  const seen = new Set(), present = new Set();
  const groups = groupings.map(group => {
    requireObject(group);
    // The official example uses "dates" although the enum says "day". Preserve the source key;
    // do not infer a calendar date/timezone from this integer until an account report is reconciled.
    if (!Number.isSafeInteger(group.id) || typeof group.type !== 'string' || ![request.grouping, 'dates', ...(request.grouping === 'item' ? ['items'] : [])].includes(group.type)
        || !Array.isArray(group.metrics) || group.metrics.length > 100) throw new AvitoError('schema', 502);
    if (group.type === 'dates' && !['day', 'totals'].includes(request.grouping)) throw new AvitoError('schema', 502);
    const key = `${group.type}:${group.id}`;
    if (seen.has(key)) throw new AvitoError('schema', 502);
    seen.add(key);
    const metrics = Object.fromEntries(request.metrics.map(slug => [slug, null]));
    const metricKeys = new Set();
    for (const metric of group.metrics) {
      requireObject(metric);
      if (typeof metric.slug !== 'string' || metricKeys.has(metric.slug) || !Number.isFinite(metric.value)) throw new AvitoError('schema', 502);
      metricKeys.add(metric.slug);
      if (!Object.hasOwn(AVITO_METRICS, metric.slug)) continue;
      if (!Number.isSafeInteger(metric.value) || metric.value < 0) throw new AvitoError('schema', 502);
      metrics[metric.slug] = metric.value;
      present.add(metric.slug);
    }
    return { sourceGroupId: String(group.id), sourceGroupType: group.type, metrics };
  });
  // Live totals reports use type=dates and dataTotalCount=underlying days, with one aggregate.
  // The source count is retained; it is not the number of pages for this grouping.
  if (request.grouping === 'totals' && (groups.length > 1 || (total > 0 && !groups.length) || (!total && groups.length))) throw new AvitoError('schema', 502);
  if (request.grouping !== 'totals' && (total < request.offset + groups.length || (total > request.offset && !groups.length)
      || (total > request.offset + groups.length && groups.length < request.limit))) throw new AvitoError('schema', 502);
  if (request.grouping === 'day' && total > groups.length) throw new AvitoError('schema', 502);
  return { source: 'avito', endpointVersion: 'stats/v2/items', dateFrom: request.dateFrom, dateTo: request.dateTo,
    grouping: request.grouping, currency: 'RUB', taxBasis: 'unknown', units: AVITO_METRICS,
    sourceTimestamp: result.timestamp, sourceTimezone: 'unverified', sourceCountReturned: !rowsOmitted, loadedAt, groups,
    pagination: { offset: request.offset, limit: request.limit, total, complete: request.offset === 0 && (request.grouping === 'totals' || groups.length === total),
      nextOffset: request.grouping === 'item' && request.offset + groups.length < total ? request.offset + groups.length : null },
    availableMetrics: [...present], unreturnedMetrics: request.metrics.filter(slug => !present.has(slug)),
    warnings: ['provider_contacts_are_not_workshop_leads', 'daily_unique_values_are_not_period_unique_people',
      'source_group_dates_require_account_reconciliation', 'spending_and_bonus_are_separate', 'data_may_be_revised'],
  };
}

export class AvitoClient {
  #config; #db; #fetch; #now; #credentials = null; #token = null; #tokenFlight = null;
  #account = null; #lastCheckAt = null; #lastError = null; #capabilities;
  #initialized = false; #closed = false; #controllers = new Set();
  constructor({ config = avitoConfig(), db, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    this.#config = config; this.#db = db; this.#fetch = fetchImpl; this.#now = now;
    this.#capabilities = { identity: 'not_checked', listings: 'not_checked', statistics: 'not_checked',
      separateSpendings: 'blocked_unit_contract', availableMetrics: [] };
  }

  status() {
    const configured = Boolean(this.#config.credentialsFile);
    const failedCapability = ['identity', 'listings', 'statistics'].some(key => !['not_checked', 'available'].includes(this.#capabilities[key]));
    return { enabled: this.#config.enabled, configured, authorization: 'client_credentials',
      state: !this.#config.enabled ? 'disabled' : !configured ? 'missing_credentials' : this.#lastError || failedCapability ? 'attention_required'
        : this.#account ? 'identity_verified' : 'not_checked',
      accountId: this.#account, lastCheckAt: this.#lastCheckAt, lastError: this.#lastError,
      capabilities: structuredClone(this.#capabilities), automaticImport: false, businessWrites: false };
  }

  #ready() {
    if (this.#closed) throw new AvitoError('closed');
    if (!this.#config.enabled) throw new AvitoError('disabled', 409);
    if (this.#config.expectedAccountId && !/^[1-9]\d{0,15}$/.test(String(this.#config.expectedAccountId))) throw new AvitoError('configuration');
    if (!this.#credentials) {
      try {
        if (!this.#config.credentialsFile) throw new Error();
        const stat = fs.statSync(this.#config.credentialsFile);
        if (!stat.isFile() || stat.size > 16384 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error();
        const value = JSON.parse(fs.readFileSync(this.#config.credentialsFile, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['client_id', 'client_secret'].includes(key))) throw new Error();
        for (const key of ['client_id', 'client_secret']) {
          if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 4096 || hasControl(value[key]) || value[key].startsWith('REPLACE_')) throw new Error();
        }
        this.#credentials = value;
      } catch { throw new AvitoError('credentials'); }
    }
    if (!this.#initialized) {
      try {
        this.#db.exec(`CREATE TABLE IF NOT EXISTS avito_request_limits (
          scope TEXT NOT NULL, resource TEXT NOT NULL, next_at INTEGER NOT NULL,
          PRIMARY KEY(scope, resource))`);
        this.#initialized = true;
      } catch { throw new AvitoError('storage'); }
    }
  }

  #scope(resource) {
    return resource === 'token' ? crypto.createHash('sha256').update(this.#credentials.client_id).digest('hex') : this.#account ||
      crypto.createHash('sha256').update(this.#credentials.client_id).digest('hex');
  }

  #reserve(resource, interval) {
    const scope = this.#scope(resource), now = this.#now();
    try {
      const reserve = this.#db.transaction(() => {
        const row = this.#db.prepare('SELECT next_at FROM avito_request_limits WHERE scope=? AND resource=?').get(scope, resource);
        if (row?.next_at > now) throw new AvitoError('rate_limit', 429, Math.ceil((row.next_at - now) / 1000));
        this.#db.prepare('INSERT INTO avito_request_limits(scope,resource,next_at) VALUES(?,?,?) ON CONFLICT(scope,resource) DO UPDATE SET next_at=excluded.next_at').run(scope, resource, now + interval);
      });
      reserve.immediate();
    } catch (error) { if (error instanceof AvitoError) throw error; throw new AvitoError('storage'); }
  }

  #postpone(resource, seconds) {
    try {
      this.#db.prepare('UPDATE avito_request_limits SET next_at=MAX(next_at,?) WHERE scope=? AND resource=?')
        .run(this.#now() + seconds * 1000, this.#scope(resource), resource);
    } catch { throw new AvitoError('storage'); }
  }

  async #request(resource, pathname, { method = 'GET', form, payload, token, interval = 3000 } = {}) {
    this.#ready();
    this.#reserve(resource, interval);
    const controller = new AbortController();
    this.#controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15000);
    timeout.unref();
    try {
      const response = await this.#fetch(`https://api.avito.ru${pathname}`, {
        method, redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : payload ? { 'Content-Type': 'application/json' } : {}) },
        ...(form ? { body: new URLSearchParams(form).toString() } : payload ? { body: JSON.stringify(payload) } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 429) {
          const raw = response.headers.get('retry-after');
          const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : raw ? Math.ceil((Date.parse(raw) - this.#now()) / 1000) : 65;
          const wait = Number.isFinite(seconds) ? Math.max(65, Math.min(86400, seconds)) : 65;
          this.#postpone(resource, wait);
          throw new AvitoError('rate_limit', 429, wait);
        }
        if (response.status === 401) {
          this.#token = null; this.#account = null; this.#capabilities.identity = 'not_checked';
          throw new AvitoError('unauthorized', 401);
        }
        if (response.status === 403) throw new AvitoError('forbidden', 403);
        if (response.status === 404) throw new AvitoError('unsupported', 502);
        if (response.status === 400) throw new AvitoError(resource === 'token' ? 'unauthorized' : 'invalid', 400);
        throw new AvitoError('unavailable', 502);
      }
      const limit = resource === 'token' ? 16384 : 2 * 1024 * 1024;
      if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new AvitoError('response_size', 502); }
      const reader = response.body?.getReader();
      if (!reader) throw new AvitoError('schema', 502);
      const chunks = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) { await reader.cancel(); throw new AvitoError('response_size', 502); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      try { const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); return resource === 'messenger_messages' && Array.isArray(parsed) ? parsed : requireObject(parsed); }
      catch { throw new AvitoError('schema', 502); }
    } catch (error) {
      if (error instanceof AvitoError) throw error;
      // Never attach provider errors, URLs, bodies or credentials to an observable error.
      throw new AvitoError('unavailable', 502);
    } finally { clearTimeout(timeout); this.#controllers.delete(controller); }
  }

  async #accessToken() {
    this.#ready();
    if (this.#token && this.#token.expiresAt > this.#now() + 60000) return this.#token.value;
    if (this.#tokenFlight) return this.#tokenFlight;
    const flight = (async () => {
      const value = await this.#request('token', '/token', { method: 'POST', interval: 3000,
        form: { grant_type: 'client_credentials', ...this.#credentials } });
      if (typeof value.access_token !== 'string' || !value.access_token || value.access_token.length > 8192 || hasControl(value.access_token)
          || String(value.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(value.expires_in) || value.expires_in <= 60 || value.expires_in > 604800) throw new AvitoError('schema', 502);
      this.#token = { value: value.access_token, expiresAt: this.#now() + value.expires_in * 1000 };
      return this.#token.value;
    })();
    this.#tokenFlight = flight;
    try { return await flight; } finally { this.#tokenFlight = null; }
  }

  async #identify() {
    const token = await this.#accessToken();
    const value = await this.#request('identity', '/core/v1/accounts/self', { token });
    const id = accountId(value.id);
    if (this.#config.expectedAccountId && id !== String(this.#config.expectedAccountId)) throw new AvitoError('account_mismatch', 409);
    this.#account = id;
    this.#capabilities.identity = 'available';
    return id;
  }

  async #operation(action, capability) {
    this.#lastError = null;
    try { return await action(); }
    catch (error) {
      const safe = error instanceof AvitoError ? error : new AvitoError('unavailable', 502);
      this.#capabilities[capability] = safe.code;
      if (capability === 'identity') this.#account = null;
      this.#lastError = { code: safe.code, message: safe.message, at: new Date(this.#now()).toISOString(), retryAfterSeconds: safe.retryAfterSeconds };
      throw safe;
    }
  }

  async checkConnection() {
    return this.#operation(async () => {
      await this.#identify();
      this.#lastCheckAt = new Date(this.#now()).toISOString();
      return this.status();
    }, 'identity');
  }

  async balance() {
    return this.#operation(async () => {
      if (!this.#account) await this.#identify();
      const token = await this.#accessToken();
      const value = await this.#request('balance', `/core/v1/accounts/${this.#account}/balance/`, { token });
      // Wallet real/bonus are decimal rubles, unlike stats/v2 spending in kopecks.
      // Missing or malformed money must never become a zero-balance warning.
      for (const field of ['real', 'bonus']) {
        if (typeof value[field] !== 'number' || !Number.isFinite(value[field]) || value[field] < 0
            || value[field] > Number.MAX_SAFE_INTEGER / 100) throw new AvitoError('schema', 502);
      }
      this.#capabilities.balance = 'available';
      return { source: 'avito', accountId: this.#account, real: value.real, bonus: value.bonus,
        currency: 'RUB', loadedAt: new Date(this.#now()).toISOString() };
    }, 'balance');
  }

  async listings(input = {}) {
    inputObject(input, ['page']);
    const page = input.page ?? 1;
    if (!Number.isSafeInteger(page) || page < 1 || page > 2000) throw new AvitoError('invalid', 400);
    return this.#operation(async () => {
      if (!this.#account) await this.#identify();
      const token = await this.#accessToken();
      const value = await this.#request('listings', `/core/v1/items?per_page=50&page=${page}&status=active,removed,old,blocked,rejected`, { token });
      if (!Array.isArray(value.resources) || value.resources.length > 50 || value.meta?.page !== page || value.meta?.per_page !== 50) throw new AvitoError('schema', 502);
      const seen = new Set();
      const items = value.resources.map(item => {
        requireObject(item); const id = accountId(item.id);
        if (seen.has(id) || typeof item.title !== 'string' || item.title.length > 1000 || !['active', 'removed', 'old', 'blocked', 'rejected'].includes(item.status)) throw new AvitoError('schema', 502);
        seen.add(id);
        // Contact details, addresses and arbitrary provider URLs are intentionally not projected.
        return { id, title: item.title, status: item.status, ...listingFields(item) };
      });
      this.#capabilities.listings = 'available';
      return { source: 'avito', accountId: this.#account, items, page, nextPage: items.length === 50 ? page + 1 : null,
        complete: page === 1 && items.length < 50, loadedAt: new Date(this.#now()).toISOString(),
        warnings: ['owner_account_required_for_complete_listing_inventory'] };
    }, 'listings');
  }

  async detail(kind, input) {
    inputObject(input, kind === 'info' ? ['itemId'] : kind === 'services' ? ['itemIds'] : ['dateFrom','dateTo','itemIds']);
    let request;
    try {
      if (kind === 'info') request = {itemId:sourceId(input.itemId)};
      else {
        const itemIds=detailInput(input,kind==='services'?100:200).map(Number);
        if(kind==='services') request={itemIds};
        else {
          validateAvitoReport({dateFrom:input.dateFrom,dateTo:input.dateTo},this.#now(),270);
          request={dateFrom:input.dateFrom,dateTo:input.dateTo,itemIds};
          if(kind==='traffic')Object.assign(request,{fields:['uniqViews','uniqContacts','uniqFavorites'],periodGrouping:'day'});
        }
      }
    }catch{throw new AvitoError('invalid',400);}
    if(!['info','services','traffic','calls'].includes(kind))throw new AvitoError('invalid',400);
    return this.#operation(async()=>{
      if(!this.#account)await this.#identify();
      const token=await this.#accessToken();
      const endpoint=kind==='info' ? '/core/v1/accounts/'+this.#account+'/items/'+request.itemId+'/' : kind==='services' ? '/promotion/v1/items/services/get' : kind==='traffic' ? '/stats/v1/accounts/'+this.#account+'/items' : '/core/v1/accounts/'+this.#account+'/calls/stats/';
      const value=await this.#request(kind,endpoint,{token,interval:kind==='info'?150:kind==='traffic'?3000:1000,...(kind==='info'?{}:{method:'POST',payload:request})});
      let data;try{data=kind==='info'?parseItemInfo(value,request.itemId):kind==='services'?parseServices(value,request):kind==='traffic'?parseTraffic(value,request):parseCalls(value,request);}catch{throw new AvitoError('schema',502);}
      this.#capabilities[kind]='available';
      return {...data,accountId:this.#account,loadedAt:new Date(this.#now()).toISOString()};
    },kind);
  }

  async statistics(input, maxDays = 31) {
    const request = validateAvitoReport(input, this.#now(), maxDays);
    return this.#operation(async () => {
      if (!this.#account) await this.#identify();
      const token = await this.#accessToken();
      const value = await this.#request('statistics', `/stats/v2/accounts/${this.#account}/items`, {
        method: 'POST', payload: request, token, interval: 65000 });
      const report = parseAvitoReport(value, request, new Date(this.#now()).toISOString());
      this.#capabilities.statistics = 'available';
      this.#capabilities.availableMetrics = report.availableMetrics;
      return { ...report, accountId: this.#account };
    }, 'statistics');
  }

  async conversations(input = {}) {
    inputObject(input,['offset']);
    const offset=input.offset??0;
    if(!Number.isSafeInteger(offset)||offset<0||offset>1000||offset%100)throw new AvitoError('invalid',400);
    return this.#operation(async()=>{
      if(!this.#account)await this.#identify();
      const token=await this.#accessToken();
      const value=await this.#request('messenger_chats','/messenger/v2/accounts/'+this.#account+'/chats?limit=100&offset='+offset+'&chat_types=u2i',{token,interval:1000});
      try{return {...parseChats(value,this.#account),accountId:this.#account};}catch{throw new AvitoError('schema',502);}
    },'messenger');
  }
  async conversationMessages(input) {
    inputObject(input,['chatId','offset']);
    const offset=input.offset??0;
    if(!Number.isSafeInteger(offset)||offset<0||offset>900||offset%100)throw new AvitoError('invalid',400);
    let key;try{key=chatId(input.chatId);}catch{throw new AvitoError('invalid',400);}
    return this.#operation(async()=>{
      if(!this.#account)await this.#identify();
      const token=await this.#accessToken();
      const value=await this.#request('messenger_messages','/messenger/v3/accounts/'+this.#account+'/chats/'+encodeURIComponent(key)+'/messages/?limit=100&offset='+offset,{token,interval:1000});
      try{return parseMessages(value);}catch{throw new AvitoError('schema',502);}
    },'messenger');
  }

  close() { this.#closed = true; for (const controller of this.#controllers) controller.abort(); this.#token = null; this.#credentials = null; }
}

const actions = new Set(['/api/integrations/avito/check', '/api/integrations/avito/listings', '/api/integrations/avito/statistics']);
export function isAvitoReadAction(pathname, method) { return method === 'POST' && actions.has(pathname); }

export async function avitoApi(client, pathname, method, input = {}) {
  if (pathname === '/api/integrations/avito' && method === 'GET') return { status: 200, data: client.status() };
  if (!isAvitoReadAction(pathname, method)) return { status: 404, data: { error: 'Метод подключения Авито не найден.' } };
  try {
    let data;
    if (pathname.endsWith('/check')) { inputObject(input, []); data = await client.checkConnection(); }
    else if (pathname.endsWith('/listings')) data = await client.listings(input);
    else data = await client.statistics(input);
    return { status: 200, data };
  } catch (error) {
    const safe = error instanceof AvitoError ? error : new AvitoError('unavailable', 502);
    // A provider 401 must not be confused with an expired Workshop session.
    return { status: safe.statusCode === 401 ? 502 : safe.statusCode, data: { error: safe.message, code: safe.code, retryAfterSeconds: safe.retryAfterSeconds },
      ...(safe.retryAfterSeconds ? { headers: { 'Retry-After': String(safe.retryAfterSeconds) } } : {}) };
  }
}
