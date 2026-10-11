import {sourceTemuTotals} from './financial-review-recovery.mjs';
import {repairUnpreparedSourceBc} from './source-bc-repair.mjs';
import {bcAllowedSql} from './bc-authorization.mjs';
import {verifySourceCommercialTotals} from './bc-pricing.mjs';
const policy='lt-0.50-eur-or-lt-5-percent-order-total';
export function monetaryReviewError(message){
 const text=String(message||'').replace(/^Stock Erplain · Mouvement à vérifier :\s*/,'').replace(/^Reprise Erplain ·\s*/,'');
 return /^BC · (?:Total Erplain .+ différent du total source|TVA Erplain .+ différente de la TVA source)/.test(text);
}
export function commercialResumeEligible(o){
 return monetaryReviewError(o.error)&&o.archived===false&&!String(o.reference||'').startsWith('DEMO-')
 && !Object.hasOwn(o.source_payload||{},'marketplacePendingCorrection')

 && !/commande annulée/i.test(o.issue||'')&&!o.partial_mode
 && !['cancelled','shipped','delivered','in_transit'].includes(o.tracking_status)
 && o.label_status!=='cancelled'&&o.erp_live?.bc?.id
 && o.erp_live.bc.status!=='cancelled'&&o.erp_live.bl?.status!=='cancelled'
 && !['creating_bc','creating_customer','publishing_bl'].includes(o.erp_live.phase);
}
export async function resumeAcceptedCommercialReviews(db,api){
 const rows=(await db.query(`SELECT o.*,j.error FROM orders o JOIN erp_live_jobs j ON j.order_id=o.id
 WHERE j.status='review' AND (${bcAllowedSql}) AND NOT o.partial_mode
 AND coalesce(o.tracking_status,'') NOT IN ('cancelled','shipped','delivered','in_transit')
 AND coalesce(o.label_status,'')<>'cancelled' AND coalesce(o.erp_live->'bc'->>'status','')<>'cancelled'
 AND coalesce(o.erp_live->'bl'->>'status','')<>'cancelled'
 AND coalesce(o.erp_live->>'phase','') NOT IN ('creating_bc','creating_customer','publishing_bl')
 AND o.erp_live->'bc'->>'id' IS NOT NULL
 AND (j.error LIKE 'BC · Total Erplain %' OR j.error LIKE 'BC · TVA Erplain %'
 OR j.error LIKE 'Stock Erplain · Mouvement à vérifier : BC · %' OR j.error LIKE 'Reprise Erplain · BC · %'
 )
 AND coalesce((o.erp_live->'commercialToleranceReview'->>'checkedAt')::timestamptz,'epoch')<now()-interval '5 minutes'
 AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting'))
 AND NOT EXISTS(SELECT 1 FROM correction_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','applying','checking','waiting'))
 ORDER BY j.updated_at LIMIT 10`)).rows;
 for(const o of rows){
  if(!commercialResumeEligible(o))continue;
  let source;
  try{source=o.channel==='temu'?sourceTemuTotals(o):o.source_payload?.erplainImported?o.erp_live.importedCommercialSource:o.erp_live.pricing;}catch{continue;}
  let confirmed,error;
  try{
   const {Order:actual}=await api.request('query V3ToleranceReadOnly($id:ID!){Order(id:$id){id total currency{label} line_items{tax_amount}}}',{id:String(o.erp_live.bc.id)});
   if(String(actual?.id)!==String(o.erp_live.bc.id))throw Error('BC · Identité Erplain différente');
   confirmed=verifySourceCommercialTotals(actual,source);
  }catch(e){error=e.message;
   if(monetaryReviewError(error)&&!o.erp_live?.bl?.id&&!o.erp_live?.stockDocument?.id&&!o.erp_live?.stockCreationAttemptedAt){
    try{confirmed=await repairUnpreparedSourceBc(db,api,o,source);error=null;}catch(repairError){error=repairError.message;}
   }
  }
  await db.transaction(async tx=>{
   const current=(await tx.query(`SELECT o.*,j.error FROM orders o JOIN erp_live_jobs j ON j.order_id=o.id WHERE o.id=$1 AND j.status='review' AND (${bcAllowedSql}) FOR UPDATE OF o,j`,[o.id])).rows[0];
   if(!current||!commercialResumeEligible(current)||current.error!==o.error||JSON.stringify(current.erp_live)!==JSON.stringify(o.erp_live)||JSON.stringify(current.source_payload)!==JSON.stringify(o.source_payload))return;
   if((await tx.query(`SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting') UNION ALL SELECT 1 FROM correction_jobs WHERE order_id=$1 AND status IN ('queued','applying','checking','waiting')`,[o.id])).rows.length)return;
   const checkedAt=new Date().toISOString();
   const detail={policy,checkedAt,status:confirmed?'accepted':'blocked',...(error?{error}:{confirmed})};
   const erp={...current.erp_live,commercialToleranceReview:detail,...(confirmed?{pricing:{...current.erp_live.pricing,...source,confirmed,error:null,status:'verified',verifiedAt:checkedAt}}:{})};
   await tx.query('UPDATE orders SET erp_live=$2,resolution_pending_resume=CASE WHEN $3 THEN false ELSE resolution_pending_resume END WHERE id=$1',[o.id,JSON.stringify(erp),!!confirmed]);
   if(confirmed){
    await tx.query("UPDATE erp_live_jobs SET status='pending',error=null,updated_at=now() WHERE order_id=$1",[o.id]);
    await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','erplain.monetary_tolerance_accepted',$1)",[JSON.stringify({orderId:o.id,bcId:erp.bc.id,confirmed,policy})]);
   }
  });
 }
}

