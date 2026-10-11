let database=null;
const tails=new Map();
const available=new Map();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function configureApiBudget(db){database=db;}
// Claim only when due: queued callers must recheck a newly imposed cooldown.
// Do not reserve future slots, which would bypass a later 429 response.
export async function apiAcquireSlot(key,intervalMs=1600,{maxWaitMs=Infinity,shouldStop=()=>false}={}){
 if(!Number.isInteger(intervalMs)||intervalMs<1||intervalMs>2147483647)throw Error('Intervalle API invalide');
 if(maxWaitMs!==Infinity&&(!Number.isFinite(maxWaitMs)||maxWaitMs<0))throw Error('Attente API invalide');
 const started=Date.now();
 const wait=async delay=>{if(delay>maxWaitMs-(Date.now()-started))throw Object.assign(Error('Quota partagé : lecture différée'),{code:'source_budget_deferred',retryAfter:String(Math.ceil(delay/1000))});await sleep(Math.min(1000,delay));};
 for(;;){
  if(shouldStop())throw Object.assign(Error('Arrêt demandé'),{code:'TEMU_STOPPING'});
  if(database){
   const claimed=await database.query(`INSERT INTO api_budget(key,next_at) VALUES($1,clock_timestamp()+($2::int*interval '1 millisecond')) ON CONFLICT(key) DO UPDATE SET next_at=clock_timestamp()+($2::int*interval '1 millisecond') WHERE api_budget.next_at<=clock_timestamp() RETURNING key`,[key,intervalMs]);
   if(claimed.rows.length)return;
   const r=(await database.query(`SELECT greatest(1,extract(epoch FROM (next_at-clock_timestamp()))*1000) AS delay FROM api_budget WHERE key=$1`,[key])).rows[0];
   await wait(Math.max(1,Number(r?.delay)||1));
  }else{
   const now=Date.now(),delay=(available.get(key)||0)-now;
   if(delay<=0){available.set(key,now+intervalMs);return;}
   await wait(delay);
  }
 }
}
export async function apiDefer(key,delayMs){
 if(!Number.isFinite(delayMs)||delayMs<0)throw Error('Délai API invalide');
 if(database)await database.query(`INSERT INTO api_budget(key,next_at) VALUES($1,clock_timestamp()+($2::double precision*interval '1 millisecond')) ON CONFLICT(key) DO UPDATE SET next_at=greatest(api_budget.next_at,EXCLUDED.next_at)`,[key,delayMs]);
 else available.set(key,Math.max(available.get(key)||0,Date.now()+delayMs));
}
export async function apiSlot(key,intervalMs=1600){
 if(database){const r=(await database.query(`INSERT INTO api_budget(key,next_at) VALUES($1,now()+($2::int*interval '1 millisecond')) ON CONFLICT(key) DO UPDATE SET next_at=greatest(api_budget.next_at,now())+($2::int*interval '1 millisecond') RETURNING greatest(0,extract(epoch FROM (next_at-now()))*1000-$2::int) AS delay`,[key,intervalMs])).rows[0];await new Promise(resolve=>setTimeout(resolve,Number(r.delay)));return;}
 const prior=tails.get(key)||Promise.resolve();const next=prior.catch(()=>{}).then(()=>new Promise(r=>setTimeout(r,intervalMs)));tails.set(key,next);await next;if(tails.get(key)===next)tails.delete(key);
}
