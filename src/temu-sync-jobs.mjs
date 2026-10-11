import {temuReadDeferral} from './temu-read-deferral.mjs';
// Read-only TEMU reconciliation. This worker never calls the purchase endpoint.
export async function initializeTemuSync(db){await db.exec(`CREATE TABLE IF NOT EXISTS temu_sync_jobs(reference text PRIMARY KEY,status text NOT NULL DEFAULT 'queued',priority int NOT NULL DEFAULT 0,attempts int NOT NULL DEFAULT 0,error text,last_checked_at timestamptz,last_success_at timestamptz,next_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now());CREATE INDEX IF NOT EXISTS temu_sync_due ON temu_sync_jobs(next_at,status);`);}
export function temuSyncJobs(db,local,{shouldStop=()=>false,concurrency=2}={}){
 let running=false;
 async function enqueue(references=null,{force=false}={}){
  if(references!==null&&(!Array.isArray(references)||references.length>2000||references.some(r=>!/^PO-\d+(?:-\d+)+$/.test(r))))throw Error('Références TEMU invalides');
  await db.query(`INSERT INTO temu_sync_jobs(reference) SELECT reference FROM orders WHERE channel='temu' AND NOT archived AND ($1::text[] IS NULL OR reference=ANY($1::text[])) ON CONFLICT DO NOTHING`,[references]);
  if(force)await db.query(`UPDATE temu_sync_jobs s SET status='queued',next_at=now(),priority=1,updated_at=now() FROM orders o WHERE o.reference=s.reference AND o.channel='temu' AND NOT o.archived AND ($1::text[] IS NULL OR s.reference=ANY($1::text[])) AND s.status<>'running' AND (s.last_checked_at IS NULL OR s.last_checked_at<now()-interval '1 minute')`,[references]);
 }
 async function status(){
  const r=(await db.query(`SELECT count(*)::int total,count(*) FILTER(WHERE s.last_checked_at IS NOT NULL)::int checked,count(*) FILTER(WHERE s.status='running')::int running,count(*) FILTER(WHERE s.error IS NOT NULL)::int errors,count(*) FILTER(WHERE s.next_at<=now() OR s.status='running')::int remaining,max(s.last_checked_at) "lastCheckedAt" FROM temu_sync_jobs s JOIN orders o ON o.reference=s.reference AND o.channel='temu' WHERE NOT o.archived`)).rows[0];
  const worker=(await db.query("SELECT 1 FROM worker_health WHERE role IN ('worker','all') AND heartbeat>now()-interval '30 seconds' AND coalesce((state->>'stopping')::boolean,false)=false AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(state->'tasks','[]'::jsonb)) t WHERE t->>'name'='temu-logistics' AND t->>'enabled'='false') LIMIT 1")).rows.length>0;
  return {...r,workerAvailable:worker,percent:r.total?Math.floor((r.total-r.remaining)*100/r.total):100};
 }
 async function run(){
  if(running||shouldStop())return;running=true;
  try{
   await enqueue();
   // A killed read can safely be retried; purchase uncertainty is handled separately.
   await db.query("UPDATE temu_sync_jobs SET status='queued',next_at=now() WHERE status='running' AND started_at<now()-interval '5 minutes'");
   const jobs=await db.transaction(async tx=>{const rows=(await tx.query(`SELECT s.reference FROM temu_sync_jobs s JOIN orders o ON o.reference=s.reference AND o.channel='temu' WHERE NOT o.archived AND s.status<>'running' AND s.next_at<=now() ORDER BY s.priority DESC,CASE WHEN s.last_checked_at IS NULL THEN 0 ELSE 1 END,s.next_at,CASE WHEN o.source_payload::text LIKE '%PK-%' THEN 0 ELSE 1 END,s.last_checked_at,o.source_date DESC,s.reference FOR UPDATE OF s SKIP LOCKED LIMIT $1`,[concurrency])).rows;for(const j of rows)await tx.query("UPDATE temu_sync_jobs SET status='running',started_at=now(),updated_at=now() WHERE reference=$1",[j.reference]);return rows;});
   await Promise.all(jobs.map(async j=>{
    if(shouldStop()){await db.query("UPDATE temu_sync_jobs SET status='queued' WHERE reference=$1",[j.reference]);return;}
    let error=null,delay=480;
    let deferred=null;
    try{const r=await local.recover(j.reference);if(r.deferred)deferred=r;else{error=r.error||null;if(r.status==='document_unavailable')delay=21600;else if(['complete','cancelled','not_to_ship','external'].includes(r.status))delay=1800;else if(r.status==='pending')delay=300;else if(error)delay=900;}}catch(e){if(e.code==='source_budget_deferred')deferred=temuReadDeferral(e,{reference:j.reference});else if(e.code==='TEMU_STOPPING'){await db.query("UPDATE temu_sync_jobs SET status='queued',next_at=now()+interval '1 second' WHERE reference=$1",[j.reference]);return;}else{error=String(e.message||e).slice(0,450);delay=900;}}
    if(deferred){await db.query("UPDATE temu_sync_jobs SET status='deferred',error=CASE WHEN error='Quota partagé : lecture différée' THEN null ELSE error END,priority=0,next_at=now()+($2::double precision*interval '1 millisecond'),updated_at=now() WHERE reference=$1",[j.reference,deferred.retryAfterMs]);return;}
    await db.query(`UPDATE temu_sync_jobs SET status=$2,error=$3,attempts=attempts+1,priority=0,last_checked_at=now(),last_success_at=CASE WHEN $3::text IS NULL THEN now() ELSE last_success_at END,next_at=now()+($4::int*interval '1 second'),updated_at=now() WHERE reference=$1`,[j.reference,error?'failed':'idle',error,delay]);
   }));
  }finally{running=false;}
 }
 return {enqueue,status,run,get running(){return running;}};
}
