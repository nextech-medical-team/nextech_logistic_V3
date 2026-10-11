export function confirmedTemuCancellation(order,detail){return order?.channel==='temu'&&detail?.parentOrderMap?.parentOrderSn===order.reference&&Number(detail.parentOrderMap.parentOrderStatus)===3;}
// Keep reading real package tracking after an indicative cancellation observation.
export async function observeTemuCancellation(db,order,detail){
 if(!confirmedTemuCancellation(order,detail))return false;
 const observation={source:'temu_direct',status:3,reference:order.reference,observedAt:new Date().toISOString(),indicative:true};
 await db.query("UPDATE orders SET source_payload=source_payload||$2::jsonb WHERE id=$1 AND channel='temu' AND reference=$3",[order.id,JSON.stringify({platformCancellationObservation:observation}),order.reference]);
 return false;
}
