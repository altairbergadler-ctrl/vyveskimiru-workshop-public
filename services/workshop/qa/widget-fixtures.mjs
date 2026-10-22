import { fixtures } from './fixtures.mjs';
import { SHEETS_SCHEMA, expectedFormula } from '../server/sheets-guard.mjs';

// Opt-in visual QA dataset. No real contacts or workspace records are copied.
export function widgetFixtures() {
  const tables = fixtures();
  const today = new Date();
  const iso = (offset) => {
    const d = new Date(today);
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const ru = (offset) => iso(offset).split('-').reverse().join('.');
  const set = (name, row, col, value) => {
    tables[name][row - 1] ??= [];
    const schema = SHEETS_SCHEMA.sheets[name],
      letter = String.fromCharCode(65 + col);
    tables[name][row - 1][col] = schema.formulas[letter]
      ? { formula: expectedFormula(schema, letter, row), value }
      : value;
  };
  const write = (name, row, values) =>
    values.forEach((v, col) => set(name, row, col, v));
  const clients = ['Вымышленная мастерская Луна', 'Вымышленное кафе Облако'];
  const titles = [
    'Учебная вывеска',
    'Учебный неон',
    'Учебная оклейка витрины',
    'Учебный световой короб',
    'Учебные объёмные буквы',
    'Учебный указатель',
    'Учебный баннер',
    'Учебная табличка',
  ];
  const statuses = [
    'В работе',
    'Расчёт / КП',
    'Готов к выдаче',
    'Монтаж',
    'Сдан',
  ];
  for (let n = 0; n < 8; n++)
    write('Заказы', n + 2, [
      String(9001 + n),
      titles[n],
      ru(-10),
      clients[n % 2],
      '',
      '',
      'Учебный мастер',
      n === 2
        ? 'Готов к выдаче'
        : n === 3
          ? 'Монтаж'
          : n === 4
            ? 'Сдан'
            : 'В работе',
      '',
      n === 7 ? '' : ru(n - 2),
      10000 + n * 2000,
      2000,
      500,
      7500,
      75,
      n === 2 ? 0 : 3000,
      n === 2 ? 14000 : 7000 + n * 2000,
      n - 2,
      'Только вымышленные данные',
    ]);
  for (let n = 0; n < statuses.length; n++)
    set('Настройки', n + 2, 5, statuses[n]);
  // A ready stage and a dependent waiting stage on the same item.
  write('Производство', 9, [
    '9001',
    titles[0],
    'Учебное изделие',
    clients[0],
    ru(2),
    'Сборка',
    false,
    'можно',
    'Учебный мастер',
    ru(0),
    '',
    1,
    2,
    '',
    '',
    '',
    'Проверка виджета и обратимой отметки',
  ]);
  write('Производство', 10, [
    '9001',
    titles[0],
    'Учебное изделие',
    clients[0],
    ru(2),
    'Упаковка',
    false,
    'ждёт',
    'Учебный мастер',
    ru(1),
    '',
    1,
    1,
    '',
    'Сборка',
    '',
    '',
  ]);
  write('Монтажи', 2, [
    'QA-I1',
    '9004',
    'Назначен',
    iso(1),
    '10:00',
    'Учебный контакт',
    '',
    'Учебная площадка, стенд 1',
    'Вымышленный монтаж',
    'Учебный мастер',
  ]);
  write('Монтажи', 3, [
    'QA-I2',
    '9002',
    'На согласовании',
    '',
    '',
    'Учебный контакт',
    '',
    '',
    '',
    'Учебный мастер',
  ]);
  const materials = [
    ['QA-M1', 'Учебный ПВХ 3 мм', 'лист', 2, 1, 5],
    ['QA-M2', 'Учебный акрил', 'лист', 1, 0, 3],
    ['QA-M3', 'Учебная белая плёнка', 'м', 8, 2, 20],
  ];
  materials.forEach(([sku, name, unit, stock, reserved, minimum], n) => {
    write('Склад', n + 2, [
      sku,
      'Учебные материалы',
      name,
      unit,
      100,
      108,
      stock,
      minimum,
      minimum - stock + reserved,
      '',
      '',
      'Учебная полка',
      reserved,
      '',
      'Прочее',
    ]);
    write('Движения склада', n + 2, [
      ru(-1),
      'Расход на заказ',
      sku,
      name,
      n + 2,
      unit,
      100,
      (n + 2) * 100,
      '9001',
      'Учебный мастер',
      'Демонстрационная выдача',
      -(n + 2),
    ]);
  });
  return tables;
}
