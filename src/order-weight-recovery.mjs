import {verifiedWeightBinding} from './verified-weight-diagnostics.mjs';
import {resolveWeight} from './erplain-readonly.mjs';

export const genericWeightReason='Poids produit Erplain manquant';
// A generic order error needs proof for EVERY physical line, never one SKU.
export function orderWeightProof(lines,bindings,at,now=Date.now()){
 if(!Array.isArray(lines)||!lines.length||!Number.isFinite(Date.parse(at)))return null;
 let total=0;
 for(const l of lines){
  const sku=l.sku||l.target_sku||l.source_sku,b=bindings.find(b=>b.sku===sku),q=Number(l.quantity);
  if(!sku||!Number.isFinite(q)||q<=0||!verifiedWeightBinding(b,now)||Date.parse(b.verified_at)<=Date.parse(at))return null;
  const physical=l.source_payload?.erplainSourceVariantId||l.source_payload?.erplainVariantId;
  if(physical!=null&&String(physical)!==String(b.live_variant_id))return null;
  total+=q*resolveWeight([b.product],sku).weightKg;
 }
 return Number.isFinite(total)&&total>0?total:null;
}
export function currentOrderWeightReason(lines,bindings,catalog,at,now=Date.now()){
 if(orderWeightProof(lines,bindings,at,now))return null;
 if(lines.length===1){const sku=lines[0].sku,c=catalog.find(c=>c.sku===sku),t=Date.parse(c?.checked_at);
  if(c?.message===sku+' : SKU Erplain introuvable'&&t>Date.parse(at)&&t<=now&&now-t<86400000)return c.message;
 }
 return genericWeightReason;
}
export async function reconcileGenericOrderWeights(db,onlyOrder=null){
 const rows=(await db.query(`SELECT o.id,o.issue,coalesce(o.erp_live->'lastAudit'->>'at',(SELECT e.updated_at::text FROM erp_live_jobs e WHERE e.order_id=o.id),o.received_at::text) AS diagnostic_at FROM orders o WHERE NOT o.archived AND ($1::text IS NULL OR o.id=$1)
  AND (o.issue=$2 OR EXISTS(SELECT 1 FROM erp_live_jobs e WHERE e.order_id=o.id AND e.error=$2) OR EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status='review' AND r.error=$2))
  AND NOT EXISTS(SELECT 1 FROM erp_live_jobs e WHERE e.order_id=o.id AND e.status IN ('pending','processing'))
  AND NOT EXISTS(SELECT 1 FROM carrier_jobs c WHERE c.order_id=o.id AND c.status IN ('pending','creating','awaiting_pdf'))`,[onlyOrder,genericWeightReason])).rows;
 for(const row of rows)await db.transaction(async tx=>{
  const o=(await tx.query(`SELECT o.id,o.issue,coalesce(o.erp_live->'lastAudit'->>'at',(SELECT e.updated_at::text FROM erp_live_jobs e WHERE e.order_id=o.id),o.received_at::text) AS diagnostic_at FROM orders o WHERE o.id=$1 FOR UPDATE`,[row.id])).rows[0];if(!o)return;
  const lines=(await tx.query(`SELECT coalesce(l.target_sku,m.target_sku,l.source_sku) sku,coalesce(l.target_quantity,CASE WHEN m.source_qty>0 THEN l.quantity*m.target_qty/m.source_qty ELSE l.quantity END) quantity,l.source_payload FROM lines l JOIN orders o ON o.id=l.order_id LEFT JOIN mappings m ON m.channel=o.channel AND m.source_sku=l.source_sku WHERE l.order_id=$1`,[o.id])).rows;
  const bindings=(await tx.query('SELECT * FROM erplain_product_bindings WHERE sku=ANY($1::text[]) FOR SHARE',[lines.map(l=>l.sku)])).rows;
  const catalog=(await tx.query('SELECT sku,message,checked_at FROM catalog_results WHERE sku=ANY($1::text[]) FOR SHARE',[lines.map(l=>l.sku)])).rows;
  const reason=at=>currentOrderWeightReason(lines,bindings,catalog,at);
  if(o.issue===genericWeightReason&&reason(o.diagnostic_at)!==genericWeightReason)await tx.query('UPDATE orders SET issue=$3 WHERE id=$1 AND issue=$2',[o.id,genericWeightReason,reason(o.diagnostic_at)]);
  const erp=(await tx.query('SELECT error,updated_at FROM erp_live_jobs WHERE order_id=$1 FOR UPDATE',[o.id])).rows[0];
  if(erp?.error===genericWeightReason&&reason(erp.updated_at)!==genericWeightReason)await tx.query('UPDATE erp_live_jobs SET error=$3 WHERE order_id=$1 AND error=$2',[o.id,genericWeightReason,reason(erp.updated_at)]);
  const jobs=(await tx.query("SELECT id,error,updated_at,created_at FROM resolution_jobs WHERE order_id=$1 AND status='review' AND error=$2 FOR UPDATE",[o.id,genericWeightReason])).rows;
  for(const j of jobs)if(reason(j.updated_at||j.created_at)!==genericWeightReason)await tx.query("UPDATE resolution_jobs SET error=$3,stage='Diagnostic actualisé · suite à vérifier',updated_at=now() WHERE id=$1 AND status='review' AND error=$2",[j.id,genericWeightReason,reason(j.updated_at||j.created_at)]);
 });
}
