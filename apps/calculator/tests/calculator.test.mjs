import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate, letterRate, parseNumber } from '../dist/calculator.mjs';

const example = {
  letters: [{ count: 8, heightCm: 30 }],
  widthCm: 240,
  heightCm: 40,
  film: true,
  cassette: false,
};

function expectCosts(input, expected) {
  const result = calculate(input);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(result.issues, []);
  for (const [field, amount] of Object.entries(expected)) {
    assert.equal(result[field], amount, field);
  }
  return result;
}

function expectIssue(input, field) {
  const result = calculate(input);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.field === field), JSON.stringify(result.issues));
  assert.equal('totalMinCents' in result, false);
  assert.equal('totalMaxCents' in result, false);
}

test('8 letters at 30 cm, 240 × 40 cm, film: 27,440–31,440 rubles', () => {
  const result = expectCosts(example, {
    letterCount: 8,
    lettersCents: 2_400_000,
    filmCents: 144_000,
    cassetteCents: 0,
    subtotalCents: 2_544_000,
    totalMinCents: 2_744_000,
    totalMaxCents: 3_144_000,
  });
  assert.ok(Math.abs(result.areaM2 - 0.96) < 1e-12);
  assert.ok(Math.abs(result.filmLinearM - 0.96) < 1e-12);
});

test('adding a 240 cm cassette gives 44,240–48,240 rubles', () => {
  expectCosts({ ...example, cassette: true }, {
    lettersCents: 2_400_000,
    filmCents: 144_000,
    cassetteCents: 1_680_000,
    subtotalCents: 4_224_000,
    totalMinCents: 4_424_000,
    totalMaxCents: 4_824_000,
  });
});

test('5 letters at 20 cm, 200 × 50 cm, both extras: 27,500–31,500 rubles', () => {
  const result = expectCosts({
    letters: [{ count: 5, heightCm: 20 }],
    widthCm: 200,
    heightCm: 50,
    film: true,
    cassette: true,
  }, {
    lettersCents: 1_000_000,
    filmCents: 150_000,
    cassetteCents: 1_400_000,
    subtotalCents: 2_550_000,
    totalMinCents: 2_750_000,
    totalMaxCents: 3_150_000,
  });
  assert.equal(result.filmLinearM, 1);
});

test('mixed groups use their own heights and tariffs: 49,700–53,700 rubles', () => {
  const result = expectCosts({
    letters: [{ count: 3, heightCm: 20 }, { count: 2, heightCm: 60 }],
    widthCm: 300,
    heightCm: 60,
    film: true,
    cassette: true,
  }, {
    letterCount: 5,
    lettersCents: 2_400_000,
    filmCents: 270_000,
    cassetteCents: 2_100_000,
    subtotalCents: 4_770_000,
    totalMinCents: 4_970_000,
    totalMaxCents: 5_370_000,
  });
  assert.deepEqual(result.letterRows.map(row => ({ rate: row.rate, costCents: row.costCents })), [
    { rate: 100, costCents: 600_000 },
    { rate: 150, costCents: 1_800_000 },
  ]);
  assert.ok(Math.abs(result.filmLinearM - 1.8) < 1e-12);
});

for (const expected of [
  { heightCm: 14.99, rate: 150, lettersCents: 899_400, totalMinCents: 1_099_400, totalMaxCents: 1_499_400 },
  { heightCm: 15, rate: 100, lettersCents: 600_000, totalMinCents: 800_000, totalMaxCents: 1_200_000 },
  { heightCm: 50, rate: 100, lettersCents: 2_000_000, totalMinCents: 2_200_000, totalMaxCents: 2_600_000 },
  { heightCm: 50.01, rate: 150, lettersCents: 3_000_600, totalMinCents: 3_200_600, totalMaxCents: 3_600_600 },
]) {
  test(`4 letters at the tariff boundary ${expected.heightCm} cm`, () => {
    assert.equal(letterRate(expected.heightCm), expected.rate);
    expectCosts({
      letters: [{ count: 4, heightCm: expected.heightCm }],
      widthCm: 240,
      heightCm: 60,
      film: false,
      cassette: false,
    }, {
      lettersCents: expected.lettersCents,
      filmCents: 0,
      cassetteCents: 0,
      totalMinCents: expected.totalMinCents,
      totalMaxCents: expected.totalMaxCents,
    });
  });
}

