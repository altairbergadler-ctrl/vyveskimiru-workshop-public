import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createDirectory,launch,removeDirectory,root } from './sandbox-lib.mjs';
import { seedAdvertising } from './advertising-fixture.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const directory=createDirectory('advertising-browser-'),out=path.join(root,'work/validation/advertising');fs.mkdirSync(out,{recursive:true});
let browser,instance;const errors=[],checks=[];
try{
  await seedAdvertising(directory);instance=await launch(directory,{avito:true});
  const before=fs.readFileSync(path.join(directory,'sheet.json'),'utf8');
  browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  await context.addCookies([{name:'finance_session',value:instance.token,url:instance.base,httpOnly:true,sameSite:'Strict'}]);
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(instance.base+'/#analytics');
  await page.getByRole('navigation',{name:'Разделы аналитики'}).getByRole('button',{name:'Источники',exact:true}).click();
  const panel=page.getByRole('region',{name:'Эффективность Авито'});await panel.getByRole('button',{name:'Вымышленная вывеска · новый заголовок',exact:true}).waitFor();
  for(const viewport of [{width:1440,height:1000},{width:384,height:832}]){
    await page.setViewportSize(viewport);
    for(const [key,label]of [['items','Объявления'],['daily','Динамика по дням'],['changes','Изменения'],['journal','Журнал загрузок'],['quality','Полнота данных']]){
      await panel.getByRole('navigation',{name:'Рекламные отчёты'}).getByRole('button',{name:label,exact:true}).click();
      await panel.evaluate(el=>window.scrollTo(0,window.scrollY+el.getBoundingClientRect().top-80));
      if(!(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))){await page.screenshot({path:path.join(out,'overflow.png')});console.log(JSON.stringify(await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth,elements:[...document.querySelectorAll('section,main,nav,form,table,div')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).map(e=>({tag:e.tagName,cls:e.className,w:e.getBoundingClientRect().width})).slice(0,25)}))));throw new Error(key+' overflow');}
      await page.screenshot({path:path.join(out,`${key}-${viewport.width}.png`)});checks.push(`${key} ${viewport.width}px`);
    }
  }
  await panel.getByRole('button',{name:'Объявления',exact:true}).click();
  await panel.getByLabel('Сигналы эффективности').selectOption('spend_no_contacts');
  assert.equal(await panel.locator('.ad-item-link').count(),1);
  assert.equal(await panel.locator('.ad-item-link').innerText(),'=Вымышленный стенд');
  const dl=page.waitForEvent('download');await panel.getByRole('button',{name:/CSV выбранных строк/}).click();const csvfile=path.join(out,'fictional-items.csv');await(await dl).saveAs(csvfile);const csv=fs.readFileSync(csvfile,'utf8');assert.ok(csv.includes("'=Вымышленный стенд"));assert.ok(csv.includes('Остальные расходы, RUB'));
  await panel.getByLabel('Сигналы эффективности').selectOption('all');
  await panel.getByRole('button',{name:'Вымышленная вывеска · новый заголовок',exact:true}).click();
  await panel.getByRole('heading',{name:'Все показатели объявления',exact:true}).waitFor();
  await panel.locator('.ad-timeline li').first().waitFor();assert.ok((await panel.locator('.ad-timeline').innerText()).includes('Цена: 1'));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await panel.getByLabel('Что изменилось в объявлении').fill('Вымышленная проверка главного фото');
  const response=page.waitForResponse(r=>r.url().endsWith('/api/analytics/avito/deep/notes')&&r.request().method()==='POST');
  await panel.getByRole('button',{name:'Сохранить отметку',exact:true}).click();assert.equal((await response).status(),200);
  await panel.getByText('Вымышленная проверка главного фото',{exact:true}).waitFor();
  await panel.getByRole('heading',{name:'Каждая проверка и изменения',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(out,'item-history-384.png')});
  checks.push('filters, formula-safe full-metric CSV, item detail, old/new values, manual note');
  // New invalid period cannot keep the previous aggregate/table under new dates.
  await panel.getByLabel('Реклама: начало периода').fill('2025-01-01');await panel.getByRole('button',{name:'Показать детализацию',exact:true}).click();
  await panel.getByRole('alert').waitFor();assert.equal(await panel.locator('.ad-kpis').count(),0);
  assert.equal(fs.readFileSync(path.join(directory,'sheet.json'),'utf8'),before);assert.deepEqual(errors,[]);
  const result={ok:true,checks,noSheetWrites:true,errors};fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser?.close();await instance?.stop();removeDirectory(directory);}
