import {readTemuLifecycle} from './temu-lifecycle-reader.mjs';
import {marketplaceContentFrozen} from './marketplace-content-freeze.mjs';
import {readTemuSource} from './temu-catchup-reader.mjs';
import {createHash} from 'node:crypto';
export function temuCollector(api,{mallId,country}){
 const shop=String(mallId||'');if(!shop)throw Error('TEMU · Identité boutique absente');
 return {channel:'temu',shop,refreshSource:(reference,options)=>readTemuSource(api,reference,options),async page({cursor,since,until,createdSince=since,shouldStop=()=>false,knownOrders=[]}){
  const pageNumber=cursor?Number(cursor):1;if(!Number.isInteger(pageNumber)||pageNumber<1)throw Error('TEMU · Page invalide');
  const result=await api.read('bg.order.list.v2.get',{pageNumber,pageSize:50,updateAtStart:Math.floor(Date.parse(since)/1000),updateAtEnd:Math.floor(Date.parse(until)/1000),sortby:'updateTime'});
  if(!Array.isArray(result.pageItems)||!Number.isInteger(Number(result.totalItemNum))||Number(result.totalItemNum)<0||result.pageItems.length>50)throw Error('TEMU · Pagination non vérifiable');
  const total=Number(result.totalItemNum);if(!result.pageItems.length&&total>(pageNumber-1)*50)throw Error('TEMU · Page de commandes manquante');
  const items=[],warnings=[],seen=new Set();for(const entry of result.pageItems){
   if(shouldStop())throw Error('Arrêt demandé');const ref=entry.parentOrderMap?.parentOrderSn;if(!ref||seen.has(ref))throw Error('TEMU · Référence absente ou dupliquée');seen.add(ref);
   const created=Number(entry.parentOrderMap?.parentOrderTime)*1000;if(Number.isFinite(created)&&created>0&&created<Date.parse(createdSince))continue;
   const frozen=knownOrders.find(o=>marketplaceContentFrozen(o)&&(o.source_reference||o.reference)===ref);
   if(frozen){const lifecycle=await readTemuLifecycle(api,frozen,{entry:{parentOrderMap:entry.parentOrderMap},shouldStop});const payload={lifecycleOnly:true,lifecycle,parentOrderTime:entry.parentOrderMap.parentOrderTime,detail:{parentOrderMap:entry.parentOrderMap}};items.push({deliveryId:'lifecycle:'+ref+':'+createHash('sha256').update(JSON.stringify(lifecycle)).digest('hex'),payload});continue;}
   const observation=await readTemuSource(api,ref,{shouldStop});
   const payload={detail:observation.payload.detail||entry,shipping:observation.payload.shipping||{},country:observation.payload.country||'',
    sourceCoverage:{complete:observation.complete,coreComplete:observation.coreComplete,requiredComplete:observation.requiredComplete,sourceStage:observation.sourceStage,expectedUnavailable:observation.expectedUnavailable,fields:observation.coverage,errors:observation.errors},
    logisticsObservation:{shipments:observation.payload.shipments||[],packages:observation.payload.packages||[]}};
   if(payload.detail.parentOrderMap?.parentOrderSn!==ref)throw Error('TEMU · Identité du détail incohérente');
   payload.detail={...payload.detail,parentOrderMap:{...payload.detail.parentOrderMap,updateTime:payload.detail.parentOrderMap.updateTime??entry.parentOrderMap.updateTime}};
   if(observation.payload.amounts)payload.detail.v3Amounts={data:observation.payload.amounts};
   if(!observation.coreComplete)payload.visibilityError=observation.requiredComplete?'TEMU · Coordonnées de livraison absentes · Lecture automatique planifiée':observation.errors.map(e=>e.message).join(' ; ').slice(0,500);
   for(const error of observation.errors)warnings.push({reference:ref,code:String(error.code),message:error.field+' · '+error.message});
   items.push({deliveryId:(observation.coreComplete?'poll:':'incomplete:')+ref+':'+createHash('sha256').update(JSON.stringify(payload)).digest('hex'),payload});
  }
  return {items,warnings,next:pageNumber*50<total?String(pageNumber+1):null};
 }};
}
