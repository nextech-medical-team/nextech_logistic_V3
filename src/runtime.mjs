import {randomUUID} from 'node:crypto';
import {withErplainTraffic,erplainTaskTraffic} from './erplain-admission.mjs';
import {monitorEventLoopDelay} from 'node:perf_hooks';

export function runtimeConfig(env=process.env){
 const role=env.APP_ROLE||'all';if(!['all','web','worker'].includes(role))throw Error('APP_ROLE invalide');
 if(role!=='all'&&!env.DATABASE_URL)throw Error('Les processus séparés nécessitent PostgreSQL via DATABASE_URL');
 const port=Number(env.PORT||4317);if(!Number.isInteger(port)||port<1||port>65535)throw Error('PORT invalide');
 const origin=new URL(env.PUBLIC_ORIGIN||`http://127.0.0.1:${port}`);
 if(origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)throw Error('PUBLIC_ORIGIN doit être une origine sans chemin');
 const local=['127.0.0.1','localhost'].includes(origin.hostname);
 if(!local&&origin.protocol!=='https:')throw Error('HTTPS requis pour une adresse publique');
 if(!local&&!env.DATABASE_URL)throw Error('PostgreSQL requis pour une exploitation publique');
 return {role,port,host:env.BIND_HOST||'127.0.0.1',origin:origin.origin,secure:origin.protocol==='https:',background:env.MIGRATION_PREPARATION!=='1'&&role!=='web',http:role!=='worker',hosts:new Set([origin.host,`127.0.0.1:${port}`,`localhost:${port}`]),origins:new Set(local?[origin.origin,`http://localhost:${port}`,`http://127.0.0.1:${port}`]:[origin.origin])};
}

export async function initializeOperations(db){
 await db.exec(`CREATE TABLE IF NOT EXISTS worker_health(id TEXT PRIMARY KEY,role TEXT NOT NULL,heartbeat TIMESTAMPTZ NOT NULL DEFAULT now(),state JSONB NOT NULL DEFAULT '{}');
 CREATE TABLE IF NOT EXISTS api_budget(key TEXT PRIMARY KEY,next_at TIMESTAMPTZ NOT NULL);
 CREATE TABLE IF NOT EXISTS operational_events(id BIGSERIAL PRIMARY KEY,topic TEXT NOT NULL,record_id TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS operational_events_created ON operational_events(created_at);
 CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
}

export function createRuntime(db,{role='all',logger=console}={}){
 const id=randomUUID(),tasks=new Map(),delay=monitorEventLoopDelay({resolution:20});let stopping=false,stopped=false,heartbeat,controls={};
 delay.enable();
 async function report(){controls=(await db.query("SELECT value FROM settings WHERE key='background_tasks'")).rows[0]?.value||{};const state={stopping,eventLoopP95Ms:Number.isFinite(delay.percentile(95))?Math.round(delay.percentile(95)/1e6):0,memoryMb:Math.round(process.memoryUsage().rss/1048576),tasks:[...tasks.values()].map(t=>({name:t.name,enabled:controls[t.name]!==false,running:t.running,lastSuccess:t.lastSuccess,error:t.error,failures:t.failures}))};await db.query('INSERT INTO worker_health(id,role,state) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET heartbeat=now(),state=excluded.state',[id,role,JSON.stringify(state)]);}
 function schedule(name,fn,interval){if(tasks.has(name))throw Error('Traitement déjà enregistré : '+name);const t={name,running:false,failures:0,lastSuccess:null,error:null,promise:null};tasks.set(name,t);t.tick=()=>{if(stopping||t.running||controls[name]===false)return;t.running=true;t.promise=Promise.resolve().then(()=>withErplainTraffic(erplainTaskTraffic(name),fn)).then(()=>{t.lastSuccess=new Date().toISOString();t.error=null;},e=>{t.failures++;t.error='Traitement en échec ; consulter le diagnostic dédié';logger.error(JSON.stringify({event:'worker.task_failed',task:name,code:e?.code||'TASK_ERROR'}));}).finally(()=>{t.running=false;});return t.promise;};t.timer=setInterval(t.tick,interval);t.timer.unref();return t.timer;}
 return {id,schedule,get stopping(){return stopping;},beginStop(){stopping=true;for(const t of tasks.values())clearInterval(t.timer);},enabled:name=>controls[name]!==false,async start(){await report();heartbeat=setInterval(()=>report().catch(()=>logger.error('Échec de publication de santé')),5000);if(role!=='worker')heartbeat.unref();},async stop(){if(stopped)return;stopped=true;stopping=true;clearInterval(heartbeat);for(const t of tasks.values())clearInterval(t.timer);await Promise.all([...tasks.values()].map(t=>t.promise).filter(Boolean));delay.disable();await db.query('DELETE FROM worker_health WHERE id=$1',[id]);},get tasks(){return tasks;}};
}
