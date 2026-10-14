import {createHash} from 'node:crypto';
import {suspensionBlock} from './order-suspension.mjs';
import {assertPublishedBcReservation} from './bc-numbering.mjs';

export const receiptHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const numeric=v=>(typeof v==='number'||typeof v==='string'&&v.trim()!=='')&&Number.isFinite(Number(v));
export function validateReceiptNumber(value){
 if(typeof value!=='string'||!value.trim()||! /^[A-Za-z0-9_-]{1,60}$/.test(value.trim()))throw Error('Saisir un numéro de réception ERPLAIN ou un numéro d’achat');
 return value.trim();
}
export function receiptLines(receipts){
 const groups=new Map();
 for(const r of receipts){
  if(!r?.id||!['delivered','completed'].includes(r.status)||r.update_stock!==true||!Array.isArray(r.line_items))throw Error('Réception non terminée ou entrée de stock non confirmée');
  for(const l of r.line_items){
   if(!l.variant){if(l.type==='normal')throw Error('Produit reçu non vérifiable');continue;}
   if(!l.variant.id||!l.variant.sku||!l.location?.id||!numeric(l.quantity)||Number(l.quantity)<=0)throw Error('Ligne de réception non exploitable');
   const key=String(l.variant.id)+':'+String(l.location.id),g=groups.get(key)||{key,variantId:String(l.variant.id),sku:l.variant.sku,locationId:String(l.location.id),location:l.location.label||String(l.location.id),quantity:0};
   g.quantity+=Number(l.quantity);groups.set(key,g);
  }
 }
 if(!groups.size)throw Error('Aucun SKU reçu exploitable');
 return [...groups.values()];
}
export function recoveryFingerprint(o,bc){
 return receiptHash([o.id,String(o.erp_live?.bc?.id),String(bc?.id),bc?.status,bc?.update_stock,(bc?.line_items||[]).filter(l=>l.variant).map(l=>[String(l.variant.id),String(l.location?.id),Number(l.quantity)]).sort(),(bc?.shipping_orders?.data||[]).map(b=>[String(b.id),b.status,b.update_stock]).sort(),bc?.shipping_orders?.paginatorInfo?.hasMorePages,o.erp_live?.bl?.id,o.erp_live?.stockDocument?.id,o.erp_live?.phase,o.suspension,o.partial_mode,o.archived,o.tracking_status,o.resolution_pending_resume,o.address,o.carrier,o.weight_kg,o.parcel_count,o.source_payload?.erplainValidationHold,o.source_payload?.visibilityHold]);
}
export function stockNeeds(bc){
 const groups=new Map();
 for(const l of bc?.line_items||[]){
  if(!l.variant){if(l.type==='normal')throw Error('Produit BC non reçu');continue;}
  if(!l.variant.id||!l.location?.id||!numeric(l.quantity)||Number(l.quantity)<=0)throw Error('Ligne BC non exploitable');
  if(l.variant.track_inventory!==false&&![l.available,l.on_hand,l.reserved_quantity].every(numeric))throw Error('Stock non vérifiable : '+l.variant.sku);
  const key=String(l.variant.id)+':'+String(l.location.id),g=groups.get(key)||{key,sku:l.variant.sku,locationId:String(l.location.id),quantity:0,reserved:0,available:Number(l.available),onHand:Number(l.on_hand),tracked:l.variant.track_inventory!==false};
  g.quantity+=Number(l.quantity);g.reserved+=Math.max(0,Number(l.reserved_quantity)||0);g.available=Math.min(g.available,Number(l.available));g.onHand=Math.min(g.onHand,Number(l.on_hand));groups.set(key,g);
 }
 if(!groups.size)throw Error('Aucun produit BC reçu');
 return [...groups.values()];
}
const finished=new Set(['ready_to_ship','shipped','delivered','completed']);
export function receiptOrderBlock(o,bc){
 const suspension=suspensionBlock(o);if(suspension)return suspension;
 if(o.archived||['cancelled','shipped','in_transit','delivered','delivered_simulated'].includes(o.tracking_status)||o.label_status==='cancelled')return 'Commande archivée, annulée ou déjà expédiée';
 if(o.source_payload?.visibilityHold||o.source_payload?.erplainValidationHold&&o.source_payload?.erplainValidation!=='approved')return 'Commande en attente de validation';
 if(!bc||String(bc.id)!==String(o.erp_live?.bc?.id))return 'BC absent ou identité non confirmée';
 if(bc.status!=='active')return 'BC '+bc.status+' : aucune nouvelle préparation';
 if(o.partial_mode||o.hasPartial)return 'Livraison partielle : vérifier le reliquat dans le parcours dédié';
 if(o.busy)return 'Traitement déjà en cours : attendre son résultat';
 if(o.resolution_pending_resume)return 'Préparation suspendue : finalisation dédiée requise';
 if([o.erp_live?.mappingAlignmentAttempt,o.erp_live?.sourceVatAttempt,o.erp_live?.stockCreationOutcome].some(a=>a?.status==='uncertain')||o.erp_live?.documentSource?.stockHolds?.length)return 'Écriture ou mouvement de stock à rapprocher';
 if(o.erp_live?.stockDocument?.id||o.erp_live?.stockCreationAttemptedAt)return 'Débit de stock existant : rapprochement requis';
 if(bc.update_stock!==false){
  if(bc.update_stock!==true||o.erp_live?.bcReservationPolicy!=='erplain_bc_bl')return 'Débit de stock existant : rapprochement requis';
  try{assertPublishedBcReservation(bc,true);}catch{return 'Réservation de la commande non confirmée : rapprochement requis';}
  if(bc.line_items.some(l=>l.variant?.track_inventory!==false&&l.variant&&Number(l.shipped_quantity)!==0))return 'Débit de stock existant : rapprochement requis';
 }
 if(!Array.isArray(bc.shipping_orders?.data)||bc.shipping_orders.paginatorInfo?.hasMorePages!==false)return 'Historique des BL incomplet';
 const bls=bc.shipping_orders.data;
 if(o.erp_live?.bl?.id||bls.length)return 'BL existant : rapprochement requis, aucune recréation';
 if(['creating_bc','creating_customer','creating_stock','creating_bl','publishing_bl','finalizing_bl'].includes(o.erp_live?.phase))return 'Préparation interrompue : rapprocher le résultat';
 return null;
}
export function buildReceiptPlan(receipts,orders,bcs,{errors=new Map()}={}){
 const received=receiptLines(receipts),keys=new Set(received.map(l=>l.key)),skus=new Set(received.map(l=>l.sku)),budget=new Map(),physical=new Map(),rows=[];
 const ordered=[...orders].sort((a,b)=>String(a.processing_priority_at||a.received_at||'').localeCompare(String(b.processing_priority_at||b.received_at||''))||a.id.localeCompare(b.id));
 for(const o of ordered){
  const bc=bcs.get(String(o.erp_live?.bc?.id));let needs=[],invalid=null;try{if(bc)needs=stockNeeds(bc);}catch(e){invalid=e.message;}
  const associated=needs.some(l=>keys.has(l.key)||skus.has(l.sku))||(bc?.line_items||[]).some(l=>l.variant&&(keys.has(String(l.variant.id)+':'+String(l.location?.id))||skus.has(l.variant.sku)))||(!bc&&(o.skus||[]).some(s=>skus.has(s)));
  if(!associated)continue;
  const active=(bc?.shipping_orders?.data||[]).filter(l=>!['cancelled','unpublished'].includes(l.status));
  const done=active.length===1&&finished.has(active[0].status)&&String(active[0].id)===String(o.erp_live?.bl?.id);
  const reason=errors.get(o.id)||invalid||(!needs.some(l=>keys.has(l.key))&&bc?'SKU reçu sur une autre variante ou dans un autre emplacement':null)||receiptOrderBlock(o,bc);
  const row={id:o.id,reference:o.reference,channel:o.channel,bc:bc?.label||o.erp_live?.bc?.label||null,bls:(bc?.shipping_orders?.data||[]).map(l=>({id:l.id,label:l.label,status:l.status})),fingerprint:bc?recoveryFingerprint(o,bc):null,needs,status:done?'documents':reason?'blocked':'eligible',reason:done?'BL déjà disponible : étiquettes existantes à récupérer':reason,labels:o.labels||[],labelError:o.labelError||null};
  row.canLabel=done&&active[0].status==='ready_to_ship'&&bc.status==='active'&&!suspensionBlock(o)&&!o.archived&&!o.partial_mode&&!o.hasPartial&&!o.busy&&!o.source_payload?.visibilityHold&&!o.source_payload?.erplainValidationHold&&!['cancelled','shipped','in_transit','delivered','delivered_simulated'].includes(o.tracking_status)&&o.label_status!=='cancelled'&&!['creating_stock','creating_bl','publishing_bl','finalizing_bl'].includes(o.erp_live?.phase)&&![o.erp_live?.mappingAlignmentAttempt,o.erp_live?.sourceVatAttempt,o.erp_live?.stockCreationOutcome].some(a=>a?.status==='uncertain');
  rows.push(row);
  if(row.status==='eligible')for(const l of needs.filter(l=>l.tracked)){
   budget.set(l.key,Math.min(budget.get(l.key)??Infinity,Math.max(0,l.available),Math.max(0,l.onHand)));
   physical.set(l.key,Math.min(physical.get(l.key)??Infinity,Math.max(0,l.onHand)));
  }
 }
 for(const row of rows.filter(r=>r.status==='eligible')){
  const owned=l=>Math.max(0,l.reserved+Math.min(0,l.available));
  const shortages=row.needs.filter(l=>l.tracked&&(l.quantity>Math.min(physical.get(l.key),owned(l)+(budget.get(l.key)||0))+1e-6));
  if(shortages.length){row.status='blocked';row.reason='Stock insuffisant après répartition : '+shortages.map(l=>l.sku+' ('+l.quantity+' nécessaires, '+Math.min(physical.get(l.key),owned(l)+(budget.get(l.key)||0))+' utilisables)').join(' ; ');continue;}
  for(const l of row.needs.filter(l=>l.tracked)){budget.set(l.key,budget.get(l.key)-Math.max(0,l.quantity-owned(l)));physical.set(l.key,physical.get(l.key)-l.quantity);}
 }
 return {receipts:receipts.map(r=>({id:r.id,label:r.label,status:r.status})),received,rows,counts:{matched:rows.length,eligible:rows.filter(r=>r.status==='eligible').length,blocked:rows.filter(r=>r.status==='blocked').length,documents:rows.filter(r=>r.status==='documents').length},readOnly:true,checkedAt:new Date().toISOString()};
}
