// Technical creation provenance, independent of the displayed diagnostic.
// A BL is the business prerequisite; only duplicate/uncertain writes need proof.
const localValidation=/^(Préparation modifiée depuis|Validation de la préparation|Étiquette bloquée : contrôle du stock)/;
export async function installCarrierAttemptProof(db){
 await db.exec(`ALTER TABLE carrier_jobs ADD COLUMN IF NOT EXISTS creation_started_at TIMESTAMPTZ;
 ALTER TABLE carrier_jobs ADD COLUMN IF NOT EXISTS failure_phase TEXT;
 ALTER TABLE carrier_jobs ADD COLUMN IF NOT EXISTS original_error TEXT;`);
}
function noCreationEvidence(job){return !job.result&&!job.reference&&Array.isArray(job.tracking)&&job.tracking.length===0;}
export function provesLegacyPreflight(job,audit){
 const d=audit?.detail,p=d?.proof;
 // The audited first-generation worker incremented attempts before local validation.
 // No later attempt/creation identifier may reuse that old evidence.
 return job.status==='failed'&&job.attempts===1&&job.creation_id==null&&noCreationEvidence(job)
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
 if(job.attempts!==1||job.creation_id!=null)return false;
 const {rows}=await db.query(`SELECT detail,created_at FROM audit
 WHERE action='carrier.prevalidation_diagnostic_revalidated' AND detail->>'orderId'=$1
 ORDER BY created_at DESC LIMIT 1`,[job.order_id]);
 return provesLegacyPreflight(job,rows[0]);
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
