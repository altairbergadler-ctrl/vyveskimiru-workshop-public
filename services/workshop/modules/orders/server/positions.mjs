import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { a1 } from './sheets.mjs';
import { OrderError, columnName, findUniqueOrder, parseNumber, readTables } from './orders.mjs';
import { describeRecord } from './editing.mjs';

const TEMPLATE_NAMES = {
  street: 'Уличная вывеска',
  neon: 'Неоновая вывеска',
  plotter: 'Плоттерная резка',
};
const BLOCKED_STATUSES = new Set(['Готов к выдаче', 'Монтаж', 'Сдан', 'Отменён']);
const ITEM_FORMULAS = ['Название заказа', 'Объём (расч.)', 'Сумма', 'Себестоимость', 'Дата заказа'];
const PRODUCTION_FORMULAS = ['Название заказа', 'Клиент', 'Срок сдачи', 'Можно', 'Норма, ч', 'К оплате', 'Ждёт 1', 'Ждёт 2'];
const queues = new Map();
const text = value => value === undefined || value === null ? '' : String(value).trim();
const formula = value => typeof value === 'string' && value.startsWith('=');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unconfirmed = () => new OrderError('POSITION_CREATE_UNCONFIRMED', 'Позиция отправлена в таблицу, но результат пока не подтверждён. Нажмите «Проверить добавление»: повторная запись не выполняется.', 409);

function column(table, ...labels) {
  return labels.map(label => table.indices.get(label)).find(index => index !== undefined);
}

function requireColumns(table, labels) {
  for (const label of labels) if (column(table, ...(Array.isArray(label) ? label : [label])) === undefined) {
    throw new OrderError('POSITION_CREATE_SCHEMA', `На листе «${table.name}» не хватает поля «${Array.isArray(label) ? label[0] : label}».`, 409);
  }
}

function routeStages(table, product) {
  const stages = table.rows.filter(row => text(table.cell(row, 'Вид изделия')) === product)
    .map(row => ({
      name: text(table.cell(row, 'Этап')),
      order: parseNumber(table.cell(row, '№')) ?? Number.MAX_SAFE_INTEGER,
      hours: parseNumber(table.cell(row, 'Норма, ч', 'Норма ч')) ?? 0,
    }))
    .filter(stage => stage.name && stage.name !== 'Монтаж')
    .sort((left, right) => left.order - right.order);
  if (stages.some((stage, index) => stage.order !== index + 1)) throw new OrderError('POSITION_ROUTE_INVALID', `Проверьте порядок этапов маршрута «${product}».`, 409);
  return stages;
}

function schema(tables, orderId) {
  const orders = tables['Заказы'];
  const order = findUniqueOrder(orders, orderId);
  const status = text(orders.cell(order, 'Статус'));
  if (BLOCKED_STATUSES.has(status)) throw new OrderError('POSITION_ORDER_CLOSED', 'В готовый, монтажный, архивный или отменённый заказ нельзя добавлять новые позиции. Сначала верните заказ в рабочий статус.', 409);
  requireColumns(tables['Позиции'], [
    '№ заказа', 'Название заказа', 'Наименование работы / изделия', ['Описание, макет, адрес', 'Описание макет адрес'], 'Ед. изм.',
    ['Ширина, м', 'Ширина м'], ['Высота, м', 'Высота м'], 'Кол-во', 'Объём (расч.)', 'Цена за ед.', 'Сумма', 'Себест. за ед.', 'Себестоимость', 'Дата заказа',
  ]);
  requireColumns(tables['Производство'], ['№ заказа', 'Название заказа', 'Изделие', 'Клиент', 'Срок сдачи', 'Этап', 'Готово', 'Можно', 'Норма, ч', 'К оплате', 'Ждёт 1', 'Ждёт 2']);
  return order;
}

