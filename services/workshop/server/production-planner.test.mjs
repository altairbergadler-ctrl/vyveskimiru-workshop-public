import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  planProduction,
  validateRoute,
  operatorIntervals,
  taskDeadline,
} from './production-planner.mjs';
import {
  addProductionItem,
  applyProductionCommand,
  snapshotFor,
} from './production-workflow.mjs';
import { productionFixture } from '../qa/production-fixture.mjs';
const now = new Date('2026-09-07T06:00:00Z');
const owner = { id: 'owner', role: 'owner' };

test('closed orders leave the queue and free capacity without deleting stages or personal history', () => {
  for (const status of [
    'Сдан',
    'Отменён',
    'Готов к выдаче',
    'Монтаж',
    'Выполненная',
  ]) {
    const state = fixture([
      task('old', {
        status: 'running',
        workerId: 'victor',
        startedAt: now.toISOString(),
        expectedEnd: '2026-09-07T15:00:00Z',
      }),
      task('current', {
        orderId: '9002',
        pin: { workerId: 'victor', rank: 1 },
      }),
    ]);
    state.orders[0].status = 'Выполненная';
    state.orders[0].actualStatus = status;
    state.records.push({
      id: 'history',
      taskId: 'old',
      orderId: '9001',
      workerId: 'victor',
      stage: 'Прошлая работа',
      quantity: 1,
    });
    const before = structuredClone(state);
    const view = snapshotFor(state, owner, now);
    assert.deepEqual(
      view.tasks.map((t) => t.id),
      ['current'],
    );
    assert.deepEqual(
      view.orders.map((o) => o.id),
      ['9002'],
    );
    assert.equal(
      view.plan.planned.find((t) => t.taskId === 'current').start,
      now.toISOString(),
    );
    assert.equal(view.records[0].id, 'history');
    assert.deepEqual(state, before);
    for (const type of [
      'task.start',
      'task.issue',
      'task.complete',
      'task.assign',
    ])
      assert.throws(
        () => cmd(state, type, { taskId: 'old' }),
        (e) => e.code === 'order_closed',
      );
    state.orders[0].status = 'В работе';
    delete state.orders[0].actualStatus;
    assert.equal(snapshotFor(state, owner, now).tasks.length, 2);
  }
});
test('mandatory day uses the workshop timezone and never extends the order deadline', () => {
  assert.equal(
    new Date(
      taskDeadline(
        { mustDate: '2026-09-07', dueAt: '2026-09-10T12:00:00Z' },
        'Europe/Moscow',
      ),
    ).toISOString(),
    '2026-09-07T20:59:59.000Z',
  );
  assert.equal(
    new Date(
      taskDeadline(
        { mustDate: '2026-09-07', dueAt: '2026-09-07T12:00:00Z' },
        'Europe/Moscow',
      ),
    ).toISOString(),
    '2026-09-07T12:00:00.000Z',
  );
});
function task(id, extra = {}) {
  return {
    id,
    name: id,
    kind: 'manual',
    skill: 'Сборка',
    resourceId: '',
    minutes: 20,
    dependencies: [],
    materials: [],
    quantity: 1,
    doneQuantity: 0,
    issued: {},
    status: 'todo',
    orderId: '9001',
    itemId: 'item',
    unit: 'шт',
    dueAt: '2026-09-07T15:00:00Z',
    mustDate: '2026-09-07',
    ...extra,
  };
}
function fixture(tasks) {
  const state = productionFixture(now);
  state.tasks = tasks;
  state.items = [{ id: 'item', orderId: '9001' }];
  return state;
}
function cmd(
  state,
  type,
  data,
  actor = owner,
  time = now,
  requestId = crypto.randomUUID(),
) {
  return applyProductionCommand(
    state,
    actor,
    { requestId, revision: state.revision, type, data },
    time,
  ).state;
}

