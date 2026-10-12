import {createHash} from 'node:crypto';
import {marketplaceSnapshotChangeFields} from './marketplace-comparison.mjs';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))??'undefined').digest('hex');
// Pure planning only: never updates a job, document, label or database.
// Applying this technical patch requires the shared writer/lifecycle integration.
export function planPlatformShipmentHold({order,priorLines,normalizedIncoming,sourceRead,carrierJobs=[],labels=[],workflowJobs=[],erpJobs=[],otherErrors=[],partialAllocationProof,runtimeProof},{now=Date.now(),maxAgeMs=300000}={}){
 const defer=(code,reason)=>({eligible:false,executionAllowed:false,code,reason});
 if(!Number.isFinite(now)||!Number.isFinite(maxAgeMs)||maxAgeMs<=0)return defer('freshness_config','Horloge ou délai de fraîcheur non valide');
 if(!order||!['shopify','amazon'].includes(order.channel))return defer('outside_scope','Le parcours transporteur TEMU et les autres canaux restent indépendants');
 if(order.archived||order.suspension?.active||order.suspension?.erplainCancellation)return defer('business_suspension','Archive ou suspension métier conservée');
 if(!order.resolution_pending_resume||!order.source_payload?.marketplacePendingCorrection)return defer('no_platform_hold','Aucune retenue marketplace historique à rapprocher');
 if(!/^Commande déjà expédiée dans (Shopify|Amazon)(?: · Vérifier les documents)?$/i.test(order.issue||''))return defer('other_reason','Un motif indépendant ou combiné doit rester visible');
 if(['cancelled','closed'].includes(order.erp_live?.bc?.status)||['cancelled','closed'].includes(order.erp_live?.bl?.status)||order.tracking_status==='cancelled'||order.label_status==='cancelled')return defer('document_cancellation','Annulation physique ou documentaire conservée');
 if(![carrierJobs,labels,workflowJobs,erpJobs,otherErrors].every(Array.isArray))return defer('evidence_incomplete','Listes de preuves absentes ou malformées');
 const source=sourceRead?.payload,at=Date.parse(sourceRead?.checkedAt);
 if(sourceRead?.readOnly!==true||sourceRead?.complete!==true||sourceRead.orderId!==order.id||!Number.isFinite(at)||at>now||now-at>maxAgeMs)return defer('source_unverified','Lecture source complète, récente et associée à la commande requise');
 if(sourceRead.origin!=='provider'||sourceRead.channel!==order.channel)return defer('source_provenance','Lecture fournisseur directe requise ; le cache V3 ou une correction stockée ne prouve pas la fraîcheur source');
 if(!source||!normalizedIncoming?.source_payload||!Object.keys(source).every(k=>hash(source[k])===hash(normalizedIncoming.source_payload[k])))return defer('source_normalization','Le modèle doit provenir de cette même réponse source');
 if(normalizedIncoming.reference!==order.reference)return defer('source_reference','Référence source différente');
 if(order.channel==='amazon'&&String(source.AmazonOrderId??source.amazon_order_id??source['amazon-order-id']??'')!==order.reference)return defer('source_identity','Identité Amazon non confirmée');
 if(order.channel==='shopify'){
  const version=Date.parse(source.updated_at),pendingVersion=Date.parse(order.source_payload.marketplacePendingCorrection.updated_at);
  if(!Number.isFinite(version)||version>now||!Number.isFinite(pendingVersion)||version<pendingVersion)return defer('source_version','Version fournisseur absente, future ou antérieure à la correction reçue');
  if(String(source.id)!==String(order.source_payload.id)||normalizedIncoming.reference!==order.reference)return defer('source_identity','Identité source différente');
 }
 if(marketplaceSnapshotChangeFields(order,priorLines,normalizedIncoming).length)return defer('commercial_change','Modification commerciale indépendante : rapprocher les champs et documents');
 if(otherErrors.length)return defer('other_problems','Les autres diagnostics ne sont pas effacés');
 if(order.partial_mode&&(!partialAllocationProof||String(partialAllocationProof.bcId)!==String(order.erp_live?.bc?.id)||!/^[a-f0-9]{64}$/.test(partialAllocationProof.shippingSignature||'')))return defer('partial_unverified','Allocations et BL partiels non rapprochés');
 if(workflowJobs.some(j=>!j||j.status!=='complete')||erpJobs.some(j=>!j||!(j.status==='complete'||order.partial_mode&&partialAllocationProof&&j.status==='partial')||j.error))return defer('jobs_unverified','Jobs historiques non terminés ou en erreur : aucune remise en file');
 if(!carrierJobs.length||carrierJobs.some(j=>!j||j.status!=='ready'||j.error||!['production','test'].includes(j.environment)))return defer('carrier_creation_unverified','Résultat de création existant non confirmé ; ne pas rejouer');
 if(!labels.length||labels.some(l=>!l||l.orderId!==order.id||!Number.isInteger(l.index)||l.index<0||!/^[a-f0-9]{64}$/.test(l.sha256||'')))return defer('labels_unverified','Empreintes des étiquettes existantes absentes ou incomplètes');
 if(new Set(labels.map(l=>l.index)).size!==labels.length)return defer('labels_ambiguous','Indices de documents dupliqués');
 if(carrierJobs.some(j=>!Array.isArray(j.tracking)||!j.tracking.length||j.tracking.some(t=>typeof t!=='string'||!t.trim())))return defer('tracking_incomplete','Identités de chaque colis existant requises');
 const parcelTracking=carrierJobs.flatMap(j=>j.tracking);
 if(new Set(parcelTracking).size!==parcelTracking.length||new Set(carrierJobs.map(j=>j.environment)).size!==1)return defer('carrier_ambiguous','Identités ou environnements de colis ambigus');
 if(labels.length!==parcelTracking.length||parcelTracking.some((t,i)=>!labels.some(l=>l.index===i&&l.tracking===t)))return defer('label_coverage','Empreintes associées à tous les colis existants requises');
 const sourcePayload={...order.source_payload};delete sourcePayload.marketplacePendingCorrection;
 if(order.channel==='shopify'){sourcePayload.fulfillment_status=source.fulfillment_status;sourcePayload.updated_at=source.updated_at;sourcePayload.financial_status=source.financial_status;}
 sourcePayload.platformShipmentHoldReconciliation={checkedAt:sourceRead.checkedAt,previousReason:order.issue,previousPendingHash:hash(order.source_payload.marketplacePendingCorrection),labelHashes:labels.map(l=>({index:l.index,sha256:l.sha256})),businessOperationsStarted:false};
 const environment=carrierJobs[0].environment;
 const technicalPatch={source_payload:sourcePayload,issue:null,resolution_pending_resume:false,label_status:order.partial_mode?'partial':environment==='production'?'production_ready':'sandbox_ready'};
 const paused=runtimeProof?.allBusinessWritersPaused===true&&Number.isFinite(Date.parse(runtimeProof.checkedAt))&&Date.parse(runtimeProof.checkedAt)<=now&&now-Date.parse(runtimeProof.checkedAt)<=maxAgeMs;
 return {eligible:true,executionAllowed:false,classification:'platform_declaration_only',lifecycleRevisionChanged:true,expectedSourceHash:hash(order.source_payload),expectedPreparationHash:hash({address:order.address,erp:order.erp_live,carrier:order.carrier,tracking:order.tracking_status}),technicalPatch,preservedLabelHashes:labels.map(l=>l.sha256),newJobs:[],externalCalls:[],requiresIntegration:['Apply only under a verified pause of all business writers','Preserve lifecycle silence: pin its revision after technical change without requesting processing','Atomic source/preparation/job/label preconditions; rollback on any changed evidence','Do not call worker/resume/prepare or create a historical missing job'],writerPauseProven:paused};
}
