import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPosition, positionCreationForm, deletePosition } from './positions.mjs';
import { describeRecord } from './editing.mjs';
import { readTables } from './orders.mjs';

const ORDER_HEADERS = ['№ заказа', 'Название заказа', 'Статус'];
const ITEM_HEADERS = ['№ заказа', 'Название заказа', 'Наименование работы / изделия', 'Описание, макет, адрес', 'Ед. изм.', 'Ширина, м', 'Высота, м', 'Кол-во', 'Объём (расч.)', 'Цена за ед.', 'Сумма', 'Себест. за ед.', 'Себестоимость', 'Дата заказа'];
const PRODUCTION_HEADERS = ['№ заказа', 'Название заказа', 'Изделие', 'Клиент', 'Срок сдачи', 'Этап', 'Готово', 'Можно', 'Исполнитель', 'План', 'Факт', 'Часы', 'Норма, ч', 'К оплате', 'Ждёт 1', 'Ждёт 2', 'Комментарий'];
const ROUTE_HEADERS = ['Вид изделия', '№', 'Этап', 'Ждёт 1', 'Ждёт 2', 'Норма, ч', 'Ключ'];
const itemFormulaColumns = [1, 8, 10, 12, 13];
const productionFormulaColumns = [1, 3, 4, 7, 12, 13, 14, 15];

function prepared(headers, formulaColumns, rowNumber, doneColumn) {
  return headers.map((_, position) => position === doneColumn ? false : formulaColumns.includes(position) ? `=IF(A${rowNumber}="","",A${rowNumber})` : '');
}

class Mock {
  constructor() {
    const street = ['Макет и согласование', 'Фрезеровка / раскрой', 'Сборка каркаса', 'Электрика и подсветка', 'Покраска', 'Лицо: плёнка, аппликация', 'Финальная сборка', 'Упаковка и доставка', 'Монтаж'];
    const neon = ['Макет и согласование', 'Гибка неона', 'Основание / подложка', 'Монтаж неона на основание', 'Электрика и БП', 'Прожиг и проверка', 'Упаковка и доставка', 'Монтаж'];
    this.raw = {
      'Заказы': [ORDER_HEADERS, [16, 'Новый заказ', 'Согласован']],
      'Настройки': [['Статус заказа', 'Ед. изм.'], ['Расчёт / КП', 'шт'], ['Согласован', 'м²'], ['В производстве', 'м.п.']],
      'Позиции': [ITEM_HEADERS, ...Array.from({ length: 4 }, (_, index) => prepared(ITEM_HEADERS, itemFormulaColumns, index + 2))],
      'Производство': [PRODUCTION_HEADERS, ...Array.from({ length: 24 }, (_, index) => prepared(PRODUCTION_HEADERS, productionFormulaColumns, index + 2, 6))],
      'Маршруты': [ROUTE_HEADERS,
        ...street.map((name, index) => ['Уличная вывеска', index + 1, name, '', '', index + 1, `Уличная вывеска|${name}`]),
        ...neon.map((name, index) => ['Неоновая вывеска', index + 1, name, '', '', 1, `Неоновая вывеска|${name}`]),
      ],
    };
    this.writes = [];
  }
  async getSpreadsheet() {
    return { sheets: Object.keys(this.raw).map((title, sheetId) => ({ properties: { title, sheetId, gridProperties: { rowCount: 100, columnCount: this.raw[title][0].length } } })) };
  }
  async getRanges(ranges, { valueRenderOption } = {}) {
    if (this.failReadback && this.writes.length) throw new Error('read timeout');
    return { valueRanges: ranges.map(range => {
      const name = range.match(/^'([^']+)'!/u)[1];
      const values = structuredClone(this.raw[name]);
      if (valueRenderOption !== 'FORMULA') for (const row of values.slice(1)) for (let position = 0; position < row.length; position++) if (typeof row[position] === 'string' && row[position].startsWith('=')) row[position] = '';
      return { range, values };
    }) };
  }
  async updateValues(updates) {
    this.writes.push(structuredClone(updates));
    if (this.noApply) throw new Error('lost before apply');
    for (const update of updates) {
      const [, name, letters, row] = update.range.match(/^'([^']+)'!([A-Z]+)(\d+)$/u);
      let position = 0;
      for (const letter of letters) position = position * 26 + letter.charCodeAt(0) - 64;
      this.raw[name][Number(row) - 1][position - 1] = update.values[0][0];
    }
    if (this.throwAfterApply) throw new Error('lost after apply');
  }
}

function context(t) {
  const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-position-'));
  t.after(() => fs.rmSync(journalDir, { recursive: true, force: true }));
  return { journalDir };
}

