import {maskedTemuAddressFields,usableFrozenAddress} from './temu-address-observation.mjs';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {obsoleteTemuVisibilityError,pureTemuSourceReadError} from './temu-catchup-policy.mjs';
import {sourceFingerprint} from './marketplace-comparison.mjs';
const sourceRows=rows=>rows.map(l=>{const skus=[...new Set((l.productList||[]).map(p=>p.extCode).filter(Boolean))];return {source_line:l.orderSn,source_sku:skus.length===1?skus[0]:null,quantity:l.quantity};});
const ordered=rows=>rows.map(l=>({id:String(l.source_line||l.orderSn),sku:l.source_sku||[...new Set((l.productList||[]).map(p=>p.extCode).filter(Boolean))][0],quantity:Number(l.quantity)})).sort((a,b)=>a.id.localeCompare(b.id));
export async function reconcileTemuCatchup(tx,order,observation){
 if(observation.reference!==(order.source_reference||order.reference)||!observation.coreComplete)throw Error('TEMU · Rapprochement source incomplet');
 const source=structuredClone(order.source_payload||{}),fresh=observation.payload;
 const priorPartial=source.temuCatchupPartial;delete source.temuCatchupPartial;
 const previousVersion=Math.max(Number(source.temuOrderDetail?.parentOrderMap?.updateTime)||0,Number(source.temuReceiptObservation?.payload?.detail?.parentOrderMap?.updateTime)||0,Number(priorPartial?.sourceVersion)||0,Number(source.temuSourceRead?.sourceVersion)||0);
 if(Number.isFinite(previousVersion)&&previousVersion>0&&Number(observation.sourceVersion)<previousVersion)throw Object.assign(Error('TEMU · Réponse source antérieure à la version enregistrée'),{code:'TEMU_STALE_SOURCE',field:'version'});
 const lines=(await tx.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY source_line FOR UPDATE',[order.id])).rows;
 const context=(await tx.query(`SELECT
 EXISTS(SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND status='review' AND error='TEMU · Import incomplet : coordonnées ou détail indisponibles, reprise après nouvelle lecture TEMU') AS initial_import_review,
 EXISTS(SELECT 1 FROM carrier_documents WHERE order_id=$1) OR EXISTS(SELECT 1 FROM carrier_jobs WHERE order_id=$1)
 OR EXISTS(SELECT 1 FROM temu_label_jobs WHERE reference=$2 AND (attempt_id IS NOT NULL OR jsonb_array_length(packages)>0))
 OR EXISTS(SELECT 1 FROM partial_deliveries WHERE order_id=$1) OR EXISTS(SELECT 1 FROM extra_parcels WHERE order_id=$1) AS prepared,
 EXISTS(SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND status='processing')
 OR EXISTS(SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting'))
 OR EXISTS(SELECT 1 FROM correction_jobs WHERE order_id=$1 AND status IN ('applying','checking')) AS busy`,[order.id,order.reference])).rows[0];
 if(!context||context.busy)throw Object.assign(Error('TEMU · Traitement local en cours'),{code:'TEMU_LOCAL_BUSY',field:'local'});
 const originals=order.erp_live?.equivalentOriginalLines;
 const protectedData=originals!==undefined||Number(fresh.detail.parentOrderMap.parentOrderStatus)===3||context.prepared||order.archived||order.partial_mode||order.suspension?.active||order.erp_live?.bc?.id||order.erp_live?.bl?.id||order.erp_live?.stockDocument?.id||order.erp_live?.stockCreationAttemptedAt||lines.some(l=>l.target_sku!=null||l.target_quantity!=null)||['shipped','in_transit','delivered'].includes(order.tracking_status);
 const masked=maskedTemuAddressFields(fresh.shipping);if(masked.length&&!usableFrozenAddress(order.address))throw Object.assign(Error('TEMU · Adresse initiale complète requise : coordonnées source masquées'),{code:'TEMU_INCOMPLETE',field:'shipping'});
 const s=fresh.shipping,address={name:s.receiptName,street:[s.addressLine1,s.addressLine2,s.addressLine3].filter(Boolean).join(', '),postal:s.postCode,city:s.regionName3,country:fresh.country,phone:s.mobile||'',email:s.mail||''};
 // Compare the customer's source units to the preserved source snapshot.
 // The replacement and its Erplain quantities remain operational data.
 const active=fresh.detail.orderList.filter(l=>Number(l.quantity)>0);
 const baseline=sourceFingerprint(originals===undefined?lines:originals),incoming=sourceFingerprint(sourceRows(active));
 const sameLines=baseline!==null&&incoming!==null&&baseline===incoming;
 const sameAddress=['name','street','postal','city','country'].every(k=>masked.includes(k)||String(order.address?.[k]||'')===String(address[k]||''));
 const oldAmounts=source.temuAmounts?.data||source.temuOrderDetail?.v3Amounts?.data;
 const sameAmounts=!oldAmounts||isDeepStrictEqual(oldAmounts,fresh.amounts);
 const conflicts=[];if(protectedData&&!sameLines)conflicts.push('articles/quantités');if((protectedData||usableFrozenAddress(order.address))&&!sameAddress)conflicts.push('adresse');if(protectedData&&!sameAmounts)conflicts.push('montants');
 // Status/cancellation facts are indicative; never apply a business cancellation here.
 source.platformStatusObservation={channel:'temu',payload:{detail:fresh.detail,shipping:fresh.shipping,country:fresh.country},observedAt:observation.checkedAt,indicative:true};
 source.temuCatchup={checkedAt:observation.checkedAt,coverage:observation.coverage,complete:observation.complete,coreComplete:true,conflicts,errors:observation.errors,shipments:fresh.shipments||[],packages:fresh.packages||[],externalWrites:0};
 let nextAddress=order.address,recipient=order.recipient,issue=order.issue;
 // An older read may have filled the source but failed to reconnect the
 // existing initial-review job because the source refusal was compound.
 const strandedInitialReview=context.initial_import_review&&source.visibilityRecoveredAt&&source.temuSourceRead?.state==='verified'&&source.temuCatchup?.coreComplete===true&&!source.temuCatchup?.conflicts?.length&&!order.erp_live?.phase&&!order.erp_live?.customer?.id;
 const initialIncomplete=!protectedData&&((source.visibilityHold===true&&!lines.length)||source.temuInitialPreparationPending===true||strandedInitialReview);
 const initialSourceOnly=initialIncomplete&&(!issue||obsoleteTemuVisibilityError(issue)||pureTemuSourceReadError(issue)||priorPartial?.currentReason&&issue===priorPartial.currentReason||issue==='Données TEMU récupérées · Préparation à vérifier'||issue==='Adresse masquée : adresse initiale complète requise avant préparation'||issue==='TEMU · Import incomplet : coordonnées ou détail indisponibles, reprise après nouvelle lecture TEMU'||issue==='TEMU · Coordonnées de livraison absentes · Lecture automatique planifiée');
 if(!conflicts.length){
  const pending=source.marketplacePendingCorrection;
  const falseEquivalentConflict=originals!==undefined&&observation.complete&&sameLines&&sameAddress&&sameAmounts
   &&Array.isArray(pending?.sourceCatchupConflicts)&&pending.sourceCatchupConflicts.length===1&&pending.sourceCatchupConflicts[0]==='articles/quantités'
   &&Array.isArray(pending.detail?.orderList)&&sourceFingerprint(sourceRows(pending.detail.orderList.filter(l=>Number(l.quantity)>0)))===baseline
   &&issue==='TEMU · Données source différentes : articles/quantités · Rapprochement à vérifier';
  if(falseEquivalentConflict){delete source.marketplacePendingCorrection;issue=null;source.temuEquivalentSourceReconciliation={checkedAt:observation.checkedAt,baseline:'equivalentOriginalLines',externalWrites:0};}
  if(!protectedData){if(!usableFrozenAddress(order.address)){nextAddress={...order.address,...address};recipient=address.name;}
   if(!sameLines){const keep=new Set(active.map(l=>l.orderSn));for(const l of lines)if(!keep.has(l.source_line))await tx.query('DELETE FROM lines WHERE id=$1 AND order_id=$2',[l.id,order.id]);
    for(const l of active){const old=lines.find(x=>x.source_line===l.orderSn),sku=ordered([l])[0].sku,raw={...(old?.source_payload||{}),goodsName:l.goodsName,skuId:l.skuId,productList:l.productList,marketplaceQuantity:Number(l.quantity),temuOrderSn:l.orderSn,mallId:source.mallId||source.sourceShop};
     if(old)await tx.query('UPDATE lines SET source_sku=$3,quantity=$4,source_payload=$5::jsonb WHERE id=$1 AND order_id=$2',[old.id,order.id,sku,l.quantity,JSON.stringify(raw)]);
     else await tx.query('INSERT INTO lines(id,order_id,source_line,source_sku,quantity,source_payload) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[randomUUID(),order.id,l.orderSn,sku,l.quantity,JSON.stringify(raw)]);
    }
   }
  }
  source.temuOrderDetail={...fresh.detail,v3Amounts:{data:fresh.amounts}};source.temuShippingInfo=fresh.shipping;source.sourceCountry=fresh.country;
  source.temuAmounts={at:observation.checkedAt,data:fresh.amounts};source.temuAmountsError=null;
  if(observation.complete){delete source.temuReceiptObservation;delete source.visibilityReadError;if(source.marketplacePendingCorrection?.visibilityHold===true)delete source.marketplacePendingCorrection;}
  source.temuSourceRead={state:'verified',status:Number(fresh.detail.parentOrderMap.parentOrderStatus),verifiedAt:observation.checkedAt,sourceVersion:observation.sourceVersion};
  if(!source.temuDirect)source.temuDirect={source:'temu_direct',state:'verified',status:Number(fresh.detail.parentOrderMap.parentOrderStatus),verifiedAt:observation.checkedAt};
  source.sourceCoverage={complete:observation.complete,coreComplete:true,sourceStage:observation.sourceStage,fields:observation.coverage,errors:observation.errors};
  if(source.visibilityHold===true&&observation.complete){source.visibilityHold=false;source.visibilityRecoveredAt=observation.checkedAt;delete source.visibilityReason;delete source.visibilityReadError;if(initialSourceOnly)issue='Données TEMU récupérées · Préparation à vérifier';}
  if(pureTemuSourceReadError(issue)||priorPartial?.currentReason&&issue===priorPartial.currentReason)issue=null;
  if(source.marketplacePendingCorrection?.visibilityError&&obsoleteTemuVisibilityError(source.marketplacePendingCorrection.visibilityError)&&sameLines&&sameAddress)delete source.marketplacePendingCorrection;
 }else{
  // A changed prepared order goes to precise review. Keep all operational data.
  source.marketplacePendingCorrection={detail:fresh.detail,shipping:fresh.shipping,country:fresh.country,sourceCatchupConflicts:conflicts};
  if(!issue||obsoleteTemuVisibilityError(issue))issue='TEMU · Données source différentes : '+conflicts.join(', ')+' · Rapprochement à vérifier';
 }
 if(initialSourceOnly)source.temuInitialPreparationPending=true;
 await tx.query('UPDATE orders SET address=$2::jsonb,recipient=$3,source_payload=$4::jsonb,issue=$5 WHERE id=$1',[order.id,JSON.stringify(nextAddress),recipient,JSON.stringify(source),issue]);
 // Reuse the established initial-import recovery only within its existing
 // reception/live authorization. This queues preparation, never a TEMU purchase.
 let initialRecovered=false;
 if(initialSourceOnly&&observation.complete&&!conflicts.length&&!source.temuDirect?.attemptedAt&&!source.externalLabel){
  const controls=Object.fromEntries((await tx.query("SELECT key,value FROM settings WHERE key IN ('automatic_live','marketplace_automatic')")).rows.map(r=>[r.key,r.value]));
  const {withinReceptionStart}=await import('./order-visibility.mjs');
  if(controls.automatic_live?.enabled===true&&controls.marketplace_automatic?.enabled===true&&controls.marketplace_automatic.channels?.temu!==false&&withinReceptionStart('temu',{detail:fresh.detail},controls.marketplace_automatic)){
   const {recoverCompleteTemuImport}=await import('./temu-import-recovery.mjs');
   initialRecovered=await recoverCompleteTemuImport(tx,order,{reference:order.reference,version:new Date(Number(observation.sourceVersion)*1000).toISOString(),lines:active},{channel:'temu',shop:String(source.sourceShop||source.mallId||'')});
  }
 }
 if(initialRecovered)await tx.query("UPDATE orders SET source_payload=source_payload-'temuInitialPreparationPending' WHERE id=$1",[order.id]);
 // Trigger and explicit wakeup use the existing local diagnostic/resumption circuit.
 await tx.query('UPDATE order_recheck_monitor SET next_check=now(),requested=requested+1 WHERE order_id=$1',[order.id]);
 await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system:temu-catchup','temu.source.reconciled',$1::jsonb)",[JSON.stringify({orderId:order.id,conflicts,initialIncomplete,externalWrites:0,documentsPreserved:true})]);
 return {conflicts,initialIncomplete,initialRecovered};
}

export async function observeTemuSourceStage(tx,order,observation){
 if(!observation.requiredComplete||!['pending','cancelled'].includes(observation.sourceStage)||observation.reference!==(order.source_reference||order.reference))throw Error('TEMU · État source non vérifiable');
 const source=structuredClone(order.source_payload||{}),fresh=observation.payload;
 const priorPartial=source.temuCatchupPartial;delete source.temuCatchupPartial;
 const previousVersion=Math.max(Number(source.temuOrderDetail?.parentOrderMap?.updateTime)||0,Number(source.temuReceiptObservation?.payload?.detail?.parentOrderMap?.updateTime)||0,Number(priorPartial?.sourceVersion)||0,Number(source.temuSourceRead?.sourceVersion)||0);
 if(Number.isFinite(previousVersion)&&previousVersion>0&&Number(observation.sourceVersion)<previousVersion)throw Object.assign(Error('TEMU · État source antérieur à la version enregistrée'),{code:'TEMU_STALE_SOURCE',field:'version'});
 source.platformStatusObservation={channel:'temu',payload:{detail:fresh.detail,country:fresh.country},observedAt:observation.checkedAt,indicative:true};
 source.sourceCoverage={complete:observation.complete,coreComplete:observation.coreComplete,requiredComplete:true,sourceStage:observation.sourceStage,fields:observation.coverage,errors:observation.errors};
 delete source.temuReceiptObservation;
 const previousCatchup=source.temuCatchup;
 const stageReason=observation.sourceStage==='cancelled'?'TEMU · État source annulé (observation indicative)':'TEMU · Commande en attente (observation indicative)';
 const missingAddress=['name','street','postal','city','country'].some(k=>!String(order.address?.[k]||'').trim());
 const localLines=Number((await tx.query('SELECT count(*) AS n FROM lines WHERE order_id=$1 AND quantity>0',[order.id])).rows[0].n);
 const currentReason=missingAddress?'TEMU · Coordonnées de livraison absentes · Lecture automatique planifiée':!localLines?'TEMU · Articles locaux absents · Rapprochement des données à vérifier':null;
 source.temuCatchup={checkedAt:observation.checkedAt,coverage:observation.coverage,complete:false,coreComplete:false,requiredComplete:true,sourceStage:observation.sourceStage,stageReason,currentReason,expectedUnavailable:observation.expectedUnavailable,conflicts:[],errors:observation.errors,shipments:fresh.shipments||[],packages:fresh.packages||[],externalWrites:0};
 const issue=!order.issue||obsoleteTemuVisibilityError(order.issue)||previousCatchup?.currentReason&&order.issue===previousCatchup.currentReason?currentReason:order.issue;
 await tx.query('UPDATE orders SET source_payload=$2::jsonb,issue=$3 WHERE id=$1',[order.id,JSON.stringify(source),issue]);
 await tx.query('UPDATE order_recheck_monitor SET next_check=now(),requested=requested+1 WHERE order_id=$1',[order.id]);
 await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system:temu-catchup','temu.source.stage-observed',$1::jsonb)",[JSON.stringify({orderId:order.id,sourceStage:observation.sourceStage,externalWrites:0,documentsPreserved:true})]);
 return {sourceStage:observation.sourceStage,stageReason,currentReason,conflicts:[]};
}
