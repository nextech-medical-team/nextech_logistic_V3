import {currentMappingLine} from './current-mapping-line.mjs';
// Resolve the same physical quantities as preparation without writing lines or BCs.
export function comparisonLines(lines,channel){
 if(!lines.length)throw Error('Comparaison BC impossible : aucune ligne de commande');
 return lines.map(l=>{
  const {sku,quantity}=currentMappingLine(l,channel);
  if(!sku)throw Error('Mapping manquant : '+l.source_sku);
  if(!Number.isFinite(quantity)||quantity<=0)throw Error('Quantité invalide : '+sku);
  return {sku,quantity};
 });
}
export async function readComparisonLines(db,order){
 const {rows}=await db.query('SELECT l.*,m.target_sku AS mapped_sku,m.source_qty,m.target_qty FROM lines l LEFT JOIN mappings m ON m.channel=$2 AND m.source_sku=l.source_sku WHERE l.order_id=$1',[order.id,order.channel]);
 return comparisonLines(rows,order.channel);
}
