import {resolveWeight} from './erplain-readonly.mjs';
import {reconcileVerifiedWeights} from './verified-weight-diagnostics.mjs';
export async function initializeBindings(db){await db.exec(`CREATE TABLE IF NOT EXISTS erplain_product_bindings(sku TEXT PRIMARY KEY,live_variant_id TEXT NOT NULL,product JSONB NOT NULL,verified_at TIMESTAMPTZ NOT NULL DEFAULT now());`);}
export async function bindProduct(db,v){
 if(!v?.id||!v.sku||v.active===false||v.product?.active===false)throw Error('Produit Erplain actif requis');
 let weight=null,message=null;try{weight=resolveWeight([v],v.sku).weightKg;}catch(e){message=e.message;}
 await db.transaction(async tx=>{
  await tx.query(`INSERT INTO erplain_product_bindings(sku,live_variant_id,product) VALUES($1,$2,$3) ON CONFLICT(sku) DO UPDATE SET live_variant_id=excluded.live_variant_id,product=excluded.product,verified_at=now()`,[v.sku,String(v.id),JSON.stringify(v)]);
  if(weight){
   await tx.query(`INSERT INTO product_weight_overrides(sku,source_variant_id,live_variant_id,weight_kg) VALUES($1,$2,$3,$4) ON CONFLICT(sku) DO UPDATE SET live_variant_id=excluded.live_variant_id,weight_kg=excluded.weight_kg,verified_at=now()`,[v.sku,String(v.id),String(v.id),weight]);
   await tx.query(`INSERT INTO products(sku,weight_kg,origin) VALUES($1,$2,'erplain_live_corrected') ON CONFLICT(sku) DO UPDATE SET weight_kg=excluded.weight_kg,origin=excluded.origin,updated_at=now()`,[v.sku,weight]);
  }else{await tx.query('DELETE FROM product_weight_overrides WHERE sku=$1',[v.sku]);await tx.query('DELETE FROM products WHERE sku=$1',[v.sku]);}
  await tx.query(`INSERT INTO catalog_results(sku,message) VALUES($1,$2) ON CONFLICT(sku) DO UPDATE SET message=excluded.message,checked_at=now()`,[v.sku,message]);
  // A global SKU can name several physical variants. Refresh only the matching
  // selected variant; never erase another document's verified per-line weight.
  await tx.query(`UPDATE lines l SET source_payload=l.source_payload-'erplainCorrectedWeightKg' WHERE coalesce(l.target_sku,(SELECT m.target_sku FROM mappings m JOIN orders o ON o.channel=m.channel WHERE o.id=l.order_id AND m.source_sku=l.source_sku),l.source_sku)=$1 AND (l.source_payload->>'erplainSourceVariantId' IS NULL OR l.source_payload->>'erplainSourceVariantId'=$2)`,[v.sku,String(v.id)]);
 });
 if(weight)await reconcileVerifiedWeights(db,v.sku);
 return {sku:v.sku,variantId:String(v.id),weightKg:weight,message};
}
