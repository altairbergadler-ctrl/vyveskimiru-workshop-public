// Pure finite-capacity planner. Business data is supplied by the caller.
const MINUTE = 60_000;
export class PlanningError extends Error {
  constructor(message, code = 'invalid', statusCode = 422) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}
export function requireValue(condition, message, code, statusCode) {
  if (!condition) throw new PlanningError(message, code, statusCode);
}
export function validateRoute(stages) {
  requireValue(
    Array.isArray(stages) && stages.length > 0 && stages.length <= 40,
    'В маршруте должно быть от 1 до 40 этапов.',
  );
  const ids = new Set(stages.map((s) => s.id));
  requireValue(
    ids.size === stages.length &&
      stages.every(
        (s) => typeof s.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(s.id),
      ),
    'Нужны уникальные ID этапов.',
  );
  for (const s of stages) {
    requireValue(
      typeof s.name === 'string' && s.name.trim() && s.name.length <= 160,
      'Укажите название этапа.',
    );
    requireValue(
      ['manual', 'machine', 'wait'].includes(s.kind),
      'Неизвестный тип работы.',
    );
    requireValue(
      Number.isFinite(s.minutes) && s.minutes >= 1 && s.minutes <= 10080,
      'Длительность этапа: от 1 до 10080 минут.',
    );
    requireValue(
      Array.isArray(s.dependencies) &&
        new Set(s.dependencies).size === s.dependencies.length &&
        s.dependencies.every((id) => ids.has(id) && id !== s.id),
      'Зависимость должна указывать на другой этап этого маршрута.',
    );
    requireValue(
      s.kind === 'wait' || (typeof s.skill === 'string' && s.skill.trim()),
      'Для работы укажите компетенцию.',
    );
    requireValue(
      s.kind !== 'machine' || Boolean(s.resourceId),
      'Для машинного этапа требуется оборудование.',
    );
    if (s.kind === 'machine') {
      requireValue(
        [
          s.setupMinutes,
          s.finishMinutes,
          s.controlMinutes,
          s.controlEvery,
        ].every((n) => Number.isFinite(n) && n >= 0 && n <= s.minutes),
        'Проверьте время обслуживания оборудования.',
      );
      requireValue(
        s.setupMinutes >= 1 &&
          s.finishMinutes >= 1 &&
          s.setupMinutes + s.finishMinutes <= s.minutes,
        'Включите запуск и снятие результата в общую длительность.',
      );
      requireValue(
        !s.controlMinutes || s.controlEvery > s.controlMinutes,
        'Интервал контроля должен быть больше длительности контроля.',
      );
    }
    requireValue(
      Array.isArray(s.materials) &&
        s.materials.every(
          (m) =>
            typeof m.sku === 'string' &&
            m.sku &&
            Number.isFinite(m.quantity) &&
            m.quantity > 0,
        ),
      'Проверьте материалы и их количества.',
    );
    requireValue(
      new Set(s.materials.map((m) => m.sku)).size === s.materials.length,
      'Материал повторяется в одном этапе.',
    );
  }
  const visiting = new Set(),
    done = new Set();
  function visit(id) {
    if (done.has(id)) return;
    requireValue(!visiting.has(id), 'В маршруте получился круг зависимостей.');
    visiting.add(id);
    stages.find((s) => s.id === id).dependencies.forEach(visit);
    visiting.delete(id);
    done.add(id);
  }
  stages.forEach((s) => visit(s.id));
  return stages;
}
// Imported markers describe provenance; only incomplete settings block work.
export function stageConfigurationIssue(stage, state) {
  try {
    validateRoute([{ ...stage, dependencies: [] }]);
    requireValue(
      !stage.resourceId ||
        state.resources.some((r) => r.id === stage.resourceId),
      'Выберите существующее оборудование этапа.',
    );
    requireValue(
      stage.materials.every((m) =>
        state.warehouse.some((w) => w.sku === m.sku),
      ),
      'Выберите существующие материалы этапа.',
    );
    return '';
  } catch (error) {
    if (error instanceof PlanningError) return error.message;
    throw error;
  }
}
export function operatorIntervals(task, start, duration = task.minutes) {
  const finish = start + duration * MINUTE;
  if (task.kind === 'wait') return [];
  if (task.kind === 'manual') return [[start, finish]];
  const setup = Math.min(task.setupMinutes, duration),
    take = Math.min(task.finishMinutes, duration);
  const intervals = [
    [start, start + setup * MINUTE],
    [Math.max(start, finish - take * MINUTE), finish],
  ];
  if (task.controlMinutes && task.controlEvery)
    for (
      let m = setup + task.controlEvery;
      m + task.controlMinutes < duration - take;
      m += task.controlEvery
    )
      intervals.push([
        start + m * MINUTE,
        start + (m + task.controlMinutes) * MINUTE,
      ]);
  return intervals
    .sort((a, b) => a[0] - b[0])
    .reduce((all, i) => {
      const last = all.at(-1);
      if (last && i[0] <= last[1]) last[1] = Math.max(last[1], i[1]);
      else all.push(i);
      return all;
    }, []);
}
const overlap = (a, b) => a[0] < b[1] && b[0] < a[1];
export function materialsFor(task, warehouse) {
  return task.materials.map((m) => {
    const stock = warehouse.find((w) => w.sku === m.sku);
    const issued = task.issued?.[m.sku] || 0,
      need = m.quantity * task.quantity;
    return {
      ...m,
      name: stock?.name || m.sku,
      unit: stock?.unit || '',
      location: stock?.location || '',
      need,
      issued,
      remaining: Math.max(0, need - issued),
      available: stock ? Math.max(0, stock.stock - (stock.reserved || 0)) : 0,
    };
  });
}
export function canWorker(task, worker, resources) {
  const resource = resources.find((r) => r.id === task.resourceId);
  return Boolean(
    worker?.enabled &&
    worker.skills.includes(task.skill) &&
    (!resource || worker.zones.includes(resource.zone)),
  );
}
export function taskDeadline(task, timeZone) {
  const deadline = Date.parse(task.dueAt) || Infinity;
  if (!task.mustDate) return deadline;
  const wallTime = Date.parse(task.mustDate + 'T23:59:59Z');
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  let instant = wallTime;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(
      formatter.formatToParts(instant).map(({ type, value }) => [type, value]),
    );
    const shown = Date.parse(
      `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`,
    );
    instant += wallTime - shown;
  }
  return Math.min(deadline, instant);
}
export function isProductionOrderActive(order) {
  return (
    Boolean(order) &&
    !['Готов к выдаче', 'Монтаж', 'Сдан', 'Отменён', 'Выполненная'].includes(
      order.actualStatus || order.status,
    )
  );
}
export function activeProductionTasks(state) {
  const ids = new Set(
    state.orders.filter(isProductionOrderActive).map((o) => o.id),
  );
  return state.tasks.filter((t) => ids.has(t.orderId));
}
export function planProduction(
  state,
  { now = new Date(), horizonDays = 7 } = {},
) {
  state = { ...state, tasks: activeProductionTasks(state) };
  const startNow = Math.ceil(now.getTime() / MINUTE) * MINUTE,
    horizon = startNow + horizonDays * 86400000;
  const workers = new Map(state.workers.map((w) => [w.id, w])),
    tasks = new Map(state.tasks.map((t) => [t.id, t]));
  const deadlines = new Map(
    state.tasks.map((t) => [t.id, taskDeadline(t, state.timeZone)]),
  );
  const resourceBusy = new Map(),
    workerBusy = new Map(),
    planned = new Map(),
    unplanned = new Map();
  const materialBudget = new Map(
    state.warehouse.map((w) => [
      w.sku,
      Math.max(0, w.stock - (w.reserved || 0)),
    ]),
  );
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: state.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const localCache = new Map();
  function local(ms) {
    const key = Math.floor(ms / MINUTE);
    if (!localCache.has(key))
      localCache.set(
        key,
        Object.fromEntries(
          formatter.formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
        ),
      );
    return localCache.get(key);
  }
  const hm = (s) => {
    const [h, m] = s.split(':').map(Number);
    return h * 60 + m;
  };
  function shiftFits(worker, from, to) {
    const a = local(from),
      b = local(to - 1),
      minute = (p) => Number(p.hour) * 60 + Number(p.minute);
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
      a.weekday,
    );
    return (
      a.day === b.day &&
      a.month === b.month &&
      a.year === b.year &&
      worker.days.includes(day) &&
      minute(a) >= hm(worker.shiftStart) &&
      minute(b) < hm(worker.shiftEnd)
    );
  }
  function workerFits(id, phases, zone) {
    if (!id) return true;
    const busy = workerBusy.get(id) || [];
    return phases.every(
      (i) =>
        shiftFits(workers.get(id), ...i) &&
        busy.every((b) => {
          const travel =
            zone && b.zone && zone !== b.zone
              ? state.travelMinutes * MINUTE
              : 0;
          return !overlap(i, [b.start - travel, b.end + travel]);
        }),
    );
  }
  function reserve(t, workerId, start, end, phases, reason) {
    const resource = state.resources.find((r) => r.id === t.resourceId),
      zone = resource?.zone || t.zone || '';
    if (t.resourceId)
      resourceBusy.set(t.resourceId, [
        ...(resourceBusy.get(t.resourceId) || []),
        [start, end],
      ]);
    if (workerId)
      workerBusy.set(workerId, [
        ...(workerBusy.get(workerId) || []),
        ...phases.map((i) => ({ start: i[0], end: i[1], taskId: t.id, zone })),
      ]);
    planned.set(t.id, {
      taskId: t.id,
      workerId,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      phases: phases.map((i) => ({
        start: new Date(i[0]).toISOString(),
        end: new Date(i[1]).toISOString(),
      })),
      reason,
      late: end > deadlines.get(t.id),
      fixed: Boolean(t.pin || t.status === 'running'),
    });
  }
  for (const t of state.tasks) {
    if (t.status === 'done') {
      planned.set(t.id, {
        taskId: t.id,
        workerId: t.workerId,
        start: t.startedAt,
        end: t.completedAt || new Date(startNow).toISOString(),
        phases: [],
        reason: 'Выполнено',
        late: false,
        done: true,
      });
      continue;
    }
    const configurationIssue = stageConfigurationIssue(t, state);
    if (configurationIssue) {
      unplanned.set(t.id, configurationIssue);
      continue;
    }
    if (t.status === 'paused' || t.blockedReason) {
      unplanned.set(t.id, t.blockedReason || 'Работа приостановлена');
      if (t.resourceId && t.startedAt)
        resourceBusy.set(t.resourceId, [[startNow, horizon]]);
      continue;
    }
    if (t.status === 'running') {
      const expected = Date.parse(t.expectedEnd),
        duration = Math.max(1, (expected - Date.parse(t.startedAt)) / MINUTE);
      if (expected <= now.getTime()) {
        unplanned.set(
          t.id,
          'Плановое время истекло: уточните оставшуюся длительность',
        );
        if (t.resourceId) resourceBusy.set(t.resourceId, [[startNow, horizon]]);
        if (t.workerId)
          workerBusy.set(t.workerId, [
            { start: startNow, end: horizon, taskId: t.id },
          ]);
        continue;
      }
      reserve(
        t,
        t.workerId,
        Date.parse(t.startedAt),
        expected,
        operatorIntervals(t, Date.parse(t.startedAt), duration).filter(
          (i) => i[1] > startNow,
        ),
        'Уже выполняется',
      );
    }
  }
  const criticalCache = new Map();
  function critical(id, seen = new Set()) {
    if (criticalCache.has(id)) return criticalCache.get(id);
    if (seen.has(id)) return 0;
    const next = new Set([...seen, id]);
    const t = tasks.get(id);
    const value =
      (t?.minutes || 0) +
      Math.max(
        0,
        ...state.tasks
          .filter((s) => s.dependencies.includes(id) && s.status !== 'done')
          .map((s) => critical(s.id, next)),
      );
    criticalCache.set(id, value);
    return value;
  }
  let pending = state.tasks.filter(
    (t) => !planned.has(t.id) && !unplanned.has(t.id),
  );
  while (pending.length) {
    const candidates = pending.filter((t) =>
      t.dependencies.every((id) => planned.has(id)),
    );
    if (!candidates.length) {
      pending.forEach((t) =>
        unplanned.set(
          t.id,
          'Ожидает предыдущие этапы или исправление зависимостей',
        ),
      );
      break;
    }
    candidates.sort(
      (a, b) =>
        Number(Boolean(b.pin?.start)) - Number(Boolean(a.pin?.start)) ||
        (a.pin?.rank ?? 9999) - (b.pin?.rank ?? 9999) ||
        Math.min(deadlines.get(a.id), horizon) -
          critical(a.id) * MINUTE -
          (Math.min(deadlines.get(b.id), horizon) - critical(b.id) * MINUTE) ||
        a.id.localeCompare(b.id),
    );
    const t = candidates[0];
    pending = pending.filter((p) => p.id !== t.id);
    const materials = materialsFor(t, state.warehouse);
    if (materials.some((m) => m.remaining > (materialBudget.get(m.sku) || 0))) {
      unplanned.set(t.id, 'Не хватает свободных материалов');
      continue;
    }
    const eligible =
      t.kind === 'wait'
        ? [null]
        : state.workers.filter(
            (w) =>
              canWorker(t, w, state.resources) &&
              (!t.pin?.workerId || t.pin.workerId === w.id),
          );
    if (!eligible.length) {
      unplanned.set(
        t.id,
        'Нет доступного мастера с нужной компетенцией и рабочей зоной',
      );
      continue;
    }
    const earliest = Math.max(
      startNow,
      ...t.dependencies.map((id) => Date.parse(planned.get(id).end)),
      Date.parse(t.notBefore) || 0,
    );
    const pinned = t.pin?.start ? Date.parse(t.pin.start) : null;
    if (pinned && pinned < earliest) {
      unplanned.set(
        t.id,
        'Закреплённое время конфликтует с зависимостями или уже прошло',
      );
      continue;
    }
    let best = null;
    for (const worker of eligible) {
      const resource = state.resources.find((r) => r.id === t.resourceId),
        zone = resource?.zone || t.zone || '';
      // Prefer a less versatile worker only after comparing feasible completion times.
      for (
        let at = pinned || earliest;
        at + t.minutes * MINUTE <= horizon;
        at += MINUTE
      ) {
        const end = at + t.minutes * MINUTE;
        if (
          !(resourceBusy.get(t.resourceId) || []).some((i) =>
            overlap([at, end], i),
          )
        ) {
          const phases = operatorIntervals(t, at);
          if (workerFits(worker?.id, phases, zone)) {
            const option = { at, end, worker, phases };
            if (
              !best ||
              option.end < best.end ||
              (option.end === best.end &&
                (worker?.skills.length || 0) <
                  (best.worker?.skills.length || 0))
            )
              best = option;
            break;
          }
        }
        if (pinned) break;
      }
    }
    if (!best) {
      unplanned.set(
        t.id,
        pinned
          ? 'Закреплённое время конфликтует с занятостью или сменой'
          : 'Не найдено свободное окно в ближайшие 7 дней',
      );
      continue;
    }
    materials.forEach((m) =>
      materialBudget.set(m.sku, (materialBudget.get(m.sku) || 0) - m.remaining),
    );
    reserve(
      t,
      best.worker?.id || null,
      best.at,
      best.end,
      best.phases,
      t.pin
        ? 'Закреплено руководителем'
        : t.kind === 'wait'
          ? 'Технологическое ожидание'
          : 'По сроку, зависимостям и доступным ресурсам',
    );
  }
  return {
    planned: [...planned.values()],
    unplanned: [...unplanned].map(([taskId, reason]) => ({ taskId, reason })),
    generatedAt: now.toISOString(),
    horizonDays,
  };
}
