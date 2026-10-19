import {validateReceiptNumber,receiptLines} from './receipt-recovery-plan.mjs';
import {receiptCandidates} from './receipt-candidates.mjs';
import {readErplainDocuments} from './erplain-document-read.mjs';

const fields='id label status update_stock line_items{type quantity variant{id sku} location{id label}}';
function pageData(c){if(!Array.isArray(c?.data)||typeof c.paginatorInfo?.hasMorePages!=='boolean')throw Error('Pagination ERPLAIN non vérifiable');return c;}
export async function readReceipt(api,value){
 const number=validateReceiptNumber(value);await api.verify();
 let receipts=[];
 if(/^\d+$/.test(number)){
  const r=await api.request(`query V3ReceiptById($id:ID!){PurchaseReceipt(id:$id){${fields}}}`,{id:number});if(r.PurchaseReceipt)receipts=[r.PurchaseReceipt];
 }else{
  const r=await api.request(`query V3ReceiptByLabel($where:QueryPurchaseReceiptsWhereWhereConditions){PurchaseReceipts(first:2,where:$where){data{${fields}} paginatorInfo{hasMorePages}}}`,{where:{column:'LABEL',operator:'EQ',value:number}});
  const c=pageData(r.PurchaseReceipts);if(c.paginatorInfo.hasMorePages||c.data.length>1)throw Error('Numéro de réception ambigu');receipts=c.data;
 }
 if(!receipts.length){
  const r=await api.request('query V3ReceiptPurchase($where:QueryPurchasesWhereWhereConditions){Purchases(first:2,where:$where){data{id label} paginatorInfo{hasMorePages}}}',{where:{column:'LABEL',operator:'EQ',value:number}});
  const c=pageData(r.Purchases);if(c.paginatorInfo.hasMorePages||c.data.length!==1)throw Error('Réception ou achat introuvable, ou numéro ambigu');
  const purchase=c.data[0],seen=new Set();
  for(let page=1;page<=100;page++){
   const q=await api.request(`query V3PurchaseReceipts($id:ID!,$page:Int!){Purchase(id:$id){id purchase_receipts(first:100,page:$page){data{${fields}} paginatorInfo{hasMorePages}}}}`,{id:String(purchase.id),page});
   if(String(q.Purchase?.id)!==String(purchase.id))throw Error('Identité achat non confirmée');const connection=pageData(q.Purchase.purchase_receipts);
   for(const item of connection.data){if(!item.id||seen.has(String(item.id)))throw Error('Pagination des réceptions incohérente');seen.add(String(item.id));receipts.push(item);}
   if(!connection.paginatorInfo.hasMorePages)break;if(!connection.data.length||page===100)throw Error('Réceptions incomplètes');
  }
 }
 receiptLines(receipts);return receipts;
}
export async function readRecoveryBcs(api,orders){
 const ids=[...new Set(orders.map(o=>String(o.erp_live?.bc?.id||'')).filter(Boolean))],bcs=new Map(),errors=new Map();
 const fields='id label status update_stock line_items{type quantity reserved_quantity shipped_quantity available on_hand location{id} variant{id sku track_inventory}} shipping_orders(first:100){data{id label status update_stock} paginatorInfo{hasMorePages}}';
 for(let start=0;start<ids.length;start+=100){
  const batch=ids.slice(start,start+100);
  try{
   // One paginated collection avoids ERPLAIN's 250-point alias complexity cap.
   const result=await api.request(`query V3ReceiptOrderStock($where:QueryOrdersWhereWhereConditions){Orders(first:100,where:$where){data{${fields}} paginatorInfo{hasMorePages}}}`,{where:{column:'ID',operator:'IN',value:batch}});
   const connection=pageData(result.Orders);if(connection.paginatorInfo.hasMorePages)throw Error('Liste des BC incomplète');
   const returned=new Map();for(const bc of connection.data){if(!bc?.id||!batch.includes(String(bc.id))||returned.has(String(bc.id)))throw Error('Identité BC non confirmée');returned.set(String(bc.id),bc);}
   for(const id of batch){let bc=returned.get(id);if(!bc)throw Error('BC demandé absent de la réponse');if(bc.shipping_orders?.paginatorInfo?.hasMorePages)bc=await readErplainDocuments(api,id);bcs.set(id,bc);}
  }catch(e){
   const deferred=e.httpStatus===429||e.httpStatus>=500||/(?:HTTP\s+)?(?:429|503|504)|timeout|network|fetch failed|ETIMEDOUT|ECONN/i.test(e.message);
   const unavailable=deferred?ids.slice(start):batch;
   for(const o of orders.filter(o=>unavailable.includes(String(o.erp_live?.bc?.id))))errors.set(o.id,'Lecture BC indisponible : '+e.message);
   if(deferred)break;
  }
 }
 return {bcs,errors};
}

