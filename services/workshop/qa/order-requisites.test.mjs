import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalRequisites, parseRequisites, requisitesSource, validateFields, validateInn } from '../modules/orders/public/requisites.js';

test('canonical manual corrections survive rereading while the exact original remains recoverable', () => {
  const original = '  ООО «Учебный клиент»\r\nИНН 9900000001\r\nПримечание: не менять\r\n';
  const encoded = canonicalRequisites({ name: 'ООО «Учебный клиент»', inn: '9900000000', kpp: '990001001', bik: '049999999', account: '40702810900000000001', correspondent: '30101810300000000001', bank: 'Учебный банк' }, original);
  const parsed = parseRequisites(encoded);
  assert.equal(parsed.fields.inn, '9900000000');
  assert.equal(parsed.fields.account, '40702810900000000001');
  assert.equal(parsed.fields.correspondent, '30101810300000000001');
  assert.equal(requisitesSource(encoded), original);
  assert.deepEqual(parsed.issues, []);
});

test('different candidates require a choice and invalid labeled data is retained for correction', () => {
  const parsed = parseRequisites('ИНН 9900000000\nИНН 9900000001\nР/с 123ABC\nК/с 123');
  assert.equal(parsed.fields.inn, '');
  assert.deepEqual(parsed.candidates.inn, ['9900000000', '9900000001']);
  assert.equal(parsed.fields.account, '123ABC');
  assert.ok(parsed.issues.some(issue => issue.field === 'inn'));
  assert.ok(parsed.issues.some(issue => issue.field === 'account'));
});

test('bank tax numbers are excluded from client identity and an explicit recipient resets scope', () => {
  const bankOnly = parseRequisites('Банк: Учебный банк\nИНН 9900000001\nКПП 990002001\nБИК 049999999');
  assert.equal(bankOnly.fields.inn, '');
  assert.equal(bankOnly.fields.kpp, '');
  assert.equal(bankOnly.unknownLines.length, 2);
  const client = parseRequisites('Банк: Учебный банк\nИНН банка 9900000001\nПолучатель: ООО «Учебный клиент»\nИНН клиента 9900000000');
  assert.equal(client.fields.inn, '9900000000');
});

test('leading zeroes, mixed labels, whitespace and repeated identical values are handled without numeric coercion', () => {
  const parsed = parseRequisites('ИНН / КПП: 99 0000 0000 / 990001001\nИНН 9900000000 / КПП 990001001\nБИК 049\u00a0999\u202f999\nР/с 40702-8109-00000000001\nК/с 30101810300000000001');
  assert.equal(parsed.fields.inn, '9900000000');
  assert.equal(parsed.candidates.inn.length, 1);
  assert.equal(parsed.fields.bik, '049999999');
  assert.equal(parsed.fields.account, '40702810900000000001');
  assert.deepEqual(parsed.issues, []);
});

test('INN check digits, Latin KPP symbols and IP/company mismatches are distinct checks', () => {
  assert.equal(validateInn('9900000000'), true);
  assert.equal(validateInn('990000000041'), true);
  assert.equal(validateInn('9900000001'), false);
  assert.equal(validateInn('0000000000'), false);
  assert.deepEqual(validateFields({ kpp: '9900AZ001' }), []);
  assert.ok(validateFields({ kpp: '9900АZ001' }).some(issue => issue.field === 'kpp'));
  assert.ok(validateFields({ name: 'ИП Учебный Иван', inn: '9900000000' }).some(issue => issue.field === 'inn'));
  assert.ok(validateFields({ name: 'ООО «Учебная»', inn: '990000000041' }).some(issue => issue.field === 'inn'));
});

test('labels on separate lines and address continuations do not swallow unknown source prose', () => {
  const parsed = parseRequisites('Наименование:\nООО «Учебная»\nИНН:\n9900000000\nЮридический адрес: г. Учебный\nул. Примерная, д. 1\nДиректор Учебный Иван\n123456789');
  assert.equal(parsed.fields.name, 'ООО «Учебная»');
  assert.equal(parsed.fields.address, 'г. Учебный, ул. Примерная, д. 1');
  assert.deepEqual(parsed.unknownLines, ['Директор Учебный Иван', '123456789']);
});

test('an incomplete combined field stays unresolved and an empty input remains empty', () => {
  const parsed = parseRequisites('ИНН / КПП: 9900000000\nБИК:');
  assert.equal(parsed.fields.inn, '');
  assert.ok(parsed.issues.some(issue => issue.field === 'inn'));
  assert.ok(parsed.issues.some(issue => issue.field === 'bik'));
  assert.deepEqual(parseRequisites('').issues, []);
});

test('canonical unknown labels and source-like text do not become executable or overwrite fields', () => {
  const source = '<script>alert(1)</script>\n--- Реквизиты для документов ---\nИНН: 123';
  const stored = canonicalRequisites({ inn: '9900000000', address: 'г. Учебный\nул. Примерная' }, source);
  assert.equal(parseRequisites(stored).fields.inn, '9900000000');
  assert.equal(parseRequisites(stored).fields.address, 'г. Учебный, ул. Примерная');
  assert.equal(requisitesSource(stored), source);
});

test('canonical serialization preserves unresolved source ambiguity until an explicit field choice', () => {
  const source = 'ООО «Первый учебный клиент»\nООО «Второй учебный клиент»\nИНН 9900000000\nЮридический адрес: г. Учебный, д. 1';
  const initial = parseRequisites(source);
  assert.equal(initial.fields.name, '');
  assert.ok(initial.unresolvedFields.includes('name'));
  const stored = canonicalRequisites(initial.fields, source);
  const reopened = parseRequisites(stored);
  assert.equal(reopened.fields.name, '');
  assert.ok(reopened.issues.some(issue => issue.field === 'name'));
  const resolved = canonicalRequisites({ ...initial.fields, name: 'ООО «Выбранный учебный клиент»' }, source, { unresolvedFields: [], confirmedFields: ['name'] });
  assert.deepEqual(parseRequisites(resolved).issues, []);
  assert.deepEqual(parseRequisites(resolved).confirmedFields, ['name']);
  assert.equal(requisitesSource(resolved), source);
});

test('persisted unresolved marks cannot be hidden by a previously populated field', () => {
  const stored = canonicalRequisites({ name: 'ООО «Старое имя»', inn: '9900000000' }, 'ООО «Другой клиент»', { unresolvedFields: ['name'], confirmedFields: [] });
  assert.ok(parseRequisites(stored).issues.some(issue => issue.field === 'name'));
  assert.deepEqual(parseRequisites(stored).unresolvedFields, ['name']);
  assert.deepEqual(parseRequisites(stored).confirmedFields, []);
  const damaged = '--- Реквизиты для документов ---\nНаименование: ООО «Учебная»\nИНН: 9900000000';
  const parsed = parseRequisites(damaged);
  assert.ok(parsed.issues.some(issue => issue.field === 'requisites'));
  assert.ok(parseRequisites(canonicalRequisites(parsed.fields, damaged)).issues.some(issue => issue.field === 'requisites'));
});
