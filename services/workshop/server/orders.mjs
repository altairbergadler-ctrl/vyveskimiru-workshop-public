const DEFAULT_SHEET = 'Заказы';

function text(value) {
  return value == null ? '' : String(value).trim();
}

function amount(value) {
  const normalized = text(value).replace(/[^\d,-]/g, '').replace(',', '.');
  return Math.round(Number(normalized || 0));
}

export async function readOrders(client, options = {}) {
  if (!client.configured) throw new Error('Google Таблица не настроена');
  const sheetName = options.sheetName || DEFAULT_SHEET;
  const response = await client.getValues(sheetName, 'A1:AB1000',
    options.includeRawNumber ? { valueRenderOption: 'UNFORMATTED_VALUE' } : {});
  const [headers = [], ...rows] = response.values ?? [];
  const normalized = headers.map((value) => text(value).toLocaleLowerCase('ru-RU'));
  const numberIndex = normalized.indexOf('№ заказа');
  const nameIndex = normalized.indexOf('название заказа');
  const clientIndex = normalized.indexOf('клиент');
  const totalIndex = normalized.indexOf('сумма заказа');
  const paidIndex = normalized.indexOf('оплачено');
  const debtIndex = normalized.indexOf('долг');
  const statusIndex = normalized.indexOf('статус');
  if (numberIndex < 0 || nameIndex < 0 || debtIndex < 0) {
    throw new Error('В листе «Заказы» не найдены номер, название или долг заказа');
  }
  if (statusIndex < 0) throw new Error('В листе «Заказы» не найден статус заказа');

  const orders = new Map();
  for (const row of rows) {
    const number = text(row[numberIndex]);
    const name = text(row[nameIndex]);
    if (!number || !name) continue;
    orders.set(number, {
      number,
      ...(options.includeRawNumber ? { rawNumber: row[numberIndex] } : {}),
      name,
      client: text(row[clientIndex]),
      status: text(row[statusIndex]),
      total: amount(row[totalIndex]),
      paid: amount(row[paidIndex]),
      debt: amount(row[debtIndex]),
    });
  }
  return {
    sheetName,
    orders: [...orders.values()].sort((a, b) => a.number.localeCompare(b.number, 'ru-RU', { numeric: true })),
  };
}
