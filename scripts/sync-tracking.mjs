import {loadEnvFile} from 'node:process';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {trackingSyncClients} from '../src/tracking-sync-clients.mjs';
import {initializeTrackingSync,saveTrackingObservation,trackingTargetKey} from '../src/tracking-sync-history.mjs';
import {loadTrackingTargets,trackingSyncStore} from '../src/tracking-sync-store.mjs';
import {synchronizeTracking} from '../src/tracking-sync.mjs';
import {configureApiBudget} from '../src/api-budget.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try{loadEnvFile(path.join(root,'.env'));}catch(e){if(e.code!=='ENOENT')throw e;}
const args=process.argv.slice(2);
if(args.includes('--help')){
 console.log('node scripts/sync-tracking.mjs [--apply] [--watch] [--reference=COMMANDE ...] [--carrier=gls|gofo|temu] [--batch-size=N]\nPar défaut : lecture et rapport. --apply : mise à jour V3, puis Erplain. --watch : cycle périodique.\nRequis : DATABASE_URL, accès Erplain et transporteurs dans .env ou CREDENTIALS_DIR.');
 process.exit(0);
}
const references=new Set(args.filter(a=>a.startsWith('--reference=')).map(a=>a.slice('--reference='.length).trim()));
const selectedCarrier=args.find(a=>a.startsWith('--carrier='))?.slice('--carrier='.length);
const batchArg=args.find(a=>a.startsWith('--batch-size='));
const batchSize=batchArg?Number(batchArg.slice('--batch-size='.length)):null;
if(references.has('')||args.some(a=>!['--apply','--watch'].includes(a)&&!['--reference=','--carrier=','--batch-size='].some(prefix=>a.startsWith(prefix)))||
 (selectedCarrier!==undefined&&!['gls','gofo','temu'].includes(selectedCarrier))||
 (batchSize!==null&&(!Number.isInteger(batchSize)||batchSize<1||batchSize>100)))throw Error('Option ou référence invalide. Utiliser --help');
const apply=args.includes('--apply'),watch=args.includes('--watch');
const interval=Number(process.env.TRACKING_SYNC_INTERVAL_SECONDS||1800);
if(!Number.isInteger(interval)||interval<300)throw Error('Intervalle minimal : 300 secondes');
if(!process.env.DATABASE_URL)throw Error('DATABASE_URL requis : utiliser la base PostgreSQL contenant les commandes V3');
if(apply&&(process.env.ERPLAIN_LIVE_WRITES!=='1'||process.env.MIGRATION_PREPARATION==='1'))throw Error('Écritures désactivées : ERPLAIN_LIVE_WRITES=1 requis et MIGRATION_PREPARATION ne doit pas valoir 1');
const directory=path.resolve(process.env.CREDENTIALS_DIR||process.env.DATA_DIR||path.join(root,'data'));
const output=path.resolve(process.env.TRACKING_SYNC_REPORT||path.join(root,'data','tracking-sync-report.json'));
let stopping=false,wake;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;wake?.();});
const {Pool}=await import('pg');
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:3});
let leader;
try{
 leader=await pool.connect();
 if(!(await leader.query("SELECT pg_try_advisory_lock(hashtextextended('nextech:tracking-sync',0)) AS acquired")).rows[0].acquired)throw Error('Un autre processus de synchronisation est actif');
 leader.on('error',()=>{stopping=true;wake?.();});
 const store=trackingSyncStore(leader,{shareLifecycleLock:true});
 configureApiBudget({
  query:(...args)=>pool.query(...args),
  async transaction(fn){
   const client=await pool.connect();
   try{
    await client.query('BEGIN');
    const result=await fn({query:(...args)=>client.query(...args)});
    await client.query('COMMIT');
    return result;
   }catch(error){await client.query('ROLLBACK');throw error;}
   finally{client.release();}
  }
 });
 const historyDb={query:(...args)=>leader.query(...args),exec:sql=>leader.query(sql),transaction:async fn=>{await leader.query('BEGIN');try{const result=await fn(historyDb);await leader.query('COMMIT');return result;}catch(e){await leader.query('ROLLBACK');throw e;}}};
 await leader.query("SELECT pg_advisory_lock(hashtextextended('nextech:schema',0))");
 try{await initializeTrackingSync(historyDb);}finally{await leader.query("SELECT pg_advisory_unlock(hashtextextended('nextech:schema',0))");}
 const clients=trackingSyncClients(directory);
 do{
  let targets=(await loadTrackingTargets(leader)).filter(target=>(!references.size||references.has(target.reference))&&(!selectedCarrier||target.carrier===selectedCarrier));
  if(references.size){
   const missing=[...references].filter(reference=>!targets.some(target=>target.reference===reference));
   if(missing.length)throw Error('Aucune cible de suivi V3 pour : '+missing.join(', '));
  }
  if(batchSize!==null){
   targets=targets.filter(target=>!target.issue&&target.blId&&target.bcId&&(target.carrier==='temu'?target.packages?.length:target.tracking?.length));
   const byKey=new Map(targets.map(target=>[trackingTargetKey(target),target]));
   const {rows}=await leader.query(`SELECT candidate.target_key
    FROM unnest($1::text[],$2::text[]) AS candidate(target_key,bl_id)
    LEFT JOIN document_lifecycle active ON active.bl_id=candidate.bl_id
    LEFT JOIN LATERAL (SELECT created_at,result FROM tracking_sync_observations WHERE target_key=candidate.target_key ORDER BY id DESC LIMIT 1) previous ON true
    WHERE coalesce(active.result->'bl'->>'status','') NOT IN ('delivered','cancelled')
      AND coalesce(previous.result->>'lastKnownErplain','') NOT IN ('delivered','cancelled')
    ORDER BY previous.created_at NULLS FIRST,candidate.target_key LIMIT $3`,[[...byKey.keys()],[...byKey.values()].map(target=>String(target.blId)),batchSize]);
   targets=rows.map(row=>byKey.get(row.target_key));
  }
  const report=await synchronizeTracking({targets,...clients,store,apply,shouldStop:()=>stopping,onRow:(row,target)=>saveTrackingObservation(historyDb,row,target)});
  await mkdir(path.dirname(output),{recursive:true,mode:0o700});
  const temporary=output+'.tmp';
  await writeFile(temporary,JSON.stringify(report,null,2),{mode:0o600});await rename(temporary,output);
  console.log(JSON.stringify({at:report.finishedAt,mode:report.mode,...report.counts,report:output}));
  if(!watch){if(report.counts.error)process.exitCode=1;break;}
  if(!stopping)await new Promise(resolve=>{const timer=setTimeout(resolve,interval*1000);wake=()=>{clearTimeout(timer);resolve();};});
 }while(!stopping);
}finally{
 configureApiBudget(null);
 if(leader){await leader.query("SELECT pg_advisory_unlock(hashtextextended('nextech:tracking-sync',0))").catch(()=>{});leader.release();}
 await pool.end();
}
