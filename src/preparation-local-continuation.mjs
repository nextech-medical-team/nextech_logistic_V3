import {usesRecordedBc} from './existing-bc-execution.mjs';
import {assertLabelStockGate} from './label-stock-gate.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {currentMappingFingerprint} from './current-mapping-line.mjs';
import {documentBusySql} from './erplain-document-read.mjs';
import {currentResolutionState,resolutionStateSql} from './historical-preparation-completion.mjs';
import {suspensionBlock} from './order-suspension.mjs';

export function freshContinuationProof(o,now=Date.now()){
 const p=o?.erp_live,r=p?.bcComparisonRefresh,t=Date.parse(r?.checkedAt);
 return !!(o&&!o.archived&&!o.simulation&&!o.partial_mode&&!o.issue&&!o.resolution_pending_resume&&!suspensionBlock(o)&&!o.source_payload?.erplainValidationHold&&!o.source_payload?.visibilityHold&&!o.source_payload?.marketplacePendingCorrection&&p?.phase==='bc_created'&&p.bc?.status==='active'&&p.bc.id&&!p.bl?.id&&!p.stockDocument?.id&&!p.stockCreationAttemptedAt&&(usesRecordedBc(o)||p.pricing?.status==='verified')&&(usesRecordedBc(o)||!p.pricing?.error)&&r?.readOnly===true&&r.preparationNotStarted===true&&String(r.bcId)===String(p.bc.id)&&r.comparison?.scope==='full'&&r.comparison.different===false&&Array.isArray(r.errors)&&r.errors.length===0&&!r.identityUnconfirmed&&/^[a-f0-9]{64}$/.test(r.mappingFingerprint||'')&&Number.isFinite(t)&&t<=now&&now-t<=15*60000);
}
// A completed read is already evidence; waiting for another external batch must
// not strand the preparation. This only queues the existing guarded ERP worker.
export async function continuePreparationFromFreshRead(db,orderId,{enabled=()=>true,canResume=()=>true,now=()=>Date.now()}={}){
 if(!enabled()||!canResume())return {queued:false};
 return db.transaction(async tx=>{
  const o=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[orderId])).rows[0];
  if(!enabled()||!canResume()||!freshContinuationProof(o,now()))return {queued:false};
  const e=(await tx.query('SELECT status,error FROM erp_live_jobs WHERE order_id=$1 FOR UPDATE',[orderId])).rows[0];
  if(e?.status!=='review'||e.error!==null||(await tx.query(documentBusySql,[orderId])).rows.length||(await tx.query("SELECT 1 FROM correction_jobs WHERE order_id=$1 AND status IN ('queued','applying','checking','waiting') LIMIT 1",[orderId])).rows.length)return {queued:false};
  const actions=(await tx.query(resolutionStateSql,[orderId])).rows,state=currentResolutionState(actions);
  if(state.reviews.length||state.pendingReplacement||actions[0]?.result?.readOnly||actions[0]?.result?.resumeAfter===false)return {queued:false};
  await tx.query('SELECT id FROM lines WHERE order_id=$1 FOR SHARE',[orderId]);
  await tx.query('SELECT source_sku FROM mappings WHERE channel=$2 AND source_sku IN (SELECT source_sku FROM lines WHERE order_id=$1) FOR SHARE',[orderId,o.channel]);
  const proof=o.erp_live.bcComparisonRefresh;
  if((!usesRecordedBc(o)&&await currentMappingFingerprint(tx,o)!==proof.mappingFingerprint)||!enabled()||!canResume())return {queued:false};
  const requestId='fresh-bc-continuation-'+createHash('sha256').update(JSON.stringify([orderId,proof.bcId,proof.checkedAt,proof.mappingFingerprint])).digest('hex'),id=randomUUID();
  const result={erpOnly:true,existingLabelsPreserved:true,automaticRecheck:true,afterFreshComparison:true,checkedAt:proof.checkedAt,mappingFingerprint:proof.mappingFingerprint};
  const queued=await tx.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,payload,result) SELECT $1,$2,$3,'resume-erp',$4,$5 WHERE NOT EXISTS(SELECT 1 FROM resolution_jobs WHERE order_id=$2 AND status IN ('pending','queued','running','waiting','processing')) ON CONFLICT DO NOTHING RETURNING id",[id,orderId,requestId,JSON.stringify({id:orderId,requestId,action:'resume-erp',type:'stock',resumeAfter:true}),JSON.stringify(result)]);
  if(!queued.rows.length)return {queued:false};
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system:order-recheck','resolution.requested',$1)",[JSON.stringify({id,orderId,action:'resume-erp',...result})]);
  return {queued:true,id};
 });
}

