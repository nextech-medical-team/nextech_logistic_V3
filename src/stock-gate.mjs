const stockNumeric=value=>(typeof value==='number'||typeof value==='string'&&value.trim()!=='')&&Number.isFinite(Number(value));
export function assertFullOrderStock(lines){
 const groups=new Map();
 for(const l of lines){if(!l.variant)continue;if(l.variant.track_inventory===false)continue;
 const key=l.variant.id+':'+l.location?.id;if(!l.location?.id)throw new Error('Lieu de stockage absent : '+l.variant.sku);
 const qty=stockNumeric(l.quantity)?Number(l.quantity):NaN,available=l.available,onHand=l.on_hand,reserved=l.reserved_quantity;
 if(!stockNumeric(l.quantity)||qty<=0||![available,onHand,reserved].every(stockNumeric))throw new Error('Stock non vérifiable : '+l.variant.sku);
 const g=groups.get(key)||{sku:l.variant.sku,need:0,reserved:0,available:Number(available),onHand:Number(onHand)};
 g.need+=qty;g.reserved+=Math.max(0,Number(reserved));g.available=Math.min(g.available,Number(available));g.onHand=Math.min(g.onHand,Number(onHand));groups.set(key,g);
 }
 const missing=[...groups.values()].map(g=>({...g,usable:Math.max(0,Math.min(g.onHand,g.available+g.reserved))})).filter(g=>g.usable+1e-6<g.need);
 if(missing.length)throw new Error('BL bloqué — stock insuffisant : '+missing.map(g=>`${g.sku} : ${g.need} nécessaires, ${g.usable} utilisables, manque ${Math.round((g.need-g.usable)*1e6)/1e6}`).join(' ; '));
 return true;
}

export async function assertStockResolved(db,variantIds,{orderId='',deliveryId=''}={}){
 const partial=(await db.query("SELECT d.id FROM partial_deliveries d WHERE d.id<>$2 AND d.bl->>'status'='pending' AND d.stock_document IS NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(d.selection) AS x(value) WHERE x.value->>'variantId'=ANY($1::text[])) LIMIT 1",[variantIds.map(String),deliveryId])).rows;
 const full=(await db.query("SELECT id FROM orders WHERE id<>$2 AND erp_live->>'phase'='creating_stock' AND erp_live->'stockDocument' IS NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(erp_live->'stockPendingVariants','[]'::jsonb)) AS x(value) WHERE x.value=ANY($1::text[])) LIMIT 1",[variantIds.map(String),orderId])).rows;
 if(partial.length||full.length)throw new Error('Mouvement de stock précédent à rapprocher pour ces produits avant nouvelle livraison');
}
