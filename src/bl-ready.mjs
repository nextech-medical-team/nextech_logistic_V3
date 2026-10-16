import {readHistoricalStock} from './historical-stock-proof.mjs';
import {copyStockLotsToBl} from './stock-lots.mjs';
import {assertHistoricalBlNumber} from './bl-numbering.mjs';
import {assertErplainReadyTransition} from './erplain-ready-transition.mjs';
export function deliveryTotals(lines){const sums=new Map();for(const l of lines||[]){if(l.type&&l.type!=='normal')continue;const q=Number(l.quantity),v=l.variant?.id,p=l.location?.id;if(!v||!p||!Number.isFinite(q)||q<=0)throw Error('BL : produits, lieux ou quantités incomplets');const k=String(v)+':'+String(p);sums.set(k,(sums.get(k)||0)+q);}if(!sums.size)throw Error('BL sans produit');return JSON.stringify([...sums].sort());}
// This operation only finalizes an existing delivery. It never creates stock or labels.
export async function confirmDeliveryReady(api,{bcId,blId,lines,stockDocument,stockLabel,stockNotes,stockOnBc=false,pendingBlScope=false,allowPendingSiblings=false,nativeErplainCycle=false}){
 if(nativeErplainCycle&&process.env.ERPLAIN_NATIVE_READY_FAST!=='0'){
  if(!stockOnBc||pendingBlScope||allowPendingSiblings||stockDocument)throw Error('Cycle BL natif incompatible avec une sortie distincte ou partielle');
  const read=async()=>{const {ShippingOrder:bl}=await api.request('query V3DeliveryReady($bl:ID!){ShippingOrder(id:$bl){id label status}}',{bl:String(blId)});if(String(bl?.id)!==String(blId))throw Error('BL à finaliser : identité non confirmée');assertHistoricalBlNumber(bl);return bl;};
  const before=await read();assertErplainReadyTransition(before.status,'ready_to_ship');
  if(['ready_to_ship','shipped','delivered','completed'].includes(before.status))return {...before,readyConfirmedAt:new Date().toISOString()};
  if(!['pending','make_the_shipment'].includes(before.status))throw Error('BL à finaliser : statut incompatible');
  const {UpdateShippingOrder:updated}=await api.request('mutation V3FinalizeDelivery($id:ID!,$input:ShippingOrderInput!){UpdateShippingOrder(id:$id,input:$input){id label status}}',{id:String(blId),input:{label:before.label,status:'ready_to_ship'}});
  const after=updated?.label&&updated?.status?updated:await read();
  if(String(after?.id)!==String(blId)||after.label!==before.label||!['ready_to_ship','shipped','delivered','completed'].includes(after.status))throw Error('BL à finaliser : transition non confirmée');
  return {...before,...after,readyConfirmedAt:new Date().toISOString()};
 }
 const stockFields='id label status update_stock line_items{type quantity variant{id} location{id} batch_numbers{quantity batch_number{id}}}';
 // StockRemoval returns StockAdjustment, which has no created_at field.
 // The historical BL proof still needs ShippingOrder.created_at.
 const fields='created_at '+stockFields;
 const read=async()=>{const r=await api.request(`query V3DeliveryReady($bc:ID!,$bl:ID!){Order(id:$bc){id created_at status update_stock line_items{id type quantity location{id} variant{id track_inventory}} shipping_orders(first:100){data{id status update_stock line_items{parent_id type quantity location{id} variant{id}}} paginatorInfo{hasMorePages}}} ShippingOrder(id:$bl){${fields}}}`,{bc:String(bcId),bl:String(blId)});const bc=r.Order,bl=r.ShippingOrder;if(String(bc?.id)!==String(bcId)||bc.status!=='active'||String(bl?.id)!==String(blId)||(bl.update_stock!==false&&!(stockOnBc&&bl.update_stock===true))||bc.shipping_orders?.paginatorInfo?.hasMorePages||!bc.shipping_orders?.data?.some(x=>String(x.id)===String(blId)))throw Error('Stock traité, statut BL à finaliser : relation BC/BL non confirmée');assertHistoricalBlNumber(bl);if(!['pending','make_the_shipment','in_preparation','ready_to_ship','shipped','delivered','completed'].includes(bl.status)||(!nativeErplainCycle&&deliveryTotals(bl.line_items)!==deliveryTotals(lines)))throw Error('Stock traité, statut BL à finaliser : statut ou quantités différents');return {bc,bl};};
 if(nativeErplainCycle&&(!stockOnBc||pendingBlScope||allowPendingSiblings||stockDocument))throw Error('Cycle BL natif incompatible avec une sortie distincte ou partielle');
 const before=await read();
 assertErplainReadyTransition(before.bl.status,'ready_to_ship');
 if(stockOnBc){if(before.bc.update_stock!==true)throw Error('Stock du BC non confirmé');if(!nativeErplainCycle&&before.bl.update_stock===true)await readHistoricalStock(api,before.bc,{bl:before.bl,pendingBlScope,allowPendingSiblings});}
 else {if(before.bc.update_stock!==false||!stockDocument?.id||!stockLabel||!stockNotes)throw Error('Stock traité, statut BL à finaliser : preuve de stock requise');const d=(await api.request(`query V3ReadyStockProof($id:ID!){StockRemoval(id:$id){${stockFields} notes}}`,{id:String(stockDocument.id)})).StockRemoval;if(String(d?.id)!==String(stockDocument.id)||d.label!==stockLabel||d.notes!==stockNotes||d.status!=='completed'||d.update_stock!==true||deliveryTotals(d.line_items)!==deliveryTotals(lines))throw Error('Stock traité, statut BL à finaliser : mouvement de stock incompatible');await copyStockLotsToBl(api,blId,d.line_items);}
 if(['pending','make_the_shipment','in_preparation'].includes(before.bl.status))await api.request('mutation V3FinalizeDelivery($id:ID!,$input:ShippingOrderInput!){UpdateShippingOrder(id:$id,input:$input){id}}',{id:String(blId),input:{label:before.bl.label,status:'ready_to_ship'}});
 const after=await read();if(!['ready_to_ship','shipped','delivered','completed'].includes(after.bl.status)||after.bl.label!==before.bl.label||after.bc.update_stock!==before.bc.update_stock||after.bl.update_stock!==before.bl.update_stock)throw Error('Stock traité, statut BL à finaliser : transition non confirmée');if(stockOnBc&&!nativeErplainCycle&&after.bl.update_stock===true)await readHistoricalStock(api,after.bc,{bl:after.bl,pendingBlScope,allowPendingSiblings});return {...after.bl,readyConfirmedAt:new Date().toISOString()};
}

