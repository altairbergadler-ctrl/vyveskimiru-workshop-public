import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate, countLetters } from '../dist/calculator.mjs';

const dimensions = { widthCm: 240, heightCm: 40, film: true, cassette: false };

for (const [label, text, expected] of [
  ['Cyrillic word', 'ВЫВЕСКА', 7],
  ['Cyrillic with ё', 'ЁЖ', 2],
  ['АПТЕКА 24', 'АПТЕКА 24', 8],
  ['spaces, tabs, line breaks and NBSP', '  АП\tТЕ\nКА\r\n\u00a0 24  ', 8],
  ['digits and printable signs', '24/7 + №1!', 8],
  ['punctuation in a sign', 'А-Б.&', 5],
  ['empty text', '', 0],
  ['whitespace only', ' \t\r\n\u00a0 ', 0],
  ['null text', null, 0],
  ['undefined text', undefined, 0],
  ['precomposed й', 'й', 1],
  ['combining й', 'и\u0306', 1],
  ['standalone combining mark', '\u0306', 0],
  ['family emoji grapheme', '👨‍👩‍👧‍👦', 1],
  ['emoji with skin tone', '👍🏽', 1],
  ['flag grapheme', '🇷🇺', 1],
  ['emoji variation selector', '🛠️', 1],
  ['zero-width space between letters', 'А\u200BБ', 2],
  ['zero-width space only', '\u200B', 0],
]) {
  test(`countLetters: ${label}`, () => {
    assert.equal(countLetters(text), expected);
  });
}

test('АПТЕКА 24 at 30 cm gives eight characters and 27,440–31,440 rubles', () => {
  const result = calculate({
    ...dimensions,
    letters: [{ text: 'АПТЕКА 24', heightCm: 30 }],
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(result.issues, []);
  assert.equal(result.letterCount, 8);
  assert.equal(result.letterRows[0].count, 8);
  assert.equal(result.lettersCents, 2_400_000);
  assert.equal(result.filmCents, 144_000);
  assert.equal(result.cassetteCents, 0);
  assert.equal(result.totalMinCents, 2_744_000);
  assert.equal(result.totalMaxCents, 3_144_000);
});

for (const count of [-1, 0, 999, 'not a number', Infinity]) {
  test(`text overrides the supplied count ${String(count)}`, () => {
    const result = calculate({
      ...dimensions,
      letters: [{ text: 'АПТЕКА 24', count, heightCm: 30 }],
    });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal(result.letterCount, 8);
    assert.equal(result.lettersCents, 2_400_000);
    assert.equal(result.totalMinCents, 2_744_000);
    assert.equal(result.totalMaxCents, 3_144_000);
  });
}

test('separate text groups retain their heights and tariffs', () => {
  const result = calculate({
    widthCm: 300,
    heightCm: 60,
    film: true,
    cassette: true,
    letters: [
      { text: 'МИР', count: -10, heightCm: 20 },
      { text: '24', count: 999, heightCm: 60 },
    ],
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.letterCount, 5);
  assert.deepEqual(result.letterRows.map(row => ({
    text: row.text,
    count: row.count,
    rate: row.rate,
    costCents: row.costCents,
  })), [
    { text: 'МИР', count: 3, rate: 100, costCents: 600_000 },
    { text: '24', count: 2, rate: 150, costCents: 1_800_000 },
  ]);
  assert.equal(result.lettersCents, 2_400_000);
  assert.equal(result.filmCents, 270_000);
  assert.equal(result.cassetteCents, 2_100_000);
  assert.equal(result.totalMinCents, 4_970_000);
  assert.equal(result.totalMaxCents, 5_370_000);
});

test('text and legacy numeric groups can coexist', () => {
  const result = calculate({
    widthCm: 300,
    heightCm: 60,
    film: false,
    cassette: false,
    letters: [{ text: 'АБ', heightCm: 20 }, { count: 3, heightCm: 60 }],
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.letterCount, 5);
  assert.equal(result.lettersCents, 3_100_000);
  assert.equal(result.totalMinCents, 3_300_000);
  assert.equal(result.totalMaxCents, 3_700_000);
});

for (const text of ['', ' \t\n\u00A0', '\u200B', null]) {
  test(`empty or invisible text ${JSON.stringify(text)} cannot fall back to a numeric count`, () => {
    const result = calculate({
      ...dimensions,
      letters: [{ text, count: 8, heightCm: 30 }],
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(issue => issue.field === 'text-0'));
    assert.equal('totalMinCents' in result, false);
    assert.equal('totalMaxCents' in result, false);
  });
}

test('combining letters and emoji each receive a single character charge', () => {
  const result = calculate({
    ...dimensions,
    film: false,
    letters: [{ text: 'и\u0306 👨‍👩‍👧‍👦', heightCm: 30 }],
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.letterCount, 2);
  assert.equal(result.lettersCents, 600_000);
  assert.equal(result.totalMinCents, 800_000);
  assert.equal(result.totalMaxCents, 1_200_000);
});
