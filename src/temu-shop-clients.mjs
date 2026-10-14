import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {temuApi} from './temu-api.mjs';
import {loadShopVault} from './temu-shop-vault.mjs';
import {temuShopError,unavailableTemuApplication} from './temu-shop-error.mjs';

export async function loadTemuShopConfig(directory){
 return JSON.parse((await readFile(path.join(directory,'temu-production.json'),'utf8')).replace(/^\uFEFF/,''));
}

// Shared connection policy used by API-imported and Excel-imported orders.
export async function connectTemuShops(directory,{
 apiFactory=temuApi,shopLoader=loadShopVault,configLoader=()=>loadTemuShopConfig(directory),
 country,strict=false,allowUnavailableApplications=false,clients=new Map(),countryByMall=new Map(),connectionErrors=new Map()
}={}){
 const config=await configLoader(),root=apiFactory(config);
 let info;const unavailableApplications=[];
 try{info=await root.read('bg.open.accesstoken.info.get',{});}
 catch(e){const error=temuShopError(e,'accès principal — vérification de l’autorisation',[config.TEMU_APP_KEY,config.TEMU_APP_SECRET,config.TEMU_ACCESS_TOKEN]);if(!allowUnavailableApplications||!unavailableTemuApplication(e))throw error;unavailableApplications.push(error);connectionErrors.set('MAIN',error);}
 if((!info&&!unavailableApplications.length)||(info&&!info.mallId))throw Error('TEMU · Identité de la boutique absente');
 const verified=country?new Map(clients):new Map();
 if(info){connectionErrors.delete('MAIN');verified.set(String(info.mallId),root);}
 for(const m of info?.associatedMallTokenList||[])if(m.mallId&&m.accessToken)verified.set(String(m.mallId),apiFactory({...config,TEMU_ACCESS_TOKEN:m.accessToken}));
 for(const m of await shopLoader(directory)){
  if(country&&String(m.country).toUpperCase()!==String(country).toUpperCase())continue;
  try{
   if(!m.appKey||!m.appSecret||!m.accessToken)throw Error('TEMU · Accès incomplets pour la boutique '+m.country);
   const shopConfig={...config,TEMU_APP_KEY:m.appKey,TEMU_APP_SECRET:m.appSecret,TEMU_ACCESS_TOKEN:m.accessToken};
   const api=apiFactory(shopConfig);
   const identity=await api.read('bg.open.accesstoken.info.get',{});
   if(!identity.mallId)throw Error('TEMU · Identité de la boutique '+m.country+' absente');
   verified.set(String(identity.mallId),api);
   connectionErrors.delete(String(m.country).toUpperCase());
   const shopCountry=String(m.country||'').trim().toUpperCase();
   if(/^[A-Z]{2}$/.test(shopCountry))countryByMall.set(String(identity.mallId),shopCountry);
   for(const associated of identity.associatedMallTokenList||[])if(associated.mallId&&associated.accessToken&&!verified.has(String(associated.mallId)))verified.set(String(associated.mallId),apiFactory({...shopConfig,TEMU_ACCESS_TOKEN:associated.accessToken}));
  }catch(e){const error=temuShopError(e,'boutique '+String(m.country||'sans pays')+' du coffre — vérification de l’autorisation',[m.appKey,m.appSecret,m.accessToken]);const unavailable=allowUnavailableApplications&&unavailableTemuApplication(e);if(e.code==='TEMU_STOPPING'||strict&&!unavailable)throw error;if(unavailable)unavailableApplications.push(error);connectionErrors.set(String(m.country).toUpperCase(),error);}
 }
 return {clients:verified,countryByMall,connectionErrors,config,unavailableApplications};
}
