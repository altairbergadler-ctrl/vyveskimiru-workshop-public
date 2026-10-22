import {calculate, countLetters, letterRate, parseNumber, RATES} from './calculator.mjs?v=standalone-v1';

const $ = selector => document.querySelector(selector);
const numberFormat = new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 6});
const moneyFormat = new Intl.NumberFormat('ru-RU', {style: 'currency', currency: 'RUB', minimumFractionDigits: 0, maximumFractionDigits: 2});
const number = value => numberFormat.format(value);
const money = value => moneyFormat.format(value / 100);
const form = $('#calculator');
const rowContainer = $('#letter-rows');
let currentResult;

function appendGroup(text = '', height = '30') {
  const fragment = $('#letter-template').content.cloneNode(true);
  fragment.querySelector('.letter-text').value = text;
  fragment.querySelector('.letter-count').value = countLetters(text);
  fragment.querySelector('.letter-height').value = height;
  rowContainer.append(fragment);
  updateGroupLabels();
}

function updateGroupLabels() {
  const rows = [...rowContainer.children];
  rows.forEach((row, index) => {
    row.querySelector('h3').textContent = `Группа ${index + 1}`;
    row.querySelector('.remove-group').hidden = rows.length === 1;
    row.querySelector('.letter-count').id = `count-${index}`;
    row.querySelector('.letter-height').id = `height-${index}`;
    row.querySelector('.letter-text').id = `text-${index}`;
    row.querySelector('.text-label').textContent = index === 0 ? 'Текст вывески' : 'Текст этой группы';
    row.querySelector('.group-error').id = `error-${index}`;
    for (const input of row.querySelectorAll('input, textarea')) input.setAttribute('aria-describedby', `error-${index}`);
  });
}

function readInput() {
  return {letters: [...rowContainer.children].map(row => ({text: row.querySelector('.letter-text').value, heightCm: row.querySelector('.letter-height').value})),
    widthCm: $('#width').value, heightCm: $('#height').value, film: $('#film').checked, cassette: $('#cassette').checked};
}

function costRow(title, formula, cost) {
  const row = document.createElement('div');
  row.className = 'cost-row';
  const label = document.createElement('div');
  const heading = document.createElement('h3');
  heading.textContent = title;
  const detail = document.createElement('p');
  detail.textContent = formula;
  const price = document.createElement('strong');
  price.textContent = cost;
  label.append(heading, detail);
  row.append(label, price);
  return row;
}

function render() {
  const input = readInput();
  const result = calculate(input);
  currentResult = result;
  $('#copy-status').textContent = '';
  for (const field of form.querySelectorAll('input, textarea')) field.removeAttribute('aria-invalid');
  for (const error of form.querySelectorAll('.error')) {error.hidden = true; error.textContent = '';}
  [...rowContainer.children].forEach((row, index) => {
    const count = countLetters(input.letters[index].text);
    row.querySelector('.letter-count').value = count;
    const height = parseNumber(input.letters[index].heightCm);
    row.querySelector('.group-price').textContent = Number.isSafeInteger(count) && count > 0 && height > 0 && Number.isFinite(height)
      ? `${number(count)} × ${number(height)} см × ${letterRate(height)} ₽ = ${money(Math.round(count * height * letterRate(height) * 100))}` : '';
  });
  if (!result.ok) {
    for (const issue of result.issues) {
      document.getElementById(issue.field)?.setAttribute('aria-invalid', 'true');
      const match = issue.field.match(/^(text|count|height)-(\d+)$/);
      const target = match ? document.getElementById(`error-${match[2]}`) : $('#size-error');
      target.hidden = false;
      target.textContent += (target.textContent ? ' ' : '') + issue.message;
    }
    $('#total').classList.add('invalid-total');
    $('#total-min').textContent = 'Проверьте данные';
    $('#total-max').textContent = '';
    $('#result-note').textContent = 'Исправьте поля с подсказками, чтобы увидеть расчёт.';
    $('#breakdown').replaceChildren();
    $('#copy').disabled = true;
    $('#area-info').textContent = 'Площадь появится после ввода корректных размеров.';
    $('#diagram-width').textContent = '—';
    $('#diagram-height').textContent = '—';
    $('#diagram-caption').textContent = 'Размеры по крайним точкам';
    return;
  }
  $('#total').classList.remove('invalid-total');
  $('#total-min').textContent = money(result.totalMinCents);
  $('#total-max').textContent = money(result.totalMaxCents);
  $('#result-note').textContent = 'Разница зависит от блока питания и каркаса. Их точную стоимость уточним по вывеске.';
  $('#copy').disabled = false;
  const letterFormula = result.letterRows.map(row => `${number(row.count)} × ${number(row.heightCm)} см × ${row.rate} ₽`).join(' + ');
  $('#breakdown').replaceChildren(
    costRow('Объёмные буквы', letterFormula, money(result.lettersCents)),
    costRow('Блок питания и каркас', 'Зависит от размера вывески', `${money(RATES.supportMin * 100)}–${money(RATES.supportMax * 100)}`),
    costRow('Плёнка на лицо', result.film ? `${number(result.widthM)} × ${number(result.heightM)} м ÷ 1 м = ${number(result.filmLinearM)} пог. м × 1 500 ₽` : 'Не выбрана', result.film ? money(result.filmCents) : '—'),
    costRow('Композитная кассета', result.cassette ? `${number(result.widthM)} пог. м × 7 000 ₽` : 'Не выбрана', result.cassette ? money(result.cassetteCents) : '—'),
  );
  $('#area-info').textContent = `Площадь по габаритам: ${number(result.areaM2)} м²`;
  $('#diagram-width').textContent = `${number(result.widthCm)} см`;
  $('#diagram-height').textContent = `${number(result.heightCm)} см`;
  $('#diagram-caption').textContent = `${number(result.letterCount)} шт. · ${result.letterRows.length === 1 ? `высота ${number(result.letterRows[0].heightCm)} см` : 'разная высота'}`;
}

