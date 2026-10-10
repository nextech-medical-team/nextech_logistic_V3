import {resolveWeight} from './erplain-readonly.mjs';

const findings=['Poids non renseigné dans Erplain','Poids manquant','Unité de poids Erplain absente ou non prise en charge'];
export function verifiedWeightBinding(b,now=Date.now()){
 const v=b?.product,t=Date.parse(b?.verified_at);
 if(!v||String(v.id)!==String(b.live_variant_id)||v.sku!==b.sku||v.active!==true||v.product?.active!==true||v.weight_amount==null||String(v.weight_amount).trim()===''||!Number.isFinite(t)||t>now||now-t>86400000)return false;
 try{return resolveWeight([v],b.sku).weightKg>0;}catch{return false;}
}
// Only retire exact, SKU-qualified findings backed by a newer verified LIVE value.
export function withoutVerifiedWeight(message,sku){
 if(message==null)return message;
 return String(message).split(/\s;\s/).map(part=>{
  const text=part.trim();
  if(findings.some(x=>text===`${sku} : ${x}`||text===`${sku} · ${x}`))return null;
  for(const prefix of [`Produit restant [${sku}] : `,`Produit équivalent [${sku}] : `])if(findings.some(x=>text===prefix+x))return prefix+'Poids vérifié, remplacement à confirmer';
  return part;
 }).filter(x=>x!==null).join(' ; ')||null;
}
export async function reconcileVerifiedWeights(db,onlySku=null,onlyOrder=null){
 const bindings=(await db.query('SELECT * FROM erplain_product_bindings'+(onlySku?' WHERE sku=$1':` b WHERE b.verified_at>now()-interval '24 hours' AND (
  EXISTS(SELECT 1 FROM resolution_jobs j WHERE j.status='review' AND j.error LIKE '%'||b.sku||'%' AND (j.error LIKE '%Poids non renseigné%' OR j.error LIKE '%Poids manquant%' OR j.error LIKE '%Unité de poids%'))
  OR EXISTS(SELECT 1 FROM orders o JOIN lines l ON l.order_id=o.id WHERE coalesce(l.target_sku,l.source_sku)=b.sku AND (o.issue LIKE '%Poids%' OR o.issue LIKE '%Unité de poids%' OR (o.erp_live->'lastAudit'->'issues')::text LIKE '%Poids%'))
  OR EXISTS(SELECT 1 FROM erp_live_jobs e JOIN lines l ON l.order_id=e.order_id WHERE coalesce(l.target_sku,l.source_sku)=b.sku AND (e.error LIKE '%Poids%' OR e.error LIKE '%Unité de poids%'))
 )`),onlySku?[onlySku]:[])).rows;
 for(const b of bindings){
  if(!verifiedWeightBinding(b))continue;
  // A verified SKU binding cannot resolve a different physical variant's
  // missing weight. Preserve that order's diagnostic until its own correction.
  const rows=(await db.query(`SELECT DISTINCT o.id FROM orders o WHERE ($3::text IS NULL OR o.id=$3) AND NOT o.archived
   AND (EXISTS(SELECT 1 FROM lines l WHERE l.order_id=o.id AND coalesce(l.target_sku,l.source_sku)=$1)
    OR EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status='review' AND r.action IN ('equivalent-preview','replace-equivalent') AND r.payload->>'replacementSku'=$1))
   AND NOT EXISTS(SELECT 1 FROM lines other WHERE other.order_id=o.id AND coalesce(other.target_sku,other.source_sku)=$1 AND other.source_payload->>'erplainSourceVariantId' IS NOT NULL AND other.source_payload->>'erplainSourceVariantId'<>$2)
   AND NOT EXISTS(SELECT 1 FROM erp_live_jobs e WHERE e.order_id=o.id AND e.status='processing')
   AND NOT EXISTS(SELECT 1 FROM carrier_jobs c WHERE c.order_id=o.id AND c.status IN ('creating','awaiting_pdf'))`,[b.sku,String(b.live_variant_id),onlyOrder])).rows;
  for(const row of rows)await db.transaction(async tx=>{
   const o=(await tx.query('SELECT id,issue,erp_live,updated_at FROM orders WHERE id=$1 FOR UPDATE',[row.id])).rows[0];if(!o)return;
   const proof=(await tx.query('SELECT * FROM erplain_product_bindings WHERE sku=$1 FOR SHARE',[b.sku])).rows[0];
   if(!verifiedWeightBinding(proof)||String(proof.live_variant_id)!==String(b.live_variant_id))return;
   const lines=(await tx.query('SELECT target_sku,source_sku,source_payload FROM lines WHERE order_id=$1 FOR SHARE',[o.id])).rows;
   if(lines.some(l=>(l.target_sku||l.source_sku)===b.sku&&l.source_payload?.erplainSourceVariantId!=null&&String(l.source_payload.erplainSourceVariantId)!==String(b.live_variant_id)))return;
   const audit=o.erp_live?.lastAudit;
   if(Date.parse(proof.verified_at)>Date.parse(audit?.at||o.updated_at)){
    const issue=withoutVerifiedWeight(o.issue,b.sku),issues=Array.isArray(audit?.issues)?audit.issues.map(x=>withoutVerifiedWeight(x,b.sku)).filter(Boolean):audit?.issues;
    const live=audit?{...o.erp_live,lastAudit:{...audit,issues,weightReconciledAt:new Date().toISOString()}}:o.erp_live;
    if(issue!==o.issue||audit&&JSON.stringify(issues)!==JSON.stringify(audit.issues))await tx.query('UPDATE orders SET issue=$2,erp_live=$3 WHERE id=$1',[o.id,issue,JSON.stringify(live)]);
   }
   const jobs=(await tx.query("SELECT id,action,error,payload,created_at,updated_at FROM resolution_jobs WHERE order_id=$1 AND status='review' FOR UPDATE",[o.id])).rows;
   let changed=0;
   for(const j of jobs){
    if(!(Date.parse(proof.verified_at)>Date.parse(j.updated_at||j.created_at)))continue;
    if(j.payload?.replacementSku===b.sku&&j.payload?.variantId!=null&&String(j.payload.variantId)!==String(b.live_variant_id))continue;
    const error=withoutVerifiedWeight(j.error,b.sku);
    if(error!==j.error){await tx.query("UPDATE resolution_jobs SET error=$2,stage='Diagnostic poids actualisé · suite à vérifier',updated_at=now() WHERE id=$1 AND status='review' AND error IS NOT DISTINCT FROM $3",[j.id,error,j.error]);changed++;}
   }
   const erp=(await tx.query('SELECT error,updated_at FROM erp_live_jobs WHERE order_id=$1 FOR UPDATE',[o.id])).rows[0];
   if(erp&&Date.parse(proof.verified_at)>Date.parse(erp.updated_at)){
    const error=withoutVerifiedWeight(erp.error,b.sku);if(error!==erp.error)await tx.query('UPDATE erp_live_jobs SET error=$2 WHERE order_id=$1 AND error IS NOT DISTINCT FROM $3',[o.id,error,erp.error]);
   }
   if(changed)await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','diagnostic.verified_weight',$1)",[JSON.stringify({orderId:o.id,sku:b.sku,variantId:b.live_variant_id,verifiedAt:proof.verified_at,updatedReviewMessages:changed,businessStatesPreserved:true})]);
  });
 }
}
