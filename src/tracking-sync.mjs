import {aggregateParcels,shippingTransition} from './status-policy.mjs';
import {readTemuOrderDiagnostic} from './temu-order-diagnostic.mjs';

export function trackingEvidence(tracking,events,now=Date.now()){
 if(!events.length||events.some(e=>!Number.isFinite(Date.parse(e.at))||Date.parse(e.at)>now+300000))throw Error('Événements de suivi absents ou dates invalides');
 return aggregateParcels(tracking,events);
}

export function trackingDecision(target,events,bl,now=Date.now()){
 if(!/^\d+$/.test(String(target.bcId||''))||String(bl?.id)!==String(target.blId)||
    bl.orders?.data?.length!==1||String(bl.orders.data[0].id)!==String(target.bcId))throw Error('Rattachement BC / BL Erplain non vérifiable');
 if(bl.orders.data[0].status==='cancelled')return {write:false,reason:'bc_cancelled'};
 const tracking=trackingEvidence(target.tracking,events,now);
 if(!tracking.complete||tracking.states.some(s=>['unknown','cancelled','exception'].includes(s)))return {write:false,reason:'tracking_incomplete_or_incident',tracking};
 if(tracking.states.some(state=>!['shipped','delivered'].includes(state)))return {write:false,reason:'no_physical_progress',tracking};
 return {...shippingTransition({current:bl.status,target:tracking.status}),target:tracking.status,tracking};
}

export async function readTemuTracking(api,reference,knownPackages=[],readCarrier){
 const diagnostic=await readTemuOrderDiagnostic(api,reference,{knownPackages});
 if(diagnostic.status===3||diagnostic.cancellationRequested)throw Error('Commande TEMU annulée ou annulation demandée : contrôle requis');
 if(diagnostic.errors.length||!diagnostic.packages.length)throw Error('TEMU : lecture des colis incomplète');
 const events=[],tracking=[];
 for(const p of diagnostic.packages){
  if(!p.trackingNumber)throw Error('TEMU : numéro de suivi absent');
  const name=p.shippingCompanyName||p.carrierName||'';
  const provider=/\bgofo\b/i.test(name)||(!name&&/^GFFR[A-Z0-9]+$/i.test(p.trackingNumber))?'gofo':/\bgls\b/i.test(name)?'gls':null;
  let response;
  try{response=await api.read('temu.track.trackinginfo.get',{packageSn:p.packageSn});}
  catch(error){if(String(error.code)!=='170070010'||!provider||!readCarrier)throw error;}
  if(response&&(response.packageSn!==p.packageSn||response.trackingNum!==p.trackingNumber))throw Error('TEMU : identité du suivi différente du colis');
  const physical=Array.isArray(response?.trackingInfo)?response.trackingInfo.filter(e=>e.logisticsStatus!=='Notification'):[];
  tracking.push(p.trackingNumber);
  if(!physical.length){
   if(!provider||!readCarrier)throw Error('TEMU : événements de suivi absents');
   events.push(...await readCarrier(provider,p.trackingNumber));
   continue;
  }
  for(const e of physical){
   const raw=e.logisticsUpdatedAt;
   const at=/^\d{10,13}$/.test(String(raw))?new Date(Number(raw)*(String(raw).length===10?1000:1)).toISOString():raw;
   events.push({carrier:'temu',tracking:p.trackingNumber,code:e.logisticsStatus,label:e.statusText,at});
  }
 }
 return {tracking,events};
}