// Ask Erplain's own current product index across every V3 BC, including those
// whose local snapshot/mapping has an old SKU. Only the returned documents and
// local disagreements need a stock/document read. No commercial comparison.
export async function readReceiptRelatedBcs(api,orders,receipts){
 const received=receiptLines(receipts),ids=[...new Set(orders.map(o=>String(o.erp_live?.bc?.id||'')).filter(Boolean))],bcs=new Map();
 const fields='id label status update_stock line_items{type quantity reserved_quantity available on_hand location{id} variant{id sku track_inventory}} shipping_orders(first:100){data{id label status update_stock} paginatorInfo{hasMorePages}}';
 try{
  for(let start=0;start<ids.length;start+=2000){
   const batch=ids.slice(start,start+2000),where={AND:[{column:'ID',operator:'IN',value:batch},{OR:[{column:'VARIANT_ID',operator:'EXISTS',value:[...new Set(received.map(l=>l.variantId))]},{column:'VARIANT_SKU',operator:'IN',value:[...new Set(received.map(l=>l.sku))]}]}]};
   for(let page=1;page<=100;page++){
    const result=await api.request(`query V3ReceiptRelatedStock($where:QueryOrdersWhereWhereConditions,$page:Int!){Orders(first:100,page:$page,orderBy:[{column:ID,order:ASC}],where:$where){data{${fields}} paginatorInfo{hasMorePages}}}`,{where,page});
    const connection=pageData(result.Orders);
    for(let bc of connection.data){const id=String(bc?.id);if(!batch.includes(id)||bcs.has(id))throw Error('Identité ou pagination BC non confirmée');if(bc.shipping_orders?.paginatorInfo?.hasMorePages)bc=await readErplainDocuments(api,id);bcs.set(id,bc);}
    if(!connection.paginatorInfo.hasMorePages)break;
    if(!connection.data.length||page===100)throw Error('Recherche des BC reçus incomplète');
   }
  }
 }catch(e){
  if(e.httpStatus===429||e.httpStatus>=500||/timeout|network|fetch failed|ETIMEDOUT|ECONN/i.test(e.message))return {bcs,errors:new Map(orders.filter(o=>o.erp_live?.bc?.id).map(o=>[o.id,'Recherche ERPLAIN incomplète : '+e.message])),mode:'provider-filter-incomplete'};
  // Older/provider schemas can refuse a product filter. Exhaustive fallback,
  // rather than pretending the local index proves provider completeness.
  return {...await readRecoveryBcs(api,orders),mode:'exhaustive-fallback'};
 }
 const local=receiptCandidates(receipts,orders,{includeUnknown:false}).filter(o=>o.erp_live?.bc?.id&&!bcs.has(String(o.erp_live.bc.id)));
 const extra=await readRecoveryBcs(api,local);for(const [id,bc] of extra.bcs)bcs.set(id,bc);
 return {bcs,errors:extra.errors,mode:'provider-product-filter'};
}

export async function refreshReceiptBcs(api,orders,bcs,errors,onProgress=async()=>{}){
 const ids=[...new Set(orders.map(o=>String(o.erp_live?.bc?.id||'')).filter(Boolean))];
 const fields='id label status update_stock shipping_orders(first:10){data{id label status update_stock} paginatorInfo{hasMorePages}}';
 const mark=(id,e)=>{for(const o of orders.filter(o=>String(o.erp_live?.bc?.id)===id)){if(e)errors.set(o.id,'Lecture du document indisponible : '+e.message);else errors.delete(o.id);}};
 for(let start=0;start<ids.length;start+=8){
  const batch=ids.slice(start,start+8),variables=Object.fromEntries(batch.map((id,i)=>['id'+i,id]));
  try{
   const result=await api.request(`query V3ReceiptDocumentBatch(${batch.map((_,i)=>'$id'+i+':ID!').join(',')}){${batch.map((_,i)=>'r'+i+':Order(id:$id'+i+'){'+fields+'}').join(' ')}}`,variables);
   for(let i=0;i<batch.length;i++){let bc=result['r'+i];if(String(bc?.id)!==batch[i])throw Error('Document individuel non confirmé');if(bc.shipping_orders?.paginatorInfo?.hasMorePages||!Array.isArray(bcs.get(batch[i])?.line_items))bc=await readErplainDocuments(api,batch[i]);else bc={...bcs.get(batch[i]),...bc};bcs.set(batch[i],bc);mark(batch[i],null);}
  }catch(e){
   if(e.httpStatus===429||e.httpStatus>=500){for(const id of ids.slice(start))mark(id,e);return;}
   // A provider may impose a lower alias complexity cap. Keep individual reads
   // as the compatibility path, never accept stale collection delivery states.
   for(const id of batch){try{bcs.set(id,await readErplainDocuments(api,id));mark(id,null);}catch(error){mark(id,error);if(error.httpStatus===429||error.httpStatus>=500){for(const rest of ids.slice(start))mark(rest,error);return;}}}
  }
  await onProgress({phase:'documents',done:Math.min(start+8,ids.length),total:ids.length,message:'BL vérifiés : '+Math.min(start+8,ids.length)+' / '+ids.length});
 }
}
