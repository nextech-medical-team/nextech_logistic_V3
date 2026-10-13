// Document-only resume intentionally keeps the manual-purchase hold. It is
// not an unfinished preparation when the original Excel job has completed.
export async function completedExcelPreparation(db,o){
 const id=o.source_payload?.temuExcelPreparation?.jobId;
 if(!id)return false;
 const jobs=(await db.query('SELECT id,action,status,error,result FROM resolution_jobs WHERE order_id=$1 ORDER BY created_at DESC,id DESC',[o.id])).rows;
 const j=jobs[0];
 return !!(j?.id===id&&j.action==='resume'&&j.status==='complete'&&!j.error&&j.result?.erpOnly===true&&!j.result?.readOnly&&!j.result?.partialRemainder&&jobs.every(r=>!['pending','queued','running','waiting','processing','review'].includes(r.status)));
}
