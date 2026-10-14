import {verifyExcelTemuDetail} from './temu-excel-identity.mjs';

// Only the API order and its lines prove the shop, not the delivery country.
export async function resolveExcelTemuShop(o,lines,candidates){
 if(!candidates.length)throw Error('Aucune boutique TEMU autorisée disponible pour rechercher la commande '+o.reference+' (livraison : '+(o.address?.country||'non renseigné')+') : vérifiez les accès des boutiques dans la configuration TEMU.');
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
 if(!matches.length)throw Error('Commande '+o.reference+' introuvable dans les '+candidates.length+' boutique(s) TEMU consultée(s), tous pays confondus (livraison : '+(o.address?.country||'non renseigné')+') : vérifiez la boutique d’origine et ses accès TEMU.');
 return matches[0];
}
