import {withoutPreparationObservation,withoutPreparationObservationSql,currentMovementDetail} from './movement-watch-diagnostic.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {observeMovement,observationFingerprint,transportClients} from './movement-watch-observation.mjs';
export const CHECK_MS=900000,WATCHDOG_MS=300000,LEASE_MS=600000;
export async function initializeMovementWatch(db){await db.exec(`CREATE TABLE IF NOT EXISTS movement_watch(
 order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
 first_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),last_check_at TIMESTAMPTZ,next_check_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 lease_token TEXT,lease_until TIMESTAMPTZ,check_started_at TIMESTAMPTZ,attempts INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL DEFAULT 'waiting',source_fingerprint TEXT,evidence JSONB NOT NULL DEFAULT '{}',
 reason_code TEXT NOT NULL DEFAULT 'not_checked',detail TEXT NOT NULL DEFAULT 'Première vérification programmée',
 alerted_at TIMESTAMPTZ,alert_key TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS movement_watch_due ON movement_watch(next_check_at,lease_until);`);}
const scope=`o.channel='temu' AND (o.issue ILIKE '%Absence de mouvement non vérifiable%' OR o.source_payload->'selectedReimport'->>'reason' ILIKE '%Absence de mouvement non vérifiable%' OR o.issue ILIKE '%Suivi du colis non vérifiable%')`;
export async function seedMovementWatch(db){return (await db.query(`INSERT INTO movement_watch(order_id,first_observed_at) SELECT o.id,coalesce((SELECT min(e.updated_at) FROM erp_live_jobs e WHERE e.order_id=o.id),clock_timestamp()) FROM orders o WHERE (${scope}) AND o.reference NOT LIKE 'DEMO-%' ON CONFLICT DO NOTHING RETURNING order_id`)).rows.length;}
export async function claimMovementObservation(db){const token=randomUUID();return db.transaction(async tx=>{
 const row=(await tx.query(`SELECT w.order_id FROM movement_watch w WHERE w.next_check_at<=clock_timestamp() AND (w.lease_until IS NULL OR w.lease_until<=clock_timestamp()) ORDER BY w.next_check_at,w.first_observed_at,w.order_id FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];if(!row)return null;
 await tx.query("UPDATE movement_watch SET lease_token=$2,lease_until=clock_timestamp()+interval '10 minutes',check_started_at=clock_timestamp(),state='checking',attempts=attempts+1,updated_at=clock_timestamp() WHERE order_id=$1",[row.order_id,token]);
 const order=(await tx.query('SELECT * FROM orders WHERE id=$1',[row.order_id])).rows[0];return {order,token};
});}
export async function finishMovementObservation(db,job,result,{retryAfter=0}={}){
 if(result?.domain!=='physical_parcel_tracking'||typeof result.detail!=='string')throw Error('Preuve hors du périmètre transport');
 return db.transaction(async tx=>{
 const fingerprint=observationFingerprint(job.order),current=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[job.order.id])).rows[0];
 if(!current)return false;
 const changed=observationFingerprint(current)!==fingerprint;
 const prior=(await tx.query('SELECT * FROM movement_watch WHERE order_id=$1 AND lease_token=$2 AND lease_until>clock_timestamp() FOR UPDATE',[job.order.id,job.token])).rows[0];if(!prior)return false;
 result={...result,detail:currentMovementDetail(result.reasonCode,result.detail)};
 const evidence=changed?{writeAllowed:false,resumeAllowed:false,reasonCode:'order_changed',detail:'Commande modifiée pendant la lecture : nouvelle vérification requise.'}:{...result};
 if(prior.evidence?.publicReason)evidence.publicReason=prior.evidence.publicReason;
 if(!changed&&result.reasonCode!=='read_interrupted'){const old=String(current.issue||'').includes('Absence de mouvement non vérifiable')?'Absence de mouvement non vérifiable':prior.evidence?.publicReason;
  if(old&&String(current.issue||'').includes(old)){evidence.publicReason=result.reasonCode==='preparation_only_observed'?null:result.detail;current.issue=result.reasonCode==='preparation_only_observed'?withoutPreparationObservation(String(current.issue)):String(current.issue).replaceAll(old,result.detail);await tx.query('UPDATE orders SET issue=$2 WHERE id=$1',[current.id,current.issue]);if(result.reasonCode==='preparation_only_observed')await tx.query('UPDATE erp_live_jobs SET error='+withoutPreparationObservationSql('error')+' WHERE order_id=$1 AND error IS NOT NULL',[current.id]);else await tx.query('UPDATE erp_live_jobs SET error=replace(error,$2,$3) WHERE order_id=$1 AND error IS NOT NULL AND position($2 IN error)>0',[current.id,old,result.detail]);}
 }
 const delay=changed||result.reasonCode==='read_interrupted'?0:Math.max(CHECK_MS,Number.isFinite(retryAfter)?retryAfter*1000:0);
 return (await tx.query(`UPDATE movement_watch SET state=$3,reason_code=$4,detail=$5,evidence=$6::jsonb,source_fingerprint=$7,last_check_at=clock_timestamp(),next_check_at=clock_timestamp()+($8::double precision*interval '1 millisecond'),lease_token=NULL,lease_until=NULL,alerted_at=CASE WHEN $4='preparation_only_observed' THEN NULL ELSE alerted_at END,alert_key=CASE WHEN $4='preparation_only_observed' THEN NULL ELSE alert_key END,updated_at=clock_timestamp() WHERE order_id=$1 AND lease_token=$2 RETURNING order_id`,[job.order.id,job.token,changed?'waiting':'observed',evidence.reasonCode,evidence.detail,JSON.stringify(evidence),changed?null:observationFingerprint(current),delay])).rows.length===1;
 });
}
export async function movementWatchdog(db){
 await seedMovementWatch(db);
 // Requalify persisted diagnostic text without waiting for a remote quota.
 // Preserve statuses, documents, stock, histories and all independent reasons.
 await db.query('UPDATE orders SET issue='+withoutPreparationObservationSql('issue')+" WHERE channel='temu' AND issue IS DISTINCT FROM ("+withoutPreparationObservationSql('issue')+')');
 await db.query('UPDATE erp_live_jobs SET error='+withoutPreparationObservationSql('error')+" WHERE order_id IN (SELECT id FROM orders WHERE channel='temu') AND error IS DISTINCT FROM ("+withoutPreparationObservationSql('error')+')');
 await db.query("UPDATE movement_watch SET detail=$1,alerted_at=NULL,alert_key=NULL WHERE reason_code='preparation_only_observed' AND (detail<>$1 OR alerted_at IS NOT NULL OR alert_key IS NOT NULL)",[currentMovementDetail('preparation_only_observed')]);
 await db.query("UPDATE movement_watch SET state='waiting',lease_token=NULL,lease_until=NULL,next_check_at=least(next_check_at,clock_timestamp()),detail='Vérification interrompue : reprise en lecture seule programmée',updated_at=clock_timestamp() WHERE lease_until<=clock_timestamp()");
 // Alert keys are stable for an unchanged reason and source; no alert spam.
 const rows=(await db.query("SELECT order_id,reason_code,source_fingerprint,alert_key FROM movement_watch WHERE first_observed_at<=clock_timestamp()-interval '1 hour' AND reason_code<>'preparation_only_observed'")).rows;
 for(const r of rows){const key=createHash('sha256').update(JSON.stringify([r.order_id,r.reason_code,r.source_fingerprint])).digest('hex');if(key!==r.alert_key)await db.query('UPDATE movement_watch SET alerted_at=clock_timestamp(),alert_key=$2 WHERE order_id=$1 AND reason_code=$3 AND source_fingerprint IS NOT DISTINCT FROM $4',[r.order_id,key,r.reason_code,r.source_fingerprint]);}
 await db.query("INSERT INTO settings(key,value) VALUES('movement_watchdog',jsonb_build_object('lastSuccessAt',clock_timestamp())) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
}
export function movementWatchWorker(db,directory,{api,observe=observeMovement,shouldStop=()=>false}={}){
 api=api||transportClients(directory,{shouldStop});let running=false,seededAt=0;
 return {get running(){return running;},async run(){if(running||shouldStop())return;running=true;try{if(Date.now()-seededAt>=60000){await seedMovementWatch(db);seededAt=Date.now();}const job=await claimMovementObservation(db);if(!job)return;
  // Renew technical lease while a rate-limited read waits; never force a retry.
  let leaseLost=false,renewing=Promise.resolve();const timer=setInterval(()=>{renewing=renewing.then(async()=>{try{const r=await db.query("UPDATE movement_watch SET lease_until=clock_timestamp()+interval '10 minutes' WHERE order_id=$1 AND lease_token=$2 AND lease_until>clock_timestamp() RETURNING order_id",[job.order.id,job.token]);if(!r.rows.length)leaseLost=true;}catch{leaseLost=true;}});},60000);timer.unref();
  try{let result,retryAfter=0;try{const reader=api.forOrder?await api.forOrder(job.order):api;result=await observe(reader,job.order);}catch(e){retryAfter=Number(e.retryAfter)||0;const message=String(e.message).slice(0,600);result={domain:'physical_parcel_tracking',writeAllowed:false,resumeAllowed:false,reasonCode:'read_incomplete',detail:message.startsWith('Suivi du colis non vérifiable')?message+' (TEMU)':'Suivi du colis non vérifiable (TEMU) : '+message};}
   if(shouldStop())result={domain:'physical_parcel_tracking',writeAllowed:false,resumeAllowed:false,reasonCode:'read_interrupted',detail:'Lecture interrompue pour arrêt propre : nouvelle vérification programmée au redémarrage.'};
   if(!leaseLost)await finishMovementObservation(db,job,result,{retryAfter});
  }finally{clearInterval(timer);await renewing;}
 }finally{running=false;}}};
}
export async function movementWatchStatus(db){
 const stored=(await db.query(`SELECT w.order_id,o.reference,row_to_json(o) AS current_order,w.state,w.reason_code,w.detail,w.first_observed_at,w.last_check_at,w.next_check_at,w.alerted_at,w.source_fingerprint,w.evidence,((w.next_check_at<clock_timestamp()-interval '5 minutes') AND (w.lease_until IS NULL OR w.lease_until<=clock_timestamp())) AS overdue,(w.check_started_at<clock_timestamp()-interval '20 minutes' AND w.state='checking') AS stalled FROM movement_watch w JOIN orders o ON o.id=w.order_id ORDER BY w.next_check_at,w.order_id`)).rows;
 const rows=stored.map(({current_order,evidence,source_fingerprint,...row})=>source_fingerprint&&source_fingerprint!==observationFingerprint(current_order)?{...row,reason_code:'order_changed',detail:'Commande modifiée depuis la dernière lecture : preuve à actualiser.',proofCurrent:false}:{...row,detail:currentMovementDetail(row.reason_code,row.detail),alerted_at:row.reason_code==='preparation_only_observed'?null:row.alerted_at,proofCurrent:!!source_fingerprint});
 const watchdog=(await db.query("SELECT value FROM settings WHERE key='movement_watchdog'")).rows[0]?.value||{};
 return {at:new Date().toISOString(),checkEveryMinutes:15,watchdogEveryMinutes:5,alertAfterMinutes:60,watchdog,rows};
}
