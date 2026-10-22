export const RATES = Object.freeze({
  regularLetter: 100,
  outsideLetter: 150,
  regularMinCm: 15,
  regularMaxCm: 50,
  supportMin: 2000,
  supportMax: 6000,
  filmPerLinearM: 1500,
  filmRollWidthM: 1,
  cassettePerLinearM: 7000,
});

export function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const normalized = String(value ?? '').trim().replace(',', '.');
  return /^\d+(?:\.\d+)?$/.test(normalized) ? Number(normalized) : NaN;
}

const graphemeSegmenter = new Intl.Segmenter('ru', {granularity: 'grapheme'});

export function countLetters(text) {
  const normalized = String(text ?? '').normalize('NFC');
  let count = 0;
  for (const {segment} of graphemeSegmenter.segment(normalized)) {
    if (!/^[\s\p{C}\p{Z}\p{M}]*$/u.test(segment)) count++;
  }
  return count;
}

export function letterRate(heightCm) {
  if (!Number.isFinite(heightCm) || heightCm <= 0) throw new RangeError('Высота буквы должна быть больше нуля.');
  return heightCm >= RATES.regularMinCm && heightCm <= RATES.regularMaxCm
    ? RATES.regularLetter : RATES.outsideLetter;
}

const cents = amount => Math.round((amount + Number.EPSILON) * 100);

export function calculate(input) {
  const issues = [];
  const rows = (input.letters ?? []).map((row, index) => {
    const text = row.text === undefined ? undefined : String(row.text ?? '');
    const count = text === undefined ? parseNumber(row.count) : countLetters(text);
    const heightCm = parseNumber(row.heightCm);
    if (!Number.isSafeInteger(count) || count < 1) issues.push(text === undefined
      ? {field: `count-${index}`, message: 'Укажите целое количество букв от 1.'}
      : {field: `text-${index}`, message: 'Введите хотя бы один символ без пробелов.'});
    if (!Number.isFinite(heightCm) || heightCm <= 0) issues.push({field: `height-${index}`, message: 'Укажите высоту буквы больше 0 см.'});
    return {count, heightCm, ...(text === undefined ? {} : {text})};
  });
  if (!rows.length) issues.push({field: 'letters', message: 'Добавьте хотя бы одну группу букв.'});
  const widthCm = parseNumber(input.widthCm);
  const heightCm = parseNumber(input.heightCm);
  if (!Number.isFinite(widthCm) || widthCm <= 0) issues.push({field: 'width', message: 'Укажите ширину вывески больше 0 см.'});
  if (!Number.isFinite(heightCm) || heightCm <= 0) issues.push({field: 'height', message: 'Укажите высоту вывески больше 0 см.'});
  const largestLetter = Math.max(...rows.map(row => row.heightCm));
  if (Number.isFinite(heightCm) && heightCm > 0 && Number.isFinite(largestLetter) && heightCm < largestLetter) {
    issues.push({field: 'height', message: 'Высота вывески по крайним точкам должна вмещать самую высокую букву.'});
  }
  if (issues.length) return {ok: false, issues};

  const letterRows = rows.map(row => ({...row, rate: letterRate(row.heightCm), costCents: cents(row.count * row.heightCm * letterRate(row.heightCm))}));
  const lettersCents = letterRows.reduce((sum, row) => sum + row.costCents, 0);
  const widthM = widthCm / 100;
  const heightM = heightCm / 100;
  const areaM2 = widthM * heightM;
  const filmLinearM = areaM2 / RATES.filmRollWidthM;
  const filmCents = input.film ? cents(filmLinearM * RATES.filmPerLinearM) : 0;
  const cassetteCents = input.cassette ? cents(widthM * RATES.cassettePerLinearM) : 0;
  const subtotalCents = lettersCents + filmCents + cassetteCents;
  const totalMinCents = subtotalCents + RATES.supportMin * 100;
  const totalMaxCents = subtotalCents + RATES.supportMax * 100;
  if (![...letterRows.map(row => row.costCents), filmCents, cassetteCents, totalMaxCents].every(Number.isSafeInteger)) {
    return {ok: false, issues: [{field: 'letters', message: 'Значения слишком велики для расчёта. Проверьте размеры и количество.'}]};
  }
  return {ok: true, issues: [], letterRows, letterCount: rows.reduce((sum, row) => sum + row.count, 0),
    widthCm, heightCm, widthM, heightM, areaM2, filmLinearM, film: Boolean(input.film), cassette: Boolean(input.cassette),
    lettersCents, filmCents, cassetteCents, subtotalCents, totalMinCents, totalMaxCents};
}
