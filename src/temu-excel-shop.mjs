import {verifyExcelTemuDetail} from './temu-excel-identity.mjs';

// A country narrows the search; only the API order and its lines prove the shop.
export async function resolveExcelTemuShop(o,lines,candidates){
 const matches=[],errors=[];
 for(const {mallId,api} of candidates){
  let detail;
  try{detail=await api.read('bg.order.detail.v2.get',{parentOrderSn:o.reference});}
  catch(e){if(e.code==='TEMU_STOPPING')throw e;errors.push(e);continue;}
  if(detail?.parentOrderMap?.parentOrderSn!==o.reference)continue;
  verifyExcelTemuDetail(o,lines,detail);
  matches.push({mallId,api,detail});
 }
 if(matches.length>1)throw Error('Plusieurs boutiques TEMU correspondent à cette commande : raccordement automatique ambigu');
 // A failed lookup does not prove that another shop cannot own the order.
 if(errors.length)throw errors[0];
 if(!matches.length)throw Error('Commande introuvable dans les boutiques TEMU autorisées pour ce pays');
 return matches[0];
}
