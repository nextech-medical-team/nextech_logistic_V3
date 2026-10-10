import {createHash} from 'node:crypto';import {writeFile,stat} from 'node:fs/promises';import {loadEnvFile} from 'node:process';import {fileURLToPath} from 'node:url';import {spawn} from 'node:child_process';
import {shopifyCollector,loadShopifyConfig} from './marketplace-collection.mjs';import {normalizeShopifyOrders} from './marketplace-local-import.mjs';
import {platformHoldDatabaseAdapter} from './platform-shipment-hold-db.mjs';import {platformHoldEvidenceHash,reconcilePlatformShipmentHold} from './platform-shipment-hold-transaction.mjs';import {systemdWriterPauseProbe} from './platform-writer-pause.mjs';
const diagnostic=/^Commande (?:déjà expédiée dans (?:Shopify|Amazon)(?: · Vérifier les documents)?|(?:entièrement remboursée|annulée) dans Shopify(?: · BC et BL Erplain annulés)?)$/i;
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const sorted=rows=>rows.slice().sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
const preserved=e=>({order:Object.fromEntries(Object.entries(e.order).filter(([k])=>!['source_payload','issue','resolution_pending_resume','label_status'].includes(k))),source:Object.fromEntries(Object.entries(e.order.source_payload||{}).filter(([k])=>!['marketplacePendingCorrection','fulfillment_status','updated_at','financial_status','platformStatusObservation','platformHoldReclassification','platformShipmentHoldReconciliation'].includes(k))),related:Object.fromEntries(Object.entries(e.relatedEvidence).map(([k,v])=>[k,Array.isArray(v)?sorted(k==='document_lifecycle'?v.map(l=>Object.fromEntries(Object.entries(l).filter(([key])=>key!=='preparation_revision'))):v):v])),labels:e.labels});
// No worker imports, preparation/resumption, purchase, document or stock APIs.
export async function runPlatformHoldMaintenance({db,collect,pauseProbe,apply=false,save=async()=>{}}){
 const report={at:new Date().toISOString(),apply,externalWrites:0,newJobs:0,labelsTouched:0,rows:[]};
 const lease=await pauseProbe();if(lease?.paused!==true||!lease.epoch)throw Error('Arrêt de tous les écrivains requis');
 const orders=(await db.query("SELECT * FROM orders WHERE NOT archived AND channel='shopify' AND issue IS NOT NULL ORDER BY id")).rows.filter(o=>diagnostic.test(o.issue));
 for(const order of orders){
  let row={orderId:order.id,reference:order.reference};
  try{
   const sourceRead=await collect(order),normalizedIncoming=normalizeShopifyOrders([sourceRead.payload])[0];
   const adapter=platformHoldDatabaseAdapter({sourceRead,normalizedIncoming,pauseProbe});
   const before=await adapter.readLockedEvidence(db,order.id);row.before={order:{source_payload:before.order.source_payload,issue:before.order.issue,resolution_pending_resume:before.order.resolution_pending_resume,label_status:before.order.label_status},lifecycle:before.relatedEvidence.document_lifecycle.map(l=>({bl_id:l.bl_id,preparation_revision:l.preparation_revision}))};
   row.expectedEvidenceHash=platformHoldEvidenceHash(before);report.rows.push(row);await save(report);
   if(!apply){row.status='PLANNED';continue;}
   row.result=await reconcilePlatformShipmentHold(db,{orderId:order.id,expectedEvidenceHash:row.expectedEvidenceHash},adapter);
   const after=await adapter.readLockedEvidence(db,order.id);if(hash(preserved(before))!==hash(preserved(after)))throw Error('Préservation documentaire ou opérationnelle non conforme');
   row.after={sourcePayloadHash:hash(after.order.source_payload),issue:after.order.issue,label_status:after.order.label_status,resolution_pending_resume:after.order.resolution_pending_resume};row.status='PASS';
  }catch(e){row.status='BLOCKED';row.error=String(e.message).slice(0,450);if(!report.rows.includes(row))report.rows.push(row);}
  await save(report);
 }
 const current=await pauseProbe();if(current?.paused!==true||current.epoch!==lease.epoch)throw Error('Arrêt des écrivains perdu pendant la maintenance');
 report.finishedAt=new Date().toISOString();report.status=report.rows.every(r=>r.status==='PASS'||!apply&&r.status==='PLANNED')?'PASS':'BLOCKED';await save(report);return report;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 const args=process.argv.slice(2),value=k=>args[args.indexOf(k)+1];
 if(!args.includes('--section7')||!args.includes('--report')||!args.includes('--writers')||!args.includes('--expected-database'))throw Error('Maintenance réservée à Section7 sous verrou, rapport et inventaire explicites requis');
 const fd=Number(value('--lock-fd'));if(!Number.isInteger(fd)||fd<3)throw Error('Descripteur du verrou de publication requis');
 const [held,target]=await Promise.all([stat('/proc/self/fd/'+fd),stat('/var/lock/nextech-deploy.lock')]);if(held.ino!==target.ino||held.dev!==target.dev)throw Error('Descripteur du verrou différent');
 await new Promise((resolve,reject)=>{const child=spawn('/usr/bin/flock',['-n','-x',String(fd),'true'],{stdio:Array.from({length:fd+1},(_,i)=>i===fd?fd:'ignore')});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Verrou exclusif indisponible')));});
 try{loadEnvFile('/etc/nextech/application.env');}catch(e){if(!process.env.DATABASE_URL)throw e;}
 const url=process.env.DATABASE_URL;if(!url||!/^postgres(?:ql)?:/.test(url)||new URL(url).pathname.slice(1)!==value('--expected-database'))throw Error('Base de production attendue non confirmée');
 const {Pool}=await import('pg');const pool=new Pool({connectionString:url,max:2});
 const db={query:(...a)=>pool.query(...a),transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
 const collector=shopifyCollector(await loadShopifyConfig(process.env.DATA_DIR||'/var/lib/nextech-live'));
 const pauseProbe=systemdWriterPauseProbe({requiredUnits:value('--writers').split(',')});
 const save=report=>writeFile(value('--report'),JSON.stringify(report,null,2),{mode:0o600});
 try{const report=await runPlatformHoldMaintenance({db,pauseProbe,apply:args.includes('--apply'),save,collect:async order=>({payload:await collector.order(order.source_payload.id),checkedAt:new Date().toISOString(),readOnly:true,complete:true,origin:'provider',channel:'shopify',orderId:order.id})});console.log(JSON.stringify({status:report.status,orders:report.rows.length,passed:report.rows.filter(r=>r.status==='PASS').length,blocked:report.rows.filter(r=>r.status==='BLOCKED').length,externalWrites:0,newJobs:0,labelsTouched:0}));if(report.status!=='PASS')process.exitCode=1;}finally{await pool.end();}
}
