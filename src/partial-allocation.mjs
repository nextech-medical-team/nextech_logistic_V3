// Pending preparations reserve quantities too: do not offer them a second time.

export const partialAllocationSql=`(SELECT coalesce(jsonb_agg(jsonb_build_object('sku',need.sku,'ordered',need.quantity,'allocated',coalesce(used.quantity,0),'remaining',greatest(0,need.quantity-coalesce(used.quantity,0)))), '[]'::jsonb)

 FROM (SELECT sku,sum(quantity) quantity FROM (

 SELECT value->>'sku' sku,(value->>'quantity')::numeric quantity FROM jsonb_array_elements(coalesce(orders.erp_live->'partialSource'->'lines','[]'::jsonb)) WHERE orders.erp_live ? 'partialSource'

 UNION ALL

 SELECT coalesce(l.target_sku,m.target_sku,l.source_sku) sku,coalesce(l.target_quantity,l.quantity*m.target_qty/nullif(m.source_qty,0),l.quantity) quantity FROM lines l LEFT JOIN mappings m ON m.channel=orders.channel AND m.source_sku=l.source_sku WHERE l.order_id=orders.id AND NOT (orders.erp_live ? 'partialSource')

 ) source_need GROUP BY sku) need

 LEFT JOIN (SELECT sku,sum(quantity) quantity FROM (

 SELECT value->>'sku' sku,(value->>'quantity')::numeric quantity FROM jsonb_array_elements(coalesce(orders.erp_live->'partialSource'->'allocations','[]'::jsonb)) WHERE orders.erp_live ? 'partialSource'

 UNION ALL

 SELECT x.value->>'sku' sku,(x.value->>'quantity')::numeric quantity FROM partial_deliveries d CROSS JOIN LATERAL jsonb_array_elements(d.selection) x(value) WHERE d.order_id=orders.id AND d.status<>'cancelled' AND coalesce(d.bl->>'status','')<>'cancelled' AND (NOT (orders.erp_live ? 'partialSource') OR d.bl->>'id' IS NULL OR (orders.erp_live->'partialSource' ? 'allocatedBlIds' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(orders.erp_live->'partialSource'->'allocatedBlIds','[]'::jsonb)) recorded(value) WHERE recorded.value=d.bl->>'id')))

 ) allocation_used GROUP BY sku) used ON used.sku=need.sku)`;

export const partiallyAllocatedSql=`(coalesce(partial_mode,false) AND EXISTS(SELECT 1 FROM jsonb_array_elements(${partialAllocationSql}) allocation WHERE (allocation->>'remaining')::numeric>0))`;

