import {usesNativeBlCycle,assertNativeBcSnapshot} from './native-bl-policy.mjs';
import {assertFullOrderStock} from './stock-gate.mjs';
import {historicalPreparationProof} from './historical-stock-proof.mjs';
const shortage=e=>/^BL bloqué [—-] stock insuffisant :/.test(e?.message||'');
const numeric=v=>(typeof v==='number'||typeof v==='string'&&v.trim()!=='')&&Number.isFinite(Number(v));
const totals=bc=>JSON.stringify(bc.line_items.filter(l=>l.variant).map(l=>[String(l.variant.id),String(l.location?.id),Number(l.quantity)]).sort());
function debtCovered(bc){
 return bc.line_items.filter(l=>l.variant&&l.variant.track_inventory!==false).every(l=>numeric(l.on_hand)&&numeric(l.available)&&Number(l.on_hand)>=0&&Number(l.available)>=0);
}
// A physical BC debit can precede reception. Never authorize dispatch while
// its stock balance is still negative, or on a reservation-only proof.
// Only in-memory state is changed; the caller persists it under its own guard.
export async function reconcileNativeBcDebit(api,o,snapshot,{prove=historicalPreparationProof}={}){
 if(!usesNativeBlCycle(o))return false;
 assertNativeBcSnapshot(o,snapshot);
 try{assertFullOrderStock(snapshot.line_items);return false;}catch(e){if(!shortage(e))throw e;}
 if(!debtCovered(snapshot))return false;
 const candidate=structuredClone(o);delete candidate.erp_live.bcReservationPolicy;
 candidate.items=o.items||snapshot.line_items;
 const proof=await prove(api,candidate,{beforeBlPublication:true});
 if(!proof?.stockOnBc||String(proof.bcId)!==String(snapshot.id)||proof.stockModel||!proof.logIds?.length)throw Error('Stock du BC : débit physique complet non confirmé');
 const {Order:current}=await api.request('query V3ConfirmBcDebitRecovery($id:ID!){Order(id:$id){id status update_stock line_items{type quantity reserved_quantity available on_hand location{id} variant{id sku track_inventory}} shipping_orders(first:100){data{id status} paginatorInfo{hasMorePages}}}}',{id:String(snapshot.id)});
 assertNativeBcSnapshot(o,current);
 if(totals(current)!==totals(snapshot)||!debtCovered(current))throw Error('Stock du BC modifié pendant le rapprochement : recontrôle requis');
 o.erp_live.stockPolicyRecovery={at:new Date().toISOString(),reason:'verified_physical_bc_debit',previousPolicy:o.erp_live.bcReservationPolicy,proof};
 o.erp_live.historicalStockProof=proof;
 delete o.erp_live.bcReservationPolicy;
 return true;
}
