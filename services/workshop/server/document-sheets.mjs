import crypto from 'node:crypto';
import { a1, SheetsError } from './sheets-client.mjs';

// Optional business tables: absence disables documents, never finance/orders.
export const DOCUMENT_TABLES = [
  { name:'Продавцы', id:2026102101, capacity:201, headers:['ID','Короткое название','Наименование','ИНН','КПП','ОГРН / ОГРНИП','Адрес','Подписант','Должность','НДС','Активен','Ревизия','Обновлено','Источник'] },
  { name:'Счета продавцов', id:2026102102, capacity:1001, headers:['ID','ID продавца','Название','Банк','БИК','Расчётный счёт','Корреспондентский счёт','Активен','Ревизия','Обновлено'] },
  { name:'Документы заказов', id:2026102103, capacity:5001, headers:['ID','№ заказа','Тип','Номер','Дата','ID продавца','ID счёта','Версия','Статус','Снимок','SHA256 снимка','ID файла','SHA256 PDF','Создано','ID запроса','SHA256 запроса','Тестовый','Обновлено'] },
];
export const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const documentColumn = index => { let value=''; for(let n=index+1;n>0;n=Math.floor((n-1)/26)) value=String.fromCharCode(65+(n-1)%26)+value; return value; };
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const denied = () => { throw new SheetsError('SHEETS_CONTRACT_DOCUMENTS','Изменён контракт справочника документов. Запись остановлена.',409); };
const rowValues = (row,width) => Array.from({length:width},(_,i)=>row?.[i] ?? '');
const nonempty = row => row.some(value=>value!=='' && value!==null && value!==undefined);

export async function readDocumentTables(client) {
  const metadata = await client.getSpreadsheet();
  if (!DOCUMENT_TABLES.every(def=>metadata.sheets?.some(sheet=>sheet.properties.title===def.name))) return {ready:false,tables:{}};
  const ranges = DOCUMENT_TABLES.map(def=>a1(def.name,`A1:${documentColumn(def.headers.length-1)}${def.capacity}`));
  const result = client.getRanges ? await client.getRanges(ranges,{valueRenderOption:'UNFORMATTED_VALUE'}) : {valueRanges:await Promise.all(DOCUMENT_TABLES.map(def=>client.getValues(def.name,`A1:${documentColumn(def.headers.length-1)}${def.capacity}`,{valueRenderOption:'UNFORMATTED_VALUE'})))};
  const tables = {};
  for(const [index,def] of DOCUMENT_TABLES.entries()) {
    const values = result.valueRanges?.[index]?.values || [];
    const properties = metadata.sheets.find(sheet=>sheet.properties.title===def.name).properties;
    if(!same(values[0],def.headers) || properties.gridProperties?.rowCount<def.capacity || properties.gridProperties?.columnCount<def.headers.length) denied();
    const rows = values.slice(1).map((row,index)=>({row:index+2,values:rowValues(row,def.headers.length)})).filter(row=>nonempty(row.values));
    const ids = new Set();
    for(const row of rows) {
      if(typeof row.values[0]!=='string' || !/^[a-z0-9-]{16,80}$/i.test(row.values[0]) || ids.has(row.values[0])) denied();
      ids.add(row.values[0]);
      if(row.values.some(value=>!['string','boolean','number'].includes(typeof value) || typeof value==='number'&&!Number.isFinite(value))) denied();
    }
    tables[def.name] = {def,properties,rows};
  }
  return {ready:true,tables};
}

export function nextDocumentRow(table) {
  const used = new Set(table.rows.map(row=>row.row));
  for(let row=2;row<=table.def.capacity;row++) if(!used.has(row)) return row;
  throw new SheetsError('DOCUMENT_CAPACITY','Лист документов заполнен. Нужна архивация перед добавлением новых записей.',409);
}

export function documentWrite(table,row,values) {
  if(values.length!==table.def.headers.length) denied();
  return {range:a1(table.def.name,`A${row}:${documentColumn(values.length-1)}${row}`),values:[values]};
}

export function isDocumentSheetWrite(path,options={}) {
  if((options.method || 'GET')==='GET') return false;
  try { const body=JSON.parse(options.body || '{}'); return body.data?.some(entry=>DOCUMENT_TABLES.some(def=>typeof entry.range==='string'&&entry.range.startsWith(a1(def.name,'')))) || false; }
  catch { return false; }
}

