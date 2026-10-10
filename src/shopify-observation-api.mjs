import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {apiSlot} from './api-budget.mjs';

// Independent reader: never import the marketplace ingestion or fulfillment writers.
export function shopifyObservationApi(directory,{fetchImpl=fetch,slot=apiSlot}={}){
 let config,token;
 async function read(query,variables={}){
  if(!/^query\s/.test(query)||/\bmutation\b/i.test(query))throw Error('Lecture Shopify uniquement');
  config??=JSON.parse((await readFile(path.join(directory,'shopify-readonly.json'),'utf8')).replace(/^\uFEFF/,''));
  const shop=String(config.SHOPIFY_STORE_DOMAIN||'').trim().toLowerCase();
  if(!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop))throw Error('Shopify : boutique non configurée');
  token??=config.SHOPIFY_ACCESS_TOKEN;
  await slot('shopify:'+shop,500);
  if(!token){
   if(!config.SHOPIFY_CLIENT_ID||!config.SHOPIFY_CLIENT_SECRET)throw Error('Shopify : accès absent');
   const r=await fetchImpl(`https://${shop}/admin/oauth/access_token`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'client_credentials',client_id:config.SHOPIFY_CLIENT_ID,client_secret:config.SHOPIFY_CLIENT_SECRET})});
   if(!r.ok)throw Error('Shopify : authentification refusée');token=(await r.json()).access_token;
   if(!token)throw Error('Shopify : jeton absent');
  }
  const r=await fetchImpl(`https://${shop}/admin/api/2026-04/graphql.json`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token},body:JSON.stringify({query,variables})});
  if(!r.ok){if(r.status===401)token=null;throw Error('Shopify : lecture HTTP '+r.status);}
  const j=await r.json();if(j.errors?.length||!j.data)throw Error('Shopify : lecture incomplète (droits, schéma ou quota)');
  return {data:j.data,shop};
 }
 return {read};
}

export const observationQuery=`query LectureShopify($after:String,$search:String!){orders(first:50,after:$after,query:$search,sortKey:CREATED_AT){pageInfo{hasNextPage endCursor} nodes{id name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus fulfillments{ id status displayStatus trackingInfo{number company} }}}}`;
export function observationRow(n,shop,start,end){
 if(!n?.id||!n.name||!Number.isFinite(Date.parse(n.createdAt)))throw Error('Shopify : identité/date de commande absente');
 if(Date.parse(n.createdAt)<Date.parse(start)||Date.parse(n.createdAt)>Date.parse(end))throw Error('Shopify : commande hors période reçue');
 if(!Array.isArray(n.fulfillments))throw Error('Shopify : expéditions non reçues');
 return {id:n.id,reference:n.name,shop,date:n.createdAt,cancelled:!!n.cancelledAt,financialStatus:n.displayFinancialStatus||'UNKNOWN',status:n.displayFulfillmentStatus||'UNKNOWN',parcels:n.fulfillments.map(f=>({id:f.id,status:f.displayStatus||f.status||'UNKNOWN',tracking:(f.trackingInfo||[]).map(t=>({number:t.number||'',company:t.company||''}))}))};
}

export function observedProcess(orders){
 if(!orders.length)return 'Absente de V3';
 if(orders.length>1)return 'Plusieurs fiches V3 · À vérifier';
 const o=orders[0],s=o.source_payload||{},e=o.erp_live||{};
 if(s.erplainImported||s.selectedReimport?.mode==='hold'||e.phase==='historical_review')return 'Récupérée sans processus normal';
 if(s.selectedReimport?.mode==='resume')return 'Reprise via le processus V3';
 if(o.linked&&o.job_status)return 'Processus normal V3'+(o.job_status==='complete'?'':' · En cours ou bloqué');
 return 'Parcours à vérifier';
}
