import {confirmedTemuCancellation} from './temu-cancellation-observation.mjs';
export function intakeCancellationProof(o, payload) {
 const d=payload?.detail;
 return confirmedTemuCancellation(o,d)&&Array.isArray(d.orderList)&&d.orderList.length>0&&d.orderList.every(l=>Number(l.orderStatus)===3&&Number(l.quantity)===0);
}
// Only untouched, incomplete imports. Existing documents, purchases and active
// corrections remain under their established reconciliation process.
export async function reconcileCancelledTemuIntakes(){return 0;}
