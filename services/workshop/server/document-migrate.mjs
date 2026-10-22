import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleSheetsClient } from './sheets-client.mjs';
import { prepareDocumentSheets, readDocumentTables } from './document-sheets.mjs';
import { normalizeDocumentSeller, encodeDocumentSeller, decodeDocumentSellers } from '../modules/orders/server/documents.mjs';

export async function migrateDocuments(client,{apply=false,seed=[]}={}) {
  if(!Array.isArray(seed)||seed.length>1) throw new Error('DOCUMENT_SEED_INVALID');
  const initialRows={};
  if(seed.length) {
    const seller=normalizeDocumentSeller(seed[0],seed[0].id);
    const encoded=encodeDocumentSeller(seller);
    initialRows['Продавцы']=[encoded.seller];initialRows['Счета продавцов']=encoded.accounts;
  }
  const result=await prepareDocumentSheets(client,{apply,initialRows});
  return {ready:result.ready,created:result.created, ...(result.ready?{sellers:result.tables['Продавцы'].rows.length,accounts:result.tables['Счета продавцов'].rows.length,documents:result.tables['Документы заказов'].rows.length}:{missing:result.missing})};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const client=new GoogleSheetsClient({credentialsFile:process.env.GOOGLE_CREDENTIALS_FILE,spreadsheetId:process.env.GOOGLE_SPREADSHEET_ID});
  try {
    let seed=[];
    if(process.env.DOCUMENT_SELLER_SEED_FILE) seed=JSON.parse(await fs.readFile(process.env.DOCUMENT_SELLER_SEED_FILE,'utf8'));
    if(process.argv.includes('--check-pending')) {
      const loaded=await readDocumentTables(client);
      if(loaded.ready&&loaded.tables['Документы заказов'].rows.some(row=>row.values[8]!=='confirmed')) throw new Error('UNCONFIRMED_DOCUMENTS');
      console.log(JSON.stringify({documentGate:'clear',ready:loaded.ready}));
    } else {
      const result=await migrateDocuments(client,{apply:process.argv.includes('--apply'),seed});
      if(result.ready&&seed.length) {
        const loaded=await readDocumentTables(client);const sellers=decodeDocumentSellers(loaded.tables);
        if(!sellers.some(seller=>seller.id===seed[0].id&&seller.inn===seed[0].inn)) throw new Error('DOCUMENT_SEED_NOT_CONFIRMED');
      }
      console.log(JSON.stringify(result));
    }
  } catch(error) {console.error(JSON.stringify({code:error.code||(/^[A-Z_]+$/.test(error.message)?error.message:'DOCUMENT_MIGRATION_BLOCKED')}));process.exitCode=1;}
}
