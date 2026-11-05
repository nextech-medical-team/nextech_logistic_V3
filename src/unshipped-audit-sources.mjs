import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {temuApi} from './temu-api.mjs';
import {loadShopVault} from './temu-shop-vault.mjs';
import {readTemuOrderDiagnostic} from './temu-order-diagnostic.mjs';
import {shopifyObservationApi} from './shopify-observation-api.mjs';
import {erplainAccount} from './erplain-accounts.mjs';
import {trackingClient} from './carrier-tracking.mjs';

export const pendingShopifyQuery='query UnshippedAuditShopify($after:String){orders(first:100,after:$after,query:"-status:cancelled -fulfillment_status:fulfilled",sortKey:CREATED_AT){pageInfo{hasNextPage endCursor} nodes{id name createdAt cancelledAt displayFulfillmentStatus fulfillments{id status trackingInfo{number company}}}}}';
export function unshippedSources(directory,{shouldStop=()=>false}={}){
 return {
  shopify:shopifyObservationApi(directory),erp:erplainAccount(directory,'source'),tracking:trackingClient(directory),
  async temu(){
   const config=JSON.parse((await readFile(path.join(directory,'temu-production.json'),'utf8')).replace(/^\uFEFF/,'')),clients=new Map(),errors=[];
   const make=c=>{const api=temuApi(c,{relay:null});return {async read(type,input){for(let n=0;;n++){
    if(shouldStop())throw Error('Contrôle interrompu');
    try{return await api.read(type,input,{shouldStop});}catch(e){if(e.code!=='source_budget_deferred'||n>=12)throw e;await new Promise(r=>setTimeout(r,Math.min(10000,Math.max(1000,Number(e.retryAfter||1)*1000))));}
   }}};};
   async function add(c,country=''){
    try{const api=make(c),info=await api.read('bg.open.accesstoken.info.get',{});if(!info.mallId)throw Error('Identité boutique absente');
     clients.set(String(info.mallId),{mall:String(info.mallId),country,api});
     for(const m of info.associatedMallTokenList||[])if(m.mallId&&m.accessToken&&!clients.has(String(m.mallId)))clients.set(String(m.mallId),{mall:String(m.mallId),country:'',api:make({...c,TEMU_ACCESS_TOKEN:m.accessToken})});
    }catch(e){errors.push('Connexion TEMU '+(country||'principale')+' : '+String(e.message).slice(0,300));}
   }
   await add(config);try{for(const s of await loadShopVault(directory))await add({...config,TEMU_APP_KEY:s.appKey,TEMU_APP_SECRET:s.appSecret,TEMU_ACCESS_TOKEN:s.accessToken},s.country);}catch(e){errors.push('Coffre TEMU : '+String(e.message).slice(0,300));}
   return {sources:[...clients.values()].map(({mall,country,api})=>({mall,country,
    page:pageNumber=>api.read('bg.order.list.v2.get',{parentOrderStatus:2,pageNumber,pageSize:50,sortby:'createTime'}),
    details:reference=>readTemuOrderDiagnostic(api,reference)
   })),errors};
  }
 };
}
