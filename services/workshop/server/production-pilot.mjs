import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SheetsError } from './sheets-client.mjs';
import { positionCreationForm } from '../modules/orders/server/positions.mjs';
import {
  preparePositionRoute,
  productionPositionTemplates,
  productionProductCatalog,
} from './production-position.mjs';
import { ProductionSheetStore } from './production-sheet.mjs';
import {
  makePinHash,
  verifyPin,
  parseCookies,
  tokenHash,
  sessionToken,
} from './auth.mjs';
import {
  addProductionItem,
  applyProductionCommand,
  snapshotFor,
} from './production-workflow.mjs';
import { PlanningError, requireValue } from './production-planner.mjs';
import {
  readTables,
  OrderError,
  findUniqueOrder,
  moveOrder,
} from '../modules/orders/server/orders.mjs';

function writeAtomic(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`,
    fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}
export function assertPilotEnvironment(env = process.env) {
  const directory = path.resolve(env.QA_DIRECTORY || '');
  requireValue(
    env.PRODUCTION_PILOT === 'offline' &&
      env.GOOGLE_SPREADSHEET_ID === 'offline-workshop' &&
      !env.GOOGLE_CREDENTIALS_FILE &&
      env.HOST === '127.0.0.1' &&
      env.DATA_DIR === path.join(directory, 'data'),
    'Пилот разрешён только в изолированном локальном стенде.',
    'pilot_guard',
    503,
  );
  requireValue(
    !fs.lstatSync(directory).isSymbolicLink() &&
      fs.readFileSync(path.join(directory, '.workshop-qa'), 'utf8').trim() ===
        'workshop-qa-v1',
    'Нет маркера тестового стенда.',
    'pilot_guard',
    503,
  );
  return directory;
}
export async function createProductionPilot({
  client,
  db,
  mediaStore,
  currentOwner,
  json,
  body,
  sheetsClient = client,
  liveStore,
}) {
  const live =
    process.env.PRODUCTION_V2 === 'google'
      ? liveStore ||
        new ProductionSheetStore({
          client: sheetsClient,
          ordersClient: client,
          db,
        })
      : null;
  if (!live && !process.env.PRODUCTION_PILOT) return null;
  const directory = live ? null : assertPilotEnvironment(),
    file = live ? null : path.join(directory, 'production.json');
  if (!live && !fs.existsSync(file)) {
    const { productionFixture } = await import('../qa/production-fixture.mjs');
    const now = new Date(),
      initial = productionFixture(now);
    addProductionItem(
      initial,
      { orderId: '9001', productId: 'letters', quantity: 4 },
      now,
    );
    addProductionItem(
      initial,
      { orderId: '9001', productId: 'frame', quantity: 1 },
      now,
    );
    addProductionItem(
      initial,
      { orderId: '9002', productId: 'print', quantity: 1 },
      now,
    );
    writeAtomic(file, initial);
  }
  let state = live
    ? await live.load(true)
    : JSON.parse(fs.readFileSync(file, 'utf8'));
  async function persist(next) {
    if (live) {
      await live.commit(next);
      state = await live.load();
    } else {
      writeAtomic(file, next);
      state = next;
    }
  }
  requireValue(
    state.version === 1 && Array.isArray(state.tasks),
    'Неизвестная версия тестового состояния.',
    'pilot_guard',
    503,
  );
  db.exec(
    'CREATE TABLE IF NOT EXISTS production_pilot_credentials(worker_id TEXT PRIMARY KEY, pin_hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS production_pilot_sessions(token_hash TEXT PRIMARY KEY, worker_id TEXT NOT NULL, expires_at TEXT NOT NULL);',
  );
  const attempts = new Map();
  const cookie = (value) =>
    `production_session=${value}; Path=/; HttpOnly; SameSite=Strict;${live && process.env.COOKIE_SECURE !== 'false' ? ' Secure;' : ''} Max-Age=${value ? 86400 : 0}`;
  function actor(request) {
    if (currentOwner(request))
      return { id: 'owner', name: 'Руководитель', role: 'owner' };
    const token = parseCookies(request.headers.cookie).production_session;
    const session =
      token &&
      db
        .prepare(
          'SELECT worker_id FROM production_pilot_sessions WHERE token_hash=? AND expires_at>?',
        )
        .get(tokenHash(token), new Date().toISOString());
    const worker =
      session &&
      state.workers.find((w) => w.id === session.worker_id && w.access);
    return worker
      ? { id: worker.id, name: worker.name, role: worker.role }
      : null;
  }
  async function snapshot(who) {
    const result = snapshotFor(state, who, new Date());
    result.pilot = !live;
    result.storagePending = Boolean(live?.pending());
    result.orders = await Promise.all(
      result.orders.map(async (o) => ({
        ...o,
        media: (await mediaStore.list(o.id)).items
          .filter((m) => m.kind === 'image')
          .map((m) => ({
            id: m.id,
            name: m.name,
            url: `/api/production-pilot/media/${encodeURIComponent(o.id)}/${m.id}`,
          })),
      })),
    );
    if (who.role !== 'master')
      result.workers = result.workers.map((w) => ({
        ...w,
        hasPin: Boolean(
          db
            .prepare(
              'SELECT 1 FROM production_pilot_credentials WHERE worker_id=?',
            )
            .get(w.id),
        ),
      }));
    return result;
  }
  async function reconcile() {
    if (live) {
      await live.recover();
      state = await live.load();
    }
    for (const orderId of state.pendingOrders) {
      try {
        const tables = (
            await readTables(client, ['Заказы'], { includeFormulas: true })
          ).tables,
          table = tables['Заказы'];
        const row = findUniqueOrder(table, orderId),
          status = String(table.cell(row, 'Статус')).trim();
        requireValue(
          (live
            ? ['В производстве', 'Готов к выдаче']
            : ['В работе', 'Выполненная']
          ).includes(status),
          'Статус заказа изменён вне производства. Нужна проверка руководителя.',
          'board_conflict',
          409,
        );
        const completedStatus = live ? 'Готов к выдаче' : 'Выполненная';
        if (status !== completedStatus)
          await moveOrder(client, {
            id: orderId,
            expectedStatus: status,
            status: completedStatus,
          });
        const next = structuredClone(state);
        Object.assign(
          next.orders.find((o) => o.id === orderId),
          { status: 'Выполненная', actualStatus: completedStatus },
        );
        next.pendingOrders = next.pendingOrders.filter((id) => id !== orderId);
        delete next.boardError;
        await persist(next);
      } catch (error) {
        const next = structuredClone(state);
        next.boardError =
          error instanceof PlanningError
            ? error.message
            : 'Переход карточки пока не подтверждён. Повторная проверка выполняется автоматически.';
        if (!live?.pending()) await persist(next);
      }
    }
  }
  const seedImage = path.resolve('qa/assets/production-letters.png');
  for (const orderId of live ? [] : ['9001', '9002'])
    if (
      fs.existsSync(seedImage) &&
      !(await mediaStore.list(orderId)).items.length
    )
      await mediaStore.add(orderId, {
        name: 'Учебный макет.png',
        contentType: 'image/png',
        bytes: fs.readFileSync(seedImage),
      });
  async function handle(request, response, url) {
    try {
      const entering = url.pathname === '/api/production-pilot/session';
      if (live && !entering && !actor(request))
        return json(response, 401, {
          error: 'Требуется вход в Мастерскую.',
          loginUrl: '/?action=production',
        });
      if (!entering)
        requireValue(
          actor(request),
          'Требуется вход в производство.',
          'unauthorized',
          401,
        );
      if (live) state = await live.load(!entering && request.method !== 'GET');
      const who = actor(request),
        sessionPath = '/api/production-pilot/session';
      if (url.pathname === sessionPath && request.method === 'GET')
        return json(response, 200, {
          enabled: true,
          authenticated: Boolean(who),
          actor: who,
        });
      if (url.pathname === sessionPath && request.method === 'POST') {
        const key = request.socket.remoteAddress || 'local',
          now = Date.now(),
          recent = (attempts.get(key) || []).filter(
            (t) => now - t < 15 * 60000,
          );
        requireValue(
          recent.length < 8,
          'Слишком много попыток. Попробуйте позже.',
          'limited',
          429,
        );
        attempts.set(key, [...recent, now]);
        const input = await body(request),
          worker = state.workers.find((w) => w.id === input.login && w.access);
        const credential =
          worker &&
          db
            .prepare(
              'SELECT pin_hash FROM production_pilot_credentials WHERE worker_id=?',
            )
            .get(worker.id);
        requireValue(
          credential &&
            typeof input.pin === 'string' &&
            input.pin.length <= 100 &&
            (await verifyPin(input.pin, credential.pin_hash)),
          'Неверный логин или код доступа.',
          'unauthorized',
          401,
        );
        const token = sessionToken();
        db.prepare('INSERT INTO production_pilot_sessions VALUES(?,?,?)').run(
          tokenHash(token),
          worker.id,
          new Date(now + 86400000).toISOString(),
        );
        attempts.delete(key);
        return json(
          response,
          200,
          { authenticated: true },
          { 'Set-Cookie': cookie(token) },
        );
      }
      if (url.pathname === sessionPath && request.method === 'DELETE') {
        const token = parseCookies(request.headers.cookie).production_session;
        if (token)
          db.prepare(
            'DELETE FROM production_pilot_sessions WHERE token_hash=?',
          ).run(tokenHash(token));
        return json(
          response,
          200,
          { authenticated: false },
          { 'Set-Cookie': cookie('') },
        );
      }
      requireValue(who, 'Требуется вход в производство.', 'unauthorized', 401);
      if (url.pathname === '/api/production-pilot' && request.method === 'GET')
        return json(response, 200, {
          ...(await snapshot(who)),
          boardError: state.boardError || '',
          confirmedRequestId:
            /^[a-zA-Z0-9_-]{12,100}$/.test(
              url.searchParams.get('requestId') || '',
            ) && state.receipts[url.searchParams.get('requestId')]
              ? url.searchParams.get('requestId')
              : null,
        });
      if (
        url.pathname === '/api/production-pilot/command' &&
        request.method === 'POST'
      ) {
        const input = await body(request);
        if (live) {
          requireValue(
            !live.pending(),
            'Предыдущее действие ещё проверяется. Обновите экран после подтверждения Google.',
            'pending',
            503,
          );
          requireValue(
            input.type !== 'warehouse.refill',
            'Пополнение выполняется в общем разделе «Склад».',
          );
        }
        if (input.type === 'worker.save' && input.data?.access)
          requireValue(
            db
              .prepare(
                'SELECT 1 FROM production_pilot_credentials WHERE worker_id=?',
              )
              .get(input.data.id || ''),
            'Сначала сохраните профиль и задайте код доступа.',
          );
        const result = applyProductionCommand(state, who, input);
        if (!result.duplicate) {
          await persist(result.state);
        }
        await reconcile();
        return json(response, 200, {
          ...(await snapshot(who)),
          boardError: state.boardError || '',
          duplicate: result.duplicate,
        });
      }
      if (
        url.pathname === '/api/production-pilot/access' &&
        request.method === 'POST'
      ) {
        requireValue(
          who.role !== 'master',
          'Доступно руководителю.',
          'forbidden',
          403,
        );
        const input = await body(request),
          worker = state.workers.find((w) => w.id === input.workerId);
        requireValue(
          worker &&
            typeof input.pin === 'string' &&
            /^\d{6,12}$/.test(input.pin),
          'Код доступа должен содержать от 6 до 12 цифр.',
        );
        db.prepare(
          'INSERT INTO production_pilot_credentials VALUES(?,?) ON CONFLICT(worker_id) DO UPDATE SET pin_hash=excluded.pin_hash',
        ).run(worker.id, await makePinHash(input.pin));
        db.prepare(
          'DELETE FROM production_pilot_sessions WHERE worker_id=?',
        ).run(worker.id);
        return json(response, 200, { saved: true });
      }
      const match = url.pathname.match(
        /^\/api\/production-pilot\/media\/([^/]+)\/([a-f0-9]{32})$/,
      );
      if (match && request.method === 'GET') {
        const orderId = decodeURIComponent(match[1]),
          allowed = snapshotFor(state, who, new Date()).orders.some(
            (o) => o.id === orderId,
          );
        requireValue(allowed, 'Изображение недоступно.', 'forbidden', 403);
        const result = await mediaStore.read(orderId, match[2]);
        requireValue(
          result.media.kind === 'image',
          'Недоступный тип вложения.',
          'forbidden',
          403,
        );
        response.writeHead(200, {
          'Content-Type': result.media.contentType,
          'Content-Length': result.bytes.length,
          'Cache-Control': 'no-store, private',
        });
        response.end(result.bytes);
        return;
      }
      return json(response, 404, { error: 'Неизвестный адрес производства.' });
    } catch (error) {
      const upstream = error instanceof SheetsError;
      const pending = Boolean(live?.pending());
      if (upstream)
        console.error(
          JSON.stringify({
            event: 'production_upstream_error',
            code: error.code,
            pending,
          }),
        );
      if (upstream || (pending && !(error instanceof PlanningError)))
        return json(response, 503, {
          error: pending
            ? 'Действие принято. Ждём подтверждения Google; экран обновится автоматически.'
            : upstream
              ? error.message
              : 'Проверяем сохранение действия. Экран обновится автоматически.',
          code: pending ? 'pending' : error.code,
        });
      const safe = error instanceof PlanningError;
      return json(response, safe ? error.statusCode : 500, {
        error: safe
          ? error.message
          : 'Не удалось выполнить команду производства. Обновите экран.',
        code: safe ? error.code : 'production_error',
      });
    }
  }
  async function positionForm(client, input) {
    if (live) state = await live.load();
    return positionCreationForm(client, input, {
      templates: productionPositionTemplates(state),
    });
  }
  async function orderCatalog(input) {
    if(live)state=await live.load();
    if(input){
      requireValue(!live?.pending(),'Сохранение справочника ещё проверяется. Повторите запрос.','pending',503);
      const command={requestId:input.requestId,revision:state.revision,type:'product.option.add',data:{scope:input.scope,value:input.value}};
      const result=applyProductionCommand(state,{id:'owner',role:'owner'},command);
      if(!result.duplicate)await persist(result.state);
    }
    return {options:state.orderOptions||{},products:state.products.filter(p=>p.orderFormKey).map(p=>({id:p.id,name:p.name,key:p.orderFormKey}))};
  }
  async function productCatalog() {
    if (live) state = await live.load();
    return productionProductCatalog(state);
  }
  async function preparePosition(input) {
    if(input.position?.template==='custom')return null; // Order validity is checked by the position writer.
    if (live) state = await live.load();
    try {
      return preparePositionRoute(state, input);
    } catch (error) {
      if (error instanceof PlanningError)
        throw new OrderError('POSITION_ROUTE_INVALID', error.message, 422);
      throw error;
    }
  }
  async function assertPositionDetached({orderId,itemRow,product}) {
    if(live)state=await live.load(true);
    if(live?.pending())throw new OrderError('POSITION_DELETE_PRODUCTION','Сохранение производства ещё проверяется. Удаление позиции пока недоступно.',409);
    const source=`position:${orderId}:${itemRow}`;
    if(state.items.some(item=>item.sourcePosition===source||(String(item.orderId)===String(orderId)&&item.name===product)))throw new OrderError('POSITION_DELETE_PRODUCTION','Позиция связана с производством. История и задания сохранены; удаление недоступно.',409);
  }
  async function ensurePosition(record) {
    if (live) state = await live.load();
    const sourcePosition = `position:${record.orderId}:${record.itemRow}`;
    const matches = state.items.filter(
      (i) => i.sourcePosition === sourcePosition,
    );
    requireValue(
      matches.length <= 1,
      'У позиции несколько производственных маршрутов.',
    );
    if (matches.length) {
      requireValue(
        matches[0].name === record.product &&
          matches[0].productId === record.productionRoute.product.id,
        'Связь позиции с производством изменилась.',
      );
      return;
    }
    const next = structuredClone(state);
    const route = record.productionRoute;
    const product = next.products.find((p) => p.id === route.product.id);
    if (!product) next.products.push(route.product);
    else {
      const frozen = route.product.versions.at(-1);
      requireValue(
        JSON.stringify(
          product.versions.find((v) => v.version === frozen.version)?.stages,
        ) === JSON.stringify(frozen.stages),
        'Версия маршрута была изменена. Нужна проверка позиции.',
      );
    }
    const result = applyProductionCommand(
      next,
      { id: 'owner', role: 'owner' },
      {
        type: 'item.add',
        requestId: 'position-' + record.requestId,
        revision: next.revision,
        data: {
          orderId: record.orderId,
          productId: route.product.id,
          productVersion: route.product.versions.at(-1).version,
          quantity: route.quantity,
          name: record.product,
          sourcePosition,
        },
      },
    );
    if (!result.duplicate) await persist(result.state);
  }
  async function decorateBoard(board) {
    if (!live) return board;
    state = await live.load();
    return {
      ...board,
      orders: board.orders.map((o) => ({
        ...o,
        production: state.tasks
          .filter((t) => t.orderId === o.id)
          .map((t) => ({
            name: t.name,
            product: state.items.find((i) => i.id === t.itemId)?.name || '',
            done: t.status === 'done',
            availability:
              t.status === 'done'
                ? 'готово'
                : t.dependencies.every(
                      (id) =>
                        state.tasks.find((p) => p.id === id)?.status === 'done',
                    )
                  ? 'можно'
                  : 'ждёт',
            assignee:
              state.workers.find((w) => w.id === t.workerId)?.name || '',
            planDate: t.mustDate,
            actualDate: t.completedAt?.slice(0, 10) || null,
            comment: t.legacyComment || '',
            edit: null,
          })),
      })),
    };
  }
  async function legacySnapshot() {
    if (live) state = await live.load();
    const value = snapshotFor(
      state,
      { id: 'owner', role: 'owner' },
      new Date(),
    );
    const tasks = value.tasks.map((t) => ({
      key: t.id,
      row: t.legacyRow || 0,
      orderNumber: t.orderId,
      orderName: state.orders.find((o) => o.id === t.orderId)?.name || '',
      item: state.items.find((i) => i.id === t.itemId)?.name || '',
      stage: t.name,
      completed: t.status === 'done',
      canComplete: false,
      availability: t.ready ? 'можно' : 'ждёт',
      assignee:
        state.workers.find((w) => w.id === t.assignedWorkerId)?.name || null,
      plannedDate: t.mustDate,
      dueDate: t.dueAt?.slice(0, 10) || null,
      overdue:
        t.status !== 'done' &&
        Boolean(t.dueAt && t.dueAt.slice(0, 10) < value.today),
      completedDate: t.completedAt?.slice(0, 10) || null,
      normHours: t.minutes / 60,
      hours: null,
      payment: null,
      waitingFor: t.dependencies
        .filter((id) => state.tasks.find((p) => p.id === id)?.status !== 'done')
        .map((id) => state.tasks.find((p) => p.id === id)?.name || id),
      comment: t.legacyComment || null,
    }));
    return {
      sheetName: 'Производство · данные',
      today: value.today,
      tasks,
      stats: {
        total: tasks.length,
        completed: tasks.filter((t) => t.completed).length,
        ready: tasks.filter((t) => !t.completed && t.availability === 'можно')
          .length,
        waiting: tasks.filter((t) => !t.completed && t.availability === 'ждёт')
          .length,
        overdue: tasks.filter((t) => t.overdue).length,
        planToday: tasks.filter((t) => t.plannedDate === value.today).length,
        completedToday: tasks.filter((t) => t.completedDate === value.today)
          .length,
        dueTodayOrders: new Set(
          tasks
            .filter((t) => !t.completed && t.dueDate === value.today)
            .map((t) => t.orderNumber),
        ).size,
      },
      refreshedAt: value.now,
      movedTo: '/production/',
    };
  }
  return {
    handle,
    reconcile,
    decorateBoard,
    positionForm,
    productCatalog,
    orderCatalog,
    preparePosition,
    ensurePosition,
    assertPositionDetached,
    legacySnapshot,
    pending: () => Boolean(live?.pending()),
    live: Boolean(live),
  };
}
