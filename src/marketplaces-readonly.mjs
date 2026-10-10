import {createHash} from 'node:crypto';

// This client exposes order reads only. No imports, webhooks or fulfilment writes.
export function createMarketplaceReader(config,{fetchImpl=fetch}={}){
 async function json(url,options){
  const response=await fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`Lecture marketplace refusée : HTTP ${response.status}`);
  return response.json();
 }
 return {
  async shopifyFive(ids=[]){
   const domain=String(config.SHOPIFY_STORE_DOMAIN||'').trim();
   if(!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(domain))throw new Error('SHOPIFY_STORE_DOMAIN requis');
   let accessToken=config.SHOPIFY_ACCESS_TOKEN;
   if(!accessToken&&config.SHOPIFY_CLIENT_ID&&config.SHOPIFY_CLIENT_SECRET){const auth=await json(`https://${domain}/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'client_credentials',client_id:config.SHOPIFY_CLIENT_ID,client_secret:config.SHOPIFY_CLIENT_SECRET})});accessToken=auth.access_token;}
   if(!accessToken)throw new Error('SHOPIFY_ACCESS_TOKEN requis pour lire les commandes');
   const url=new URL(`https://${domain}/admin/api/2026-04/orders.json`);
   url.searchParams.set('status','any');url.searchParams.set('limit','5');
   if(ids.length){if(ids.length>5||ids.some(id=>!/^\d+$/.test(String(id))))throw new Error('Un à cinq identifiants Shopify requis');url.searchParams.set('ids',ids.join(','));}
   url.searchParams.set('fields','id,name,created_at,currency,total_price,financial_status,fulfillment_status,shipping_address,line_items,email,contact_email,shipping_lines,note_attributes');
   const result=await json(url,{method:'GET',headers:{'X-Shopify-Access-Token':accessToken,Accept:'application/json'}});
   if(!Array.isArray(result.orders))throw new Error('Shopify : liste de commandes absente');
   return result.orders.slice(0,5);
  },
  async temuFive(){
   for(const key of ['TEMU_APP_KEY','TEMU_APP_SECRET','TEMU_ACCESS_TOKEN'])if(!config[key])throw new Error(`${key} requis pour lire les commandes TEMU`);
   const payload={app_key:config.TEMU_APP_KEY,access_token:config.TEMU_ACCESS_TOKEN,data_type:'JSON',timestamp:String(Math.floor(Date.now()/1000)),type:'bg.order.list.v2.get',pageNumber:1,pageSize:5,sortby:'createTime'};
   const assembled=Object.keys(payload).sort().map(k=>k+String(payload[k])).join('');
   const sign=createHash('md5').update(config.TEMU_APP_SECRET+assembled+config.TEMU_APP_SECRET).digest('hex').toUpperCase();
   const result=await json('https://openapi-b-eu.temu.com/openapi/router',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,sign})});
   if(!result.success||(result.errorCode!==undefined&&![0,1000000].includes(Number(result.errorCode))))throw new Error(`TEMU : lecture refusée (code ${String(result.errorCode||'inconnu')})`);
   if(result.result===undefined)throw new Error('TEMU : résultat absent');
   return result.result;
  }
 };
}


