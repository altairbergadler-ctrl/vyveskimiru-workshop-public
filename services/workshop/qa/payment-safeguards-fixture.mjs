import fs from 'node:fs';
import path from 'node:path';
import { fixtures } from './fixtures.mjs';
import { shiftFormula } from '../server/sheets-guard.mjs';

export function seedPaymentSafeguards(directory) {
  const tables = fixtures();
  const set = (row, index, value) => {
    if (row[index] && typeof row[index] === 'object') row[index].value = value;
    else row[index] = value;
  };
  const base = structuredClone(tables['Заказы'][2]);
  for (const [number, title, total, paid, debt, status] of [
    ['9002', 'Учебный оплаченный', 5000, 5000, 0, 'Сдан'],
    ['9003', 'Учебная переплата', 5000, 5500, -500, 'Сдан'],
    ['9004', 'Учебный отменённый', 5000, 0, 5000, 'Отменён'],
    ['9005', 'Учебный без суммы', 0, 0, 0, 'Расчёт / КП'],
    ['9006', 'Учебный ожидает оплату', 5000, 0, 5000, 'Расчёт / КП'],
  ]) {
    const row = structuredClone(base);
    for (const value of row) if (value?.formula) value.formula = shiftFormula(value.formula, Number(number) - 9002);
    for (const [index, value] of [[0, number], [1, title], [7, status], [10, total], [15, paid], [16, debt]]) set(row, index, value);
    tables['Заказы'][Number(number) - 9000] = row;
  }
  for (const status of ['Сдан', 'Отменён']) tables['Настройки'].push(['', '', '', '', '', status]);
  fs.writeFileSync(path.join(directory, 'sheet.json'), JSON.stringify(tables));
}
