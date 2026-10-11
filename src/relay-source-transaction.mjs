export const platformHoldWriteLockSql='LOCK TABLE orders,lines,jobs,erp_live_jobs,carrier_jobs,carrier_documents,document_lifecycle,extra_parcels,partial_deliveries,partial_documents,resolution_jobs,correction_jobs,temu_label_jobs IN SHARE ROW EXCLUSIVE MODE NOWAIT';
import {createHash} from 'node:crypto';
import {planRelaySourceReconciliation} from './relay-source-reconciliation.mjs';
const canonical=v=>v instanceof Date?v.toISOString():Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const platformHoldEvidenceHash=v=>createHash('sha256').update(JSON.stringify(canonical({...v,runtimeProof:undefined}))).digest('hex');
// Adapter contract: readLockedEvidence locks order and ALL associated rows;
// pinLifecycleRevision updates only the revision, with no processing request.
// No route registers this executor until these adapters have integration proofs.
export async function reconcileRelaySourceHold(db,{orderId,expectedEvidenceHash},adapter,{now=()=>Date.now()}={}){
 if(!/^[a-f0-9]{64}$/.test(expectedEvidenceHash||''))throw Error('Snapshot complet requis');
 for(const key of ['assertWritersPaused','readLockedEvidence','pinLifecycleRevision'])if(typeof adapter?.[key]!=='function')throw Error('Adaptateur intégré requis: '+key);
 const lease=await adapter.assertWritersPaused();
 if(lease?.paused!==true||!lease.epoch)throw Error('Arrêt des writers non confirmé');
 const checkLease=async()=>{const current=await adapter.assertWritersPaused();if(current?.paused!==true||current.epoch!==lease.epoch)throw Error('Concurrence: arrêt des writers perdu');};
 return db.transaction(async tx=>{
  await checkLease();
  // Also protect empty related-row sets against concurrent INSERT.
  // NOWAIT aborts maintenance instead of waiting behind an active writer.
  await tx.query(platformHoldWriteLockSql);
  const evidence=await adapter.readLockedEvidence(tx,orderId);
  if(evidence?.order?.id!==orderId||platformHoldEvidenceHash(evidence)!==expectedEvidenceHash)throw Error('Concurrence: preuves modifiées');
  const plan=planRelaySourceReconciliation(evidence,{now:typeof now==='function'?now():now});
  if(!plan.eligible)throw Error(plan.reason);
  if(evidence.runtimeProof?.allBusinessWritersPaused!==true)throw Error('Preuve locale arrêt writers absente');
  await checkLease();
  const p=plan.technicalPatch;
  const changed=await tx.query('UPDATE orders SET source_payload=$2,issue=$3,resolution_pending_resume=$4,label_status=$5 WHERE id=$1 RETURNING id',[orderId,JSON.stringify(p.source_payload),p.issue,p.resolution_pending_resume,p.label_status]);
  if(changed.rows.length!==1)throw Error('Commande disparue pendant correction');
  if(plan.lifecycleRevisionChanged!==false){
   const pin=await adapter.pinLifecycleRevision(tx,orderId);
   if(pin?.processingRequested!==false||pin?.allDocumentsCovered!==true)throw Error('Silence lifecycle non prouvé');
  }else if(p.resolution_pending_resume!==evidence.order.resolution_pending_resume||p.label_status!==evidence.order.label_status||JSON.stringify(p.source_payload.marketplacePendingCorrection)!==JSON.stringify(evidence.order.source_payload.marketplacePendingCorrection))throw Error('État opérationnel modifié pendant reclassification');
  await checkLease();
  return {orderId,technicalHoldReconciled:plan.classification==='relay_false_hold_removed',diagnosticReclassified:true,classification:plan.classification,newBlockingReason:p.issue,externalWrites:0,newJobs:0,labelsTouched:0};
 });
}
