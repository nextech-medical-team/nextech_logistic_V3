export const persistedRecheckProblemSql="EXISTS(SELECT 1 FROM order_recheck_monitor monitor WHERE monitor.order_id=orders.id AND monitor.state->>'blocked'='true')";
export const successfulPreparationAfterSql=alias=>`NOT EXISTS(SELECT 1 FROM resolution_jobs done WHERE done.order_id=orders.id AND (done.created_at,done.id)>(${alias}.created_at,${alias}.id) AND done.status='complete' AND done.error IS NULL AND done.action IN ('resume-erp','resume','replace-equivalent') AND NOT coalesce(done.result->>'partialRemainder'='true',false))`;
// Match diagnostics that are shown even when the BC/BL and label are ready.
// An existing document does not resolve a missing product weight or an
// unconfirmed replacement. These predicates are read-only.
export const catalogProblemSql=`EXISTS(
 SELECT 1 FROM lines l
 LEFT JOIN mappings m ON m.channel=orders.channel AND m.source_sku=l.source_sku
 JOIN catalog_results c ON c.sku=coalesce(l.target_sku,m.target_sku,l.source_sku)
 WHERE l.order_id=orders.id AND coalesce(c.message,'')<>''
 AND l.source_payload->>'erplainCorrectedWeightKg' IS NULL
)`;
export const pendingEquivalentProblemSql=`EXISTS(
 SELECT 1 FROM (
  SELECT j.id,j.status,j.payload,j.error,j.created_at FROM resolution_jobs j
  WHERE j.order_id=orders.id AND j.action IN ('equivalent-preview','replace-equivalent')
  ORDER BY j.created_at DESC,j.id DESC LIMIT 1
 ) pending
 WHERE ${successfulPreparationAfterSql('pending')} AND pending.status='review' AND coalesce(pending.payload->>'replacementSku','')<>''
 AND (coalesce(pending.error,'')<>'' OR EXISTS(
  SELECT 1 FROM resolution_jobs corrected WHERE corrected.order_id=orders.id
  AND corrected.created_at>pending.created_at AND corrected.status='complete'
  AND corrected.action IN ('weight','select-product','activate-product','create-product')
  AND corrected.payload->>'sku'=pending.payload->>'replacementSku'
 ))
 AND EXISTS(
  SELECT 1 FROM lines l LEFT JOIN mappings m ON m.channel=orders.channel AND m.source_sku=l.source_sku
  WHERE l.order_id=orders.id AND pending.payload->>'sku' IN (l.source_sku,coalesce(l.target_sku,m.target_sku))
 )
)`;
