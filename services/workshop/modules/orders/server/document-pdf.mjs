import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';

const regularFont = fileURLToPath(new URL('./fonts/NotoSans-Regular.ttf', import.meta.url));
const boldFont = fileURLToPath(new URL('./fonts/NotoSans-Bold.ttf', import.meta.url));
const MARGIN = 36;
const FOOTER = 44;
const BLACK = '#18212b';
const MUTED = '#58616b';
const BORDER = '#a8b0b8';
const TEST_LABEL = 'ТЕСТОВЫЙ ОБРАЗЕЦ - НЕ ДЛЯ ОПЛАТЫ';

function content(value) {
  return String(value ?? '').replace(/\p{Cc}/gu, character => character === '\n' || character === '\r' ? character : ' ');
}

function required(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`PDF snapshot requires ${field}`);
}

function money(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TypeError('PDF snapshot requires a nonnegative ruble amount');
  return value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replaceAll('\u00a0', ' ');
}

function dateLabel(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(content(value));
  return match ? `${match[3]}.${match[2]}.${match[1]}` : content(value);
}

function partyLines(party) {
  const lines = [party.name];
  const tax = [`ИНН ${party.inn || '-'}`, party.kpp ? `КПП ${party.kpp}` : ''].filter(Boolean);
  lines.push(tax.join(', '));
  if (party.ogrn) lines.push(`${String(party.ogrn).length === 15 ? 'ОГРНИП' : 'ОГРН'} ${party.ogrn}`);
  if (party.address) lines.push(party.address);
  return lines.join('\n');
}