export function completedContinuationForPurchase(o,now=Date.now()){
 const p=o?.erp_live;
 return !!(o?.channel==='temu'&&o.resolution_pending_resume&&!o.archived&&!o.simulation&&!o.partial_mode&&!o.issue&&!suspensionBlock(o)&&!o.source_payload?.erplainValidationHold&&!o.source_payload?.visibilityHold&&!o.source_payload?.marketplacePendingCorrection&&p?.phase==='bl_ready'&&p.bc?.status==='active'&&p.bl?.id&&p.bl.status==='ready_to_ship'&&(usesRecordedBc(o)||p.pricing?.status==='verified')&&(usesRecordedBc(o)||!p.pricing?.error)&&p.stockDocument?.id&&p.stockDocument.status==='completed'&&p.stockDocument.update_stock===true&&[p.verifiedAt,p.stockCheckedAt].every(v=>Number.isFinite(Date.parse(v))&&Date.parse(v)<=now&&now-Date.parse(v)<=15*60000));
}
export async function releaseCompletedContinuationForPurchase(db,orderId,{enabled=()=>true,canResume=()=>true,now=()=>Date.now()}={}){
 if(!enabled()||!canResume())return {updated:false};
 return db.transaction(async tx=>{
  const o=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[orderId])).rows[0];
  if(!enabled()||!canResume()||!completedContinuationForPurchase(o,now()))return {updated:false};
  const e=(await tx.query('SELECT status,error FROM erp_live_jobs WHERE order_id=$1 FOR UPDATE',[orderId])).rows[0];
  if(e?.status!=='complete'||e.error!==null||(await tx.query(documentBusySql,[orderId])).rows.length||(await tx.query("SELECT 1 FROM correction_jobs WHERE order_id=$1 AND status IN ('pending','queued','running','applying','checking','waiting') LIMIT 1",[orderId])).rows.length)return {updated:false};
  const actions=(await tx.query(resolutionStateSql,[orderId])).rows,state=currentResolutionState(actions),j=actions[0];
  if(state.reviews.length||state.pendingReplacement||j?.action!=='resume-erp'||j.status!=='complete'||j.error||j.result?.erpOnly!==true||j.result.readOnly||j.result.resumeAfter===false)return {updated:false};
  // The ERP worker replaces its transient result; the pre-request audit retains provenance.
  const origin=(await tx.query("SELECT detail FROM audit WHERE user_email='system:order-recheck' AND action='resolution.requested' AND detail->>'id'=$1 AND detail->>'afterFreshComparison'='true' LIMIT 1",[j.id])).rows[0]?.detail;
  if(origin?.automaticRecheck!==true||origin.erpOnly!==true||origin.mappingFingerprint!==o.erp_live.mappingPreparationFingerprint)return {updated:false};
  const label=(await tx.query('SELECT status,error,attempt_id,packages FROM temu_label_jobs WHERE reference=$1 FOR UPDATE',[o.reference])).rows[0];
  if(!label||!['ready','to_buy'].includes(label.status)||label.error||label.attempt_id||!Array.isArray(label.packages)||label.packages.length||(await tx.query('SELECT 1 FROM temu_label_documents WHERE reference=$1 LIMIT 1',[o.reference])).rows.length||(await tx.query('SELECT 1 FROM carrier_jobs WHERE order_id=$1 LIMIT 1',[orderId])).rows.length)return {updated:false};
  await tx.query('SELECT id FROM lines WHERE order_id=$1 FOR SHARE',[orderId]);
  await tx.query('SELECT source_sku FROM mappings WHERE channel=$2 AND source_sku IN (SELECT source_sku FROM lines WHERE order_id=$1) FOR SHARE',[orderId,o.channel]);
  if(!o.erp_live.mappingPreparationFingerprint||(!usesRecordedBc(o)&&await currentMappingFingerprint(tx,o)!==o.erp_live.mappingPreparationFingerprint))return {updated:false};
  try{await assertLabelStockGate(tx,o);}catch{return {updated:false};}
  if(!enabled()||!canResume())return {updated:false};
  await tx.query('UPDATE orders SET resolution_pending_resume=false WHERE id=$1',[orderId]);
  await tx.query("UPDATE resolution_jobs SET result=result||$2::jsonb WHERE id=$1",[j.id,JSON.stringify({purchaseAdmissionReady:true,message:'Préparation Erplain vérifiée ; étiquette TEMU soumise au contrôle automatique de marge et de transporteur.'})]);
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system:order-recheck','preparation.continuation_completed',$1)",[JSON.stringify({orderId,resolutionId:j.id,bcId:o.erp_live.bc.id,blId:o.erp_live.bl.id,stockDocumentId:o.erp_live.stockDocument.id,newLabelAdmissionOnly:true,providerWrites:0})]);
  return {updated:true};
 });
}
