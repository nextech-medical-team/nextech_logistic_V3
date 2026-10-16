import {projectOpenBlDiagnosticHistory} from './open-bl-diagnostic-history.mjs';
import {projectSubstitutionDiagnostics} from './substitution-diagnostics.mjs';
import {usesRecordedBc,recordedBcPricing} from './existing-bc-execution.mjs';
import {projectDeliveredOrder} from './delivered-order.mjs';
import {projectPostBlLabelHistory} from './post-bl-label-history.mjs';
import {projectManualLabelRequest} from './manual-label-request-view.mjs';
import {hasCompleteOrderDocuments} from './complete-order-documents.mjs';
import {currentPlatformModificationReason,currentPlatformModificationSql,genericPlatformModificationSql,platformChangeVerifiedSql} from './platform-change-diagnostics.mjs';
import {stockIncidentOnly} from './stock-incident-recheck.mjs';
import {withoutSharedParcelReason,withoutSharedParcelReasonSql} from './shared-parcel-diagnostic.mjs';
import {obsoleteTemuVisibilityError,pureTemuSourceReadError} from './temu-catchup-policy.mjs';
// Current diagnostic projection only. Never changes jobs or business data.
export const oldFinanceErrors=['TEMU · Remises client et TVA à rapprocher','TEMU · Totaux client source incohérents','TEMU · Prix client et TVA source incohérents'];
export const verifiedFinanceSql="(channel='temu' AND erp_live->'bc'->>'id' IS NOT NULL AND jsonb_typeof(erp_live->'pricing'->'confirmed'->'total')='number' AND jsonb_typeof(erp_live->'pricing'->'confirmed'->'sourceTotal')='number' AND erp_live->'pricing'->>'status'='verified' AND erp_live->'pricing'->>'error' IS NULL AND erp_live->'pricing'->'confirmed'->>'authority'='erplain' AND erp_live->'pricing'->'commercialBasis'->>'field'='estimatedRevenue' AND erp_live->'pricing'->'commercialBasis'->'sourceEstimatedRevenue' IS NOT NULL AND erp_live->'pricing'->'commercialBasis'->'sourceEstimatedRevenue'=source_payload->'temuAmounts'->'data'->'parentOrderMap'->'estimatedRevenue')";
export const awaitingPurchaseSql="coalesce((channel='temu' AND transport_choice IS NULL AND NOT coalesce(partial_mode,false) AND NOT coalesce(resolution_pending_resume,false) AND erp_live->>'phase'='bl_ready' AND EXISTS(SELECT 1 FROM erp_live_jobs e WHERE e.order_id=orders.id AND e.status='complete' AND e.error IS NULL) AND EXISTS(SELECT 1 FROM temu_label_jobs j WHERE j.reference=orders.reference AND j.status='ready' AND j.error IS NULL) AND NOT EXISTS(SELECT 1 FROM carrier_jobs c WHERE c.order_id=orders.id) AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=orders.id AND r.status IN ('queued','running','waiting'))),false)";
// Retire only this exact historical diagnosis when the current carrier is valid.
// Labels, jobs and all other preparation errors remain untouched.
export function currentCarrierReason(o,reason){
 if(!['gls','gls_pharma','gls_shop','gofo'].includes(o.carrier)||typeof reason!=='string')return reason;
 const parts=reason.split(';');if(!parts.some(part=>part.trim()==='Transporteur non déterminé'))return reason;
 return parts.map(part=>part.trim()).filter(part=>part&&part!=='Transporteur non déterminé').join(' ; ')||null;
}
function currentCarrierReasonSql(raw){
 const parts="regexp_split_to_table(carrier_reason.raw_reason,';') WITH ORDINALITY AS carrier_part(part,position)";
 return `(SELECT CASE WHEN carrier IN ('gls','gls_pharma','gls_shop','gofo') AND EXISTS(SELECT 1 FROM ${parts} WHERE btrim(part)='Transporteur non déterminé') THEN (SELECT string_agg(btrim(part),' ; ' ORDER BY position) FROM ${parts} WHERE nullif(btrim(part),'') IS NOT NULL AND btrim(part)<>'Transporteur non déterminé') ELSE carrier_reason.raw_reason END FROM (SELECT (${raw}) AS raw_reason OFFSET 0) carrier_reason)`;
}
export function currentReasonSql(raw){
 const stripped=currentCarrierReasonSql(withoutSharedParcelReasonSql(raw));raw='current_reason.raw_reason';const old=oldFinanceErrors.map(s=>"'"+s+"'").join(',');
 const recovered="(channel='temu' AND source_payload->'marketplacePendingCorrection' IS NULL AND source_payload->>'visibilityHold'='false' AND source_payload->>'visibilityRecoveredAt' IS NOT NULL)";
 // Project the source reason only once for ordinary rows. The rare case where
 // an old generic job maps to a verified financial error keeps the same result.
 const expression=`CASE WHEN ${verifiedFinanceSql} AND ((${raw}) IN (${old}) OR (issue IN (${old}) AND ${genericPlatformModificationSql(raw)} AND (${platformChangeVerifiedSql} OR ${recovered}))) THEN CASE WHEN erp_live->>'phase'='historical_review' AND coalesce(resolution_pending_resume,false) THEN 'Reprise historique à vérifier : BL non créé' ELSE NULL END ELSE (${currentPlatformModificationSql(raw)}) END`;return `(SELECT ${expression} FROM (SELECT (${stripped}) AS raw_reason OFFSET 0) current_reason)`;
}
// Boolean form for the problem scope: avoids generating descriptive strings and
// their nested subqueries when only the presence of a reason is required.
export function currentReasonEmptySql(raw){
 const stripped=currentCarrierReasonSql(withoutSharedParcelReasonSql(raw));raw='current_reason.raw_reason';const old=oldFinanceErrors.map(s=>"'"+s+"'").join(',');
 const generic=genericPlatformModificationSql(raw),nonGenericIssue=`issue IS NOT NULL AND issue<>'' AND NOT coalesce(${genericPlatformModificationSql('issue')},false)`;
 const recovered="(channel='temu' AND source_payload->'marketplacePendingCorrection' IS NULL AND source_payload->>'visibilityHold'='false' AND source_payload->>'visibilityRecoveredAt' IS NOT NULL)";
 const expression=`coalesce(CASE WHEN ${verifiedFinanceSql} AND ((${raw}) IN (${old}) OR (issue IN (${old}) AND ${generic} AND (${platformChangeVerifiedSql} OR ${recovered}))) THEN NOT coalesce((erp_live->>'phase'='historical_review' AND coalesce(resolution_pending_resume,false)),false) WHEN coalesce(${generic},false) THEN CASE WHEN ${platformChangeVerifiedSql} THEN CASE WHEN ${nonGenericIssue} THEN issue='' ELSE source_payload->'marketplacePendingCorrection' IS NULL END WHEN ${recovered} THEN CASE WHEN ${nonGenericIssue} THEN issue='' ELSE false END ELSE false END ELSE (${raw}) IS NULL OR (${raw})='' END,false)`;return `(SELECT ${expression} FROM (SELECT (${stripped}) AS raw_reason OFFSET 0) current_reason)`;
}
export function paidDeferredBillingDiagnosis(o){
 const d=o.source_payload?.platformChangeReconciliation;
 const matches=typeof o.issue==='string'&&(o.issue===d?.deferredReason||typeof d?.deferredReason==='string'&&o.issue===d.deferredReason.replace(/ ; TEMU · Quota partagé : lecture différée$/,''));
 return d?.kind==='temu_address_masking'&&d.verified===true&&d.deferredBilling===true&&o.invoice_status==='paid'&&matches&&(!d.deferredLabelRead||!!o.temu_job);
}
// A past PDF printing refusal is documentary history once the shipment is
// delivered and registered. Never reopen preparation or fetch a new label for it.
export function projectTemuPdfArchiveWarning(o){
 if(o.channel!=='temu'||o.tracking_status!=='delivered'||o.source_payload?.externalLabel?.active!==true)return;
 const warnings=[];
 for(const [target,key] of [[o,'issue'],[o,'resolution_error'],[o.erp_live_job,'error'],[o.temu_job,'error'],...(o.resolution_actions||[]).map(j=>[j,'error'])]){
  const reason=target?.[key];
  if(typeof reason!=='string'||!/^(?:TEMU\s*[·:]\s*)?(?:Étiquette TEMU déjà achetée\s*:\s*PDF original indisponible|PDF (?:non réimprimable|indisponible))/i.test(reason)||/\b(?:stock|facture|paiement|BC|BL|annulation|préparation)\b/i.test(reason))continue;
  if(reason.split(';').slice(1).some(part=>!/^conserver cette expédition\.?$/i.test(part.trim())))continue;
  warnings.push(reason);target[key]=null;
 }
 if(warnings.length)o.temu_pdf_archive_note=[...new Set(warnings)].join(' ; ');
}
// Persisting workflows explicitly retain their previous diagnostic policy;
// the default read projection always applies the terminal delivery rule.
export function projectCurrentDiagnostics(o,{delivery=true}={}){
 projectOpenBlDiagnosticHistory(o);
 projectTemuPdfArchiveWarning(o);
 if(delivery&&projectDeliveredOrder(o))return o;
 projectSubstitutionDiagnostics(o);
 projectPostBlLabelHistory(o);
 if(delivery)projectManualLabelRequest(o);
 if(hasCompleteOrderDocuments(o)){
  for(const [target,key] of [[o,'issue'],[o,'resolution_error'],[o.erp_live_job,'error'],[o.carrier_job,'error'],[o.temu_job,'error'],[o.pending_equivalent,'error'],...(o.resolution_actions||[]).map(job=>[job,'error']),...(o.sku_lines||[]).map(line=>[line,'catalog_issue'])])if(target)target[key]=null;
  return o;
 }
 if(o.archived||o.label_status==='cancelled'||o.tracking_status==='cancelled'){for(const [target,key] of [[o,'issue'],[o.erp_live_job,'error'],[o.carrier_job,'error'],[o.temu_job,'error'],[o,'resolution_error']])if(target)target[key]=null;return o;}
 const partial=o.source_payload?.temuCatchupPartial;
 if(o.channel==='temu'&&partial?.currentReason&&Number.isFinite(Date.parse(partial.checkedAt))&&partial.coverage?.detail&&partial.coverage?.version&&partial.coverage?.consistency&&(!o.source_payload?.temuDirect?.attemptedAt||Date.parse(o.source_payload.temuDirect.attemptedAt)<=Date.parse(partial.checkedAt))){
  if(pureTemuSourceReadError(o.issue))o.issue=partial.currentReason;
  const job=o.erp_live_job;
  if(job&&Number.isFinite(Date.parse(job.updated_at))&&Date.parse(job.updated_at)<=Date.parse(partial.checkedAt)&&(pureTemuSourceReadError(job.error)||job.error==='TEMU · Import incomplet : coordonnées ou détail indisponibles, reprise après nouvelle lecture TEMU'))job.error=partial.currentReason;
 }
 const deferred=o.source_payload?.platformChangeReconciliation;
 // A successful quota read may have retired only the known quota suffix from
 // the card. Match that exact historical suffix without retiring other errors.

 if(paidDeferredBillingDiagnosis(o)){
  const sourceReason=o.source_payload?.marketplacePendingCorrection?currentPlatformModificationReason(o,'Commande modifiée sur la plateforme : vérifier les nouvelles données avant reprise'):null;
  o.issue=[sourceReason,o.temu_job?.error?'TEMU · '+o.temu_job.error:null].filter(Boolean).join(' ; ')||null;
 }
 const stock=o.erp_live?.stockIncidentRecheck,stamp=Date.parse(stock?.checkedAt),stockFresh=Number.isFinite(stamp)&&stamp<=Date.now()&&Date.now()-stamp<=15*60000;
 if(stock&&((stock.preparationRequired&&o.issue===stock.currentIssue)||(stock.status!=='resolved'&&o.issue===stock.currentError))){for(const [target,key] of [[o.erp_live_job,'error'],[o,'resolution_error']])if(target&&stockIncidentOnly(target[key])&&(target===o.erp_live_job?target[key]===stock.erpError:(stock.status==='resolved'?stock.retiredErrors:stock.observedErrors)?.includes(target[key])))target[key]=stock.status==='resolved'?(stockFresh?null:'Stock : vérification à reprendre — dernier contrôle expiré'):stock.currentError;}

 const fresh=o.source_payload?.temuCatchup;
 if(o.channel==='temu'&&(fresh?.complete===true&&fresh.coreComplete===true||fresh?.requiredComplete===true&&['pending','cancelled'].includes(fresh.sourceStage))&&!fresh.conflicts?.length&&Number.isFinite(Date.parse(fresh.checkedAt))&&(!o.source_payload?.temuDirect?.attemptedAt||Date.parse(o.source_payload.temuDirect.attemptedAt)<=Date.parse(fresh.checkedAt))){
  for(const [target,key] of [[o,'issue'],[o.erp_live_job,'error'],[o,'resolution_error'],...(o.resolution_actions||[]).map(j=>[j,'error'])]){
   const dated=key==='resolution_error'?o.resolution_error_updated_at:target?.updated_at;
   if(target&&obsoleteTemuVisibilityError(target[key])&&(key==='issue'&&!dated||Number.isFinite(Date.parse(dated))&&Date.parse(dated)<=Date.parse(fresh.checkedAt)))target[key]=(fresh.requiredComplete&&!fresh.coreComplete?fresh.currentReason:fresh.stageReason)||null;
  }
 }
 for(const [target,key] of [[o,'issue'],[o.erp_live_job,'error'],[o,'resolution_error']])if(target)target[key]=currentPlatformModificationReason(o,withoutSharedParcelReason(target[key]));
 const p=o.erp_live?.pricing,s=o.source_payload?.temuAmounts?.data?.parentOrderMap?.estimatedRevenue;
 const proof=usesRecordedBc(o)?true:o.channel==='temu'&&o.erp_live?.bc?.id&&Number.isFinite(p?.confirmed?.total)&&Number.isFinite(p?.confirmed?.sourceTotal)&&p?.status==='verified'&&!p.error&&p.confirmed?.authority==='erplain'&&p.commercialBasis?.field==='estimatedRevenue'&&s&&p.commercialBasis.sourceEstimatedRevenue&&p.commercialBasis.sourceEstimatedRevenue.amount===s.amount&&p.commercialBasis.sourceEstimatedRevenue.currency===s.currency;
 if(proof){const reason=o.erp_live?.phase==='historical_review'&&o.resolution_pending_resume?'Reprise historique à vérifier : BL non créé':null;for(const [target,key] of [[o,'issue'],[o.erp_live_job,'error'],[o,'resolution_error']])if(target&&oldFinanceErrors.includes(target[key]))target[key]=reason;}
 for(const [target,key] of [[o,'issue'],[o.erp_live_job,'error'],[o.carrier_job,'error'],[o,'resolution_error']])if(target)target[key]=currentCarrierReason(o,target[key]);
 if(Array.isArray(o.resolution_actions))o.resolution_actions=o.resolution_actions.map(job=>job?{...job,error:currentCarrierReason(o,currentPlatformModificationReason(o,job.error))}:job);
 return o;
}
