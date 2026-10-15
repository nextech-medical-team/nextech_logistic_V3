import {cancellationBlock} from './erp-transient-policy.mjs';
import {assertPublishedBcReservation} from './bc-numbering.mjs';
export const retiredReservationEquation=message=>/^BC · Quantités réservées non confirmées(?: · SKU [^;\r\n]+)?$/.test(message||'');
export function reservationReviewEligible(o){
 const s=o?.erp_live;
 return !!s?.bc?.id&&s.phase==='bc_created'&&!s.bl?.id&&!s.stockDocument?.id&&!s.stockCreationAttemptedAt&&retiredReservationEquation(o.error)
 &&!['cancelled','closed'].includes(s.bc.status)&&!['production_ready','sandbox_ready','ready','cancelled'].includes(o.label_status)&&!o.source_payload?.externalLabel?.active
 &&!o.archived&&!o.partial_mode&&!o.resolution_pending_resume&&!cancellationBlock(o)&&o.channel!=='tender'
 &&!String(o.reference||'').startsWith('DEMO-')&&!o.source_payload?.visibilityHold&&!o.source_payload?.erplainValidationHold
 &&!Object.hasOwn(o.source_payload||{},'marketplacePendingCorrection')&&!['shipped','in_transit','delivered'].includes(o.tracking_status)
 &&![s.mappingAlignmentAttempt,s.sourceVatAttempt,s.stockCreationOutcome].some(a=>a?.status==='uncertain'||a?.kind==='uncertain')&&!s.documentSource?.stockHolds?.length;
}
export async function resumeRetiredReservationReviews(db,api){
 if(await api.quotaDelay?.()>0)return 0;
 const rows=(await db.query(`SELECT o.*,e.error,e.updated_at::text review_version FROM orders o JOIN erp_live_jobs e ON e.order_id=o.id
 WHERE e.status='review' AND e.error LIKE 'BC · Quantités réservées non confirmées%' AND o.erp_live->>'phase'='bc_created'
 AND NOT o.archived AND NOT o.partial_mode AND NOT o.resolution_pending_resume
 ORDER BY e.updated_at LIMIT 10`)).rows;
 let n=0;
 for(const o of rows){
  if(!reservationReviewEligible(o))continue;
  let bc;
  try{
   const result=await api.request('query V3RetiredReservationReview($id:ID!){Order(id:$id){id status update_stock line_items{type quantity reserved_quantity shipped_quantity variant{id sku track_inventory}} shipping_orders(first:100){data{id status} paginatorInfo{hasMorePages}}}}',{id:String(o.erp_live.bc.id)});bc=result.Order;
   if(String(bc?.id)!==String(o.erp_live.bc.id)||bc.status!=='active'||typeof bc.update_stock!=='boolean'||typeof o.erp_live.bc.update_stock==='boolean'&&o.erp_live.bc.update_stock!==bc.update_stock||!Array.isArray(bc.shipping_orders?.data)||bc.shipping_orders.paginatorInfo?.hasMorePages!==false||bc.shipping_orders.data.length)continue;
   assertPublishedBcReservation(bc,o.erp_live.bcReservationPolicy==='erplain_bc_bl'?true:bc.update_stock);
  }catch(e){if(e.httpStatus===429)break;continue;}
  n+=await db.transaction(async tx=>{
   const fresh=(await tx.query(`SELECT o.*,e.error FROM orders o JOIN erp_live_jobs e ON e.order_id=o.id
    WHERE o.id=$1 AND e.status='review' AND e.updated_at::text=$2 AND o.erp_live=$3::jsonb
    AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting'))
    AND NOT EXISTS(SELECT 1 FROM correction_jobs c WHERE c.order_id=o.id AND c.status IN ('queued','applying','checking','waiting'))
    FOR UPDATE OF o,e SKIP LOCKED`,[o.id,o.review_version,JSON.stringify(o.erp_live)])).rows[0];
   if(!fresh||fresh.error!==o.error||!reservationReviewEligible(fresh))return 0;
   const record={previousError:o.error,bcId:String(bc.id),checkedAt:new Date().toISOString(),policy:'reservation-equation-removed',providerMutations:0};
   await tx.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{reservationEquationRetired}',$2::jsonb),issue=CASE WHEN issue=$3 THEN NULL ELSE issue END WHERE id=$1",[o.id,JSON.stringify(record),o.error]);
   await tx.query(`UPDATE resolution_jobs SET error=null,result=(CASE WHEN jsonb_typeof(result)='object' THEN result ELSE jsonb_build_object('previousResult',result) END)||jsonb_build_object('reservationEquationRetired',$3::jsonb,'previousError',error),updated_at=now()
    WHERE order_id=$1 AND status='review' AND stage='Erplain à compléter' AND updated_at<=$4::timestamptz
    AND (error=$2 OR error IN ('Erplain temporairement limité : vérification et reprise automatiques programmées','Accès Erplain en attente · reprise automatique programmée'))`,[o.id,o.error,JSON.stringify(record),o.review_version]);
   await tx.query("UPDATE erp_live_jobs SET status='pending',error=null,updated_at=now() WHERE order_id=$1",[o.id]);
   return 1;
  });
 }
 return n;
}
