import {erplainBatchError} from './erplain-accounts.mjs';

// Reconcile each alias independently: a failed read must not interrupt other orders.
export function shippingOrderFromRead(result,alias){
 if(result?._v3Errors?.some(e=>!e.path?.length||e.path[0]===alias)){
  const error=erplainBatchError(result,alias,'lecture BL');
  error.erplainReadOnly=true;
  throw error;
 }
 const list=result?.[alias]?.shipping_orders;
 if(!Array.isArray(list?.data)||list.paginatorInfo?.hasMorePages!==false)throw Error('API Erplain · Réponse BL incomplète : aucune nouvelle création');
 if(list.data.length>1)throw Error('BL multiples à contrôler');
 if(list.data.some(bl=>!bl?.id))throw Error('API Erplain · Réponse BL incomplète : identifiant absent');
 return list.data[0]||null;
}

export async function reconcileShippingOrderReads(orders,result,{save,fail}){
 for(let i=0;i<orders.length;i++){
  const order=orders[i];
  try{
   const bl=shippingOrderFromRead(result,'p'+i);
   if(bl){order.erp_live.bl=bl;await save(order);}
  }catch(error){order.failed=true;await fail(order,error);}
 }
}
