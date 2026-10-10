import {loadEnvFile} from 'node:process';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {trackingSyncClients} from '../src/tracking-sync-clients.mjs';
import {initializeTrackingSync,saveTrackingObservation} from '../src/tracking-sync-history.mjs';
import {loadTrackingTargets,trackingSyncStore} from '../src/tracking-sync-store.mjs';
import {synchronizeTracking} from '../src/tracking-sync.mjs';
import {configureApiBudget} from '../src/api-budget.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try{loadEnvFile(path.join(root,'.env'));}catch(e){if(e.code!=='ENOENT')throw e;}
const args=process.argv.slice(2);
if(args.includes('--help')){
 console.log('node scripts/sync-tracking.mjs [--apply] [--watch]\nPar défaut : lecture et rapport. --apply : mise à jour des statuts BL. --watch : cycle périodique.\nRequis : DATABASE_URL, accès Erplain et transporteurs dans .env ou CREDENTIALS_DIR.');
 process.exit(0);
}
if(args.some(a=>!['--apply','--watch'].includes(a)))throw Error('Option inconnue ; utiliser --help');
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
 const store=trackingSyncStore(leader);
 configureApiBudget(pool);
 const historyDb={query:(...args)=>leader.query(...args),exec:sql=>leader.query(sql),transaction:async fn=>{await leader.query('BEGIN');try{const result=await fn(historyDb);await leader.query('COMMIT');return result;}catch(e){await leader.query('ROLLBACK');throw e;}}};
 await leader.query("SELECT pg_advisory_lock(hashtextextended('nextech:schema',0))");
 try{await initializeTrackingSync(historyDb);}finally{await leader.query("SELECT pg_advisory_unlock(hashtextextended('nextech:schema',0))");}
 do{
  if(apply){
   const controls=(await leader.query("SELECT value FROM settings WHERE key='background_tasks'")).rows[0]?.value||{};
   if(controls.lifecycle!==false)throw Error('Désactiver le traitement V3 « lifecycle » avant ce processus dédié : il inclut aussi facturation et paiements');
  }
  const report=await synchronizeTracking({targets:await loadTrackingTargets(leader),...trackingSyncClients(directory),store,apply,shouldStop:()=>stopping,onRow:(row,target)=>saveTrackingObservation(historyDb,row,target)});
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
