import test from 'node:test';
import assert from 'node:assert/strict';
import { estimatedOrderProfit } from './order-profit.mjs';
test('temporary profit uses order amount before ads, handles cents and unknown amounts', () => {
  assert.equal(estimatedOrderProfit(100000), 50000);
  assert.equal(estimatedOrderProfit(100000) - 10000, 40000);
  assert.equal(estimatedOrderProfit(0), 0);
  assert.equal(estimatedOrderProfit(0.01), 0.01);
  assert.equal(estimatedOrderProfit(-0.01), -0.01);
  for (const input of [null, undefined, '100', Infinity, NaN, 1.001, 1e20])
    assert.equal(estimatedOrderProfit(input), null);
});