// A cycle reads fresh carrier evidence, rereads Erplain, and only advances an existing BL.
// This service cannot create labels, BCs, BLs, invoices or payments.
export async function synchronizeTracking({targets,carrier,temuFor,gateway,store,apply=false,shouldStop=()=>false,onRow=async()=>{}}){
 const report={startedAt:new Date().toISOString(),mode:apply?'apply':'preview',rows:[]};
 const cache=new Map(),cooldowns=new Set();
 async function readCarrier(provider,number){
  if(cooldowns.has(provider))throw Error('Collecte suspendue pour ce transporteur après une limitation API');
  await store.assertCarrierAvailable?.(provider);
  const key=JSON.stringify([provider,number]);
  if(!cache.has(key)){
   try{cache.set(key,await carrier.read(provider,'production',number));}
   catch(error){
    if(error.retryAfter>0){
     cooldowns.add(provider);
     await store.deferCarrier?.(provider,error.retryAfter);
    }
    throw error;
   }
  }
  return cache.get(key);
 }
 let verified=false;
 for(const target of targets){
  if(shouldStop())break;
  const row={orderId:target.orderId,reference:target.reference,blId:target.blId,partialId:target.partialId||null,carrier:target.carrier};
  report.rows.push(row);
  try{
   if(target.issue)throw Error(target.issue);
   if(target.environment!=='production')throw Error('Suivi hors production exclu');
   if(!['gls','gofo','temu'].includes(target.carrier))throw Error('Transporteur non pris en charge');
   if(cooldowns.has(target.carrier))throw Error('Collecte suspendue pour ce transporteur après une limitation API');
   let evidence;
   if(target.carrier==='temu')evidence=await readTemuTracking(await temuFor(target),target.reference,target.packages||[],readCarrier);
   else{
    if(!target.tracking?.length)throw Error('Numéros de suivi absents');
    const events=[];
    for(const number of target.tracking)events.push(...await readCarrier(target.carrier,number));
    evidence={tracking:target.tracking,events};
   }
   const physical=trackingEvidence(evidence.tracking,evidence.events);
   row.tracking=evidence.tracking;row.events=evidence.events;row.observedAt=new Date().toISOString();
   row.carrierStatus=physical.status;
   const allDispatched=physical.states.every(state=>['shipped','delivered'].includes(state));
   if(apply&&store.updateLogistics&&physical.complete&&!physical.states.includes('cancelled')&&(physical.status!=='shipped'||allDispatched)){
    await store.assertCurrent(target);
    row.localUpdated=await store.updateLogistics(target,physical.status);
   }
   if(!target.blId||!target.bcId)throw Error('BC ou BL Erplain absent : suivi récupéré, mise à jour Erplain impossible');
   if(!verified){await gateway.verifyLive();verified=true;}
   const execute=async()=>{
    if(shouldStop())throw Error('Arrêt demandé avant écriture');
    await store.assertCurrent(target);
    const bl=await gateway.readBL(target.blId);
    const decision=trackingDecision({...target,tracking:evidence.tracking},evidence.events,bl);
    row.before=bl.status;
    row.proposed=decision.target||null;row.reason=decision.reason;
    if(!decision.write){
     if(apply&&decision.reason==='already_applied'){
      await store.confirm(target,bl.status);
      await store.record('tracking_sync.reconciled',{...row,orderId:target.orderId});
     }
     row.outcome='unchanged';return;
    }
    if(!apply){row.outcome='proposed';return;}
    await store.record('tracking_sync.intent',{...row,orderId:target.orderId});
    await gateway.setBLStatus(target.blId,decision.target);
    const confirmed=await gateway.readBL(target.blId);
    if(confirmed.status!==decision.target)throw Error('Statut Erplain non confirmé : rapprochement au prochain passage');
    trackingDecision({...target,tracking:evidence.tracking},evidence.events,confirmed);
    await store.confirm(target,confirmed.status);
    row.after=confirmed.status;row.outcome='updated';
    await store.record('tracking_sync.confirmed',{...row,orderId:target.orderId});
   };
   if(apply)await store.withLock(target,execute);else await execute();
  }catch(e){
   row.outcome='error';row.error=String(e.message||e).slice(0,500);
   if(apply)await store.record('tracking_sync.error',{...row,orderId:target.orderId});
  }finally{await onRow(row,target);}
 }
 report.finishedAt=new Date().toISOString();
 report.counts=Object.fromEntries(['updated','proposed','unchanged','error'].map(s=>[s,report.rows.filter(r=>r.outcome===s).length]));
 return report;
}
