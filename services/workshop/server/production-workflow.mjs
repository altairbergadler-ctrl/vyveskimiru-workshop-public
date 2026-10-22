import { PRODUCTS, schemas } from '../modules/orders/public/order-config-model.js';
import crypto from 'node:crypto';
import {
  canWorker,
  stageConfigurationIssue,
  materialsFor,
  operatorIntervals,
  planProduction,
  PlanningError,
  requireValue,
  validateRoute,
  activeProductionTasks,
  isProductionOrderActive,
} from './production-planner.mjs';
const id = () => crypto.randomUUID();
export const businessDate = (value, timeZone) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
const text = (value) => String(value ?? '').trim();
export function addProductionItem(state, input, now) {
  const order = state.orders.find((o) => o.id === input.orderId),
    product = state.products.find((p) => p.id === input.productId);
  requireValue(
    isProductionOrderActive(order) && !state.pendingOrders.includes(order.id),
    'Выберите незавершённый заказ.',
  );
  requireValue(product, 'Продукт не найден.');
  requireValue(
    Number.isFinite(input.quantity) &&
      input.quantity > 0 &&
      input.quantity <= 10000,
    'Укажите количество от 0 до 10000.',
  );
  requireValue(
    state.tasks.length + product.versions.at(-1).stages.length <=
      (state.live ? 2000 : 250),
    'Достигнут предел активного журнала этапов.',
  );
  const route = input.productVersion
    ? product.versions.find((v) => v.version === input.productVersion)
    : product.versions.at(-1);
  requireValue(route, 'Версия маршрута не найдена.');
  validateRoute(route.stages);
  const item = {
    id: id(),
    orderId: order.id,
    productId: product.id,
    productVersion: route.version,
    ...(input.sourcePosition
      ? { sourcePosition: text(input.sourcePosition) }
      : {}),
    name: text(input.name) || product.name,
    quantity: input.quantity,
    unit: product.unit,
  };
  state.items.push(item);
  const map = new Map(route.stages.map((s) => [s.id, id()]));
  state.tasks.push(
    ...route.stages.map((s) => ({
      ...structuredClone(s),
      id: map.get(s.id),
      stageId: s.id,
      itemId: item.id,
      orderId: order.id,
      quantity: input.quantity,
      doneQuantity: 0,
      unit: product.unit,
      dependencies: s.dependencies.map((d) => map.get(d)),
      dueAt: order.dueAt,
      mustDate: businessDate(now, state.timeZone),
      status: 'todo',
      workerId: null,
      issued: {},
      pin: null,
      needsSetup: false,
    })),
  );
  return item;
}
export function taskAssignee(state, task, plan) {
  return (
    task.workerId ||
    plan.planned.find((p) => p.taskId === task.id)?.workerId ||
    task.pin?.workerId ||
    (task.kind === 'wait'
      ? null
      : state.workers
          .filter((w) => canWorker(task, w, state.resources))
          .sort(
            (a, b) =>
              a.skills.length - b.skills.length || a.id.localeCompare(b.id),
          )[0]?.id) ||
    null
  );
}
export function startBlockReason(state, task, plan) {
  const issue = stageConfigurationIssue(task, state);
  if (issue) return issue;
  if (task.status === 'todo' && task.blockedReason) return task.blockedReason;
  const waiting = task.dependencies.filter(
    (id) => state.tasks.find((t) => t.id === id)?.status !== 'done',
  );
  if (waiting.length)
    return (
      'Сначала завершите: ' +
      waiting
        .map((id) => state.tasks.find((t) => t.id === id)?.name || id)
        .join(', ')
    );
  if (materialsFor(task, state.warehouse).some((m) => m.remaining > 0))
    return 'Подтвердите получение материалов со склада.';
  if (
    task.kind !== 'wait' &&
    !canWorker(
      task,
      state.workers.find((w) => w.id === taskAssignee(state, task, plan)),
      state.resources,
    )
  )
    return 'Назначьте мастера с нужной компетенцией.';
  return '';
}
export function snapshotFor(state, actor, now) {
  const plan = planProduction(state, { now });
  const manager = actor.role !== 'master';
  const all = activeProductionTasks(state).map((t) => ({
    ...t,
    needsSetup: Boolean(stageConfigurationIssue(t, state)),
    startBlockedReason: startBlockReason(state, t, plan),
    assignedWorkerId: taskAssignee(state, t, plan),
    materialList: materialsFor(t, state.warehouse),
    ready:
      !t.blockedReason &&
      !stageConfigurationIssue(t, state) &&
      t.dependencies.every(
        (d) => state.tasks.find((x) => x.id === d)?.status === 'done',
      ),
    schedule: plan.planned.find((p) => p.taskId === t.id) || null,
    schedulingProblem:
      plan.unplanned.find((p) => p.taskId === t.id)?.reason || '',
    expectedLate: t.status === 'running' && Date.parse(t.expectedEnd) < +now,
  }));
  const tasks = manager
    ? all
    : all.filter((t) => t.assignedWorkerId === actor.id);
  const orderIds = new Set(tasks.map((t) => t.orderId));
  return {
    revision: state.revision,
    pilot: true,
    actor,
    now: now.toISOString(),
    today: businessDate(now, state.timeZone),
    timeZone: state.timeZone,
    workers: manager
      ? state.workers
      : state.workers.filter((w) => w.id === actor.id),
    resources: manager
      ? state.resources
      : state.resources.filter((r) => tasks.some((t) => t.resourceId === r.id)),
    products: manager
      ? state.products.map((p) => ({
          ...p,
          needsSetup: !p.versions.at(-1).stages.length || p.versions
            .at(-1)
            .stages.some((s) => stageConfigurationIssue(s, state)),
        }))
      : [],
    warehouse: manager ? state.warehouse : [],
    orders: state.orders.filter(
      (o) => isProductionOrderActive(o) && (manager || orderIds.has(o.id)),
    ),
    items: state.items.filter((i) => tasks.some((t) => t.itemId === i.id)),
    tasks,
    records: state.records.filter((r) => manager || r.workerId === actor.id),
    events: manager ? state.events.slice(-100) : [],
    pendingOrders: manager ? state.pendingOrders : [],
    plan: {
      ...plan,
      planned: plan.planned.filter(
        (p) => manager || tasks.some((t) => t.id === p.taskId),
      ),
      unplanned: plan.unplanned.filter(
        (p) => manager || tasks.some((t) => t.id === p.taskId),
      ),
    },
  };
}
function admin(actor) {
  requireValue(
    actor.role === 'owner' || actor.role === 'lead',
    'Доступно руководителю производства.',
    'forbidden',
    403,
  );
}
function noOperatorOverlap(state, task, workerId, now) {
  const candidate = operatorIntervals(task, +now);
  for (const other of activeProductionTasks(state).filter(
    (t) => t.id !== task.id && ['running', 'paused'].includes(t.status),
  )) {
    requireValue(
      !task.resourceId || task.resourceId !== other.resourceId,
      'Оборудование занято другой незавершённой задачей.',
      'busy',
      409,
    );
    if (other.workerId !== workerId || !workerId || other.status === 'paused')
      continue;
    const expected = Date.parse(other.expectedEnd);
    requireValue(
      expected > +now,
      'Уточните оставшееся время предыдущей задачи.',
      'busy',
      409,
    );
    const reserved = operatorIntervals(
      other,
      Date.parse(other.startedAt),
      (expected - Date.parse(other.startedAt)) / 60000,
    );
    requireValue(
      candidate.every((a) =>
        reserved.every((b) => a[0] >= b[1] || b[0] >= a[1]),
      ),
      'У мастера есть другая работа или обслуживание оборудования в это время.',
      'busy',
      409,
    );
    const aZone = state.resources.find((r) => r.id === task.resourceId)?.zone,
      bZone = state.resources.find((r) => r.id === other.resourceId)?.zone;
    requireValue(
      !aZone ||
        !bZone ||
        aZone === bZone ||
        candidate.every((a) =>
          reserved.every(
            (b) =>
              a[0] >= b[1] + state.travelMinutes * 60000 ||
              b[0] >= a[1] + state.travelMinutes * 60000,
          ),
        ),
      'Нужно время для перехода между рабочими зонами.',
      'busy',
      409,
    );
  }
}
export function applyProductionCommand(source, actor, input, now = new Date()) {
  requireValue(
    input &&
      typeof input === 'object' &&
      /^[a-zA-Z0-9_-]{12,100}$/.test(input.requestId || ''),
    'Нужен постоянный номер команды.',
  );
  const hash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        actor: actor.id,
        role: actor.role,
        type: input.type,
        data: input.data,
      }),
    )
    .digest('hex');
  const receipt = source.receipts[input.requestId];
  if (receipt) {
    requireValue(
      receipt.hash === hash,
      'Номер команды уже использован с другим содержимым.',
      'request_conflict',
      409,
    );
    return { state: source, duplicate: true };
  }
  requireValue(
    input.revision === source.revision,
    'Данные изменились. Обновите экран и повторите действие.',
    'stale',
    409,
  );
  const state = structuredClone(source),
    data = input.data || {},
    plan = planProduction(state, { now });
  const task = state.tasks.find((t) => t.id === data.taskId);
  let effectiveWorker;
  if (input.type.startsWith('task.')) {
    requireValue(task, 'Задача не найдена.', 'missing', 404);
    requireValue(
      isProductionOrderActive(state.orders.find((o) => o.id === task.orderId)),
      'Производство заказа закрыто или заказ находится в архиве. Обновите экран.',
      'order_closed',
      409,
    );
    effectiveWorker = taskAssignee(state, task, plan);
    if (actor.role === 'master')
      requireValue(
        effectiveWorker === actor.id,
        'Можно менять только назначенные вам задачи.',
        'forbidden',
        403,
      );
  }
  if (input.type === 'task.start' || input.type === 'task.resume') {
    requireValue(
      !stageConfigurationIssue(task, state),
      stageConfigurationIssue(task, state),
    );
    requireValue(
      task.status === (input.type === 'task.start' ? 'todo' : 'paused'),
      'Состояние задачи уже изменилось.',
      'conflict',
      409,
    );
    requireValue(
      input.type === 'task.resume' || !task.blockedReason,
      'Руководителю нужно снять препятствие перед началом.',
      'blocked',
      409,
    );
    requireValue(
      task.dependencies.every(
        (d) => state.tasks.find((t) => t.id === d)?.status === 'done',
      ),
      'Сначала завершите все предыдущие этапы.',
      'blocked',
      409,
    );
    requireValue(
      !materialsFor(task, state.warehouse).some((m) => m.remaining > 0),
      'Сначала подтвердите получение материалов этапа.',
      'materials',
      409,
    );
    requireValue(
      task.kind === 'wait' ||
        canWorker(
          task,
          state.workers.find((w) => w.id === effectiveWorker),
          state.resources,
        ),
      'Нет подходящего назначенного мастера.',
      'assignment',
      409,
    );
    const minutes =
      input.type === 'task.resume'
        ? task.remainingMinutes || task.minutes
        : task.minutes;
    noOperatorOverlap(state, { ...task, minutes }, effectiveWorker, now);
    task.workerId = effectiveWorker;
    task.startedAt = now.toISOString();
    task.firstStartedAt ||= task.startedAt;
    task.expectedEnd = new Date(+now + minutes * 60000).toISOString();
    task.status = 'running';
    task.blockedReason = '';
    task.remainingMinutes = null;
  } else if (input.type === 'task.pause') {
    requireValue(
      task.status === 'running',
      'Приостановить можно выполняющуюся задачу.',
    );
    task.remainingMinutes = Math.max(
      1,
      Math.ceil((Date.parse(task.expectedEnd) - +now) / 60000),
    );
    task.status = 'paused';
    task.blockedReason =
      text(data.reason).slice(0, 300) || 'Приостановлено мастером';
  } else if (input.type === 'task.block') {
    requireValue(
      task.status === 'todo',
      'Для начатой задачи используйте паузу.',
    );
    task.blockedReason =
      text(data.reason).slice(0, 300) || 'Нужна помощь руководителя';
  } else if (input.type === 'task.delay') {
    requireValue(
      task.status === 'running',
      'Прогноз меняется у выполняющейся задачи.',
    );
    requireValue(
      Number.isFinite(data.minutes) &&
        data.minutes >= 1 &&
        data.minutes <= 10080,
      'Укажите оставшиеся минуты.',
    );
    task.expectedEnd = new Date(+now + data.minutes * 60000).toISOString();
  } else if (input.type === 'task.complete') {
    requireValue(
      task.status === 'running',
      'Сначала начните или возобновите задачу.',
      'conflict',
      409,
    );
    requireValue(
      task.kind !== 'wait' || +now >= Date.parse(task.expectedEnd),
      'Технологическое ожидание ещё не закончилось.',
      'blocked',
      409,
    );
    if (task.kind === 'machine')
      noOperatorOverlap(
        state,
        { ...task, kind: 'manual', minutes: task.finishMinutes },
        task.workerId,
        now,
      );
    const quantity = data.quantity ?? task.quantity - task.doneQuantity;
    requireValue(
      Number.isFinite(quantity) &&
        quantity > 0 &&
        quantity <= task.quantity - task.doneQuantity + 1e-9,
      'Количество превышает оставшийся объём.',
    );
    task.doneQuantity = Math.min(task.quantity, task.doneQuantity + quantity);
    state.records.push({
      id: id(),
      taskId: task.id,
      orderId: task.orderId,
      itemId: task.itemId,
      stage: task.name,
      workerId: task.workerId,
      recordedBy: actor.id,
      quantity,
      unit: task.unit,
      completedAt: now.toISOString(),
      startedAt: task.startedAt,
      partial: task.doneQuantity < task.quantity,
    });
    if (task.doneQuantity === task.quantity) {
      task.status = 'done';
      task.completedAt = now.toISOString();
    } else {
      task.status = 'paused';
      task.remainingMinutes = Math.max(
        1,
        Math.ceil(
          (task.minutes * (task.quantity - task.doneQuantity)) / task.quantity,
        ),
      );
      task.blockedReason = 'Осталось выполнить часть задачи';
    }
    const related = state.tasks.filter((t) => t.orderId === task.orderId),
      items = state.items.filter((i) => i.orderId === task.orderId);
    if (
      items.length &&
      items.every((i) => related.some((t) => t.itemId === i.id)) &&
      related.every((t) => t.status === 'done')
    ) {
      if (!state.pendingOrders.includes(task.orderId))
        state.pendingOrders.push(task.orderId);
    }
  } else if (input.type === 'task.issue') {
    if (state.live)
      requireValue(
        materialsFor(task, state.warehouse).every(
          (m) =>
            Math.abs(m.remaining * 100 - Math.round(m.remaining * 100)) <
            0.000001,
        ),
        'Количество выдачи должно иметь не больше двух знаков после запятой. Уточните материалы этапа.',
      );
    requireValue(task.status !== 'done', 'Этап уже завершён.');
    const materials = materialsFor(task, state.warehouse);
    requireValue(
      materials.every((m) => m.remaining <= m.available),
      'На складе не хватает свободного материала.',
      'stock',
      409,
    );
    for (const m of materials.filter((m) => m.remaining > 0)) {
      const stock = state.warehouse.find((w) => w.sku === m.sku);
      stock.stock -= m.remaining;
      task.issued[m.sku] = m.need;
      state.movements.push({
        id: id(),
        taskId: task.id,
        orderId: task.orderId,
        sku: m.sku,
        quantity: m.remaining,
        actorId: actor.id,
        at: now.toISOString(),
      });
    }
  } else if (input.type === 'task.assign') {
    admin(actor);
    requireValue(
      !['running', 'done'].includes(task.status),
      'Сначала приостановите начатую работу; выполненная задача не переназначается.',
    );
    const worker = state.workers.find((w) => w.id === data.workerId);
    requireValue(
      task.kind === 'wait' || canWorker(task, worker, state.resources),
      'У выбранного мастера нет нужной компетенции или зоны.',
    );
    requireValue(
      !data.start || Number.isFinite(Date.parse(data.start)),
      'Некорректное закреплённое время.',
    );
    requireValue(
      data.rank === undefined ||
        (Number.isInteger(data.rank) && data.rank >= 0 && data.rank <= 9999),
      'Порядок должен быть целым числом от 0 до 9999.',
    );
    task.pin = data.unpin
      ? null
      : {
          workerId: data.workerId || null,
          rank: data.rank ?? 1,
          start: data.start || null,
        };
    task.workerId = data.unpin ? null : data.workerId || null;
    if (data.clearBlock) task.blockedReason = '';
    if (data.mustDate !== undefined) {
      requireValue(
        typeof data.mustDate === 'string' &&
          /^\d{4}-\d{2}-\d{2}$/.test(data.mustDate) &&
          Number.isFinite(Date.parse(data.mustDate)) &&
          new Date(data.mustDate).toISOString().slice(0, 10) === data.mustDate,
        'Укажите корректную дату обязательного завершения.',
      );
      task.mustDate = data.mustDate;
    }
    if (data.minutes !== undefined) {
      requireValue(
        Number.isFinite(data.minutes) &&
          data.minutes >= 1 &&
          data.minutes <= 10080,
        'Проверьте длительность.',
      );
      task.minutes = data.minutes;
    }
  } else if (input.type === 'task.configure') {
    admin(actor);
    requireValue(
      task.status === 'todo',
      'Настраивать можно только ещё не начатый этап.',
    );
    const fields = [
      'name',
      'kind',
      'minutes',
      'skill',
      'resourceId',
      'materials',
      'setupMinutes',
      'finishMinutes',
      'controlEvery',
      'controlMinutes',
    ];
    const stage = Object.fromEntries(
      fields.map((key) => [key, data.stage?.[key]]),
    );
    validateRoute([{ ...stage, id: task.id, dependencies: [] }]);
    requireValue(
      (!stage.resourceId ||
        state.resources.some((r) => r.id === stage.resourceId)) &&
        stage.materials.every((m) =>
          state.warehouse.some((w) => w.sku === m.sku),
        ),
      'Неизвестное оборудование или материал.',
    );
    requireValue(
      Object.entries(task.issued).every(([sku, quantity]) =>
        stage.materials.some(
          (m) => m.sku === sku && m.quantity * task.quantity >= quantity,
        ),
      ),
      'Нельзя убрать уже полученные материалы.',
    );
    Object.assign(task, stage, { needsSetup: false });
    if (
      task.workerId &&
      !canWorker(
        task,
        state.workers.find((w) => w.id === task.workerId),
        state.resources,
      )
    )
      task.workerId = null;
    if (
      task.pin &&
      !canWorker(
        task,
        state.workers.find((w) => w.id === task.pin.workerId),
        state.resources,
      )
    )
      task.pin = null;
  } else if (input.type === 'product.catalog.seed') {
    admin(actor);
    for(const entry of PRODUCTS){
      const matches=state.products.filter(p=>p.name===entry.name && !p.sourceProductId);
      requireValue(matches.length<=1,'Неоднозначное название изделия в справочнике.');
      if(matches.length){matches[0].orderFormKey=entry.id;continue;}
      state.products.push({id:'order-catalog-'+entry.id,name:entry.name,unit:'шт',orderFormKey:entry.id,needsSetup:true,versions:[{version:1,stages:[],createdAt:now.toISOString()}]});
    }
  } else if (input.type === 'product.option.add') {
    admin(actor);
    const scopes=new Set(['film','variant-steps']);
    for(const [type,sections] of Object.entries(schemas))for(const field of sections.flatMap(s=>s.fields))if(field.opts)scopes.add(['kind','purpose','composition','shape','mount'].includes(field.key)?type+':'+field.key:field.key);
    requireValue(scopes.has(data.scope)&&typeof data.value==='string'&&data.value.trim()&&data.value.length<=100&&![...data.value].some(c=>c.charCodeAt(0)<32),'Проверьте параметр и название варианта.');
    state.orderOptions ||= {};
    const list=state.orderOptions[data.scope] ||= [];
    const normalize=v=>v.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('ru-RU');
    requireValue(list.length<500,'Справочник параметра заполнен.');
    if(!list.some(v=>normalize(v)===normalize(data.value)))list.push(data.value.normalize('NFKC').trim().replace(/\s+/g,' '));
  } else if (input.type === 'product.save') {
    admin(actor);
    validateRoute(data.stages);
    requireValue(
      text(data.name) && text(data.name).length <= 160 && text(data.unit),
      'Укажите название продукта и единицу.',
    );
    requireValue(
      data.stages.every(
        (s) =>
          (!s.resourceId ||
            state.resources.some((r) => r.id === s.resourceId)) &&
          s.materials.every((m) =>
            state.warehouse.some((w) => w.sku === m.sku),
          ),
      ),
      'В маршруте неизвестное оборудование или материал.',
    );
    let product = state.products.find((p) => p.id === data.id);
    if (!product) {
      product = {
        id: id(),
        name: text(data.name),
        unit: text(data.unit),
        versions: [],
      };
      state.products.push(product);
    }
    product.name = text(data.name);
    product.unit = text(data.unit);
    product.needsSetup = false;
    product.versions.push({
      version: (product.versions.at(-1)?.version || 0) + 1,
      stages: structuredClone(data.stages),
      createdAt: now.toISOString(),
    });
  } else if (input.type === 'item.add') {
    admin(actor);
    addProductionItem(state, data, now);
  } else if (input.type === 'worker.save') {
    admin(actor);
    requireValue(
      text(data.name) && text(data.name).length <= 80,
      'Укажите имя мастера.',
    );
    requireValue(
      Array.isArray(data.skills) &&
        data.skills.every((s) => typeof s === 'string' && s.length <= 80) &&
        Array.isArray(data.zones) &&
        data.zones.every((z) => state.resources.some((r) => r.zone === z)),
      'Проверьте компетенции и рабочие зоны.',
    );
    requireValue(
      /^([01]\d|2[0-3]):[0-5]\d$/.test(data.shiftStart) &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(data.shiftEnd) &&
        data.shiftEnd > data.shiftStart,
      'Для пилота задайте дневную смену: начало раньше окончания.',
    );
    requireValue(
      Array.isArray(data.days) &&
        data.days.length &&
        data.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6),
      'Выберите рабочие дни.',
    );
    requireValue(
      ['master', 'lead'].includes(data.role) &&
        typeof data.enabled === 'boolean' &&
        typeof data.access === 'boolean',
      'Проверьте роль и доступ.',
    );
    let worker = state.workers.find((w) => w.id === data.id);
    if (!worker) {
      worker = { id: id() };
      state.workers.push(worker);
    }
    if (
      activeProductionTasks(state).some(
        (t) => t.workerId === worker.id && t.status === 'running',
      )
    )
      requireValue(
        data.enabled &&
          activeProductionTasks(state)
            .filter((t) => t.workerId === worker.id && t.status === 'running')
            .every((t) => data.skills.includes(t.skill)),
        'Сначала завершите или приостановите текущую работу мастера.',
      );
    Object.assign(worker, {
      name: text(data.name),
      skills: [...new Set(data.skills)],
      zones: [...new Set(data.zones)],
      shiftStart: data.shiftStart,
      shiftEnd: data.shiftEnd,
      days: [...new Set(data.days)],
      enabled: data.enabled,
      access: data.access,
      role: data.role,
    });
  } else if (input.type === 'warehouse.refill') {
    admin(actor);
    const material = state.warehouse.find((w) => w.sku === data.sku);
    requireValue(
      material &&
        Number.isFinite(data.quantity) &&
        data.quantity > 0 &&
        data.quantity <= 100000,
      'Проверьте материал и количество.',
    );
    material.stock += data.quantity;
  } else if (input.type === 'plan.refresh') {
    admin(actor);
  } else throw new PlanningError('Неизвестная команда.');
  state.revision++;
  state.receipts[input.requestId] = { hash, at: now.toISOString() };
  state.events.push({
    id: id(),
    actorId: actor.id,
    type: input.type,
    taskId: task?.id || null,
    at: now.toISOString(),
  });
  return { state, duplicate: false };
}
