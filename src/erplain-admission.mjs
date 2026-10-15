import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';

const context=new AsyncLocalStorage(),initializations=new WeakMap(),memory=new Map();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export const erplainTraffic=()=>context.getStore()||'foreground';
export function withErplainTraffic(traffic,fn){
 if(!['foreground','background'].includes(traffic))throw Error('Priorité Erplain invalide');
 return context.run(traffic,fn);
}
const foregroundTasks=new Set(['erplain-preparation','corrections','resolutions','resolutions-followup','partials','extra-parcels','carrier-gls','carrier-gofo','receipt-recovery','stock-resume']);
export const erplainTaskTraffic=name=>foregroundTasks.has(name)?'foreground':'background';
const deferred=delay=>Object.assign(Error('Quota partagé : lecture différée'),{code:'source_budget_deferred',retryAfter:String(Math.max(2,Math.ceil(delay/1000)))});

async function initialize(db){
 if(!initializations.has(db))initializations.set(db,db.transaction(async tx=>{
  if(db.kind==='postgres')await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('nextech:erplain-admission-init',0))");
  await tx.query('CREATE TABLE IF NOT EXISTS api_budget(key text PRIMARY KEY,next_at timestamptz NOT NULL)');
  await tx.query('CREATE TABLE IF NOT EXISTS erplain_quota_waiters(id text PRIMARY KEY,key text NOT NULL,traffic text NOT NULL,ticket bigserial UNIQUE,expires_at timestamptz NOT NULL)');
  await tx.query('CREATE INDEX IF NOT EXISTS erplain_quota_waiters_due ON erplain_quota_waiters(key,traffic,ticket)');
  await tx.query('CREATE TABLE IF NOT EXISTS erplain_quota_turns(key text PRIMARY KEY,foreground_streak integer NOT NULL DEFAULT 0,foreground_grants bigint NOT NULL DEFAULT 0,background_grants bigint NOT NULL DEFAULT 0,deferred bigint NOT NULL DEFAULT 0,max_wait_ms integer NOT NULL DEFAULT 0,provider_pauses bigint NOT NULL DEFAULT 0,last_pause_at timestamptz)');
 }).catch(e=>{initializations.delete(db);throw e;}));
 await initializations.get(db);
}
export async function noteErplainProviderPause(db,key){
 if(!db)return;
 await initialize(db);
 await db.query(`INSERT INTO erplain_quota_turns(key,provider_pauses,last_pause_at) VALUES($1,1,clock_timestamp())
  ON CONFLICT(key) DO UPDATE SET provider_pauses=erplain_quota_turns.provider_pauses+1,last_pause_at=EXCLUDED.last_pause_at`,[key]);
}
export function erplainHead(rows,streak){
 const foreground=rows.find(r=>r.traffic==='foreground'),background=rows.find(r=>r.traffic==='background');
 return streak>=4?(background||foreground):(foreground||background);
}

// The only transaction is a short local admission decision. It never waits for
// the provider, sleeps, or reserves future slots. All processes use api_budget.
async function claim(db,key,id,intervalMs,waitMs){
 return db.transaction(async tx=>{
  await tx.query('INSERT INTO erplain_quota_turns(key) VALUES($1) ON CONFLICT DO NOTHING',[key]);
  const turn=(await tx.query('SELECT foreground_streak FROM erplain_quota_turns WHERE key=$1 FOR UPDATE',[key])).rows[0];
  await tx.query('DELETE FROM erplain_quota_waiters WHERE key=$1 AND expires_at<=clock_timestamp()',[key]);
  const own=await tx.query("UPDATE erplain_quota_waiters SET expires_at=clock_timestamp()+interval '30 seconds' WHERE id=$1 RETURNING id",[id]);
  if(!own.rows.length)throw deferred(intervalMs);
  const rows=(await tx.query('SELECT id,traffic FROM erplain_quota_waiters WHERE key=$1 ORDER BY ticket',[key])).rows;
  const head=erplainHead(rows,Number(turn.foreground_streak));
  if(head?.id===id){
   const grant=await tx.query(`INSERT INTO api_budget(key,next_at) VALUES($1,clock_timestamp()+($2::int*interval '1 millisecond'))
    ON CONFLICT(key) DO UPDATE SET next_at=clock_timestamp()+($2::int*interval '1 millisecond') WHERE api_budget.next_at<=clock_timestamp() RETURNING key`,[key,intervalMs]);
   if(grant.rows.length){
    await tx.query(`UPDATE erplain_quota_turns SET foreground_streak=$2,
     foreground_grants=foreground_grants+CASE WHEN $3='foreground' THEN 1 ELSE 0 END,
     background_grants=background_grants+CASE WHEN $3='background' THEN 1 ELSE 0 END,
     max_wait_ms=greatest(max_wait_ms,$4::int) WHERE key=$1`,[key,head.traffic==='background'?0:Math.min(4,Number(turn.foreground_streak)+1),head.traffic,Math.min(2147483647,waitMs)]);
    await tx.query('DELETE FROM erplain_quota_waiters WHERE id=$1',[id]);
    return {granted:true,delay:0};
   }
  }
  const delay=Number((await tx.query('SELECT greatest(0,extract(epoch FROM(next_at-clock_timestamp()))*1000) delay FROM api_budget WHERE key=$1',[key])).rows[0]?.delay)||0;
  return {granted:false,delay};
 });
}

export async function erplainAdmission(key,intervalMs,{database,available,maxWaitMs,shouldStop,onProgress}){
 const traffic=erplainTraffic(),id=randomUUID(),started=Date.now();let queue,registered=false;
 try{
  if(shouldStop())throw Object.assign(Error('Arrêt demandé'),{code:'TEMU_STOPPING'});
  if(database){await initialize(database);await database.query("INSERT INTO erplain_quota_waiters(id,key,traffic,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '30 seconds')",[id,key,traffic]);}
  else{queue=memory.get(key)||{rows:[],streak:0};memory.set(key,queue);queue.rows.push({id,traffic});}
  registered=true;
  for(;;){
   if(shouldStop())throw Object.assign(Error('Arrêt demandé'),{code:'TEMU_STOPPING'});
   await onProgress?.();
   let result;
   if(database)result=await claim(database,key,id,intervalMs,Date.now()-started);
   else{
    const delay=Math.max(0,(available.get(key)||0)-Date.now()),head=erplainHead(queue.rows,queue.streak);
    if(head?.id===id&&delay<=0){available.set(key,Date.now()+intervalMs);queue.streak=traffic==='background'?0:Math.min(4,queue.streak+1);return;}
    result={granted:false,delay};
   }
   if(result.granted)return;
   const remaining=maxWaitMs===Infinity?Infinity:maxWaitMs-(Date.now()-started);
   // One common cooldown, rather than per-order sleeps or premature claims.
   if(remaining<=0||result.delay>remaining)throw deferred(Math.max(intervalMs,result.delay));
   await sleep(Math.min(database?500:100,remaining,Math.max(database?100:5,result.delay)));
  }
 }catch(error){
  if(database&&registered&&error?.code==='source_budget_deferred')await database.query('UPDATE erplain_quota_turns SET deferred=deferred+1 WHERE key=$1',[key]).catch(()=>{});
  throw error;
 }finally{
  if(registered&&database)await database.query('DELETE FROM erplain_quota_waiters WHERE id=$1',[id]);
  if(registered&&queue){queue.rows=queue.rows.filter(r=>r.id!==id);if(!queue.rows.length)memory.delete(key);}
 }
}
