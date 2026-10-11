import {createHash,randomUUID} from 'node:crypto';
import {currentMappingFingerprint} from './current-mapping-line.mjs';
import {documentBusySql} from './erplain-document-read.mjs';
import {currentResolutionState,resolutionStateSql} from './historical-preparation-completion.mjs';
import {suspensionBlock} from './order-suspension.mjs';

export function freshContinuationProof(o,now=Date.now()){
 const p=o?.erp_live,r=p?.bcComparisonRefresh,t=Date.parse(r?.checkedAt);
 return !!(o&&!o.archived&&!o.simulation&&!o.partial_mode&&!o.issue&&!o.resolution_pending_resume&&!suspensionBlock(o)&&!o.source_payload?.erplainValidationHold&&!o.source_payload?.visibilityHold&&!o.source_payload?.marketplacePendingCorrection&&p?.phase==='bc_created'&&p.bc?.status==='active'&&p.bc.id&&!p.bl?.id&&!p.stockDocument?.id&&!p.stockCreationAttemptedAt&&p.pricing?.status==='verified'&&!p.pricing.error&&r?.readOnly===true&&r.preparationNotStarted===true&&String(r.bcId)===String(p.bc.id)&&r.comparison?.scope==='full'&&r.comparison.different===false&&Array.isArray(r.errors)&&r.errors.length===0&&!r.identityUnconfirmed&&/^[a-f0-9]{64}$/.test(r.mappingFingerprint||'')&&Number.isFinite(t)&&t<=now&&now-t<=15*60000);
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
  if(await currentMappingFingerprint(tx,o)!==proof.mappingFingerprint||!enabled()||!canResume())return {queued:false};
  const requestId='fresh-bc-continuation-'+createHash('sha256').update(JSON.stringify([orderId,proof.bcId,proof.checkedAt,proof.mappingFingerprint])).digest('hex'),id=randomUUID();
  const result={erpOnly:true,existingLabelsPreserved:true,automaticRecheck:true,afterFreshComparison:true,checkedAt:proof.checkedAt,mappingFingerprint:proof.mappingFingerprint};
  const queued=await tx.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,payload,result) SELECT $1,$2,$3,'resume-erp',$4,$5 WHERE NOT EXISTS(SELECT 1 FROM resolution_jobs WHERE order_id=$2 AND status IN ('pending','queued','running','waiting','processing')) ON CONFLICT DO NOTHING RETURNING id",[id,orderId,requestId,JSON.stringify({id:orderId,requestId,action:'resume-erp',type:'stock',resumeAfter:true}),JSON.stringify(result)]);
  if(!queued.rows.length)return {queued:false};
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system:order-recheck','resolution.requested',$1)",[JSON.stringify({id,orderId,action:'resume-erp',...result})]);
  return {queued:true,id};
 });
}
