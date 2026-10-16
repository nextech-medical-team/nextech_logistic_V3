import {currentHoldDiagnostic} from './preparation-recheck-policy.mjs';
import {reconcileTemuParcelDiagnostics} from './temu-parcel-count.mjs';
import {completedHistoricalPreparation,reconcileHistoricalPreparation,currentReplacementPreview,currentResolutionState,resolutionStateSql} from './historical-preparation-completion.mjs';
import {reconcileVerifiedWeights} from './verified-weight-diagnostics.mjs';
import {projectCurrentDiagnostics} from './current-order-diagnostics.mjs';
import {isDeliveredOrder} from './delivered-order.mjs';

// Local diagnostic reconciliation only: no provider mutation, preparation,
// document, stock or label operations. A successful correction is not delivery.
export function correctionStatusSnapshot(order,{erpJob,carrierJob,temuJob,otherReviews=[]}={}){
 if(isDeliveredOrder(order))return {checkedAt:new Date().toISOString(),state:'observed',blockers:[],businessCompleted:false,delivered:true,source:'current-local-diagnostics',providerFreshness:'existing-verified-proofs-only'};
 const current=projectCurrentDiagnostics({...order,erp_live_job:erpJob?{...erpJob}:null});
 const blockers=[current.issue,current.erp_live_job?.error,carrierJob?.error,...otherReviews.map(j=>j.error)].filter(Boolean).map(reason=>/^Pr[ée]paration bloqu[ée]e(?:\s*:\s*v[ée]rification [àa] reprendre| à vérifier)?$/i.test(reason)?currentHoldDiagnostic(order,{erpJob,carrierJob,temuJob}).label:reason);
 if(order.pendingReplacement)blockers.push('Remplacement à confirmer');
 if(order.resolution_pending_resume)blockers.push(currentHoldDiagnostic(order,{erpJob,carrierJob,temuJob}).label);
 if(order.suspension?.active||order.suspension?.erplainCancellation)blockers.push('Commande suspendue');
 if(['pending','processing'].includes(erpJob?.status)||['pending','creating','awaiting_pdf'].includes(carrierJob?.status))blockers.push('Traitement en cours');
 if(order.label_status==='blocked'||order.erp_status==='blocked')blockers.push(currentHoldDiagnostic(order,{erpJob,carrierJob,temuJob}).label);
 return {checkedAt:new Date().toISOString(),state:blockers.length?'needs_review':'observed',blockers:[...new Set(blockers)],businessCompleted:false,source:'current-local-diagnostics',providerFreshness:'existing-verified-proofs-only'};
}
export async function refreshCorrectionStatuses(db,orderId){
 if(!orderId)throw Error('Commande requise pour actualiser les statuts');
 await reconcileVerifiedWeights(db,null,orderId);
 await reconcileTemuParcelDiagnostics(db,orderId);
 let order=(await db.query('SELECT * FROM orders WHERE id=$1',[orderId])).rows[0];
 if(!order)throw Error('Commande introuvable pendant actualisation des statuts');
 const erpJob=(await db.query('SELECT status,error FROM erp_live_jobs WHERE order_id=$1',[orderId])).rows[0];
 order.resolution_actions=(await db.query(resolutionStateSql,[orderId])).rows;
 if(completedHistoricalPreparation(order,erpJob)){const result=await reconcileHistoricalPreparation(db,orderId);if(result.updated)order=(await db.query('SELECT * FROM orders WHERE id=$1',[orderId])).rows[0];}
 const carrierJob=(await db.query('SELECT status,error FROM carrier_jobs WHERE order_id=$1',[orderId])).rows[0];
 const temuJob=order.channel==='temu'?(await db.query('SELECT status,error FROM temu_label_jobs WHERE reference=$1',[order.reference])).rows[0]:null;
 const actions=(await db.query(resolutionStateSql,[orderId])).rows;const {reviews:otherReviews,pendingReplacement}=currentResolutionState(actions);
 return correctionStatusSnapshot({...order,pendingReplacement:pendingReplacement||otherReviews.some(j=>j.action==='replace-equivalent'&&!j.error)},{erpJob,carrierJob,temuJob,otherReviews});
}
