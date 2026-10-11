export const recoveryCadence={local:300000,external:900000,hourly:3600000,daily:86400000,alert:3600000};

// This schedules observations, never a provider mutation or a new label.
export async function initializeRecoverySweeps(db){
 await db.exec(`CREATE TABLE IF NOT EXISTS order_recheck_sweeps(
 name text PRIMARY KEY,next_at timestamptz NOT NULL DEFAULT now(),
 checked_at timestamptz,result jsonb NOT NULL DEFAULT '{}');
 INSERT INTO order_recheck_sweeps(name) VALUES('hourly-unresolved'),('daily-consistency') ON CONFLICT DO NOTHING;`);
}
export const unresolvedPreparationSql=`NOT o.archived AND (
 o.resolution_pending_resume OR o.issue IS NOT NULL OR o.partial_mode
 OR o.label_status IN ('blocked','review','failed','waiting_catalog')
 OR o.erp_status IN ('blocked','review','live_review')
 OR EXISTS(SELECT 1 FROM erp_live_jobs e WHERE e.order_id=o.id AND e.status='review')
 OR EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting','review'))
 OR EXISTS(SELECT 1 FROM correction_jobs c WHERE c.order_id=o.id AND c.status IN ('queued','applying','checking','waiting','review'))
 OR coalesce(m.state->>'blocked','false')='true')`;

export async function requestRecoverySweeps(db){
 return db.transaction(async tx=>{
  const due=(await tx.query(`SELECT name FROM order_recheck_sweeps WHERE next_at<=now()
   ORDER BY next_at,name FOR UPDATE SKIP LOCKED`)).rows;
  const result=[];
  for(const sweep of due){
   const daily=sweep.name==='daily-consistency';
   await tx.query('INSERT INTO order_recheck_monitor(order_id) SELECT id FROM orders WHERE NOT archived ON CONFLICT DO NOTHING');
   const changed=(await tx.query(`UPDATE order_recheck_monitor m SET
    next_check=now(),next_external=least(m.next_external,now()),requested=requested+1,
    state=m.state||jsonb_build_object('auditRequested',true,'auditScope',$1::text)
    FROM orders o WHERE m.order_id=o.id AND ${daily?'NOT o.archived':unresolvedPreparationSql}
    RETURNING m.order_id`,[sweep.name])).rows;
   const proof={requested:changed.length,scope:sweep.name,providerMutations:0};
   await tx.query(`UPDATE order_recheck_sweeps SET checked_at=now(),result=$2::jsonb,
    next_at=CASE WHEN name='daily-consistency' THEN
     ((date_trunc('day',now() AT TIME ZONE 'Europe/Paris')+interval '1 day') AT TIME ZONE 'Europe/Paris')
     ELSE now()+interval '1 hour' END WHERE name=$1`,[sweep.name,JSON.stringify(proof)]);
   result.push(proof);
  }
  return result;
 });
}

