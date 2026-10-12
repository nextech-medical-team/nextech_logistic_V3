import {paidDeferredBillingDiagnosis,projectCurrentDiagnostics} from './current-order-diagnostics.mjs';
import {consumerInvoice} from './invoice-customer-policy.mjs';

// This retires a local diagnostic only after the lifecycle has confirmed payment.
// No supplier mutation, document replacement or label creation occurs here.
export async function reconcilePaidBillingDiagnosis(db,orderId,result){
 const invoice=result?.invoice,bl=result?.bl;
 if(result?.billing!=='paid'||invoice?.status!=='paid'||bl?.status!=='delivered'||!/^\d+$/.test(String(invoice.id))||!/^\d+$/.test(String(bl.id))||!Number.isFinite(Number(invoice.total))||!Number.isFinite(Number(invoice.paid_amount))||Number(invoice.total)<=0||Number(invoice.remaining_balance)!==0||Number(invoice.paid_amount)<Number(invoice.total))return {changed:false,reason:'paid_result_unconfirmed'};
 return db.transaction(async tx=>{
  const row=(await tx.query(`SELECT o.*,l.partial_id,l.journal,l.result AS lifecycle_result,l.error AS lifecycle_error,l.locked AS lifecycle_locked FROM orders o JOIN document_lifecycle l ON l.order_id=o.id WHERE o.id=$1 AND l.bl_id=$2 FOR UPDATE OF o,l`,[orderId,String(bl.id)])).rows[0];
  if(!row||row.lifecycle_locked||row.partial_id||row.archived||row.suspension?.active===true||row.suspension?.erplainCancellation||[row.label_status,row.erp_status,row.tracking_status,row.erp_live?.bc?.status,row.erp_live?.bl?.status].includes('cancelled')||row.invoice_status!=='paid'||String(row.journal?.invoiceId)!==String(invoice.id)||!Number.isFinite(Date.parse(row.journal?.completedAt))||row.lifecycle_error||row.lifecycle_result?.billing!=='paid'||row.lifecycle_result?.invoice?.status!=='paid'||String(row.lifecycle_result.invoice.id)!==String(invoice.id)||String(row.erp_live?.bl?.id)!==String(bl.id)||!consumerInvoice({channel:row.channel,sourcePayload:row.source_payload}))return {changed:false,reason:'current_paid_lifecycle_unconfirmed'};
  const label=(await tx.query('SELECT status,error,packages FROM temu_label_jobs WHERE reference=$1 FOR SHARE',[row.reference])).rows[0];row.temu_job=label||null;
  if(!paidDeferredBillingDiagnosis(row))return {changed:false,reason:'different_or_unverified_diagnosis'};
  row.erp_live_job=(await tx.query('SELECT status,error FROM erp_live_jobs WHERE order_id=$1 FOR SHARE',[orderId])).rows[0]||null;
  row.carrier_job=(await tx.query('SELECT status,error FROM carrier_jobs WHERE order_id=$1 FOR SHARE',[orderId])).rows[0]||null;
  row.resolution_actions=(await tx.query('SELECT status,error FROM resolution_jobs WHERE order_id=$1 FOR SHARE',[orderId])).rows;
  const next=projectCurrentDiagnostics(structuredClone(row));
  const independent=next.issue||next.erp_live_job?.error||next.carrier_job?.error||next.resolution_actions.some(j=>j.error||['queued','running','waiting'].includes(j.status));
  const packages=label?.packages&&typeof label.packages==='object'?Object.keys(label.packages):[];
  const documents=Number((await tx.query('SELECT count(*)::int AS n FROM temu_label_documents WHERE reference=$1 AND package=ANY($2::text[])',[row.reference,packages])).rows[0].n);
  const restoreLabel=row.label_status==='blocked'&&!independent&&label?.status==='complete'&&documents>0;
  const labelStatus=restoreLabel?'production_ready':row.label_status,pendingResume=restoreLabel?false:row.resolution_pending_resume;
  const currentIssue=next.issue||(!independent&&row.label_status==='blocked'&&!restoreLabel?'Étiquette TEMU à vérifier · Document courant non confirmé':null);
  if(currentIssue===row.issue&&labelStatus===row.label_status&&pendingResume===row.resolution_pending_resume)return {changed:false,reason:'already_current'};
  const receipt={at:new Date().toISOString(),invoiceId:String(invoice.id),blId:String(bl.id),previousIssue:row.issue,previousLabelStatus:row.label_status,previousPendingResume:row.resolution_pending_resume,labelsPreserved:true,providerWrites:0};
  await tx.query(`UPDATE orders SET issue=$2,label_status=$3,resolution_pending_resume=$4,erp_live=jsonb_set(erp_live,'{paidBillingDiagnosisRetirement}',$5::jsonb,true) WHERE id=$1`,[orderId,currentIssue,labelStatus,pendingResume,JSON.stringify(receipt)]);
  return {changed:true,issue:currentIssue,labelStatus,labelsPreserved:true,providerWrites:0};
 });
}
