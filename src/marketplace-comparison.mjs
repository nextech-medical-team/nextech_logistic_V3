import {unchangedPartialCommercial} from './shopify-status-only-proof.mjs';
// Marketplace receipts describe what was ordered, not the replacement sent.
export function sourceFingerprint(rows) {
 if (!Array.isArray(rows) || !rows.length) return null;
 const seen=new Set(), result=[];
 for (const x of rows) {
  const line=String(x.source_line??''),sku=x.source_sku,quantity=Number(x.quantity);
  if (!line || seen.has(line) || typeof sku!=='string' || !sku.trim() || !Number.isFinite(quantity) || quantity<=0) return null;
  seen.add(line);result.push({line,sku,quantity});
 }
 return JSON.stringify(result.sort((a,b)=>a.line.localeCompare(b.line)));
}
export function marketplaceChanged(existing, prior, incoming) {
 // A partial fulfillment alone does not invalidate an already reconciled partial order.
 // Full shipment, cancellation and every commercial/address change still block.
 if(!incoming.cancelled&&existing.channel==='shopify'&&existing.partial_mode&&incoming.fulfilled&&unchangedPartialCommercial(existing,incoming.source_payload))return false;
 const originals=existing.erp_live?.equivalentOriginalLines;
 const baseline=sourceFingerprint(originals===undefined?prior:originals);
 return !!(incoming.cancelled || incoming.fulfilled || !baseline || baseline!==sourceFingerprint(incoming.lines) ||
  ['name','street','postal','city','country'].some(k=>String(existing.address?.[k]||'')!==String(incoming.address?.[k]||'')));
}
