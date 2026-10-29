// Read-only creation gate. Stock availability and allocation are checked by
// the stock workflow; this check never creates a batch or reserves stock.
export async function assertBlBatchNumbers(api,order,lines){
 const prefix='BL · Lot de traçabilité Erplain';
 if(!Array.isArray(lines)||!lines.length)throw Error(prefix+' : produits non vérifiables');
 const variants=new Map();
 for(const line of lines){
  if(line.type&&line.type!=='normal')continue;
  const id=String(line.variant?.id||'');
  if(!id)throw Error(prefix+' : produit non identifié');
  variants.set(id,line.variant?.sku||line.description||id);
 }
 if(!variants.size)throw Error(prefix+' : aucun produit à contrôler');
 for(const [id,sku] of variants){
  const fail=reason=>Error(prefix+' · '+sku+' : '+reason+' ; création BL bloquée');
  const v=(await api.request('query V3BlBatchVariant($id:ID!){Variant(id:$id){id sku has_batch_numbers}}',{id})).Variant;
  if(String(v?.id)!==id||typeof v.has_batch_numbers!=='boolean')throw fail('traçabilité non vérifiable');
  if(!v.has_batch_numbers)throw fail('activer la gestion des lots et renseigner un numéro de lot dans Erplain');
  let found=false;
  for(let page=1;page<=100;page++){
   const result=await api.request('query V3BlBatchNumbers($where:QueryBatchNumbersWhereWhereConditions!,$page:Int!){BatchNumbers(first:100,page:$page,where:$where){data{id label variant_id} paginatorInfo{hasMorePages}}}',{where:{column:'VARIANT_ID',operator:'EQ',value:id},page});
   const batches=result.BatchNumbers;
   if(!Array.isArray(batches?.data)||typeof batches.paginatorInfo?.hasMorePages!=='boolean'||batches.data.some(b=>String(b?.variant_id)!==id))throw fail('lecture des lots incomplète ou produit différent');
   if(batches.data.some(b=>b.id&&typeof b.label==='string'&&b.label.trim())){found=true;break;}
   if(!batches.paginatorInfo.hasMorePages)throw fail('numéro de lot absent dans Erplain');
   if(!batches.data.length)throw fail('lecture des lots incomplète');
  }
  if(!found)throw fail('lecture des lots incomplète');
 }
}
