import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseExpenseCategories,
  readExpenseCategories,
} from './expense-categories.mjs';

test('expense categories keep exact sheet values and remove blank duplicates', () => {
  assert.deepEqual(
    parseExpenseCategories([
      [' Материалы: неон и комплектующие '],
      [''],
      ['материалы: НЕОН И КОМПЛЕКТУЮЩИЕ'],
      ['Материалы: инструмент и производственные расходники'],
    ]),
    [
      ' Материалы: неон и комплектующие ',
      'Материалы: инструмент и производственные расходники',
    ],
  );
});

test('expense categories are read from the Settings source range', async () => {
  const client = {
    configured: true,
    async getValues(sheetName, range) {
      assert.equal(sheetName, 'Настройки');
      assert.equal(range, 'D2:D31');
      return { values: [['Материалы: клеи и химия']] };
    },
  };

  assert.deepEqual(await readExpenseCategories(client), {
    categories: ['Материалы: клеи и химия'],
  });
});

test('expense categories reject an empty source range', () => {
  assert.throws(
    () => parseExpenseCategories([[''], []]),
    /не найдены категории расходов/,
  );
});
