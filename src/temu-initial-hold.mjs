import {bcAllowedSql} from './bc-authorization.mjs';
import {cancellationBlock} from './erp-transient-policy.mjs';
// Label purchase always requires TEMU's explicit price confirmation. It is not an ERP correction hold.
export const initialMarketplaceHold=()=>false;
export function recoverableInitialTemuHold(o){
 const s=o.erp_live||{},p=o.source_payload||{};
 return o.channel==='temu'&&o.archived===false&&o.resolution_pending_resume===true
 && !o.partial_mode&&!o.issue&&!cancellationBlock(o)
 && !['shipped','delivered','in_transit','delivered_simulated'].includes(o.tracking_status)
 && o.label_status!=='cancelled'&&!Object.hasOwn(p,'marketplacePendingCorrection')
 && !p.erplainImported&&!String(o.reference||'').startsWith('DEMO-')&&p.sourceShop
 && !s.phase&&!s.customer?.id&&!s.bc?.id&&!s.bl?.id&&!s.stockDocument?.id&&!s.stockCreationAttemptedAt
 && ['pending','review'].includes(o.erp_job_status)
 && (o.erp_job_status==='pending'||o.erp_job_error==='Préparation suspendue : validation requise');
}
export async function resumeInitialTemuHolds(db){
 return db.transaction(async tx=>{
 const rows=(await tx.query(`SELECT o.*,e.status erp_job_status,e.error erp_job_error FROM orders o JOIN erp_live_jobs e ON e.order_id=o.id
 WHERE (${bcAllowedSql}) AND o.channel='temu' AND o.resolution_pending_resume=true AND NOT o.partial_mode AND coalesce(o.issue,'')=''
 AND coalesce(o.tracking_status,'') NOT IN ('shipped','delivered','in_transit','delivered_simulated','cancelled')
 AND coalesce(o.label_status,'')<>'cancelled'

 AND NOT coalesce(o.source_payload ? 'erplainImported',false)
 AND o.source_payload->>'sourceShop' IS NOT NULL
 AND o.erp_live->>'phase' IS NULL AND o.erp_live->'customer'->>'id' IS NULL AND o.erp_live->'bc'->>'id' IS NULL AND o.erp_live->'bl'->>'id' IS NULL
 AND o.erp_live->'stockDocument'->>'id' IS NULL AND o.erp_live->>'stockCreationAttemptedAt' IS NULL
 AND (e.status='pending' OR e.status='review' AND e.error='Préparation suspendue : validation requise')
 AND EXISTS(SELECT 1 FROM marketplace_order_links l WHERE l.order_id=o.id AND l.channel='temu' AND l.reference=o.reference AND l.shop=o.source_payload->>'sourceShop')
 AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id)
 AND NOT EXISTS(SELECT 1 FROM correction_jobs r WHERE r.order_id=o.id)
 AND NOT EXISTS(SELECT 1 FROM carrier_jobs c WHERE c.order_id=o.id)
 AND NOT EXISTS(SELECT 1 FROM temu_label_documents d WHERE d.reference=o.reference)
 AND NOT EXISTS(SELECT 1 FROM temu_label_jobs t WHERE t.reference=o.reference AND (t.attempt_id IS NOT NULL OR t.result IS NOT NULL OR coalesce(t.packages,'[]'::jsonb)<>'[]'::jsonb OR t.status NOT IN ('ready','quoting','failed','cancelled')))
 ORDER BY e.updated_at LIMIT 25 FOR UPDATE OF o,e SKIP LOCKED`)).rows;
 let n=0;for(const o of rows){if(!recoverableInitialTemuHold(o))continue;
 const proof={reason:'initial_temu_label_confirmation_misclassified',checkedAt:new Date().toISOString(),externalWrites:0};
 await tx.query(`UPDATE orders SET resolution_pending_resume=false,source_payload=source_payload||'{"temuLabelPurchaseConfirmationRequired":true}'::jsonb,erp_live=erp_live||$2::jsonb WHERE id=$1`,[o.id,JSON.stringify({initialTemuHoldRecovery:proof})]);
 await tx.query("UPDATE erp_live_jobs SET status='pending',error=null,updated_at=now() WHERE order_id=$1",[o.id]);
 await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','temu.initial_hold_reconciled',$1)",[JSON.stringify({orderId:o.id,...proof})]);n++;
 }return n;
 });
}
