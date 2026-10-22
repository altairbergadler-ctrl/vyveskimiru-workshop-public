import path from 'node:path';
import fs from 'node:fs';
import { AvitoAnalytics } from '../server/analytics/avito.mjs';
import { InquiryImport } from '../server/analytics/inquiry-import.mjs';
export const inquiryChat = (overrides = {}) => ({id:'fictional-chat',itemId:'5678',itemTitle:'Учебная вывеска',createdAt:'2026-09-05T10:00:00.000Z',updatedAt:'2026-09-06T10:00:00.000Z',users:[{id:'2345',name:'Вымышленная мастерская Луна'}],lastMessageId:'fictional-message',...overrides});
export const inquiryMessage = (overrides = {}) => ({id:'fictional-message',createdAt:'2026-09-05T10:00:00.000Z',direction:'in',type:'text',text:'Нужна учебная вывеска. luna@example.invalid, +7 (999) 000-00-01',...overrides});
export function inquiryFixture(directory, initialNow=Date.parse('2026-09-09T10:00:00Z')) {
  fs.mkdirSync(directory,{recursive:true});
  let clock=initialNow,calls=0,fail=null,chat=inquiryChat();
  const client={status:()=>({enabled:true,configured:true,accountId:'1234'}),conversations:async()=>({accountId:'1234',chats:[chat],received:1,excluded:0,hasMore:false}),conversationMessages:async()=>{calls++;if(fail)throw fail;return{messages:[inquiryMessage()],hasMore:false};}};
  const base=new AvitoAnalytics({client,directory,automatic:false,now:()=>clock});
  const importer=new InquiryImport({base,client,scheduler:false,automatic:false,now:()=>clock});
  return {base,client,importer,calls:()=>calls,advance:(ms)=>{clock+=ms;},change:()=>{chat={...chat,updatedAt:new Date(clock).toISOString(),lastMessageId:'fictional-message-v2'};},setFailure:e=>{fail=e;},now:()=>clock,drain:async()=>{for(let i=0;i<30;i++){await importer.work();clock+=2000;if(!importer.view().jobs.some(r=>['queued','running'].includes(r.state)))return;}throw new Error('INQUIRY_FIXTURE_PENDING');},close:async()=>{await importer.close();base.close();}};
}
export async function seedInquiries(directory) {
  const f=inquiryFixture(path.join(directory,'data'),Date.now()-120000);try{f.importer.start();await f.drain();}finally{await f.close();}
}
