import {receiptLines} from './receipt-recovery-plan.mjs';

// This is admission to a fresh ERP read, never permission to write or ship.
// Unknown snapshots stay in the candidate pool so incomplete indexing cannot
// silently hide an order. Match source, mapped and recorded ERP identifiers.
export function receiptCandidates(receipts,orders,{includeUnknown=true}={}){
 const received=receiptLines(receipts),skus=new Set(received.map(l=>l.sku)),variants=new Set(received.map(l=>String(l.variantId)));
 return orders.filter(o=>{
  if((o.skus||[]).some(s=>skus.has(s)))return true;
  const lines=o.erp_live?.bc?.line_items;
  if(!Array.isArray(lines)||!lines.some(l=>l.variant?.id&&l.variant?.sku))return includeUnknown;
  return lines.some(l=>l.variant&&(skus.has(l.variant.sku)||variants.has(String(l.variant.id))));
 });
}

export function receiptWork(row,order){
 const shipped=['shipped','in_transit','delivered','delivered_simulated','cancelled'];
 const bl=row.currentBl||(row.bls?.length===1?row.bls[0]:null);
 if(order?.archived||shipped.includes(order?.tracking_status)||shipped.includes(bl?.status)||bl?.status==='completed')return 'history';
 if(row.labels?.length)return 'available';
 if(row.item?.state==='complete')return 'available';
 if(row.status==='eligible'||row.canLabel)return 'action';
 return 'blocked';
}
