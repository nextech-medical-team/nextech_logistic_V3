import {stockIncidentOnly} from './stock-incident-recheck.mjs';
import {withoutSharedParcelReason,withoutSharedParcelReasonSql} from './shared-parcel-diagnostic.mjs';
import {obsoleteTemuVisibilityError,pureTemuSourceReadError} from './temu-catchup-policy.mjs';
// Current diagnostic projection only. Never changes jobs or business data.
export const oldFinanceErrors=['TEMU · Remises client et TVA à rapprocher','TEMU · Totaux client source incohérents','TEMU · Prix client et TVA source incohérents'];
export const verifiedFinanceSql="(channel='temu' AND erp_live->'bc'->>'id' IS NOT NULL AND jsonb_typeof(erp_live->'pricing'->'confirmed'->'total')='number' AND jsonb_typeof(erp_live->'pricing'->'confirmed'->'sourceTotal')='number' AND erp_live->'pricing'->>'status'='verified' AND erp_live->'pricing'->>'error' IS NULL AND erp_live->'pricing'->'confirmed'->>'authority'='erplain' AND erp_live->'pricing'->'commercialBasis'->>'field'='estimatedRevenue' AND erp_live->'pricing'->'commercialBasis'->'sourceEstimatedRevenue' IS NOT NULL AND erp_live->'pricing'->'commercialBasis'->'sourceEstimatedRevenue'=source_payload->'temuAmounts'->'data'->'parentOrderMap'->'estimatedRevenue')";
export const awaitingPurchaseSql="coalesce((channel='temu' AND transport_choice IS NULL AND NOT coalesce(partial_mode,false) AND NOT coalesce(resolution_pending_resume,false) AND erp_live->>'phase'='bl_ready' AND EXISTS(SELECT 1 FROM erp_live_jobs e WHERE e.order_id=orders.id AND e.status='complete' AND e.error IS NULL) AND EXISTS(SELECT 1 FROM temu_label_jobs j WHERE j.reference=orders.reference AND j.status='ready' AND j.error IS NULL) AND NOT EXISTS(SELECT 1 FROM carrier_jobs c WHERE c.order_id=orders.id) AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=orders.id AND r.status IN ('queued','running','waiting'))),false)";
export function currentReasonSql(raw){raw=withoutSharedParcelReasonSql(raw);return "CASE WHEN "+verifiedFinanceSql+" AND ("+raw+") IN ("+oldFinanceErrors.map(s=>"'"+s+"'").join(',')+") THEN CASE WHEN erp_live->>'phase'='historical_review' AND coalesce(resolution_pending_resume,false) THEN 'Reprise historique à vérifier : BL non créé' ELSE NULL END ELSE ("+raw+") END";}
export function projectCurrentDiagnostics(o){
 const partial=o.source_payload?.temuCatchupPartial;
 if(o.channel==='temu'&&partial?.currentReason&&Number.isFinite(Date.parse(partial.checkedAt))&&partial.coverage?.detail&&partial.coverage?.version&&partial.coverage?.consistency&&(!o.source_payload?.temuDirect?.attemptedAt||Date.parse(o.source_payload.temuDirect.attemptedAt)<=Date.parse(partial.checkedAt))){
  if(pureTemuSourceReadError(o.issue))o.issue=partial.currentReason;
  const job=o.erp_live_job;
  if(job&&Number.isFinite(Date.parse(job.updated_at))&&Date.parse(job.updated_at)<=Date.parse(partial.checkedAt)&&(pureTemuSourceReadError(job.error)||job.error==='TEMU · Import incomplet : coordonnées ou détail indisponibles, reprise après nouvelle lecture TEMU'))job.error=partial.currentReason;
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
 for(const [target,key] of [[o,'issue'],[o.erp_live_job,'error'],[o,'resolution_error']])if(target)target[key]=withoutSharedParcelReason(target[key]);
 const p=o.erp_live?.pricing,s=o.source_payload?.temuAmounts?.data?.parentOrderMap?.estimatedRevenue;
 const proof=o.channel==='temu'&&o.erp_live?.bc?.id&&Number.isFinite(p?.confirmed?.total)&&Number.isFinite(p?.confirmed?.sourceTotal)&&p?.status==='verified'&&!p.error&&p.confirmed?.authority==='erplain'&&p.commercialBasis?.field==='estimatedRevenue'&&s&&p.commercialBasis.sourceEstimatedRevenue&&p.commercialBasis.sourceEstimatedRevenue.amount===s.amount&&p.commercialBasis.sourceEstimatedRevenue.currency===s.currency;
 if(proof){const reason=o.erp_live?.phase==='historical_review'&&o.resolution_pending_resume?'Reprise historique à vérifier : BL non créé':null;for(const [target,key] of [[o,'issue'],[o.erp_live_job,'error'],[o,'resolution_error']])if(target&&oldFinanceErrors.includes(target[key]))target[key]=reason;}
 return o;
}
