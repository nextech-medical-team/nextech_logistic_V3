import {cancellationBlock} from './erp-transient-policy.mjs';
import {assertFullOrderStock} from './stock-gate.mjs';

// ERPLAIN owns reservation and stock deduction for this persisted V3 cycle.
// Do not reinterpret its journals as a prerequisite for creating its BL.
export function usesNativeBlCycle(o){
 return o?.erp_live?.bcReservationPolicy==='erplain_bc_bl' && !o.source_payload?.erplainImported && !o.partial_mode && o.channel!=='tender';
}
export function assertNativeBlOrder(o){
 const reason=cancellationBlock(o);
 if(!usesNativeBlCycle(o)||o.archived||reason||['shipped','delivered','in_transit','delivered_simulated'].includes(o.tracking_status))throw Error(reason||'Cycle BL natif non admissible');
 const s=o.erp_live;
 if(s.stockDocument||s.stockCreationAttemptedAt||s.stockCreationOutcome||s.stockPendingVariants?.length||s.previousCancelledCycle)throw Error('Cycle BL natif : écriture de stock distincte à rapprocher');
}
export function assertNativeBcSnapshot(o,bc,{beforeBlPublication=false}={}){
 assertNativeBlOrder(o);
 const id=String(o.erp_live.bc?.id||''),blId=o.erp_live.bl?.id,connection=bc?.shipping_orders;
 if(String(bc?.id)!==id||bc.status!=='active'||bc.update_stock!==true)throw Error('Cycle BL natif : BC actif non confirmé');
 if(!Array.isArray(connection?.data)||connection.paginatorInfo?.hasMorePages!==false)throw Error('Cycle BL natif : recherche des BL incomplète');
 if(connection.data.some(x=>!x?.id||String(x.id)!==String(blId)))throw Error('Cycle BL natif : autre BL existant, rapprochement requis');
 if(beforeBlPublication&&!blId)assertFullOrderStock(bc.line_items);
 return bc;
}
export async function readNativeBlCycle(api,o,{beforeBlPublication=false}={}){
 assertNativeBlOrder(o);
 const id=String(o.erp_live.bc?.id||''),blId=o.erp_live.bl?.id;
 if(!/^\d+$/.test(id)||blId&&!/^\d+$/.test(String(blId)))throw Error('Cycle BL natif : identifiants absents');
 const r=await api.request(`query V3NativeBlCycle($id:ID!${blId?',$bl:ID!':''}){Order(id:$id){id status update_stock line_items{type quantity reserved_quantity available on_hand location{id} variant{id sku track_inventory}} shipping_orders(first:100){data{id status} paginatorInfo{hasMorePages}}}${blId?' ShippingOrder(id:$bl){id label status update_stock orders(first:100){data{id} paginatorInfo{hasMorePages}}}':''}}`,{id,...(blId?{bl:String(blId)}:{})});
 const bc=r.Order,bl=r.ShippingOrder,connection=bc?.shipping_orders;
 assertNativeBcSnapshot(o,bc,{beforeBlPublication});
 if(blId){
  if(String(bl?.id)!==String(blId))throw Error('Brouillon BL introuvable dans Erplain : reprendre depuis le BC après rapprochement');
  if(bl.update_stock!==true||!['unpublished','pending','make_the_shipment','in_preparation','ready_to_ship'].includes(bl.status))throw Error('Cycle BL natif : statut ou politique du BL incompatible');
  if(bl.orders?.paginatorInfo?.hasMorePages!==false||bl.orders?.data?.length!==1||String(bl.orders.data[0].id)!==id)throw Error('Cycle BL natif : rattachement du BL non confirmé');
 }
 // A real shortage still waits for reception. No quantity/reservation equation
 // and no historical debit comparison; once a BL exists this is not a label gate.
 return {bc,bl,observation:{bcId:id,stockOnBc:true,stockModel:'erplain_native_cycle',historicalDebitCompared:false,...(o.erp_live.historicalStockProof?{previousHistoricalProof:o.erp_live.historicalStockProof.stockModel==='erplain_native_cycle'?o.erp_live.historicalStockProof.previousHistoricalProof:o.erp_live.historicalStockProof}:{}),checkedAt:new Date().toISOString()}};
}
