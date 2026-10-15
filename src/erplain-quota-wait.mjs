import {cancellationBlock} from './erp-transient-policy.mjs';
export const quotaWaitingMessage='Accès Erplain en attente · reprise automatique programmée';
export function quotaReadRetryAt(error,now=Date.now()){
 const local=error?.erplainRequestNotSent===true&&error?.erplainProviderRateLimited!==true;
 return new Date(now+Math.max(local?2000:60000,Number(error?.retryAfter||0)*1000)).toISOString();
}
export function safeQuotaReadQueue(order,error){
 return error?.erplainRequestNotSent===true&&error?.erplainReadOnly===true&&error?.httpStatus===429&&
  !order.archived&&!order.partial_mode&&!order.resolution_pending_resume&&!cancellationBlock(order)&&
  !['shipped','delivered','in_transit'].includes(order.tracking_status)&&
  !['cancelled','closed'].includes(order.erp_live?.bc?.status)&&!['cancelled','closed'].includes(order.erp_live?.bl?.status)&&
  [undefined,null,'customer_created','bc_created','bl_created','bl_ready'].includes(order.erp_live?.phase);
}
export async function queueQuotaRead(db,order,error){
 if(!safeQuotaReadQueue(order,error))return false;
 return db.transaction(async tx=>{
  const fresh=(await tx.query(`SELECT o.* FROM orders o JOIN erp_live_jobs e ON e.order_id=o.id
   WHERE o.id=$1 AND e.status='processing' AND o.erp_live=$2::jsonb
   AND NOT EXISTS(SELECT 1 FROM correction_jobs c WHERE c.order_id=o.id AND c.status IN ('queued','applying','checking','waiting'))
   FOR UPDATE OF o,e SKIP LOCKED`,[order.id,JSON.stringify(order.erp_live)])).rows[0];
  if(!fresh||!safeQuotaReadQueue(fresh,error))return false;
  await tx.query("UPDATE erp_live_jobs SET status='pending',error=null,updated_at=now() WHERE order_id=$1",[order.id]);
  return true;
 });
}
