import {businessWeight,missingWeight} from './weight-business-policy.mjs';
import {chooseActiveStockVariant} from './active-stock-choice.mjs';

export async function weightVariantForCache(db,variants,sku,locationId){
 const active=variants.filter(v=>v.sku===sku&&v.active===true&&v.product?.active===true);
 const pins=(await db.query('SELECT live_variant_id FROM erplain_product_bindings WHERE sku=$1 UNION SELECT live_variant_id FROM product_weight_overrides WHERE sku=$1',[sku])).rows.map(r=>String(r.live_variant_id));
 if(pins.length){const selected=active.filter(v=>pins.every(id=>id===String(v.id)));if(selected.length!==1)throw Error('Variante liée absente ou ambiguë : '+sku);return selected[0];}
 if(active.length===1)return active[0];
 return chooseActiveStockVariant(variants,{sku,locationId:typeof locationId==='function'?await locationId():locationId}).variant;
}

// A provider value, not a locally defaulted value, is the cache authority.
// Existing identity choices and weights attached to completed documents stay intact.
export async function cacheProviderWeight(db,v){
 if(!v?.id||!v.sku||v.active!==true||v.product?.active!==true)throw Error('Identité produit active non vérifiée');
 if(missingWeight(v.weight_amount))throw Error('Poids absent dans Erplain : enregistrement des 5 g à confirmer');
 const weight=businessWeight(v.weight_amount,v.weight_unit).weightKg;
 return db.transaction(async tx=>{
  const binding=(await tx.query('SELECT live_variant_id FROM erplain_product_bindings WHERE sku=$1 FOR UPDATE',[v.sku])).rows[0];
  const override=(await tx.query('SELECT live_variant_id FROM product_weight_overrides WHERE sku=$1 FOR UPDATE',[v.sku])).rows[0];
  if([binding,override].some(b=>b&&String(b.live_variant_id)!==String(v.id)))throw Error('Variante liée différente : poids conservés');
  if(binding)await tx.query('UPDATE erplain_product_bindings SET product=$2,verified_at=now() WHERE sku=$1 AND live_variant_id=$3',[v.sku,JSON.stringify(v),String(v.id)]);
  if(override)await tx.query('UPDATE product_weight_overrides SET weight_kg=$2,verified_at=now() WHERE sku=$1 AND live_variant_id=$3',[v.sku,weight,String(v.id)]);
  await tx.query(`INSERT INTO products(sku,weight_kg,origin,updated_at) VALUES($1,$2,'erplain_readonly',now()) ON CONFLICT(sku) DO UPDATE SET weight_kg=excluded.weight_kg,updated_at=now()`,[v.sku,weight]);
  await tx.query(`INSERT INTO catalog_results(sku,message,checked_at) VALUES($1,null,now()) ON CONFLICT(sku) DO UPDATE SET message=null,checked_at=now()`,[v.sku]);
  // A recorded BL or purchased/uncertain shipment keeps its historical metadata.
  await tx.query(`UPDATE lines l SET source_payload=jsonb_set(l.source_payload,'{erplainCorrectedWeightKg}',$3::jsonb)
   FROM orders o WHERE l.order_id=o.id AND l.source_payload->>'erplainSourceVariantId'=$2
   AND coalesce(l.target_sku,(SELECT m.target_sku FROM mappings m WHERE m.channel=o.channel AND m.source_sku=l.source_sku),l.source_sku)=$1
   AND NOT o.archived AND NOT o.partial_mode AND o.erp_live->'bl'->>'id' IS NULL
   AND o.channel<>'tender' AND NOT coalesce(o.source_payload->'externalLabel'->>'active','false')::boolean
   AND NOT EXISTS(SELECT 1 FROM erp_live_jobs e WHERE e.order_id=o.id AND e.status IN ('pending','processing'))
   AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting'))
   AND NOT EXISTS(SELECT 1 FROM carrier_jobs c WHERE c.order_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM carrier_documents d WHERE d.order_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM carrier_label_history d WHERE d.order_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM temu_label_jobs t WHERE t.reference=o.reference)
   AND NOT EXISTS(SELECT 1 FROM partial_deliveries d WHERE d.order_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM extra_parcels x WHERE x.order_id=o.id)`,[v.sku,String(v.id),JSON.stringify(weight)]);
  return {sku:v.sku,variantId:String(v.id),weightKg:weight};
 });
}
