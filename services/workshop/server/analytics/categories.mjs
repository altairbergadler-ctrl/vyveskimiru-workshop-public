// Shared reporting dimensions; these are not manufacturing products or routes.
export const categories = [
  {id:'category:signs',name:'Вывески и объёмные буквы',description:'Изготовление обычных, световых и несветовых вывесок, объёмных букв, рекламных конструкций. Неон выделен отдельно.'},
  {id:'category:neon',name:'Неоновые вывески и оформление',description:'Готовые неоновые вывески, фигуры, неоновые ёлки, оформление зданий и входных групп неоном. Продажа гибкого неона как материала относится к комплектующим.'},
  {id:'category:print',name:'Печать и полиграфия',description:'Баннеры, наклейки, плёнка, плакаты, таблички с печатью, штендеры. Сочетание этих товаров относится к одной категории.'},
  {id:'category:parts',name:'Комплектующие и материалы',description:'Продажа блоков питания, светодиодных модулей, провода, гибкого неона и других материалов для изготовления рекламы.'},
  {id:'category:ink',name:'Чернила и расходники для печати',description:'Чернила, картриджи, печатающие головки и расходники принтеров. Не услуги печати и не продажа самого принтера.'},
  {id:'category:equipment',name:'Оборудование',description:'Продажа принтеров, фрезерных станков и другого оборудования. По неясной модели без указания товара не угадывай.'},
  {id:'category:property',name:'Недвижимость и аренда',description:'Продажа или аренда складов, помещений и объектов свободного назначения.'},
  {id:'category:logistics',name:'Доставка и логистика',description:'Карго и доставка товаров, в том числе из Китая.'},
  {id:'category:hiring',name:'Вакансии',description:'Поиск работников и объявления о найме, например макетчик-монтажник.'},
].map(p=>({...p,unit:'категория',version:1}));

export function analyticsCatalog(production, mappings=null) {
  const aliases={};
  for(const p of production?.products||[]) {
    if(/неон/iu.test(p.name))aliases[p.id]='category:neon';
    else if(/вывеск|объ[её]мн.*букв/iu.test(p.name))aliases[p.id]='category:signs';
  }
  // Keep an unfamiliar legacy service available rather than losing manual choices.
  const retained=new Set([...(mappings||[]).map(m=>m.productId),...(production?.positions||[]).map(p=>p.productId)]);
  const legacy=(production?.products||[]).filter(p=>!aliases[p.id]&&(mappings===null||retained.has(p.id))).map(p=>({...p,automatic:false}));
  return {source:'analytics-categories',products:[...categories.map(p=>({...p})),...legacy],aliases,
    positions:(production?.positions||[]).map(p=>({...p,productId:aliases[p.productId]||p.productId}))};
}
export const categoryId = (catalog,id) => catalog?.aliases?.[id] || id;
