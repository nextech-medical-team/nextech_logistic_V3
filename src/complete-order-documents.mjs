// Display policy only: existing business jobs, histories and documents are untouched.
export function hasCompleteOrderDocuments(order){
 const identified=document=>document&&String(document.id??'').trim()!=='';
 return identified(order.erp_live?.bc)&&
  (identified(order.erp_live?.bl)||(Array.isArray(order.erplain_tracking_bls)&&order.erplain_tracking_bls.some(identified)))&&
  (Number(order.document_count)>0||(Array.isArray(order.temu_documents)&&order.temu_documents.length>0));
}
export const completeOrderDocumentsSql=`(
 nullif(btrim(erp_live->'bc'->>'id'),'') IS NOT NULL AND (
 nullif(btrim(erp_live->'bl'->>'id'),'') IS NOT NULL OR
 EXISTS(SELECT 1 FROM partial_deliveries complete_bl WHERE complete_bl.order_id=orders.id AND nullif(btrim(complete_bl.bl->>'id'),'') IS NOT NULL) OR
 EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(erp_live->'documentSource'->'shippingOrders')='array' THEN erp_live->'documentSource'->'shippingOrders' ELSE '[]'::jsonb END) complete_bl WHERE nullif(btrim(complete_bl->>'id'),'') IS NOT NULL)
 ) AND (
 EXISTS(SELECT 1 FROM carrier_documents complete_label JOIN carrier_jobs complete_carrier ON complete_carrier.order_id=complete_label.order_id WHERE complete_label.order_id=orders.id AND complete_carrier.status='ready') OR
 EXISTS(SELECT 1 FROM temu_label_documents complete_label JOIN temu_label_jobs complete_job ON complete_job.reference=complete_label.reference WHERE orders.channel='temu' AND complete_label.reference=orders.reference AND complete_job.result->>'source'='temu_direct' AND complete_job.packages ? complete_label.package)
 ))`;
