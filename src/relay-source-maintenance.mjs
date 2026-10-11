import {marketplaceContentFrozen} from './marketplace-content-freeze.mjs';
import {createHash,randomUUID} from 'node:crypto';import {open,rename,unlink,readFile,stat,realpath} from 'node:fs/promises';import {dirname} from 'node:path';import {loadEnvFile} from 'node:process';import {fileURLToPath} from 'node:url';import {spawn} from 'node:child_process';
import {shopifyCollector,loadShopifyConfig} from './marketplace-collection.mjs';import {normalizeShopifyOrders} from './marketplace-local-import.mjs';
import {readShopifyRelay} from './shopify-relay-source.mjs';
import {createProductionCarriers} from './carriers-test.mjs';
import {planRelaySourceReconciliation} from './relay-source-reconciliation.mjs';
import {platformHoldDatabaseAdapter} from './platform-shipment-hold-db.mjs';import {platformHoldEvidenceHash,reconcileRelaySourceHold,platformHoldWriteLockSql} from './relay-source-transaction.mjs';import {systemdWriterPauseProbe} from './platform-writer-pause.mjs';
const diagnostic=/Relais GLS/i;
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const sorted=rows=>rows.slice().sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
const preserved=e=>({order:Object.fromEntries(Object.entries(e.order).filter(([k])=>!['source_payload','issue','resolution_pending_resume','label_status'].includes(k))),source:Object.fromEntries(Object.entries(e.order.source_payload||{}).filter(([k])=>!['marketplacePendingCorrection','fulfillment_status','updated_at','financial_status','platformStatusObservation','platformHoldReclassification','platformShipmentHoldReconciliation','shopifyRelay','shopifyDeliveryMode','relaySourceReconciliation'].includes(k))),related:Object.fromEntries(Object.entries(e.relatedEvidence).map(([k,v])=>[k,Array.isArray(v)?sorted(k==='document_lifecycle'?v.map(l=>Object.fromEntries(Object.entries(l).filter(([key])=>key!=='preparation_revision'))):v):v])),labels:e.labels.map(({parcelShopId,...l})=>l)});
const lifecycle=e=>sorted(e.relatedEvidence.document_lifecycle.map(l=>({bl_id:l.bl_id,preparation_revision:l.preparation_revision})));
const technicalSnapshot=e=>({sourcePayloadHash:hash(e.order.source_payload),preservedHash:hash(preserved(e)),issue:e.order.issue,label_status:e.order.label_status,resolution_pending_resume:e.order.resolution_pending_resume,lifecycle:lifecycle(e)});
export async function savePlatformMaintenanceReport(file,report){
 const temporary=file+'.'+randomUUID()+'.tmp';let handle;
 try{
  handle=await open(temporary,'wx',0o600);await handle.writeFile(JSON.stringify(report,null,2));await handle.sync();await handle.close();handle=undefined;
  await rename(temporary,file);
  if(process.platform!=='win32'){const directory=await open(dirname(file),'r');try{await directory.sync();}finally{await directory.close();}}
 }finally{if(handle)await handle.close();await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
// No worker imports, preparation/resumption, purchase, document or stock APIs.
export async function runRelaySourceMaintenance({db,collect,nearestProof=async()=>null,labelProof=[],pauseProbe,apply=false,save=async()=>{}}){
 const report={at:new Date().toISOString(),apply,externalWrites:0,newJobs:0,labelsTouched:0,rows:[]};
 const lease=await pauseProbe();if(lease?.paused!==true||!lease.epoch)throw Error('Arrêt de tous les écrivains requis');
 const orders=(await db.query("SELECT * FROM orders WHERE NOT archived AND channel='shopify' AND label_status <> 'cancelled' ORDER BY id")).rows.filter(o=>o.source_payload?.shopifyDeliveryMode==='relay'||diagnostic.test(o.delivery_mode||o.carrier_service||'')||o.source_payload?.shipping_lines?.some(l=>diagnostic.test(l.title||l.code||'')));
 for(const order of orders){
  if(marketplaceContentFrozen(order)){report.rows.push({orderId:order.id,reference:order.reference,status:'EXCLUDED',reason:'BC rempli · Contenu plateforme figé'});continue;}
  let row={orderId:order.id,reference:order.reference};
  if(order.suspension?.active||order.suspension?.erplainCancellation){row.status='EXCLUDED';row.reason='Suspension humaine conservée';report.rows.push(row);continue;}
  try{
   const sourceRead=await collect(order),normalizedIncoming=normalizeShopifyOrders([sourceRead.payload])[0];
   const base=platformHoldDatabaseAdapter({sourceRead,normalizedIncoming,pauseProbe});
   const nearest=await nearestProof(order,sourceRead);
   const adapter={...base,readLockedEvidence:async(...a)=>{const evidence=await base.readLockedEvidence(...a);return {...evidence,nearestProof:nearest,labels:evidence.labels.map(l=>({...l,parcelShopId:labelProof.find(p=>p.orderId===order.id&&p.sha256===l.sha256)?.parcelShopId}))};}};
   const before=await adapter.readLockedEvidence(db,order.id);row.before={order:{source_payload:before.order.source_payload,issue:before.order.issue,resolution_pending_resume:before.order.resolution_pending_resume,label_status:before.order.label_status},lifecycle:lifecycle(before),snapshot:technicalSnapshot(before)};
   row.expectedEvidenceHash=platformHoldEvidenceHash(before);report.rows.push(row);await save(report);
   if(!apply){const plan=planRelaySourceReconciliation(before);row.status=plan.eligible?'PLANNED':'BLOCKED';row.classification=plan.classification;row.error=plan.reason;continue;}
   // Mutate, verify preservation and persist a recoverable journal BEFORE COMMIT.
   // Reconcile uses this same transaction; no nested independent commit is possible.
   row.result=await db.transaction(async tx=>{
    const result=await reconcileRelaySourceHold({transaction:fn=>fn(tx)},{orderId:order.id,expectedEvidenceHash:row.expectedEvidenceHash},adapter);
    const after=await adapter.readLockedEvidence(tx,order.id);if(hash(preserved(before))!==hash(preserved(after)))throw Error('Préservation documentaire ou opérationnelle non conforme');
    row.after=technicalSnapshot(after);row.result=result;row.commitState='prepared';row.status='COMMIT_PENDING';await save(report);
    const current=await pauseProbe();if(current?.paused!==true||current.epoch!==lease.epoch)throw Error('Arrêt des écrivains perdu avant commit');
    return result;
   });
   row.commitState='committed';row.status='PASS';
  }catch(e){row.status='BLOCKED';row.error=String(e.message).slice(0,450);if(!report.rows.includes(row))report.rows.push(row);}
  await save(report);
 }
 const current=await pauseProbe();if(current?.paused!==true||current.epoch!==lease.epoch)throw Error('Arrêt des écrivains perdu pendant la maintenance');
 report.finishedAt=new Date().toISOString();report.status=report.rows.every(r=>r.status==='PASS'||r.status==='EXCLUDED'||!apply&&r.status==='PLANNED')?'PASS':'BLOCKED';await save(report);return report;
}
export async function rollbackRelaySourceMaintenance({db,pauseProbe,report}){
 if(report?.apply!==true||!Array.isArray(report.rows))throw Error('Rapport de maintenance appliquée requis');
 const lease=await pauseProbe();if(lease?.paused!==true||!lease.epoch)throw Error('Arrêt des écrivains requis pour le retour arrière');
 const adapter=platformHoldDatabaseAdapter({pauseProbe});
 return db.transaction(async tx=>{
  await tx.query(platformHoldWriteLockSql);let restored=0,uncommitted=0;
  for(const row of report.rows.filter(r=>r.status==='PASS'||['prepared','committed'].includes(r.commitState))){
   if(!row.before?.order||!row.after?.preservedHash)throw Error('Sauvegarde technique incomplète');
   const current=await adapter.readLockedEvidence(tx,row.orderId);
   // An uncertain COMMIT can leave either the verified after-state or the exact
   // original state. Restore only the former; never silently skip a changed row.
   if(row.before.snapshot&&hash(technicalSnapshot(current))===hash(row.before.snapshot)){uncommitted++;continue;}
   if(hash(current.order.source_payload)!==row.after.sourcePayloadHash||hash(preserved(current))!==row.after.preservedHash||current.order.issue!==row.after.issue||current.order.label_status!==row.after.label_status||current.order.resolution_pending_resume!==row.after.resolution_pending_resume||hash(lifecycle(current))!==hash(sorted(row.after.lifecycle)))throw Error('Commande modifiée depuis la maintenance : retour arrière refusé');
   const old=row.before.order;await tx.query('UPDATE orders SET source_payload=$2,issue=$3,resolution_pending_resume=$4,label_status=$5 WHERE id=$1',[row.orderId,JSON.stringify(old.source_payload),old.issue,old.resolution_pending_resume,old.label_status]);
   for(const life of row.before.lifecycle)await tx.query('UPDATE document_lifecycle SET preparation_revision=$2 WHERE bl_id=$1',[life.bl_id,life.preparation_revision]);restored++;
  }
  const current=await pauseProbe();if(current?.paused!==true||current.epoch!==lease.epoch)throw Error('Arrêt des écrivains perdu');
  return {status:'PASS',restored,uncommitted,externalWrites:0,newJobs:0,labelsTouched:0};
 });
}
export async function isPlatformMaintenanceEntry(url,argument=process.argv[1]){
 if(!argument||!url.startsWith('file:'))return false;
 try{return await realpath(fileURLToPath(url))===await realpath(argument);}catch(e){if(e.code==='ENOENT')return false;throw e;}
}
export function assertPlatformMaintenanceDatabase(url,expected,Client){
 if(!url||!/^postgres(?:ql)?:/.test(url)||typeof Client!=='function')throw Error('Base de production attendue non confirmée');
 // Use the driver's parser: a valid Unix-socket DSN has an empty hostname and
 // is rejected by WHATWG URL even though PostgreSQL accepts it.
 const database=new Client({connectionString:url}).connectionParameters.database;
 if(!expected||database!==expected)throw Error('Base de production attendue non confirmée');
 return database;
}
export async function assertPlatformMaintenanceLock(fd,targetPath='/var/lock/nextech-deploy.lock'){
 if(!Number.isInteger(fd)||fd<3)throw Error('Descripteur du verrou de publication requis');
 const [held,target]=await Promise.all([stat('/proc/self/fd/'+fd),stat(targetPath)]);if(held.ino!==target.ino||held.dev!==target.dev)throw Error('Descripteur du verrou différent');
 await new Promise((resolve,reject)=>{const child=spawn('/usr/bin/flock',['-n','-x',String(fd)],{stdio:Array.from({length:fd+1},(_,i)=>i===fd?fd:'ignore')});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Verrou exclusif indisponible')));});
}
if(await isPlatformMaintenanceEntry(import.meta.url)){
 const args=process.argv.slice(2),value=k=>args[args.indexOf(k)+1];
 if(!args.includes('--section7')||!args.includes('--report')||!args.includes('--writers')||!args.includes('--expected-database'))throw Error('Maintenance réservée à Section7 sous verrou, rapport et inventaire explicites requis');
 await assertPlatformMaintenanceLock(Number(value('--lock-fd')));
 try{loadEnvFile('/etc/nextech/application.env');}catch(e){if(!process.env.DATABASE_URL)throw e;}
 const url=process.env.DATABASE_URL;const {Pool,Client}=await import('pg');assertPlatformMaintenanceDatabase(url,value('--expected-database'),Client);
 const pool=new Pool({connectionString:url,max:2});
 const db={query:(...a)=>pool.query(...a),transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
 const pauseProbe=systemdWriterPauseProbe({requiredUnits:value('--writers').split(',')});
 const save=report=>savePlatformMaintenanceReport(value('--report'),report);
 try{
  if(args.includes('--rollback-from')){const result=await rollbackRelaySourceMaintenance({db,pauseProbe,report:JSON.parse(await readFile(value('--rollback-from'),'utf8'))});await save(result);console.log(JSON.stringify(result));}
  else{const directory=process.env.DATA_DIR||'/var/lib/nextech-live';
   const collector=shopifyCollector(await loadShopifyConfig(directory));
   if(!args.includes('--label-proof'))throw Error('Preuves des PDF existants requises');
   const labelProof=JSON.parse(await readFile(value('--label-proof'),'utf8'));
   if(!Array.isArray(labelProof)||labelProof.some(p=>!p.orderId||!/^[a-f0-9]{64}$/.test(p.sha256)||!/^GLS_[A-Z]{2}-[A-Za-z0-9]+$/.test(p.parcelShopId)))throw Error('Preuves PDF invalides');
   const client=createProductionCarriers(JSON.parse(await readFile(directory+'/carriers-production.json','utf8')),{shopifyReader:collector,fetchImpl:async(u,o)=>{if(!u.endsWith('/oauth2/v2/token')&&!u.endsWith('/parcelshop/address'))throw Error('Écriture transporteur interdite en maintenance');return fetch(u,o);}});
   const nearestProof=async(order,sourceRead)=>{const relay=readShopifyRelay(sourceRead.payload);if(!relay||relay.selectedId)return null;return client.resolveParcelShop({channel:'audit',address:relay.clientAddress,source_payload:{}});};
   const report=await runRelaySourceMaintenance({db,pauseProbe,labelProof,nearestProof,apply:args.includes('--apply'),save,collect:async order=>({payload:await collector.order(order.source_payload.id),checkedAt:new Date().toISOString(),readOnly:true,complete:true,origin:'provider',channel:'shopify',orderId:order.id})});console.log(JSON.stringify({status:report.status,orders:report.rows.length,passed:report.rows.filter(r=>r.status==='PASS').length,blocked:report.rows.filter(r=>r.status==='BLOCKED').length,externalWrites:0,newJobs:0,labelsTouched:0}));if(report.status!=='PASS')process.exitCode=1;}
 }finally{await pool.end();}
}
