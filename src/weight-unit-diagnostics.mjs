import {resolveWeight} from './erplain-readonly.mjs';
const unitError='Unité de poids Erplain absente ou non prise en charge';
export function weightUnitProof(variant,sku){
 if(String(variant?.sku)!==String(sku)||!variant?.id||variant.active===false||variant.product?.active===false)throw Error('Identité du produit actif non vérifiée');
 try{return {sku,variantId:String(variant.id),amount:variant.weight_amount,unit:variant.weight_unit,weightKg:resolveWeight([variant],sku).weightKg,message:null};}
 catch(e){return {sku,variantId:String(variant.id),amount:variant.weight_amount,unit:variant.weight_unit,weightKg:null,message:e.message};}
}
export function reconcileUnitMessage(message,proof,{allowUnqualified=false}={}){
 if(message==null)return message;
 const sku=proof.sku,normal=[`${sku} : ${unitError}`,`${sku} · ${unitError}`];
 return String(message).split(/\s;\s/).map(part=>{
  const exact=part.trim();
  if(normal.includes(exact)||(allowUnqualified&&exact===unitError))return proof.message?(exact===unitError?proof.message:`${sku} : ${proof.message}`):null;
  const prefix=`Produit équivalent [${sku}] : `;
  if(exact===prefix+unitError)return prefix+(proof.message||'Poids vérifié, remplacement à confirmer');
  return part;
 }).filter(part=>part!==null).join(' ; ')||null;
}
// Cache and diagnostic reconciliation only. Never queue, prepare or resume an order.
export async function refreshWeightUnitDiagnostics(db,order,sku,variant){
 const proof=weightUnitProof(variant,sku);
 const busy=(await db.query("SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND status IN ('pending','processing') UNION ALL SELECT 1 FROM carrier_jobs WHERE order_id=$1 AND status IN ('pending','creating','awaiting_pdf')",[order.id])).rows;
 if(busy.length)throw Error('Traitement en cours : attendre avant actualisation du diagnostic');
 await db.transaction(async tx=>{
  const current=(await tx.query('SELECT id,issue,erp_live FROM orders WHERE id=$1 FOR UPDATE',[order.id])).rows[0];if(!current)throw Error('Commande introuvable');
  const lines=(await tx.query('SELECT target_sku,source_sku,source_payload FROM lines WHERE order_id=$1',[order.id])).rows;
  const affected=lines.filter(l=>(l.target_sku||l.source_sku)===sku);
  if(affected.some(l=>l.source_payload?.erplainSourceVariantId!=null&&String(l.source_payload.erplainSourceVariantId)!==proof.variantId))throw Error('Variante physique différente sur la commande : diagnostic conservé');
  if(!affected.length){const replacement=(await tx.query("SELECT payload FROM resolution_jobs WHERE order_id=$1 AND status='review' AND action IN ('equivalent-preview','replace-equivalent') ORDER BY created_at DESC,id DESC LIMIT 1",[order.id])).rows[0];if(replacement?.payload?.replacementSku!==sku)throw Error('SKU absent de la commande et du remplacement prévu');}
  const bound=(await tx.query('SELECT live_variant_id FROM erplain_product_bindings WHERE sku=$1 FOR UPDATE',[sku])).rows[0];
  if(bound&&String(bound.live_variant_id)!==proof.variantId)throw Error('Liaison produit différente : actualisation du diagnostic à rapprocher');
  await tx.query(`INSERT INTO erplain_product_bindings(sku,live_variant_id,product) VALUES($1,$2,$3) ON CONFLICT(sku) DO UPDATE SET product=excluded.product,verified_at=now()`,[sku,proof.variantId,JSON.stringify(variant)]);
  if(proof.weightKg){
   await tx.query(`INSERT INTO product_weight_overrides(sku,source_variant_id,live_variant_id,weight_kg) VALUES($1,$2,$2,$3) ON CONFLICT(sku) DO UPDATE SET weight_kg=excluded.weight_kg,verified_at=now()`,[sku,proof.variantId,proof.weightKg]);
   await tx.query(`INSERT INTO products(sku,weight_kg,origin) VALUES($1,$2,'erplain_live_corrected') ON CONFLICT(sku) DO UPDATE SET weight_kg=excluded.weight_kg,origin=excluded.origin,updated_at=now()`,[sku,proof.weightKg]);
   await tx.query(`UPDATE lines SET source_payload=jsonb_set(source_payload,'{erplainCorrectedWeightKg}',$3::jsonb) WHERE order_id=$1 AND source_payload->>'erplainSourceVariantId'=$2 AND coalesce(target_sku,source_sku)=$4`,[order.id,proof.variantId,JSON.stringify(proof.weightKg),sku]);
  }else{
   await tx.query('DELETE FROM product_weight_overrides WHERE sku=$1 AND live_variant_id=$2',[sku,proof.variantId]);
   await tx.query('DELETE FROM products WHERE sku=$1',[sku]);
  }
  await tx.query(`INSERT INTO catalog_results(sku,message) VALUES($1,$2) ON CONFLICT(sku) DO UPDATE SET message=excluded.message,checked_at=now()`,[sku,proof.message]);
  const issue=reconcileUnitMessage(current.issue,proof);
  const previous=current.erp_live||{},audit=previous.lastAudit;
  const issues=Array.isArray(audit?.issues)?audit.issues.map(x=>reconcileUnitMessage(x,proof)).filter(Boolean):audit?.issues;
  if(issue!==current.issue||audit&&JSON.stringify(issues)!==JSON.stringify(audit.issues)){
   const live=audit?{...previous,lastAudit:{...audit,issues,unitDiagnosticVerifiedAt:new Date().toISOString()}}:previous;
   await tx.query('UPDATE orders SET issue=$2,erp_live=$3 WHERE id=$1',[order.id,issue,JSON.stringify(live)]);
  }
  const jobs=(await tx.query("SELECT id,error,payload FROM resolution_jobs WHERE order_id=$1 AND status='review' FOR UPDATE",[order.id])).rows;
  for(const job of jobs){if(job.payload?.variantId!=null&&String(job.payload.variantId)!==proof.variantId)continue;const error=reconcileUnitMessage(job.error,proof);if(error!==job.error)await tx.query("UPDATE resolution_jobs SET error=$2 WHERE id=$1 AND error=$3 AND status='review'",[job.id,error,job.error]);}
  const erp=(await tx.query('SELECT error FROM erp_live_jobs WHERE order_id=$1 FOR UPDATE',[order.id])).rows[0];
  if(erp){const error=reconcileUnitMessage(erp.error,proof);if(error!==erp.error)await tx.query('UPDATE erp_live_jobs SET error=$2 WHERE order_id=$1',[order.id,error]);}
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','diagnostic.weight_unit_refreshed',$1)",[JSON.stringify({orderId:order.id,...proof,preparationChanged:false})]);
 });
 return {provider:'Erplain',readOnly:true,diagnosticOnly:true,sourceReadOnly:true,localDiagnosticUpdates:true,proof,message:proof.message?'Diagnostic de poids actualisé : '+proof.message:'Poids relu et diagnostic d’unité actualisé. La préparation reste inchangée.',errors:[]};
}
