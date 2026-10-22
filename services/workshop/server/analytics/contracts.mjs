export const METRIC_VERSION = 'workshop-business-v2-estimated-margin-50';
export const DAY = 86_400_000;
export const businessToday = (now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
export const isDate = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
export const shiftDate = (date, days) =>
  new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10);
export class AnalyticsError extends Error {
  constructor(code, message, statusCode = 503) {
    super(message);
    this.name = 'AnalyticsError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
export function periodFrom(params, now = new Date()) {
  const today = businessToday(now),
    from = params.get('from') || `${today.slice(0, 7)}-01`,
    to = params.get('to') || today;
  if (
    [...params.keys()].some(
      (key) => !['from', 'to', 'refresh'].includes(key),
    ) ||
    ['from', 'to', 'refresh'].some((key) => params.getAll(key).length > 1) ||
    (params.has('refresh') && params.get('refresh') !== '1') ||
    !isDate(from) ||
    !isDate(to) ||
    from > to ||
    from < '2000-01-01' ||
    to > today
  )
    throw new AnalyticsError(
      'ANALYTICS_PERIOD',
      'Выберите корректный период до сегодняшнего дня.',
      400,
    );
  const days = (Date.parse(to) - Date.parse(from)) / DAY + 1;
  if (days > 366)
    throw new AnalyticsError(
      'ANALYTICS_PERIOD',
      'Выберите период не длиннее 366 дней.',
      400,
    );
  return {
    from,
    to,
    days,
    previous: { from: shiftDate(from, -days), to: shiftDate(from, -1) },
    today,
    timeZone: 'Europe/Moscow',
  };
}
export const connections = [
  {
    id: 'yandex_direct',
    name: 'Яндекс Директ',
    short: 'Я',
    kind: 'Реклама',
    planned: 'Расходы, показы, клики и кампании',
    requires: 'Подключение рекламного кабинета и сверка отчёта.',
  },
  {
    id: 'vk_ads',
    name: 'VK Реклама',
    short: 'VK',
    kind: 'Реклама',
    planned: 'Кампании, расходы и результаты рекламы',
    requires: 'Подключение кабинета VK и проверка доступных показателей.',
  },
  {
    id: 'avito',
    name: 'Авито',
    short: 'A',
    kind: 'Объявления',
    planned: 'Объявления, просмотры и контакты',
    requires: 'Собственный кабинет с объявлениями. Доступные показатели статистики проверяются при подключении.',
  },
  {
    id: 'telegram_ads',
    name: 'Telegram',
    short: 'T',
    kind: 'Реклама и размещения',
    planned: 'Отчёты рекламы и отдельный учёт посевов',
    requires:
      'Выбор доступного отчёта кабинета или партнёра; посевы учитываются отдельно.',
  },
  {
    id: 'yandex_metrica',
    name: 'Яндекс Метрика',
    short: 'M',
    kind: 'Посещаемость',
    planned: 'Визиты и цели на сайтах',
    requires: 'Доступ к счётчику сайта и согласование целей.',
  },
  {
    id: 'website',
    name: 'Сайты и формы',
    short: '↗',
    kind: 'Обращения',
    planned: 'Формы, рекламные метки и связь с заказом',
    requires: 'Сбор заявок на сайте и реестр обращений со связью с заказом.',
  },
].map((source) => ({
  ...source,
  state: 'not_connected',
  lastSuccessAt: null,
  metrics: null,
}));
export const definitions = [
  {
    id: 'income',
    label: 'Поступления',
    unit: 'RUB',
    basis: 'Дата платежа',
    rule: 'Сумма подтверждённых приходов за период по всем счетам, включая замеры. Флаг «Деньги в кассе» не исключает приход.',
    source: 'Платежи',
  },
  {
    id: 'expense',
    label: 'Выплаты',
    unit: 'RUB',
    basis: 'Дата расхода',
    rule: 'Сумма подтверждённых денежных расходов за период по всем категориям. Складские движения сюда не добавляются.',
    source: 'Расходы',
  },
  {
    id: 'net',
    label: 'Денежный поток',
    unit: 'RUB',
    basis: 'Даты операций',
    rule: 'Поступления минус выплаты за период. Это не прибыль и не остаток счёта.',
    source: 'Платежи, Расходы',
  },
  {
    id: 'orders',
    label: 'Новые заказы',
    unit: 'count',
    basis: 'Дата заказа',
    rule: 'Число уникальных заказов с датой создания в периоде, кроме отменённых. Текущее состояние читается из Google.',
    source: 'Заказы',
  },
  {
    id: 'orderAmount',
    label: 'Сумма новых заказов',
    unit: 'RUB',
    basis: 'Дата заказа',
    rule: 'Текущая формульная сумма заказов, созданных в периоде, кроме отменённых. Это не поступления за период.',
    source: 'Заказы!K',
  },
  {
    id: 'profit',
    label: 'Оценочная прибыль заказов',
    unit: 'RUB',
    basis: 'Дата заказа',
    rule: 'Временная оценка: 50% суммы каждого неотменённого заказа до рекламы, с округлением до копейки. Не фактическая прибыль; исходные затраты и формулы Google сохранены.',
    source: 'Сумма заказа из Google; оценочная маржа 50%',
  },
  {
    id: 'debt',
    label: 'Долг по всем заказам',
    unit: 'RUB',
    basis: 'Текущее состояние',
    rule: 'Сумма положительных формульных долгов всех неотменённых заказов независимо от периода. Переплаты показаны отдельно.',
    source: 'Заказы!Q',
  },
  {
    id: 'source',
    label: 'Источник клиента',
    unit: 'label',
    basis: 'Дата заказа',
    rule: 'Однозначный источник из карточки клиента. Не доказывает рекламную кампанию или источник конкретного заказа; неоднозначные и пустые связи остаются неизвестными.',
    source: 'Клиенты!H → Заказы',
  },
  {
    id: 'advertisingPayments',
    label: 'Оплачено за рекламу',
    unit: 'RUB',
    basis: 'Дата расхода',
    rule: 'Денежные расходы категории «Реклама и продвижение». Пополнение кабинета не равно рекламному списанию; данные кабинетов с этой суммой не складываются.',
    source: 'Расходы',
  },
  {
    id: 'funnel',
    label: 'Статусы заказов',
    unit: 'count',
    basis: 'Дата заказа',
    rule: 'Текущие статусы созданных в периоде заказов, включая отменённые. Это распределение, а не история переходов или конверсия.',
    source: 'Заказы',
  },
];
