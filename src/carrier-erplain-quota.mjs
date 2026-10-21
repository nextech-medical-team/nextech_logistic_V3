import {quotaReadRetryAt} from './erplain-quota-wait.mjs';

export const carrierQuotaMessage='Erplain · Quota en attente — reprise programmée';
export const legacyCarrierQuotaMessage='Erplain HTTP 429 · attente du quota partagé différée, aucune requête envoyée';
export const carrierQuotaRetryLimit=5;
const emptyCreation=c=>c&&c.creation_started_at===null&&!c.result&&!c.reference&&Array.isArray(c.tracking)&&!c.tracking.length;
export function carrierQuotaReadError(error){
 return error?.httpStatus===429&&error?.erplainReadOnly===true&&error?.uncertain!==true;
}

// No external call in this transaction. A durable creation marker, PDF or
// historical shipment always vetoes automatic recovery, even after a restart.
export async function deferCarrierQuota(db,job,error,{legacy=false,now=Date.now()}={}){
 if(!legacy&&!carrierQuotaReadError(error))return false;
 return db.transaction(async tx=>{
  const order=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[job.order_id])).rows[0];
  if(!order||order.archived||order.partial_mode||order.label_status==='cancelled'||['shipped','delivered','in_transit','cancelled','delivered_simulated'].includes(order.tracking_status)||order.suspension?.active||order.suspension?.erplainCancellation||order.source_payload?.externalLabel?.active||order.source_payload?.visibilityHold||order.source_payload?.marketplacePendingCorrection||order.source_payload?.historicalShipments?.length)return false;
  const current=(await tx.query('SELECT * FROM carrier_jobs WHERE order_id=$1 FOR UPDATE',[job.order_id])).rows[0];
  if(!emptyCreation(current)||!current.creation_id||current.creation_id!==job.creation_id||current.environment!=='production'||current.status!==(legacy?'failed':'creating'))return false;
  if(legacy&&(current.error!==legacyCarrierQuotaMessage||current.failure_phase!=='preflight'||current.quota_retries!==0||current.stock_override))return false;
  if((await tx.query('SELECT 1 FROM carrier_documents WHERE order_id=$1 LIMIT 1',[job.order_id])).rows.length||(await tx.query('SELECT 1 FROM carrier_label_history WHERE order_id=$1 LIMIT 1',[job.order_id])).rows.length)return false;
  const retries=Number(current.quota_retries||0)+1,exhausted=retries>=carrierQuotaRetryLimit;
  const retryAt=exhausted?null:quotaReadRetryAt(error,now);
  const message=exhausted?'Erplain · Quota toujours indisponible après 5 reports : reprise manuelle requise':carrierQuotaMessage;
  await tx.query(`UPDATE carrier_jobs SET status=$2,error=$3,original_error=coalesce(original_error,$4),failure_phase='preflight',quota_retries=$5,quota_retry_at=$6,updated_at=now() WHERE order_id=$1`,[job.order_id,exhausted?'failed':'pending',message,legacy?current.error:String(error.message),retries,retryAt]);
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system',$1,$2)",[exhausted?'carrier.erplain_quota_exhausted':'carrier.erplain_quota_deferred',JSON.stringify({orderId:job.order_id,creationId:current.creation_id,retries,retryAt,legacy,externalWrites:0})]);
  return true;
 });
}

export async function installCarrierQuotaColumns(db){
 await db.exec('ALTER TABLE carrier_jobs ADD COLUMN IF NOT EXISTS quota_retry_at TIMESTAMPTZ; ALTER TABLE carrier_jobs ADD COLUMN IF NOT EXISTS quota_retries INTEGER NOT NULL DEFAULT 0');
}
export async function initializeCarrierQuota(db){
 await installCarrierQuotaColumns(db);
 await recoverLegacyCarrierQuota(db);
}
export async function recoverLegacyCarrierQuota(db){
 // Only the exact historical unsent preflight refusal can be recovered. Other
 // legacy failures and ambiguous provider calls retain their manual review.
 const {rows}=await db.query("SELECT order_id,creation_id FROM carrier_jobs WHERE status='failed' AND error=$1 AND failure_phase='preflight' AND quota_retries=0 AND creation_started_at IS NULL AND result IS NULL AND reference IS NULL AND tracking='[]'::jsonb AND environment='production' ORDER BY order_id LIMIT 100",[legacyCarrierQuotaMessage]);
 for(const job of rows)await deferCarrierQuota(db,job,{message:legacyCarrierQuotaMessage,retryAfter:60,erplainRequestNotSent:true},{legacy:true});
}