const deleteFixturePosition={template:'custom',name:'Баннер',description:'Люверсы по углам',unit:'шт',quantity:2,width:1,height:2,unitPrice:100,unitCost:50};
async function deletionRequest(client,rowNumber=2){
  const {tables}=await readTables(client,['Позиции','Заказы','Настройки'],{includeFormulas:true});
  return {requestId:crypto.randomUUID(),orderId:'16',record:describeRecord('item',tables['Позиции'],tables['Позиции'].rows.find(row=>row.rowNumber===rowNumber),tables).record};
}
test('position deletion clears only nine manual cells and retains formulas, other positions and original receipt',async t=>{
  const client=new Mock(),options=context(t);
  await createPosition(client,{requestId:crypto.randomUUID(),orderId:'16',position:deleteFixturePosition},options);
  await createPosition(client,{requestId:crypto.randomUUID(),orderId:'16',position:deleteFixturePosition},options);
  const before=structuredClone(client.raw),request=await deletionRequest(client);
  await deletePosition(client,request,options);
  assert.equal(client.writes.at(-1).length,9);
  for(let c=0;c<ITEM_HEADERS.length;c++)assert.equal(client.raw['Позиции'][1][c],itemFormulaColumns.includes(c)?before['Позиции'][1][c]:'');
  assert.deepEqual(client.raw['Позиции'].slice(2),before['Позиции'].slice(2));
  for(const name of ['Заказы','Настройки','Производство','Маршруты'])assert.deepEqual(client.raw[name],before[name]);
  const receipt=JSON.parse(fs.readFileSync(path.join(options.journalDir,request.requestId+'.json')));
  assert.deepEqual(receipt.beforeRow,before['Позиции'][1]);assert.equal(receipt.state,'verified');
  const writes=client.writes.length;await deletePosition(client,request,options);assert.equal(client.writes.length,writes);
});
test('lost deletion response resumes readback after restart and cannot erase a newly reused row',async t=>{
  const client=new Mock(),options=context(t);
  await createPosition(client,{requestId:crypto.randomUUID(),orderId:'16',position:deleteFixturePosition},options);
  const request=await deletionRequest(client),update=client.updateValues.bind(client);
  client.updateValues=async changes=>{await update(changes);client.failReadback=true;throw new Error('lost');};
  await assert.rejects(deletePosition(client,request,options),{code:'POSITION_DELETE_UNCONFIRMED'});
  const writes=client.writes.length;client.failReadback=false;client.updateValues=update;
  await deletePosition(client,request,{...options});assert.equal(client.writes.length,writes);
  await createPosition(client,{requestId:crypto.randomUUID(),orderId:'16',position:{...deleteFixturePosition,name:'Новое изделие'}},options);
  const after=structuredClone(client.raw);await deletePosition(client,request,options);assert.deepEqual(client.raw,after);
});
test('unapplied deletion is never resent and blocks row reuse until confirmation',async t=>{
  const client=new Mock(),options=context(t);
  await createPosition(client,{requestId:crypto.randomUUID(),orderId:'16',position:deleteFixturePosition},options);
  const request=await deletionRequest(client);client.noApply=true;
  await assert.rejects(deletePosition(client,request,options),{code:'POSITION_DELETE_UNCONFIRMED'});
  const writes=client.writes.length;client.noApply=false;
  await assert.rejects(deletePosition(client,request,options),{code:'POSITION_DELETE_UNCONFIRMED'});
  await assert.rejects(createPosition(client,{requestId:crypto.randomUUID(),orderId:'16',position:deleteFixturePosition},options),{code:'POSITION_CREATE_UNCONFIRMED'});
  assert.equal(client.writes.length,writes);assert.equal(client.raw['Позиции'][1][2],'Баннер');
});
test('deletion rejects stale or foreign records, closed orders and both production linkage sources',async t=>{
  const client=new Mock(),options=context(t);
  await createPosition(client,{requestId:crypto.randomUUID(),orderId:'16',position:deleteFixturePosition},options);
  const request=await deletionRequest(client),writes=client.writes.length;
  await assert.rejects(deletePosition(client,{...request,record:{...request.record,key:'wrong'}},options),{code:'POSITION_DELETE_SOURCE_CHANGED'});
  await assert.rejects(deletePosition(client,request,{...options,assertProductionDetached:()=>{throw Object.assign(new Error('linked'),{code:'POSITION_DELETE_PRODUCTION'});}}),{code:'POSITION_DELETE_PRODUCTION'});
  client.raw['Производство'][1][0]=16;client.raw['Производство'][1][2]='Баннер';
  await assert.rejects(deletePosition(client,request,options),{code:'POSITION_DELETE_PRODUCTION'});
  client.raw['Производство'][1][0]='';client.raw['Производство'][1][2]='';
  client.raw['Заказы'][1][2]='Сдан';await assert.rejects(deletePosition(client,request,options),{code:'POSITION_ORDER_CLOSED'});
  client.raw['Заказы'][1][2]='Согласован';client.raw['Позиции'][1][0]=99;
  await assert.rejects(deletePosition(client,request,options),{code:'POSITION_DELETE_SOURCE_CHANGED'});
  assert.equal(client.writes.length,writes);
});

