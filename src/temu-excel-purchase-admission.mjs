import {assertLabelStockGate} from './label-stock-gate.mjs';
import {suspensionBlock} from './order-suspension.mjs';
// Document-only resume intentionally keeps the manual-purchase hold. It is
// not an unfinished preparation when the original Excel job has completed.
export async function completedExcelPreparation(db,o){
 const id=o.source_payload?.temuExcelPreparation?.jobId;
 if(!id)return false;
 const jobs=(await db.query('SELECT id,action,status,error,result FROM resolution_jobs WHERE order_id=$1 ORDER BY created_at DESC,id DESC',[o.id])).rows;
 const complete=j=>j?.status==='complete'&&!j.error&&j.result?.erpOnly===true&&!j.result?.readOnly&&!j.result?.partialRemainder&&!j.result?.manualPricing&&!j.result?.equivalent;
 const original=jobs.find(j=>j.id===id),latest=jobs[0];
 // A completed BL retry legitimately follows the import. Keep the original
 // provenance and reject independent corrections or work still in progress.
 return !!(original?.action==='resume'&&complete(original)&&complete(latest)&&
  (latest.id===id||['resume','resume-erp'].includes(latest.action))&&
  jobs.every(r=>!['pending','queued','running','waiting','processing','review'].includes(r.status)));
}

// Release only the completed Excel import's hold, not an unrelated correction.
export async function releaseExcelPurchaseHold(db,id){
 return db.transaction(async tx=>{
  const o=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(o?.source_payload?.origin!=='temu_excel'||!o.resolution_pending_resume||o.archived||o.issue||o.partial_mode||o.transport_choice||suspensionBlock(o)||o.source_payload.marketplacePendingCorrection||o.source_payload.visibilityHold)return;
  if(!await completedExcelPreparation(tx,o))return;
  await assertLabelStockGate(tx,o);
  await tx.query("UPDATE orders SET resolution_pending_resume=false,source_payload=source_payload||'{\"manualLabelPurchaseRequired\":false}'::jsonb WHERE id=$1",[id]);
 });
}
