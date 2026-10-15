export {isDeliveredOrder} from './problem-typology-reader.mjs';
import {isDeliveredOrder} from './problem-typology-reader.mjs';

// Projection only. Never persist this object or change jobs/documents/providers.
export function projectDeliveredOrder(order){
 if(!isDeliveredOrder(order))return false;
 order.order_delivered=true;
 order.label_status='delivered';
 order.issue=null;order.resolution_error=null;order.resolution_pending_resume=false;
 order.resolution_active=null;order.label_manual_request_required=false;
 const nodes=[order.erp_live_job,order.carrier_job,order.temu_job,order.pending_equivalent,order.erplain_refresh,
  ...(order.resolution_actions||[]),...(order.sku_lines||[]),...(order.extra_parcels||[])];
 for(const node of nodes)if(node){if('error' in node)node.error=null;if('catalog_issue' in node)node.catalog_issue=null;if('issues' in node)node.issues=[];}
 return true;
}

// Equivalent to isDeliveredOrder, evaluated before SQL pagination and counts.
// JSON extraction keeps this usable with both orders and scoped orders aliases.
export const deliveredOrderSql=`coalesce((tracking_status='delivered' OR (
 EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(erp_live->'documentSource'->'shippingOrders')='array' THEN erp_live->'documentSource'->'shippingOrders' WHEN erp_live->'bc'->'shipping_orders'->'paginatorInfo'->>'hasMorePages'='false' AND jsonb_typeof(erp_live->'bc'->'shipping_orders'->'data')='array' THEN erp_live->'bc'->'shipping_orders'->'data' ELSE '[]'::jsonb END) delivered_bl WHERE delivered_bl->>'status' IS DISTINCT FROM 'cancelled')
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(erp_live->'documentSource'->'shippingOrders')='array' THEN erp_live->'documentSource'->'shippingOrders' WHEN erp_live->'bc'->'shipping_orders'->'paginatorInfo'->>'hasMorePages'='false' AND jsonb_typeof(erp_live->'bc'->'shipping_orders'->'data')='array' THEN erp_live->'bc'->'shipping_orders'->'data' ELSE '[]'::jsonb END) delivered_bl WHERE delivered_bl->>'status' IS DISTINCT FROM 'cancelled' AND (nullif(delivered_bl->>'id','') IS NULL OR delivered_bl->>'status' IS DISTINCT FROM 'delivered'))
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(erp_live->'bc'->'line_items')='array' THEN erp_live->'bc'->'line_items' ELSE '[]'::jsonb END) delivered_line WHERE delivered_line->'variant' IS NOT NULL AND delivered_line->'variant'<>'null'::jsonb)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(erp_live->'bc'->'line_items')='array' THEN erp_live->'bc'->'line_items' ELSE '[]'::jsonb END) delivered_line WHERE delivered_line->'variant' IS NOT NULL AND delivered_line->'variant'<>'null'::jsonb AND NOT coalesce(CASE WHEN delivered_line->>'quantity' ~ '^[0-9]+([.][0-9]+)?$' AND delivered_line->>'shipped_quantity' ~ '^[0-9]+([.][0-9]+)?$' THEN (delivered_line->>'shipped_quantity')::numeric >= (delivered_line->>'quantity')::numeric ELSE false END,false))
)),false)`;