function payload(overrides = {}) {
  return {
    requestId: crypto.randomUUID(), orderId: '16', position: {
      template: 'street', name: 'Уличная вывеска', description: 'Лицо белое. Подсветка 8500K.',
      unit: 'шт', width: 1.8, height: 0.6, quantity: 2, unitPrice: 10000, unitCost: 6000,
      ...overrides,
    },
  };
}

test('form exposes source routes without the separate installation stage', async () => {
  const form = await positionCreationForm(new Mock(), { orderId: '16' });
  assert.deepEqual(form.units, ['шт', 'м²', 'м.п.']);
  assert.deepEqual(form.templates.map(value => value.id), ['street', 'neon', 'plotter', 'custom']);
  assert.equal(form.templates.find(value => value.id === 'street').stages.length, 8);
  assert.equal(form.templates.find(value => value.id === 'neon').stages.length, 7);
  assert.ok(form.templates.find(value => value.id === 'neon').stages.some(stage => stage.name === 'Монтаж неона на основание'));
  assert.ok(form.templates.flatMap(value => value.stages).every(stage => stage.name !== 'Монтаж'));
});

test('typical position fills one prepared item row and creates its production route', async t => {
  const client = new Mock();
  const beforeItem = structuredClone(client.raw['Позиции'][1]);
  const beforeProduction = structuredClone(client.raw['Производство']);
  const result = await createPosition(client, payload(), context(t));
  assert.deepEqual(result, { itemRow: 2, routeStageCount: 8, product: 'Уличная вывеска', changed: true });
  const item = client.raw['Позиции'][1];
  assert.deepEqual([item[0], item[2], item[3], item[4], item[5], item[6], item[7], item[9], item[11]], [16, 'Уличная вывеска', 'Лицо белое. Подсветка 8500K.', 'шт', 1.8, 0.6, 2, 10000, 6000]);
  for (const position of itemFormulaColumns) assert.equal(item[position], beforeItem[position]);
  assert.deepEqual(client.raw['Производство'].slice(1, 9).map(row => [row[0], row[2], row[5]]), beforeProduction.slice(1, 9).map((row, index) => [16, 'Уличная вывеска', client.raw['Маршруты'][index + 1][2]]));
  assert.ok(client.raw['Производство'].slice(1, 9).every(row => row[5] !== 'Монтаж'));
  assert.deepEqual(client.raw['Производство'][9], beforeProduction[9]);
  assert.equal(client.writes.length, 1);
});

test('atypical position keeps free text and does not invent a production route', async t => {
  const client = new Mock();
  const input = payload({ template: 'custom', name: 'Стеллаж для цветов', description: 'Шесть секций по размерам из замера.', width: '', height: '', unitPrice: '', unitCost: '' });
  const before = structuredClone(client.raw['Производство']);
  const result = await createPosition(client, input, context(t));
  assert.equal(result.routeStageCount, 0);
  assert.equal(client.raw['Позиции'][1][2], 'Стеллаж для цветов');
  assert.deepEqual(client.raw['Производство'], before);
});

test('closed order and invalid values fail before any write', async t => {
  const client = new Mock();
  client.raw['Заказы'][1][2] = 'Готов к выдаче';
  await assert.rejects(createPosition(client, payload(), context(t)), { code: 'POSITION_ORDER_CLOSED' });
  assert.equal(client.writes.length, 0);
  const invalid = new Mock();
  await assert.rejects(createPosition(invalid, payload({ quantity: 0 }), context(t)), { code: 'INVALID_FIELD' });
  assert.equal(invalid.writes.length, 0);
});

test('lost response is recovered from the same journal without a duplicate position', async t => {
  const client = new Mock(); const config = context(t); const input = payload();
  client.throwAfterApply = true; client.failReadback = true;
  await assert.rejects(createPosition(client, input, config), { code: 'POSITION_CREATE_UNCONFIRMED' });
  client.failReadback = false;
  const result = await createPosition(client, input, config);
  assert.equal(result.itemRow, 2);
  assert.equal(client.writes.length, 1);
  assert.equal(client.raw['Позиции'].filter(row => row[0] === 16).length, 1);
});

