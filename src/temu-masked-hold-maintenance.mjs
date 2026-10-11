import {createHash} from 'node:crypto';import {readFile} from 'node:fs/promises';import {loadEnvFile} from 'node:process';
import {platformHoldDatabaseAdapter} from './platform-shipment-hold-db.mjs';
import {platformLifecycleRevisionSql} from './platform-lifecycle-revision.mjs';
import {platformHoldWriteLockSql} from './relay-source-transaction.mjs';
import {planMaskedTemuHold,evidenceHash,genericModificationReason} from './temu-masked-hold-plan.mjs';
import {savePlatformMaintenanceReport,isPlatformMaintenanceEntry,assertPlatformMaintenanceLock,assertPlatformMaintenanceDatabase} from './relay-source-maintenance.mjs';
import {systemdWriterPauseProbe} from './platform-writer-pause.mjs';
import {maskedTemuSourceReader} from './temu-masked-hold-reader.mjs';
const active=['queued','pending','running','processing','waiting'];
const lockSql=platformHoldWriteLockSql.replace('temu_label_jobs IN','temu_label_jobs,temu_label_documents IN');
const preserved=e=>({source:Object.fromEntries(Object.entries(e.order.source_payload||{}).filter(([k])=>!['marketplacePendingCorrection','platformChangeReconciliation'].includes(k))),order:Object.fromEntries(Object.entries(e.order).filter(([k])=>!['source_payload','issue','resolution_pending_resume','label_status'].includes(k))),related:Object.fromEntries(Object.entries(e.relatedEvidence).map(([k,v])=>[k,k==='document_lifecycle'?v.map(({preparation_revision,...rest})=>rest):v])),temuJob:e.temuJob,temuDocuments:e.temuDocuments});
export function maskedTemuDatabaseAdapter({sourceRead,pauseProbe}){
 const base=platformHoldDatabaseAdapter({sourceRead,pauseProbe});
 return {...base,async readLockedEvidence(tx,id){const e=await base.readLockedEvidence(tx,id);
  const job=(await tx.query('SELECT * FROM temu_label_jobs WHERE reference=$1 FOR UPDATE',[e.order.reference])).rows[0];
  const docs=(await tx.query('SELECT * FROM temu_label_documents WHERE reference=$1 ORDER BY package FOR UPDATE',[e.order.reference])).rows.map(({pdf,...rest})=>({...rest,bytes:pdf?.length||0,pdfValid:!!pdf&&Buffer.from(pdf).subarray(0,5).toString()==='%PDF-',sha256:pdf?createHash('sha256').update(pdf).digest('hex'):null}));
  const rows=e.relatedEvidence,latest=new Map();for(const j of [...rows.resolution_jobs].sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))))if(!latest.has(j.action))latest.set(j.action,j);
  const errors=[...e.erpJobs,...e.carrierJobs,...latest.values(),...rows.correction_jobs].filter(j=>j.error&&j.status!=='complete').map(j=>j.error);
  if(rows.extra_parcels.length||rows.partial_deliveries.length)errors.push('Colis supplémentaire ou livraison partielle : rapprochement dédié requis');
  return {...e,temuJob:job,temuDocuments:docs,lifecycle:rows.document_lifecycle,otherErrors:errors,activeJobs:[...rows.resolution_jobs,...rows.correction_jobs,...e.erpJobs,...e.carrierJobs].filter(j=>active.includes(j.status))};
 },async pinLifecycleRevision(tx,id){const rows=(await tx.query('SELECT * FROM document_lifecycle WHERE order_id=$1 FOR UPDATE',[id])).rows;
  const o=(await tx.query('SELECT * FROM orders WHERE id=$1',[id])).rows[0];if(!rows.length||rows.some(l=>l.locked||l.requested)||!rows.some(l=>String(l.bl_id)===String(o.erp_live?.bl?.id)))throw Error('Contrôle documentaire actif ou incomplet');
  const revisions=(await tx.query(platformLifecycleRevisionSql,[id])).rows;if(revisions.length!==rows.length)throw Error('Révisions documentaires incomplètes');for(const r of revisions)await tx.query('UPDATE document_lifecycle SET preparation_revision=$2 WHERE bl_id=$1',[r.bl_id,r.revision]);
  return {processingRequested:false,allDocumentsCovered:true,errorsPreserved:true};
 }};
}
export async function runMaskedTemuMaintenance({db,collect,pauseProbe,apply=false,save=async()=>{}}){
 const lease=await pauseProbe();if(lease?.paused!==true||!lease.epoch)throw Error('Maintenance réservée à Section7, tous les écrivains arrêtés');
 const assertLease=async()=>{const p=await pauseProbe();if(p?.paused!==true||p.epoch!==lease.epoch)throw Error('Pause des écrivains perdue');};
 const report={at:new Date().toISOString(),apply,externalWrites:0,newJobs:0,labelsTouched:0,rows:[]};
 const orders=(await db.query("SELECT * FROM orders WHERE channel='temu' AND NOT archived AND label_status<>'cancelled' AND source_payload ? 'marketplacePendingCorrection' ORDER BY id")).rows.filter(o=>genericModificationReason(o.issue));
 for(const order of orders){const row={orderId:order.id,reference:order.reference};report.rows.push(row);try{await assertLease();const sourceRead=await collect(order),adapter=maskedTemuDatabaseAdapter({sourceRead,pauseProbe});
  await db.transaction(async tx=>{await tx.query(lockSql);const before=await adapter.readLockedEvidence(tx,order.id),plan=planMaskedTemuHold(before);row.classification=plan.classification;row.reason=plan.reason;
   if(!plan.eligible){row.status='BLOCKED';return;}
   row.before={source_payload:before.order.source_payload,issue:before.order.issue,label_status:before.order.label_status,resolution_pending_resume:before.order.resolution_pending_resume,lifecycle:before.lifecycle.map(l=>({bl_id:l.bl_id,preparation_revision:l.preparation_revision}))};row.preservedHash=evidenceHash(preserved(before));
   if(!apply){row.status='PLANNED';return;}
   row.status='PREPARED';await save(report);await assertLease();const p=plan.technicalPatch;
   await tx.query('UPDATE orders SET source_payload=$2,issue=$3,resolution_pending_resume=$4,label_status=$5 WHERE id=$1',[order.id,JSON.stringify(p.source_payload),p.issue,p.resolution_pending_resume,p.label_status]);await adapter.pinLifecycleRevision(tx,order.id);
   const after=await adapter.readLockedEvidence(tx,order.id);if(evidenceHash(preserved(after))!==row.preservedHash)throw Error('Documents ou historique modifiés : transaction annulée');row.after={source_payload:after.order.source_payload,issue:after.order.issue,label_status:after.order.label_status,resolution_pending_resume:after.order.resolution_pending_resume,lifecycle:after.lifecycle.map(l=>({bl_id:l.bl_id,preparation_revision:l.preparation_revision}))};row.status='COMMIT_PENDING';await save(report);await assertLease();
  });if(row.status==='COMMIT_PENDING')row.status='PASS';
 }catch(error){row.status='BLOCKED';row.error=String(error.message).slice(0,450);row.commitUncertain=!!row.after;if(row.before&&apply)row.recoveryInstruction='vérifier l’état réel avant toute reprise — ne pas rejouer';}
 await save(report);
 }
 await assertLease();report.finishedAt=new Date().toISOString();report.status=report.rows.every(r=>r.status==='PASS'||!apply&&r.status==='PLANNED')?'PASS':'BLOCKED';await save(report);return report;
}
export async function rollbackMaskedTemuMaintenance({db,pauseProbe,report}){
 if(!report?.apply||!Array.isArray(report.rows))throw Error('Journal appliqué requis');const p=await pauseProbe();if(p?.paused!==true||!p.epoch)throw Error('Tous les écrivains doivent être arrêtés');
 return db.transaction(async tx=>{await tx.query(lockSql);let restored=0;const adapter=maskedTemuDatabaseAdapter({pauseProbe});
 for(const row of report.rows.filter(r=>r.after)){const e=await adapter.readLockedEvidence(tx,row.orderId);const technical={source_payload:e.order.source_payload,issue:e.order.issue,label_status:e.order.label_status,resolution_pending_resume:e.order.resolution_pending_resume,lifecycle:e.lifecycle.map(l=>({bl_id:l.bl_id,preparation_revision:l.preparation_revision}))};if(evidenceHash(technical)===evidenceHash(row.before))continue;if(evidenceHash(technical)!==evidenceHash(row.after)||evidenceHash(preserved(e))!==row.preservedHash)throw Error('État réel différent du journal : ne pas rejouer ni écraser');const b=row.before;await tx.query('UPDATE orders SET source_payload=$2,issue=$3,resolution_pending_resume=$4,label_status=$5 WHERE id=$1',[row.orderId,JSON.stringify(b.source_payload),b.issue,b.resolution_pending_resume,b.label_status]);for(const l of b.lifecycle)await tx.query('UPDATE document_lifecycle SET preparation_revision=$2 WHERE bl_id=$1',[l.bl_id,l.preparation_revision]);restored++;}
 const latest=await pauseProbe();if(latest?.paused!==true||latest.epoch!==p.epoch)throw Error('Pause perdue');return {restored,externalWrites:0,newJobs:0,labelsTouched:0};});
}
if(await isPlatformMaintenanceEntry(import.meta.url)){
 const args=process.argv.slice(2),value=k=>args[args.indexOf(k)+1];if(!args.includes('--section7')||!args.includes('--writers')||!args.includes('--report')||!args.includes('--expected-database'))throw Error('Maintenance Section7 sous verrou, inventaire et journal obligatoires');if(!args.includes('--rollback-from')){try{await readFile(value('--report'));throw Error('Journal existant : vérifier l’état réel avant toute reprise — ne pas rejouer ni écraser');}catch(error){if(error.code!=='ENOENT')throw error;}}await assertPlatformMaintenanceLock(Number(value('--lock-fd')));loadEnvFile('/etc/nextech/application.env');process.env.SHOP_VAULT_FILE='/etc/nextech/temu-shops.json';
 const {Pool,Client}=await import('pg');await assertPlatformMaintenanceDatabase(process.env.DATABASE_URL,value('--expected-database'),Client);const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2});
 const db={query:(...a)=>pool.query(...a),transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};const pauseProbe=systemdWriterPauseProbe({requiredUnits:value('--writers').split(',')}),save=r=>savePlatformMaintenanceReport(value('--report'),r);
 try{const report=args.includes('--rollback-from')?await rollbackMaskedTemuMaintenance({db,pauseProbe,report:JSON.parse(await readFile(value('--rollback-from'),'utf8'))}):await runMaskedTemuMaintenance({db,collect:maskedTemuSourceReader(),pauseProbe,apply:args.includes('--apply'),save});console.log(JSON.stringify({status:report.status,rows:report.rows?.map(({reference,status,classification,reason,error})=>({reference,status,classification,reason,error})),externalWrites:0,newJobs:0,labelsTouched:0}));if(report.status==='BLOCKED')process.exitCode=2;}finally{await pool.end();}
}
