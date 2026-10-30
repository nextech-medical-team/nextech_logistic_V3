import {readCancelledImportScope} from './cancelled-import-scope.mjs';
// Lot vérifié du 08/10/2026 et annulations explicites d’import sans documents ERP.
const scope=readCancelledImportScope();
const ids=scope?.orderIds||[];
export const cancelledImportSql = `(coalesce(orders.source_payload->'importCorrection'->>'cancelled','false')='true' AND orders.source_payload->'importCorrection'->>'scope'='import_only_not_marketplace' AND orders.channel IN ('tender','samples','amazon') AND orders.tracking_status='cancelled' AND orders.archived=true AND orders.erp_live->'bc'->>'id' IS NULL AND orders.erp_live->'bl'->>'id' IS NULL) OR coalesce((${ids.length?`orders.id IN (${ids.map(id=>`'${id}'`).join(',')})`:'false'}
 AND orders.channel='amazon' AND orders.archived=true AND orders.resolution_pending_resume=true
 AND orders.tracking_status='cancelled' AND orders.received_at='${scope?.receivedAt||'1970-01-01T00:00:00.000Z'}'::timestamptz
 AND orders.source_payload->'importCancellation'->>'receiptId'='${scope?.receiptId||'PRIVATE_SCOPE_NOT_CONFIGURED'}'
 AND orders.source_payload->'importCancellation'->>'status'='cancelled'
 AND orders.source_payload->'importCancellation'->>'scope'='import_only_not_marketplace'
 AND coalesce(orders.erp_live->'bc'->>'status','cancelled')='cancelled'
 AND coalesce(orders.erp_live->'bl'->>'status','cancelled')='cancelled'
 AND coalesce(orders.erp_live->'stockDocument'->>'status','cancelled')='cancelled'),false)`;
export async function releaseCancelledImportReferences(tx,channel,references){
 // Seulement lors d'une validation d'import. Conserver ID, référence source, lignes, documents et statuts.
 await tx.query(`UPDATE orders SET reference=coalesce(source_reference,reference)||' / import annulé '||id
 WHERE channel=$1 AND reference=ANY($2::text[]) AND (${cancelledImportSql})`,[channel,references]);
}