test('an uncertain unapplied write blocks both replay and later creations', async t => {
  const client = new Mock(); const config = context(t); const input = payload(); client.noApply = true;
  await assert.rejects(createPosition(client, input, config), { code: 'POSITION_CREATE_UNCONFIRMED' });
  client.noApply = false;
  await assert.rejects(createPosition(client, input, config), { code: 'POSITION_CREATE_UNCONFIRMED' });
  await assert.rejects(createPosition(client, payload({ description: 'Другая позиция' }), config), { code: 'POSITION_CREATE_UNCONFIRMED' });
  assert.equal(client.writes.length, 1);
});


test('a known unsent contract refusal aborts the reservation without claiming a lost response', async t => {
  const client = new Mock(), options = context(t), input = payload({});
  const before = structuredClone(client.raw);
  client.updateValues = async () => { throw Object.assign(new Error('Contract denied'), { code: 'SHEETS_CONTRACT_HEADER', notSubmitted: true }); };
  await assert.rejects(() => createPosition(client, input, options), { code: 'SHEETS_CONTRACT_HEADER' });
  const record = JSON.parse(fs.readFileSync(path.join(options.journalDir, `${input.requestId}.json`), 'utf8'));
  assert.equal(record.state, 'aborted');
  assert.deepEqual(client.raw, before);
});


test('new production journals the route and recovers a lost confirmation without a second position or route', async t => {
  const { createProductionPilot } = await import('../../../server/production-pilot.mjs');
  const { productionFixture } = await import('../../../qa/production-fixture.mjs');
  const { default: Database } = await import('better-sqlite3');
  const prior = process.env.PRODUCTION_V2;
  process.env.PRODUCTION_V2 = 'google';
  t.after(() => { if (prior === undefined) delete process.env.PRODUCTION_V2; else process.env.PRODUCTION_V2 = prior; });
  const db = new Database(':memory:'); t.after(() => db.close());
  let state = productionFixture();
  state.orders = [{ id: '16', status: 'В производстве' }];
  const stage = { id: 'layout', name: 'Макет и согласование', kind: 'manual', skill: 'Сборка', resourceId: '', minutes: 20, dependencies: [], materials: [], setupMinutes: 0, finishMinutes: 0, controlEvery: 0, controlMinutes: 0 };
  state.products = [{ id: 'street', name: 'Уличная вывеска', unit: 'позиция', needsSetup: true, versions: [{ version: 1, stages: [stage, { ...stage, id: 'installation', name: 'Монтаж', dependencies: ['layout'] }] }] }];
  let commits = 0, lose = true;
  const store = { load: async () => structuredClone(state), pending: () => false, commit: async next => { commits++; state = structuredClone(next); if (lose) { lose = false; throw new Error('lost confirmation'); } } };
  const client = new Mock();
  const pilot = await createProductionPilot({ client, db, mediaStore: {}, liveStore: store });
  const options = { ...context(t), prepareProduction: pilot.preparePosition, ensureProduction: pilot.ensurePosition };
  const beforeLegacy = structuredClone(client.raw['Производство']);
  const input = payload({ quantity: 9 });
  const form = await pilot.positionForm(client, { orderId: '16' });
  assert.equal(form.templates[0].stages.length, 1);
  await assert.rejects(createPosition(client, input, options), e => e.code === 'POSITION_CREATE_UNCONFIRMED');
  const recovered = await createPosition(client, input, options);
  assert.equal(recovered.routeStageCount, 1);
  assert.equal(client.writes.length, 1);
  assert.deepEqual(client.raw['Производство'], beforeLegacy);
  assert.ok(client.writes[0].every(w => w.range.startsWith("'Позиции'!")));
  assert.equal(state.tasks.length, 1);
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].quantity, 1, 'legacy norms describe the entire position');
  assert.equal(state.items[0].sourcePosition, 'position:16:2');
  assert.equal(commits, 1);
  await createPosition(client, input, options);
  assert.equal(state.tasks.length, 1);
  assert.equal(client.writes.length, 1);
  await createPosition(client, payload({ quantity: 9 }), options);
  assert.equal(state.items.length, 2, 'two genuinely separate rows with the same name each receive a route');
  assert.equal(state.tasks.length, 2);
});

