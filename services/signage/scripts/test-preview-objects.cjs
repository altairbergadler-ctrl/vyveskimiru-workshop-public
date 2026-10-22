'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
class Element{
  constructor(tag){this.tagName=tag;this.children=[];this.style={};this.attrs={};this.classList={toggle(){}};}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=children;}
  setAttribute(name,value){this.attrs[name]=String(value);}
  getAttribute(name){return this.attrs[name];}
  removeAttribute(name){delete this.attrs[name];}
  addEventListener(){}
  focus(){}
}
const window={SignageProducts:{activeProduct:project=>project.products?.[0]||{type:'channel_letters',params:project.sign},renderer:value=>typeof value==='string'?value:value.type}};
const document={createElement:tag=>new Element(tag),body:new Element('body')};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../assets/preview.js'),'utf8'),{window,document,Intl,console});
const preview=window.SignagePreview;
const png='data:image/png;base64,aGVsbG8=';
const objects=[
  {type:'text',text:'КОФЕ\nС СОБОЙ',font_family:'Missing Face',font_bold:true,letter_height_cm:12.5,depth_cm:4,front_color:'#fff3dc',side_color:'#292f30',artwork:{font_family_rendered:'Arial',font_fallback:true}},
  {type:'logo',width_cm:42,depth_cm:5,side_color:'#111111',artwork:{data_url:png}},
  {type:'text',text:'каждый день',font_family:'Georgia',font_bold:false,letter_height_cm:8,depth_cm:0,front_color:'#aabbcc',side_color:'#222222',artwork:{font_family_rendered:'Georgia',font_fallback:false}}
];
const stale={text:'LEGACY',depth_cm:999,front_color:'#ff0000',side_color:'#00ff00',face_material:{type:'film_on_acrylic',brand:'ORACAL',series:'641',color_code:'010',led_temperature_k:6500}};
const project={sign:stale,products:[{type:'channel_letters',params:{...stale,objects}}]};
const before=JSON.stringify(project);
const summary=preview.materialSummary(project,'night');
assert.match(summary,/объектов: 3/);
assert.match(summary,/Текст 1: строк 2; высота строки 12,5 см/);
assert.match(summary,/шрифт по ТЗ «Missing Face» Bold; шрифт PNG «Arial» \(браузерная замена\)/);
assert.match(summary,/Лого 1: ширина 42 см; исходный PNG; глубина по ТЗ 5 см/);
assert.match(summary,/Текст 2: строк 1; высота строки 8 см/);
assert.match(summary,/Объём, тени и свечение показаны условно/);
assert.match(summary,/температура LED не моделируются/);
assert.ok(!summary.includes('999')&&!summary.includes('6500')&&!summary.includes('641'),'Legacy global depth and material must not describe independent objects');
const colors=new Element('div');
preview.colorSwatches(colors,project.products[0].params,'channel_letters');
assert.equal(colors.children.length,6);
assert.deepEqual(colors.children.map(row=>row.children[1].textContent),[
  'Текст 1 · лицевая часть: #FFF3DC','Текст 1 · борта: #292F30',
  'Лого 1 · лицевая графика: исходный PNG','Лого 1 · борта: #111111',
  'Текст 2 · лицевая часть: #AABBCC','Текст 2 · борта: #222222'
]);
assert.equal(colors.children[2].children[0].style.backgroundImage,`url("${png}")`);
assert.equal(JSON.stringify(project),before,'Saved presentation must not mutate the project or original artwork');
const originalLegacySummary=preview.materialSummary({sign:stale},'night');
assert.match(originalLegacySummary,/серия 641/);
assert.match(originalLegacySummary,/LED 6500 K/);
preview.colorSwatches(colors,stale,'channel_letters');
assert.deepEqual(colors.children.map(row=>row.children[1].textContent),['Лицевая часть: #FF0000','Борта: #00FF00']);
const plaque={type:'plaque',params:{material:'pvc',thickness_mm:3,mounting:'tape',margin_mm:10,front_color:'#123456',background_color:'#ffffff'}};
assert.match(preview.materialSummary({products:[plaque]},'original'),/Табличка · ПВХ · толщина 3 мм/);
preview.colorSwatches(colors,plaque.params,'plaque');
assert.deepEqual(colors.children.map(row=>row.children[1].textContent),['Текст / оригинал: #123456','Основание: #FFFFFF']);
console.log('PASS: saved independent object counts, heights, fonts, raster fallback, per-object colors and original logo PNG; illustrative effects disclosure; legacy and plaque presentation preserved.');
