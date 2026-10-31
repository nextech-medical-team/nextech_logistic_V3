// Read-only creation gate. Stock availability and allocation are checked by
// the stock workflow; this check never creates a batch or reserves stock.
const marketplaceChannels=new Set(['amazon','temu','shopify']);
// Explicit BL-only exceptions requested on 2026-10-31. Match the effective
// Erplain SKU exactly; stock and Erplain document validation still apply.
const batchExemptSkus=new Set(['2311859-02','2311860-02','2311858-02','2311861-02','27817-02','27818-02','27819-02','270123','271602','271603','2318021']);
function tenderManager(label){
 const name=String(label??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
 return name==='appeldoffres'||name==='appelsdoffres';
}

// The effective Erplain variant is the shared identity after SKU mapping and
// substitutions. Read all matching BC pages, including historical documents;
// an unavailable/incomplete answer must never mean "not a tender product".
async function usedInTenderOrder(api,id){
 const seen=new Set();
 for(let page=1;page<=100;page++){
  const result=await api.request('query V3BlTenderProductOrders($where:QueryOrdersWhereWhereConditions!,$page:Int!){Orders(first:100,page:$page,where:$where,orderBy:[{column:ID,order:ASC}]){data{id account_representative{id label} line_items{type variant{id}}} paginatorInfo{hasMorePages currentPage}}}',{where:{column:'VARIANT_ID',operator:'EXISTS',value:id},page});
  const orders=result?.Orders;
  const incomplete=()=>Error('périmètre Appel d’offres non vérifiable dans Erplain');
  if(!Array.isArray(orders?.data)||typeof orders.paginatorInfo?.hasMorePages!=='boolean'||orders.paginatorInfo.currentPage!==page)throw incomplete();
  for(const bc of orders.data){
   if(!bc?.id||seen.has(String(bc.id))||!Object.hasOwn(bc,'account_representative')||!Array.isArray(bc.line_items)||!bc.line_items.some(l=>(!l.type||l.type==='normal')&&String(l.variant?.id)===id))throw incomplete();
   const manager=bc.account_representative;
   if(manager!==null&&(!manager?.id||typeof manager.label!=='string'||!manager.label.trim()))throw incomplete();
   seen.add(String(bc.id));
   if(tenderManager(manager?.label))return true;
  }
  if(!orders.paginatorInfo.hasMorePages)return false;
  if(!orders.data.length)throw incomplete();
 }
 throw Error('périmètre Appel d’offres non vérifiable dans Erplain : pagination incomplète');
}

export async function assertBlBatchNumbers(api,order,lines){
 const prefix='BL · Lot de traçabilité Erplain';
 const tender=order?.channel==='tender'||tenderManager(order?.erp_live?.bc?.account_representative?.label);
 if(!tender&&!marketplaceChannels.has(order?.channel))return;
 if(!Array.isArray(lines)||!lines.length)throw Error(prefix+' : produits non vérifiables');
 const variants=new Map();
 for(const line of lines){
  if(line.type&&line.type!=='normal')continue;
  const id=String(line.variant?.id||'');
  if(!id)throw Error(prefix+' : produit non identifié');
  variants.set(id,{sku:line.variant?.sku||line.description||id,exempt:batchExemptSkus.has(String(line.variant?.sku??'').trim())});
 }
 if(!variants.size)throw Error(prefix+' : aucun produit à contrôler');
 const failures=[];
 for(const [id,{sku,exempt}] of variants){
  if(exempt)continue;
  try{
  const fail=reason=>Error(prefix+' · '+sku+' : '+reason+' — création BL bloquée');
  if(!tender&&!await usedInTenderOrder(api,id))continue;
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
  }catch(error){
   const message=String(error?.message||error);
   failures.push(message.startsWith(prefix+' · ')?message:prefix+' · '+sku+' : '+message+' — création BL bloquée');
  }
 }
 if(failures.length)throw Error(failures.join(' ; '));
}
