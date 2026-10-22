import fs from 'node:fs';
import path from 'node:path';
import { AvitoAnalytics } from '../server/analytics/avito.mjs';
import { AvitoDeepAnalytics } from '../server/analytics/avito-deep.mjs';
import { AVITO_METRICS, parseAvitoReport, validateAvitoReport } from '../server/avito.mjs';
export function advertisingFixture(directory, initialNow=Date.now()){
  fs.mkdirSync(directory,{recursive:true});let clock=initialNow,revision=0,fail=null;
  const stamp=()=>new Date(clock).toISOString();
  const items=()=>[{id:'5678',title:revision?'Вымышленная вывеска · новый заголовок':'Вымышленная вывеска',status:'active',price:revision?2000:1000,category:{id:'1',name:'Вымышленная категория'},url:'https://www.avito.ru/fictional_5678'},
    {id:'5679',title:'=Вымышленный стенд',status:'old',price:null,category:null,url:null}];
  const client={status:()=>({enabled:true,configured:true,accountId:'1234',capabilities:{}}),
    listings:async()=>({items:items(),page:1,nextPage:null,complete:true,loadedAt:stamp()}),
    statistics:async(input)=>{
      if(fail)throw fail;
      const request=validateAvitoReport(input,clock,270),days=(Date.parse(input.dateTo)-Date.parse(input.dateFrom))/86400000+1,previous=input.dateTo<stamp().slice(0,8)+'01';
      const metrics=(index,n)=>Object.entries({...Object.fromEntries(Object.keys(AVITO_METRICS).map(k=>[k,0])),impressions:(index?50:100)*n,views:(index?3:10)*n,contacts:(index?0:2)*n,spending:(index?200:previous?500:1000)*n,promoSpending:(index?0:200)*n,presenceSpending:(index?200:800)*n}).map(([slug,value])=>({slug,value}));
      const groupings=input.grouping==='item'?items().map((item,i)=>({id:Number(item.id),type:'items',metrics:metrics(i,days)})):
        Array.from({length:days},(_,i)=>({id:Date.parse(input.dateFrom)/1000+i*86400,type:'dates',metrics:metrics(0,1).map(m=>({slug:m.slug,value:m.value+(metrics(1,1).find(v=>v.slug===m.slug)?.value||0)}))}));
      return {...parseAvitoReport({result:{timestamp:stamp(),dataTotalCount:groupings.length,groupings}},request,stamp()),accountId:'1234'};
    },
    detail:async(kind,p)=>{
      const days=p.dateFrom?Array.from({length:(Date.parse(p.dateTo)-Date.parse(p.dateFrom))/86400000+1},(_,i)=>new Date(Date.parse(p.dateFrom)+i*86400000).toISOString().slice(0,10)):[];
      const base={loadedAt:stamp(),accountId:'1234'};
      if(kind==='info')return {...base,id:p.itemId,status:'active',startTime:'2026-08-01T00:00:00Z',finishTime:null,vas:[],vasExplicit:true};
      if(kind==='services')return {...base,items:p.itemIds.map(id=>({id,services:id==='5678'?[{name:'Вымышленное продвижение',slug:'fictional',startDate:'2026-09-01T00:00:00Z',endDate:'2026-09-15T00:00:00Z'}]:[],servicesExplicit:true})),missingIds:[],errors:[]};
      if(kind==='traffic')return {...base,items:p.itemIds.map(id=>({id,days:days.map(date=>({date,views:id==='5678'?10:3,contacts:id==='5678'?2:0,favorites:0}))})),missingIds:[]};
      return {...base,items:p.itemIds.map(id=>({id,employeeId:0,days:days.map(date=>({date,calls:4,answered:3,new:2,newAnswered:1}))}))};
    }};
  const base=new AvitoAnalytics({client,directory,now:()=>clock,automatic:false});
  const deep=new AvitoDeepAnalytics({base,client,now:()=>clock,automatic:false,scheduler:false});
  return {client,base,deep,advance:ms=>{clock+=ms;},change:()=>{revision++;},setFailure:e=>{fail=e;},directory,close:async()=>{await deep.close();base.close();},
    drain:async()=>{for(let i=0;i<300;i++){const row=deep.db().prepare("SELECT count(*) AS n FROM ad_steps WHERE state='queued'").get();if(!row.n)return;await deep.work();clock+=1000;}throw new Error('FIXTURE_QUEUE_NOT_DRAINED');}};
}
export async function seedAdvertising(directory){
  const f=advertisingFixture(path.join(directory,'data'));try{const p=f.base.currentPeriod();f.deep.start(p);await f.drain();f.advance(60000);f.change();f.deep.start(p);await f.drain();return p;}finally{await f.close();}
}
