import type { LiveReport } from './analytics-live';

type Day = LiveReport['daily'][number];
export const ratio = (a: number | null, b: number | null, scale = 1) =>
  a == null || b == null || b <= 0 ? null : (a / b) * scale;
export const difference = (a: number | null, b: number | null) =>
  a == null || b == null ? null : Math.round((a - b) * 100) / 100;
const totals = [
  'receipts',
  'spend',
  'contacts',
  'impressions',
  'views',
  'orders',
  'profit',
  'responseSecondsTotal',
  'responseAnswered',
  'responseWaiting',
] as const;
export function analyticsSeries(days: Day[], grouping: 'day' | 'week') {
  const groups = new Map<string, Day[]>();
  for (const day of days) {
    const monday = new Date(day.date + 'T00:00:00Z');
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const key =
      grouping === 'week' ? monday.toISOString().slice(0, 10) : day.date;
    groups.set(key, [...(groups.get(key) || []), day]);
  }
  return [...groups.values()].map((rows) => {
    // A missing day/metric must not turn into a zero or a misleading partial total.
    const d = Object.fromEntries(
      totals.map((key) => [
        key,
        rows.some((row) => row[key] == null)
          ? null
          : Math.round(rows.reduce((n, row) => n + row[key]!, 0) * 100) / 100,
      ]),
    ) as Omit<Day, 'date'>;
    const result = difference(d.profit, d.spend);
    return {
      ...d,
      date: rows[0].date,
      end: rows[rows.length - 1].date,
      result,
      cpc: ratio(d.spend, d.contacts),
      ctr: ratio(d.views, d.impressions, 100),
      conversion: ratio(d.contacts, d.views, 100),
      romi: ratio(result, d.spend, 100),
      roas: ratio(d.receipts, d.spend),
      firstResponseSeconds: ratio(d.responseSecondsTotal ?? null, d.responseAnswered ?? null),
    };
  });
}
