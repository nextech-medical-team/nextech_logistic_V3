// Informational ERPLAIN reads only. Never allocate stock or change a purchase.
const number=value=>['number','string'].includes(typeof value)&&String(value).trim()!==''&&Number.isFinite(Number(value))?Number(value):null;
export function receiptDate(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return null;
 const date=new Date(value+'T00:00:00Z');return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value?value:null;
}
export async function readIncomingReceipts(api,{sku,variantId,locationId,incoming}){
 if(!(incoming>0))return {status:incoming===0?'none':'unverified',receipts:[]};
 const receipts=new Map(),seen=new Set();let undated=0,total=0;
 const where={AND:[{column:'VARIANT_ID',operator:'EXISTS',value:variantId},{column:'LOCATION_ID',operator:'EXISTS',value:locationId},{column:'STATUS',operator:'EQ',value:'active'},{column:'UPDATE_INCOMING',operator:'EQ',value:true}]};
 for(let page=1;page<=5;page++){
  const response=await api.request('query V3IncomingReceipts($where:QueryPurchasesWhereWhereConditions!,$page:Int!){Purchases(first:100,page:$page,where:$where){data{id status update_incoming drop_shipping shipping_at line_items{id sku variant{id} location{id} undelivered_quantity shipping_at drop_shipping}} paginatorInfo{hasMorePages}}}',{where,page});
  const purchases=response.Purchases;
  if(!Array.isArray(purchases?.data)||typeof purchases.paginatorInfo?.hasMorePages!=='boolean')throw Error('Réceptions incomplètes');
  for(const purchase of purchases.data){
   if(purchase.status!=='active'||purchase.update_incoming!==true||purchase.drop_shipping!==false)continue;
   if(!Array.isArray(purchase.line_items))throw Error('Lignes de réception non vérifiées');
   for(const line of purchase.line_items){
    if(String(line.variant?.id)!==String(variantId)||line.sku!==sku||String(line.location?.id)!==String(locationId)||line.drop_shipping!==0)continue;
    const amount=number(line.undelivered_quantity);
    if(amount===null||amount<0)throw Error('Quantité de réception non vérifiée');
    if(amount===0)continue;
    if(line.id==null||seen.has(String(line.id)))throw Error('Ligne de réception ambiguë');seen.add(String(line.id));
    // A malformed explicit line date must not silently become the document date.
    const date=receiptDate(line.shipping_at==null||line.shipping_at===''?purchase.shipping_at:line.shipping_at);
    total+=amount;if(date)receipts.set(date,(receipts.get(date)||0)+amount);else undated+=amount;
   }
  }
  if(!purchases.paginatorInfo.hasMorePages){
   if(total>incoming+0.000001)throw Error('Réceptions supérieures au stock à venir : rapprochement requis');
   return {status:Math.abs(total-incoming)<0.000001&&undated===0?'verified':'partial',receipts:[...receipts].sort(([a],[b])=>a.localeCompare(b)).map(([date,quantity])=>({date,quantity})),undatedQuantity:undated,matchedQuantity:total};
  }
 }
 throw Error('Trop de réceptions pour vérifier les dates');
}

