import {randomUUID} from 'node:crypto';
const kinds=new Set(['catalog','weights','stocks']);
export async function initializeReadServiceJobs(db){await db.exec("CREATE TABLE IF NOT EXISTS read_service_jobs(id text PRIMARY KEY,kind text NOT NULL,status text NOT NULL DEFAULT 'queued',requested_by text NOT NULL,state jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());CREATE UNIQUE INDEX IF NOT EXISTS read_service_active ON read_service_jobs(kind) WHERE status IN ('queued','running');");if(db.recoverInterrupted!==false)await db.query("UPDATE read_service_jobs SET status='queued',updated_at=now() WHERE status='running'");}
export function readServiceJobs(db,handlers={},{enabled=()=>true}={}){
 let running=false;
 return {
  get running(){return running;},
  async enqueue(kind,user='system'){
   if(!kinds.has(kind))throw Error('Lecture non autorisée');const id=randomUUID();
   const r=await db.query("INSERT INTO read_service_jobs(id,kind,requested_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id",[id,kind,user]);
   const selected=r.rows[0]||(await db.query("SELECT id FROM read_service_jobs WHERE kind=$1 AND status IN ('queued','running')",[kind])).rows[0];if(!selected)throw Error('Lecture à relancer');return {id:selected.id,running:true,queued:true};
  },
  async snapshot(kind,fallback){const row=(await db.query('SELECT status,state FROM read_service_jobs WHERE kind=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[kind])).rows[0];const base=await fallback();return row?{...base,...row.state,running:['queued','running'].includes(row.status),queued:row.status==='queued'}:base;},
  async run(){if(running)return;running=true;let job,timer,saves=Promise.resolve();try{
   job=await db.transaction(async tx=>{const allowed=[...kinds].filter(enabled);if(!allowed.length)return null;const r=(await tx.query("SELECT * FROM read_service_jobs WHERE status='queued' AND kind=ANY($1::text[]) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",[allowed])).rows[0];if(r)await tx.query("UPDATE read_service_jobs SET status='running',updated_at=now() WHERE id=$1",[r.id]);return r;});if(!job)return;
   const service=handlers[job.kind];if(!service)throw Error('Service de lecture non configuré');
   timer=setInterval(()=>{saves=saves.then(async()=>db.query('UPDATE read_service_jobs SET state=$2,updated_at=now() WHERE id=$1',[job.id,JSON.stringify(await service.status())]));saves.catch(()=>{});},2000);timer.unref();
   await service.start();await service.wait();clearInterval(timer);await saves;const state=await service.status();await db.query('UPDATE read_service_jobs SET status=$2,state=$3,updated_at=now() WHERE id=$1',[job.id,state.error?'failed':'complete',JSON.stringify(state)]);
  }catch(e){clearInterval(timer);await saves.catch(()=>{});if(job)await db.query("UPDATE read_service_jobs SET status='failed',state=$2,updated_at=now() WHERE id=$1",[job.id,JSON.stringify({running:false,error:e.message})]);else throw e;}finally{running=false;}}
 };
}
