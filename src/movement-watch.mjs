import {randomUUID,createHash} from 'node:crypto';
import {erplainAccount} from './erplain-accounts.mjs';
import {observeMovement,observationFingerprint} from './movement-watch-observation.mjs';
import {mutationBlock} from './erp-transient-policy.mjs';
import {canRetryStock} from './stock-creation-claim.mjs';
export const CHECK_MS=900000,WATCHDOG_MS=300000,LEASE_MS=600000;
export async function initializeMovementWatch(db){await db.exec(`CREATE TABLE IF NOT EXISTS movement_watch(
 order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
 first_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),last_check_at TIMESTAMPTZ,next_check_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 lease_token TEXT,lease_until TIMESTAMPTZ,check_started_at TIMESTAMPTZ,attempts INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL DEFAULT 'waiting',source_fingerprint TEXT,evidence JSONB NOT NULL DEFAULT '{}',
 reason_code TEXT NOT NULL DEFAULT 'not_checked',detail TEXT NOT NULL DEFAULT 'Première vérification programmée',
 alerted_at TIMESTAMPTZ,alert_key TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS movement_watch_due ON movement_watch(next_check_at,lease_until);`);}
const scope=`o.issue ILIKE '%Absence de mouvement%' OR o.source_payload->'selectedReimport'->>'reason' ILIKE '%Absence de mouvement%' OR o.erp_live->'stockReconciliation'->>'state' IN ('blocked','waiting_api','waiting_missing') OR (o.erp_live->>'phase' IN ('creating_stock','publishing_bl') AND o.erp_live->'stockDocument'->>'id' IS NULL)`;
export async function seedMovementWatch(db){return (await db.query(`INSERT INTO movement_watch(order_id,first_observed_at) SELECT o.id,coalesce((SELECT min(e.updated_at) FROM erp_live_jobs e WHERE e.order_id=o.id),clock_timestamp()) FROM orders o WHERE (${scope}) AND o.reference NOT LIKE 'DEMO-%' ON CONFLICT DO NOTHING RETURNING order_id`)).rows.length;}
export async function claimMovementObservation(db){const token=randomUUID();return db.transaction(async tx=>{
 const row=(await tx.query(`SELECT w.order_id FROM movement_watch w WHERE w.next_check_at<=clock_timestamp() AND (w.lease_until IS NULL OR w.lease_until<=clock_timestamp()) ORDER BY w.next_check_at,w.order_id FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];if(!row)return null;
 await tx.query("UPDATE movement_watch SET lease_token=$2,lease_until=clock_timestamp()+interval '10 minutes',check_started_at=clock_timestamp(),state='checking',attempts=attempts+1,updated_at=clock_timestamp() WHERE order_id=$1",[row.order_id,token]);
 const order=(await tx.query('SELECT * FROM orders WHERE id=$1',[row.order_id])).rows[0];return {order,token};
});}
export async function finishMovementObservation(db,job,result,{retryAfter=0}={}){
 return db.transaction(async tx=>{
 const fingerprint=observationFingerprint(job.order),current=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR SHARE',[job.order.id])).rows[0];
 if(!current)return false;
 const changed=observationFingerprint(current)!==fingerprint;
 const evidence=changed?{writeAllowed:false,resumeAllowed:false,reasonCode:'order_changed',detail:'Commande modifiée pendant la lecture : nouvelle vérification requise.'}:result;
 const delay=changed?0:Math.max(CHECK_MS,Number.isFinite(retryAfter)?retryAfter*1000:0);
 return (await tx.query(`UPDATE movement_watch SET state=$3,reason_code=$4,detail=$5,evidence=$6::jsonb,source_fingerprint=$7,last_check_at=clock_timestamp(),next_check_at=clock_timestamp()+($8::double precision*interval '1 millisecond'),lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE order_id=$1 AND lease_token=$2 AND lease_until>clock_timestamp() RETURNING order_id`,[job.order.id,job.token,changed?'waiting':'observed',evidence.reasonCode,evidence.detail,JSON.stringify(evidence),changed?null:fingerprint,delay])).rows.length===1;
 });
}
export async function resumeVerifiedMovement(db,orderId,{writesEnabled=process.env.ERPLAIN_LIVE_WRITES==='1'&&process.env.MIGRATION_PREPARATION!=='1'}={}){
 if(!writesEnabled)return false;
 return db.transaction(async tx=>{
  const o=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[orderId])).rows[0];if(!o||mutationBlock(o))return false;
  const prior=(await tx.query('SELECT status,error FROM erp_live_jobs WHERE order_id=$1 FOR UPDATE',[orderId])).rows[0];
  if(prior?.status!=='review'||!canRetryStock({...o,error:prior.error}))return false;
  const settings=(await tx.query("SELECT key,value FROM settings WHERE key IN ('automatic_live','background_tasks')")).rows;
  const automatic=settings.find(s=>s.key==='automatic_live')?.value?.enabled===true,controls=settings.find(s=>s.key==='background_tasks')?.value||{};
  if(!automatic||['erplain-preparation','automatic-preparation','movement-watch'].some(k=>controls[k]===false))return false;
  const w=(await tx.query("SELECT * FROM movement_watch WHERE order_id=$1 AND reason_code='cycle_movement_verified' AND last_check_at>clock_timestamp()-interval '15 minutes' FOR UPDATE",[orderId])).rows[0];
  if(!w||w.source_fingerprint!==observationFingerprint(o)||!w.evidence?.proof?.stock?.id)return false;
  if((await tx.query("SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting') UNION ALL SELECT 1 FROM correction_jobs WHERE order_id=$1 AND status IN ('queued','applying','checking','waiting')",[orderId])).rows.length)return false;
  const job=(await tx.query("UPDATE erp_live_jobs SET status='pending',error=NULL,updated_at=clock_timestamp() WHERE order_id=$1 AND status='review' RETURNING order_id",[orderId])).rows[0];if(!job)return false;
  await tx.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{stockReconciliation}',coalesce(erp_live->'stockReconciliation','{}')||jsonb_build_object('state','queued','queuedAt',clock_timestamp(),'movementWatchProof',true)) WHERE id=$1",[orderId]);return true;
 });
}
export async function movementWatchdog(db){
 await seedMovementWatch(db);
 await db.query("UPDATE movement_watch SET state='waiting',lease_token=NULL,lease_until=NULL,next_check_at=least(next_check_at,clock_timestamp()),detail='Vérification interrompue : reprise en lecture seule programmée',updated_at=clock_timestamp() WHERE lease_until<=clock_timestamp()");
 // Alert keys are stable for an unchanged reason and source; no alert spam.
 const rows=(await db.query("SELECT order_id,reason_code,source_fingerprint,alert_key FROM movement_watch WHERE first_observed_at<=clock_timestamp()-interval '1 hour'")).rows;
 for(const r of rows){const key=createHash('sha256').update(JSON.stringify([r.order_id,r.reason_code,r.source_fingerprint])).digest('hex');if(key!==r.alert_key)await db.query('UPDATE movement_watch SET alerted_at=clock_timestamp(),alert_key=$2 WHERE order_id=$1 AND reason_code=$3 AND source_fingerprint IS NOT DISTINCT FROM $4',[r.order_id,key,r.reason_code,r.source_fingerprint]);}
 await db.query("INSERT INTO settings(key,value) VALUES('movement_watchdog',jsonb_build_object('lastSuccessAt',clock_timestamp())) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
}
export function movementWatchWorker(db,directory,{api=erplainAccount(directory,'live'),observe=observeMovement,shouldStop=()=>false}={}){
 let running=false,seededAt=0;
 return {get running(){return running;},async run(){if(running||shouldStop())return;running=true;try{if(Date.now()-seededAt>=60000){await seedMovementWatch(db);seededAt=Date.now();}const job=await claimMovementObservation(db);if(!job)return;
  // Renew technical lease while a rate-limited read waits; never force a retry.
  let leaseLost=false,renewing=Promise.resolve();const timer=setInterval(()=>{renewing=renewing.then(async()=>{try{const r=await db.query("UPDATE movement_watch SET lease_until=clock_timestamp()+interval '10 minutes' WHERE order_id=$1 AND lease_token=$2 AND lease_until>clock_timestamp() RETURNING order_id",[job.order.id,job.token]);if(!r.rows.length)leaseLost=true;}catch{leaseLost=true;}});},60000);timer.unref();
  try{let result,retryAfter=0;try{result=await observe(api,job.order);}catch(e){retryAfter=Number(e.retryAfter)||0;result={writeAllowed:false,resumeAllowed:false,reasonCode:'read_incomplete',detail:String(e.message).slice(0,1000)};}
   if(!leaseLost&&await finishMovementObservation(db,job,result,{retryAfter}))await resumeVerifiedMovement(db,job.order.id);
  }finally{clearInterval(timer);await renewing;}
 }finally{running=false;}}};
}
export async function movementWatchStatus(db){
 const stored=(await db.query(`SELECT w.order_id,o.reference,row_to_json(o) AS current_order,w.state,w.reason_code,w.detail,w.first_observed_at,w.last_check_at,w.next_check_at,w.alerted_at,w.source_fingerprint,w.evidence,((w.next_check_at<clock_timestamp()-interval '5 minutes') AND (w.lease_until IS NULL OR w.lease_until<=clock_timestamp())) AS overdue,(w.check_started_at<clock_timestamp()-interval '20 minutes' AND w.state='checking') AS stalled FROM movement_watch w JOIN orders o ON o.id=w.order_id ORDER BY w.next_check_at,w.order_id`)).rows;
 const rows=stored.map(({current_order,evidence,source_fingerprint,...row})=>source_fingerprint&&source_fingerprint!==observationFingerprint(current_order)?{...row,reason_code:'order_changed',detail:'Commande modifiée depuis la dernière lecture : preuve à actualiser.',proofCurrent:false}:{...row,proofCurrent:!!source_fingerprint});
 const watchdog=(await db.query("SELECT value FROM settings WHERE key='movement_watchdog'")).rows[0]?.value||{};
 return {at:new Date().toISOString(),checkEveryMinutes:15,watchdogEveryMinutes:5,alertAfterMinutes:60,watchdog,rows};
}
