import {historicalPreparationProof} from './historical-stock-proof.mjs';
import {assertFullOrderStock} from './stock-gate.mjs';

// An existing BC debit must be reconciled, never tested as a new purchase of
// available stock. This rule applies to every resume, independently of channel.
export async function assertResumeStock(api,order,bc,lines,{prove=historicalPreparationProof,assertAvailable=assertFullOrderStock}={}){
 if(String(bc?.id)!==String(order.erp_live?.bc?.id)||bc?.status!=='active')throw Error('BC actif demandé non confirmé');
 if(typeof bc.update_stock!=='boolean')throw Error('Politique de stock du BC non reçue');
 if(bc.update_stock){
  const proof=await prove(api,{...order,items:lines});
  if(String(proof?.bcId)!==String(bc.id)||proof.stockOnBc!==true)throw Error('Débit historique non confirmé');
  return {stockOnBc:true,proof};
 }
 assertAvailable(lines);
 return {stockOnBc:false};
}
