import {hasCreatedBl} from './created-bl-label.mjs';
import {assertPreparedLabelOrder} from './equivalent-auto-label.mjs';
import {completedExcelPreparation} from './temu-excel-purchase-admission.mjs';
import {usesRecordedBc} from './existing-bc-execution.mjs';
import {retiredCommercialControl} from './post-bc-control-recovery.mjs';

// The manual quote and the final purchase claim use the same eligibility check.
// Automatic purchases retain their additional admission and margin checks.
export async function assertExcelLabelPreparation(db,o){
 const fail=reason=>{throw Error('Excel TEMU : préparation à terminer avant achat — '+reason);};
 if(o.simulation)fail('commande de simulation');
 if(o.erp_live?.bc?.status==='cancelled'||o.erp_live?.bl?.status==='cancelled')fail('document Erplain annulé');
 if(o.archived||o.label_status==='cancelled'||['cancelled','shipped','in_transit','delivered'].includes(o.tracking_status))fail('commande archivée, annulée ou déjà expédiée');
 if(hasCreatedBl(o)&&o.erp_live?.bc?.id){
  assertPreparedLabelOrder(o);
  if(o.source_payload?.visibilityHold||o.source_payload?.erplainValidationHold)fail('validation de la commande suspendue');
  if(o.transport_choice)fail('transporteur déjà choisi : utiliser le parcours correspondant');
  const busy=(await db.query(`SELECT id FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting')
   UNION ALL SELECT id FROM correction_jobs WHERE order_id=$1 AND status IN ('queued','applying','checking','waiting','review')`,[o.id])).rows;
  if(busy.length)fail('correction ou reprise en cours');
  // Historic import completion flags do not invalidate an already published BL.
  // Preserve unrelated reviews; only the original import's ERP review is obsolete.
  const reviews=(await db.query("SELECT id,action,error FROM resolution_jobs WHERE order_id=$1 AND (status='review' OR error IS NOT NULL)",[o.id])).rows;
  const original=o.source_payload?.temuExcelPreparation?.jobId;
  if(reviews.some(j=>j.id!==original||j.action!=='resume'||!/^BC · Quantités réservées non confirmées/.test(j.error||'')))fail('intervention à vérifier : '+(reviews[0]?.error||'consulter les corrections'));
  return;
 }
 if(o.issue&&!(usesRecordedBc(o)&&retiredCommercialControl(o.issue)))fail(o.issue);
 if(!o.source_payload?.temuExcelPreparation)fail('demande de préparation Excel absente');
 if(o.resolution_pending_resume&&!await completedExcelPreparation(db,o))fail('historique de préparation non terminé');
}
