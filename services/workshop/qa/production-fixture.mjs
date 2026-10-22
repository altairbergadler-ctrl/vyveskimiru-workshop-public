import { fixtures } from './fixtures.mjs';
export function productionSheetFixtures() {
  const tables = fixtures();
  tables['Настройки'][3][5] = 'Выполненная';
  tables['Заказы'][2][7] = 'В работе';
  // Legacy stages are absent in this opt-in dataset: the new routes have stable IDs.
  tables['Производство'] = tables['Производство'].map((row, index) =>
    index < 8
      ? row
      : row.map((value) => (value?.formula ? { ...value, value: '' } : '')),
  );
  return tables;
}
export function productionFixture(now = new Date()) {
  const stage = (
    id,
    name,
    skill,
    resourceId,
    minutes,
    dependencies = [],
    extra = {},
  ) => ({
    id,
    name,
    skill,
    resourceId,
    kind: 'manual',
    minutes,
    dependencies,
    materials: [],
    setupMinutes: 0,
    finishMinutes: 0,
    controlEvery: 0,
    controlMinutes: 0,
    ...extra,
  });
  const products = [
    {
      id: 'letters',
      name: 'Объёмные буквы',
      unit: 'буквы',
      versions: [
        {
          version: 1,
          stages: [
            stage('cut', 'Вырезать заготовки', 'ЧПУ', 'cnc', 30, [], {
              kind: 'machine',
              setupMinutes: 5,
              finishMinutes: 5,
              materials: [{ sku: 'QA-M1', quantity: 1 }],
            }),
            stage('bend', 'Погнуть борта', 'Фендер', 'bender', 20, [], {
              materials: [{ sku: 'QA-BORDER', quantity: 2 }],
            }),
            stage(
              'glue',
              'Склеить буквы с бортами',
              'Сборка',
              'bench',
              25,
              ['cut', 'bend'],
              { materials: [{ sku: 'QA-GLUE', quantity: 0.1 }] },
            ),
            stage('dry', 'Выдержка клея', '', 'drying', 10, ['glue'], {
              kind: 'wait',
            }),
            stage(
              'assemble',
              'Светодиоды, коммутация и проверка',
              'Сборка',
              'bench',
              40,
              ['dry'],
            ),
          ],
        },
      ],
    },
    {
      id: 'frame',
      name: 'Рамка',
      unit: 'шт',
      versions: [
        {
          version: 1,
          stages: [
            stage('weld', 'Сварить рамку', 'Сварка', 'welding', 35, [], {
              materials: [{ sku: 'QA-PROFILE', quantity: 4 }],
            }),
            stage('check', 'Проверить рамку', 'Сборка', 'bench', 10, ['weld']),
          ],
        },
      ],
    },
    {
      id: 'print',
      name: 'Печатная навигация',
      unit: 'компл.',
      versions: [
        {
          version: 1,
          stages: [
            stage(
              'print',
              'Напечатать навигацию',
              'Принтер',
              'printer',
              40,
              [],
              {
                kind: 'machine',
                setupMinutes: 5,
                finishMinutes: 5,
                controlEvery: 15,
                controlMinutes: 2,
                materials: [{ sku: 'QA-FILM', quantity: 2 }],
              },
            ),
            stage('trim', 'Обрезать и проверить', 'Сборка', 'bench', 10, [
              'print',
            ]),
          ],
        },
      ],
    },
  ];
  const workers = [
    {
      id: 'alex',
      name: 'Алексей',
      skills: ['ЧПУ', 'Фендер', 'Сварка', 'Сборка'],
      zones: ['Станочная', 'Печатная', 'Сварочная', 'Сборочная'],
    },
    {
      id: 'boris',
      name: 'Борис',
      skills: ['Фендер', 'Плоттер', 'Принтер', 'Сборка'],
      zones: ['Печатная', 'Сборочная'],
    },
    { id: 'victor', name: 'Виктор', skills: ['Сборка'], zones: ['Сборочная'] },
  ].map((w) => ({
    ...w,
    enabled: true,
    access: false,
    role: 'master',
    shiftStart: '00:00',
    shiftEnd: '23:59',
    days: [0, 1, 2, 3, 4, 5, 6],
  }));
  return {
    version: 1,
    revision: 0,
    timeZone: 'Europe/Athens',
    travelMinutes: 5,
    workers,
    products,
    resources: [
      ['cnc', 'ЧПУ', 'Станочная'],
      ['bender', 'Фендер', 'Печатная'],
      ['plotter', 'Плоттер', 'Печатная'],
      ['printer', 'Промышленный принтер', 'Печатная'],
      ['welding', 'Сварочный пост', 'Сварочная'],
      ['bench', 'Сборочный стол', 'Сборочная'],
      ['drying', 'Место сушки', 'Сборочная'],
    ].map(([id, name, zone]) => ({ id, name, zone })),
    warehouse: [
      ['QA-M1', 'Учебный пластик', 'шт', 20, 'Полка А1'],
      ['QA-BORDER', 'Алюминиевый борт', 'м', 30, 'Стеллаж Б2'],
      ['QA-GLUE', 'Клей', 'л', 2, 'Шкаф В1'],
      ['QA-PROFILE', 'Профиль для рамки', 'м', 12, 'Стеллаж Г1'],
      ['QA-FILM', 'Печатная плёнка', 'м²', 8, 'Рулоны П1'],
    ].map(([sku, name, unit, stock, location]) => ({
      sku,
      name,
      unit,
      stock,
      location,
      reserved: 0,
    })),
    orders: [
      {
        id: '9001',
        name: 'Учебная вывеска',
        customer: 'Вымышленная мастерская Луна',
        dueAt: new Date(+now + 6 * 3600000).toISOString(),
        status: 'В работе',
      },
      {
        id: '9002',
        name: 'Учебный стенд',
        customer: 'Вымышленное кафе Облако',
        dueAt: new Date(+now + 3 * 3600000).toISOString(),
        status: 'В работе',
      },
    ],
    items: [],
    tasks: [],
    records: [],
    events: [],
    receipts: {},
    pendingOrders: [],
    movements: [],
  };
}
