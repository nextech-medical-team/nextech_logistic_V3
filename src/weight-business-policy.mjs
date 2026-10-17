// Human rules, 10 October 2026: missing weight = 5 g; only explicit kg means kg.
// Unknown/absent units mean grams. Existing positive values are never replaced.
export const DEFAULT_UNIT_WEIGHT_GRAMS=5;
export function missingWeight(value){return value==null||(typeof value==='string'&&!value.trim());}
export function businessWeight(weightAmount,weightUnit){
 if(missingWeight(weightAmount))return {weightKg:DEFAULT_UNIT_WEIGHT_GRAMS/1000,defaulted:true,unit:'g'};
 if(!['number','string'].includes(typeof weightAmount))throw Error('Poids unitaire invalide dans Erplain');
 const amount=Number(weightAmount);
 if(!Number.isFinite(amount)||amount<=0)throw Error('Poids unitaire invalide dans Erplain');
 const unit=typeof weightUnit==='string'&&weightUnit.trim().toLowerCase()==='kg'?'kg':'g';
 const weightKg=unit==='kg'?amount:amount/1000;
 if(!Number.isFinite(weightKg)||weightKg<=0)throw Error('Poids unitaire invalide dans Erplain');
 return {weightKg,defaulted:false,unit};
}

// Explicit maintenance action only. Conversion/ingestion never writes to Erplain.
// Journal is persisted before mutation; an uncertain write must be reconciled, not replayed.
export async function fillMissingVariantWeight(api,expected,{checkpoint}={}){
 if(!expected?.id||!expected?.sku||typeof checkpoint!=='function')throw Error('Identité et journal persistants requis');
 const query='query V3BusinessWeightRead($id:ID!){Variant(id:$id){id sku active weight_amount weight_unit product{id active}}}';
 const read=async()=>{
  const {Variant:v}=await api.request(query,{id:String(expected.id)});
  if(!v||String(v.id)!==String(expected.id)||v.sku!==expected.sku||v.active!==true||v.product?.active!==true||expected.productId&&String(v.product.id)!==String(expected.productId))throw Error('Identité produit active différente');
  if(!Object.hasOwn(v,'weight_amount')||!Object.hasOwn(v,'weight_unit'))throw Error('Lecture du poids Erplain incomplète : aucune écriture');
  return v;
 };
 const before=await read();
 if(!missingWeight(before.weight_amount)){await checkpoint({state:'preserved',before,after:before});return {changed:false,variant:before};}
 await checkpoint({state:'submitting',before});
 try{
  await api.request('mutation V3BusinessMissingWeight($id:ID!,$input:VariantInput!){UpdateVariant(id:$id,input:$input){id}}',{id:String(expected.id),input:{weight_amount:DEFAULT_UNIT_WEIGHT_GRAMS,weight_unit:'g'}});
  const after=await read();
  if(after.weight_amount==null||Number(after.weight_amount)!==DEFAULT_UNIT_WEIGHT_GRAMS||after.weight_unit!=='g')throw Error('Enregistrement des 5 g non confirmé');
  await checkpoint({state:'verified',before,after});return {changed:true,variant:after};
 }catch(error){await checkpoint({state:'uncertain',before});throw error;}
}
