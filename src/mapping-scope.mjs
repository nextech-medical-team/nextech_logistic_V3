import {preserveSubstitutionLabels} from './preserve-substitution-labels.mjs';
export function validateMappingScope(scope){if(!['order','permanent'].includes(scope))throw Error('Choisir : uniquement cette commande ou mapping permanent');}
export async function applyMappingScope(db,b,orderId,saveMapping){
 validateMappingScope(b.scope);
 if(b.scope==='permanent')return saveMapping(db,b);
 const sourceQty=Number(b.source_qty),targetQty=Number(b.target_qty);
 if(!(sourceQty>0&&targetQty>0&&Number.isFinite(sourceQty)&&Number.isFinite(targetQty)))throw Error('Quantités de correspondance invalides');
 return db.transaction(async tx=>{
  await tx.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE',[orderId]);
  await preserveSubstitutionLabels(tx,orderId);
  const r=await tx.query(`UPDATE lines SET target_sku=$3,target_quantity=round(quantity*$4::numeric/$5::numeric,6),source_payload=source_payload||$6::jsonb WHERE order_id=$1 AND source_sku=$2 RETURNING id`,[orderId,b.source_sku.trim(),b.target_sku.trim(),targetQty,sourceQty,JSON.stringify({mappingScope:'order',mappingSourceQty:sourceQty,mappingTargetQty:targetQty})]);
  if(!r.rows.length)throw Error('SKU absent de cette commande');
  return {mapping:b,affected:[orderId],scope:'order'};
 });
}
