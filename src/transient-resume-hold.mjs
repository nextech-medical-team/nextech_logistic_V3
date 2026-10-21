import {cancellationBlock,retryDecision,pendingTransientRecovery} from './erp-transient-policy.mjs';

// Legacy TEMU resume jobs could finish on BL presence while ERP was still
// working. Reuse only that explicit, completed resume; never a generic hold.
export async function recoverCompletedTemuResumeHolds(db){
 return db.transaction(async tx=>{
  const rows=(await tx.query(`SELECT o.*,e.error,e.updated_at AS retry_updated,latest.proof
   FROM orders o JOIN erp_live_jobs e ON e.order_id=o.id
   JOIN LATERAL (SELECT to_jsonb(r) AS proof FROM resolution_jobs r WHERE r.order_id=o.id
    ORDER BY to_jsonb(r)->>'created_at' DESC NULLS LAST,to_jsonb(r)->>'updated_at' DESC NULLS LAST,to_jsonb(r)->>'id' DESC NULLS LAST LIMIT 1) latest ON true
   WHERE o.channel='temu' AND o.resolution_pending_resume AND NOT o.archived AND NOT o.partial_mode
   AND e.status='review' AND o.erp_live->>'phase'='bl_created'
   AND o.erp_live->'bc'->>'status'='active' AND o.erp_live->'bl'->>'status'='pending'
   AND latest.proof->>'action'='resume' AND latest.proof->>'status'='complete'
   AND latest.proof->'result'->>'resume'='true' AND latest.proof->'result'->>'erpOnly'='true'
   AND latest.proof->'result'->'transientResumeRecovery' IS NULL
   AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting'))
   AND NOT EXISTS(SELECT 1 FROM correction_jobs c WHERE c.order_id=o.id AND c.status IN ('queued','applying','checking','waiting','review'))
   ORDER BY e.updated_at,o.id LIMIT 20 FOR UPDATE OF o,e SKIP LOCKED`)).rows;
  let recovered=0;
  for(const o of rows){
   const p=o.proof,s=o.erp_live,raw=s.transientRecovery?.lastError;
   if(!p?.id||p.error||p.result?.transientResumeRecovery||!s.bc?.id||!s.bl?.id||cancellationBlock(o)
    ||Object.hasOwn(o.suspension||{},'erplainCancellation')
    ||o.duplicate_of||o.source_payload?.marketplacePendingCorrection||o.source_payload?.visibilityHold
    ||o.source_payload?.selectedReimport?.mode==='hold'
    ||o.source_payload?.erplainValidationHold&&o.source_payload?.erplainValidation!=='approved'
    ||!pendingTransientRecovery(o.error)||!raw
    ||!retryDecision({...o,resolution_pending_resume:false},raw,o.retry_updated))continue;
   const completed=new Date(p.updated_at).getTime(),failed=new Date(s.transientRecovery.lastFailureAt).getTime(),updated=new Date(o.retry_updated).getTime();
   if(!Number.isFinite(completed)||!Number.isFinite(failed)||!Number.isFinite(updated)||failed<=completed||failed>updated)continue;
   if(o.suspension?.updatedAt&&(!Number.isFinite(Date.parse(o.suspension.updatedAt))||Date.parse(o.suspension.updatedAt)>=completed))continue;
   // Lock the authorization itself; an edited/completed newer intervention
   // must not be mistaken for the explicit resume observed above.
   const locked=(await tx.query('SELECT to_jsonb(r) AS proof FROM resolution_jobs r WHERE to_jsonb(r)->>\'id\'=$1 FOR UPDATE SKIP LOCKED',[p.id])).rows[0]?.proof;
   if(JSON.stringify(locked)!==JSON.stringify(p))continue;
   const proof={resolutionId:p.id,bcId:String(s.bc.id),blId:String(s.bl.id),previousHold:true,recoveredAt:new Date().toISOString(),reason:'completed_resume_interrupted_after_bl',labelPurchase:'unchanged'};
   await tx.query("UPDATE orders SET resolution_pending_resume=false,erp_live=jsonb_set(erp_live,'{transientRecovery}', $2::jsonb) WHERE id=$1",[o.id,JSON.stringify({...s.transientRecovery,resumeHoldRecovery:proof})]);
   await tx.query("UPDATE resolution_jobs SET result=result||$2::jsonb WHERE to_jsonb(resolution_jobs)->>'id'=$1",[p.id,JSON.stringify({transientResumeRecovery:proof})]);
   recovered++;
  }
  return recovered;
 });
}