test('a product created in production appears in order forms and analytics, creates its exact route, and keeps the existing version after edits', async t => {
  const { createProductionPilot } = await import('../../../server/production-pilot.mjs');
  const { applyProductionCommand } = await import('../../../server/production-workflow.mjs');
  const { productionFixture } = await import('../../../qa/production-fixture.mjs');
  const { realModel, realRows } = await import('../../../prototypes/analytics/real-model.mjs');
  const { default: Database } = await import('better-sqlite3');
  const prior = process.env.PRODUCTION_V2;
  process.env.PRODUCTION_V2 = 'google';
  t.after(() => { if (prior === undefined) delete process.env.PRODUCTION_V2; else process.env.PRODUCTION_V2 = prior; });
  const db = new Database(':memory:'); t.after(() => db.close());
  let state = productionFixture();
  state.orders = [{id:'16', status:'В производстве'}]; state.products = [];
  const client = new Mock();
  const store = {load:async()=>structuredClone(state),pending:()=>false,commit:async next=>{state=structuredClone(next);}};
  const pilot = await createProductionPilot({client,db,mediaStore:{},liveStore:store});
  assert.equal((await pilot.positionForm(client,{orderId:'16'})).templates.length,1);
  const stage = {id:'assembly',name:'Сборка тестового изделия',kind:'manual',skill:'Сборка',resourceId:'',minutes:20,dependencies:[],materials:[],setupMinutes:0,finishMinutes:0,controlEvery:0,controlMinutes:0};
  const command = (type,data) => {state=applyProductionCommand(state,{id:'owner',role:'owner'},{type,data,requestId:crypto.randomUUID(),revision:state.revision}).state;};
  command('product.save',{name:'Новое тестовое изделие',unit:'компл.',stages:[stage]});
  const productId = state.products[0].id;
  const form = await pilot.positionForm(client,{orderId:'16'});
  const template = form.templates.find(p=>p.id==='route:'+productId);
  assert.equal(template.name,'Новое тестовое изделие'); assert.equal(template.unit,'компл.');
  assert.equal(template.stages.length,1);
  const beforeLegacy=structuredClone(client.raw['Производство']);
  const beforeRoutes=structuredClone(client.raw['Маршруты']);
  const options={...context(t),prepareProduction:pilot.preparePosition,ensureProduction:pilot.ensurePosition};
  const input=payload({template:template.id,name:template.name,unit:template.unit});
  await createPosition(client,input,options);
  assert.equal(state.items[0].productId,productId); assert.equal(state.items[0].sourcePosition,'position:16:2');
  assert.equal(state.tasks.length,1); assert.equal(state.tasks[0].name,stage.name);
  assert.deepEqual(client.raw['Производство'],beforeLegacy); assert.deepEqual(client.raw['Маршруты'],beforeRoutes);
  const frozen=structuredClone(state.tasks);
  command('product.save',{id:productId,name:'Переименованное тестовое изделие',unit:'компл.',stages:[{...stage,minutes:40}]});
  assert.deepEqual(state.tasks,frozen); assert.equal(state.items[0].productVersion,1);
  const catalog=await pilot.productCatalog();
  assert.equal(catalog.products[0].version,2); assert.equal(catalog.positions[0].productId,productId);
  const model=realModel({period:{dateFrom:'2026-09-01',dateTo:'2026-09-09'},rows:[{id:'ad-test',title:catalog.products[0].name}]},{sources:[{id:'orders',state:'ready'}],orders:{rows:[{id:'16',items:[{row:2,name:template.name}],paid:100,amount:200}]}},{dialogs:[]},catalog);
  assert.equal(model.orders[0].product,productId); assert.equal(model.ads[0].product,'unknown','ad title is never manual assignment');
  assert.equal(realRows(model,'product').find(r=>r.id===productId).orders.length,1);
  await createPosition(client,input,options); assert.equal(client.writes.length,1); assert.equal(state.tasks.length,1);
  await assert.rejects(createPosition(client,payload({template:template.id,name:template.name,unit:template.unit}),options),{code:'POSITION_ROUTE_INVALID'});
  assert.equal(client.writes.length,1,'stale product name rejected before any business write');
  const current=(await pilot.positionForm(client,{orderId:'16'})).templates.find(p=>p.id===template.id);
  assert.equal(current.name,catalog.products[0].name);
  await createPosition(client,payload({template:current.id,name:current.name,unit:current.unit}),options);
  assert.equal(state.items[1].productVersion,2); assert.equal(state.tasks[1].minutes,40);
  assert.equal(state.tasks[0].minutes,20);
});

test('custom configured position never borrows stages from a matching legacy name', async t => {
 const client=new Mock();const result=await createPosition(client,payload({template:'custom',name:'Уличная вывеска'}),context(t));assert.equal(result.routeStageCount,0);assert(client.writes.flat().every(update=>!update.range.startsWith("'Производство'")));
});
