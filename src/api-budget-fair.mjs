import {randomUUID} from 'node:crypto';
const memoryQueues=new Map(),initializations=new WeakMap();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=seconds=>Object.assign(Error('Quota partagé : lecture différée'),{code:'source_budget_deferred',field:'source.quota',retryAfter:String(Math.max(1,Math.ceil(seconds)))});
async function initialize(db){
 if(!initializations.has(db))initializations.set(db,db.transaction(async tx=>{
  if(db.kind==='postgres')await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('nextech:api-budget-waiters-init',0))");
  await tx.query('CREATE TABLE IF NOT EXISTS api_budget_waiters(id text PRIMARY KEY,key text NOT NULL,ticket bigserial UNIQUE,expires_at timestamptz NOT NULL)');
  await tx.query('CREATE INDEX IF NOT EXISTS api_budget_waiters_due ON api_budget_waiters(key,ticket)');
 }).catch(e=>{initializations.delete(db);throw e;}));
 await initializations.get(db);
}
// FIFO admission is shared by web and worker. Tickets are demand, never future API slots.
// A stopped process loses its ticket after 30 seconds; a live head renews while waiting.
export async function fairApiBudget(key,{database,maxWaitMs,shouldStop,onProgress},acquire){
 const started=Date.now(),id=randomUUID();let queue,registered=false;
 const remaining=()=>maxWaitMs===Infinity?Infinity:Math.max(0,maxWaitMs-(Date.now()-started));
 async function progress(){
  if(shouldStop())throw Object.assign(Error('Arrêt demandé'),{code:'TEMU_STOPPING'});
  if(database){const renewed=await database.query("UPDATE api_budget_waiters SET expires_at=clock_timestamp()+interval '30 seconds' WHERE id=$1 AND expires_at>clock_timestamp() RETURNING id",[id]);if(!renewed.rows.length)throw deferred(1);}
  await onProgress?.();
 }
 try{
  if(shouldStop())throw Object.assign(Error('Arrêt demandé'),{code:'TEMU_STOPPING'});
  if(database){
   await initialize(database);
   await database.query("INSERT INTO api_budget_waiters(id,key,expires_at) VALUES($1,$2,clock_timestamp()+interval '30 seconds')",[id,key]);registered=true;
  }else{queue=memoryQueues.get(key)||[];memoryQueues.set(key,queue);queue.push(id);registered=true;}
  for(;;){
   await progress();
   const head=database?(await database.query("SELECT id FROM api_budget_waiters WHERE key=$1 AND expires_at>clock_timestamp() ORDER BY ticket LIMIT 1",[key])).rows[0]?.id:queue[0];
   if(head===id)return await acquire({maxWaitMs:remaining(),shouldStop,onProgress:progress});
   if(remaining()<=0){
    const delay=database?Number((await database.query("SELECT greatest(0,extract(epoch FROM(next_at-clock_timestamp()))) AS delay FROM api_budget WHERE key=$1",[key])).rows[0]?.delay)||0:0;
    throw deferred(delay);
   }
   await sleep(Math.min(100,remaining()));
  }
 }finally{
  if(registered&&database)await database.query('DELETE FROM api_budget_waiters WHERE id=$1 OR expires_at<=clock_timestamp()',[id]);
  if(registered&&queue){const index=queue.indexOf(id);if(index>=0)queue.splice(index,1);if(!queue.length)memoryQueues.delete(key);}
 }
}
