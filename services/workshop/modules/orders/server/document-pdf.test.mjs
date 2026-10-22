import assert from 'node:assert/strict';
import test from 'node:test';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { renderDocumentPdf, renderDocumentPdfWithLayout } from './document-pdf.mjs';

function snapshot(patch = {}) {
  return {
    version: 1, type: 'invoice', number: 'ТЕСТ-001', date: '2026-10-21',
    orderId: 'ТЕСТ-9001', orderDate: '2026-10-20',
    seller: { id: 'fictional', name: 'ИП Образцов Тест Тестович', inn: '000000000000', address: 'Тестовый город, улица Примерная, дом 1', ogrn: '000000000000000', signer: 'Образцов Т. Т.', signerRole: 'Индивидуальный предприниматель', vat: 'none' },
    bank: { id: 'fictional-bank', bank: 'ВЫМЫШЛЕННЫЙ ТЕСТОВЫЙ БАНК', bik: '000000000', account: '00000000000000000000', correspondent: '00000000000000000001' },
    buyer: { name: 'ООО «Тестовый заказчик»', inn: '0000000000', kpp: '000000000', address: 'Тестовый город, улица Учебная, дом 2' },
    items: [
      { name: 'Изготовление тестовой вывески', description: 'Только вымышленный пример, цветные буквы ЁЖИК', unit: 'м²', quantity: 2.75, price: 1000, amount: 2750 },
      { name: 'Монтаж тестового образца', description: '', unit: 'усл.', quantity: 1, price: 750.25, amount: 750.25 },
    ],
    total: 3500.25, amountDue: 1750.13, basis: 'Тестовый договор № ОБРАЗЕЦ-7 от 20.10.2026', test: true,
    ...patch,
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

async function extract(value) {
  const task = getDocument({ data: new Uint8Array(value), useSystemFonts: false, isEvalSupported: false });
  const pdf = await task.promise;
  try {
    const pages = [];
    for (let index = 1; index <= pdf.numPages; index += 1) {
      const page = await pdf.getPage(index);
      const text = await page.getTextContent();
      pages.push({ width: page.view[2], height: page.view[3], items: text.items.filter(item => 'str' in item), text: text.items.map(item => item.str ?? '').join(' ') });
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

function assertGeometry(pages) {
  for (const [pageIndex, page] of pages.entries()) {
    assert.ok(Math.abs(page.width - 595.28) < 0.1, 'A4 width');
    assert.ok(Math.abs(page.height - 841.89) < 0.1, 'A4 height');
    assert.ok(page.items.some(item => item.str.includes('Страница')), `Page ${pageIndex + 1} has a footer`);
    for (const item of page.items.filter(item => item.str.trim())) {
      const [,,,, x, baseline] = item.transform;
      assert.ok(x >= 35 && x + item.width <= page.width - 34, `Text exceeds horizontal page bounds: ${item.str}`);
      assert.ok(baseline >= 12 && baseline <= page.height - 30, `Text exceeds vertical page bounds: ${item.str}`);
      assert.ok(!item.str.includes('\uFFFD'), 'No replacement glyphs');
    }
  }
}

test('invoice embeds readable Cyrillic, canonical quantity, no VAT and the independent partial payment', async () => {
  const source = deepFreeze(snapshot());
  const buffer = await renderDocumentPdf(source);
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
  const pages = await extract(buffer);
  const text = pages.map(page => page.text).join(' ');
  for (const expected of ['Счёт на оплату', '21.10.2026', 'Образцов Тест Тестович', 'Тестовый заказчик', 'ЁЖИК', 'м²', '2,75', '3 500,25', '1 750,13', 'Частичная оплата', 'Корр. счёт', 'Расчётный счёт', 'Без налога (НДС)', 'Образцов Т. Т.']) assert.ok(text.includes(expected), expected);
  assert.ok(!text.includes('22%'));
  assertGeometry(pages);
});

test('renderer preserves supplied amounts and quantities instead of allocating totals or recalculating rows', async () => {
  const pages = await extract(await renderDocumentPdf(snapshot({
    items: [{ name: 'Фиксированная историческая цена', unit: 'м', quantity: 3.125, price: 20, amount: 77.77 }],
    total: 88.88, amountDue: 44.44,
  })));
  const text = pages.map(page => page.text).join(' ');
  for (const expected of ['3,125', '20,00', '77,77', '88,88', '44,44']) assert.ok(text.includes(expected), expected);
  assert.ok(!text.includes('62,50'), 'Does not recalculate quantity x price');
  assertGeometry(pages);
});

test('UPD status 2 has source content, parties and signature/date spaces without an invoice payment demand', async () => {
  const pages = await extract(await renderDocumentPdf(snapshot({ type: 'upd' })));
  const text = pages.map(page => page.text).join(' ');
  for (const expected of ['Универсальный передаточный документ', 'Статус: 2', 'передаточный документ (акт)', 'ПРОДАВЕЦ / ИСПОЛНИТЕЛЬ', 'ПОКУПАТЕЛЬ / ЗАКАЗЧИК', 'ОСНОВАНИЕ', 'Всего передано / выполнено', '3 500,25', 'Передал / сдал', 'Принял.', 'Должность:', 'Подпись:', 'Фамилия, инициалы:', 'Дата:', 'Бумажная форма первичного учётного документа']) assert.ok(text.includes(expected), expected);
  assert.ok(!text.includes('К оплате по этому счёту'));
  assert.ok(!text.includes('1 750,13'));
  assertGeometry(pages);
});

test('a multi-page invoice repeats table headers, marks every test page and places the totals once after all items', async () => {
  const items = Array.from({ length: 75 }, (_, index) => ({ name: `Позиция-${String(index + 1).padStart(3, '0')}`, description: `Вымышленная строка для проверки переноса ${index + 1}`, unit: 'шт.', quantity: 1, price: 10.25, amount: 10.25 }));
  const pages = await extract(await renderDocumentPdf(snapshot({ items, total: 768.75, amountDue: 321.09 })));
  assert.ok(pages.length >= 3);
  assertGeometry(pages);
  for (const [index, page] of pages.entries()) {
    assert.ok(page.text.includes('ТЕСТОВЫЙ ОБРАЗЕЦ - НЕ ДЛЯ ОПЛАТЫ'), `Test label on page ${index + 1}`);
    assert.ok(page.text.includes(`Страница ${index + 1} из ${pages.length}`));
    if (page.text.includes('Позиция-')) assert.ok(page.text.includes('Наименование / описание'), 'Table header repeats');
  }
  const text = pages.map(page => page.text).join(' ');
  for (const item of items) assert.equal(text.split(item.name).length - 1, 1, item.name);
  assert.equal(text.split('768,75').length - 1, 1);
  assert.equal(text.split('321,09').length - 1, 1);
  assert.ok(text.indexOf('Позиция-075') < text.indexOf('Полная стоимость позиций'));
});

test('one description taller than a page is continued without losing text or duplicating its money', async () => {
  const description = Array.from({ length: 210 }, (_, index) => `Маркер${String(index).padStart(3, '0')} описание`).join(' ');
  const pages = await extract(await renderDocumentPdf(snapshot({ items: [{ name: 'Длинное описание', description, unit: 'усл.', quantity: 1, price: 123.45, amount: 567.89 }], total: 900, amountDue: 400 })));
  assert.ok(pages.length > 1);
  assertGeometry(pages);
  const text = pages.map(page => page.text).join(' ');
  for (let index = 0; index < 210; index += 1) assert.equal(text.split(`Маркер${String(index).padStart(3, '0')}`).length - 1, 1);
  assert.equal(text.split('567,89').length - 1, 1, 'Amount shown once for a continued row');
  assert.equal(text.split('123,45').length - 1, 1, 'Price shown once for a continued row');
});

test('long unbroken customer text wraps safely and zero values stay zero', async () => {
  const source = snapshot({
    buyer: { name: `ООО ${'Ж'.repeat(230)}`, inn: '0000000000', address: 'Тестовый адрес' },
    items: [{ name: 'Нулевая позиция', unit: 'шт.', quantity: 0, price: 0, amount: 0 }], total: 0, amountDue: 0,
  });
  const pages = await extract(await renderDocumentPdf(source));
  assertGeometry(pages);
  assert.ok(pages.map(page => page.text).join(' ').includes('0,00'));
});

test('ordinary fictional document has no test banner and full amount is not described as partial payment', async () => {
  const pages = await extract(await renderDocumentPdf(snapshot({ test: false, amountDue: 3500.25 })));
  const text = pages.map(page => page.text).join(' ');
  assert.ok(!text.includes('ТЕСТОВЫЙ ОБРАЗЕЦ'));
  assert.ok(!text.includes('Частичная оплата'));
  assertGeometry(pages);
});

test('unsupported VAT and malformed snapshots fail without producing misleading documents', async () => {
  const original = snapshot();
  await assert.rejects(renderDocumentPdf(snapshot({ seller: { ...original.seller, vat: '22' } })), /no-VAT/);
  await assert.rejects(renderDocumentPdf(snapshot({ type: 'unknown' })), /Unsupported/);
  await assert.rejects(renderDocumentPdf(snapshot({ items: [] })), /items/);
  await assert.rejects(renderDocumentPdf(snapshot({ total: null })), /amount/);
  await assert.rejects(renderDocumentPdf(snapshot({ amountDue: -1 })), /amount/);
  await assert.rejects(renderDocumentPdf(snapshot({ bank: { ...original.bank, bik: '' } })), /bank.bik/);
  await assert.rejects(renderDocumentPdf(snapshot({ items: [{ ...original.items[0], quantity: NaN }] })), /quantity/);
});

test('renderer returns exact seller-only page anchors after pagination and reserves non-overlapping stamp/signature boxes', async () => {
  for (const type of ['invoice', 'upd']) {
    const items = Array.from({ length: 65 }, (_, index) => ({ name: `Учебная позиция ${index}`, description: 'Синтетический многостраничный пример', unit: 'шт.', quantity: 1, price: 10, amount: 10 }));
    const { bytes, layout } = await renderDocumentPdfWithLayout(snapshot({ type, items, total: 650, amountDue: 650 }));
    const pages = await extract(bytes);
    assert.equal(layout.version, 1); assert.equal(layout.unit, 'pt'); assert.equal(layout.origin, 'top-left');
    assert.equal(layout.pages.length, pages.length);
    assert.deepEqual(Object.keys(layout.anchors).sort(), ['sellerSignature', 'sellerStamp']);
    const signature = layout.anchors.sellerSignature, stamp = layout.anchors.sellerStamp;
    assert.equal(signature.page, stamp.page);
    assert.ok(signature.page > 0);
    assert.ok(signature.x + signature.width < stamp.x);
    for (const anchor of [signature, stamp]) {
      assert.ok(anchor.x >= 36 && anchor.y >= 36);
      assert.ok(anchor.x + anchor.width <= layout.pages[anchor.page].width - 36);
      assert.ok(anchor.y + anchor.height < layout.pages[anchor.page].height - 44);
    }
    assert.ok(pages[signature.page].text.includes(type === 'invoice' ? 'Выставил счёт:' : 'Передал / сдал.'));
    assertGeometry(pages);
  }
});

test('default order basis is printed once with the localized date', async () => {
  const pages = await extract(await renderDocumentPdf(snapshot({ basis: 'Заказ № ТЕСТ-9001 от 2026-10-20' })));
  const text = pages.map(page => page.text).join(' ');
  assert.equal(text.split('Заказ № ТЕСТ-9001 от').length - 1, 1);
  assert.ok(text.includes('Заказ № ТЕСТ-9001 от 20.10.2026'));
  assert.ok(!text.includes('2026-10-20'));
});

test('a short UPD keeps both signature blocks and acceptance notes together on one page', async () => {
  const pages = await extract(await renderDocumentPdf(snapshot({ type: 'upd', basis: 'Заказ № ТЕСТ-9001 от 2026-10-20',
    seller: { ...snapshot().seller, ogrn: '', signerRole: 'Директор' },
    items: [{ name: 'Учебный образец', unit: 'шт.', quantity: 2, price: 500, amount: 1000 }], total: 1000 })));
  assert.equal(pages.length, 1);
  for (const text of ['Передал / сдал.', 'Принял.', 'Замечания при приёмке:', 'Для подписания сторонами.']) assert.ok(pages[0].text.includes(text));
  assertGeometry(pages);
});

test('UPD acceptance notes stay with the buyer signature when extra party details need another page', async () => {
  const pages = await extract(await renderDocumentPdf(snapshot({ type: 'upd' })));
  const buyerPage = pages.findIndex(page => page.text.includes('Принял.'));
  assert.ok(buyerPage >= 0);
  assert.ok(pages[buyerPage].text.includes('Замечания при приёмке:'));
  assert.ok(pages[buyerPage].text.includes('Для подписания сторонами.'));
  assertGeometry(pages);
});
