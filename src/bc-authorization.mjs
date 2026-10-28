import {usesRecordedBc,recordedBcPricing} from './existing-bc-execution.mjs';
import {cancellationBlock} from './erp-transient-policy.mjs';
export const bcAllowedSql = `coalesce(o.suspension->>'active','false')<>'true' AND NOT (o.suspension ? 'erplainCancellation') AND NOT (o.suspension ? 'suspendedAt' AND o.resolution_pending_resume) AND NOT o.archived AND o.reference NOT LIKE 'DEMO-%' AND (o.erp_live->'bc'->>'id' IS NOT NULL OR NOT coalesce(o.source_payload ? 'marketplacePendingCorrection',false)) AND NOT coalesce(o.issue,'') ~* 'commande annulée'`;
export function assertBcLines(items){if(!items.length)throw Error('BC · Commande sans lignes');for(const l of items)if(!l.variant?.id||!Number.isFinite(Number(l.quantity))||Number(l.quantity)<=0||!Number.isFinite(Number(l.price))||Number(l.price)<0)throw Error('BC · Produit, quantité ou prix invalide : '+(l.description||''));}
export function bcAddresses(a={},billing=a){
 const convert=value=>{
  if(!['name','street','postal','city','country'].every(k=>String(value?.[k]||'').trim()))return null;
  return Object.fromEntries([['label',value.name],['address_1',value.street],['city',value.city],['postal_code',value.postal],['country',value.country]].map(([k,v])=>[k,String(v).trim()]));
 };
 const shipping_address=convert(a),billing_address=convert(billing);
 if(!shipping_address)return {};
 if(!billing_address)throw Error('Adresse de facturation incomplète');
 return {shipping_address,billing_address};
}
export function preparationBlock(o){const cancelled=cancellationBlock(o);if(cancelled)return cancelled;if(o.partial_mode)return 'Livraison partielle : utiliser la préparation dédiée';if(!usesRecordedBc(o)&&o.source_payload?.marketplacePendingCorrection)return 'Commande modifiée sur la plateforme : validation nécessaire avant BL';return null;}
export function uncertainBc(o){return !o.erp_live?.bc?.id&&o.erp_live?.phase!=='creating_customer'&&/^creating/.test(o.erp_live?.phase||'');}