// The renderer consumes an issued snapshot: quantities, line amounts, total and
// amountDue are already confirmed by the caller. It never derives one from another.
export async function renderDocumentPdfWithLayout(snapshot) {
  if (!snapshot || snapshot.version !== 1 || !['invoice', 'upd'].includes(snapshot.type)) throw new TypeError('Unsupported PDF snapshot');
  if (snapshot.seller?.vat !== 'none') throw new TypeError('Only confirmed no-VAT documents are supported');
  required(snapshot.number, 'number');
  required(snapshot.date, 'date');
  required(snapshot.seller?.name, 'seller.name');
  required(snapshot.buyer?.name, 'buyer.name');
  required(snapshot.seller?.signer, 'seller.signer');
  required(snapshot.seller?.signerRole, 'seller.signerRole');
  if (!Array.isArray(snapshot.items) || !snapshot.items.length || snapshot.items.length > 2000) throw new TypeError('PDF snapshot requires 1 to 2000 items');
  money(snapshot.total);
  if (snapshot.type === 'invoice') {
    money(snapshot.amountDue);
    for (const field of ['bank', 'bik', 'account', 'correspondent']) required(snapshot.bank?.[field], `bank.${field}`);
  }
  for (const item of snapshot.items) {
    required(item.name, 'item.name');
    required(item.unit, 'item.unit');
    if (typeof item.quantity !== 'number' || !Number.isFinite(item.quantity) || item.quantity < 0) throw new TypeError('PDF snapshot requires a nonnegative item.quantity');
    money(item.price);
    money(item.amount);
  }

  const doc = new PDFDocument({
    size: 'A4', margin: MARGIN, bufferPages: true, autoFirstPage: false,
    info: { Title: `${snapshot.type === 'invoice' ? 'Счёт на оплату' : 'УПД'} № ${content(snapshot.number)}`, Creator: 'Мастерская' },
  });
  doc.registerFont('regular', regularFont).registerFont('bold', boldFont);
  const chunks = [];
  const result = new Promise((resolve, reject) => {
    doc.on('data', chunk => chunks.push(chunk));
    doc.once('end', () => resolve(Buffer.concat(chunks)));
    doc.once('error', reject);
  });
  const width = 595.28 - 2 * MARGIN;
  const layout = { version: 1, unit: 'pt', origin: 'top-left', pages: [], anchors: {} };
  let y = MARGIN;
  let pageCount = 0;
  const bottom = () => doc.page.height - FOOTER;

  function text(value, x, top, options = {}) {
    const { size = 9, bold = false, color = BLACK, ...rest } = options;
    doc.font(bold ? 'bold' : 'regular').fontSize(size).fillColor(color);
    doc.text(content(value), x, top, { lineBreak: false, ...rest });
  }

  function wrap(value, cellWidth, size = 9, bold = false) {
    doc.font(bold ? 'bold' : 'regular').fontSize(size);
    const lines = [];
    for (const paragraph of content(value).split(/\r?\n/)) {
      let line = '';
      for (let word of paragraph.trim().split(/\s+/).filter(Boolean)) {
        if (line && doc.widthOfString(`${line} ${word}`) <= cellWidth) {
          line += ` ${word}`;
          continue;
        }
        if (line) lines.push(line);
        while (doc.widthOfString(word) > cellWidth) {
          let low = 1;
          let high = word.length;
          while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            if (doc.widthOfString(word.slice(0, mid)) <= cellWidth) low = mid;
            else high = mid - 1;
          }
          lines.push(word.slice(0, low));
          word = word.slice(low);
        }
        line = word;
      }
      lines.push(line);
    }
    return lines.length ? lines : [''];
  }

  function addPage() {
    doc.addPage();
    pageCount += 1;
    layout.pages.push({ index: pageCount - 1, width: doc.page.width, height: doc.page.height });
    y = MARGIN;
    if (snapshot.test) {
      doc.rect(MARGIN, y, width, 24).fill('#fff1ed');
      text(TEST_LABEL, MARGIN + 8, y + 6, { size: 11, bold: true, color: '#9b2110' });
      y += 34;
    }
    if (pageCount > 1) {
      text(`${snapshot.type === 'invoice' ? 'Счёт на оплату' : 'УПД, статус 2'} № ${snapshot.number} от ${dateLabel(snapshot.date)}`, MARGIN, y, { size: 9, bold: true });
      y += 16;
      text('Продолжение', MARGIN, y, { size: 8, color: MUTED });
      y += 21;
    }
  }

  function ensure(height) {
    if (y + height > bottom()) addPage();
  }

  function flow(value, options = {}) {
    const { size = 9, bold = false, gap = 5, color = BLACK } = options;
    const lines = wrap(value, width, size, bold);
    const lineHeight = size * 1.42;
    for (const line of lines) {
      ensure(lineHeight);
      text(line, MARGIN, y, { size, bold, color });
      y += lineHeight;
    }
    y += gap;
  }

  function section(label, value) {
    ensure(40);
    flow(label, { size: 8, bold: true, color: MUTED, gap: 2 });
    flow(value, { size: 9, gap: 10 });
  }

  // Ordinary rows stay together. A description taller than a page is split into
  // continuation fragments; its quantity and money appear once, in the first.
  function table() {
    const columns = [25, width - 25 - 43 - 55 - 78 - 83, 43, 55, 78, 83];
    const labels = ['№', 'Наименование / описание', 'Ед.', 'Кол-во', 'Цена, руб.', 'Сумма, руб.'];
    const padding = 5;
    const size = 8.5;
    const lineHeight = 12;
    function row(cells, lineCount, header = false) {
      const height = lineCount * lineHeight + padding * 2;
      let x = MARGIN;
      for (let i = 0; i < columns.length; i += 1) {
        doc.lineWidth(0.5).strokeColor(BORDER);
        doc.rect(x, y, columns[i], height).fillAndStroke(header ? '#edf0f3' : '#ffffff', BORDER);
        for (let j = 0; j < cells[i].length; j += 1) {
          const align = i >= 3 ? 'right' : 'left';
          text(cells[i][j], x + padding, y + padding + j * lineHeight, { size, bold: header, width: columns[i] - padding * 2, align });
        }
        x += columns[i];
      }
      y += height;
    }
    function header() {
      row(labels.map((label, i) => wrap(label, columns[i] - padding * 2, size, true)), 2, true);
    }
    ensure(70);
    header();
    snapshot.items.forEach((item, index) => {
      let cells = [String(index + 1), [item.name, item.description].filter(Boolean).join('\n'), item.unit, String(item.quantity).replace('.', ','), money(item.price), money(item.amount)]
        .map((value, i) => wrap(value, columns[i] - padding * 2, size));
      const fullLines = Math.max(...cells.map(cell => cell.length));
      const freshPageCapacity = Math.floor((doc.page.height - FOOTER - MARGIN - (snapshot.test ? 34 : 0) - 37 - 34 - padding * 2) / lineHeight);
      if (fullLines <= freshPageCapacity && y + fullLines * lineHeight + padding * 2 > bottom()) {
        addPage();
        header();
      }
      while (cells.some(cell => cell.length)) {
        const available = Math.floor((bottom() - y - padding * 2) / lineHeight);
        if (available < 1) {
          addPage();
          header();
          continue;
        }
        const count = Math.min(available, Math.max(...cells.map(cell => cell.length)));
        row(cells.map(cell => cell.slice(0, count)), count);
        cells = cells.map(cell => cell.slice(count));
        if (cells.some(cell => cell.length)) {
          addPage();
          header();
        }
      }
    });
    y += 12;
  }

  function total(label, amount, emphasis = false) {
    const labelWidth = width - 145;
    const size = emphasis ? 13 : 10;
    const lines = wrap(label, labelWidth - 16, size, true);
    const amountLines = wrap(`${money(amount)} руб.`, 137, size, true);
    const height = Math.max(lines.length, amountLines.length) * size * 1.4 + 14;
    ensure(height + 3);
    if (emphasis) doc.rect(MARGIN, y, width, height).fill('#edf0f3');
    lines.forEach((line, index) => text(line, MARGIN + 8, y + 7 + index * size * 1.4, { size, bold: true }));
    amountLines.forEach((line, index) => text(line, MARGIN + labelWidth, y + 7 + index * size * 1.4, { size, bold: true, width: 137, align: 'right' }));
    y += height + 3;
  }

  function signature(party, title, signerRole = '', signer = '', reserveAfter = 0) {
    const seller = party === 'seller';
    const leftWidth = seller ? width - 150 : width;
    const titleLines = wrap(title, width, 9, true);
    const roleLines = wrap(signerRole || 'Должность: __________________________', leftWidth, 9);
    const nameLines = wrap(signer || 'Фамилия, инициалы: __________________________', leftWidth, 9);
    const lineHeight = 12.78;
    const signatureHeight = seller ? 48 : 22;
    const titleHeight = titleLines.length * lineHeight + 7;
    const roleHeight = roleLines.length * lineHeight + 7;
    const leftHeight = titleHeight + roleHeight + signatureHeight + 7 + nameLines.length * lineHeight + 30;
    const blockHeight = Math.max(leftHeight, seller ? titleHeight + 124 + 12 : 0);
    ensure(blockHeight + reserveAfter);
    const top = y;
    titleLines.forEach((line, index) => text(line, MARGIN, top + index * lineHeight, { bold: true }));
    roleLines.forEach((line, index) => text(line, MARGIN, top + titleHeight + index * lineHeight));
    const signatureTop = top + titleHeight + roleHeight;
    const signatureX = MARGIN + doc.font('regular').fontSize(9).widthOfString('Подпись: ');
    text('Подпись:', MARGIN, signatureTop + signatureHeight - 16);
    doc.moveTo(signatureX, signatureTop + signatureHeight - 2).lineTo(signatureX + 200, signatureTop + signatureHeight - 2).lineWidth(0.5).strokeColor(BORDER).stroke();
    nameLines.forEach((line, index) => text(line, MARGIN, signatureTop + signatureHeight + 7 + index * lineHeight));
    text('Дата: «____» ________________ 20____ г.', MARGIN, signatureTop + signatureHeight + 7 + nameLines.length * lineHeight + 8, { size: 8, color: MUTED });
    if (seller) {
      layout.anchors.sellerSignature = { page: pageCount - 1, x: signatureX, y: signatureTop, width: 200, height: 48 };
      layout.anchors.sellerStamp = { page: pageCount - 1, x: MARGIN + width - 124, y: top + titleHeight, width: 124, height: 124 };
      text('М.П.', MARGIN + width - 124, top + titleHeight + 127, { size: 7, color: MUTED });
    }
    y = top + blockHeight;
  }

  try {
    addPage();
    flow(snapshot.type === 'invoice' ? 'Счёт на оплату' : 'Универсальный передаточный документ', { size: snapshot.type === 'invoice' ? 21 : 18, bold: true, gap: 4 });
    flow(`№ ${snapshot.number} от ${dateLabel(snapshot.date)}`, { size: 13, bold: true, gap: 13 });
    if (snapshot.type === 'upd') flow('Статус: 2 - передаточный документ (акт). Без налога (НДС).', { bold: true, gap: 12 });
    if (snapshot.type === 'invoice') {
      section('ПОЛУЧАТЕЛЬ ПЛАТЕЖА', partyLines(snapshot.seller));
      section('БАНКОВСКИЕ РЕКВИЗИТЫ', `${snapshot.bank.bank}\nБИК ${snapshot.bank.bik}    Корр. счёт ${snapshot.bank.correspondent}\nРасчётный счёт ${snapshot.bank.account}`);
    } else {
      section('ПРОДАВЕЦ / ИСПОЛНИТЕЛЬ', partyLines(snapshot.seller));
    }
    section('ПОКУПАТЕЛЬ / ЗАКАЗЧИК', partyLines(snapshot.buyer));
    const orderBasis = `Заказ № ${snapshot.orderId}${snapshot.orderDate ? ` от ${dateLabel(snapshot.orderDate)}` : ''}`;
    const legacyBasis = `Заказ № ${snapshot.orderId}${snapshot.orderDate ? ` от ${String(snapshot.orderDate).slice(0, 10)}` : ''}`;
    const basis = content(snapshot.basis).trim();
    section('ОСНОВАНИЕ', basis && basis !== orderBasis && basis !== legacyBasis ? `${basis}\n${orderBasis}` : orderBasis);
    flow('Валюта: российский рубль (643).', { size: 8, color: MUTED, gap: 7 });
    table();
    total(snapshot.type === 'invoice' ? 'Полная стоимость позиций' : 'Всего передано / выполнено', snapshot.total, snapshot.type === 'upd');
    flow('Без налога (НДС). НДС не предъявляется.', { size: 9, gap: 9 });
    if (snapshot.type === 'invoice') {
      total('К оплате по этому счёту', snapshot.amountDue, true);
      if (snapshot.amountDue < snapshot.total) flow('Частичная оплата. Позиции выше приведены по полной стоимости; сумма этого счёта указана в строке «К оплате».', { size: 9, gap: 9 });
      flow(`Назначение платежа: оплата по счёту № ${snapshot.number} от ${dateLabel(snapshot.date)}, заказ № ${snapshot.orderId}. Без НДС.`, { gap: 17 });
      signature('seller', 'Выставил счёт:', snapshot.seller.signerRole, snapshot.seller.signer);
    } else {
      flow('Содержание операции: передача товаров / сдача результатов выполненных работ, оказанных услуг по указанным позициям.', { gap: 13 });
      signature('seller', 'Передал / сдал. Ответственный за оформление со стороны продавца:', snapshot.seller.signerRole, snapshot.seller.signer);
      signature('buyer', 'Принял. Ответственный за оформление со стороны покупателя:', snapshot.buyer.signerRole, snapshot.buyer.signer, 8 * 1.42 * 2 + 7);
      flow('Замечания при приёмке: _________________________________________________________', { size: 8, gap: 7 });
      flow('Бумажная форма первичного учётного документа. Для подписания сторонами.', { size: 8, color: MUTED });
    }

    const range = doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) {
      doc.switchToPage(index);
      // The footer intentionally occupies the reserved bottom margin. Prevent
      // PDFKit from treating that text as body overflow and adding a blank page.
      const savedBottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.moveTo(MARGIN, doc.page.height - 31).lineTo(MARGIN + width, doc.page.height - 31).lineWidth(0.5).strokeColor(BORDER).stroke();
      text(snapshot.test ? TEST_LABEL : `${snapshot.type === 'invoice' ? 'Счёт' : 'УПД, статус 2'} № ${snapshot.number}`, MARGIN, doc.page.height - 23, { size: 7, color: snapshot.test ? '#9b2110' : MUTED, width: width - 100 });
      text(`Страница ${index + 1} из ${range.count}`, MARGIN + width - 95, doc.page.height - 23, { size: 7, color: MUTED, width: 95, align: 'right' });
      doc.page.margins.bottom = savedBottomMargin;
    }
    doc.end();
  } catch (error) {
    doc.destroy(error);
  }
  return { bytes: await result, layout };
}

export async function renderDocumentPdf(snapshot) {
  return (await renderDocumentPdfWithLayout(snapshot)).bytes;
}