export async function validateDocumentSheetWrite(path,options,request) {
  const body = JSON.parse(options.body || '{}');
  if(path!=='/values:batchUpdate' || body.valueInputOption!=='RAW' || !Array.isArray(body.data) || !body.data.length || body.data.length>50 || Object.keys(body).some(key=>!['valueInputOption','data'].includes(key))) denied();
  const rawClient = {
    getSpreadsheet:()=>request('?fields=sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))'),
    getRanges:(ranges)=>request('/values:batchGet?'+new URLSearchParams({valueRenderOption:'UNFORMATTED_VALUE',dateTimeRenderOption:'SERIAL_NUMBER'}).toString()+ranges.map(range=>'&ranges='+encodeURIComponent(range)).join('')),
  };
  const loaded = await readDocumentTables(rawClient);
  if(!loaded.ready) denied();
  const projected = structuredClone(loaded.tables);
  const targets = new Set();
  for(const write of body.data) {
    if(Object.keys(write).some(key=>!['range','values'].includes(key)) || !Array.isArray(write.values) || write.values.length!==1) denied();
    const table = Object.values(projected).find(table=>write.range?.startsWith(a1(table.def.name,'')));
    if(!table) denied();
    const suffix=write.range.slice(a1(table.def.name,'').length), match=suffix.match(/^A([2-9]|[1-9]\d+):([A-Z]+)([2-9]|[1-9]\d+)$/);
    if(!match || match[1]!==match[3] || Number(match[1])>table.def.capacity || match[2]!==documentColumn(table.def.headers.length-1)) denied();
    const row=Number(match[1]), values=write.values[0];
    if(values.length!==table.def.headers.length || values.some(value=>!['string','boolean','number'].includes(typeof value) || typeof value==='number'&&!Number.isFinite(value) || typeof value==='string'&&(value.length>45000||value.startsWith('=')||value.includes('\0')))) denied();
    if(targets.has(write.range)) denied(); targets.add(write.range);
    const old=table.rows.find(entry=>entry.row===row);
    if(old && old.values[0]!==values[0]) denied();
    if(table.def.name==='Документы заказов') {
      if(!['invoice','upd'].includes(values[2]) || !['prepared','confirmed'].includes(values[8]) || typeof values[7]!=='number' || !Number.isInteger(values[7]) || values[7]<1 || !/^[a-f0-9]{64}$/.test(values[10]) || digest(values[9])!==values[10] || !/^[a-f0-9]{64}$/.test(values[15])) denied();
      if(!old && (values[8]!=='prepared' || values[11]!=='' || values[12]!=='')) denied();
      if(old && values.some((value,index)=>![8,11,12,17].includes(index) && value!==old.values[index])) denied();
      if(old?.values[8]==='confirmed' && !same(old.values,values)) denied();
      if(values[8]==='confirmed' && (!/^[a-f0-9]{32}$/.test(values[11]) || !/^[a-f0-9]{64}$/.test(values[12]))) denied();
    }
    if(old) old.values=[...values]; else table.rows.push({row,values:[...values]});
  }
  for(const table of Object.values(projected)) {
    if(new Set(table.rows.map(row=>row.values[0])).size!==table.rows.length) denied();
  }
  const sellers=new Set(projected['Продавцы'].rows.map(row=>row.values[0]));
  const accounts=new Map(projected['Счета продавцов'].rows.map(row=>[row.values[0],row.values[1]]));
  if([...accounts.values()].some(seller=>!sellers.has(seller))) denied();
  const requests=new Set(); const versions=new Set();
  for(const {values:row} of projected['Документы заказов'].rows) {
    if(!sellers.has(row[5]) || accounts.get(row[6])!==row[5] || requests.has(row[14])) denied();
    requests.add(row[14]);
    const version=JSON.stringify([row[1],row[2],row[7]]); if(versions.has(version)) denied(); versions.add(version);
  }
}

export async function prepareDocumentSheets(client,{apply=false,initialRows={}}={}) {
  const metadata=await client.getSpreadsheet();
  const present=DOCUMENT_TABLES.filter(def=>metadata.sheets?.some(sheet=>sheet.properties.title===def.name));
  if(present.length && present.length!==DOCUMENT_TABLES.length) denied();
  if(present.length===DOCUMENT_TABLES.length) return {...await readDocumentTables(client),created:false};
  if(!apply) return {ready:false,created:false,missing:DOCUMENT_TABLES.map(def=>def.name)};
  if(DOCUMENT_TABLES.some(def=>metadata.sheets?.some(sheet=>sheet.properties.sheetId===def.id))) denied();
  if(Object.keys(initialRows).some(name=>!DOCUMENT_TABLES.some(def=>def.name===name))) denied();
  const cell=value=>({userEnteredValue:typeof value==='boolean'?{boolValue:value}:typeof value==='number'?{numberValue:value}:{stringValue:String(value)}});
  const requests=[];
  for(const def of DOCUMENT_TABLES) {
    requests.push({addSheet:{properties:{sheetId:def.id,title:def.name,gridProperties:{rowCount:def.capacity,columnCount:def.headers.length,frozenRowCount:1}}}});
    const rows=initialRows[def.name]||[];
    if(!Array.isArray(rows)||rows.length>=def.capacity||rows.some(row=>!Array.isArray(row)||row.length!==def.headers.length)) denied();
    requests.push({updateCells:{start:{sheetId:def.id,rowIndex:0,columnIndex:0},rows:[def.headers,...rows].map(row=>({values:row.map(cell)})),fields:'userEnteredValue'}});
    requests.push({addProtectedRange:{protectedRange:{range:{sheetId:def.id},description:'Справочник документов Мастерской. Изменяйте через приложение.',warningOnly:true}}});
  }
  // New tabs, headers and the explicitly approved private seed are one atomic request.
  await client.batchUpdate(requests);
  const loaded=await readDocumentTables(client);
  if(!loaded.ready) denied();
  for(const [name,rows] of Object.entries(initialRows)) if(!same(loaded.tables[name].rows.map(row=>row.values),rows)) denied();
  return {...loaded,created:true};
}
