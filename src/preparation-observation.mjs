import {createHash} from 'node:crypto';
import {assertFullOrderStock} from './stock-gate.mjs';

export const preparationCadence=Object.freeze({local:300000,external:900000,alert:3600000});
const numeric=x=>(typeof x==='number'||typeof x==='string'&&x.trim()!=='')&&Number.isFinite(Number(x));
export function preparationFingerprint(order,lines){
 return createHash('sha256').update(JSON.stringify([order.id,order.reference,order.erp_live?.bc?.id||null,order.erp_live?.bl?.id||null,order.erp_live?.stockDocument?.id||null,order.suspension||null,order.partial_mode||false,(lines||[]).map(l=>[l.source,l.sku,l.quantity,l.mappingPresent,l.variantId||null,l.locationId||null]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))])).digest('hex');
}
export function preparationNeedsCheck(order,job={}){
 return !order.archived&&!order.partial_mode&&!order.suspension?.active&&!order.suspension?.erplainCancellation&&!['pending','processing','complete'].includes(job.status)&&(order.erp_status==='live_review'||job.status==='review');
}
function currentProof(proof,now){return Number.isFinite(Date.parse(proof?.readAt))&&now-Date.parse(proof.readAt)>=0&&now-Date.parse(proof.readAt)<=preparationCadence.external;}

// Observation only: never completes jobs, requests a continuation, or writes supplier data.
// The caller must atomically compare this fingerprint/version before persisting it.
export function observePreparation({order,lines,document,products=[],documentSearch,readError,now=Date.now()}){
 const fingerprint=preparationFingerprint(order,lines),observedAt=new Date(now).toISOString();
 const proofDates=[document?.readAt,documentSearch?.readAt,...products.map(p=>p.readAt)].map(Date.parse).filter(t=>Number.isFinite(t)&&now>=t&&now-t<=preparationCadence.external);
 const expiresAt=new Date(Math.min(now,...proofDates)+preparationCadence.external).toISOString();
 const business=[],technical=[];let mappingVerified=false;
 const add=(list,code,message)=>list.push({code,message});
 const result=()=>({schemaVersion:1,fingerprint,observedAt,expiresAt,mappingVerified,processing:{erpStatus:order.erp_status,phase:order.erp_live?.phase||null,completed:false},business,technical,blocked:!!(business.length||technical.length),continuationEligible:false});
 if(order.archived||order.suspension?.active||order.suspension?.erplainCancellation){add(business,'suspended','Préparation suspendue : décision explicite requise');return result();}
 if(order.partial_mode){add(technical,'partial-scope','Préparation partielle : contrôle dédié requis');return result();}
 if(readError){add(technical,'source-read-failed','Contrôle Erplain en échec : '+readError);return result();}
 if(!Array.isArray(lines)||!lines.length){add(technical,'missing-lines','Lignes de préparation non vérifiables');return result();}
 for(const l of lines)if(!l.mappingPresent||!l.sku||!numeric(l.quantity)||Number(l.quantity)<=0)add(business,'mapping','Mapping courant à compléter : '+(l.source||l.sku||'?'));
 if(business.length)return result();
 mappingVerified=true;
 let stockLines=[];
 if(order.erp_live?.bc?.id){
  const bc=document?.bc;
  if(!currentProof(document,now)){add(technical,'stale-document','Lecture BC absente ou périmée');return result();}
  if(!bc||String(bc.id)!==String(order.erp_live.bc.id)||bc.external_reference!==order.reference){add(technical,'document-identity','Identité BC différente de la commande : rapprochement requis');return result();}
  if(bc.status!=='active'||typeof bc.update_stock!=='boolean'){add(business,'document-state','BC non actif ou état de débit à rapprocher');return result();}
  if(!Array.isArray(bc.shipping_orders?.data)||bc.shipping_orders.paginatorInfo?.hasMorePages!==false||!Array.isArray(bc.line_items)){add(technical,'incomplete-documents','Lecture BC/BL incomplète');return result();}
  if(bc.shipping_orders.data.length||order.erp_live?.stockDocument?.id||order.erp_live?.stockCreationAttemptedAt||bc.update_stock){add(technical,'existing-movement','Documents ou débit existants : rapprochement requis avant continuation');return result();}
  const expected=new Map(),actual=new Map();
  for(const l of lines)expected.set(l.sku,(expected.get(l.sku)||0)+Number(l.quantity));
  for(const l of bc.line_items.filter(l=>l.variant)){if(!numeric(l.quantity)||Number(l.quantity)<=0){add(technical,'document-lines','Quantités BC non vérifiables');return result();}actual.set(l.variant.sku,(actual.get(l.variant.sku)||0)+Number(l.quantity));}
  if(expected.size!==actual.size||[...expected].some(([sku,q])=>!actual.has(sku)||Math.abs(actual.get(sku)-q)>1e-6)){add(business,'document-mapping','Produits ou quantités du BC différents du mapping courant');return result();}
  stockLines=bc.line_items;
 }else{
  if(!currentProof(documentSearch,now)||documentSearch.complete!==true){add(technical,'incomplete-search','Recherche des documents Erplain absente, périmée ou incomplète');return result();}
  if(documentSearch.found!==null){add(technical,'document-recovery','Document Erplain retrouvé : rapprochement requis, aucune recréation automatique');return result();}
  for(const l of lines){
   const p=products.find(p=>p.sku===l.sku);
   if(!currentProof(p,now)||p.lookupProof?.responseComplete!==true){add(technical,'stale-product','Lecture produit absente, périmée ou incomplète : '+l.sku);continue;}
   if(p.status!=='active'||!p.variant||p.variant.sku!==l.sku||p.variant.active!==true||p.variant.product?.active!==true){add(business,'catalogue','Produit Erplain absent, inactif ou ambigu : '+l.sku);continue;}
   const v=p.variant;if(v.track_inventory===false){stockLines.push({variant:v,quantity:l.quantity});continue;}
   const levels=v.stock_levels;
   if(!l.locationId||!Array.isArray(levels?.data)||levels.paginatorInfo?.hasMorePages!==false){add(technical,'stock-unverifiable','Stock non vérifiable : '+l.sku);continue;}
   const stock=levels.data.filter(s=>String(s.location?.id)===String(l.locationId));
   if(stock.length!==1||![stock[0].available,stock[0].on_hand].every(numeric)){add(technical,'stock-unverifiable','Stock non vérifiable : '+l.sku);continue;}
   stockLines.push({...stock[0],variant:v,quantity:l.quantity,reserved_quantity:0});
  }
 }
 if(stockLines.length)try{assertFullOrderStock(stockLines);}catch(e){add(e.message.startsWith('BL bloqué — stock insuffisant')?business:technical,e.message.startsWith('BL bloqué — stock insuffisant')?'stock-insufficient':'stock-unverifiable',e.message);}
 const out=result();
 if(!out.blocked){out.processing.continuationRequired=true;out.nextStep='Produits, quantités et stock vérifiés ; autres prérequis de préparation à contrôler';out.blocked=true;}
 return out;
}
export function applicablePreparationObservation(observation,order,lines,now=Date.now()){
 return observation?.schemaVersion===1&&observation.fingerprint===preparationFingerprint(order,lines)&&currentProof({readAt:observation.observedAt},now)&&Date.parse(observation.expiresAt)>now;
}
