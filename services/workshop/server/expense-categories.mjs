const SETTINGS_SHEET = 'Настройки';
const EXPENSE_CATEGORIES_RANGE = 'D2:D31';

function text(value) {
  return value == null ? '' : String(value);
}

export function parseExpenseCategories(values) {
  const categories = [];
  const seen = new Set();

  for (const row of values ?? []) {
    const category = text(row?.[0]);
    const key = category.trim().toLocaleLowerCase('ru-RU');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    categories.push(category);
  }

  if (!categories.length) {
    throw new Error('В листе «Настройки» не найдены категории расходов');
  }

  return categories;
}

export async function readExpenseCategories(client) {
  if (!client.configured) throw new Error('Google Таблица не настроена');
  const response = await client.getValues(
    SETTINGS_SHEET,
    EXPENSE_CATEGORIES_RANGE,
  );
  return { categories: parseExpenseCategories(response.values) };
}
