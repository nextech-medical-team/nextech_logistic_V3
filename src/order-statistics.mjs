import {orderQuery} from './order-query.mjs';
export async function orderStatistics(db,params,orderIds=null){const {where,args}=orderQuery(params,orderIds);const result=(await db.query(`WITH scoped AS MATERIALIZED (SELECT * FROM orders ${where}), docs AS (
SELECT o.id,CASE WHEN o.carrier LIKE 'gls%' THEN 'gls' ELSE coalesce(o.carrier,'other') END family FROM scoped o JOIN carrier_jobs j ON j.order_id=o.id AND j.status='ready' JOIN carrier_documents d ON d.order_id=o.id WHERE NOT o.partial_mode
UNION ALL SELECT o.id,CASE WHEN p.carrier LIKE 'gls%' THEN 'gls' ELSE coalesce(p.carrier,'other') END FROM scoped o JOIN partial_deliveries p ON p.order_id=o.id AND p.status='ready' JOIN partial_documents d ON d.delivery_id=p.id
UNION ALL SELECT o.id,CASE WHEN p.carrier LIKE 'gls%' THEN 'gls' ELSE coalesce(p.carrier,'other') END FROM scoped o JOIN extra_parcels p ON p.order_id=o.id AND p.status='ready' AND p.pdf IS NOT NULL
UNION ALL SELECT o.id,'temu' FROM scoped o JOIN temu_label_documents d ON d.reference=o.reference WHERE o.channel='temu' AND d.pdf IS NOT NULL
), unique_orders AS(SELECT id,CASE WHEN count(DISTINCT family)>1 THEN 'mixed' ELSE min(family) END family FROM docs GROUP BY id),
families AS(SELECT family,count(*)::int orders FROM unique_orders GROUP BY family)
SELECT count(*)::int total,count(*) FILTER(WHERE label_status IN ('blocked','waiting_catalog') OR EXISTS(SELECT 1 FROM carrier_jobs j WHERE j.order_id=orders.id AND j.status IN ('failed','review')) OR EXISTS(SELECT 1 FROM erp_live_jobs j WHERE j.order_id=orders.id AND j.status IN ('failed','review')))::int blocked,count(*) FILTER(WHERE tracking_status='delivered')::int delivered,
coalesce((SELECT json_agg(f ORDER BY family) FROM families f),'[]'::json) AS transport_stats FROM scoped orders`,args)).rows[0];
const {transport_stats:rows,...summary}=result;return{transportStats:rows,summary:{...summary,labels:rows.reduce((n,r)=>n+r.orders,0)}};}
