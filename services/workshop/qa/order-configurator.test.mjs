import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {productionFixture} from './production-fixture.mjs';
import {applyProductionCommand,addProductionItem} from '../server/production-workflow.mjs';
import {encodeProduction,decodeProduction} from '../server/production-sheet.mjs';
import {matchesClient} from '../modules/orders/public/client-search.js';
import {positionConfiguration} from '../modules/orders/public/order-configurator.js';
import {PRODUCTS} from '../modules/orders/public/order-config-model.js';
const owner={id:'owner',role:'owner'};

test('free products restore arbitrary names and multiline prose without interpreting its labels; old racks remain editable',()=>{
 assert.equal(PRODUCTS.some(p=>p.id==='rack'),false);
 assert.equal(PRODUCTS.find(p=>p.id==='custom').name,'Свободная позиция');
 const prose='Панель <по эскизу>\nКоличество изделий: 99 шт\nШирина: 9000 мм\nТип продукции: Баннер\nОписание товара:\nОставить эти строки без изменений';
 const value=positionConfiguration({name:'Витрина из дерева',unit:'шт',width:'',height:'',quantity:2,description:'Тип продукции: Свободная позиция\nГлубина: 400 мм\nКоличество изделий: 2 шт\nОписание товара:\n'+prose});
 assert.equal(value.type,'custom');assert.equal(value.data.name,'Витрина из дерева');
 assert.equal(value.data.description,prose);assert.equal(value.data.qty,'2');assert.equal(value.data.width,'');assert.equal(value.data.depth,'400');assert.deepEqual(value.extraLines,[]);
 assert.equal(positionConfiguration({name:'Товар',unit:'шт',quantity:2,description:'Тип продукции: Свободная позиция\nОписание товара:\nКоличество изделий: 99 шт'}),null);
 const rack=positionConfiguration({name:'Стеллаж',unit:'шт',quantity:1,description:'Тип продукции: Стеллаж\nЧисло ступеней: 3 ступени\nГлубина: 500 мм\nКоличество изделий: 1 шт'});
 assert.equal(rack.type,'rack');assert.equal(rack.data.steps,'3 ступени');assert.equal(rack.data.depth,'500');
});
test('persisted specifications restore explicit options and keep unknown lines without guessing legacy prose',()=>{
 const position={name:'Объёмные буквы',unit:'шт',width:1.35,height:'',quantity:4,description:'Цвет лица: Красный\nЦвет борта: Особый цвет\nКоличество изделий: 2 шт\nШирина: 1200 мм\nЧасть 1 · название: Лого\nЧасть 1 · плёнка: Oracal 8500 · 034\nПримечание: не сверлить\nЦвет лица: Белый'};
 const value=positionConfiguration(position);
 assert.equal(value.data.face,'Красный');assert.equal(value.data.side,'Особый цвет');
 assert.equal(value.data.width,'1350');assert.equal(value.data.qty,'4');
 assert.deepEqual(value.parts,[{label:'Лого',film:'Oracal 8500 · 034'}]);
 assert.deepEqual(value.extraLines,['Примечание: не сверлить','Цвет лица: Белый']);
 assert.equal(positionConfiguration({...position,description:'Буквы красные, остальное уточнить'}),null);
 assert.equal(positionConfiguration({...position,unit:'м²'}),null);
 assert.equal(positionConfiguration({...position,name:'Неизвестный продукт'}),null);
 assert.equal(positionConfiguration({...position,name:'Световой короб · вариант 1'}).type,'box');
 assert.equal(positionConfiguration({...position,name:'Печать с накаткой на ПВХ'}).type,'print');
 assert.equal(positionConfiguration({...position,name:'Особый короб',description:'Тип продукции: Короб / кронштейн\nЧто изготавливаем: Особый короб\nКоличество изделий: 4 шт'}).type,'box');
});
const command=(state,type,data={},actor=owner)=>applyProductionCommand(state,actor,{type,data,revision:state.revision,requestId:crypto.randomUUID()}).state;
test('order catalog seeds nine types without changing existing routes or producing tasks; reseeding and Google roundtrip preserve it',()=>{
 const before=productionFixture(),state=command(before,'product.catalog.seed');
 assert.equal(state.products.filter(p=>p.orderFormKey).length,9);assert.deepEqual(state.tasks,before.tasks);
 for(const old of before.products)assert.deepEqual(state.products.find(p=>p.id===old.id).versions,old.versions);
 const again=command(state,'product.catalog.seed');assert.equal(again.products.length,state.products.length);
 const decoded=decodeProduction(encodeProduction(again));assert.equal(decoded.products.filter(p=>p.orderFormKey).length,9);
 const draft=state.products.find(p=>p.orderFormKey==='banner');assert.equal(draft.versions[0].stages.length,0);assert.throws(()=>addProductionItem(state,{orderId:state.orders[0].id,productId:draft.id,quantity:1},new Date()));
});
test('shared option creation validates scope, rejects control characters, deduplicates and persists in Google encoding',()=>{
 let state=command(productionFixture(),'product.option.add',{scope:'face',value:'Бордовый'});
 state=command(state,'product.option.add',{scope:'face',value:'  БОРДОВЫЙ  '});assert.deepEqual(state.orderOptions.face,['Бордовый']);
 assert.deepEqual(decodeProduction(encodeProduction(state)).orderOptions.face,['Бордовый']);
 for(const data of [{scope:'__proto__',value:'x'},{scope:'face',value:'x\nY'},{scope:'face',value:' '}])assert.throws(()=>command(state,'product.option.add',data));
 assert.throws(()=>command(state,'product.catalog.seed',{}, {id:'worker',role:'master'}));
 assert.throws(()=>command(state,'product.option.add',{scope:'face',value:'x'}, {id:'worker',role:'master'}));
});
test('client search matches name tokens, contact names, formatted phones and 7/8 prefixes',()=>{
 const client={name:'Ромашка Ёлка',contact:'Анна',phone:'+7 (000) 123-45-67'};
 for(const q of ['елка ром','АННА','1234567','8 000 123 45 67','+7 (000) 123-45-67','ром 4567'])assert(matchesClient(client,q));
 for(const q of ['7911','ром дуб','пётр'])assert(!matchesClient(client,q));
});
