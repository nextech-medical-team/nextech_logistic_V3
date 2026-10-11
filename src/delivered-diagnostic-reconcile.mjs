import {readErplainDocuments,assertDocumentIdle} from './erplain-document-read.mjs';
import {createHash} from 'node:crypto';
import {planDeliveredDiagnostic,staleDeliveredReason} from './delivered-diagnostic-plan.mjs';
export function deliveredDiagnosticReconciler(db,api,{now=()=>Date.now(),enabled=()=>true,reconcile=reconcileDeliveredDiagnostic}={}){
 let running=false,next=0;const attempts=new Map();
 return {async run(){
  if(running||now()<next||!enabled())return;running=true;next=now()+60000;
  try{
   const rows=(await db.query("SELECT id FROM orders WHERE issue=$1 AND NOT archived AND tracking_status='delivered' AND source_payload->'postBcContentFreeze'->>'enabled'='true' ORDER BY id",[staleDeliveredReason])).rows;
   let n=0;for(const o of rows){if(!enabled()||n>=5)break;if((attempts.get(o.id)||0)>now())continue;attempts.set(o.id,now()+15*60000);n++;try{await reconcile(db,api,o.id,{now});}catch(e){console.error('Delivered diagnostic reconciliation deferred',e.message);}}
   const found=new Set(rows.map(o=>o.id));for(const id of attempts.keys())if(!found.has(id))attempts.delete(id);
  }finally{running=false;}
 }};
}
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function evidence(db,id,{lock=false,assertIdle}){
 const suffix=lock?' FOR SHARE':'';
 const order=(await db.query('SELECT * FROM orders WHERE id=$1'+(lock?' FOR UPDATE':''),[id])).rows[0];if(!order)return null;
 await assertIdle(db,id);
 const erp=(await db.query('SELECT status,error,updated_at FROM erp_live_jobs WHERE order_id=$1'+suffix,[id])).rows[0];
 const carrier=(await db.query('SELECT status,error,environment,tracking FROM carrier_jobs WHERE order_id=$1'+suffix,[id])).rows[0];
 const documents=(await db.query('SELECT document_index,pdf FROM carrier_documents WHERE order_id=$1 ORDER BY document_index'+suffix,[id])).rows;
 const labels=documents.map(d=>({index:d.document_index,environment:carrier?.environment,tracking:carrier?.tracking?.[Number(d.document_index)],bytes:d.pdf?.length||0,signature:d.pdf?Buffer.from(d.pdf).subarray(0,5).toString('ascii'):null,sha256:d.pdf?createHash('sha256').update(Buffer.from(d.pdf)).digest('hex'):null}));
 const jobs=(await db.query('SELECT action,status,error,created_at FROM resolution_jobs WHERE order_id=$1 ORDER BY created_at DESC,id DESC'+suffix,[id])).rows;
 const current=[...new Map([...jobs].reverse().map(j=>[j.action,j])).values()];
 const otherErrors=current.filter(j=>j.error).map(j=>j.error);
 if(carrier?.status!=='ready'||carrier.error||!Array.isArray(carrier.tracking)||carrier.tracking.length!==labels.length)otherErrors.push('Existing carrier label unconfirmed');
 const active=(await db.query("SELECT 1 FROM correction_jobs WHERE order_id=$1 AND status IN ('pending','queued','running','applying','checking','waiting') UNION ALL SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('pending','processing') UNION ALL SELECT 1 FROM extra_parcels WHERE order_id=$1 UNION ALL SELECT 1 FROM partial_deliveries WHERE order_id=$1",[id])).rows.length>0;
 return {order,erp,labels,otherErrors,busy:active};
}
export async function reconcileDeliveredDiagnostic(db,api,id,{readDocuments=readErplainDocuments,assertIdle=assertDocumentIdle,now=()=>Date.now(),dryRun=false}={}){
 if(typeof readDocuments!=='function'||typeof assertIdle!=='function')throw Error('Verified document reader and idle guard required');
 const before=await evidence(db,id,{assertIdle});if(!before||before.order.issue!==staleDeliveredReason)return {updated:false,notApplicable:true};
 if(!before.order.source_payload?.postBcContentFreeze?.enabled)return {updated:false,awaitPolicy:true};
 if(before.busy||before.otherErrors.length||before.erp?.status!=='complete'||before.erp.error!==null)return {updated:false,independentBlocker:true};
 const provider={request:(query,...args)=>{if(!/^\s*query\b/.test(query)||/\bmutation\b/i.test(query))throw Error('Provider mutation prohibited');return api.request(query,...args);}};
 await api.verify?.();
 const bc=await readDocuments(provider,before.order.erp_live.bc.id);
 const stock=(await provider.request('query V3DeliveredDiagnosticStock($id:ID!){StockRemoval(id:$id){id label status notes update_stock}}',{id:String(before.order.erp_live.stockDocument?.id||'')})).StockRemoval;
 const checkedAt=new Date(now()).toISOString(),plan=planDeliveredDiagnostic({...before,bc,stock,checkedAt},{now:now()});
 if(!plan.eligible)return {updated:false,reason:plan.reason};
 if(dryRun)return {updated:false,eligible:true,plan};
 return db.transaction(async tx=>{
  const fresh=await evidence(tx,id,{lock:true,assertIdle});
  if(hash(fresh)!==hash(before))return {updated:false,changedDuringRead:true};
  const checked=planDeliveredDiagnostic({...fresh,bc,stock,checkedAt},{now:now()});if(!checked.eligible)return {updated:false,reason:checked.reason};
  const updated=await tx.query('UPDATE orders SET issue=null,resolution_pending_resume=false,label_status=$3 WHERE id=$1 AND issue=$2 RETURNING id',[id,staleDeliveredReason,checked.technicalPatch.label_status]);
  if(updated.rows.length!==1)throw Error('Diagnostic changed during update');
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system:delivered-diagnostic','diagnostic.delivered_hold_completed',$1)",[JSON.stringify({orderId:id,...checked.proof,providerWrites:0,newJobs:[],labelsModified:0,businessCompleted:false})]);
  return {updated:true,proof:checked.proof,businessCompleted:false};
 });
}
