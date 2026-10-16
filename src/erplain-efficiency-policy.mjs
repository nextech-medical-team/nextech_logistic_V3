import {createHash} from 'node:crypto';

// No timestamps, diagnostics, prices or fiscal comparisons in this identity.
// Physical availability is included so a new receipt can wake a failed BL.
export function automaticContinuationKey(order,comparison={}){
 const erp=order.erp_live||{},bc=erp.bc||{};
 const lines=(bc.line_items||[]).map(l=>[l.id??null,l.type??null,l.variant?.id??null,l.location?.id??null,l.quantity??null,l.reserved_quantity??null,l.available??null,l.on_hand??null]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 const value=[order.id,bc.id,erp.bl?.id??null,erp.phase,bc.status,bc.update_stock,lines,comparison.mappingFingerprint,[order.suspension?.active,order.suspension?.version,order.suspension?.erplainCancellation],order.source_payload?.erplainValidationHold,order.source_payload?.visibilityHold,order.source_payload?.marketplacePendingCorrection,erp.mappingAlignmentAttempt?.status];
 return 'historical-recheck-v2-'+createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// New functionality can be disabled independently, without changing documents
// or clearing durable queues. Explicit 0 is the operational rollback switch.
export const stableRechecksEnabled=()=>process.env.ERPLAIN_STABLE_RECHECKS!=='0';
export const groupedStockEnabled=()=>process.env.ERPLAIN_GROUPED_STOCK_WATCH!=='0';
