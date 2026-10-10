import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {temuApi} from './temu-api.mjs';
import {loadShopVault} from './temu-shop-vault.mjs';
import {readTemuShipments} from './temu-shipping.mjs';

export function v2TemuReader(directory,{apiFactory=temuApi,shopLoader=loadShopVault,configLoader=async()=>JSON.parse(await readFile(path.join(directory,'temu-production.json'),'utf8'))}={}){
 let clients=[],until=0;const known=new Map();
 async function connect(){if(clients.length&&until>Date.now())return;
  const config=await configLoader(),root=apiFactory(config),info=await root.read('bg.open.accesstoken.info.get',{});
  if(!info.mallId)throw Error('TEMU : identité boutique indisponible');
  const map=new Map([[String(info.mallId),root]]);
  for(const m of info.associatedMallTokenList||[])if(m.mallId&&m.accessToken)map.set(String(m.mallId),apiFactory({...config,TEMU_ACCESS_TOKEN:m.accessToken}));
  for(const m of await shopLoader(directory)){
   if(m.appKey!==config.TEMU_APP_KEY||!m.accessToken)continue;
   const api=apiFactory({...config,TEMU_ACCESS_TOKEN:m.accessToken}),identity=await api.read('bg.open.accesstoken.info.get',{});
   if(identity.mallId)map.set(String(identity.mallId),api);
  }
  clients=[...map].map(([mall,api])=>({mall,read:api.read}));until=Date.now()+3600000;
 }
 return async function(s,{mallHint}={}){await connect();const preferred=known.get(s.reference)||mallHint;
  const ordered=[...clients].sort((a,b)=>Number(b.mall===preferred)-Number(a.mall===preferred));
  for(const c of ordered){let detail;try{detail=await c.read('bg.order.detail.v2.get',{parentOrderSn:s.reference});}catch(e){if(/140020002|Order not found/.test(e.message))continue;throw e;}
   if(detail.parentOrderMap?.parentOrderSn!==s.reference)throw Error('TEMU : identité de commande non concordante');known.set(s.reference,c.mall);
   return readV2Parcels(c.read,s,detail,c.mall);
  }throw Error('TEMU : commande introuvable dans les boutiques autorisées');
 };
}
export async function readV2Parcels(read,s,detail,mall=''){
 const shipment=await readTemuShipments({read},s.reference,detail);
 const packages=[...new Set([...(detail.orderList||[]).flatMap(l=>(l.packageSnInfo||[]).map(p=>p.packageSn)),...shipment.shipmentInfoDTO.flatMap(p=>[p,...(p.subPackageShipmentInfoList||[])]).map(p=>{if(p.parentOrderSn&&p.parentOrderSn!==s.reference)throw Error('TEMU : colis d’une autre commande');return p.packageSn;})].filter(Boolean))];
 if(!packages.length)throw Error('TEMU : aucune expédition existante trouvée');
 if(packages.some(p=>!/^PK-\d+$/.test(p)))throw Error('TEMU : identifiant colis invalide');
 const result=await read('bg.logistics.shipment.result.get',{packageSnList:packages});
 const all=(result.packageInfoResultList||[]).filter(p=>packages.includes(p.packageSn));
 const selected=s.tracking.length?s.tracking.map(tracking=>{const m=all.filter(p=>String(p.trackingNumber||'').trim()===tracking);if(m.length!==1)throw Error('TEMU : numéro du fichier non rapproché du colis');return m[0];}):all.filter(p=>p.trackingNumber&&Number(p.shippingLabelStatus)===1);
 if(!selected.length)throw Error('TEMU : numéro de suivi non disponible');
 const parcels=selected.map(p=>({tracking:String(p.trackingNumber).trim(),carrier:String(p.shippingCompanyName||p.carrierName||p.carrier||p.logisticsCompanyName||'Transporteur non communiqué par TEMU'),package:p.packageSn,api:'TEMU'}));
 const events=[],errors=[];
 for(const p of parcels){try{const t=await read('temu.track.trackinginfo.get',{packageSn:p.package});
  if(t.packageSn!==p.package||String(t.trackingNum||'').trim()!==p.tracking)throw Error('TEMU : identité suivi non concordante');
  const rows=t.trackingInfo||[];if(!rows.length)throw Error('TEMU : aucun événement communiqué');
  for(const e of rows){const raw=e.logisticsUpdatedAt,at=/^\d{10,13}$/.test(String(raw))?new Date(Number(raw)*(String(raw).length===10?1000:1)).toISOString():raw;if(!Number.isFinite(Date.parse(at)))throw Error('TEMU : date événement invalide');events.push({carrier:'temu',tracking:p.tracking,code:e.logisticsStatus,label:e.statusText,at});}
 }catch(e){errors.push(String(e.message).slice(0,300));}}
 return {parcels,events,errors,api:'TEMU',mall};
}
