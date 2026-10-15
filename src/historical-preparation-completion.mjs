import {usesRecordedBc,retiredRecordedBcSourceReview} from './existing-bc-execution.mjs';
import {closedStockReview,reopenedStockReview} from './stock-incident-recheck.mjs';
import {currentMappingFingerprint} from './current-mapping-line.mjs';
import {oldFinanceErrors,projectCurrentDiagnostics} from './current-order-diagnostics.mjs';
import {shipmentFingerprint} from './label-stock-gate.mjs';
import {suspensionBlock} from './order-suspension.mjs';
export function currentReplacementPreview(j){return j?.action==='equivalent-preview'&&j.status==='complete'&&!j.error&&!!j.result?.replacementSku&&!j.result?.reconcileOnly;}
export const resolutionStateSql="SELECT action,status,error,result,created_at,id FROM (SELECT DISTINCT ON (action) action,status,error,result,created_at,id FROM resolution_jobs WHERE order_id=$1 ORDER BY action,created_at DESC,id DESC) current_actions ORDER BY created_at DESC,id DESC";
export function currentResolutionState(actions=[]){
 actions=Array.isArray(actions)?actions:[];
 const preparation=new Set(['resume-erp','resume','replace-equivalent','reconcile-bc','compare-bc','manual-temu-pricing','equivalent-preview','refresh','create-product']);
 const completed=actions.findIndex(j=>['resume-erp','resume','replace-equivalent'].includes(j.action)&&j.status==='complete'&&!j.error&&!j.result?.partialRemainder);
 const reviews=actions.filter((j,i)=>j.status==='review'&&!closedStockReview(j)&&!retiredRecordedBcSourceReview(j)&&(reopenedStockReview(j)||!preparation.has(j.action)||completed<0||i<completed));
 const applied=actions.findIndex(j=>j.action==='replace-equivalent'&&j.status==='waiting'&&!j.error&&j.result?.equivalent===true&&j.result?.erpOnly===true&&!j.result?.partialRemainder&&!j.result?.importDeferred);
 const preview=actions.findIndex(currentReplacementPreview);return {reviews,pendingReplacement:preview>=0&&(completed<0||preview<completed)&&(applied<0||preview<applied)};
}
const historicalReason='Reprise historique \u00e0 v\u00e9rifier : BL non cr\u00e9\u00e9';
export function completedHistoricalPreparation(o,e,now=Date.now()){
 const p=o.erp_live,pricing=p?.pricing;
 const completedResume=(o.resolution_actions||[]).find(j=>['resume-erp','resume','replace-equivalent'].includes(j.action)&&j.status==='complete'&&!j.error&&!j.result?.partialRemainder);
 const successfulResume=!!completedResume&&(o.issue==null||oldFinanceErrors.includes(o.issue)||o.issue===historicalReason);
 if(o.label_status!=='blocked'||(!successfulResume&&!oldFinanceErrors.includes(o.issue)&&o.issue!==historicalReason))return false;
 if(o.archived||o.simulation||o.partial_mode||(o.resolution_pending_resume&&!successfulResume)||suspensionBlock(o)||(!usesRecordedBc(o)&&o.source_payload?.marketplacePendingCorrection)||o.source_payload?.visibilityHold||o.source_payload?.erplainValidationHold)return false;
 if(successfulResume){
  const state=currentResolutionState(o.resolution_actions),started=Date.parse(completedResume.created_at);
  if(state.reviews.length||state.pendingReplacement||o.resolution_actions.some(j=>['pending','running','waiting','processing','queued'].includes(j.status))||!Number.isFinite(started))return false;
  if([p?.verifiedAt,p?.stockCheckedAt].some(t=>!Number.isFinite(Date.parse(t))||Date.parse(t)<started))return false;
 }
 if(e?.status!=='complete'||e.error!==null||p?.phase!=='bl_ready'||p.bc?.status!=='active'||!p.bc?.id||!p.bl?.id||!['ready_to_ship','shipped','delivered','completed'].includes(p.bl.status))return false;
 if((!usesRecordedBc(o)&&(pricing?.status!=='verified'||pricing.error||pricing.confirmed?.authority!=='erplain'||!Number.isFinite(pricing.confirmed.total)||!Number.isFinite(pricing.confirmed.sourceTotal)))||(!p.historicalStockProof&&!p.stockDocument?.id))return false;
 if(o.channel==='temu'&&!usesRecordedBc(o)){const source=o.source_payload?.temuAmounts?.data?.parentOrderMap?.estimatedRevenue,basis=pricing.commercialBasis;if(basis?.field!=='estimatedRevenue'||!source||basis.sourceEstimatedRevenue?.amount!==source.amount||basis.sourceEstimatedRevenue?.currency!==source.currency)return false;}
 if(!p.stockDocument?.id){const stock=p.historicalStockProof;if(stock.stockOnBc!==true||String(stock.bcId)!==String(p.bc.id)||!Array.isArray(stock.quantities)||!Array.isArray(stock.logIds))return false;}
 if(!/^[a-f0-9]{64}$/.test(p.mappingPreparationFingerprint||'')||!/^[a-f0-9]{64}$/.test(p.labelPreparationFingerprint||''))return false;
 for(const value of [p.verifiedAt,p.stockCheckedAt]){const t=Date.parse(value);if(!Number.isFinite(t)||t>now||now-t>86400000)return false;}
 if(!usesRecordedBc(o)&&(successfulResume||oldFinanceErrors.includes(o.issue))){const issue=projectCurrentDiagnostics(structuredClone(o)).issue;if(issue!==null&&!(successfulResume&&o.issue===historicalReason&&issue===historicalReason))return false;}
 return true;
}
export async function reconcileHistoricalPreparation(db,orderId,{fingerprint=shipmentFingerprint,mappingFingerprint=currentMappingFingerprint}={}){
 return db.transaction(async tx=>{
  const o=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[orderId])).rows[0];if(!o)return {updated:false};
  o.resolution_actions=(await tx.query(resolutionStateSql,[orderId])).rows;
  if((await tx.query("SELECT id FROM resolution_jobs WHERE order_id=$1 AND status IN ('pending','running','waiting','processing','queued') LIMIT 1",[orderId])).rows.length)return {updated:false};
  const e=(await tx.query('SELECT status,error FROM erp_live_jobs WHERE order_id=$1',[orderId])).rows[0];if(!completedHistoricalPreparation(o,e))return {updated:false};
  if(await fingerprint(tx,o)!==o.erp_live.labelPreparationFingerprint)return {updated:false};
  if(!usesRecordedBc(o)&&await mappingFingerprint(tx,o)!==o.erp_live.mappingPreparationFingerprint)return {updated:false};
  let complete=false;
  if(o.channel==='temu'){
   const j=(await tx.query('SELECT status,error,packages FROM temu_label_jobs WHERE reference=$1 FOR SHARE',[o.reference])).rows[0];
   const docs=(await tx.query('SELECT package,octet_length(pdf) bytes FROM temu_label_documents WHERE reference=$1 FOR SHARE',[o.reference])).rows;
   complete=j?.status==='complete'&&j.error===null&&Array.isArray(j.packages)&&j.packages.length>0&&j.packages.every(p=>docs.some(d=>d.package===p&&Number(d.bytes)>0));
  }else{
   const j=(await tx.query('SELECT status,error,environment,tracking FROM carrier_jobs WHERE order_id=$1 FOR SHARE',[orderId])).rows[0];
   const docs=(await tx.query('SELECT document_index,octet_length(pdf) bytes FROM carrier_documents WHERE order_id=$1 FOR SHARE',[orderId])).rows;
   complete=j?.status==='ready'&&j.error===null&&j.environment==='production'&&Array.isArray(j.tracking)&&j.tracking.length>0&&j.tracking.every((t,i)=>!!t&&docs.some(d=>Number(d.document_index)===i&&Number(d.bytes)>0));
  }
  if(!complete)return {updated:false};
  await tx.query("UPDATE orders SET label_status='production_ready',issue=null,resolution_pending_resume=false WHERE id=$1",[orderId]);
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system:historical-completion','diagnostic.historical_preparation_completed',$1)",[JSON.stringify({orderId,previousIssue:o.issue,previousLabelStatus:o.label_status,bcId:o.erp_live.bc.id,blId:o.erp_live.bl.id,verifiedAt:o.erp_live.verifiedAt,stockCheckedAt:o.erp_live.stockCheckedAt,labelPreparationFingerprint:o.erp_live.labelPreparationFingerprint,labelsPreserved:true})]);
  return {updated:true};
 });
}
