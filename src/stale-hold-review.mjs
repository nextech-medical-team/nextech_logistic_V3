import {reconcileCancelledTemuIntakes} from './temu-cancelled-intake.mjs';
import {reconcilePaidTemuStatuses} from './temu-paid-status-reconciliation.mjs';
import {resumeInitialCustomerCheckpoint} from './temu-customer-checkpoint.mjs';
import {cancellationBlock} from './erp-transient-policy.mjs';
const message='Préparation suspendue : validation requise';
export function staleHoldReviewAllowed(o){return !!o&&o.channel==='temu'&&!o.archived&&!o.partial_mode&&!o.resolution_pending_resume&&!o.issue&&!cancellationBlock(o)&&!Object.hasOwn(o.source_payload||{},'marketplacePendingCorrection')&&!['shipped','delivered','in_transit','delivered_simulated'].includes(o.tracking_status)&&o.erp_live?.phase==='bc_created'&&!!o.erp_live.bc?.id&&!o.erp_live.bl?.id&&!o.erp_live.stockDocument?.id&&!o.erp_live.stockCreationAttemptedAt&&o.erp_live.pricing?.status==='verified';}
export async function resumeStaleHoldReviews(db,api){
 await reconcileCancelledTemuIntakes(db);
 await reconcilePaidTemuStatuses(db);
 await resumeInitialCustomerCheckpoint(db,api);
 const rows=(await db.query(`SELECT o.* FROM orders o JOIN erp_live_jobs e ON e.order_id=o.id WHERE e.status='review' AND e.error=$1 AND o.channel='temu' AND NOT o.archived AND NOT o.partial_mode AND NOT o.resolution_pending_resume AND coalesce(o.issue,'')='' AND o.erp_live->>'phase'='bc_created' AND o.erp_live->'bc'->>'id' IS NOT NULL AND o.erp_live->'bl'->>'id' IS NULL AND o.erp_live->'stockDocument'->>'id' IS NULL AND o.erp_live->>'stockCreationAttemptedAt' IS NULL AND o.erp_live->'pricing'->>'status'='verified' AND NOT coalesce(o.source_payload ? 'marketplacePendingCorrection',false) AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting')) AND NOT EXISTS(SELECT 1 FROM correction_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','applying','checking','waiting')) ORDER BY e.updated_at LIMIT 25`,[message])).rows;
 let count=0;
 for(const o of rows){
  if(!staleHoldReviewAllowed(o))continue;
  const {Order:b}=await api.request('query V3StaleHoldCheck($id:ID!){Order(id:$id){id status external_reference internal_notes shipping_orders(first:100){data{id status} paginatorInfo{hasMorePages}}}}',{id:String(o.erp_live.bc.id)});
  if(String(b?.id)!==String(o.erp_live.bc.id)||b.status!=='active'||b.external_reference!==o.reference||!b.internal_notes?.includes('[V3:'+o.id+']')||b.shipping_orders?.paginatorInfo?.hasMorePages!==false||!Array.isArray(b.shipping_orders?.data)||b.shipping_orders.data.length)continue;
  count+=await db.transaction(async tx=>{
   const fresh=(await tx.query(`SELECT o.* FROM orders o JOIN erp_live_jobs e ON e.order_id=o.id WHERE o.id=$1 AND e.status='review' AND e.error=$2 AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting')) AND NOT EXISTS(SELECT 1 FROM correction_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','applying','checking','waiting')) FOR UPDATE OF o,e`,[o.id,message])).rows[0];
   if(!staleHoldReviewAllowed(fresh)||JSON.stringify(fresh.erp_live)!==JSON.stringify(o.erp_live)||JSON.stringify(fresh.source_payload)!==JSON.stringify(o.source_payload))return 0;
   await tx.query("UPDATE erp_live_jobs SET status='pending',error=null,updated_at=now() WHERE order_id=$1",[o.id]);
   await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','temu.stale_hold_review_reconciled',$1)",[JSON.stringify({orderId:o.id,bcId:b.id,reason:'hold_already_cleared',checkedAt:new Date().toISOString(),externalWrites:0})]);
   return 1;
  });
 }
 return count;
}