function units(table) {
  const result = [...new Set(table.rows.map(row => text(table.cell(row, 'Ед. изм.'))).filter(Boolean))];
  return result.length ? result : ['шт', 'м²', 'м.п.', 'компл.'];
}

export async function positionCreationForm(client, { orderId } = {}, { templates: routeTemplates } = {}) {
  orderId = text(orderId);
  if (!orderId) throw new OrderError('INVALID_ORDER', 'Не указан заказ для позиции.', 400);
  const { tables } = await readTables(client, ['Заказы', 'Настройки', 'Позиции', 'Производство', 'Маршруты'], { includeFormulas: true });
  schema(tables, orderId);
  const templates = routeTemplates ? structuredClone(routeTemplates) : ['street', 'neon', 'plotter'].map(id => {
    const name = TEMPLATE_NAMES[id];
    const stages = routeStages(tables['Маршруты'], name);
    return { id, name, stages, totalHours: stages.reduce((sum, stage) => sum + stage.hours, 0) };
  });
  templates.push({ id: 'custom', name: 'Нетиповая работа', stages: [], totalHours: 0 });
  return { orderId, units: units(tables['Настройки']), templates };
}

function number(value, label, { required = false } = {}) {
  if (value === '' || value === null || value === undefined) {
    if (required) throw new OrderError('REQUIRED_FIELD', `Заполните поле «${label}».`, 422);
    return '';
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || required && value <= 0) throw new OrderError('INVALID_FIELD', `«${label}»: укажите ${required ? 'положительное' : 'неотрицательное'} число.`, 422);
  return value;
}

function validate(input, tables, externalProduction = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['template', 'name', 'description', 'unit', 'width', 'height', 'quantity', 'unitPrice', 'unitCost'].includes(key))) {
    throw new OrderError('INVALID_POSITION_CREATE', 'Переданы неизвестные поля позиции.', 400);
  }
  const template = text(input.template);
  const route = externalProduction && /^route:[a-zA-Z0-9_-]{1,160}$/u.test(template);
  if (!route && ![...Object.keys(TEMPLATE_NAMES), 'custom'].includes(template)) throw new OrderError('INVALID_POSITION_TEMPLATE', 'Выберите тип позиции.', 422);
  const name = template === 'custom' || route ? text(input.name) : TEMPLATE_NAMES[template];
  const description = text(input.description);
  const unit = text(input.unit);
  if (!name || name.length > 300) throw new OrderError('REQUIRED_FIELD', 'Укажите короткое название позиции.', 422);
  if (!description || description.length > 12_000 || /\u0000/u.test(description)) throw new OrderError('REQUIRED_FIELD', 'Заполните описание позиции.', 422);
  const allowedUnits = units(tables['Настройки']);
  if ((!route && !allowedUnits.includes(unit)) || !unit || unit.length > 60) throw new OrderError('INVALID_FIELD', 'Выберите единицу измерения из настроек таблицы.', 422);
  return {
    template, name, description, unit,
    width: number(input.width, 'Ширина'), height: number(input.height, 'Высота'),
    quantity: number(input.quantity, 'Количество', { required: true }),
    unitPrice: number(input.unitPrice, 'Цена за единицу'), unitCost: number(input.unitCost, 'Себестоимость за единицу'),
  };
}

function candidateItem(table) {
  const derived = new Set(ITEM_FORMULAS.map(label => column(table, label)));
  for (let index = table.headerIndex + 1; index < table.rawValues.length; index++) {
    const row = table.rawValues[index] ?? [];
    if (![...derived].every(position => formula(row[position]))) continue;
    if (table.headers.some((_, position) => !derived.has(position) && text(row[position]))) continue;
    return index + 1;
  }
  throw new OrderError('POSITION_CREATE_NO_ITEM_ROW', 'На листе «Позиции» закончились подготовленные строки с формулами.', 409);
}