test('route rejects cycles, dangling IDs, duplicate IDs and invalid machine attention', () => {
  assert.throws(
    () =>
      validateRoute([
        task('a', { dependencies: ['b'] }),
        task('b', { dependencies: ['a'] }),
      ]),
    /круг/,
  );
  assert.throws(
    () => validateRoute([task('a', { dependencies: ['missing'] })]),
    /Зависимость/,
  );
  assert.throws(() => validateRoute([task('a'), task('a')]), /уникальные/);
  assert.throws(
    () =>
      validateRoute([
        task('a', {
          kind: 'machine',
          resourceId: 'cnc',
          setupMinutes: 15,
          finishMinutes: 15,
          controlMinutes: 0,
          controlEvery: 0,
        }),
      ]),
    /общую длительность/,
  );
});
test('all branches of all items must complete before the order is queued for the board', () => {
  let s = fixture([task('one'), task('two', { itemId: 'other' })]);
  s.items.push({ id: 'other', orderId: '9001' });
  s = cmd(s, 'task.start', { taskId: 'one' });
  s = cmd(s, 'task.complete', { taskId: 'one' });
  assert.deepEqual(s.pendingOrders, []);
  s = cmd(s, 'task.start', { taskId: 'two' });
  s = cmd(s, 'task.complete', { taskId: 'two' });
  assert.deepEqual(s.pendingOrders, ['9001']);
  assert.equal(s.records.length, 2);
});
test('parallel join cannot start until all predecessor chains have finished', () => {
  let s = fixture([
    task('a', { status: 'done', completedAt: now.toISOString() }),
    task('b'),
    task('join', { dependencies: ['a', 'b'] }),
  ]);
  assert.throws(
    () => cmd(s, 'task.start', { taskId: 'join' }),
    /все предыдущие/,
  );
  s = cmd(s, 'task.start', { taskId: 'b' });
  s = cmd(s, 'task.complete', { taskId: 'b' });
  assert.equal(
    cmd(s, 'task.start', { taskId: 'join' }).tasks[2].status,
    'running',
  );
});
test('partial completion preserves remaining quantity and does not release dependents', () => {
  let s = fixture([
    task('a', { quantity: 4 }),
    task('b', { dependencies: ['a'] }),
  ]);
  s = cmd(s, 'task.start', { taskId: 'a' });
  assert.throws(
    () => cmd(s, 'task.complete', { taskId: 'a', quantity: 5 }),
    /оставшийся/,
  );
  s = cmd(s, 'task.complete', { taskId: 'a', quantity: 2 });
  assert.equal(s.tasks[0].doneQuantity, 2);
  assert.equal(s.tasks[0].status, 'paused');
  assert.equal(s.records[0].partial, true);
  assert.throws(() => cmd(s, 'task.start', { taskId: 'b' }), /все предыдущие/);
  s = cmd(s, 'task.resume', { taskId: 'a' });
  s = cmd(s, 'task.complete', { taskId: 'a', quantity: 2 });
  assert.equal(s.tasks[0].status, 'done');
});
test('receipt replay is exact and stale or changed requests never apply again', () => {
  let s = fixture([task('a')]);
  const input = {
    requestId: crypto.randomUUID(),
    revision: 0,
    type: 'task.start',
    data: { taskId: 'a' },
  };
  s = applyProductionCommand(s, owner, input, now).state;
  assert.equal(applyProductionCommand(s, owner, input, now).duplicate, true);
  assert.throws(
    () =>
      applyProductionCommand(
        s,
        owner,
        { ...input, data: { taskId: 'b' } },
        now,
      ),
    /другим содержимым/,
  );
  assert.throws(
    () =>
      applyProductionCommand(
        s,
        owner,
        { ...input, requestId: crypto.randomUUID() },
        now,
      ),
    /Данные изменились/,
  );
});
test('issue requires stock and is atomic and idempotent; merely viewing never consumes', () => {
  let s = fixture([
    task('a', { materials: [{ sku: 'QA-M1', quantity: 2 }], quantity: 4 }),
  ]);
  snapshotFor(s, owner, now);
  assert.equal(s.warehouse[0].stock, 20);
  assert.throws(
    () => cmd(s, 'task.start', { taskId: 'a' }),
    /получение материалов/,
  );
  s = cmd(s, 'task.issue', { taskId: 'a' });
  assert.equal(s.warehouse[0].stock, 12);
  s = cmd(s, 'task.issue', { taskId: 'a' });
  assert.equal(s.warehouse[0].stock, 12);
  assert.equal(s.movements.length, 1);
  s.tasks[0].materials.push({ sku: 'QA-FILM', quantity: 100 });
  assert.throws(() => cmd(s, 'task.issue', { taskId: 'a' }), /не хватает/);
  assert.equal(s.warehouse[0].stock, 12);
});
test('shortage remains visible to its capable master with mandatory date intact', () => {
  const s = fixture([
    task('a', { materials: [{ sku: 'QA-M1', quantity: 50 }] }),
  ]);
  const v = snapshotFor(s, { id: 'victor', role: 'master' }, now);
  assert.equal(v.tasks.length, 1);
  assert.match(v.tasks[0].schedulingProblem, /материал/);
  assert.equal(v.tasks[0].mustDate, '2026-09-07');
});
test('material budget prevents allocating the same remaining stock to two tasks', () => {
  const s = fixture([
    task('a', { materials: [{ sku: 'QA-M1', quantity: 15 }] }),
    task('b', { materials: [{ sku: 'QA-M1', quantity: 15 }] }),
  ]);
  const p = planProduction(s, { now });
  assert.equal(p.planned.length, 1);
  assert.match(p.unplanned[0].reason, /материал/);
});
test('machine autonomy can overlap a manual job in the same room without operator overlap', () => {
  const s = fixture([
    task('print', {
      skill: 'Принтер',
      resourceId: 'printer',
      kind: 'machine',
      minutes: 60,
      setupMinutes: 5,
      finishMinutes: 5,
      controlEvery: 0,
      controlMinutes: 0,
      dueAt: '2026-09-07T08:00:00Z',
    }),
    task('bend', {
      skill: 'Фендер',
      resourceId: 'bender',
      minutes: 20,
      pin: { workerId: 'boris', rank: 2 },
    }),
  ]);
  s.workers = s.workers.filter((w) => w.id === 'boris');
  s.tasks[0].pin = { workerId: 'boris', rank: 1 };
  const p = planProduction(s, { now });
  const a = p.planned.find((t) => t.taskId === 'print'),
    b = p.planned.find((t) => t.taskId === 'bend');
  assert.ok(Date.parse(b.start) >= Date.parse(a.start) + 5 * 60000);
  assert.ok(Date.parse(b.end) <= Date.parse(a.end) - 5 * 60000);
});
test('periodic checks and travel gaps are reserved, different operators cannot share a machine', () => {
  const phases = operatorIntervals(
    task('m', {
      kind: 'machine',
      minutes: 60,
      setupMinutes: 5,
      finishMinutes: 5,
      controlEvery: 15,
      controlMinutes: 2,
    }),
    +now,
  );
  assert.equal(phases.length, 5);
  const s = fixture([
    task('a', { resourceId: 'bench', minutes: 30 }),
    task('b', { resourceId: 'bench', minutes: 30 }),
  ]);
  const p = planProduction(s, { now });
  assert.ok(Date.parse(p.planned[1].start) >= Date.parse(p.planned[0].end));
});
test('manual overrides persist through recomputation and reject incompatible competencies', () => {
  let s = fixture([task('a')]);
  s = cmd(s, 'task.assign', { taskId: 'a', workerId: 'alex', rank: 1 });
  const p = planProduction(s, { now });
  assert.equal(p.planned[0].workerId, 'alex');
  assert.match(p.planned[0].reason, /Закреплено/);
  s.tasks[0].skill = 'Сварка';
  assert.throws(
    () => cmd(s, 'task.assign', { taskId: 'a', workerId: 'victor' }),
    /компетенции/,
  );
});
test('skills and working days are hard constraints; pinned conflicts stay explicit', () => {
  const s = fixture([
    task('a', { pin: { workerId: 'victor', start: now.toISOString() } }),
  ]);
  s.workers.find((w) => w.id === 'victor').days = [2];
  assert.match(planProduction(s, { now }).unplanned[0].reason, /конфликтует/);
  s.tasks[0].pin = null;
  s.tasks[0].skill = 'Нет такого навыка';
  assert.match(planProduction(s, { now }).unplanned[0].reason, /компетенцией/);
});
test('estimated finish never completes a manual job or frees an overdue machine', () => {
  const s = fixture([
    task('a', {
      status: 'running',
      workerId: 'victor',
      resourceId: 'bench',
      startedAt: new Date(+now - 3600000).toISOString(),
      expectedEnd: new Date(+now - 60000).toISOString(),
    }),
    task('b', { resourceId: 'bench' }),
  ]);
  const p = planProduction(s, { now });
  assert.match(p.unplanned.find((t) => t.taskId === 'a').reason, /истекло/);
  assert.equal(s.tasks[0].status, 'running');
  assert.ok(p.unplanned.some((t) => t.taskId === 'b'));
});
test('technical waiting cannot be confirmed before its minimum interval', () => {
  let s = fixture([task('dry', { kind: 'wait', skill: '', minutes: 10 })]);
  s = cmd(s, 'task.start', { taskId: 'dry' });
  assert.throws(
    () => cmd(s, 'task.complete', { taskId: 'dry' }),
    /не закончилось/,
  );
  s = cmd(
    s,
    'task.complete',
    { taskId: 'dry' },
    owner,
    new Date(+now + 10 * 60000),
  );
  assert.equal(s.tasks[0].status, 'done');
});
test('master cannot write someone else task or manage the catalog', () => {
  const s = fixture([task('a', { pin: { workerId: 'alex', rank: 1 } })]),
    master = { id: 'boris', role: 'master' };
  assert.throws(
    () => cmd(s, 'task.start', { taskId: 'a' }, master),
    /только назначенные/,
  );
  assert.throws(() => cmd(s, 'plan.refresh', {}, master), /руководителю/);
  const v = snapshotFor(s, master, now);
  assert.deepEqual(v.tasks, []);
  assert.deepEqual(v.orders, []);
  assert.deepEqual(v.products, []);
  assert.deepEqual(v.warehouse, []);
});
test('product version edit never changes instantiated item routes', () => {
  let s = productionFixture(now);
  addProductionItem(
    s,
    { orderId: '9001', productId: 'frame', quantity: 2 },
    now,
  );
  const old = structuredClone(s.tasks);
  const stages = structuredClone(
    s.products.find((p) => p.id === 'frame').versions[0].stages,
  );
  stages[0].minutes = 70;
  s = cmd(s, 'product.save', {
    id: 'frame',
    name: 'Рамка v2',
    unit: 'шт',
    stages,
  });
  assert.deepEqual(s.tasks, old);
  addProductionItem(
    s,
    { orderId: '9002', productId: 'frame', quantity: 1 },
    now,
  );
  assert.equal(s.tasks.at(-2).minutes, 70);
  assert.equal(s.items.at(-1).productVersion, 2);
});

