import {hasCreatedBl} from './created-bl-label.mjs';
import {usesRecordedBc} from './existing-bc-execution.mjs';
import {resolveExcelTemuShop} from './temu-excel-shop.mjs';
import {isTemuExcel,verifiedExcelCommercial} from './temu-excel-commercial.mjs';
import {verifyExcelTemuDetail} from './temu-excel-identity.mjs';
import {isTemuReadDeferred,temuReadDeferral} from './temu-read-deferral.mjs';
import {excludedTemuCarrier} from './temu-purchase-policy.mjs';
import {hasExternalLabel,readExternalTemuTracking} from './temu-external-label.mjs';
import {readTemuOrderDiagnostic} from './temu-order-diagnostic.mjs';
import {reconcilePaidTemuStatuses} from './temu-paid-status-reconciliation.mjs';
import {recoverTemuSubstitutionReviews} from './temu-substitution-recovery.mjs';
import {observeTemuCancellation} from './temu-cancellation-observation.mjs';
import {readOrderAmounts} from './temu-margin-data.mjs';
import {withShipmentLock} from './shipment-lock.mjs';
import {temuCollector} from './temu-collection.mjs';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {aggregateParcels} from './status-policy.mjs';
import {temuApi} from './temu-api.mjs';
import {temuShipping,inspectTemu,readTemuShipments} from './temu-shipping.mjs';
import {loadShopVault} from './temu-shop-vault.mjs';
import {connectTemuShops,loadTemuShopConfig} from './temu-shop-clients.mjs';
export function buyerCancellationPending(detail){const flags=[...(detail?.parentOrderMap?.parentOrderLabel||[]),...(detail?.orderList||[]).flatMap(l=>l.orderLabel||[])];return flags.some(f=>f==='pending_buyer_cancellation'||f?.name==='pending_buyer_cancellation'&&[1,'1',true].includes(f.value));}
export function directError(e){return String(e?.message||e).includes('NOT_IN_IP_WHITE_LIST')?'TEMU · IP non autorisée (5000003 — NOT_IN_IP_WHITE_LIST)':String(e?.message||e).slice(0,450);}
export async function localTemuRows(db){return (await db.query(`SELECT o.id,o.reference,o.recipient,o.address->>'country' country,o.tracking_status,o.erp_live,o.source_payload->'temuDirect' direct,e.status erp_job_status,e.error erp_error,j.status,j.error,j.result,j.plan,j.packages,(SELECT coalesce(json_agg(json_build_object('source_sku',l.source_sku,'target_sku',coalesce(nullif(l.target_sku,''),m.target_sku)) ORDER BY l.source_line),'[]'::json) FROM lines l LEFT JOIN mappings m ON m.channel='temu' AND m.source_sku=l.source_sku WHERE l.order_id=o.id) sku_lines,(SELECT json_agg(package ORDER BY package) FROM temu_label_documents d WHERE d.reference=o.reference AND j.packages ? d.package) documents FROM orders o LEFT JOIN temu_label_jobs j ON j.reference=o.reference LEFT JOIN erp_live_jobs e ON e.order_id=o.id WHERE o.channel='temu' AND NOT o.archived ORDER BY o.source_date DESC,o.reference`)).rows;}
export function temuLocalService(db,directory,{apiFactory=temuApi,shopLoader=loadShopVault,configLoader=()=>loadTemuShopConfig(directory)}={}){
 let running=false,clients=new Map(),services=new Map(),allShopsConnected=false,countryByMall=new Map(),connectedAt=0,connectionErrors=new Map(),connections=new Map();
 async function connect(country){const key=country||'ALL';if(connections.has(key))return connections.get(key);const pending=connectShops(country);connections.set(key,pending);try{return await pending;}finally{connections.delete(key);}}
 async function connectShops(country){
  const connected=await connectTemuShops(directory,{apiFactory,shopLoader,configLoader,country,clients,countryByMall,connectionErrors,allowUnavailableApplications:true});
  if(!connected.clients.size&&connected.unavailableApplications.length)throw connected.unavailableApplications[0];
  clients=connected.clients;
  if(!country){allShopsConnected=true;connectedAt=Date.now();services.clear();}
 }
 async function context(reference){const o=(await db.query("SELECT * FROM orders WHERE channel='temu' AND reference=$1",[reference])).rows[0];if(!o)throw Error('Commande TEMU absente de V3');let mall=String(o.source_payload.mallId||'');
  if(!mall&&isTemuExcel(o)&&(o.source_payload.temuExcelPreparation||hasCreatedBl(o)&&o.erp_live?.bc?.id)){
   const lines=(await db.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY source_line,id',[o.id])).rows;
   const resolved=await resolveExcelShop(o,lines);mall=String(resolved.mallId);
   const linkage={mallId:mall,sourceShop:mall,temuShopVerifiedAt:new Date().toISOString(),temuShopWarnings:resolved.shopWarnings||[]};
   await db.query('UPDATE orders SET source_payload=source_payload||$2::jsonb WHERE id=$1',[o.id,JSON.stringify(linkage)]);
   o.source_payload={...o.source_payload,...linkage};clients.set(mall,resolved.api);
  }
  if(!clients.has(mall))await connect();const api=clients.get(mall);if(!api){const error=connectionErrors.get(String(o.address?.country||'').toUpperCase());if(error)throw error;throw Error('TEMU · Autorisation manquante pour la boutique '+mall);}if(!services.has(mall))services.set(mall,temuShipping(db,api));return {o,api,service:services.get(mall)};}
 const locked=(ref,fn)=>withShipmentLock(fn,['temu-order:'+ref]);
 async function fail(o,e){
  if(e.code==='TEMU_STOPPING')throw e;
  if(isTemuReadDeferred(e)){const deferred=temuReadDeferral(e,{reference:o.reference});await db.query('UPDATE orders SET source_payload=source_payload||$2::jsonb WHERE id=$1',[o.id,JSON.stringify({temuReadDeferred:deferred})]);return deferred;}
  if(hasExternalLabel(o)){await db.query("UPDATE temu_label_jobs SET result=coalesce(result,'{}'::jsonb)||$2::jsonb WHERE reference=$1",[o.reference,JSON.stringify({trackingErrors:[{error:directError(e)}]})]);return {reference:o.reference,status:'external',error:null,trackingWarning:directError(e)};}
  const error=directError(e),shipmentIssue=['TEMU_SHIPMENT_FAILED','TEMU_SHIPMENT_PENDING'].includes(e.code);
  await db.query("UPDATE orders SET source_payload=(source_payload-'temuReadDeferred')||$2::jsonb WHERE id=$1",[o.id,JSON.stringify({temuDirect:{source:'temu_direct',state:shipmentIssue?'verified':'error',attemptedAt:new Date().toISOString(),error}})]);
  await db.query("INSERT INTO temu_label_jobs(reference,status,error) VALUES($1,'api_error',$2) ON CONFLICT(reference) DO UPDATE SET status=CASE WHEN temu_label_jobs.attempt_id IS NOT NULL OR jsonb_array_length(temu_label_jobs.packages)>0 THEN temu_label_jobs.status ELSE 'api_error' END,error=excluded.error,updated_at=now()",[o.reference,error]);
  return {reference:o.reference,error};
 }
 async function refreshAmounts(o,api,{force=false}={}){
  if(isTemuExcel(o))return {reference:o.reference,source:'temu_excel',cached:true};
  const old=o.source_payload?.temuAmounts;
  if(!force&&old?.data&&Number.isFinite(Date.parse(old.at))&&Date.now()-Date.parse(old.at)<1800000)return {reference:o.reference,cached:true};
  try{const amounts=await readOrderAmounts(api,o.reference);await db.query('UPDATE orders SET source_payload=source_payload||$2::jsonb WHERE id=$1',[o.id,JSON.stringify({temuAmounts:amounts,temuAmountsError:null})]);return {reference:o.reference,updated:true};}
  catch(e){if(isTemuReadDeferred(e))throw e;const error=directError(e);await db.query('UPDATE orders SET source_payload=source_payload||$2::jsonb WHERE id=$1',[o.id,JSON.stringify({temuAmountsError:{at:new Date().toISOString(),message:error}})]);return {reference:o.reference,error};}
 }
 async function refresh(reference,options={}){const result=await refreshRead(reference,options);if(!result.deferred)await db.query("UPDATE orders SET source_payload=source_payload-'temuReadDeferred' WHERE channel='temu' AND reference=$1 AND source_payload ? 'temuReadDeferred'",[reference]);return result;}
 async function refreshRead(reference,{forceQuote=false,channel}={}){
  const held=(await db.query("SELECT source_payload,issue,erp_live FROM orders WHERE channel='temu' AND reference=$1",[reference])).rows[0];if(held?.source_payload?.origin==='temu_excel'&&!held.source_payload.temuExcelPreparation&&!(hasCreatedBl(held)&&held.erp_live?.bc?.id))return {reference,status:'unverified',error:'Excel TEMU : relancez la préparation depuis Imports'};if(held?.source_payload?.visibilityHold)return {reference,status:'api_error',error:held.issue};
  let ctx;try{ctx=await context(reference);}catch(e){const o=(await db.query("SELECT * FROM orders WHERE channel='temu' AND reference=$1",[reference])).rows[0];if(!o)throw e;return fail(o,e);}const {o,api,service}=ctx;
  try{
   const detail=await api.read('bg.order.detail.v2.get',{parentOrderSn:reference});
   if(detail.parentOrderMap?.parentOrderSn!==reference||!Array.isArray(detail.orderList)||!detail.orderList.length)throw Error('TEMU · Identité ou articles de commande incohérents');
   if(isTemuExcel(o)){const lines=(await db.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY source_line,id',[o.id])).rows;verifyExcelTemuDetail(o,lines,detail);if(!usesRecordedBc(o))verifiedExcelCommercial(o,lines);}
   const now=new Date().toISOString(),direct={source:'temu_direct',state:'verified',verifiedAt:now,status:Number(detail.parentOrderMap.parentOrderStatus)};
   await db.query('UPDATE orders SET source_payload=source_payload||$2::jsonb WHERE id=$1',[o.id,JSON.stringify({temuDirect:direct,temuOrderDetail:detail})]);
   await observeTemuCancellation(db,o,detail);
   await refreshAmounts(o,api);
   const shipments=await readTemuShipments(api,reference,detail);
   if(hasExternalLabel(o))return readExternalTemuTracking(db,o,api,shipments);
   const packages=[...new Set([...(detail.orderList||[]).flatMap(l=>(l.packageSnInfo||[]).map(p=>p.packageSn)),...shipments.shipmentInfoDTO.flatMap(s=>[s,...(s.subPackageShipmentInfoList||[])]).map(s=>{if(s.parentOrderSn&&s.parentOrderSn!==reference)throw Error('TEMU · Colis d’une autre commande');return s.packageSn;})].filter(Boolean))];
   if(packages.some(p=>!/^PK-\d+$/.test(p)))throw Error('TEMU · Identifiant de colis invalide');
   if(packages.length){
    const j=await service.recover(reference,{packages});await reconcilePaidTemuStatuses(db).catch(e=>console.error("TEMU local status reconciliation deferred",e.message));const parcels=j.result.packageInfoResultList||[],events=[],trackingErrors=[];
    const groupedRefs=[...new Set(parcels.flatMap(p=>(p.orderSendInfoList||[]).map(l=>l.parentOrderSn)))];
    if(groupedRefs.length>1){const known=new Set((await db.query("SELECT reference FROM orders WHERE channel='temu' AND reference=ANY($1::text[])",[groupedRefs])).rows.map(r=>r.reference)),groupedOrderLines=[];
     for(const ref of groupedRefs.filter(ref=>!known.has(ref))){const groupedDetail=await api.read('bg.order.detail.v2.get',{parentOrderSn:ref});if(groupedDetail.parentOrderMap?.parentOrderSn!==ref||!groupedDetail.orderList?.length)throw Error('TEMU · Commande du colis groupé non vérifiable : '+ref);const seen=new Set();
      for(const l of groupedDetail.orderList){const skus=[...new Set((l.productList||[]).map(p=>String(p.extCode||'').trim()).filter(Boolean))];if(skus.length!==1||!l.orderSn||seen.has(l.orderSn)||!(Number(l.quantity)>0))throw Error('TEMU · Articles du colis groupé non vérifiables : '+ref);seen.add(l.orderSn);groupedOrderLines.push({reference:ref,source_line:l.orderSn,source_sku:skus[0],quantity:Number(l.quantity)});}
     }
     await db.query('UPDATE temu_label_jobs SET result=result||$2::jsonb WHERE reference=$1',[reference,JSON.stringify({groupedOrderLines})]);
    }
    for(const p of parcels){try{const t=await api.read('temu.track.trackinginfo.get',{packageSn:p.packageSn});if(t.packageSn!==p.packageSn||String(t.trackingNum||'').trim()!==String(p.trackingNumber||'').trim())throw Error('TEMU · Suivi incompatible avec le colis');for(const e of t.trackingInfo||[]){const raw=e.logisticsUpdatedAt,at=/^\d{10,13}$/.test(raw||'')?new Date(Number(raw)*(String(raw).length===10?1000:1)).toISOString():raw;if(!Number.isFinite(Date.parse(at)))throw Error('TEMU · Date du suivi non vérifiable');events.push({source:'temu_tracking',trackingKey:t.trackingNum,code:e.logisticsStatus,label:e.statusText,at});}}catch(e){if(isTemuReadDeferred(e))throw e;trackingErrors.push({package:p.packageSn,error:directError(e)});}}
    await db.query('UPDATE temu_label_jobs SET result=result||$2::jsonb WHERE reference=$1',[reference,JSON.stringify({deliveryStatuses:events,trackingErrors,trackingVerifiedAt:trackingErrors.length?null:now})]);
    if(!o.transport_choice&&!trackingErrors.length)await db.query('UPDATE orders SET tracking_status=$2 WHERE id=$1',[o.id,trackingState(parcels.map(p=>({...p,status:1})),events,o.tracking_status||'not_shipped')]);
    if(j.status==='complete')await recoverTemuSubstitutionReviews(db,reference);
    return {reference,status:j.status,documents:true,error:j.error||null};
   }
   const old=(await db.query('SELECT * FROM temu_label_jobs WHERE reference=$1',[reference])).rows[0];
   if(old?.attempt_id||old?.packages?.length)throw Error('TEMU · Achat existant sans colis confirmé : vérifier avant tout nouvel achat');
   if(shipments.shipmentInfoDTO.length){
    const status='external';
    await db.query("INSERT INTO temu_label_jobs(reference,status,result) VALUES($1,$2,$3) ON CONFLICT(reference) DO UPDATE SET status=excluded.status,result=excluded.result,error=null,plan=null,updated_at=now()",[reference,status,JSON.stringify({source:'temu_direct',observedAt:now})]);
    return {reference,status};
   }
   // Preserve an unexpired quote only when the fresh TEMU order is unchanged.
   const info=inspectTemu(detail,reference);
   if(!forceQuote&&old?.status==='ready'&&!old.error&&old.plan?.expiresAt>Date.now()+60000&&old.plan.orderFingerprint===info.fingerprint&&!excludedTemuCarrier(old.plan.offers?.find(offer=>offer.channelId===old.plan.selected)))return {reference,status:'ready',plan:old.plan};
   try{const plan=await service.prepare(reference,channel,{detail,shipments});return {reference,status:'ready',plan};}
   catch(e){if(isTemuReadDeferred(e))return fail(o,e);const error=directError(e);await db.query("INSERT INTO temu_label_jobs(reference,status,error,result) VALUES($1,'to_buy',$2,$3) ON CONFLICT(reference) DO UPDATE SET status='to_buy',error=excluded.error,result=excluded.result,updated_at=now()",[reference,error,JSON.stringify({source:'temu_direct',observedAt:now})]);return {reference,status:'to_buy',error};}
  }catch(e){return fail(o,e);}
 }

 async function resolveExcelShop(o,lines){
  // The delivery country is not proof of shop ownership. Search every configured shop.
  const connected=await connectTemuShops(directory,{apiFactory,shopLoader,configLoader,strict:true,allowUnavailableApplications:true});
  const candidates=[...connected.clients].map(([mallId,api])=>({mallId,api}));
  return resolveExcelTemuShop(o,lines,candidates,connected.unavailableApplications);
 }
 return {resolveExcelShop,async excelShops(country){await connect(country);const config=await configLoader();return [...clients].map(([mallId])=>({mallId,country:config.TEMU_COUNTRIES?.[mallId]||countryByMall.get(mallId)||''})).filter(s=>!s.country||s.country===country);},async excelShop(mallId,country){const shops=await this.excelShops(country);if(!shops.some(s=>s.mallId===mallId))throw Error('Boutique TEMU absente ou pays différent');return clients.get(mallId);},async diagnose(reference){const {api}=await context(reference);const known=(await db.query('SELECT packages FROM temu_label_jobs WHERE reference=$1',[reference])).rows[0];return readTemuOrderDiagnostic(api,reference,{knownPackages:known?.packages||[]});},async amounts(reference,options){const {o,api}=await context(reference);return refreshAmounts(o,api,options);},get running(){return running;},async collectors(){if(!allShopsConnected||!clients.size||Date.now()-connectedAt>300000)await connect();const sources=[];for(const [mallId,api] of clients){const countries=(await db.query("SELECT DISTINCT address->>'country' country FROM orders WHERE channel='temu' AND source_payload->>'mallId'=$1 AND archived=false",[mallId])).rows.map(x=>x.country).filter(Boolean);const config=await configLoader();const country=config.TEMU_COUNTRIES?.[mallId]||countryByMall.get(mallId)||(countries.length===1?countries[0]:null);sources.push(temuCollector(api,{mallId,country}));}return sources;},async sync(){if(running)throw Error('Actualisation TEMU déjà en cours');running=true;const result={at:new Date().toISOString(),source:'temu_direct',updated:0,errors:[]};try{const rows=(await db.query("SELECT * FROM orders WHERE channel='temu' AND NOT archived")).rows;try{await connect();}catch(e){result.connectionError={code:e.code||'TEMU_CONNECTION_ERROR',message:directError(e),...(isTemuReadDeferred(e)?temuReadDeferral(e):{})};await writeFile(path.join(directory,'temu-direct-last-sync.json'),JSON.stringify(result));return result;}
   for(const o of rows){try{await locked(o.reference,()=>refresh(o.reference));result.updated++;}catch(e){result.errors.push(await fail(o,e));}}await writeFile(path.join(directory,'temu-direct-last-sync.json'),JSON.stringify(result));return result;
  }finally{running=false;}},async prepare(reference,channel){return locked(reference,async()=>{const r=await refresh(reference,{forceQuote:true,channel});if(r.deferred)throw Object.assign(Error(r.message),{code:r.code,retryAfter:String(r.retryAfterMs/1000)});if(!r.plan)throw Error(r.error||(r.documents?'TEMU · Étiquette déjà disponible : consultez le PDF':'TEMU · '+r.status));return r.plan;});},async buy(reference,id,amount,options={}){return withShipmentLock(async()=>{const {o,service}=await context(reference);if(hasExternalLabel(o))throw Error('Étiquette externe enregistrée : aucun nouvel achat TEMU');if(o.transport_choice)throw Error('Transporteur choisi manuellement : achat TEMU désactivé pour éviter une double étiquette');if(o.source_payload.temuReadDeferred)throw Object.assign(Error('Lecture TEMU en attente : achat non engagé'),{code:'source_budget_deferred',retryAfter:'1'});if(o.source_payload.temuDirect?.state!=='verified')throw Error('TEMU · Commande non vérifiée directement');const purchased=await service.buy(reference,id,amount,options);await reconcilePaidTemuStatuses(db).catch(e=>console.error("TEMU local status reconciliation deferred",e.message));return purchased;},['stock-mutations','temu-order:'+reference]);},async recover(reference){return locked(reference,()=>refresh(reference));},async list(){await connect();const result=[];for(const [mallId,api] of clients)result.push({mallId,...await api.read('bg.order.list.v2.get',{pageNumber:1,pageSize:20,sortby:'createTime'})});return {shops:result};}};
}
export function trackingState(packages,events,previous='not_shipped'){
 const expected=packages.map(p=>p.trackingNumber||'missing:'+p.packageSn);
 const next=aggregateParcels(expected,events.filter(e=>e.source==='temu_tracking').map(e=>({tracking:e.trackingKey,carrier:'temu',code:e.code,label:e.label,at:e.at}))).status;
 if(previous==='delivered')return previous;
 if(next==='unknown')return previous;
 if(next==='not_shipped'&&['shipped','in_transit'].includes(previous))return previous;
 return next;
}
