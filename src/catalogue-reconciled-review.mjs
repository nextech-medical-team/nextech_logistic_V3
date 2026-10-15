import {currentMappingLine} from './current-mapping-line.mjs';
import {productCreationBlock} from './missing-product-creation.mjs';

// Only an explicit preparation request may resume this historical local refusal.
// Reconciliation deliberately changes diagnostics only; a NULL error by itself
// never proves that a stopped job can safely run again.
export async function resumeReconciledCatalogueReview(tx,o,j){
 if(j.error!==null||o.issue||o.duplicate_of||o.simulation||o.reference?.startsWith('DEMO-')||o.resolution_pending_resume||o.erp_live?.phase||o.erp_live?.customer||o.erp_live?.stockDocument||o.erp_live?.stockCreationAttemptedAt||productCreationBlock(o))return false;
 const events=(await tx.query("SELECT detail FROM audit WHERE action='diagnostic.catalogue_lookup_reconciled' AND detail->>'orderId'=$1 ORDER BY created_at DESC LIMIT 1",[o.id])).rows;
 const event=events[0]?.detail,proof=event?.proof;
 if(event?.preparationChanged!==false||proof?.status!=='active'||proof.complete!==true||proof.sourceReadOnly!==true||proof.documentId!=null||typeof proof.sku!=='string'||!proof.sku||!/^\d+$/.test(String(proof.variantId||''))||!/^\d+$/.test(String(proof.productId||'')))return false;
 const local=new Set([`Création produit · Nom de la référence convertie à confirmer : ${proof.sku}`,`BC · SKU Erplain LIVE introuvable : ${proof.sku}`]);
 const retired=event.retired?.filter(r=>r.scope==='erp');
 if(!retired?.length||retired.some(r=>!local.has(r.previousMessage)||!Number.isFinite(Date.parse(r.previousUpdatedAt))||Date.parse(r.previousUpdatedAt)!==new Date(j.updated_at).getTime()))return false;
 if(!Number.isFinite(Date.parse(proof.readAt))||Date.parse(proof.readAt)<=new Date(j.updated_at).getTime()||Date.parse(proof.readAt)>Date.now())return false;
 // Current mapping, binding and any creation journal must agree. The worker
 // will reread Erplain and all preparation prerequisites after admission.
 const lines=(await tx.query('SELECT l.*,m.target_sku AS mapped_sku,m.source_qty,m.target_qty FROM lines l LEFT JOIN mappings m ON m.channel=$2 AND m.source_sku=l.source_sku WHERE l.order_id=$1',[o.id,o.channel])).rows;
 try{if(!lines.map(l=>currentMappingLine(l,o.channel)).some(l=>l.sku===proof.sku))return false;}catch{return false;}
 const binding=(await tx.query('SELECT live_variant_id,product FROM erplain_product_bindings WHERE sku=$1',[proof.sku])).rows[0];
 const v=binding?.product;
 if(String(binding?.live_variant_id)!==String(proof.variantId)||String(v?.id)!==String(proof.variantId)||String(v?.product?.id)!==String(proof.productId)||v.sku!==proof.sku||v.active!==true||v.product.active!==true)return false;
 const table=(await tx.query("SELECT to_regclass('erplain_product_creation_attempts') AS name")).rows[0]?.name;
 if(table){const attempts=(await tx.query('SELECT status,product_id,variant_id FROM erplain_product_creation_attempts WHERE sku=$1',[proof.sku])).rows;
  if(attempts.some(a=>a.status!=='verified'||String(a.product_id)!==String(proof.productId)||String(a.variant_id)!==String(proof.variantId)))return false;
 }
 const busy=(await tx.query("SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting','review') UNION ALL SELECT 1 FROM carrier_jobs WHERE order_id=$1 AND status IN ('pending','creating','awaiting_pdf','ready') UNION ALL SELECT 1 FROM correction_jobs WHERE order_id=$1 AND status IN ('queued','applying','checking','waiting','review')",[o.id])).rows;
 if(busy.length)return false;
 await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','erplain.reconciled_catalogue_review_resumed',$1)",[JSON.stringify({orderId:o.id,sku:proof.sku,originalUpdatedAt:j.updated_at,retired,proof,providerReplay:false,explicitPreparationRequest:true})]);
 await tx.query("UPDATE erp_live_jobs SET status='pending',error=null,updated_at=now() WHERE order_id=$1",[o.id]);
 return true;
}
