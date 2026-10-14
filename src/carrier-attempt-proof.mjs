// Technical creation provenance, independent of the displayed diagnostic.
// A BL is the business prerequisite; only duplicate/uncertain writes need proof.
const localValidation=/^(BC modifié depuis sa préparation : recontrôle requis$|Préparation modifiée depuis|Validation de la préparation|Étiquette bloquée : contrôle du stock)/;
export async function installCarrierAttemptProof(db){
 await db.exec(`ALTER TABLE carrier_jobs ADD COLUMN IF NOT EXISTS creation_started_at TIMESTAMPTZ;
 ALTER TABLE carrier_jobs ADD COLUMN IF NOT EXISTS failure_phase TEXT;
 ALTER TABLE carrier_jobs ADD COLUMN IF NOT EXISTS original_error TEXT;`);
}
function noCreationEvidence(job){return !job.result&&!job.reference&&Array.isArray(job.tracking)&&job.tracking.length===0;}
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
 &&d?.orderId===job.order_id&&d.currentError===job.error&&localValidation.test(d.previousError||'')
 &&p?.readOnly===true&&p.verified===true&&p.businessActionAuthorized===false
 &&d.businessWrites===0&&d.labelPurchased===false
 &&p.previousFailureAt===d.previousUpdatedAt
 &&Number.isFinite(Date.parse(p.previousFailureAt))
 &&Date.parse(p.previousFailureAt)<Date.parse(p.validationAt)
 &&new Date(job.updated_at).getTime()===new Date(audit.created_at).getTime();
}
export async function canRetryFailedCarrier(db,job){
 if(job?.status!=='failed'||!noCreationEvidence(job)||job.creation_started_at)return false;
 if(job.failure_phase==='preflight')return job.creation_started_at===null;
 if(job.failure_phase)return false;
 // Existing unambiguous validation errors and jobs never attempted keep their policy.
 if(job.attempts===0||localValidation.test(job.error||''))return true;
 const {rows}=await db.query(`SELECT detail,created_at FROM audit
 WHERE action IN ('carrier.prevalidation_diagnostic_revalidated','carrier.imported_fields_diagnostic_revalidated') AND detail->>'orderId'=$1
 ORDER BY created_at DESC LIMIT 1`,[job.order_id]);
 return provesLegacyPreflight(job,rows[0])||provesImportedFieldsPreflight(job,rows[0]);
}
export async function hasUncertainCarrierHistory(db,id){
 const {rows}=await db.query(`SELECT h.id,h.job,
 EXISTS(SELECT 1 FROM carrier_label_history_documents d WHERE d.history_id=h.id) AS documents
 FROM carrier_label_history h WHERE h.order_id=$1 FOR SHARE`,[id]);
 for(const h of rows)if(h.documents||!await canRetryFailedCarrier(db,h.job))return true;
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
