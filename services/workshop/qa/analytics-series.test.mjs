import test from 'node:test';
import assert from 'node:assert/strict';
import { analyticsSeries } from '../lib/analytics-series.ts';

const day = (date, overrides = {}) => ({
  date,
  receipts: 100,
  spend: 20,
  contacts: 2,
  impressions: 100,
  views: 10,
  orders: 1,
  profit: 50,
  ...overrides,
});

test('response weeks divide total seconds by answered dialogs, preserve zero and unknown', () => {
  const rows = analyticsSeries([
    day('2026-09-07',{responseSecondsTotal:60,responseAnswered:1,responseWaiting:0}),
    day('2026-09-08',{responseSecondsTotal:900,responseAnswered:9,responseWaiting:5}),
    day('2026-09-09',{responseSecondsTotal:0,responseAnswered:0,responseWaiting:2}),
  ],'week');
  assert.equal(rows[0].firstResponseSeconds,96);
  assert.equal(rows[0].responseWaiting,7);
  assert.equal(analyticsSeries([day('2026-09-07')],'day')[0].firstResponseSeconds,null);
  assert.equal(analyticsSeries([day('2026-09-07',{responseSecondsTotal:0,responseAnswered:1})],'day')[0].firstResponseSeconds,0);
  assert.equal(analyticsSeries([day('2026-09-07',{responseSecondsTotal:0,responseAnswered:0})],'day')[0].firstResponseSeconds,null);
});
test('weekly metrics use Monday boundaries and ratios of totals, never mean daily ratios', () => {
  const series = analyticsSeries(
    [
      day('2026-09-06'),
      day('2026-09-07'),
      day('2026-09-08', {
        spend: 80,
        contacts: 8,
        views: 20,
        impressions: 400,
      }),
    ],
    'week',
  );
  assert.equal(series.length, 2);
  assert.equal(series[1].date, '2026-09-07');
  assert.equal(series[1].end, '2026-09-08');
  assert.equal(series[1].spend, 100);
  assert.equal(series[1].cpc, 10);
  assert.equal(series[1].ctr, 6);
  assert.equal(series[1].roas, 2);
  assert.equal(series[1].result, 0);
});
test('missing data and zero denominators stay unknown, including partial weeks', () => {
  const rows = analyticsSeries(
    [
      day('2026-09-07'),
      day('2026-09-08', { spend: null, profit: null, impressions: null }),
    ],
    'week',
  );
  assert.equal(rows[0].spend, null);
  assert.equal(rows[0].result, null);
  assert.equal(rows[0].ctr, null);
  assert.equal(rows[0].receipts, 200);
  const zero = analyticsSeries(
    [day('2026-09-07', { spend: 0, contacts: 0, impressions: 0, views: 0 })],
    'day',
  )[0];
  assert.equal(zero.cpc, null);
  assert.equal(zero.romi, null);
  assert.equal(zero.ctr, null);
  assert.equal(zero.conversion, null);
});
