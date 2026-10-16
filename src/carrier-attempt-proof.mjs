// Technical creation provenance, independent of the displayed diagnostic.
// A BL is the business prerequisite; only duplicate/uncertain writes need proof.
const localValidation=/^(BC modifié depuis sa préparation : recontrôle requis$|Préparation modifiée depuis|Validation de la préparation|Étiquette bloquée : contrôle du stock)/;
const retiredMapping=/^(Mapping modifié avant création : recontrôle requis|Mapping modifié depuis la validation du BL : recontrôle requis)$/;
export async function installCarrierAttemptProof(db){
 await db.exec(`ALTER TABLE carrier_jobs ADD COLUMN IF NOT EXISTS creation_started_at TIMESTAMPTZ;
 ALTER TABLE carrier_jobs ADD COLUMN IF NOT EXISTS failure_phase TEXT;
 ALTER TABLE carrier_jobs ADD COLUMN IF NOT EXISTS original_error TEXT;`);
}
function noCreationEvidence(job){return !job.result&&!job.reference&&Array.isArray(job.tracking)&&job.tracking.length===0;}
export function provesClearedImportedPreflight(job,audit){
 const d=audit?.detail;
 // This historical read-only refresher cleared the displayed phone error.
 // Its exact audit event/timestamp proves the archive was a local refusal.
 return audit?.action==='erplain.label_preflight_refreshed'
 &&job.status==='failed'&&noCreationEvidence(job)
 &&!job.creation_started_at&&(!job.failure_phase||job.failure_phase==='preflight')
 &&job.error===null&&d?.currentError===null&&d.orderId===job.order_id
 &&/^Erplain LIVE · Informations obligatoires manquantes : /.test(d.previousError||'')
 &&d.labelPurchased===false&&Number.isFinite(Date.parse(job.updated_at))
 &&new Date(job.updated_at).getTime()===new Date(audit.created_at).getTime();
}
export function provesImportedFieldsPreflight(job,audit){
 const d=audit?.detail,p=d?.proof;
 return job.status==='failed'&&noCreationEvidence(job)
 &&d?.orderId===job.order_id&&d.currentError===job.error
 &&/^Erplain LIVE · (Informations obligatoires manquantes :|Numéro de téléphone invalide : corriger avant création de l’étiquette$)/.test(d.previousError||'')
 &&p?.readOnly===true&&p.businessActionAuthorized===false&&d.businessWrites===0&&d.labelPurchased===false
 &&new Date(job.updated_at).getTime()===new Date(audit.created_at).getTime();
}
export function provesLegacyPreflight(job,audit){
 const d=audit?.detail,p=d?.proof;
 // Attempts include local validation failures and are not evidence of a provider call.
 // Match the immutable audit to this exact job version; a later update cannot reuse it.
 return job.status==='failed'&&job.creation_id==null&&noCreationEvidence(job)
 &&d?.orderId===job.order_id&&d.currentError===job.error&&(localValidation.test(d.previousError||'')||retiredMapping.test(d.previousError||''))
 &&p?.readOnly===true&&p.verified===true&&p.businessActionAuthorized===false
 &&d.businessWrites===0&&d.labelPurchased===false
 &&p.previousFailureAt===d.previousUpdatedAt
 &&Number.isFinite(Date.parse(p.previousFailureAt))
 &&Date.parse(p.previousFailureAt)<Date.parse(p.validationAt)
 &&new Date(job.updated_at).getTime()===new Date(audit.created_at).getTime();
}
export async function canRetryFailedCarrier(db,job,{manualRequest=false}={}){
 // GOFO's explicit city-validation refusal is not an uncertain shipment.
 // Require its original persisted provider failure and a fresh manual request.
 if(manualRequest&&job?.status==='failed'&&job.carrier==='gofo'&&job.environment==='production'
 &&job.failure_phase==='provider'&&job.attempts===1&&job.creation_id
 &&Number.isFinite(Date.parse(job.creation_started_at))&&noCreationEvidence(job)
 &&job.original_error==='GOFO 200301000 : City information is incorrect'
 &&job.error===job.original_error)return true;
 if(job?.status!=='failed'||!noCreationEvidence(job)||job.creation_started_at)return false;
 if(job.failure_phase==='preflight')return job.creation_started_at===null;
 if(job.failure_phase)return false;
 // These exact legacy messages were thrown before entering the carrier client.
 // A creation UUID was allocated at queueing, not evidence of a provider POST.
 // Only a fresh human request may retry this first, locally rejected attempt.
 if(manualRequest&&job.attempts===1&&[
  'Mapping modifié avant création : recontrôle requis',
  'Mapping modifié depuis la validation du BL : recontrôle requis',
  'Appels d’offres · Client et destinataire dépassent les trois lignes GLS : vérifier avant création',
  'Appels d’offres · Noms et complément d’adresse trop longs pour les trois lignes GLS',
  'Appels d’offres · Numéro de téléphone absent ou invalide : renseigner un numéro joignable avant création de l’étiquette GLS',
  'BC modifié depuis sa préparation : recontrôle requis'
 ].includes(job.error))return true;
 // Existing unambiguous validation errors and jobs never attempted keep their policy.
 if(job.attempts===0||localValidation.test(job.error||''))return true;
 const {rows}=await db.query(`SELECT action,detail,created_at FROM audit
 WHERE action IN ('carrier.prevalidation_diagnostic_revalidated','carrier.imported_fields_diagnostic_revalidated','erplain.label_preflight_refreshed') AND detail->>'orderId'=$1
 AND date_trunc('milliseconds',created_at)=date_trunc('milliseconds',$2::timestamptz)
 ORDER BY created_at DESC`,[job.order_id,job.updated_at]);
 return rows.some(a=>provesLegacyPreflight(job,a)||provesImportedFieldsPreflight(job,a)||provesClearedImportedPreflight(job,a));
}
export async function hasUncertainCarrierHistory(db,id,{manualRequest=false}={}){
 const {rows}=await db.query(`SELECT h.id,h.job,
 EXISTS(SELECT 1 FROM carrier_label_history_documents d WHERE d.history_id=h.id) AS documents
 FROM carrier_label_history h WHERE h.order_id=$1 FOR SHARE`,[id]);
 for(const h of rows)if(h.documents||!await canRetryFailedCarrier(db,h.job,{manualRequest}))return true;
 return false;
}
export async function markCarrierCreationStarted(db,id){
 const r=await db.query(`UPDATE carrier_jobs SET creation_started_at=now(),failure_phase=null,updated_at=now()
 WHERE order_id=$1 AND status='creating' AND creation_started_at IS NULL RETURNING order_id`,[id]);
 if(r.rows.length!==1)throw Error('Création déjà engagée : rapprocher son résultat');
}
export async function recordCarrierFailure(db,id,{status,error,creationStarted,hasResult}){
 const phase=!creationStarted&&!hasResult?'preflight':'provider';
 await db.query(`UPDATE carrier_jobs SET status=$2,error=$3,original_error=coalesce(original_error,$3),
 failure_phase=$4,updated_at=now() WHERE order_id=$1`,[id,status,error,phase]);
}
