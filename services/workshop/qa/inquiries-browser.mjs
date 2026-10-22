import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createDirectory,launch,removeDirectory,root} from './sandbox-lib.mjs';
import {seedInquiries} from './inquiry-fixture.mjs';
const require=createRequire(import.meta.url),{chromium}=require('C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const directory=createDirectory('inquiries-browser-'),out=path.join(root,'work/validation/inquiries');fs.mkdirSync(out,{recursive:true});let browser,instance;const errors=[],checks=[];
try{
 await seedInquiries(directory);instance=await launch(directory,{avito:true});const before=fs.readFileSync(path.join(directory,'sheet.json'),'utf8');
 browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});await context.addCookies([{name:'finance_session',value:instance.token,url:instance.base,httpOnly:true,sameSite:'Strict'}]);const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(instance.base+'/#analytics');
 await page.getByRole('navigation',{name:'Разделы аналитики'}).getByRole('button',{name:'Обращения и заказы',exact:true}).click();const panel=page.getByRole('region',{name:'Связи обращений с заказами'});await panel.locator('.im-kpis').waitFor();
 for(const viewport of [{width:1440,height:1000},{width:384,height:832}]){
   await page.setViewportSize(viewport);
   for(const [key,label]of [['orders','Заказы и кандидаты'],['dialogs','Диалоги Авито'],['advertising','По объявлениям'],['quality','Основания и полнота']]){
     await panel.getByRole('navigation',{name:'Сопоставление обращений'}).getByRole('button',{name:label,exact:true}).click();await panel.evaluate(el=>window.scrollTo(0,window.scrollY+el.getBoundingClientRect().top-70));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),key+' overflow');await page.screenshot({path:path.join(out,key+'-'+viewport.width+'.png')});checks.push(key+' '+viewport.width);
   }
 }
 await panel.getByRole('button',{name:'Заказы и кандидаты',exact:true}).click();await panel.getByLabel('Поиск связей заказов').fill('9001');
 await panel.locator('tbody button').first().click();await panel.getByRole('region',{name:'Кандидаты выбранного заказа'}).waitFor();assert.ok((await panel.innerText()).includes('Email клиента совпал'));assert.ok((await panel.innerText()).includes('не подтверждено'));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(out,'evidence-384.png')});
 const dl=page.waitForEvent('download');await panel.getByRole('button',{name:/CSV/}).click();const file=path.join(out,'fictional-links.csv');await(await dl).saveAs(file);const csv=fs.readFileSync(file,'utf8');assert.ok(csv.includes('9001'));assert.ok(!csv.includes('9002'));assert.ok(csv.includes('Подтверждено'));assert.ok(!csv.includes('luna@example.invalid'));checks.push('evidence, filtered CSV, privacy, order link');
 await panel.getByLabel('Уровень предварительных связей').selectOption('strong');await page.waitForResponse(r=>r.url().includes('/api/analytics/inquiries?')&&r.url().includes('mode=strong'));await panel.locator('.im-kpis').waitFor();
 assert.equal(fs.readFileSync(path.join(directory,'sheet.json'),'utf8'),before);assert.deepEqual(errors,[]);const result={ok:true,checks,noSheetWrites:true,errors};fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser?.close();await instance?.stop();removeDirectory(directory);}