test('valid imported routes start without re-saving; setup and real prerequisites still block', () => {
  let state = fixture([
    task('legacy', { needsSetup: true, workerId: 'victor' }),
  ]);
  const before = structuredClone(state);
  const view = snapshotFor(state, owner, now);
  assert.equal(view.tasks[0].needsSetup, false);
  assert.equal(view.tasks[0].startBlockedReason, '');
  assert.ok(view.plan.planned.some((p) => p.taskId === 'legacy'));
  assert.deepEqual(
    state,
    before,
    'read-only validation must not change history',
  );
  state = cmd(state, 'task.start', { taskId: 'legacy' });
  assert.equal(state.tasks[0].status, 'running');
  state = cmd(state, 'task.complete', { taskId: 'legacy' });
  assert.equal(state.tasks[0].status, 'done');
  for (const extra of [
    { skill: '' },
    { minutes: 0 },
    { resourceId: 'missing' },
    { materials: [{ sku: 'unknown', quantity: 1 }] },
  ]) {
    const invalid = fixture([
      task('invalid', { ...extra, workerId: 'victor', needsSetup: false }),
    ]);
    const snapshot = snapshotFor(invalid, owner, now);
    assert.equal(snapshot.tasks[0].needsSetup, true);
    assert.ok(snapshot.tasks[0].startBlockedReason);
    assert.throws(() => cmd(invalid, 'task.start', { taskId: 'invalid' }));
  }
  const waiting = fixture([
    task('first'),
    task('second', { dependencies: ['first'] }),
  ]);
  assert.match(
    snapshotFor(waiting, owner, now).tasks[1].startBlockedReason,
    /first/,
  );
  const noWorker = fixture([task('no-worker', { skill: 'Missing skill' })]);
  assert.match(
    snapshotFor(noWorker, owner, now).tasks[0].startBlockedReason,
    /мастера/,
  );
});

test('saving unchanged settings keeps a compatible assignee and queue pin', () => {
  let state = fixture([
    task('configured', {
      workerId: 'victor',
      pin: { workerId: 'victor', rank: 1 },
    }),
  ]);
  state = cmd(state, 'task.configure', {
    taskId: 'configured',
    stage: state.tasks[0],
  });
  assert.equal(state.tasks[0].workerId, 'victor');
  assert.equal(state.tasks[0].pin.workerId, 'victor');
  state = cmd(state, 'task.configure', {
    taskId: 'configured',
    stage: { ...state.tasks[0], skill: 'Missing skill' },
  });
  assert.equal(state.tasks[0].workerId, null);
  assert.equal(state.tasks[0].pin, null);
});
