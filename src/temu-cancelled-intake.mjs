import {confirmedTemuCancellation} from './temu-cancellation-observation.mjs';
export function intakeCancellationProof(o, payload) {
 const d=payload?.detail;
 return confirmedTemuCancellation(o,d)&&Array.isArray(d.orderList)&&d.orderList.length>0&&d.orderList.every(l=>Number(l.orderStatus)===3&&Number(l.quantity)===0);
}
// Only untouched, incomplete imports. Existing documents, purchases and active
// corrections remain under their established reconciliation process.
export async function reconcileCancelledTemuIntakes(db){
 return db.transaction(async tx=>{
 const rows=(await tx.query(`SELECT o.*,r.payload AS cancellation_payload FROM orders o
 JOIN erp_live_jobs e ON e.order_id=o.id
 JOIN LATERAL (SELECT payload FROM marketplace_receipts WHERE channel='temu' AND status='complete' AND payload->'detail'->'parentOrderMap'->>'parentOrderSn'=o.reference ORDER BY created_at DESC,id DESC LIMIT 1) r ON true
 WHERE o.channel='temu' AND NOT o.archived AND NOT o.partial_mode
 AND o.source_payload->>'visibilityHold'='true'
 AND coalesce(o.erp_live,'{}'::jsonb)='{}'::jsonb AND e.status IN ('pending','review','failed')
 AND r.payload->'detail'->'parentOrderMap'->>'parentOrderStatus'='3'
 AND NOT EXISTS(SELECT 1 FROM temu_label_jobs j WHERE j.reference=o.reference)
 AND NOT EXISTS(SELECT 1 FROM carrier_jobs j WHERE j.order_id=o.id)
 AND NOT EXISTS(SELECT 1 FROM resolution_jobs j WHERE j.order_id=o.id AND j.status IN ('queued','running','waiting'))
 AND NOT EXISTS(SELECT 1 FROM correction_jobs j WHERE j.order_id=o.id AND j.status IN ('queued','applying','checking','waiting'))
 ORDER BY o.received_at LIMIT 100 FOR UPDATE OF o,e SKIP LOCKED`)).rows;
 let count=0;
 for(const o of rows){
 if(!intakeCancellationProof(o,o.cancellation_payload))continue;
 await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','temu.cancelled_intake_reconciled',$1)",[JSON.stringify({orderId:o.id,reference:o.reference,previousIssue:o.issue,previousPendingCorrection:o.source_payload.marketplacePendingCorrection||null,sourceStatus:3,externalWrites:0})]);
 await tx.query(`UPDATE orders SET label_status='cancelled',tracking_status=CASE WHEN tracking_status IN ('shipped','delivered','in_transit') THEN tracking_status ELSE 'cancelled' END, issue=null,resolution_pending_resume=false,
 source_payload=(source_payload-'visibilityHold'-'visibilityError'-'visibilityReadError'-'visibilityReason'-'marketplacePendingCorrection')||$2::jsonb WHERE id=$1`,[o.id,JSON.stringify({temuCancellation:{confirmed:true,status:3,observedAt:new Date().toISOString(),source:'marketplace_receipt'},temuOrderDetail:o.cancellation_payload.detail})]);
 await tx.query("UPDATE erp_live_jobs SET status='complete',error=null,updated_at=now() WHERE order_id=$1",[o.id]);
 count++;
 }
 return count;
 });
}

