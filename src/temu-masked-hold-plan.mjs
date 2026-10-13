import {usesRecordedBc} from './existing-bc-execution.mjs';
import {createHash} from 'node:crypto';
import {normalizeTemuReceipt} from './marketplace-inbox.mjs';
import {marketplaceChanged,sourceFingerprint} from './marketplace-comparison.mjs';
import {maskedTemuAddressFields,usableFrozenAddress} from './temu-address-observation.mjs';
import {platformLifecycleReadinessProblem} from './platform-shipment-hold-db.mjs';
export const canonicalValue=x=>x instanceof Date?x.toISOString():Array.isArray(x)?x.map(canonicalValue):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonicalValue(x[k])])):x;
export const evidenceHash=x=>createHash('sha256').update(JSON.stringify(canonicalValue(x))).digest('hex');
export const genericModificationReason=x=>/^Commande modifiée (?:dans (?:temu|shopify) · Vérifier la préparation|sur la plateforme(?: : vérifier les nouvelles données avant reprise| · articles, quantités ou adresse à rapprocher)?)$/i.test(String(x||''));
const moneyData=x=>{if(!x?.parentOrderMap?.parentOrderSn||!Array.isArray(x.orderList)||!x.orderList.length||!x.parentOrderMap.estimatedRevenue?.currency||!['number','string'].includes(typeof x.parentOrderMap.estimatedRevenue.amount)||Number(x.parentOrderMap.estimatedRevenue.amount)<0||x.parentOrderMap.estimatedRevenue.amount==null||x.parentOrderMap.estimatedRevenue.amount===''||!Number.isFinite(Number(x.parentOrderMap.estimatedRevenue.amount)))return null;const y={...x};delete y.warning;return evidenceHash(y);};
export function planMaskedTemuHold(e,{now=Date.now()}={}){
 const o=e.order,s=e.sourceRead;const stop=(code,reason)=>({eligible:false,code,reason});
 if(o?.channel!=='temu'||o.archived||o.partial_mode||o.label_status==='cancelled'||o.suspension?.active||o.suspension?.erplainCancellation)return stop('excluded','Commande annulée, archivée, partielle ou suspendue conservée');
 const pending=o.source_payload?.marketplacePendingCorrection;if(!pending||!genericModificationReason(o.issue)||!maskedTemuAddressFields(pending.shipping).length)return stop('not_mask_hold','Blocage différent du masquage TEMU');
 const at=Date.parse(s?.checkedAt);if(s?.origin!=='provider'||s.readOnly!==true||s.complete!==true||s.channel!=='temu'||s.orderId!==o.id||!Number.isFinite(at)||at>now||now-at>300000)return stop('source_unverified','Lecture TEMU complète et fraîche requise');
 if(String(s.shop)!==String(o.source_payload.sourceShop||o.source_payload.mallId)||s.payload?.detail?.parentOrderMap?.parentOrderSn!==o.reference||s.payload?.country!==o.address?.country||!s.first||!s.last||evidenceHash(s.first)!==evidenceHash(s.last)||evidenceHash(s.payload.detail)!==evidenceHash({...s.first,v3Amounts:s.payload.detail.v3Amounts}))return stop('source_identity','Identité ou détail source non stable');
 if(!usableFrozenAddress(o.address)||!maskedTemuAddressFields(s.payload.shipping).length)return stop('frozen_address','Adresse initiale complète et masquage actuel requis');
 let incoming,old;try{incoming=normalizeTemuReceipt(s.payload,s.shop);old=normalizeTemuReceipt(pending,s.shop);}catch(error){return stop('source_incomplete',error.message);}
 if(marketplaceChanged(o,e.priorLines,incoming)||marketplaceChanged(o,e.priorLines,old)||!sourceFingerprint(e.priorLines))return stop('real_change','Articles, quantités ou champs d’adresse divulgués réellement différents');
 const acceptedMoney=moneyData(o.source_payload?.temuAmounts?.data),currentMoney=moneyData(s.payload.detail.v3Amounts?.data);
 if(!usesRecordedBc(o)&&(!acceptedMoney||acceptedMoney!==currentMoney))return stop('commercial_changed','Prix, taxes ou remises source différents ou incomplets');
 const p=o.erp_live;if(p?.bc?.status!=='active'||!p.bc.id||!p.bl?.id||!['ready_to_ship','shipped','delivered','completed'].includes(p.bl.status)||!['bl_ready','bl_created'].includes(p.phase)||(!usesRecordedBc(o)&&(p.pricing?.status!=='verified'||p.pricing.error)))return stop('preparation','Préparation Erplain actuelle non vérifiée');
 if(e.erpJobs?.length!==1||e.erpJobs[0].status!=='complete'||e.erpJobs[0].error)return stop('erp_job','Traitement Erplain non terminé');
 const j=e.temuJob,docs=e.temuDocuments||[],labelReadDeferred=j?.error==='Quota partagé : lecture différée';if(j?.status!=='complete'||j.error&&!labelReadDeferred||!Array.isArray(j.packages)||!j.packages.length||j.packages.some(pkg=>!docs.some(d=>String(d.package)===String(pkg)&&d.bytes>0&&d.pdfValid===true&&/^[a-f0-9]{64}$/.test(d.sha256))))return stop('label_proof','Étiquettes TEMU existantes non complètement prouvées');
 if(e.workflowJobs?.some(j=>['queued','pending','running','processing','waiting'].includes(j.status))||e.activeJobs?.length)return stop('active_job','Traitement actif conservé');
 if((e.otherErrors||[]).some(x=>x&&!genericModificationReason(x)))return stop('independent_problem',(e.otherErrors||[]).find(x=>x&&!genericModificationReason(x)));
 const lifecycle=e.lifecycle||[];if(lifecycle.some(l=>l.locked||l.requested)||!lifecycle.some(l=>String(l.bl_id)===String(o.erp_live.bl.id)))return stop('lifecycle','Contrôle BL actif ou document absent : correction différée');
 const life=platformLifecycleReadinessProblem(o,lifecycle,[],now);const independent=lifecycle.find(l=>l.error)?.error;const issue=[independent?'Facturation Erplain à vérifier · '+independent:life?'Préparation V3 à vérifier · '+life:null,labelReadDeferred?'TEMU · '+j.error:null].filter(Boolean).join(' ; ')||null;
 if(e.runtimeProof?.allBusinessWritersPaused!==true)return stop('writers','Arrêt des écrivains requis');
 const source_payload={...o.source_payload};delete source_payload.marketplacePendingCorrection;
 source_payload.platformChangeReconciliation={kind:'temu_address_masking',deferredReason:issue,deferredBilling:!!independent&&/facture|SIREN|Siret|VAT|TVA/i.test(independent),deferredLabelRead:labelReadDeferred,verified:true,at:s.checkedAt,addressFrozen:true,labelsPreserved:true,commercialHash:currentMoney,sourceEvidenceHash:evidenceHash(s.payload),previousPendingHash:evidenceHash(pending)};
 return {eligible:true,classification:issue?'masked_address_reclassified_independent_problem':'masked_address_false_hold_removed',technicalPatch:{source_payload,issue,resolution_pending_resume:issue?o.resolution_pending_resume:false,label_status:issue?o.label_status:'production_ready'},externalWrites:0,newJobs:0,labelsTouched:0,lifecycleRevisionChanged:true};
}
