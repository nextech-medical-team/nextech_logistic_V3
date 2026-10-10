import {resolveWeight} from './erplain-readonly.mjs';

// Only retire exact missing-weight findings backed by a newer verified LIVE value.
export function withoutVerifiedWeight(message,sku){
 const exact=new Set([`${sku} : Poids non renseigné dans Erplain`,`${sku} : Poids manquant`,`${sku} · Poids manquant`]);
 return String(message||'').split(/\s;\s/).filter(part=>!exact.has(part.trim())).join(' ; ')||null;
}
export async function reconcileVerifiedWeights(db,onlySku=null){
 const bindings=(await db.query('SELECT * FROM erplain_product_bindings'+(onlySku?' WHERE sku=$1':''),onlySku?[onlySku]:[])).rows;
 for(const b of bindings){
  try{if(b.product?.active===false||b.product?.product?.active===false||!resolveWeight([b.product],b.sku).weightKg)continue;}catch{continue;}
  // A verified SKU binding cannot resolve a different physical variant's
  // missing weight. Preserve that order's diagnostic until its own correction.
  const rows=(await db.query(`SELECT DISTINCT o.id,o.issue,o.erp_live FROM orders o JOIN lines l ON l.order_id=o.id WHERE l.target_sku=$1 AND o.erp_live->'lastAudit' IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM lines other WHERE other.order_id=o.id AND other.target_sku=$1
    AND other.source_payload->>'erplainSourceVariantId' IS NOT NULL
    AND other.source_payload->>'erplainSourceVariantId'<>$2
    AND CASE WHEN jsonb_typeof(other.source_payload->'erplainCorrectedWeightKg')='number'
      THEN (other.source_payload->>'erplainCorrectedWeightKg')::numeric<=0 ELSE true END)`,[b.sku,String(b.live_variant_id)])).rows;
  for(const o of rows){
   const audit=o.erp_live.lastAudit;if(!(new Date(b.verified_at)>new Date(audit.at)))continue;
   const issue=withoutVerifiedWeight(o.issue,b.sku),issues=(audit.issues||[]).map(x=>withoutVerifiedWeight(x,b.sku)).filter(Boolean);
   if(issue===o.issue&&JSON.stringify(issues)===JSON.stringify(audit.issues||[]))continue;
   await db.query('UPDATE orders SET issue=$2,erp_live=$3 WHERE id=$1',[o.id,issue,JSON.stringify({...o.erp_live,lastAudit:{...audit,issues,weightReconciledAt:new Date().toISOString()}})]);
   const jobs=(await db.query("SELECT id,error FROM resolution_jobs WHERE order_id=$1 AND action='audit' AND status='review' AND created_at<$2",[o.id,b.verified_at])).rows;
   for(const j of jobs){const error=withoutVerifiedWeight(j.error,b.sku);if(error!==j.error)await db.query("UPDATE resolution_jobs SET error=$2,status=$3 WHERE id=$1",[j.id,error,error?'review':'complete']);}
   await db.query("INSERT INTO audit(user_email,action,detail) VALUES('system','diagnostic.verified_weight',$1)",[JSON.stringify({orderId:o.id,sku:b.sku,previousIssue:o.issue,issue,verifiedAt:b.verified_at})]);
  }
 }
}
