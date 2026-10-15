import {hasCreatedBl} from './created-bl-label.mjs';
// Supplier quantities can be zero after a commercial status change. For an
// existing BL, the original recorded order units still describe this shipment.
// Read data only: never compare stock/mappings/prices or fabricate a default.
export async function recordedBlQuantityData(db,o,detail){
 if(!hasCreatedBl(o)||o.partial_mode||!Array.isArray(detail?.orderList)||!detail.orderList.some(l=>!(Number(l.quantity)>0)))return [];
 const original=o.erp_live?.equivalentOriginalLines;
 const rows=Array.isArray(original)&&original.length?original:(await db.query('SELECT source_line,source_payload,quantity FROM lines WHERE order_id=$1 ORDER BY source_line,id',[o.id])).rows;
 const byId=new Map(),duplicates=new Set();
 for(const l of rows){const id=String(l.source_payload?.temuOrderSn||l.source_line||''),q=Number(l.quantity);if(!id||!Number.isSafeInteger(q)||q<=0)continue;if(byId.has(id))duplicates.add(id);byId.set(id,q);}
 return detail.orderList.filter(l=>!(Number(l.quantity)>0)&&byId.has(String(l.orderSn))&&!duplicates.has(String(l.orderSn))).map(l=>({orderSn:String(l.orderSn),quantity:byId.get(String(l.orderSn)),providerQuantity:l.quantity??null,blId:String(o.erp_live.bl.id),source:'original_recorded_order_units'}));
}
