import {createHash} from 'node:crypto';
import {convertedQuantity} from './domain.mjs';

// target_* normally caches a previous preparation. It must not override the
// current permanent mapping. An explicitly saved order-only choice is distinct.
export function currentMappingLine(line,channel){
 const explicit=line.source_payload?.mappingScope==='order';
 const sku=explicit?line.target_sku:line.mapped_sku||line.target_sku||(['tender','samples'].includes(channel)?line.source_sku:null);
 const quantity=Number(explicit?line.target_quantity:line.mapped_sku?convertedQuantity(line.quantity,line.source_qty,line.target_qty):line.target_quantity??line.quantity);
 if(!Number.isFinite(quantity)||quantity<=0)throw Error('Quantité invalide : '+(sku||line.source_sku));
 return {sku,quantity};
}

export function mappingSelectionFingerprint(lines,channel){return createHash('sha256').update(JSON.stringify(lines.map(l=>({id:String(l.id),...currentMappingLine(l,channel)})).sort((a,b)=>a.id.localeCompare(b.id)))).digest('hex');}
export async function currentMappingFingerprint(db,o){const lines=(await db.query('SELECT l.*,m.target_sku AS mapped_sku,m.source_qty,m.target_qty FROM lines l LEFT JOIN mappings m ON m.channel=$2 AND m.source_sku=l.source_sku WHERE l.order_id=$1',[o.id,o.channel])).rows;return mappingSelectionFingerprint(lines,o.channel);}
