import {currentMappingLine} from './current-mapping-line.mjs';

export function resolveReplacementLines(lines,channel){
 return lines.map(line=>{
  try{const {sku,quantity}=currentMappingLine(line,channel);return {...line,replacement_sku:sku,replacement_quantity:quantity,replacement_quantity_error:null};}
  catch(e){return {...line,replacement_sku:null,replacement_quantity:null,replacement_quantity_error:e.message};}
 });
}
