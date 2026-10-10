// Human authorization 2026-10-09: cancelled and fully refunded Shopify orders.
// A partial refund, voided authorization or a missing financial status is not a full refund.
export function shopifyCancellationReason(payload){
 if(!payload||typeof payload!=='object')return null;
 if(payload.cancelled_at||payload.cancelledAt)return 'Commande annulée dans Shopify';
 if(String(payload.financial_status||payload.displayFinancialStatus||'').toLowerCase()==='refunded')return 'Commande entièrement remboursée dans Shopify';
 return null;
}
export function proveShopifyCancellation(order,node){
 if(order?.channel!=='shopify'||typeof node?.id!=='string'||node.name!==order.reference||!/^gid:\/\/shopify\/Order\/\d+$/.test(node.id)||typeof node.updatedAt!=='string'||!Number.isFinite(Date.parse(node.updatedAt)))throw Error('Shopify · Identité ou date de commande non confirmée');
 if(node.cancelledAt!==null&&node.cancelledAt!==undefined&&(typeof node.cancelledAt!=='string'||!Number.isFinite(Date.parse(node.cancelledAt))))throw Error('Shopify · Date d’annulation non confirmée');
 const known=order.source_payload?.id;
 if(known&&String(known)!==node.id.split('/').at(-1))throw Error('Shopify · Identifiant source différent');
 const reason=shopifyCancellationReason(node);
 return {sourceId:node.id,reference:node.name,version:node.updatedAt,cancelled_at:node.cancelledAt||null,financial_status:String(node.displayFinancialStatus||'UNKNOWN').toLowerCase(),fulfillment_status:String(node.displayFulfillmentStatus||'UNKNOWN').toLowerCase(),reason,observedAt:new Date().toISOString()};
}
export function assertCancellationBC(order,bc){
 if(!bc||String(bc.id)!==String(order.erp_live?.bc?.id)||![order.reference,'V3:'+order.id].includes(bc.external_reference))throw Error('Erplain · Identité du BC non confirmée');
 if(!Array.isArray(bc.shipping_orders?.data)||bc.shipping_orders.paginatorInfo?.hasMorePages!==false)throw Error('Erplain · Liste des BL incomplète');
 if(new Set(bc.shipping_orders.data.map(b=>String(b.id))).size!==bc.shipping_orders.data.length||bc.shipping_orders.data.some(b=>!/^\d+$/.test(String(b.id))))throw Error('Erplain · Liste des BL incohérente');
 if(!['active','cancelled','closed','completed'].includes(bc.status))throw Error('Erplain · Statut BC non vérifiable');
}
export function assertCancellationBL(bc,bl){
 if(!bl?.id||!Array.isArray(bl.orders?.data)||bl.orders.paginatorInfo?.hasMorePages!==false||bl.orders.data.length!==1||String(bl.orders.data[0].id)!==String(bc.id))throw Error('Erplain · BL partagé ou rattachement incomplet');
 if(!Array.isArray(bl.invoices?.data)||bl.invoices.paginatorInfo?.hasMorePages!==false)throw Error('Erplain · Factures du BL non vérifiables');
 if(bl.status==='cancelled')return;
 if(!['unpublished','pending','make_the_shipment','in_preparation','ready_to_ship'].includes(bl.status)||bl.invoices.data.length||Number(bl.invoices_count)!==0)throw Error('BL expédié, livré, facturé ou statut inconnu : documents et stock conservés, rapprochement physique requis');
}
