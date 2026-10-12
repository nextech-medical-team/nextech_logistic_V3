import {readTemuTracking,trackingDecision,trackingEvidence} from '../src/tracking-sync.mjs';
import {temuApi} from '../src/temu-api.mjs';
import {trackingClient} from '../src/carrier-tracking.mjs';
import {trackingSyncConfig} from '../src/tracking-sync-config.mjs';
import {erplainAccount} from '../src/erplain-accounts.mjs';
import {readFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
export function trackingPreview({api,readEvidence}){
 let busy=false;
 return async input=>{
  if(!input||!['temu','gls','gofo'].includes(input.carrier)||typeof input.reference!=='string'||!input.reference.trim()||input.reference.length>150||typeof input.bl!=='string'||!input.bl.trim()||input.bl.length>100)throw Error('Renseignez la référence, le BL et le transporteur.');
  const tracking=Array.isArray(input.tracking)?input.tracking:[];
  if(input.carrier!=='temu'&&(!tracking.length||tracking.length>20||tracking.some(t=>typeof t!=='string'||!/^[a-zA-Z0-9-]{4,80}$/.test(t))))throw Error('Renseignez les numéros de tous les colis de ce BL.');
  if(busy)throw Error('Une comparaison est déjà en cours');busy=true;
  try{
   const company=await api.verify();if(Number(company.id)!==100174)throw Error('Société PROD 100174 requise');
   const {Orders:orders}=await api.request('query PreviewOrder($where:QueryOrdersWhereWhereConditions){Orders(first:20,where:$where){data{id status shipping_orders(first:100){data{id label status} paginatorInfo{hasMorePages}}} paginatorInfo{hasMorePages}}}',{where:{column:'EXTERNAL_REFERENCE',operator:'EQ',value:input.reference.trim()}});
   if(!orders||orders.paginatorInfo?.hasMorePages||!orders.data.length)throw Error('BC absent ou recherche incomplète pour cette référence');
   if(orders.data.some(o=>!o.shipping_orders||o.shipping_orders.paginatorInfo?.hasMorePages))throw Error('Liste des BL incomplète');
   const candidates=orders.data.flatMap(bc=>bc.shipping_orders.data.filter(bl=>bl.label===input.bl.trim()).map(bl=>({bc,bl})));
   if(!candidates.length)throw Error('Ce BL n’est pas associé à cette commande');
   if(candidates.length!==1)throw Error('Rattachement BC / BL ambigu : plusieurs correspondances');
   const {bc,bl:matched}=candidates[0],bls=bc.shipping_orders,hits=[matched];
   if(input.carrier==='temu'&&bls.data.length!==1)throw Error('Plusieurs BL : les colis TEMU doivent être rapprochés par BL avant comparaison');
   const evidence=await readEvidence({...input,tracking});
   const {ShippingOrder:bl}=await api.request('query PreviewBL($id:ID!){ShippingOrder(id:$id){id status orders(first:100){data{id status} paginatorInfo{hasMorePages}}}}',{id:String(hits[0].id)});
   if(bl?.orders?.paginatorInfo?.hasMorePages)throw Error('Rattachement du BL incomplet');
   const target={bcId:String(bc.id),blId:String(hits[0].id),tracking:evidence.tracking};
   const decision=trackingDecision(target,evidence.events,bl);
   return {reference:input.reference,bl:input.bl,carrier:input.carrier,readAt:new Date().toISOString(),erplainStatus:bl.status,carrierStatus:trackingEvidence(evidence.tracking,evidence.events).status,tracking:evidence.tracking,events:evidence.events,proposed:decision.write?decision.target:null,reason:decision.reason,manualTracking:input.carrier!=='temu',applied:false};
  }catch(error){
   if(/NOT_IN_IP_WHITE_LIST/.test(error.message))throw Error('TEMU refuse l’adresse IP de ce poste (NOT_IN_IP_WHITE_LIST). Il faut autoriser cette IP dans TEMU ou configurer un relais de lecture valide. Aucun statut n’a été modifié.');
   throw error;
  }finally{busy=false;}
 };
}
export async function loadTrackingPreview(){
 const env=parseEnv(await readFile(new URL('../.env',import.meta.url),'utf8'));
 const directory=env.CREDENTIALS_DIR||'/home/user/Bureau/api-nextechlogistic-v3/Output/Code/data';
 const load=file=>trackingSyncConfig(directory,file,env);
 const api=erplainAccount('', 'source',{loadConfig:()=>load('erplain-live.json')});
 const carrier=trackingClient(directory,{loadConfig:load});
 return trackingPreview({api,readEvidence:async input=>{
  if(input.carrier!=='temu'){const events=[];for(const n of input.tracking)events.push(...await carrier.read(input.carrier,'production',n));return {tracking:input.tracking,events};}
  const config=await load('temu-production.json'),root=temuApi(config,{relay:null});
  const identity=await root.read('bg.open.accesstoken.info.get',{});if(!identity.mallId)throw Error('Identité boutique TEMU absente');
  const shops=[{id:String(identity.mallId),api:root},...(identity.associatedMallTokenList||[]).filter(s=>s.mallId&&s.accessToken&&String(s.mallId)!==String(identity.mallId)).map(s=>({id:String(s.mallId),api:temuApi({...config,TEMU_ACCESS_TOKEN:s.accessToken},{relay:null})}))];
  // Find the order in an authenticated shop; never infer a shop from its country.
  for(const shop of shops){
   const verified=shop.api===root?identity:await shop.api.read('bg.open.accesstoken.info.get',{});if(String(verified.mallId)!==shop.id)throw Error('Identité boutique incohérente');
   let detail;try{detail=await shop.api.read('bg.order.detail.v2.get',{parentOrderSn:input.reference});}catch(e){if(/429|limit/i.test(e.message))throw e;continue;}
   if(detail?.parentOrderMap?.parentOrderSn===input.reference)return readTemuTracking(shop.api,input.reference);
  }
  throw Error('Commande inaccessible dans les boutiques TEMU autorisées. Vérifiez les accès API.');
 }});
}