export function currentHoldDiagnostic(o,{erpJob=o.erp_live_job,carrierJob=o.carrier_job,temuJob=o.temu_job,now=Date.now()}={}){
 const state=o.erp_live||{},p=o.source_payload||{};
 if(p.marketplacePendingCorrection)return {code:'source_change',label:'Commande source modifiée : rapprochement des données en attente',nextStep:'Comparer la version source aux documents existants avant toute reprise',decisionRequired:true};
 if(p.temuReadDeferred?.deferred===true&&(!temuJob?.error||temuJob.error==='Quota partagé : lecture différée'))return {code:'temu_read_deferred',label:'Lecture TEMU en attente',nextStep:'Reprise automatique selon la disponibilité du quota ; étiquettes et résultats existants conservés',decisionRequired:false};
 if(temuJob?.status==='pending'&&temuJob.error==='TEMU · PDF en attente chez TEMU'){
  const observed=Date.parse(temuJob.result?.observedAt),age=now-observed;
  const parcels=Array.isArray(temuJob.result?.packageInfoResultList)?temuJob.result.packageInfoResultList:[],packages=Array.isArray(temuJob.packages)?temuJob.packages:[];
  const verified=temuJob.result?.source==='temu_direct'&&packages.length>0&&packages.every(pkg=>parcels.some(p=>p.packageSn===pkg&&[0,1,'0','1'].includes(p.shippingLabelStatus)))&&parcels.every(p=>packages.includes(p.packageSn)&&[0,1,'0','1'].includes(p.shippingLabelStatus));
  if(verified&&Number.isFinite(age)&&age>=0&&age<=2*recoveryCadence.local)return {code:'temu_pdf_processing',label:'PDF TEMU : récupération automatique en cours',nextStep:'Relire le résultat et récupérer le PDF existant ; aucun nouvel achat',decisionRequired:false,observedAt:temuJob.result.observedAt};
  return {code:'temu_pdf_recheck',label:'PDF TEMU : disponibilité à revérifier',nextStep:'Actualiser le résultat TEMU et récupérer le document existant, sans nouvel achat',decisionRequired:false};
 }
 if(temuJob?.error)return {code:'temu_error',label:temuJob.status==='shipment_error'?'Étiquette refusée par TEMU : '+temuJob.error:temuJob.error,nextStep:'Recontrôler le résultat TEMU ; conserver toute création existante ou incertaine',decisionRequired:false};
 if(['pending','processing'].includes(erpJob?.status))return {code:o.resolution_pending_resume&&state.bc?.id?'erp_admission_hold':'erp_processing',label:o.resolution_pending_resume&&state.bc?.id?'BC existant : admission à la préparation Erplain suspendue':'Préparation Erplain en attente ou en cours',nextStep:o.resolution_pending_resume&&state.bc?.id?'Vérifier l’origine du verrou et les prérequis avant admission au worker':'Suivre le traitement Erplain jusqu’à son résultat',decisionRequired:false};
 if(['pending','creating','awaiting_pdf'].includes(carrierJob?.status))return {code:'carrier_processing',label:'Traitement transport existant en cours',nextStep:'Suivre ou récupérer le document existant, sans nouvelle création',decisionRequired:false};
 if(!state.bc?.id)return {code:'bc_unverified',label:'Préparation initiale : BC et prérequis non validés',nextStep:'Relire les prérequis et vérifier l’autorisation de préparation',decisionRequired:false};
 if(!state.bl?.id)return {code:'bl_missing',label:'BC existant : BL restant à préparer après validation',nextStep:'Rapprocher produits, quantités, prix et stock puis poursuivre la préparation autorisée',decisionRequired:false};
 if(o.channel==='temu'&&temuJob?.status==='ready')return {code:'temu_confirmation',label:'Achat d’étiquette TEMU à confirmer'+(o.temu_auto_purchase?.result?.status==='held'?' : '+o.temu_auto_purchase.result.message.replace(/^Achat d’étiquette TEMU à confirmer\s*:\s*/, ''):''),nextStep:'Achat automatique TEMU après vérification de préparation et marge nette positive sur le devis sans Cainiao ; sinon confirmation nécessaire',decisionRequired:true};
 if(o.channel==='temu'&&temuJob?.status!=='complete')return {code:'temu_result',label:'BL présent : résultat du parcours TEMU à compléter',nextStep:'Relire le traitement TEMU et conserver les éventuelles créations existantes',decisionRequired:false};
 if(o.channel!=='temu'&&carrierJob?.status!=='ready')return {code:'label_missing',label:'BL présent : étape étiquette distincte de la préparation',nextStep:'Contrôler l’autorisation et le parcours d’étiquette applicable',decisionRequired:true};
 if(!state.mappingPreparationFingerprint||!state.labelPreparationFingerprint)return {code:'legacy_proof',label:'Documents existants : preuve de cohérence de préparation à reconstruire',nextStep:'Comparer les données actuelles au BC, BL et stock, puis rapprocher le verrou sans recréer les documents',decisionRequired:false};
 return {code:'final_reconciliation',label:'Documents existants : rapprochement final de préparation en attente',nextStep:'Vérifier les preuves actuelles puis rapprocher les statuts et le verrou',decisionRequired:false};
}

export function externalCoverage({attemptedAt,checkedAt,now=Date.now()}={}){
 const time=Date.parse(checkedAt),attempt=Date.parse(attemptedAt);
 return {lastComplete:checkedAt||null,overdue:!Number.isFinite(time)?Number.isFinite(attempt)&&now-attempt>=2*recoveryCadence.external:now-time>=2*recoveryCadence.external};
}
