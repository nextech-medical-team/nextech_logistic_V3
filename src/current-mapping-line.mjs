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
