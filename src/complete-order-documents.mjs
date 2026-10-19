// Display policy only: existing business jobs, histories and documents are untouched.
import {partialAllocationSql} from './partial-allocation.mjs';
export function hasCompletePartialDocuments(order,deliveries=order.partial_document_status){
 const allocation=order.partial_allocation;
 if(!order.partial_mode||!order.erp_live?.bc?.id||!Array.isArray(allocation)||!allocation.length||allocation.some(l=>!['number','string'].includes(typeof l.remaining)||String(l.remaining).trim()===''||Number(l.remaining)!==0))return false;
 const current=Array.isArray(deliveries)?deliveries.filter(d=>d.status!=='cancelled'&&d.bl?.status!=='cancelled'):[];
 return current.length>0&&current.every(d=>d.status==='ready'&&d.environment==='production'&&String(d.bl?.id??'').trim()!==''&&Number(d.documents)>0);
}
export function hasCompleteOrderDocuments(order){
 if(order.complete_order_documents===true)return true;
 if(order.partial_mode)return hasCompletePartialDocuments(order);
 const identified=document=>document&&String(document.id??'').trim()!=='';
 return identified(order.erp_live?.bc)&&
  (identified(order.erp_live?.bl)||(Array.isArray(order.erplain_tracking_bls)&&order.erplain_tracking_bls.some(identified)))&&
  (Number(order.document_count)>0||(Array.isArray(order.temu_documents)&&order.temu_documents.length>0));
}
export const completePartialDocumentsSql=`(
 coalesce(orders.partial_mode,false) AND nullif(btrim(erp_live->'bc'->>'id'),'') IS NOT NULL
 AND (SELECT jsonb_array_length(allocation)>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(allocation) a WHERE a->>'remaining' IS NULL OR (a->>'remaining')::numeric<>0) FROM (SELECT ${partialAllocationSql} allocation) complete_allocation)
 AND EXISTS(SELECT 1 FROM partial_deliveries d WHERE d.order_id=orders.id AND d.status<>'cancelled' AND coalesce(d.bl->>'status','')<>'cancelled')
 AND NOT EXISTS(SELECT 1 FROM partial_deliveries d WHERE d.order_id=orders.id AND d.status<>'cancelled' AND coalesce(d.bl->>'status','')<>'cancelled' AND (d.status<>'ready' OR d.environment IS DISTINCT FROM 'production' OR nullif(btrim(d.bl->>'id'),'') IS NULL OR NOT EXISTS(SELECT 1 FROM partial_documents p WHERE p.delivery_id=d.id)))
)`;
export const completeOrderDocumentsSql=`(${completePartialDocumentsSql} OR (NOT coalesce(orders.partial_mode,false) AND (
 nullif(btrim(erp_live->'bc'->>'id'),'') IS NOT NULL AND (
 nullif(btrim(erp_live->'bl'->>'id'),'') IS NOT NULL OR
 EXISTS(SELECT 1 FROM partial_deliveries complete_bl WHERE complete_bl.order_id=orders.id AND nullif(btrim(complete_bl.bl->>'id'),'') IS NOT NULL) OR
 EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(erp_live->'documentSource'->'shippingOrders')='array' THEN erp_live->'documentSource'->'shippingOrders' ELSE '[]'::jsonb END) complete_bl WHERE nullif(btrim(complete_bl->>'id'),'') IS NOT NULL)
 ) AND (
 EXISTS(SELECT 1 FROM carrier_documents complete_label JOIN carrier_jobs complete_carrier ON complete_carrier.order_id=complete_label.order_id WHERE complete_label.order_id=orders.id AND complete_carrier.status='ready') OR
 EXISTS(SELECT 1 FROM temu_label_documents complete_label JOIN temu_label_jobs complete_job ON complete_job.reference=complete_label.reference WHERE orders.channel='temu' AND complete_label.reference=orders.reference AND complete_job.result->>'source'='temu_direct' AND complete_job.packages ? complete_label.package)
 ))))`;
