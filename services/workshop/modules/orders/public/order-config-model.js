const PRODUCTS=[
 {id:'letters',name:'Объёмные буквы',hint:'Лицо, борт, свет, подложка'},
 {id:'box',name:'Короб / кронштейн',hint:'Короб, панель или сменное лицо'},
 {id:'neon',name:'Неоновая вывеска',hint:'Свечение, длина, крепление'},
 {id:'print',name:'Печать и накатка',hint:'Холст, плёнка и жёсткие основания'},
 {id:'plotter',name:'Плоттерная резка',hint:'Плёнка, цвет и части макета'},
 {id:'banner',name:'Баннер',hint:'Размер, обрезка и люверсы'},
 {id:'plaque',name:'Табличка',hint:'Основание, толщина и размер'},
 {id:'custom',name:'Свободная позиция',hint:'Любой нетиповый товар'},
 {id:'logo',name:'Логотип',hint:'Части, цвета и оформление'}
];
// Historical rack specifications and local drafts remain editable, but new
// orders offer a general product instead of a rack-only category.
const LEGACY_PRODUCTS=[{id:'rack',name:'Стеллаж'}];
const product=id=>PRODUCTS.find(p=>p.id===id)||LEGACY_PRODUCTS.find(p=>p.id===id);
const unknown='Уточняется';
const colors=['Белый','Чёрный','Красный'];
const swatches={'Белый':'#fff','Чёрный':'#333','Красный':'#bb5546','Салатовый':'#b6cb74','Графит':'#61656a','Розовый':'#e9a3b7','Тёплый белый':'#f7e3b0','Нейтральный белый · 4000 K':'#f5f4ea'};
const choice=(key,label,opts,when)=>({key,label,opts:[...opts,unknown],when});
const number=(key,label,unit,when)=>({key,label,unit,type:'number',when});
const section=(title,fields)=>({title,fields});
const faceFields=[choice('face','Цвет лица',colors),choice('faceFinish','Оформление лица',['Плёнка','Без плёнки']),choice('film','Плёнка на лице',['Чёрная плёнка','Oracal 8500 · 041','Oracal 8500 · 063','Oracal 8500 · 034'],d=>d.faceFinish==='Плёнка'),choice('side','Цвет борта',['Белый','Чёрный','Салатовый']),number('sideDepth','Глубина борта','мм')];
const supportFields=[choice('frame','Каркас',['Нужен','Без каркаса']),choice('frameColor','Цвет каркаса',['Графит','Красный','Чёрный','В цвет фасада'],d=>d.frame==='Нужен'),choice('backing','Подложка',['Нужна','Без подложки']),choice('backMaterial','Материал подложки',['Чёрный композит'],d=>d.backing==='Нужна'),choice('backShape','Исполнение подложки',['Плоская','Кассета'],d=>d.backing==='Нужна')];
const lightFields=[choice('light','Подсветка',['8500 K','Без подсветки'])];
const schemas={
 letters:[section('Исполнение',[choice('composition','Состав',['Буквы','Буквы + логотип'])]),section('Лицо и борт',faceFields),section('Свет и основание',[...lightFields,...supportFields])],
 box:[section('Конструкция',[choice('kind','Что изготавливаем',['Световой короб','Панель-кронштейн','Сменное лицо']),choice('shape','Форма',['Прямоугольник','Круг']),number('diameter','Диаметр','мм',d=>d.shape==='Круг')]),section('Лицо и борт',faceFields),section('Свет',lightFields)],
 neon:[section('Свечение',[choice('glow','Цвет свечения',['Тёплый белый','Нейтральный белый · 4000 K','Розовый']),number('neonLength','Длина неона','м')]),section('Крепление',[choice('mount','Способ крепления',['На тросиках','К потолку на тросиках']),choice('holes','Отверстия',['Нужны','Не нужны']),choice('hooks','Крючки',['Нужны','Не нужны']),choice('wire','Вывод провода',['Не имеет значения','Слева','Справа','Снизу','Сверху'])])],
 print:[section('Изделие',[choice('kind','Вид печати',['Печать с накаткой','Холст на каркасе','Печать на прозрачной плёнке'])]),section('Материал',[choice('substrate','Основание',['ПВХ','Композит','Прозрачный поликарбонат'],d=>d.kind==='Печать с накаткой'),choice('thickness','Толщина',['3 мм','5 мм'],d=>d.kind==='Печать с накаткой'&&d.substrate==='ПВХ'),choice('polyThickness','Толщина поликарбоната',['6 мм'],d=>d.kind==='Печать с накаткой'&&d.substrate==='Прозрачный поликарбонат')])],
 plotter:[section('Плёнка',[choice('vinylColor','Цвет плёнки',['Белый','Чёрный']),choice('finish','Поверхность',['Матовая'])])],
 banner:[section('Обработка',[choice('trim','Обрезка',['По контуру']),choice('eyelets','Люверсы',['Без люверсов','По углам'])])],
 plaque:[section('Назначение',[choice('purpose','Вид таблички',['На дверь','Адресная'])]),section('Основание',[choice('substrate','Материал',['ПВХ','Композит']),choice('thickness','Толщина ПВХ',['3 мм','5 мм'],d=>d.substrate==='ПВХ')])],
 custom:[section('Товар',[{key:'name',label:'Название товара',type:'text',required:true,maxLength:300,placeholder:'Например, витрина или декоративная панель'},{key:'description',label:'Описание и характеристики',type:'textarea',maxLength:10000,placeholder:'Материалы, конструкция, цвет и требования к изделию'}])],
 rack:[section('Конструкция',[choice('steps','Число ступеней',['2 ступени','3 ступени'])])],
 logo:[section('Состав',[number('componentCount','Количество частей','шт'),choice('faceFinish','Оформление',['Плёнка','Без плёнки'])]),section('Исполнение',[choice('face','Цвет лица',colors),choice('light','Подсветка',['8500 K','Без подсветки'])])]
};

export { product, PRODUCTS, LEGACY_PRODUCTS, schemas, swatches, unknown };
