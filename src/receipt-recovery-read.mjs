import {validateReceiptNumber,receiptLines} from './receipt-recovery-plan.mjs';
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
