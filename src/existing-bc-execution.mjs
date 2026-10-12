import {marketplaceContentFrozen} from './marketplace-content-freeze.mjs';
import {shippingProductLines} from './erplain-shipping-lines.mjs';
import {createHash} from 'node:crypto';

// Once persisted, the BC is the execution document. Marketplace content and
// global mappings are not evidence against its accepted lines or amounts.
export const usesRecordedBc=order=>marketplaceContentFrozen(order)&&!!order.erp_live?.bc?.id;
export function recordedBcItems(bc){
 const products=shippingProductLines(bc?.line_items||[]);
 if(!products.length)throw Error('BC enregistré · Lignes du document non reçues');
 return products.map(l=>{
  const q=Number(l.quantity);
  if(!l.variant?.id||!l.location?.id||l.quantity===null||typeof l.quantity==='boolean'||String(l.quantity).trim()===''||!Number.isFinite(q)||q<=0)throw Error('BC enregistré · Produit, emplacement ou quantité non reçus');
  return {...l,variant:{...l.variant,id:String(l.variant.id)},location:{...l.location,id:String(l.location.id)},quantity:q};
 });
}
export function recordedBcFingerprint(bc){
 const items=recordedBcItems(bc).map(l=>[String(l.variant.id),String(l.location.id),l.quantity]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 return createHash('sha256').update(JSON.stringify({bcId:String(bc.id),items})).digest('hex');
}
export function recordedBcPricing(order,bc,{allowedStatuses=['active']}={}){
 if(String(bc?.id)!==String(order.erp_live?.bc?.id)||!allowedStatuses.includes(bc.status))throw Error('BC enregistré · Identité ou état du document non confirmé');
 const total=Number(bc.total),currency=bc.currency?.label;
 if(bc.total===null||bc.total===undefined||typeof bc.total==='boolean'||String(bc.total).trim()===''||!Number.isFinite(total)||total<0||!currency)throw Error('BC enregistré · Montant ou devise non reçus');
 if(!Array.isArray(bc.line_items)||!bc.line_items.length||bc.line_items.some(l=>l.tax_amount===null||l.tax_amount===undefined||typeof l.tax_amount==='boolean'||String(l.tax_amount).trim()===''||!Number.isFinite(Number(l.tax_amount))))throw Error('BC enregistré · Montants fiscaux du document non reçus');
 const tax=bc.line_items.reduce((n,l)=>n+Number(l.tax_amount),0);
 if(tax<0||tax>total)throw Error('BC enregistré · Réponse fiscale du document invalide');
 return {total,tax,currency,tax_type:bc.tax_type,items:bc.line_items,authority:'recorded_erplain_bc',commercialBasis:'recorded_bc',confirmed:{total,tax,authority:'recorded_erplain_bc'},status:'verified',error:null};
}
export async function readRecordedBc(api,order){
 const {Order:bc}=await api.request('query V3RecordedBcExecution($id:ID!){Order(id:$id){id label status update_stock external_reference dated_at tax_type total currency{id label} shipping_address{label address_1 postal_code city country} line_items{id type quantity price tax_amount tax_codes{id} variant{id sku} location{id}}}}',{id:String(order.erp_live.bc.id)});
 const pricing=recordedBcPricing(order,bc),items=recordedBcItems(bc);
 return {bc,pricing,items};
}
export async function verifyRecordedOrSourceTotals(api,order,actual,source){
 if(usesRecordedBc(order))return recordedBcPricing(order,actual).confirmed;
 const {verifySourceCommercialTotals}=await import('./bc-pricing.mjs');
 return verifySourceCommercialTotals(actual,source());
}
export async function withRecordedOrSourceGuard(api,order,source,fn){
 if(usesRecordedBc(order)){
  const {Order:bc}=await api.request('query V3RecordedBcBeforeExecution($id:ID!){Order(id:$id){id status total currency{label} line_items{tax_amount}}}',{id:String(order.erp_live.bc.id)});
  recordedBcPricing(order,bc);return fn();
 }
 const {withSourceCommercialGuard}=await import('./bc-pricing.mjs');
 return withSourceCommercialGuard(api,order.erp_live.bc.id,source(),fn);
}

const retiredBcSourceReasons=new Set([
 'Commande V3 et BC différents : comparer les produits et quantités avant de générer l’étiquette',
 'Commande V3 et BC différents : vérifier les produits et quantités avant reprise',
 'Commande V3 et BC différents : vérifier les quantités avant dérogation',
 'BC · Produits ou quantités des lignes Erplain différents de la source',
 'Produits ou quantités V3 et BC différents : vérifier les unités, conditionnements et documents avant toute reprise'
]);
export function retiredRecordedBcSourceReview(job){
 const marker=job?.result?.bcComparisonRefresh,p=marker?.proof;
 return job?.status==='review'&&job.error===null&&marker?.currentError===null&&retiredBcSourceReasons.has(marker.previousError)
  &&p?.authority==='recorded_bc'&&p.readOnly===true&&p.preparationNotStarted===true&&/^[1-9]\d*$/.test(String(p.bcId))
  &&p.comparison?.scope==='full'&&p.comparison.different===false&&Array.isArray(p.errors)&&p.errors.length===0&&!p.identityUnconfirmed
  &&/^[a-f0-9]{64}$/.test(p.mappingFingerprint||'')&&Number.isFinite(Date.parse(p.checkedAt));
}
