import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandQueue } from './command-queue.mjs';

test('concurrent readers share work, then refresh instead of retaining a result', async () => {
  const queue = new CommandQueue();
  const gate = Promise.withResolvers();
  let calls = 0;
  const read = () => queue.read('finance', async () => { calls++; await gate.promise; return 7; });
  const requests = Array.from({ length: 50 }, read);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(queue.waiting, 1);
  assert.equal(queue.status().active.label, 'read:finance');
  gate.resolve();
  assert.deepEqual(await Promise.all(requests), Array(50).fill(7));
  assert.equal(queue.waiting, 0);
  assert.equal(queue.status().active, null);
  await read();
  assert.equal(calls, 2);
});

test('a write is a barrier: readers on either side see the correct state', async () => {
  const queue = new CommandQueue(), gate = Promise.withResolvers();
  let value = 1;
  const first = queue.read('finance', async () => { await gate.promise; return value; });
  const write = queue.run(() => { value = 2; });
  const next = queue.read('finance', () => value);
  const repeat = queue.read('finance', () => { throw new Error('duplicate read'); });
  assert.equal(next, repeat);
  assert.notEqual(first, next);
  gate.resolve();
  assert.equal(await first, 1);
  await write;
  assert.equal(await next, 2);
  assert.equal(queue.waiting, 0);
});

test('a failed read releases its shared flight and preserves the following writer', async () => {
  const queue = new CommandQueue(), gate = Promise.withResolvers();
  const first = queue.read('finance', async () => { await gate.promise; throw new Error('upstream unavailable'); });
  const repeat = queue.read('finance', () => assert.fail('duplicate read'));
  let writes = 0;
  const write = queue.run(() => { writes++; });
  const settled = Promise.allSettled([first, repeat, write]);
  gate.resolve();
  const results = await settled;
  assert.deepEqual(results.map(r => r.status), ['rejected', 'rejected', 'fulfilled']);
  assert.equal(writes, 1);
  assert.equal(await queue.read('finance', () => 3), 3);
  assert.equal(queue.waiting, 0);
});
