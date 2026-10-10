import {bcAllowedSql} from './bc-authorization.mjs';
import {cancellationBlock} from './erp-transient-policy.mjs';
import {temuPricingIssue} from './temu-bc-pricing.mjs';

export const commandRecoveryPolicy='temu-initial-commercial-recovery-20261008';
const recoverableError=e=>/^Préparation suspendue : validation requise$|^TEMU · (Remises client et TVA à rapprocher|Totaux client source incohérents|Prix client et TVA source incohérents|Nombre de lignes financières différent de la commande)$/.test(e||'');
// A purchased label does not authorize another purchase and must not block the
// first BC. Only recover initial dossiers: an external creation phase is never reset.
export function initialCommercialRecovery(o,lines){
 const p=o.source_payload||{},s=o.erp_live||{};
 if(o.channel!=='temu'||o.archived!==false||o.partial_mode||cancellationBlock(o)
 ||['shipped','delivered','in_transit','delivered_simulated'].includes(o.tracking_status)
 ||Object.hasOwn(p,'marketplacePendingCorrection')||p.visibilityHold||p.erplainImported
 ||!p.sourceShop||String(o.reference||'').startsWith('DEMO-')
 ||s.phase||s.customer?.id||s.bc?.id||s.bl?.id||s.stockDocument?.id||s.stockCreationAttemptedAt
 ||o.erp_job_status!=='review'||!recoverableError(o.erp_job_error)
 ||(o.issue&&!['Données récupérées · Préparation à vérifier',o.erp_job_error].includes(o.issue)))return false;
 return !temuPricingIssue(o,lines);
}
export async function recoverInitialCommercialReviews(db){
 return db.transaction(async tx=>{
  const rows=(await tx.query(`SELECT o.*,e.status erp_job_status,e.error erp_job_error FROM orders o JOIN erp_live_jobs e ON e.order_id=o.id
   WHERE (${bcAllowedSql}) AND o.channel='temu' AND e.status='review' AND NOT o.partial_mode
   AND coalesce(o.erp_live->>'phase','')='' AND o.erp_live->'customer'->>'id' IS NULL
   AND o.erp_live->'bc'->>'id' IS NULL AND o.erp_live->'bl'->>'id' IS NULL
   AND o.erp_live->'stockDocument'->>'id' IS NULL AND o.erp_live->>'stockCreationAttemptedAt' IS NULL
   AND coalesce(o.source_payload->>'visibilityHold','false')<>'true'


   AND (coalesce(o.issue,'')='' OR o.issue=e.error OR o.issue='Données récupérées · Préparation à vérifier')
   AND coalesce(o.tracking_status,'') NOT IN ('cancelled','shipped','delivered','in_transit','delivered_simulated')
   AND coalesce(o.label_status,'')<>'cancelled'
   AND e.error IN ('Préparation suspendue : validation requise','TEMU · Remises client et TVA à rapprocher','TEMU · Totaux client source incohérents','TEMU · Prix client et TVA source incohérents','TEMU · Nombre de lignes financières différent de la commande')
   AND EXISTS(SELECT 1 FROM marketplace_order_links l WHERE l.order_id=o.id AND l.channel='temu' AND l.reference=o.reference AND l.shop=o.source_payload->>'sourceShop')
   AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM correction_jobs r WHERE r.order_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM carrier_jobs r WHERE r.order_id=o.id)
   ORDER BY e.updated_at LIMIT 25 FOR UPDATE OF o,e SKIP LOCKED`)).rows;
  let count=0;
  for(const o of rows){
   const lines=(await tx.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY source_line,id FOR UPDATE',[o.id])).rows;
   if(!initialCommercialRecovery(o,lines))continue;
   const proof={policy:commandRecoveryPolicy,previousError:o.erp_job_error,previousIssue:o.issue,checkedAt:new Date().toISOString(),externalWrites:0,labelPurchaseUnchanged:true};
   await tx.query(`UPDATE orders SET resolution_pending_resume=false,issue=null,source_payload=source_payload||'{"temuLabelPurchaseConfirmationRequired":true}'::jsonb,erp_live=erp_live||$2::jsonb WHERE id=$1`,[o.id,JSON.stringify({initialCommercialRecovery:proof})]);
   await tx.query("UPDATE erp_live_jobs SET status='pending',error=null,updated_at=now() WHERE order_id=$1 AND status='review'",[o.id]);
   await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','temu.initial_commercial_recovered',$1)",[JSON.stringify({orderId:o.id,...proof})]);count++;
  }
  return count;
 });
}
