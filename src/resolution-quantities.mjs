import {currentMappingLine} from './current-mapping-line.mjs';

export function resolveReplacementLines(lines,channel,{bc}={}){
 // An equivalence edits the recorded BC. A later marketplace mapping is a
 // proposal for future orders, not the original product of that document.
 if(bc?.id&&channel!=='tender'){
  const products=Array.isArray(bc.line_items)?bc.line_items.filter(l=>l.type==='normal'):[];
  if(!products.length||products.some(l=>!l.id||!l.variant?.sku||l.quantity==null||typeof l.quantity==='boolean'||!Number.isFinite(Number(l.quantity))||Number(l.quantity)<=0))return lines.map(line=>({...line,replacement_sku:null,replacement_quantity:null,replacement_quantity_error:'Relire les lignes du BC avant de choisir un remplacement'}));
  return products.map(product=>{
   const matches=lines.filter(l=>String(l.source_payload?.bcLineId)===String(product.id)||l.source_sku===product.variant.sku||l.target_sku===product.variant.sku);
   const line=matches.length===1?matches[0]:{};
   return {...line,source_sku:line.source_sku||product.variant.sku,replacement_sku:product.variant.sku,replacement_quantity:Number(product.quantity),replacement_quantity_error:null,recorded_bc_line_id:String(product.id)};
  });
 }
 return lines.map(line=>{
  try{const {sku,quantity}=currentMappingLine(line,channel);return {...line,replacement_sku:sku,replacement_quantity:quantity,replacement_quantity_error:null};}
  catch(e){return {...line,replacement_sku:null,replacement_quantity:null,replacement_quantity_error:e.message};}
 });
}
