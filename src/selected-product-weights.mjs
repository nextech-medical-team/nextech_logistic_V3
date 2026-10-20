import {resolveWeight} from './erplain-readonly.mjs';
import {convertedQuantity} from './domain.mjs';
import {parcelWeightKg} from './weight-arithmetic.mjs';
// Produce per-order weights from exactly the variants used for that order's BC.
// Zero means explicitly unknown; SQL COALESCE must not borrow another variant's
// global SKU weight in that case. The caller keeps the missing-weight problem.
export function selectedProductWeights(lines,products,items){
 if(!Array.isArray(lines)||!lines.length||!Array.isArray(items))throw Error('Poids sélectionnés : lignes absentes');
 const byId=new Map(),updates=[],missing=[];let weightKg=0;
 for(const line of lines){
  if(!line.id||byId.has(String(line.id)))throw Error('Poids sélectionnés : ligne absente ou dupliquée');byId.set(String(line.id),line);
  const sku=line.target_sku||line.mapped_sku||line.source_sku,variant=products?.[sku];
  if(!sku||!variant?.id||variant.sku!==sku||variant.active!==true||variant.product?.active!==true)throw Error('Poids sélectionnés : identité active non vérifiée pour '+sku);
  const quantity=Number(line.target_quantity??(line.source_qty?convertedQuantity(line.quantity,line.source_qty,line.target_qty):line.quantity));
  if(!Number.isFinite(quantity)||quantity<=0)throw Error('Poids sélectionnés : quantité invalide pour '+sku);
  const expected=items.filter(i=>String(i.variant?.id)===String(variant.id));
  if(!expected.length)throw Error('Poids sélectionnés : variante différente du BC pour '+sku);
  let unitWeight=0,error=null;try{unitWeight=resolveWeight([variant],sku).weightKg;}catch(e){error=String(e.message);missing.push({sku,variantId:String(variant.id),message:error});}
  weightKg+=unitWeight*quantity;
  updates.push({id:String(line.id),sku,variantId:String(variant.id),quantity,weightKg:unitWeight,error,sourcePayload:{erplainSourceVariantId:String(variant.id),erplainCorrectedWeightKg:unitWeight}});
 }
 // Compare aggregates as one SKU can legitimately occupy several source rows.
 const planned=new Map(),actual=new Map();
 for(const u of updates)planned.set(u.variantId,(planned.get(u.variantId)||0)+u.quantity);
 for(const i of items){const id=String(i.variant?.id||''),q=Number(i.quantity);if(!id||!Number.isFinite(q)||q<=0)throw Error('Poids sélectionnés : articles BC incomplets');actual.set(id,(actual.get(id)||0)+q);}
 if(planned.size!==actual.size||[...planned].some(([id,q])=>Math.abs(q-(actual.get(id)??NaN))>1e-6||!actual.has(id)))throw Error('Poids sélectionnés : quantités différentes du BC');
 if(!Number.isFinite(weightKg))throw Error('Poids sélectionnés : poids total invalide');
 return {updates,missing,weightKg:missing.length?null:parcelWeightKg(weightKg)};
}

// This writes only preparation metadata, never products, BCs, BLs or labels.
// A missing row aborts the transaction rather than leaving a partially saved plan.
export async function cacheSelectedProductWeights(db,orderId,plan){
 if(!orderId||!Array.isArray(plan?.updates)||!plan.updates.length)throw Error('Poids sélectionnés : plan absent');
 await db.transaction(async tx=>{
  for(const u of plan.updates){
   const r=await tx.query('UPDATE lines SET source_payload=source_payload||$3::jsonb WHERE id=$1 AND order_id=$2 RETURNING id',[u.id,orderId,JSON.stringify(u.sourcePayload)]);
   if(r.rows.length!==1)throw Error('Poids sélectionnés : ligne modifiée pendant la préparation');
  }
 });
 return plan;
}
