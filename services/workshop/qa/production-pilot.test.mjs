import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createDirectory, launch, removeDirectory } from './sandbox-lib.mjs';
import { productionFixture } from './production-fixture.mjs';
import { assertPilotEnvironment } from '../server/production-pilot.mjs';

test('pilot storage refuses a production environment even when the feature is accidentally enabled', () => {
  assert.throws(
    () =>
      assertPilotEnvironment({
        PRODUCTION_PILOT: 'offline',
        GOOGLE_SPREADSHEET_ID: 'real-sheet',
      }),
    /изолированном/,
  );
});
test('HTTP pilot enforces roles, persists results, retries once and moves the actual kanban after every chain', async () => {
  const directory = createDirectory('production-test-');
  let instance;
  const state = productionFixture();
  const makeTask = (id, orderId, itemId, workerId) => ({
    id,
    name: `Учебный этап ${id}`,
    skill: 'Сборка',
    resourceId: '',
    kind: 'manual',
    minutes: 1,
    setupMinutes: 0,
    finishMinutes: 0,
    controlEvery: 0,
    controlMinutes: 0,
    dependencies: [],
    materials: [],
    quantity: 1,
    doneQuantity: 0,
    status: 'todo',
    issued: {},
    orderId,
    itemId,
    unit: 'шт',
    dueAt: new Date(Date.now() + 86400000).toISOString(),
    mustDate: new Date().toISOString().slice(0, 10),
    workerId: null,
    pin: { workerId, rank: 1 },
  });
  state.tasks = [
    makeTask('task-one', '9001', 'item-one', 'victor'),
    makeTask('task-two', '9001', 'item-two', 'victor'),
    makeTask('task-foreign', '9002', 'item-foreign', 'alex'),
  ];
  state.items = state.tasks.map((t) => ({
    id: t.itemId,
    orderId: t.orderId,
    name: 'Учебное изделие',
    productVersion: 1,
  }));
  fs.writeFileSync(
    path.join(directory, 'production.json'),
    JSON.stringify(state),
  );
  try {
    instance = await launch(directory, { production: true });
    const api = async (
      route,
      method = 'GET',
      payload,
      cookie,
      expected = 200,
      origin,
    ) => {
      const r = await fetch(instance.base + route, {
        method,
        headers: {
          Cookie: cookie ?? `finance_session=${instance.token}`,
          Origin: origin || instance.base,
          'Content-Type': 'application/json',
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
      assert.equal(r.status, expected, `${route}: HTTP ${r.status}`);
      return r;
    };
    const snapshot = async (cookie) =>
      (await api('/api/production-pilot', 'GET', undefined, cookie)).json();
    const command = async (type, data, cookie, request) => {
      const current = await snapshot(cookie);
      const input = request || {
        requestId: crypto.randomUUID(),
        revision: current.revision,
        type,
        data,
      };
      const result = await (
        await api('/api/production-pilot/command', 'POST', input, cookie)
      ).json();
      return { input, result };
    };
    assert.equal(
      (await fetch(instance.base + '/api/production-pilot')).status,
      401,
    );
    await api(
      '/api/production-pilot/command',
      'POST',
      {},
      undefined,
      403,
      'https://other.invalid',
    );
    const privatePin = String(crypto.randomInt(100000, 999999));
    await api('/api/production-pilot/access', 'POST', {
      workerId: 'victor',
      pin: privatePin,
    });
    let current = await snapshot();
    const worker = current.workers.find((w) => w.id === 'victor');
    await command('worker.save', { ...worker, access: true });
    const login = await api(
      '/api/production-pilot/session',
      'POST',
      { login: 'victor', pin: privatePin },
      '',
    );
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const personal = await snapshot(cookie);
    assert.equal(personal.actor.id, 'victor');
    assert.equal(personal.orders.length, 1);
    assert.equal(personal.orders[0].id, '9001');
    assert.deepEqual(personal.products, []);
    assert.deepEqual(personal.warehouse, []);
    for (const route of [
      '/api/transactions',
      '/api/warehouse',
      '/kanban/api/board',
    ])
      await api(route, 'GET', undefined, cookie, 401);
    await api(
      '/api/production-pilot/command',
      'POST',
      {
        requestId: crypto.randomUUID(),
        revision: personal.revision,
        type: 'task.start',
        data: { taskId: 'task-foreign' },
      },
      cookie,
      403,
    );
    await api(
      '/api/production-pilot/command',
      'POST',
      {
        requestId: crypto.randomUUID(),
        revision: personal.revision,
        type: 'warehouse.refill',
        data: { sku: 'QA-M1', quantity: 1 },
      },
      cookie,
      403,
    );
    await command('task.start', { taskId: 'task-one' }, cookie);
    const first = await command(
      'task.complete',
      { taskId: 'task-one' },
      cookie,
    );
    const repeated = await command('', {}, cookie, first.input);
    assert.equal(repeated.result.records.length, 1);
    assert.equal(repeated.result.duplicate, true);
    let board = await (await api('/kanban/api/board?fresh=1')).json();
    assert.equal(board.orders.find((o) => o.id === '9001').status, 'В работе');
    await command('task.start', { taskId: 'task-two' }, cookie);
    // Lose access to the external transport after the durable completion: no duplicate completion or blind move.
    fs.writeFileSync(path.join(directory, 'fail-offline-dev'), 'fault');
    const second = await command(
      'task.complete',
      { taskId: 'task-two' },
      cookie,
    );
    assert.equal(second.result.records.length, 2);
    current = await snapshot();
    assert.ok(current.pendingOrders.includes('9001'));
    fs.unlinkSync(path.join(directory, 'fail-offline-dev'));
    await command('plan.refresh', {});
    board = await (await api('/kanban/api/board?fresh=1')).json();
    assert.equal(
      board.orders.find((o) => o.id === '9001').status,
      'Выполненная',
    );
    assert.equal(board.orders.find((o) => o.id === '9002').status, 'В работе');
    await instance.stop();
    instance = await launch(directory, { production: true });
    assert.equal((await snapshot(cookie)).records.length, 2);
    current = await snapshot();
    await command('worker.save', {
      ...current.workers.find((w) => w.id === 'victor'),
      access: false,
    });
    await api('/api/production-pilot', 'GET', undefined, cookie, 401);
    assert.equal(
      (await snapshot()).records.filter((r) => r.workerId === 'victor').length,
      2,
    );
  } finally {
    await instance?.stop();
    removeDirectory(directory);
  }
});
