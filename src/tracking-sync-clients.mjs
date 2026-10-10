import {trackingClient} from './carrier-tracking.mjs';
import {erplainAccount} from './erplain-accounts.mjs';
import {erplainLifecycleGateway} from './erplain-lifecycle-gateway.mjs';
import {temuApi} from './temu-api.mjs';
import {trackingSyncConfig} from './tracking-sync-config.mjs';

export function trackingSyncClients(directory){
 const loadConfig=file=>trackingSyncConfig(directory,file);
 const shops=new Map();let connected=false;
 const temuFor=async target=>{
  if(!connected){
   const config=await loadConfig('temu-production.json');
   const api=temuApi(config,{relay:null});
   const identity=await api.read('bg.open.accesstoken.info.get',{});
   if(!identity.mallId)throw Error('TEMU : identité de boutique absente');
   shops.set(String(identity.mallId),api);
   for(const shop of identity.associatedMallTokenList||[]){
    if(!shop.mallId||!shop.accessToken)continue;
    const client=temuApi({...config,TEMU_ACCESS_TOKEN:shop.accessToken},{relay:null});
    const verified=await client.read('bg.open.accesstoken.info.get',{});
    if(String(verified.mallId)!==String(shop.mallId))throw Error('TEMU : identité de boutique associée incohérente');
    shops.set(String(shop.mallId),client);
   }
   connected=true;
  }
  const api=shops.get(String(target.mallId));
  if(!api)throw Error('TEMU : accès manquant pour la boutique de cette commande');
  return api;
 };
 return {carrier:trackingClient(directory,{loadConfig}),temuFor,
  gateway:erplainLifecycleGateway(erplainAccount(directory,'live',{loadConfig:()=>loadConfig('erplain-live.json')}))};
}