function candidateProduction(table, count) {
  const derived = new Set(PRODUCTION_FORMULAS.map(label => column(table, label, label === 'Норма, ч' ? 'Норма ч' : label)));
  const done = column(table, 'Готово');
  const result = [];
  for (let index = table.headerIndex + 1; index < table.rawValues.length && result.length < count; index++) {
    const row = table.rawValues[index] ?? [];
    if (![...derived].every(position => formula(row[position]))) continue;
    const occupied = table.headers.some((_, position) => {
      if (derived.has(position)) return false;
      const value = row[position];
      if (position === done && (value === false || value === 'FALSE' || value === '')) return false;
      return text(value) !== '';
    });
    if (!occupied) result.push(index + 1);
  }
  if (result.length !== count) throw new OrderError('POSITION_CREATE_NO_PRODUCTION_ROWS', 'На листе «Производство» не хватает подготовленных строк для маршрута.', 409);
  return result;
}

function write(table, rowNumber, label, value, aliases = []) {
  const position = column(table, label, ...aliases);
  return { range: a1(table.name, `${columnName(position)}${rowNumber}`), values: [[value]] };
}

function plan(tables, orderId, cleaned, externalProduction = false) {
  const item = tables['Позиции'];
  const production = tables['Производство'];
  const itemRow = candidateItem(item);
  const stages = externalProduction || cleaned.template === 'custom' ? [] : routeStages(tables['Маршруты'], cleaned.name);
  const productionRows = candidateProduction(production, stages.length);
  const updates = [
    write(item, itemRow, '№ заказа', orderId),
    write(item, itemRow, 'Наименование работы / изделия', cleaned.name),
    write(item, itemRow, 'Описание, макет, адрес', cleaned.description, ['Описание макет адрес']),
    write(item, itemRow, 'Ед. изм.', cleaned.unit),
    write(item, itemRow, 'Кол-во', cleaned.quantity),
  ];
  for (const [label, aliases, value] of [
    ['Ширина, м', ['Ширина м'], cleaned.width], ['Высота, м', ['Высота м'], cleaned.height],
    ['Цена за ед.', [], cleaned.unitPrice], ['Себест. за ед.', [], cleaned.unitCost],
  ]) if (value !== '') updates.push(write(item, itemRow, label, value, aliases));
  stages.forEach((stage, index) => {
    const row = productionRows[index];
    updates.push(write(production, row, '№ заказа', orderId), write(production, row, 'Изделие', cleaned.name), write(production, row, 'Этап', stage.name));
  });
  return { itemRow, productionRows, stages, updates };
}

function snapshot(tables) {
  return hash(['Заказы', 'Настройки', 'Позиции', 'Производство', 'Маршруты'].map(name => [tables[name].properties.sheetId, tables[name].headers, tables[name].rawValues]));
}

function applied(record, tables) {
  if (record.tables.some(entry => tables[entry.name]?.properties.sheetId !== entry.sheetId || hash(tables[entry.name].headers) !== entry.headersHash)) return false;
  for (const entry of record.rows) {
    const row = tables[entry.name].rawValues[entry.rowNumber - 1] ?? [];
    for (let position = 0; position < Math.max(row.length, entry.expected.length); position++) if ((row[position] ?? '') !== (entry.expected[position] ?? '')) return false;
  }
  return true;
}

function journalRecord(requestId, payloadHash, orderId, cleaned, tables, planValue) {
  const changed = new Map();
  for (const update of planValue.updates) {
    const match = update.range.match(/^'((?:[^']|'')+)'!([A-Z]+)(\d+)$/u);
    let position = 0;
    for (const letter of match[2]) position = position * 26 + letter.charCodeAt(0) - 64;
    const key = `${match[1]}:${match[3]}`;
    if (!changed.has(key)) changed.set(key, { name: match[1], rowNumber: Number(match[3]), expected: [...(tables[match[1]].rawValues[Number(match[3]) - 1] ?? [])] });
    changed.get(key).expected[position - 1] = update.values[0][0];
  }
  return {
    requestId, payloadHash, state: 'reserved', orderId, itemRow: planValue.itemRow,
    routeStageCount: planValue.stages.length, product: cleaned.name,
    tables: ['Позиции', 'Производство'].map(name => ({ name, sheetId: tables[name].properties.sheetId, headersHash: hash(tables[name].headers) })),
    rows: [...changed.values()], updates: planValue.updates,
  };
}

