import {shipmentFingerprint} from './label-stock-gate.mjs';
import {cancellationBlock} from './erp-transient-policy.mjs';

// Complete only the diagnostic's already-finished ERP continuation. No business retry.
export function completedErpReview(x,currentFingerprint){
 const o=x.order||{},s=o.erp_live||{},r=x.result||{};
 const historical=Math.max(Date.parse(x.created_at),Date.parse(x.updated_at));
 const later=t=>Number.isFinite(historical)&&Number.isFinite(Date.parse(t))&&Date.parse(t)>historical;
 const reason=/^BL bloqué — stock insuffisant : .+/.test(x.error||'')||/^Incident temporaire Erplain : rapprochement et reprise automatique en attente \(\d+\/\d+\)$/.test(x.error||'');
 const expectedStock='V3FS-'+o.id+(s.previousCancelledCycle?'-BC'+s.bc?.id:'');
 return Boolean(x.status==='review'&&x.stage==='Erplain à compléter'&&r.resume===true&&r.regenerateExisting!==true&&reason
  &&['refresh','mapping','weight','create-product','activate-product','select-product','address','relay'].includes(x.action)
  &&o.archived===false&&!o.duplicate_of&&!o.partial_mode&&!o.resolution_pending_resume&&!o.issue
  &&o.erp_status==='live_created'&&o.label_status!=='cancelled'
  &&!Object.hasOwn(o.source_payload||{},'marketplacePendingCorrection')
  &&!o.source_payload?.erplainValidationHold&&!cancellationBlock(o)
  &&![true,'true',1,'1'].includes(o.source_payload?.cancelled)&&!o.source_payload?.cancelled_at
  &&!['cancelled','shipped','delivered','in_transit'].includes(o.tracking_status)
  &&!String(o.reference||'').startsWith('DEMO-')
  &&s.phase==='bl_ready'&&s.bc?.id&&s.bc.status==='active'&&s.bl?.id&&s.bl.status==='ready_to_ship'
  &&s.bl.update_stock===false&&s.stockDocument?.id&&s.stockDocument.status==='completed'
  &&s.stockDocument.update_stock===true&&s.stockDocument.label===expectedStock
  &&Array.isArray(s.stockPendingVariants)&&s.stockPendingVariants.length===0
  &&later(s.stockCheckedAt)&&later(s.verifiedAt)&&later(s.bl.readyConfirmedAt)&&later(x.erp_updated_at)
  &&x.erp_status==='complete'&&x.erp_error===null
  &&typeof currentFingerprint==='string'&&/^[a-f0-9]{64}$/.test(currentFingerprint)
  &&s.labelPreparationFingerprint===currentFingerprint);
}

export async function reconcileCompletedErpReviews(db){
 return db.transaction(async tx=>{
  const rows=(await tx.query(`SELECT r.id,r.status,r.stage,r.action,r.error,r.result,r.created_at,r.updated_at,
   to_jsonb(o) AS "order",e.status AS erp_status,e.error AS erp_error,e.updated_at AS erp_updated_at
   FROM resolution_jobs r JOIN orders o ON o.id=r.order_id JOIN erp_live_jobs e ON e.order_id=o.id
   WHERE r.status='review' AND r.stage='Erplain à compléter' AND r.result->>'resume'='true'
   AND (r.error LIKE 'BL bloqué — stock insuffisant : %' OR r.error LIKE 'Incident temporaire Erplain : rapprochement et reprise automatique en attente (%')
   AND e.status='complete' AND e.error IS NULL AND o.erp_live->>'phase'='bl_ready'
   AND NOT o.archived AND NOT coalesce(o.partial_mode,false) AND NOT coalesce(o.resolution_pending_resume,false)
   AND r.id=(SELECT last.id FROM resolution_jobs last WHERE last.order_id=o.id ORDER BY last.created_at DESC,last.id DESC LIMIT 1)
   AND NOT EXISTS(SELECT 1 FROM resolution_jobs busy WHERE busy.order_id=o.id AND busy.status IN ('queued','running','waiting'))
   ORDER BY r.created_at,r.id LIMIT 20 FOR UPDATE OF r,o,e SKIP LOCKED`)).rows;
  let n=0;
  for(const x of rows){
   // Lock source lines too: a concurrent mapping/quantity change must not invalidate the proof.
   await tx.query('SELECT id FROM lines WHERE order_id=$1 ORDER BY id FOR SHARE',[x.order.id]);
   // SELECT * preserves PostgreSQL numeric types as used when the proof was recorded;
   // to_jsonb converts those strings to numbers and would change the fingerprint.
   const current=(await tx.query('SELECT * FROM orders WHERE id=$1',[x.order.id])).rows[0];
   const fingerprint=await shipmentFingerprint(tx,current);
   if(!completedErpReview(x,fingerprint))continue;
   const s=x.order.erp_live;
   const proof={resolvedPreviousError:x.error,reconciledAt:new Date().toISOString(),erpCompletionDiagnostic:{version:1,resolutionId:x.id,previousStage:x.stage,previousUpdatedAt:x.updated_at,bcId:s.bc.id,blId:s.bl.id,stockDocumentId:s.stockDocument.id,verifiedAt:s.verifiedAt,stockCheckedAt:s.stockCheckedAt,erpCompletedAt:x.erp_updated_at,preparationFingerprint:fingerprint}};
   await tx.query(`UPDATE resolution_jobs SET status='complete',stage='Diagnostic résolu · reprise ERP terminée',error=null,
    result=coalesce(result,'{}'::jsonb)||$2::jsonb,updated_at=now() WHERE id=$1 AND status='review'`,[x.id,JSON.stringify(proof)]);
   n++;
  }
  return n;
 });
}
