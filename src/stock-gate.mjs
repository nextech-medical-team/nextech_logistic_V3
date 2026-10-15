const stockNumeric=value=>(typeof value==='number'||typeof value==='string'&&value.trim()!=='')&&Number.isFinite(Number(value));
export function assertFullOrderStock(lines){
 const groups=new Map();
 for(const l of lines){if(!l.variant)continue;
 if(!stockNumeric(l.quantity)||Number(l.quantity)<=0)throw new Error('Quantité produit invalide : '+l.variant.sku);
 if(l.variant.track_inventory===false)continue;
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

export const stockLockMessage='Mouvement de stock précédent à rapprocher pour ces produits avant nouvelle livraison';
export function isStockLockMessage(message){return message===stockLockMessage||String(message||'').startsWith(stockLockMessage+' · ');}
export async function assertStockResolved(db,variantIds,{orderId='',deliveryId=''}={}){
 const partial=(await db.query("SELECT d.id,o.reference,d.bl->>'label' bl_label,d.updated_at FROM partial_deliveries d JOIN orders o ON o.id=d.order_id WHERE d.id<>$2 AND d.bl->>'status'='pending' AND (d.stock_document IS NULL OR d.stock_document='null'::jsonb) AND EXISTS(SELECT 1 FROM jsonb_array_elements(d.selection) AS x(value) WHERE x.value->>'variantId'=ANY($1::text[])) ORDER BY d.updated_at,d.id LIMIT 1",[variantIds.map(String),deliveryId])).rows;
 const full=(await db.query("SELECT o.id,o.reference,o.erp_live->'bl'->>'label' bl_label,e.updated_at FROM orders o LEFT JOIN erp_live_jobs e ON e.order_id=o.id WHERE o.id<>$2 AND o.erp_live->>'phase'='creating_stock' AND (o.erp_live->'stockDocument' IS NULL OR o.erp_live->'stockDocument'='null'::jsonb) AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(o.erp_live->'stockPendingVariants','[]'::jsonb)) AS x(value) WHERE x.value=ANY($1::text[])) ORDER BY e.updated_at NULLS LAST,o.id LIMIT 1",[variantIds.map(String),orderId])).rows;
 if(partial.length||full.length){
  const blocker=partial[0]||full[0],age=Date.now()-Date.parse(blocker.updated_at),overdue=Number.isFinite(age)&&age>=900000;
  const detail=[blocker.reference&&'commande '+blocker.reference,blocker.bl_label&&'BL '+blocker.bl_label,overdue&&'blocage prolongé : rapprochement requis'].filter(Boolean).join(' · ');
  const error=new Error(stockLockMessage+(detail?' · '+detail:''));error.code='STOCK_RECONCILIATION_PENDING';error.blockerId=blocker.id;error.blockerReference=blocker.reference;error.overdue=overdue;throw error;
 }
}
