import {randomUUID} from 'node:crypto';
import {shopifyObservationApi} from './shopify-observation-api.mjs';
import {connectTemuShops} from './temu-shop-clients.mjs';

const query=`query MissingOrders($after:String,$search:String!){orders(first:100,after:$after,query:$search,sortKey:CREATED_AT){nodes{id name createdAt cancelledAt displayFulfillmentStatus shippingAddress{countryCodeV2}} pageInfo{hasNextPage endCursor}}}`;
export async function missingFromV3(db,rows,start,end){
 const eligible=rows.filter(r=>Date.parse(r.date)>=Date.parse(start)&&Date.parse(r.date)<Date.parse(end));
 if(!eligible.length)return [];
 const refs=[...new Set(eligible.map(r=>r.reference))];
 const found=(await db.query(`SELECT channel,reference,source_reference FROM orders WHERE channel IN ('shopify','temu') AND (reference=ANY($1::text[]) OR source_reference=ANY($1::text[]))`,[refs])).rows;
 return eligible.filter(r=>!found.some(o=>o.channel===r.channel&&(o.reference===r.reference||o.source_reference===r.reference)));
}

// This service only reads source APIs and orders. Reports live in memory, never in the intake pipeline.
export function missingOrdersVerification(db,directory,{shopify=shopifyObservationApi(directory),connect=()=>connectTemuShops(directory),now=()=>Date.now()}={}){
 const runs=new Map();
 return async function({p,req,res,user,permitted,body,json}){
  if(p!=='/api/missing-orders/verify'||req.method!=='POST')return false;
  permitted(user,['admin','manager']);const b=await body(req);
  for(const [id,s] of runs)if(s.expires<now()&&!s.busy)runs.delete(id);
  if(!b.runId){
   const platform=b.platform??'all';if(!['shopify','temu','all'].includes(platform))throw Error('Plateforme invalide');
   const days=Number(b.days??60);if(!Number.isInteger(days)||days<2||days>60)throw Error('Période requise : 2 à 60 jours');
   const minimumAgeHours=Number(b.minimumAgeHours??24);if(!Number.isInteger(minimumAgeHours)||minimumAgeHours<24||minimumAgeHours>720)throw Error('Ancienneté requise : 24 à 720 heures');
   if(runs.size>=20)throw Error('Trop de vérifications en cours');
   const at=now(),end=b.beforeDate===undefined?at-minimumAgeHours*3600000:(typeof b.beforeDate==='string'?Date.parse(b.beforeDate):NaN);
   if(!Number.isFinite(end)||end>at-24*3600000||end<=at-days*86400000)throw Error('Date limite requise : au moins 24 h dans le passé et dans les '+days+' derniers jours');
   const start=b.startDate===undefined?at-days*86400000:(typeof b.startDate==='string'?Date.parse(b.startDate):NaN);
   if(!Number.isFinite(start)||start<at-days*86400000||start>=end)throw Error('Date de début requise : dans les '+days+' derniers jours et avant la date de fin');
   const id=randomUUID();runs.set(id,{owner:user.id,platform,minimumAgeHours:(at-end)/3600000,start:new Date(start).toISOString(),end:new Date(end).toISOString(),checkedAt:new Date(at).toISOString(),expires:at+3600000,phase:platform==='temu'?'connect-temu':'shopify',cursor:null,seen:new Set(),checked:0,rows:[],errors:[],sources:[],index:0});
   json(res,200,{runId:id,done:false});return true;
  }
  const s=runs.get(b.runId);if(!s||s.owner!==user.id)throw Error('Vérification expirée ou inaccessible');
  if(s.busy)throw Error('Lecture déjà en cours');s.busy=true;
  try{
   let rows=[];
   try{
    if(s.phase==='shopify'){
     const {data,shop}=await shopify.read(query,{after:s.cursor,search:`created_at:>='${s.start}' created_at:<'${s.end}'`});const page=data.orders;
     if(!Array.isArray(page?.nodes)||typeof page.pageInfo?.hasNextPage!=='boolean')throw Error('Pagination Shopify incomplète');
     rows=page.nodes.map(n=>{if(!n.id||!n.name||!Number.isFinite(Date.parse(n.createdAt)))throw Error('Identité ou date Shopify absente');return {channel:'shopify',shop,reference:n.name,date:n.createdAt,country:n.shippingAddress?.countryCodeV2||'',status:n.cancelledAt?'CANCELLED':n.displayFulfillmentStatus||''};});
     const next=page.pageInfo.hasNextPage?page.pageInfo.endCursor:null;
     if(page.pageInfo.hasNextPage&&(!next||s.seen.has(next)||!rows.length))throw Error('Pagination Shopify interrompue');
     if(next)s.seen.add(next);s.cursor=next;if(!next)s.phase=s.platform==='shopify'?'done':'connect-temu';
    }else if(s.phase==='connect-temu'){
     const connection=await connect();s.sources=[...connection.clients].map(([shop,api])=>({shop,api,country:connection.countryByMall.get(shop)||''}));
     for(const [country] of connection.connectionErrors)s.errors.push('TEMU '+country+' : connexion impossible');
     s.phase=s.sources.length?'temu':'done';s.cursor=1;s.seen.clear();
    }else if(s.phase==='temu'){
     const source=s.sources[s.index],page=await source.api.read('bg.order.list.v2.get',{pageNumber:s.cursor,pageSize:50,updateAtStart:Math.floor(Date.parse(s.start)/1000),updateAtEnd:Math.floor(Date.parse(s.checkedAt)/1000),sortby:'updateTime'});
     const total=Number(page.totalItemNum);
     if(!Array.isArray(page.pageItems)||!Number.isInteger(total)||total<0||page.pageItems.length>50||s.total!=null&&s.total!==total)throw Error('Pagination TEMU incomplète ou instable');s.total=total;
     rows=page.pageItems.map(item=>{const n=item.parentOrderMap,date=Number(n?.parentOrderTime)*1000;if(!n?.parentOrderSn||!Number.isFinite(date)||date<=0||s.seen.has(n.parentOrderSn))throw Error('Identité ou date TEMU invalide');s.seen.add(n.parentOrderSn);return {channel:'temu',shop:source.shop,reference:n.parentOrderSn,date:new Date(date).toISOString(),country:n.regionName1||source.country,status:String(n.parentOrderStatus??'')};});
     if(s.seen.size>total||s.cursor*50<total&&rows.length!==50||s.cursor*50>=total&&s.seen.size!==total)throw Error('Page TEMU manquante');
     if(s.cursor*50>=total){s.index++;s.cursor=1;s.seen.clear();s.total=null;if(s.index>=s.sources.length)s.phase='done';}else s.cursor++;
    }
   }catch(e){
    s.errors.push((s.phase==='shopify'?'Shopify':s.phase==='temu'?'TEMU boutique '+s.sources[s.index]?.shop:'TEMU')+' : lecture incomplète ('+String(e.code||'API indisponible')+')');
    rows=[];
    if(s.phase==='shopify')s.phase=s.platform==='shopify'?'done':'connect-temu';else if(s.phase==='temu'){s.index++;s.cursor=1;s.total=null;s.seen.clear();if(s.index>=s.sources.length)s.phase='done';}else s.phase='done';
   }
   s.rows.push(...await missingFromV3(db,rows,s.start,s.end));s.checked+=rows.length;s.expires=now()+3600000;
   // Recheck the report against V3 as concurrent imports may have completed during the scan.
   s.rows=await missingFromV3(db,s.rows,s.start,s.end);
   json(res,200,{runId:b.runId,minimumAgeHours:s.minimumAgeHours,done:s.phase==='done',complete:s.phase==='done'&&!s.errors.length,start:s.start,end:s.end,checkedAt:s.checkedAt,checked:s.checked,rows:s.rows,errors:s.errors});
  }finally{s.busy=false;}
  return true;
 };
}
