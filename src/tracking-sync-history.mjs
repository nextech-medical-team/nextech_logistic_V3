import {createHash} from 'node:crypto';
export const trackingTargetKey=t=>createHash('sha256').update(JSON.stringify([t.orderId,t.partialId||null,t.blId||null])).digest('hex');

export async function initializeTrackingSync(db){
 await db.exec(`CREATE TABLE IF NOT EXISTS tracking_sync_runs(
  id text PRIMARY KEY,requested_by text NOT NULL,mode text NOT NULL,order_ids jsonb,
  status text NOT NULL DEFAULT 'queued',total integer NOT NULL DEFAULT 0,processed integer NOT NULL DEFAULT 0,
  counts jsonb NOT NULL DEFAULT '{}',error text,created_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,finished_at timestamptz);
 CREATE UNIQUE INDEX IF NOT EXISTS tracking_sync_one_active ON tracking_sync_runs((1)) WHERE status IN ('queued','running');
 CREATE TABLE IF NOT EXISTS tracking_sync_observations(
  id bigserial PRIMARY KEY,run_id text REFERENCES tracking_sync_runs(id),target_key text NOT NULL,
  order_id text NOT NULL,reference text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS tracking_sync_latest ON tracking_sync_observations(target_key,id DESC);
 CREATE TABLE IF NOT EXISTS tracking_sync_changes(
  id bigserial PRIMARY KEY,target_key text NOT NULL,run_id text,carrier_before text,carrier_after text,
  erplain_before text,erplain_after text,created_at timestamptz NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS tracking_sync_changes_target ON tracking_sync_changes(target_key,id DESC);`);
}

export async function saveTrackingObservation(db,row,target,runId=null){
 const key=trackingTargetKey(target);
 await db.transaction(async tx=>{
  // Serialize observations for the same delivery, including CLI and web runs.
  await tx.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE',[target.orderId]);
  const previous=(await tx.query('SELECT result FROM tracking_sync_observations WHERE target_key=$1 ORDER BY id DESC LIMIT 1',[key])).rows[0]?.result;
  const carrierBefore=previous?.carrierStatus||null,carrierAfter=row.carrierStatus||carrierBefore;
  const erplainBefore=row.outcome==='updated'?row.before:previous?.lastKnownErplain||previous?.after||previous?.before||null;
  const erplainAfter=row.after||row.before||erplainBefore;
  // Keep the last known status visible if the latest API read fails; its observation date stays explicit.
  const result={...row,carrierStatus:carrierAfter,carrierObservedAt:row.carrierStatus?row.observedAt:previous?.carrierObservedAt||null,
   tracking:row.tracking||previous?.tracking||[],events:row.events||previous?.events||[],lastKnownErplain:erplainAfter};
  await tx.query('INSERT INTO tracking_sync_observations(run_id,target_key,order_id,reference,result) VALUES($1,$2,$3,$4,$5)',[runId,key,target.orderId,target.reference,JSON.stringify(result)]);
  if(carrierBefore!==carrierAfter||erplainBefore!==erplainAfter)await tx.query('INSERT INTO tracking_sync_changes(target_key,run_id,carrier_before,carrier_after,erplain_before,erplain_after) VALUES($1,$2,$3,$4,$5,$6)',[key,runId,carrierBefore,carrierAfter,erplainBefore,erplainAfter]);
  if(runId)await tx.query('UPDATE tracking_sync_runs SET processed=processed+1 WHERE id=$1',[runId]);
 });
}

export async function trackingOverview(db,{page=1,search='',runId=null}={}){
 page=Math.max(1,Number.isSafeInteger(Number(page))?Number(page):1);search=String(search).slice(0,200);
 const params=[runId,'%'+search+'%'];
 const latest=`SELECT DISTINCT ON (target_key) target_key,order_id,reference,result,created_at FROM tracking_sync_observations WHERE ($1::text IS NULL OR run_id=$1) ORDER BY target_key,id DESC`;
 const filter=`FROM (${latest}) latest WHERE reference ILIKE $2 OR result->>'blId' ILIKE $2 OR (result->'tracking')::text ILIKE $2`;
 const total=Number((await db.query('SELECT count(*) AS n '+filter,params)).rows[0].n);
 const pages=Math.max(1,Math.ceil(total/50));page=Math.min(page,pages);
 const rows=(await db.query("SELECT target_key,order_id,reference,result-'events' AS result,created_at "+filter+' ORDER BY created_at DESC,target_key LIMIT 50 OFFSET $3',[...params,(page-1)*50])).rows;
 const runs=(await db.query('SELECT * FROM tracking_sync_runs ORDER BY created_at DESC LIMIT 20')).rows;
 return {rows,runs,page,pages,total};
}

export async function trackingHistory(db,key,{before=null}={}){
 if(!/^[a-f0-9]{64}$/.test(key))throw Error('Livraison invalide');
 if(before!==null&&!/^\d+$/.test(String(before)))throw Error('Page historique invalide');
 const changes=(await db.query('SELECT * FROM tracking_sync_changes WHERE target_key=$1 AND ($2::bigint IS NULL OR id<$2::bigint) ORDER BY id DESC LIMIT 101',[key,before])).rows;
 const observations=(await db.query('SELECT result,created_at FROM tracking_sync_observations WHERE target_key=$1 ORDER BY id DESC LIMIT 20',[key])).rows;
 // Carrier scans are immutable history from the latest complete response; retain distinct scans from earlier reads too.
 const events=new Map();for(const o of observations)for(const e of o.result.events||[])events.set(JSON.stringify([e.carrier,e.tracking,e.at,e.code,e.label]),e);
 return {changes:changes.slice(0,100),next:changes.length>100?String(changes[99].id):null,
  events:[...events.values()].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)),observations};
}
