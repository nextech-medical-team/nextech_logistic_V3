export const mappingChannels=['amazon','shopify','temu','tender','samples','rakuten'];
export function normalizeMapping(b){
 b={...b,channel:String(b.channel||'').trim().toLowerCase()};if(['tender','samples'].includes(b.channel))throw Error('Aucun mapping pour les appels d’offres et échantillons : SKU Erplain et quantités en unités.');
 if(!mappingChannels.includes(b.channel)||![b.source_sku,b.target_sku].every(x=>typeof x==='string'&&x.trim()&&x.length<200)||![b.source_qty,b.target_qty].every(x=>Number.isFinite(Number(x))&&Number(x)>0))throw Error('Gestionnaire, références et quantités de correspondance requis');
 if(['tender','samples'].includes(b.channel)&&(Number(b.source_qty)!==1||Number(b.target_qty)!==1))throw Error('Les appels d’offres et échantillons sont déjà en unités : correspondance 1 pour 1');
 return {...b,source_sku:b.source_sku.trim(),target_sku:b.target_sku.trim(),source_qty:Number(b.source_qty),target_qty:Number(b.target_qty),notes:String(b.notes||'').slice(0,1000)};
}
export const mutablePreparation=`coalesce(o.suspension->>'active','false')<>'true' AND NOT (o.suspension ? 'erplainCancellation') AND o.archived=false AND o.partial_mode=false AND o.tracking_status NOT IN ('delivered','delivered_simulated','shipped','in_transit') AND coalesce(o.erp_live->'bc'->>'status','') NOT IN ('cancelled','closed','completed') AND NOT EXISTS(SELECT 1 FROM carrier_jobs c WHERE c.order_id=o.id AND (c.status NOT IN ('failed','superseded') OR c.result IS NOT NULL OR jsonb_array_length(c.tracking)>0)) AND NOT EXISTS(SELECT 1 FROM erp_live_jobs e WHERE e.order_id=o.id AND e.status='processing')`;
export async function saveMapping(db,input){
 const b=normalizeMapping(input);
 return db.transaction(async tx=>{
  await tx.query(`INSERT INTO mappings(channel,source_sku,target_sku,source_qty,target_qty,notes,updated_at) VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(channel,source_sku) DO UPDATE SET target_sku=excluded.target_sku,source_qty=excluded.source_qty,target_qty=excluded.target_qty,notes=excluded.notes,updated_at=now()`,[b.channel,b.source_sku,b.target_sku,b.source_qty,b.target_qty,b.notes]);
  const ids=(await tx.query(`SELECT o.id FROM orders o WHERE o.channel=$1 AND nullif(o.erp_live->'bc'->>'id','') IS NULL AND ${mutablePreparation} AND EXISTS(SELECT 1 FROM lines l WHERE l.order_id=o.id AND l.source_sku=$2) FOR UPDATE OF o`,[b.channel,b.source_sku])).rows.map(x=>x.id);
  await tx.query(`UPDATE lines SET target_sku=null,target_quantity=null,source_payload=source_payload-'erplainSourceVariantId'-'erplainCorrectedWeightKg' WHERE source_sku=$1 AND order_id=ANY($2::text[])`,[b.source_sku,ids]);
  await tx.query(`UPDATE jobs SET status='pending',available_at=now(),error=null WHERE kind='label' AND order_id=ANY($1::text[]) AND status<>'processing'`,[ids]);
  return {mapping:b,affected:ids};
 });
}
