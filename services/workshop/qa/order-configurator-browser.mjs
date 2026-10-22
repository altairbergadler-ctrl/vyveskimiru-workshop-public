import {productionSheetFixtures} from './production-fixture.mjs';
import {shiftFormula} from '../server/sheets-guard.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {createDirectory,launch,removeDirectory,root} from './sandbox-lib.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const directory=createDirectory('order-configurator-'),out=path.join(root,'work/validation/order-configurator');fs.mkdirSync(out,{recursive:true});
let instance,browser;const errors=[];
try{
 const fixture=productionSheetFixtures();const rows=fixture['Позиции'];for(let i=0;i<12;i++)rows.push(rows.at(-1).map(v=>v?.formula?{formula:shiftFormula(v.formula,1),value:''}:''));fs.writeFileSync(path.join(directory,'sheet.json'),JSON.stringify(fixture));
 instance=await launch(directory,{production:true});browser=await chromium.launch({channel:'msedge',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addCookies([{name:'finance_session',value:instance.token,url:instance.base,httpOnly:true,sameSite:'Strict'}]);
 const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(instance.base+'/kanban/');
 const api=async(url,data)=>{const r=await context.request.fetch(instance.base+url,{method:data?'POST':'GET',headers:{Origin:instance.base},...(data?{data}: {})});const json=await r.json();assert(r.ok(),JSON.stringify(json));return json;};
 const before=await api('/api/production-pilot');const command={requestId:crypto.randomUUID(),revision:before.revision,type:'product.catalog.seed',data:{}};const seeded=await api('/api/production-pilot/command',command);assert.equal(seeded.products.filter(x=>x.orderFormKey).length,9);assert.equal(seeded.tasks.length,before.tasks.length);
 for(const old of before.products)assert.deepEqual(seeded.products.find(x=>x.id===old.id).versions,old.versions);
 const seedAgain=await api('/api/production-pilot/command',command);assert.equal(seedAgain.products.length,seeded.products.length);
 // A free product needs only its name and quantity. Exercise dimension
 // variants and restoration independently of the order's persisted rows.
 const productPage=await context.newPage();await productPage.goto(instance.base+'/kanban/');
 await productPage.evaluate(async()=>{
  const module=await import('./order-configurator.js');const host=document.createElement('section');host.id='custom-qa';document.body.prepend(host);
  window.customQA={host,module,config:module.mountOrderConfigurator(host)};
 });
 const customHost=productPage.locator('#custom-qa');await customHost.locator('[data-product=custom]').click();
 await customHost.locator('[data-field=name]').fill('Единичное нетиповое изделие');await customHost.locator('#add-item').click();
 const minimal=await productPage.evaluate(()=>window.customQA.config.positions());assert.equal(minimal.length,1);assert.equal(minimal[0].quantity,1);assert.equal(minimal[0].width,'');assert.equal(minimal[0].height,'');
 await customHost.locator('[data-edit="0"]').click();await customHost.locator('[data-field=description]').fill('Свободный текст\nОписание товара:\nШирина: 9000 мм');
 await customHost.locator('#add-variant').click();assert.equal(await customHost.locator('[data-v-key=steps]').count(),0);
 await customHost.locator('[data-v-key=w]').fill('500');await customHost.locator('[data-v-key=h]').fill('600');await customHost.locator('[data-v-key=depth]').fill('300');
 await customHost.locator('[data-field=name]').fill('Я'.repeat(300));await customHost.locator('#add-item').click();assert.match(await customHost.locator('#editor-error').innerText(),/300 символов/);
 const restoredTooLong=await productPage.evaluate(()=>{
  const {module,config}=window.customQA,state=config.state();state.items=[state.editor];state.editor=null;
  const restored=module.mountOrderConfigurator(document.createElement('div'),{initial:state,readOnly:true});
  try{restored.positions();return null;}catch(error){return{message:error.message,status:error.status};}
 });
 assert.equal(restoredTooLong.status,422);assert.match(restoredTooLong.message,/300 символов/);
 await customHost.locator('[data-field=name]').fill('Я'.repeat(288));
 await customHost.locator('#add-item').click();
 const variants=await productPage.evaluate(()=>window.customQA.config.positions());assert.equal(variants.length,2);assert.equal(variants[1].width,0.5);assert.equal(variants[1].height,0.6);
 assert.equal(variants[1].name.length,300);
 const roundtrip=await productPage.evaluate(positions=>positions.map(position=>window.customQA.module.positionConfiguration(position)),variants);
 for(const item of roundtrip)assert.equal(item.data.description,'Свободный текст\nОписание товара:\nШирина: 9000 мм');
 assert.equal(roundtrip[1].data.depth,'300');assert.deepEqual(roundtrip[1].extraLines,['Размерный вариант: 1']);
 await productPage.evaluate(()=>{
  const {host,module}=window.customQA;
  window.customQA.config=module.mountOrderConfigurator(host,{initial:{items:[],editor:{type:'rack',data:{qty:'2',steps:'3 ступени',depth:'500',width:'900',height:'700'},parts:[],variants:[],source:''},editingIndex:null,showCatalog:false,source:''}});
 });
 assert.equal(await customHost.locator('[data-choice=steps][aria-pressed=true]').innerText(),'3 ступени');assert.equal(await customHost.locator('[data-field=depth]').inputValue(),'500');
 await customHost.locator('#add-item').click();const legacy=await productPage.evaluate(()=>window.customQA.config.positions());assert.equal(legacy[0].name,'Стеллаж');assert.match(legacy[0].description,/Число ступеней: 3 ступени/);
 await productPage.close();
 await p.locator('#create-order').click();const dialog=p.locator('.record-dialog[open]');await dialog.locator('[name=title]').fill('Конфигуратор · учебный заказ');
 const contacts=(await api('/kanban/api/orders/new')).fields.find(f=>f.id==='client').contacts;assert(contacts.length);const contact=contacts.find(c=>c.phone)||contacts[0];await dialog.locator('.client-query').fill(contact.phone.replace(/\D/g,'').slice(-5)||contact.name);assert(await dialog.locator('.client-match').count());await dialog.locator('.client-match').filter({hasText:contact.name}).first().click();assert.match(await dialog.locator('.client-selected').innerText(),new RegExp(contact.name));
 await dialog.locator('[name=comment]').fill('Монтаж согласовать.\nНе сверлить лицевую панель.');
 assert.equal(await dialog.locator('[data-product=rack]').count(),0);
 await dialog.locator('[data-product=custom]').scrollIntoViewIfNeeded();
 await dialog.locator('.product-grid').screenshot({path:path.join(out,'catalog-free-position.png')});
 await dialog.locator('[data-product=custom]').screenshot({path:path.join(out,'free-position-card.png')});
 const customName='Декоративная панель <по эскизу>';
 const customDescription='МДФ, окраска по образцу.\nШирина: 9000 мм\nКоличество изделий: 99 шт\nОписание товара:\nОставить надписи как в эскизе.';
 const types=['letters','box','neon','print','plotter','banner','plaque','custom','logo'];
 for(const [i,type] of types.entries()){
  if(i)await p.locator('#add-more').click();await p.locator(`[data-product=${type}]`).click();
  await p.locator('[data-field=qty]').fill('2');await p.locator('[data-field=width]').fill('1200');
  if(type==='custom'){
   assert.equal(await p.locator('[data-choice=steps]').count(),0);
   await p.locator('#add-item').click();assert.equal(await p.locator('#editor-error').innerText(),'Укажите название товара.');
   await p.locator('[data-field=name]').fill('   ');await p.locator('#add-item').click();assert.equal(await p.locator('#editor-error').innerText(),'Укажите название товара.');
   await p.locator('[data-field=name]').fill(customName);await p.locator('[data-field=description]').fill(customDescription);await p.locator('[data-field=depth]').fill('400');
   for(const width of [1440,390,320]){
    await p.setViewportSize({width,height:1000});await p.locator('.editor-heading').scrollIntoViewIfNeeded();
    assert(await dialog.locator('.record-body').evaluate(e=>e.scrollWidth<=e.clientWidth));
    assert(await p.locator('.editor-heading img').evaluate(e=>e.complete&&e.naturalWidth>0));
    await p.screenshot({path:path.join(out,`free-position-editor-${width}.png`)});
   }
   await p.setViewportSize({width:1440,height:1000});
  }
  if(type==='box')await p.locator('[data-choice=kind][data-value="Световой короб"]').click();
  if(type==='letters'){
   assert.equal(await p.locator('[data-choice=frame][aria-pressed=true]').innerText(),'Нужен');assert.equal(await p.locator('[data-choice=backing][aria-pressed=true]').innerText(),'Нужна');
   await p.locator('[data-choice=face][data-value="Белый"]').click();await p.locator('[data-choice=faceFinish][data-value="Плёнка"]').click();await p.locator('[data-choice=film][data-value="Oracal 8500 · 041"]').click();
   await p.locator('[data-new-option=side]').click();await p.locator('#new-option-value').fill('Тестовый бордовый');await p.locator('[data-option-save]').click();await p.locator('.new-option-form').waitFor({state:'detached'});
   assert((await api('/kanban/api/configurator')).options.side.includes('Тестовый бордовый'));
  }
  await p.locator('#add-item').click();
 }
 assert.equal(await p.locator('.saved-item').count(),9);assert.match(await p.locator('#config-comment').innerText(),/Не сверлить/);
 for(const width of [1440,390,320]){await p.setViewportSize({width,height:1000});await p.locator('.saved-item').first().scrollIntoViewIfNeeded();await p.screenshot({path:path.join(out,`debug-${width}.png`)});const overflow=await dialog.locator('.record-body').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,nodes:[...el.querySelectorAll('*')].filter(n=>n.getBoundingClientRect().right>el.getBoundingClientRect().right).slice(0,8).map(n=>[n.tagName,n.className,n.getBoundingClientRect().width])}));assert(overflow.scroll<=overflow.width,JSON.stringify({width,...overflow}));assert(await dialog.locator('.record-header').evaluate(el=>el.getBoundingClientRect().top>=0));await p.screenshot({path:path.join(out,`summary-${width}.png`)});}
 // Lose the first position response after the server committed it: retry must
 // continue the saved request, not create another order or duplicate the row.
 let lost=false;await p.route('**/kanban/api/orders/*/positions',async route=>{if(!lost){lost=true;await route.fetch();await route.abort();}else await route.continue();});
 await dialog.locator('button[type=submit]').click();await dialog.locator('.record-error').waitFor();assert.match(await dialog.locator('.record-error').innerText(),/пока не подтверждено/);
 await dialog.locator('button[type=submit]').click();await dialog.waitFor({state:'detached',timeout:15000}).catch(async e=>{console.error(await dialog.locator('.record-error').innerText());throw e;});
 const board=await api('/kanban/api/board?fresh=1');const orders=board.orders.filter(o=>o.title==='Конфигуратор · учебный заказ');assert.equal(orders.length,1);assert.equal(orders[0].items.length,9);assert(orders[0].items.every(i=>i.description.includes('1200 мм')));

 // The persisted detail card uses the same full specification and editor.
 const orderId=orders[0].id;
 assert.equal(orders[0].items[7].name,customName);assert(orders[0].items[7].description.endsWith(customDescription));
 await p.locator('#order-dialog .position-edit-button').nth(7).click();
 assert.equal(await dialog.locator('[data-field=name]').inputValue(),customName);
 assert.equal(await dialog.locator('[data-field=description]').inputValue(),customDescription);
 assert.equal(await dialog.locator('[data-field=depth]').inputValue(),'400');
 assert.equal(await dialog.locator('[data-field=qty]').inputValue(),'2');
 const updatedCustomName='Панель с гравировкой',updatedCustomDescription=customDescription+'\nКромки обработать.';
 await dialog.locator('[data-field=name]').fill(updatedCustomName);await dialog.locator('[data-field=description]').fill(updatedCustomDescription);
 await dialog.locator('#add-item').click();await dialog.locator('button[type=submit]').click();await dialog.waitFor({state:'detached'});
 const customSaved=(await api('/kanban/api/board?fresh=1')).orders.find(o=>o.id===orderId).items[7];
 assert.equal(customSaved.name,updatedCustomName);assert(customSaved.description.endsWith(updatedCustomDescription));
 await p.locator('#order-dialog .position-edit-button').nth(7).click();
 assert.equal(await dialog.locator('[data-field=name]').inputValue(),updatedCustomName);
 assert.equal(await dialog.locator('[data-field=description]').inputValue(),updatedCustomDescription);
 await dialog.locator('#add-item').click();await dialog.locator('button[type=submit]').click();await dialog.waitFor({state:'detached'});
 assert.equal((await api('/kanban/api/board?fresh=1')).orders.find(o=>o.id===orderId).items[7].description,customSaved.description);
 assert.equal(await p.locator('#order-dialog .position-card').count(),9);
 assert.match(await p.locator('#order-dialog .position-card').first().innerText(),/Тестовый бордовый/);
 assert.match(await p.locator('#order-dialog .positions-panel').innerText(),/Не сверлить/);
 await p.locator('#order-dialog .position-edit-button').first().click();
 await dialog.locator('[data-field=width]').fill('1350');
 await dialog.locator('[data-choice=face][data-value="Красный"]').click();
 await dialog.locator('#add-item').click();
 await dialog.locator('[name=unitPrice]').fill('123');
 await dialog.locator('button[type=submit]').click();
 await dialog.waitFor({state:'detached'});
 let detail=(await api('/kanban/api/board?fresh=1')).orders.find(o=>o.id===orderId);
 assert.equal(detail.items.length,9);assert.equal(Number(detail.items[0].width),1.35);
 assert.match(detail.items[0].description,/Цвет лица: Красный/);
 assert.match(detail.items[0].description,/Тестовый бордовый/);
 assert.equal(Number(detail.items[0].edit.fields.find(f=>f.id==='unitPrice').value),123);
 // Reopening reconstructs current choices, dimensions, parts and unknown options.
 await p.locator('#order-dialog .position-edit-button').first().click();
 assert.equal(await dialog.locator('[data-field=width]').inputValue(),'1350');
 assert.equal(await dialog.locator('[data-choice=face][aria-pressed=true]').innerText(),'Красный');
 await dialog.locator('#add-item').click();await dialog.locator('button[type=submit]').click();await dialog.waitFor({state:'detached'});

 // External row changes invalidate its identity hash: block overwrite, preserve
 // draft, and require reopening the current row rather than guessing a match.
 await p.locator('#order-dialog .position-edit-button').first().click();
 await dialog.locator('[data-field=width]').fill('1400');await dialog.locator('#add-item').click();
 detail=(await api('/kanban/api/board?fresh=1')).orders.find(o=>o.id===orderId);
 const concurrent=await context.request.patch(instance.base+'/kanban/api/records/item',{headers:{Origin:instance.base},data:{record:detail.items[0].edit.record,changes:{width:1.5}}});assert(concurrent.ok(),await concurrent.text());
 await dialog.locator('button[type=submit]').click();await dialog.locator('.record-error').waitFor();
 assert.match(await dialog.locator('.record-error').innerText(),/изменились/);
 await dialog.getByRole('button',{name:'Обновить исходные данные',exact:true}).click();
 await dialog.locator('.record-error').getByText('Не удалось безопасно обновить запись.',{exact:true}).waitFor();
 assert.equal(await dialog.locator('[name=width]').inputValue(),'1.4');
 assert(await dialog.locator('button[type=submit]').isDisabled());
 await dialog.locator('.record-footer-actions').getByRole('button',{name:'Отмена',exact:true}).click();
 await dialog.getByRole('button',{name:'Не сохранять',exact:true}).click();await dialog.waitFor({state:'detached'});
 await p.locator('#order-dialog .position-edit-button').first().click();
 assert.equal(await dialog.locator('[data-field=width]').inputValue(),'1500');
 await dialog.locator('[data-field=width]').fill('1400');await dialog.locator('#add-item').click();
 await dialog.locator('button[type=submit]').click();await dialog.waitFor({state:'detached'});
 detail=(await api('/kanban/api/board?fresh=1')).orders.find(o=>o.id===orderId);assert.equal(Number(detail.items[0].width),1.4);
 await p.locator('#order-dialog .position-edit-button').nth(1).click();
 await dialog.locator('[data-choice=kind][data-value="Панель-кронштейн"]').click();
 await dialog.locator('#add-item').click();await dialog.locator('button[type=submit]').click();await dialog.waitFor({state:'detached'});
 detail=(await api('/kanban/api/board?fresh=1')).orders.find(o=>o.id===orderId);assert.equal(detail.items[1].name,'Панель-кронштейн');
 // A changed neighbouring row preserves identity; refresh retains our draft.
 await p.locator('#order-dialog .position-edit-button').first().click();
 await dialog.locator('[data-choice=face][data-value="Белый"]').click();await dialog.locator('#add-item').click();
 const neighbor=await context.request.patch(instance.base+'/kanban/api/records/item',{headers:{Origin:instance.base},data:{record:detail.items[1].edit.record,changes:{width:1.21}}});assert(neighbor.ok(),await neighbor.text());
 await dialog.locator('button[type=submit]').click();await dialog.locator('.record-error').waitFor();
 await dialog.getByRole('button',{name:'Обновить исходные данные',exact:true}).click();
 await dialog.locator('.record-error').getByText('Исходные данные обновлены. Черновик сохранён.',{exact:true}).waitFor();
 assert.equal(await dialog.locator('[data-choice=face][aria-pressed=true]').innerText(),'Белый');
 await dialog.locator('#add-item').click();await dialog.locator('button[type=submit]').click();await dialog.waitFor({state:'detached'});
 // Append multiple products to an existing order and lose one confirmed response.
 await p.locator('#order-dialog .position-add-button').click();
 await dialog.locator('[data-product]').first().waitFor();
 assert.equal(await dialog.locator('[data-product]').count(),9);
 for(const type of ['banner','logo']){
  if(type==='logo')await dialog.locator('#add-more').click();
  await dialog.locator(`[data-product=${type}]`).click();await dialog.locator('[data-field=qty]').fill('3');await dialog.locator('#add-item').click();
 }
 lost=false;await dialog.locator('button[type=submit]').click();await dialog.locator('.record-error').waitFor();
 assert.match(await dialog.locator('.record-error').innerText(),/без дублей/);
 // Closing/reopening restores pending batch and its stable request identifiers.
 await dialog.locator('.record-footer-actions').getByRole('button',{name:'Отмена',exact:true}).click();
 await dialog.waitFor({state:'detached'});
 await p.locator('#order-dialog .position-add-button').click();await dialog.locator('button[type=submit]').click();await dialog.waitFor({state:'detached'});
 detail=(await api('/kanban/api/board?fresh=1')).orders.find(o=>o.id===orderId);
 assert.equal(detail.items.length,11);assert.equal(detail.comment,'Монтаж согласовать.\nНе сверлить лицевую панель.');
 for(const width of [1440,390,320]){
  await p.setViewportSize({width,height:1000});
  const content=p.locator('#order-dialog .dialog-content');
  assert(await content.evaluate(e=>e.scrollWidth<=e.clientWidth),`detail overflow ${width}`);
  await p.locator('#order-dialog .position-card').first().scrollIntoViewIfNeeded();
  await p.screenshot({path:path.join(out,`detail-${width}.png`)});
 }
 await p.locator('#order-dialog').getByRole('tab',{name:'Обзор',exact:true}).click();
 for(const width of [1440,390]){
  await p.setViewportSize({width,height:1000});
  const content=p.locator('#order-dialog .dialog-content');await content.evaluate(e=>e.scrollTop=0);
  assert(await content.evaluate(e=>e.scrollWidth<=e.clientWidth));
  assert.equal(await p.locator('#order-dialog .position-card').count(),11);
  await p.screenshot({path:path.join(out,`overview-${width}.png`)});
 }

 // Persisted deletion is confirmed explicitly, retains prepared formulas and
 // resumes the same request after losing a successful HTTP response.
 const deletionBefore=JSON.parse(fs.readFileSync(path.join(directory,'sheet.json'),'utf8'));
 await p.locator('#order-dialog .position-delete-button').first().click();
 await dialog.locator('.record-title').filter({hasText:'Удалить позицию?'}).waitFor();
 assert.match(await dialog.innerText(),/Объёмные буквы/);
 await dialog.locator('.record-footer-actions').getByRole('button',{name:'Отмена',exact:true}).click();await dialog.waitFor({state:'detached'});
 assert.equal((await api('/kanban/api/board?fresh=1')).orders.find(o=>o.id===orderId).items.length,11);
 await p.locator('#order-dialog .position-delete-button').first().click();
 for(const width of [1440,390,320]){await p.setViewportSize({width,height:1000});assert(await dialog.locator('.record-body').evaluate(e=>e.scrollWidth<=e.clientWidth));await p.screenshot({path:path.join(out,`delete-confirm-${width}.png`)});}
 let deletionLost=false,deleteCalls=0,deleteRequest;
 await p.route('**/kanban/api/orders/*/positions',async route=>{
  if(route.request().method()==='DELETE'){
   deleteCalls++;deleteRequest=JSON.parse(route.request().postData());
   if(!deletionLost){deletionLost=true;const response=await route.fetch();assert.equal(response.status(),200,await response.text());await route.abort();return;}
  }
  await route.continue();
 });
 await dialog.locator('button[type=submit]').click();await dialog.locator('.record-error').waitFor();
 assert.match(await dialog.locator('.record-error').innerText(),/пока не подтверждено/);
 await dialog.locator('.record-footer-actions').getByRole('button',{name:'Отмена',exact:true}).click();await dialog.waitFor({state:'detached'});
 await p.reload();await p.locator('#board [data-order-id="'+orderId+'"]').click();
 await p.locator('#order-dialog .position-delete-retry').click();await dialog.locator('button[type=submit]').click();await dialog.waitFor({state:'detached'});
 detail=(await api('/kanban/api/board?fresh=1')).orders.find(o=>o.id===orderId);
 assert.equal(detail.items.length,10);assert.equal(deleteCalls,2);assert(!detail.items.some(i=>i.name==='Объёмные буквы'));
 const deletionAfter=JSON.parse(fs.readFileSync(path.join(directory,'sheet.json'),'utf8'));
 const deletedRow=deleteRequest.record.rowNumber-1;
 for(let r=0;r<deletionBefore['Позиции'].length;r++){
  if(r!==deletedRow)assert.deepEqual(deletionAfter['Позиции'][r],deletionBefore['Позиции'][r]);
  else for(let c=0;c<deletionBefore['Позиции'][r].length;c++){
   if([0,2,3,4,5,6,7,9,11].includes(c))assert.equal(deletionAfter['Позиции'][r][c],'');
   else assert.deepEqual(deletionAfter['Позиции'][r][c],deletionBefore['Позиции'][r][c]);
  }
 }
 for(const name of ['Заказы','Платежи','Расходы','Производство'])assert.deepEqual(deletionAfter[name],deletionBefore[name]);
 assert.equal(await p.locator('#order-dialog .position-delete-retry').count(),0);
 const after=await api('/api/production-pilot');assert.equal(after.tasks.length,before.tasks.length);

 // Removing the last item must not revive an old generated composition as
 // the current order summary; its historical text remains separately accessible.
 const creation=await api('/kanban/api/orders/new');const changes=Object.fromEntries(creation.fields.map(f=>[f.id,f.value??'']));
 changes.title='Учебное удаление последней позиции';changes.client=contact.name;changes.comment='ПРОДУКЦИЯ\n1. Баннер\nЛюверсы: По углам\n\nКОММЕНТАРИЙ К ЗАКАЗУ\nСогласовать время';
 const single=await api('/kanban/api/orders',{requestId:crypto.randomUUID(),changes});
 await api('/kanban/api/orders/'+single.createdOrderId+'/positions',{requestId:crypto.randomUUID(),position:{template:'custom',name:'Баннер',description:'Количество изделий: 1 шт',unit:'шт',quantity:1}});
 await p.reload();await p.locator('#board [data-order-id="'+single.createdOrderId+'"]').click();
 await p.locator('#order-dialog .position-delete-button').click();await dialog.locator('button[type=submit]').click();await dialog.waitFor({state:'detached'});
 assert.equal(await p.locator('#order-dialog .position-card').count(),0);
 assert.equal(await p.locator('#order-dialog .positions-panel .detail-section .note-box').innerText(),'Согласовать время');
 assert.equal(await p.locator('#order-dialog .original-composition').getAttribute('open'),null);
 assert.match(await p.locator('#order-dialog .original-composition').textContent(),/Люверсы: По углам/);
 // Exercise the unified production link guard, not only the legacy sheet guard.
 const routeOrder='9001',form=await api('/kanban/api/orders/'+routeOrder+'/positions/new');
 const routeTemplate=form.templates.find(t=>t.id.startsWith('route:')&&t.stages.length);assert(routeTemplate);
 const routed=await api('/kanban/api/orders/'+routeOrder+'/positions',{requestId:crypto.randomUUID(),position:{template:routeTemplate.id,name:routeTemplate.name,description:'Учебная позиция с маршрутом',unit:routeTemplate.unit,quantity:1}});
 const linkedItem=routed.orders.find(o=>o.id===routeOrder).items.find(i=>i.row===routed.createdPosition.itemRow);assert(linkedItem);
 const productionBeforeDelete=await api('/api/production-pilot');
 const linkedDelete=await context.request.delete(instance.base+'/kanban/api/orders/'+routeOrder+'/positions',{headers:{Origin:instance.base},data:{requestId:crypto.randomUUID(),record:linkedItem.edit.record}});
 assert.equal(linkedDelete.status(),409);assert.equal((await linkedDelete.json()).code,'POSITION_DELETE_PRODUCTION');
 assert.deepEqual((await api('/api/production-pilot')).tasks,productionBeforeDelete.tasks);
 const sheet=JSON.parse(fs.readFileSync(path.join(directory,'sheet.json'),'utf8'));fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,products:9,positions:orders[0].items.length,lostResponseRetried:lost,detailEditing:true,appendedPositions:2,resumedBatch:true,productionDeletionGuard:true,deletionConfirmed:true,deletionRetriedWithoutDuplicates:true,stageCountUnchanged:true,sheetNames:Object.keys(sheet),errors},null,2));assert.deepEqual(errors,[]);
 console.log('Configurator browser: 9 products, 9 initial positions, structured edit/reopen/type change, conflict guard, resumed append without duplicates, complete overview, desktop/mobile passed.');
}finally{await browser?.close();await instance?.stop();removeDirectory(directory);}
