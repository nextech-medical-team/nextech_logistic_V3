import {verifyExcelTemuDetail} from './temu-excel-identity.mjs';
import {temuShopError,unavailableTemuApplication} from './temu-shop-error.mjs';

// Only the API order and its lines prove the shop, not the delivery country.
export async function resolveExcelTemuShop(o,lines,candidates,connectionFailures=[]){
 if(!candidates.length&&!connectionFailures.length)throw Error('Aucune boutique TEMU autorisée disponible pour rechercher la commande '+o.reference+' (livraison : '+(o.address?.country||'non renseigné')+') : vérifiez les accès des boutiques dans la configuration TEMU.');
 const matches=[],errors=[...connectionFailures];
 for(const {mallId,api} of candidates){
  let detail;
  try{detail=await api.read('bg.order.detail.v2.get',{parentOrderSn:o.reference});}
  catch(e){if(e.code==='TEMU_STOPPING')throw e;
   // A definitive absence in this shop is expected during multi-shop discovery.
   // Require both the specific code and explicit provider message.
   if(String(e.code)==='140020002'&&/\border not found\b/i.test(String(e.message||'')))continue;
   errors.push(temuShopError(e,'boutique '+mallId+' — lecture de la commande '+o.reference));continue;}
  if(detail?.parentOrderMap?.parentOrderSn!==o.reference)continue;
  verifyExcelTemuDetail(o,lines,detail);
  matches.push({mallId,api,detail});
 }
 if(matches.length>1)throw Error('Plusieurs boutiques TEMU correspondent à cette commande : raccordement automatique ambigu');
 // An unavailable application cannot disprove an exact order/line match from
 // another verified shop. Quotas, timeouts and ambiguous matches still hold.
 const blocking=errors.find(e=>!unavailableTemuApplication(e));if(blocking)throw blocking;
 if(!matches.length&&errors.length)throw errors[0];
 if(!matches.length)throw Error('Commande '+o.reference+' introuvable dans les '+candidates.length+' boutique(s) TEMU consultée(s), tous pays confondus (livraison : '+(o.address?.country||'non renseigné')+') : vérifiez la boutique d’origine et ses accès TEMU.');
 return {...matches[0],shopWarnings:errors.map(e=>({code:e.code,message:e.message}))};
}
