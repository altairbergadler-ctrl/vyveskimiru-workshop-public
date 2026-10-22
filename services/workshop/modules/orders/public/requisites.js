const Requisites = (function () {
  'use strict';

  const KEYS = ['name', 'inn', 'kpp', 'bik', 'account', 'correspondent', 'bank', 'address', 'ogrn', 'email'];
  const TITLES = { name: 'Наименование', inn: 'ИНН', kpp: 'КПП', bik: 'БИК', account: 'Расчётный счёт', correspondent: 'Корреспондентский счёт', bank: 'Банк', address: 'Адрес', ogrn: 'ОГРН / ОГРНИП', email: 'Email' };
  const SCALARS = new Set(['inn', 'kpp', 'bik', 'account', 'correspondent', 'ogrn']);
  const LABELS = [
    ['bankInn', 'инн\\s+банка'], ['bankKpp', 'кпп\\s+банка'],
    ['clientInn', 'инн\\s+(?:получателя|клиента|организации)'], ['clientKpp', 'кпп\\s+(?:получателя|клиента|организации)'],
    ['innKpp', 'инн\\s*[/\\\\]\\s*кпп'],
    ['bank', '(?:наименование|название)\\s+банка|банк(?:\\s+получателя)?'],
    ['correspondent', '(?:корреспондентский|корр\\.?)\\s+сч[её]т|к\\s*[/\\\\]\\s*с|к\\.\\s*с\\.?|кс'],
    ['account', 'расч[её]тный\\s+сч[её]т|р\\s*[/\\\\]\\s*с|р\\.\\s*с\\.?|рс|сч[её]т\\s+получателя'],
    ['address', 'юридический\\s+адрес|юр\\.?\\s*адрес|адрес\\s+местонахождения|адрес'],
    ['name', 'полное\\s+наименование(?:\\s+(?:организации|получателя))?|наименование(?:\\s+(?:организации|получателя))?|название(?:\\s+организации)?|получатель|организация|ф\\.?\\s*и\\.?\\s*о\\.?'],
    ['inn', 'инн'], ['kpp', 'кпп'], ['bik', 'бик'], ['ogrn', 'огрнип|огрн'], ['email', 'e-?mail|электронная\\s+почта|эл\\.?\\s*почта'],
  ];
  const LABEL_RE = new RegExp('(?<![\\p{L}\\p{N}])(?:' + LABELS.map(([, pattern], index) => '(?<l' + index + '>' + pattern + ')').join('|') + ')(?![\\p{L}\\p{N}])', 'giu');
  const clean = value => String(value ?? '').replace(/\u00a0|\u202f/g, ' ').trim();
  const normalize = (key, value) => {
    let result = clean(value).replace(/^[\s:;=№#]+|[\s;,|]+$/g, '').trim();
    if (SCALARS.has(key) && /^[\dA-Za-z\s-]+$/.test(result)) result = result.replace(/[\s-]/g, '');
    if (key === 'kpp') result = result.toUpperCase();
    return result;
  };
  const isOrganization = value => /^(?:ООО|ПАО|НАО|АО|ОАО|ЗАО|ИП)(?=\s|[«"“]|$)/iu.test(value);

  function validateInn(value) {
    const inn = clean(value);
    if (!/^\d{10}(?:\d{2})?$/.test(inn) || /^0+$/.test(inn)) return false;
    const check = weights => weights.reduce((sum, weight, index) => sum + Number(inn[index]) * weight, 0) % 11 % 10;
    if (inn.length === 10) return check([2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(inn[9]);
    return check([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(inn[10]) && check([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(inn[11]);
  }

  function validateFields(fields = {}) {
    const issues = [];
    const add = (field, message) => issues.push({ field, message });
    const inn = clean(fields.inn);
    if (inn && !validateInn(inn)) add('inn', /^\d{10}(?:\d{2})?$/.test(inn) ? 'Контрольные цифры ИНН не сходятся. Проверьте номер по исходнику.' : 'ИНН должен содержать 10 или 12 цифр.');
    const kpp = clean(fields.kpp);
    if (kpp && !/^\d{4}[0-9A-Z]{2}\d{3}$/i.test(kpp)) add('kpp', 'Проверьте КПП: 9 знаков, в 5-м и 6-м знаках допустимы латинские буквы.');
    const bik = clean(fields.bik);
    if (bik && (!/^\d{9}$/.test(bik) || /^0+$/.test(bik))) add('bik', 'БИК должен содержать 9 цифр.');
    for (const field of ['account', 'correspondent']) {
      const value = clean(fields[field]);
      if (value && (!/^\d{20}$/.test(value) || /^0+$/.test(value))) add(field, TITLES[field] + ' должен содержать 20 цифр.');
    }
    const ogrn = clean(fields.ogrn);
    if (ogrn) {
      if (!/^\d{13}(?:\d{2})?$/.test(ogrn) || /^0+$/.test(ogrn)) add('ogrn', 'ОГРН должен содержать 13 цифр, ОГРНИП — 15 цифр.');
      else if (Number(BigInt(ogrn.slice(0, -1)) % (ogrn.length === 13 ? 11n : 13n) % 10n) !== Number(ogrn.at(-1))) add('ogrn', 'Контрольная цифра ОГРН / ОГРНИП не сходится.');
    }
    const email = clean(fields.email);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) add('email', 'Проверьте адрес электронной почты.');
    const name = clean(fields.name);
    if (/^ИП(?=\s|[«"“]|$)/iu.test(name)) {
      if (inn.length === 10) add('inn', 'В наименовании указан ИП, а ИНН содержит 10 цифр. Проверьте тип клиента и номер.');
      if (kpp) add('kpp', 'В наименовании указан ИП. Проверьте, не перенесён ли КПП банка или другой организации.');
    } else if (/^(?:ООО|ПАО|НАО|АО|ОАО|ЗАО)(?=\s|[«"“]|$)/iu.test(name) && inn.length === 12) add('inn', 'В наименовании указана организация, а ИНН содержит 12 цифр. Проверьте тип клиента и номер.');
    return issues;
  }

  function parse(source) {
    const candidates = Object.fromEntries(KEYS.map(key => [key, []]));
    const fields = Object.fromEntries(KEYS.map(key => [key, '']));
    const issues = [];
    const unknownLines = [];
    const addIssue = (field, message) => { if (!issues.some(issue => issue.field === field && issue.message === message)) issues.push({ field, message }); };
    const preserve = line => { if (clean(line) && !unknownLines.includes(line)) unknownLines.push(line); };
    const add = (key, value) => {
      const normalized = normalize(key, value);
      if (!normalized) { addIssue(key, 'После метки «' + TITLES[key] + '» нет значения.'); return; }
      if (!candidates[key].includes(normalized)) candidates[key].push(normalized);
    };
    let bankScope = false;
    let ignoredBankInn = false;
    let pending = null;
    let addressContinuation = false;
    const lines = String(source ?? '').split(/\r\n?|\n/);

    for (const rawLine of lines) {
      const line = clean(rawLine);
      if (!line) { addressContinuation = false; continue; }
      const matches = Array.from(line.matchAll(LABEL_RE)).map(match => {
        const index = LABELS.findIndex((_, index) => match.groups['l' + index] !== undefined);
        return { key: LABELS[index][0], index: match.index, end: match.index + match[0].length, label: match[0] };
      }).filter(match => {
        if (SCALARS.has(match.key) || ['innKpp', 'bankInn', 'bankKpp', 'clientInn', 'clientKpp'].includes(match.key)) return true;
        return match.index === 0 || /[;|\t]\s*$/.test(line.slice(0, match.index)) || /^\s*[:=]/.test(line.slice(match.end));
      });

      if (pending) {
        if (!matches.length && (['name', 'bank', 'address', 'email'].includes(pending.key) || /^[\dA-Za-z\s/\\-]+$/.test(line))) {
          if (pending.bankTax) { preserve(rawLine); if (pending.key === 'inn') ignoredBankInn = true; }
          else add(pending.key, line);
          addressContinuation = pending.key === 'address';
          pending = null;
          continue;
        }
        addIssue(pending.key, 'После метки «' + TITLES[pending.key] + '» нет значения.');
        pending = null;
      }

      if (!matches.length) {
        if (isOrganization(line)) { add('name', line); bankScope = false; addressContinuation = false; }
        else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(line)) { add('email', line); addressContinuation = false; }
        else if (addressContinuation && /^(?:г\.|город|ул\.|улица|д\.|дом|корп\.|корпус|стр\.|строение|оф\.|офис|кв\.|квартира|обл\.|область|р-н|район|пос\.|проспект|пр-т|шоссе|пер\.|переулок)\s/iu.test(line) && candidates.address.length === 1) candidates.address[0] += ', ' + line;
        else { preserve(rawLine); addressContinuation = false; }
        continue;
      }

      addressContinuation = false;
      const prefix = line.slice(0, matches[0].index).replace(/[\s;|]+$/g, '');
      if (prefix) {
        if (isOrganization(prefix)) { add('name', prefix); bankScope = false; }
        else preserve(prefix);
      }
      for (let index = 0; index < matches.length; index++) {
        const match = matches[index];
        let value = line.slice(match.end, matches[index + 1]?.index ?? line.length).replace(/^[\s:;=№#]+|[\s;,|]+$/g, '').trim();
        if (matches[index + 1]) value = value.replace(/\s*[/\\]\s*$/g, '').trim();
        if (['bank', 'bik', 'correspondent'].includes(match.key)) bankScope = true;
        if (match.key === 'name') bankScope = false;
        if (match.key === 'clientInn' || match.key === 'clientKpp') { bankScope = false; match.key = match.key === 'clientInn' ? 'inn' : 'kpp'; }
        const bankTax = match.key === 'bankInn' || match.key === 'bankKpp' || (bankScope && ['inn', 'kpp', 'innKpp'].includes(match.key));
        if (bankTax) {
          if (match.key === 'bankInn' || match.key === 'inn' || match.key === 'innKpp') ignoredBankInn = true;
          preserve(rawLine);
          if (!value) pending = { key: match.key.toLowerCase().includes('kpp') ? 'kpp' : 'inn', bankTax: true };
          continue;
        }
        if (match.key === 'innKpp') {
          const pair = value.split(/[/\\]/);
          if (pair.length === 2) { add('inn', pair[0]); add('kpp', pair[1]); }
          else { preserve(rawLine); addIssue('inn', 'Не удалось разделить ИНН / КПП. Введите их отдельно.'); addIssue('kpp', 'Не удалось разделить ИНН / КПП. Введите их отдельно.'); }
          continue;
        }
        if (!value) pending = { key: match.key, bankTax: false };
        else { add(match.key, value); addressContinuation = match.key === 'address'; }
      }
    }
    if (pending && !pending.bankTax) addIssue(pending.key, 'После метки «' + TITLES[pending.key] + '» нет значения.');
    for (const key of KEYS) {
      if (candidates[key].length === 1) fields[key] = candidates[key][0];
      else if (candidates[key].length > 1) addIssue(key, 'Найдено несколько значений «' + TITLES[key] + '». Выберите нужное вручную.');
    }
    if (ignoredBankInn && !candidates.inn.length) addIssue('inn', 'Найден ИНН в реквизитах банка. ИНН клиента по нему не определяется.');
    for (const issue of validateFields(fields)) addIssue(issue.field, issue.message);
    return { fields, candidates, issues, unknownLines };
  }

  return Object.freeze({ parse, validateInn, validateFields });
})();

const LABELLED_HEADER = '--- Реквизиты для документов ---';
const SOURCE_HEADER = '\n\n--- Исходный текст клиента ---\n';
const UNRESOLVED_HEADER = 'Требует проверки:';
const CONFIRMED_HEADER = 'Подтверждено вручную:';
const FIELD_LABELS = { name: 'Наименование', inn: 'ИНН', kpp: 'КПП', bik: 'БИК', account: 'Р/с', correspondent: 'К/с', bank: 'Банк', address: 'Юридический адрес', ogrn: 'ОГРН', email: 'Email' };
const OPTIONAL_FIELDS = new Set(['kpp', 'bik', 'account', 'correspondent', 'bank', 'ogrn', 'email']);
export const validateInn = Requisites.validateInn;
export const validateFields = Requisites.validateFields;
export function isCanonicalRequisites(value) { return String(value ?? '').startsWith(LABELLED_HEADER + '\n'); }
export function requisitesSource(value) {
  const text = String(value ?? '');
  const split = text.startsWith(LABELLED_HEADER + '\n') ? text.indexOf(SOURCE_HEADER) : -1;
  return split < 0 ? text : text.slice(split + SOURCE_HEADER.length);
}
export function parseRequisites(value) {
  const text = String(value ?? '');
  if (!isCanonicalRequisites(text)) {
    const parsed = Requisites.parse(text);
    return { ...parsed, unresolvedFields: [...new Set(parsed.issues.map(issue => issue.field))], confirmedFields: [] };
  }
  const split = text.indexOf(SOURCE_HEADER);
  const lines = text.slice(LABELLED_HEADER.length + 1, split < 0 ? undefined : split).split('\n');
  const metadata = { unresolved: new Set(), confirmed: new Set() };
  let confirmedPresent = false, invalidMetadata = false;
  const body = lines.filter(line => {
    const kind = line.startsWith(UNRESOLVED_HEADER) ? 'unresolved' : line.startsWith(CONFIRMED_HEADER) ? 'confirmed' : null;
    if (!kind) return true;
    if (kind === 'confirmed') confirmedPresent = true;
    const prefix = kind === 'unresolved' ? UNRESOLVED_HEADER : CONFIRMED_HEADER;
    for (const key of line.slice(prefix.length).split(',').map(key => key.trim()).filter(Boolean)) {
      if (Object.hasOwn(FIELD_LABELS, key) || (kind === 'unresolved' && key === 'requisites')) metadata[kind].add(key); else invalidMetadata = true;
    }
    return false;
  }).join('\n');
  const parsed = Requisites.parse(body);
  for (const issue of parsed.issues) if (Object.hasOwn(FIELD_LABELS, issue.field)) metadata.unresolved.add(issue.field);
  if (split < 0 || invalidMetadata) { metadata.unresolved.add('requisites'); parsed.issues.push({ field: 'requisites', message: 'Сохранённый блок реквизитов неполон или содержит неизвестные отметки проверки. Разберите исходник заново.' }); }
  for (const field of metadata.unresolved) if (!parsed.issues.some(issue => issue.field === field)) parsed.issues.push({ field, message: 'Поле «' + (FIELD_LABELS[field] || 'Исходный текст') + '» требует явного выбора или ручного исправления по исходнику.' });
  return { ...parsed, unresolvedFields: [...metadata.unresolved], confirmedFields: confirmedPresent ? [...metadata.confirmed] : Object.keys(parsed.fields).filter(key => parsed.fields[key]) };
}
export function canonicalRequisites(fields, source, options = {}) {
  const lines = Object.entries(FIELD_LABELS).filter(([key]) => String(fields[key] ?? '').trim()).map(([key, label]) => label + ': ' + String(fields[key]).trim().replace(/\r?\n/g, ', '));
  const unresolved = options.unresolvedFields ?? parseRequisites(source).unresolvedFields.filter(key => !String(fields[key] ?? '').trim());
  const confirmed = options.confirmedFields ?? Object.keys(FIELD_LABELS).filter(key => String(fields[key] ?? '').trim());
  const keys = values => [...new Set(values)].filter(key => Object.hasOwn(FIELD_LABELS, key) || key === 'requisites').join(',');
  lines.push(UNRESOLVED_HEADER + ' ' + keys(unresolved), CONFIRMED_HEADER + ' ' + keys(confirmed));
  // Both parts stay in the existing Google cell. The marked source is never reparsed over a manual correction.
  return LABELLED_HEADER + '\n' + lines.join('\n') + SOURCE_HEADER + String(source ?? '');
}

export function enhanceRequisitesEditor({ controls, editorApi }) {
  const entry = controls.get('requisites');
  if (!entry) return null;
  const element = (tag, className, content) => { const node = document.createElement(tag); node.className = className || ''; if (content !== undefined) node.textContent = content; return node; };
  const host = element('section', 'requisites-editor');
  entry.input.hidden = true;
  const sourceLabel = element('label', 'requisites-label', 'Исходный текст клиента');
  const source = element('textarea', 'requisites-source');
  source.rows = 5;
  source.maxLength = 12000;
  source.id = entry.input.id + '-source';
  sourceLabel.htmlFor = source.id;
  const note = element('p', 'record-field-hint', 'Вставьте реквизиты целиком. Поля заполнятся автоматически; перед выставлением документа проверьте их. Исходник сохранится вместе с полями.');
  const grid = element('div', 'requisites-grid');
  const messages = element('div', 'requisites-issues');
  messages.setAttribute('aria-live', 'polite');
  const inputs = new Map();
  const touched = new Set();
  const unresolved = new Set();
  for (const [key, label] of Object.entries(FIELD_LABELS)) {
    const group = element('div', 'requisites-field');
    const caption = element('label', '', label);
    const input = element('input'); input.type = 'text'; input.id = source.id + '-' + key; caption.htmlFor = input.id;
    input.maxLength = key === 'address' || key === 'name' || key === 'bank' ? 800 : 320;
    input.addEventListener('input', () => { touched.add(key); if (input.value.trim() || OPTIONAL_FIELDS.has(key)) unresolved.delete(key); sync(); showCurrentIssues(); });
    group.append(caption, input); grid.append(group); inputs.set(key, input);
  }
  function values() { return Object.fromEntries([...inputs].map(([key, input]) => [key, input.value])); }
  function showCurrentIssues(unknown = []) {
    const issues = validateFields(values());
    for (const field of unresolved) if (!issues.some(issue => issue.field === field)) issues.push({ field, message: 'Поле «' + (FIELD_LABELS[field] || 'Исходный текст') + '» требует явного выбора или ручного исправления по исходнику.' });
    showIssues(issues, unknown);
  }
  function showIssues(issues, unknown = []) {
    messages.replaceChildren();
    for (const issue of issues) messages.append(element('p', '', issue.message));
    if (unknown.length) messages.append(element('p', 'record-field-hint', 'Не распределено по полям: ' + unknown.join(' · ')));
    if (!issues.length) messages.append(element('p', 'record-field-hint', 'Формат заполненных полей проверен. Достоверность и принадлежность счёта проверьте по исходнику.'));
  }
  function sync() {
    const stored = canonicalRequisites(values(), source.value, { unresolvedFields: [...unresolved], confirmedFields: [...touched] });
    source.setCustomValidity(stored.length > 12000 ? 'Реквизиты вместе с исходником превышают 12 000 знаков. Сократите исходный текст перед сохранением.' : '');
    editorApi.setValue('requisites', stored);
  }
  function parseSource(save, replaceManual = false) {
    const parsed = parseRequisites(source.value);
    if (replaceManual) touched.clear();
    if (parsed.unresolvedFields.includes('requisites')) unresolved.add('requisites'); else unresolved.delete('requisites');
    for (const [key, input] of inputs) if (!touched.has(key)) {
      input.value = parsed.fields[key] || '';
      if (parsed.unresolvedFields.includes(key)) unresolved.add(key); else unresolved.delete(key);
    }
    showCurrentIssues(parsed.unknownLines);
    if (save) sync();
  }
  source.addEventListener('input', () => parseSource(true));
  const parse = element('button', 'button button-outline', 'Разобрать исходник заново'); parse.type = 'button';
  parse.addEventListener('click', () => parseSource(true, true));
  function refresh() {
    const stored = entry.read(); source.value = requisitesSource(stored);
    const parsed = parseRequisites(stored);
    touched.clear(); unresolved.clear();
    for (const key of parsed.confirmedFields) touched.add(key);
    for (const key of parsed.unresolvedFields) unresolved.add(key);
    for (const [key, input] of inputs) input.value = parsed.fields[key] || '';
    showIssues(parsed.issues, parsed.unknownLines);
  }
  host.append(sourceLabel, source, note, parse, grid, messages); entry.group.append(host); refresh();
  return { refresh, setDisabled(disabled) { source.disabled = disabled; parse.disabled = disabled; for (const input of inputs.values()) input.disabled = disabled; } };
}
