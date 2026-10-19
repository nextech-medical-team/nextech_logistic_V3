import {createHash} from 'node:crypto';
import {shippingProductLines} from './erplain-shipping-lines.mjs';

// Human decision: a persisted BC is the execution authority for every channel.
// Commercial fields are observations, never prerequisites for BLs or labels.
export const usesRecordedBc=o=>!!o?.erp_live?.bc?.id;
export function fiscalAttemptHasNoLogisticsChange(order,bc){
 const attempt=order.erp_live?.sourceVatAttempt;
 if(attempt?.status!=='uncertain')return true;
 if(order.channel==='tender')return false;
 // Exceptional old-write reconciliation only: never compare tax, price or
 // totals. The persisted pre-write products, quantities and stock policy must
 // prove that this uncertainty has no logistical effect.
 try{return attempt.before?.id!=null&&String(attempt.before.id)===String(bc?.id)&&typeof attempt.stockPolicy==='boolean'&&bc.update_stock===attempt.stockPolicy&&recordedBcFingerprint(attempt.before)===recordedBcFingerprint(bc);}catch{return false;}
}
export function assertRecordedBc(order,bc,{allowedStatuses=['active','pending','unpublished']}={}){
 if(order.erp_live?.mappingAlignmentAttempt?.status==='uncertain'||!fiscalAttemptHasNoLogisticsChange(order,bc))throw Error('BC enregistré · Modification incertaine : rapprochement fournisseur requis');
 if(!bc||String(bc.id)!==String(order.erp_live?.bc?.id)||!allowedStatuses.includes(bc.status))throw Error('BC enregistré · Identité ou état du document non confirmé');
 return bc;
}
export function recordedBcItems(bc){
 const lines=shippingProductLines(bc?.line_items||[]);
 if(!lines.length)throw Error('BC enregistré · Lignes du document non reçues');
 // These fields are required to execute a stock/document operation, rather
 // than compared with quantities in V3, a marketplace or global mappings.
 return lines.map(l=>{
  if(!l.variant?.id||!l.location?.id||l.quantity==null||typeof l.quantity==='boolean'||String(l.quantity).trim()===''||!Number.isFinite(Number(l.quantity))||Number(l.quantity)<=0)throw Error('BC enregistré · Ligne de préparation non exploitable');
  return {...l,variant:{...l.variant,id:String(l.variant.id)},location:{...l.location,id:String(l.location.id)},quantity:Number(l.quantity)};
 });
}
export function recordedBcFingerprint(bc){
 return createHash('sha256').update(JSON.stringify({bcId:String(bc.id),items:recordedBcItems(bc).map(l=>[l.variant.id,l.location.id,l.quantity]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))})).digest('hex');
}

// This proof describes the complete recorded BC, even when preparation uses
// only the lines of a remaining BL. Keep shipment-scope proofs separate.
export function recordedBcPreparationAuthority(bc){
 return {kind:'recorded_bc',bcId:String(bc.id),fingerprint:recordedBcFingerprint(bc)};
}
export function recordedBcPricing(order,bc,options){
 assertRecordedBc(order,bc,options);
 const number=v=>v!=null&&v!==''&&typeof v!=='boolean'&&Number.isFinite(Number(v))?Number(v):null;
 const total=number(bc.total),taxes=Array.isArray(bc.line_items)?bc.line_items.map(l=>number(l.tax_amount)):[];
 const tax=taxes.length&&taxes.every(v=>v!==null)?taxes.reduce((a,b)=>a+b,0):null;
 return {total,tax,currency:bc.currency?.label??null,tax_type:bc.tax_type??null,items:bc.line_items,authority:'recorded_erplain_bc',commercialBasis:'recorded_bc',confirmed:{total,tax,authority:'recorded_erplain_bc',comparisonPerformed:false},status:'observed',error:null};
}
export async function readRecordedBc(api,order){
 const {Order:bc}=await api.request('query V3RecordedBcExecution($id:ID!){Order(id:$id){id label status update_stock external_reference dated_at tax_type total currency{id label} line_items{id type quantity price tax_amount tax_codes{id} variant{id sku} location{id}}}}',{id:String(order.erp_live.bc.id)});
 return {bc:assertRecordedBc(order,bc),pricing:recordedBcPricing(order,bc),items:recordedBcItems(bc)};
}
export async function verifyRecordedOrSourceTotals(api,order,actual,source){
 if(usesRecordedBc(order))return recordedBcPricing(order,actual).confirmed;
 const {verifySourceCommercialTotals}=await import('./bc-pricing.mjs');return verifySourceCommercialTotals(actual,source());
}
export async function withRecordedOrSourceGuard(api,order,source,fn){
 if(usesRecordedBc(order))return fn();
 const {withSourceCommercialGuard}=await import('./bc-pricing.mjs');return withSourceCommercialGuard(api,order.erp_live.bc.id,source(),fn);
}
const retiredReasons=new Set(['Commande V3 et BC différents : comparer les produits et quantités avant de générer l’étiquette','Commande V3 et BC différents : vérifier les produits et quantités avant reprise','Commande V3 et BC différents : vérifier les quantités avant dérogation','BC · Produits ou quantités des lignes Erplain différents de la source','Produits ou quantités V3 et BC différents : vérifier les unités, conditionnements et documents avant toute reprise']);
export function retiredRecordedBcSourceReview(job){
 const retirement=job?.result?.postBcCommercialControlRetired;
 if(job?.status==='review'&&job.error===null&&['resume','resume-erp','reconcile-bc','compare-bc'].includes(job.action)&&retirement?.policy==='recorded-bc-no-commercial-comparison'&&retirement.providerMutations===0&&/^[1-9]\d*$/.test(retirement.bcId||'')&&Number.isFinite(Date.parse(retirement.checkedAt))&&/^(BC · |Commande V3 et )/.test(retirement.previousError||''))return true;
 const m=job?.result?.bcComparisonRefresh,p=m?.proof;
 return job?.status==='review'&&job.error===null&&m?.currentError===null&&retiredReasons.has(m.previousError)&&p?.authority==='recorded_bc'&&p.readOnly===true&&p.preparationNotStarted===true&&p.comparison?.different===false&&Array.isArray(p.errors)&&p.errors.length===0;
}