function estimateText(result) {
  const lines = ['ВывескиМиру · Предварительный расчёт объёмных букв', `Габариты: ${number(result.widthCm)} × ${number(result.heightCm)} см`, ''];
  result.letterRows.forEach(row => {
    lines.push(`Текст: ${row.text.trim()}`);
    lines.push(`Буквы: ${number(row.count)} × ${number(row.heightCm)} см × ${row.rate} ₽ = ${money(row.costCents)}`);
  });
  lines.push(`Всего буквы: ${money(result.lettersCents)}`, 'Блок питания и каркас: 2 000–6 000 ₽');
  lines.push(result.film ? `Плёнка: ${number(result.widthM)} × ${number(result.heightM)} м ÷ 1 м × 1 500 ₽ = ${money(result.filmCents)}` : 'Плёнка: не выбрана');
  lines.push(result.cassette ? `Композитная кассета: ${number(result.widthM)} пог. м × 7 000 ₽ = ${money(result.cassetteCents)}` : 'Композитная кассета: не выбрана');
  lines.push('', `Итого: от ${money(result.totalMinCents)} до ${money(result.totalMaxCents)}`, 'Плёнка рассчитана по габаритной площади, ширина рулона 1 м, без запаса на раскрой.', 'Монтаж и доставка здесь ещё не рассчитаны.');
  return lines.join('\n');
}

form.addEventListener('submit', event => event.preventDefault());
form.addEventListener('input', render);
form.addEventListener('change', render);
$('#add-group').addEventListener('click', () => {appendGroup(); render(); rowContainer.lastElementChild.querySelector('textarea').focus();});
rowContainer.addEventListener('click', event => {
  const button = event.target.closest('.remove-group');
  if (button && rowContainer.children.length > 1) {button.closest('.letter-group').remove(); updateGroupLabels(); render(); $('#add-group').focus();}
});
$('#copy').addEventListener('click', async () => {
  if (!currentResult.ok) return;
  const text = estimateText(currentResult);
  try {
    await navigator.clipboard.writeText(text);
    $('#copy-status').textContent = 'Расчёт скопирован.';
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('aria-label', 'Текст расчёта для копирования');
    textarea.className = 'copy-source';
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    $('#copy').focus();
    $('#copy-status').textContent = copied ? 'Расчёт скопирован.' : 'Браузер не разрешил копирование. Выделите расчёт на странице.';
  }
});
appendGroup('АПТЕКА24', '30');
render();

// Give this directory its own scope when the host has a root PWA worker.
// This worker does not cache or intercept requests.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(new URL('./sw.js?v=standalone-v1', import.meta.url), {scope: './'}).catch(() => {});
}
