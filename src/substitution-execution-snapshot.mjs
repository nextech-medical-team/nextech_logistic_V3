// A BC already created is authoritative. Amounts never invalidate an
// equivalence preview or the reconciliation of a previously sent replacement.
const commercial=new Set(['price','total','tax','tax_amount','tax_codes','tax_type','currency','discount','discount_rule_amount','ecotax','pricing','importBcAmounts']);
export function substitutionExecutionSnapshot(value){
 if(Array.isArray(value))return value.map(substitutionExecutionSnapshot);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>!commercial.has(k)).map(k=>[k,substitutionExecutionSnapshot(value[k])]));
 return value;
}
