import {readShopifyRelay,normalizeRelayAddress,sameRelayAddress,relayComparisonAddress} from './shopify-relay-source.mjs';
import {sourceFingerprint} from './marketplace-comparison.mjs';
import {normalizeShopifyOrders} from './marketplace-local-import.mjs';
const reason=/^Commande modifiée (?:dans shopify · Vérifier la préparation|sur la plateforme(?: : vérifier les nouvelles données avant reprise| · articles, quantités ou adresse à rapprocher)?)$/i;
function money(v){const n=Number(v);if(v===null||v===undefined||v===''||!Number.isFinite(n)||n<0)throw Error('Prix source incomplet');return n;}
function commercial(v){
 if(!v?.currency||typeof v.taxes_included!=='boolean'||!Array.isArray(v.line_items)||!v.line_items.length||!Array.isArray(v.shipping_lines))throw Error('Données commerciales source incomplètes');
 const taxes=x=>{if(!Array.isArray(x))throw Error('Taxes source non reçues');return x.map(t=>[money(t.rate),money(t.price)]).sort();};
 return JSON.stringify({currency:v.currency,total:money(v.total_price),included:v.taxes_included,
  lines:v.line_items.map(l=>{if(!l.id||!l.sku||!Array.isArray(l.discount_allocations))throw Error('Ligne commerciale source incomplète');return [String(l.id),l.sku,money(l.quantity),money(l.price),taxes(l.tax_lines),l.discount_allocations.map(d=>money(d.amount)).sort()];}).sort(),
  shipping:v.shipping_lines.map(l=>[l.title,l.code,money(l.discounted_price??l.price),taxes(l.tax_lines)]).sort()});
}
export function relayCommercialFingerprint(payload){try{return commercial(payload);}catch{return null;}}
// Technical reconciliation only. No customer-address edit, provider mutation,
// job creation or replay of a label is part of this plan.
export function planRelaySourceReconciliation(e,{now=Date.now()}={}){
 const o=e.order,s=e.sourceRead,n=e.normalizedIncoming;
 const stop=(code,message)=>({eligible:false,code,reason:message});
 if(o?.channel!=='shopify'||o.archived||o.label_status==='cancelled'||o.suspension?.active||o.suspension?.erplainCancellation)return stop('excluded','Commande annulée, archivée ou suspendue conservée');
 if(s?.origin!=='provider'||s?.readOnly!==true||s.complete!==true||s.orderId!==o.id||s.channel!=='shopify'||!Number.isFinite(Date.parse(s.checkedAt))||now-Date.parse(s.checkedAt)<0||now-Date.parse(s.checkedAt)>300000)return stop('source_unverified','Lecture Shopify fraîche requise');
 if(String(s.payload?.id)!==String(o.source_payload?.id)||s.payload?.name!==o.reference||n?.reference!==o.reference)return stop('identity','Identité source différente');
 const actualIncoming=normalizeShopifyOrders([s.payload])[0];
 if(!actualIncoming||sourceFingerprint(actualIncoming.lines)!==sourceFingerprint(n.lines)||!sameRelayAddress(actualIncoming.address,n.address))return stop('normalization_mismatch','Normalisation différente de la lecture Shopify fraîche');
 const relay=readShopifyRelay(s.payload);if(!relay)return stop('relay_incomplete','Métadonnées du relais non reçues');
 const acceptedVersion=Date.parse(o.source_payload?.marketplacePendingCorrection?.updated_at||o.source_payload?.updated_at);
 if(!Number.isFinite(acceptedVersion)||Date.parse(s.payload.updated_at)<acceptedVersion)return stop('old_version','Version source antérieure ou historique non daté');
 const lineProof=sourceFingerprint(o.erp_live?.equivalentOriginalLines??e.priorLines);
 if(!lineProof||lineProof!==sourceFingerprint(n.lines))return stop('lines_changed','Produits ou quantités réellement modifiés');
 try{if(commercial(o.source_payload)!==commercial(s.payload))return stop('commercial_changed','Prix, taxes ou livraison réellement modifiés');}catch(error){return stop('commercial_incomplete',error.message);}
 const frozen=relayComparisonAddress(o),accepted=normalizeRelayAddress(o.source_payload.shipping_address||{});
 const storedRelayAddress=sameRelayAddress(o.address,accepted)&&relay.destinationAddress&&sameRelayAddress(accepted,relay.destinationAddress);
 if(!sameRelayAddress(frozen,relay.clientAddress)&&!storedRelayAddress)return stop('client_address_changed','Adresse client modifiée : validation de l’équipe requise');
 relay.frozenOrderAddress=structuredClone(o.address);relay.frozenClientAddress=structuredClone(relay.clientAddress);
 const source_payload={...o.source_payload,shopifyRelay:relay,shopifyDeliveryMode:'relay',relaySourceReconciliation:{at:s.checkedAt,sourceVersion:s.payload.updated_at,customerAddressPreserved:true,labelsPreserved:true}};
 const hasLabel=e.labels?.length>0;
 const labelIds=(e.labels||[]).map(l=>l.parcelShopId);
 if(hasLabel&&labelIds.some(id=>!/^GLS_[A-Z]{2}-[A-Za-z0-9]+$/.test(id||'')))return stop('label_proof_missing','Relais réel du PDF existant non vérifié');
 const nearest=e.nearestProof;
 const validNearest=nearest?.selection==='nearest_gls'&&nearest.environment==='production'&&Number.isFinite(nearest.distance)&&nearest.distance>=0&&Number.isFinite(Date.parse(nearest.resolvedAt))&&now-Date.parse(nearest.resolvedAt)>=0&&now-Date.parse(nearest.resolvedAt)<=300000;
 let independent=null;
 if(hasLabel&&relay.selectedId&&labelIds.some(id=>id!==relay.selectedId))independent='GLS · Relais de l’étiquette différent du relais sélectionné Shopify : intervention transporteur requise';
 if(hasLabel&&!relay.selectedId&&(!validNearest||labelIds.some(id=>id!==nearest.parcelShopId)))independent='GLS · Relais par défaut : proximité et destination de l’étiquette à confirmer';
 const patch={source_payload,issue:o.issue,resolution_pending_resume:o.resolution_pending_resume,label_status:o.label_status};
 const obsolete=reason.test(o.issue||'');
 if(independent){patch.issue=independent;patch.label_status='blocked';return {eligible:true,classification:'relay_label_intervention',technicalPatch:patch,lifecycleRevisionChanged:o.label_status!=='blocked'};}
 if(obsolete){
  const errors=(e.otherErrors||[]).filter(x=>!reason.test(String(x)));
  if(!hasLabel||errors.length){patch.issue=errors.length?'Préparation V3 à vérifier · '+errors.map(String).join(' · ').slice(0,450):'Étiquette relais à créer · préparation source vérifiée';return {eligible:true,classification:'relay_source_verified_preparation_pending',technicalPatch:patch,lifecycleRevisionChanged:false};}
  if(!e.carrierJobs?.length||e.carrierJobs.some(j=>j.status!=='ready'||j.error||j.environment!=='production')||!e.runtimeProof?.allBusinessWritersPaused)return stop('operational_proof','Préservation des traitements existants non prouvée');
  delete source_payload.marketplacePendingCorrection;patch.issue=null;patch.resolution_pending_resume=false;patch.label_status=o.partial_mode?'partial':'production_ready';
  return {eligible:true,classification:'relay_false_hold_removed',technicalPatch:patch,lifecycleRevisionChanged:true};
 }
 return {eligible:true,classification:'relay_metadata_verified',technicalPatch:patch,lifecycleRevisionChanged:false};
}
