export const defaultShopifyServices=[{service:'Relais GLS',mode:'relay'},{service:'GLS BusinessParcel',mode:'direct'}];
export function shopifyDeliveryMode(order,services=defaultShopifyServices){
 const lines=order.shipping_lines||[];const labels=lines.flatMap(l=>[l.title,l.code]).map(x=>String(x||'').trim().toLowerCase());
 const matches=services.filter(r=>labels.includes(String(r.service).trim().toLowerCase()));
 const modes=[...new Set(matches.map(r=>r.mode))];if(modes.length===1)return modes[0];
 return 'unknown';
}
export function configuredShopifyMode(source,config){return Array.isArray(source?.shipping_lines)?shopifyDeliveryMode(source,config.shopifyServices??defaultShopifyServices):source?.shopifyDeliveryMode||'unknown';}
