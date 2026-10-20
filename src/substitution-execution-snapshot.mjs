// A BC already created is authoritative. Amounts never invalidate an
// equivalence preview or the reconciliation of a previously sent replacement.
const commercial=new Set(['price','total','tax','tax_amount','tax_codes','tax_type','currency','discount','discount_rule_amount','ecotax','pricing','importBcAmounts']);
// Shared stock changes when another order is processed. It is checked again
// against live stock before applying; it is not part of this BC's identity.
// Keep reserved quantities and all historical stock evidence unchanged.
export function substitutionBcSnapshot(bc){
 if(!bc||!Array.isArray(bc.line_items))return bc;
 return {...bc,line_items:bc.line_items.map(line=>{
  if(line.type!=='normal')return line;
  const {available,on_hand,...stable}=line;
  return stable;
 })};
}
export function substitutionExecutionSnapshot(value){
 if(Array.isArray(value))return value.map(substitutionExecutionSnapshot);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>!commercial.has(k)).map(k=>[k,substitutionExecutionSnapshot(value[k])]));
 return value;
}
