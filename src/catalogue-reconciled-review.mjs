import {currentMappingLine} from './current-mapping-line.mjs';
import {productCreationBlock} from './missing-product-creation.mjs';

// Admission requires the exact historical reconciliation, never just a NULL error.
// Reconciliation deliberately changes diagnostics only; a NULL error by itself
// never proves that a stopped job can safely run again.
export async function resumeReconciledCatalogueReview(tx,o,j,{automatic=false}={}){
 if(o.source_payload?.temuDirect?.attemptedAt)return false;
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
 await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','erplain.reconciled_catalogue_review_resumed',$1)",[JSON.stringify({orderId:o.id,sku:proof.sku,originalUpdatedAt:j.updated_at,retired,proof,providerReplay:false,explicitPreparationRequest:!automatic,automaticRecovery:automatic})]);
 await tx.query("UPDATE erp_live_jobs SET status='pending',error=null,updated_at=now() WHERE order_id=$1",[o.id]);
 return true;
}

// The initial automatic queue used ON CONFLICT DO NOTHING, so an audited review
// could remain stopped forever after its obsolete catalogue error was removed.
// Rotate through eligible history without changing timestamps of rejected jobs.
// Only the existing guarded admission below changes a job, not any document or
// label. The normal worker rereads the provider before creating the first BC.
export async function resumeAuditedCatalogueReviews(db,{afterId='',limit=25}={}){
 if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('Lot catalogue invalide');
 return db.transaction(async tx=>{
  const rows=(await tx.query(`SELECT o.*,e.updated_at review_updated FROM orders o JOIN erp_live_jobs e ON e.order_id=o.id
   WHERE e.status='review' AND e.error IS NULL AND o.channel IN ('temu','amazon','shopify')
   AND NOT o.archived AND NOT o.partial_mode AND NOT o.resolution_pending_resume
   AND coalesce(o.suspension->>'active','false')<>'true' AND NOT (o.suspension ? 'erplainCancellation')
   AND coalesce(o.issue,'')='' AND o.erp_live->'bc'->>'id' IS NULL AND o.erp_live->'bl'->>'id' IS NULL
   AND coalesce(o.erp_live->>'phase','')='' AND o.erp_live->'customer'->>'id' IS NULL
   AND coalesce(o.tracking_status,'') IN ('not_shipped','unknown') AND coalesce(o.label_status,'')<>'cancelled'
   AND EXISTS(SELECT 1 FROM audit a WHERE a.action='diagnostic.catalogue_lookup_reconciled' AND a.detail->>'orderId'=o.id)
   ORDER BY (o.id>$1) DESC,o.id LIMIT $2 FOR UPDATE OF o,e SKIP LOCKED`,[afterId,limit])).rows;
  let resumed=0;
  for(const o of rows)if(await resumeReconciledCatalogueReview(tx,o,{error:null,updated_at:o.review_updated},{automatic:true}))resumed++;
  return {resumed,checked:rows.length,afterId:rows.at(-1)?.id||'',providerWrites:0};
 });
}