test('both optional components can be disabled: 26,000–30,000 rubles', () => {
  expectCosts({ ...example, film: false, cassette: false }, {
    lettersCents: 2_400_000,
    filmCents: 0,
    cassetteCents: 0,
    totalMinCents: 2_600_000,
    totalMaxCents: 3_000_000,
  });
});

test('cassette without film: 42,800–46,800 rubles', () => {
  expectCosts({ ...example, film: false, cassette: true }, {
    filmCents: 0,
    cassetteCents: 1_680_000,
    subtotalCents: 4_080_000,
    totalMinCents: 4_280_000,
    totalMaxCents: 4_680_000,
  });
});

test('cassette depends on horizontal width; a taller sign changes only film', () => {
  const result = expectCosts({ ...example, heightCm: 80, cassette: true }, {
    lettersCents: 2_400_000,
    filmCents: 288_000,
    cassetteCents: 1_680_000,
    totalMinCents: 4_568_000,
    totalMaxCents: 4_968_000,
  });
  assert.ok(Math.abs(result.filmLinearM - 1.92) < 1e-12);
});

test('fractional comma inputs preserve dimensions and do not round film up to whole metres', () => {
  assert.equal(parseNumber(' 12,75 '), 12.75);
  const result = expectCosts({
    letters: [{ count: ' 2 ', heightCm: '15,5' }],
    widthCm: '125,5',
    heightCm: ' 25,5 ',
    film: true,
    cassette: true,
  }, {
    widthCm: 125.5,
    heightCm: 25.5,
    lettersCents: 310_000,
    filmCents: 48_004,
    cassetteCents: 878_500,
    subtotalCents: 1_236_504,
    totalMinCents: 1_436_504,
    totalMaxCents: 1_836_504,
  });
  assert.ok(Math.abs(result.filmLinearM - 0.320025) < 1e-12);
});

for (const count of [0, -1, 1.5, '', 'letters', '2abc', Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid letter count ${JSON.stringify(count)} produces no total`, () => {
    expectIssue({ ...example, letters: [{ count, heightCm: 30 }] }, 'count-0');
  });
}

for (const heightCm of [0, -1, '', '30cm', NaN, Infinity]) {
  test(`invalid letter height ${String(heightCm)} produces no total`, () => {
    expectIssue({ ...example, letters: [{ count: 8, heightCm }] }, 'height-0');
  });
}

for (const [dimension, field, value] of [
  ['widthCm', 'width', 0],
  ['widthCm', 'width', -10],
  ['widthCm', 'width', ''],
  ['widthCm', 'width', '240 cm'],
  ['widthCm', 'width', Infinity],
  ['heightCm', 'height', 0],
  ['heightCm', 'height', -10],
  ['heightCm', 'height', ''],
  ['heightCm', 'height', 'forty'],
  ['heightCm', 'height', NaN],
]) {
  test(`invalid ${dimension} ${String(value)} produces no total`, () => {
    expectIssue({ ...example, [dimension]: value }, field);
  });
}

test('an empty letter list cannot produce a quote', () => {
  expectIssue({ ...example, letters: [] }, 'letters');
});

test('a 59.99 cm sign cannot contain a 60 cm letter from a later group', () => {
  expectIssue({
    ...example,
    letters: [{ count: 3, heightCm: 20 }, { count: 2, heightCm: 60 }],
    heightCm: 59.99,
  }, 'height');
});

test('overflowing component costs cannot produce a quote', () => {
  expectIssue({ ...example, widthCm: 1e308 }, 'letters');
});

test('the standalone rate helper rejects nonpositive and nonfinite heights', () => {
  for (const height of [0, -1, NaN, Infinity]) {
    assert.throws(() => letterRate(height), RangeError);
  }
});