function syncDirectory(directory) {
  let fd;
  try { fd = fs.openSync(directory, 'r'); fs.fsyncSync(fd); }
  catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EISDIR', 'EINVAL'].includes(error.code)) throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function save(directory, record, fresh = false) {
  const filename = path.join(directory, `${record.requestId}.json`);
  const target = fresh ? filename : `${filename}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(target, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  if (!fresh) fs.renameSync(target, filename);
  syncDirectory(directory);
}

function load(directory, requestId) {
  try { return JSON.parse(fs.readFileSync(path.join(directory, `${requestId}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new OrderError('POSITION_CREATE_JOURNAL', 'Не удалось проверить журнал добавления позиций.', 503); }
}

async function serialized(key, operation) {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(operation);
  queues.set(key, run);
  try { return await run; }
  finally { if (queues.get(key) === run) queues.delete(key); }
}

export async function createPosition(client, { requestId, orderId, position } = {}, { journalDir = process.env.POSITION_CREATE_DIR || '/var/lib/orders-kanban/position-creation', prepareProduction, ensureProduction } = {}) {
  if (typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(requestId)) throw new OrderError('INVALID_REQUEST_ID', 'Не указан постоянный номер заявки позиции.', 400);
  requestId = requestId.toLowerCase();
  orderId = text(orderId);
  if (!orderId) throw new OrderError('INVALID_ORDER', 'Не указан заказ для позиции.', 400);
  const payloadHash = hash({ orderId, position });
  async function finish(record) {
    if (record.productionRoute) {
      if (!ensureProduction) throw unconfirmed();
      try { await ensureProduction(record); save(directory, { ...record, state: 'verified' }); }
      catch { throw new OrderError('POSITION_CREATE_UNCONFIRMED', 'Позиция сохранена, маршрут ещё не подтверждён. Нажмите «Проверить добавление» — повтор не создаст дубли.', 409); }
    }
    return { itemRow: record.itemRow, routeStageCount: record.routeStageCount, product: record.product, changed: true };
  }
  const directory = path.resolve(journalDir);
  return serialized(directory, async () => {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const existing = load(directory, requestId);
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new OrderError('POSITION_CREATE_REQUEST_CONFLICT', 'Эта заявка уже отправлена с другими полями.', 409);
      if (existing.state === 'verified') return finish(existing);
      if (existing.state === 'aborted') throw new OrderError('POSITION_CREATE_SOURCE_CHANGED', 'Таблица изменилась до отправки позиции. Обновите форму и начните добавление заново.', 409);
      const current = (await readTables(client, ['Позиции', 'Производство'], { includeFormulas: true })).tables;
      if (!applied(existing, current)) throw unconfirmed();
      save(directory, { ...existing, state: existing.productionRoute ? 'position_verified' : 'verified' });
      return finish(existing);
    }

    for (const filename of fs.readdirSync(directory).filter(name => /^[a-f0-9-]+\.json$/iu.test(name))) {
      const record = load(directory, filename.slice(0, -5));
      if (!record || ['verified', 'aborted'].includes(record.state)) continue;
      const current = (await readTables(client, ['Позиции', 'Производство'], { includeFormulas: true })).tables;
      if (!applied(record, current)) throw unconfirmed();
      save(directory, { ...record, state: record.productionRoute ? 'position_verified' : 'verified' });
      await finish(record);
    }

    const before = await readTables(client, ['Заказы', 'Настройки', 'Позиции', 'Производство', 'Маршруты'], { includeFormulas: true });
    const tables = before.tables;
    const order = schema(tables, orderId);
    const canonicalOrderId = tables['Заказы'].rawCell(order, '№ заказа');
    const cleaned = validate(position, tables, Boolean(prepareProduction));
    const productionRoute = prepareProduction ? await prepareProduction({ orderId, position: cleaned, allowedUnits: units(tables['Настройки']) }) : null;
    const planValue = plan(tables, canonicalOrderId, cleaned, Boolean(prepareProduction));
    const record = journalRecord(requestId, payloadHash, orderId, cleaned, tables, planValue);
    if (productionRoute) { record.productionRoute = productionRoute; record.routeStageCount = productionRoute.product.versions.at(-1).stages.length; }
    save(directory, record, true);
    try {
      const fresh = await readTables(client, ['Заказы', 'Настройки', 'Позиции', 'Производство', 'Маршруты'], { includeFormulas: true });
      if (snapshot(fresh.tables) !== snapshot(tables)) throw new Error('changed');
    } catch {
      save(directory, { ...record, state: 'aborted' });
      throw new OrderError('POSITION_CREATE_SOURCE_CHANGED', 'Таблица изменилась до отправки позиции. Обновите форму и повторите добавление.', 409);
    }
    try { await client.updateValues(planValue.updates); } catch (error) {
      if (error.notSubmitted) { save(directory, { ...record, state: 'aborted' }); throw error; }
    }
    try {
      const current = (await readTables(client, ['Позиции', 'Производство'], { includeFormulas: true })).tables;
      if (!applied(record, current)) throw new Error('unconfirmed');
      save(directory, { ...record, state: record.productionRoute ? 'position_verified' : 'verified' });
    } catch { throw unconfirmed(); }
    return finish(record);
  });
}

