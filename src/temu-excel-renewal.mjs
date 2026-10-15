import {createHash} from 'node:crypto';
export const localExcelPreparationError=error=>/^(Excel : (prix ou articles modifiés depuis la validation|validation commerciale requise avant préparation)|BC · Taux de TVA source à préciser|Création produit · Nom du produit manquant ou invalide : [^\r\n]+)$/.test(error||'');
// Revalidation is a separate, explicit pre-document action. It never changes a
// recorded BC/BL, buys a label, or replays an uncertain ERP creation.
export function excelRenewalCandidate(o,job,review){
 const s=o.source_payload||{},e=o.erp_live||{};
 return o.channel==='temu'&&s.origin==='temu_excel'&&!!s.temuExcelPreparation&&!o.archived&&!o.partial_mode&&!o.transport_choice&&(!o.issue||localExcelPreparationError(o.issue))&&o.label_status!=='cancelled'&&o.tracking_status==='not_shipped'&&!o.suspension?.active&&!Object.hasOwn(o.suspension||{},'erplainCancellation')&&!s.marketplacePendingCorrection&&!s.manualPlatformCancellation?.cancelled&&!s.manualPreparationRequired&&!s.visibilityHold&&!s.erplainValidationHold&&!e.bc&&!e.bl&&!e.customer&&!e.customerNumber&&!e.phase&&(!job||job.status==='review')&&[job?.error,review?.error].some(localExcelPreparationError);
}
export const excelRenewalFingerprint=(o,lines,commercial)=>createHash('sha256').update(JSON.stringify({reference:o.reference,address:o.address,recipient:o.recipient,suspension:o.suspension,preparation:o.source_payload.temuExcelPreparation,commercial,lines:lines.map(l=>({id:l.id,source_line:l.source_line,source_sku:l.source_sku,quantity:l.quantity,target_sku:l.target_sku,target_quantity:l.target_quantity,source_payload:l.source_payload})),pending:o.source_payload.marketplacePendingCorrection,cancellation:o.source_payload.manualPlatformCancellation})).digest('hex');
export async function assertExcelRenewal(tx,o,lines){
 const job=(await tx.query('SELECT * FROM erp_live_jobs WHERE order_id=$1 FOR UPDATE',[o.id])).rows[0];
 const reviews=(await tx.query("SELECT * FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting','review')",[o.id])).rows;
 if(!excelRenewalCandidate(o,job,reviews.find(r=>localExcelPreparationError(r.error))))throw Error('Revalidation Excel : préparation locale avant BC/BL requise');
 if(reviews.some(r=>r.status!=='review'||!['resume','refresh'].includes(r.action)||!localExcelPreparationError(r.error)))throw Error('Revalidation Excel : autre traitement à rapprocher');
 const busy=(await tx.query(`SELECT 1 FROM correction_jobs WHERE order_id=$1 AND status IN ('queued','applying','checking','waiting','review')
 UNION ALL SELECT 1 FROM temu_label_jobs WHERE reference=$2 AND (attempt_id IS NOT NULL OR jsonb_array_length(packages)>0)
 UNION ALL SELECT 1 FROM temu_label_documents WHERE reference=$2
 UNION ALL SELECT 1 FROM carrier_jobs WHERE order_id=$1
 UNION ALL SELECT 1 FROM carrier_documents WHERE order_id=$1
 UNION ALL SELECT 1 FROM carrier_label_history WHERE order_id=$1
 UNION ALL SELECT 1 FROM partial_deliveries WHERE order_id=$1
 UNION ALL SELECT 1 FROM extra_parcels WHERE order_id=$1`,[o.id,o.reference])).rows;
 if(busy.length)throw Error('Revalidation Excel : correction ou achat existant à rapprocher');
 const table=(await tx.query("SELECT to_regclass('erplain_product_creation_attempts') AS name")).rows[0]?.name;
 if(table&&(await tx.query('SELECT sku FROM erplain_product_creation_attempts WHERE sku=ANY($1::text[])',[lines.map(l=>l.target_sku||l.source_sku)])).rows.length)throw Error('Revalidation Excel : création produit déjà engagée à rapprocher');
 return {job,reviews};
}
