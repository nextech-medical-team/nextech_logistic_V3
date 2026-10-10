// Trusted Section 7 deployment helper; installed from the reviewed bootstrap.
import fs from 'node:fs';
import path from 'node:path';
import pg from '/opt/nextech/current/node_modules/pg/lib/index.js';
import {backgroundTasks} from '/opt/nextech/current/src/background-controls.mjs';
const [action,backup]=process.argv.slice(2);
if(!['pause','check','resume'].includes(action)||!/^cicd-[a-f0-9]{40}-\d+$/.test(path.basename(backup||'')))throw Error('Arguments invalides');
const file='/var/lib/nextech-live/'+path.basename(backup)+'-controls.json';
const db=new pg.Client({host:'/var/run/postgresql',user:'nextech',database:'nextech_v3_migration'});
await db.connect();
try{
 if(action==='check'){
  const observation='/var/lib/nextech-live/temu-reading-observation.json';
  if(fs.existsSync(observation)&&JSON.parse(fs.readFileSync(observation)).running)throw Error('Lecture TEMU active');
  await db.query('BEGIN READ ONLY');
  const result=await db.query("SELECT (SELECT count(*)::int FROM purchase_jobs WHERE status='creating') purchases,(SELECT count(*)::int FROM temu_label_jobs WHERE status IN ('purchasing','buying','quoting')) temu,(SELECT count(*)::int FROM resolution_jobs WHERE status='running') resolutions,(SELECT count(*)::int FROM carrier_jobs WHERE status='creating') carriers,(SELECT count(*)::int FROM extra_parcels WHERE status='creating') extras,(SELECT count(*)::int FROM erp_live_jobs WHERE status='processing') erplain,(SELECT count(*)::int FROM partial_deliveries WHERE status IN ('creating_bl','publishing_bl','creating_stock','creating_label')) partials");
  const health=await db.query("SELECT count(*)::int n FROM worker_health w CROSS JOIN LATERAL jsonb_array_elements(w.state->'tasks') t WHERE heartbeat>now()-interval '30 seconds' AND t->>'running'='true'");
  if(Object.values(result.rows[0]).some(n=>n>0)||health.rows[0].n>0)throw Error('Traitements actifs');
  await db.query('ROLLBACK');
 }else{
  await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(712761)');
  const current=(await db.query("SELECT value FROM settings WHERE key='background_tasks' FOR UPDATE")).rows[0]?.value||{};
  if(action==='pause'){
   if(fs.existsSync(file))throw Error('Pause existante');
   const keys=[...new Set([...backgroundTasks,...Object.keys(current),'erplain-interrupted-recovery','v2-followup'])];
   fs.writeFileSync(file,JSON.stringify({saved:current,keys}),{mode:0o600,flag:'wx'});
   await db.query("INSERT INTO settings(key,value) VALUES('background_tasks',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[JSON.stringify({...current,...Object.fromEntries(keys.map(k=>[k,false]))})]);
  }else{
   if(!fs.existsSync(file))throw Error('Snapshot des contrôles absent');
   const {saved,keys}=JSON.parse(fs.readFileSync(file));const restored={...current};
   // Preserve a human modification made during the drain.
   for(const k of keys)if(current[k]===false){if(Object.hasOwn(saved,k))restored[k]=saved[k];else delete restored[k];}
   await db.query("UPDATE settings SET value=$1 WHERE key='background_tasks'",[JSON.stringify(restored)]);
  }
  await db.query('COMMIT');
  if(action==='resume')fs.renameSync(file,file+'.restored');
 }
 console.log(JSON.stringify({action,status:'PASS'}));
}catch(error){await db.query('ROLLBACK').catch(()=>{});console.error('Contrôle de déploiement non satisfait');process.exitCode=43;}
finally{await db.end();}