// Reuse the position command queue and durable receipts. Clearing only manual
// cells releases a prepared row; deleting a spreadsheet row would shift formulas.
export async function deletePosition(client, {requestId, orderId, record: token} = {}, {
  journalDir = process.env.POSITION_CREATE_DIR || '/var/lib/orders-kanban/position-creation', assertProductionDetached,
} = {}) {
  if(typeof requestId !== 'string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(requestId))throw new OrderError('INVALID_REQUEST_ID','Не указан номер заявки удаления.',400);
  requestId=requestId.toLowerCase();orderId=text(orderId);
  if(!orderId||!token||token.sheet!=='Позиции'||!Number.isInteger(token.rowNumber)||typeof token.key!=='string'||typeof token.revision!=='string'||Object.keys(token).some(key=>!['sheet','rowNumber','key','revision'].includes(key)))throw new OrderError('INVALID_POSITION_DELETE','Не удалось определить позицию. Обновите заказ.',400);
  const directory=path.resolve(journalDir),payloadHash=hash({operation:'delete',orderId,record:token});
  const uncertain=()=>new OrderError('POSITION_DELETE_UNCONFIRMED','Удаление пока не подтверждено. Нажмите «Проверить удаление»: повторно очищать строку не будем.',409);
  const result=receipt=>({itemRow:receipt.itemRow,product:receipt.product,changed:true});
  return serialized(directory,async()=>{
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    const existing=load(directory,requestId);
    if(existing){
      if(existing.payloadHash!==payloadHash)throw new OrderError('POSITION_DELETE_REQUEST_CONFLICT','Эта заявка относится к другой операции.',409);
      if(existing.state==='verified')return result(existing);
      if(existing.state==='aborted')throw new OrderError('POSITION_DELETE_SOURCE_CHANGED','Исходная позиция изменилась. Обновите заказ и начните удаление заново.',409);
      try{const {tables}=await readTables(client,['Позиции','Производство'],{includeFormulas:true});if(!applied(existing,tables))throw uncertain();}
      catch{throw uncertain();}
      save(directory,{...existing,state:'verified'});return result(existing);
    }
    for(const filename of fs.readdirSync(directory).filter(name=>/^[a-f0-9-]+\.json$/iu.test(name))){
      const pending=load(directory,filename.slice(0,-5));
      if(pending&&!['verified','aborted'].includes(pending.state))throw new OrderError('POSITION_DELETE_PENDING','Сначала подтвердите предыдущую операцию с позициями.',409);
    }
    const names=['Заказы','Настройки','Позиции','Производство','Маршруты'];
    const {tables}=await readTables(client,names,{includeFormulas:true});
    const order=findUniqueOrder(tables['Заказы'],orderId);
    if(BLOCKED_STATUSES.has(text(tables['Заказы'].cell(order,'Статус'))))throw new OrderError('POSITION_ORDER_CLOSED','Чтобы удалить позицию, сначала верните заказ в рабочий статус.',409);
    const table=tables['Позиции'],row=table.rows.find(candidate=>candidate.rowNumber===token.rowNumber);
    if(!row||text(table.rawCell(row,'№ заказа'))!==orderId)throw new OrderError('POSITION_DELETE_SOURCE_CHANGED','Позиция больше не принадлежит этому заказу. Обновите данные.',409);
    const descriptor=describeRecord('item',table,row,tables);
    if(['sheet','rowNumber','key','revision'].some(key=>descriptor.record[key]!==token[key]))throw new OrderError('POSITION_DELETE_SOURCE_CHANGED','Позиция или таблица изменились. Обновите заказ перед удалением.',409);
    const product=text(table.cell(row,'Наименование работы / изделия'));
    const linked=tables['Производство'].rows.some(stage=>text(tables['Производство'].cell(stage,'№ заказа'))===orderId&&text(tables['Производство'].cell(stage,'Изделие'))===product);
    if(linked)throw new OrderError('POSITION_DELETE_PRODUCTION','Позиция связана с производством. Сначала разберите её производственный маршрут; история работ не удалена.',409);
    const manual=['orderId','name','description','unit','width','height','quantity','unitPrice','unitCost'];
    if(manual.some(id=>!descriptor.fields.some(field=>field.id===id&&field.editable)))throw new OrderError('POSITION_DELETE_SCHEMA','Некоторые поля позиции защищены или содержат формулы. Удаление остановлено.',409);
    const labels=['№ заказа','Наименование работы / изделия',['Описание, макет, адрес','Описание макет адрес'],'Ед. изм.',['Ширина, м','Ширина м'],['Высота, м','Высота м'],'Кол-во','Цена за ед.','Себест. за ед.'];
    requireColumns(table,labels);
    const updates=labels.map(label=>({range:a1('Позиции',`${columnName(column(table,...(Array.isArray(label)?label:[label])))}${row.rowNumber}`),values:[['']]}));
    const reference={orderId,itemRow:row.rowNumber,product};
    await assertProductionDetached?.(reference);
    const receipt={...journalRecord(requestId,payloadHash,orderId,{name:product},tables,{updates,itemRow:row.rowNumber,stages:[]}),operation:'delete',beforeRow:[...table.rawValues[row.rowNumber-1]]};
    save(directory,receipt,true);
    try{
      const fresh=await readTables(client,names,{includeFormulas:true});
      if(snapshot(fresh.tables)!==snapshot(tables))throw new Error('source changed');
      await assertProductionDetached?.(reference);
    }catch{
      save(directory,{...receipt,state:'aborted'});
      throw new OrderError('POSITION_DELETE_SOURCE_CHANGED','Данные изменились до удаления. Обновите заказ и повторите действие.',409);
    }
    try{await client.updateValues(updates);}catch(error){if(error.notSubmitted){save(directory,{...receipt,state:'aborted'});throw error;}}
    try{
      const current=(await readTables(client,['Позиции','Производство'],{includeFormulas:true})).tables;
      if(!applied(receipt,current))throw uncertain();
    }catch{throw uncertain();}
    save(directory,{...receipt,state:'verified'});return result(receipt);
  });
}
