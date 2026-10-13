import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {temuApi} from './temu-api.mjs';
import {loadShopVault} from './temu-shop-vault.mjs';

export async function loadTemuShopConfig(directory){
 return JSON.parse((await readFile(path.join(directory,'temu-production.json'),'utf8')).replace(/^\uFEFF/,''));
}

// Shared connection policy used by API-imported and Excel-imported orders.
export async function connectTemuShops(directory,{
 apiFactory=temuApi,shopLoader=loadShopVault,configLoader=()=>loadTemuShopConfig(directory),
 country,strict=false,clients=new Map(),countryByMall=new Map(),connectionErrors=new Map()
}={}){
 const config=await configLoader(),root=apiFactory(config);
 const info=await root.read('bg.open.accesstoken.info.get',{});
 if(!info.mallId)throw Error('TEMU · Identité de la boutique absente');
 const verified=country?new Map(clients):new Map();
 verified.set(String(info.mallId),root);
 for(const m of info.associatedMallTokenList||[])if(m.mallId&&m.accessToken)verified.set(String(m.mallId),apiFactory({...config,TEMU_ACCESS_TOKEN:m.accessToken}));
 for(const m of await shopLoader(directory)){
  if(country&&String(m.country).toUpperCase()!==String(country).toUpperCase())continue;
  if(m.appKey!==config.TEMU_APP_KEY||!/^epl\w+$/.test(m.accessToken||''))continue;
  const api=apiFactory({...config,TEMU_ACCESS_TOKEN:m.accessToken});
  try{
   const identity=await api.read('bg.open.accesstoken.info.get',{});
   if(!identity.mallId)throw Error('TEMU · Identité de la boutique '+m.country+' absente');
   verified.set(String(identity.mallId),api);
   connectionErrors.delete(String(m.country).toUpperCase());
   if(/^[A-Z]{2}$/.test(m.country||''))countryByMall.set(String(identity.mallId),m.country);
  }catch(e){if(strict||e.code==='TEMU_STOPPING')throw e;connectionErrors.set(String(m.country).toUpperCase(),e);}
 }
 return {clients:verified,countryByMall,connectionErrors,config};
}
