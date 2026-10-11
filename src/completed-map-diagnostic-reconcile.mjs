import {readErplainDocuments,assertDocumentIdle} from './erplain-document-read.mjs';
import {createHash} from 'node:crypto';
import {completedMapError,planCompletedMapDiagnostic} from './completed-map-diagnostic-plan.mjs';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function snapshot(db,id,{lock=false,assertIdle}){
 const suffix=lock?' FOR SHARE':'';
 const order=(await db.query('SELECT * FROM orders WHERE id=$1'+(lock?' FOR UPDATE':''),[id])).rows[0];if(!order)return null;
 await assertIdle(db,id);
 const erp=(await db.query('SELECT status,error,updated_at FROM erp_live_jobs WHERE order_id=$1'+suffix,[id])).rows[0];
 const reviews=(await db.query('SELECT * FROM resolution_jobs WHERE order_id=$1 ORDER BY created_at DESC,id DESC'+suffix,[id])).rows;
 const current=[...new Map([...reviews].reverse().map(j=>[j.action,j])).values()];
 const review=current.find(j=>j.action==='replace-equivalent');
 const done=Date.parse(order.erp_live?.verifiedAt);
 const validDone=Number.isFinite(done)&&done<=Date.now();
 const historicalStockReviews=current.filter(j=>j.id!==review?.id&&j.status==='review'&&/^(BL bloqué — stock insuffisant|Stock insuffisant)/.test(j.error||'')&&validDone&&Date.parse(j.updated_at)<=done);
 const historicalIds=new Set(historicalStockReviews.map(j=>j.id));
 const otherErrors=current.filter(j=>j.id!==review?.id&&j.error&&!historicalIds.has(j.id)).map(j=>j.error);
 if(!validDone)otherErrors.push('Verified BL date unconfirmed');
 const job=(await db.query('SELECT status,error,packages,result FROM temu_label_jobs WHERE reference=$1'+suffix,[order.reference])).rows[0];
 const docs=(await db.query('SELECT package,pdf FROM temu_label_documents WHERE reference=$1 ORDER BY package'+suffix,[order.reference])).rows;
 const labels=docs.map(d=>({package:d.package,source:job?.result?.source,jobStatus:job?.status,jobError:job?.error,bytes:d.pdf?.length||0,signature:d.pdf?Buffer.from(d.pdf).subarray(0,5).toString('ascii'):null,sha256:d.pdf?createHash('sha256').update(Buffer.from(d.pdf)).digest('hex'):null}));
 if(!Array.isArray(job?.packages)||job.packages.length!==labels.length||job.packages.some(p=>!labels.some(l=>l.package===p)))otherErrors.push('TEMU package evidence incomplete');
 const busy=(await db.query("SELECT 1 FROM correction_jobs WHERE order_id=$1 AND status IN ('pending','queued','running','applying','checking','waiting') UNION ALL SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('pending','processing') UNION ALL SELECT 1 FROM extra_parcels WHERE order_id=$1 UNION ALL SELECT 1 FROM partial_deliveries WHERE order_id=$1",[id])).rows.length>0;
 return {order,erp,review,labels,busy,otherErrors,historicalStockReviews:historicalStockReviews.map(j=>({id:j.id,error:j.error,updatedAt:j.updated_at}))};
}
export async function reconcileCompletedMapDiagnostic(db,api,id,{readDocuments=readErplainDocuments,assertIdle=assertDocumentIdle,now=()=>Date.now(),dryRun=false}={}){
 if(typeof readDocuments!=='function'||typeof assertIdle!=='function')throw Error('Verified document reader and idle guard required');
 const before=await snapshot(db,id,{assertIdle});if(!before||before.erp?.error!==completedMapError||before.erp.status!=='review'||before.review?.error!==completedMapError)return {updated:false,notApplicable:true};
 if(!before.order.erp_live?.bc?.id||before.order.issue||before.busy||before.otherErrors.length)return {updated:false,independentOrPolicyBlocker:true};
 const provider={request:(query,...args)=>{if(!/^\s*query\b/.test(query)||/\bmutation\b/i.test(query))throw Error('Provider mutation prohibited');return api.request(query,...args);}};
 await api.verify?.();const bc=await readDocuments(provider,before.order.erp_live.bc.id);
 const stock=(await provider.request('query V3CompletedMapStock($id:ID!){StockRemoval(id:$id){id label status notes update_stock}}',{id:String(before.order.erp_live.stockDocument?.id||'')})).StockRemoval;
 const checkedAt=new Date(now()).toISOString(),plan=planCompletedMapDiagnostic({...before,bc,stock,checkedAt},{now:now()});if(!plan.eligible)return {updated:false,reason:plan.reason};
 if(dryRun)return {updated:false,eligible:true,plan};
 return db.transaction(async tx=>{
  const fresh=await snapshot(tx,id,{lock:true,assertIdle});if(hash(fresh)!==hash(before))return {updated:false,changedDuringRead:true};
  const checked=planCompletedMapDiagnostic({...fresh,bc,stock,checkedAt},{now:now()});if(!checked.eligible)return {updated:false,reason:checked.reason};
  const proof={...checked.proof,historicalStockReviewsPreserved:fresh.historicalStockReviews,labelsModified:0,providerWrites:0,newJobs:[],businessCompleted:false};
  const erp=await tx.query("UPDATE erp_live_jobs SET status='complete',error=null,updated_at=now() WHERE order_id=$1 AND status='review' AND error=$2 RETURNING order_id",[id,completedMapError]);if(erp.rows.length!==1)throw Error('ERP diagnostic changed');
  const result=await tx.query("UPDATE resolution_jobs SET status='complete',error=null,stage=$3,result=coalesce(result,'{}'::jsonb)||$4::jsonb,updated_at=now() WHERE id=$1 AND status='review' AND error=$2 RETURNING id",[fresh.review.id,completedMapError,checked.resolutionTechnicalPatch.stage,JSON.stringify({completedMapReconciliation:proof})]);if(result.rows.length!==1)throw Error('Resolution diagnostic changed');
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system:completed-map','diagnostic.completed_map_reconciled',$1)",[JSON.stringify({orderId:id,reviewId:fresh.review.id,...proof})]);
  return {updated:true,proof,businessCompleted:false};
 });
}

export function completedMapDiagnosticReconciler(db,api,{now=()=>Date.now(),enabled=()=>true,reconcile=reconcileCompletedMapDiagnostic}={}){
 let running=false,next=0;const attempts=new Map();return {async run(){
  if(running||now()<next||!enabled())return;running=true;next=now()+60000;
  try{const rows=(await db.query("SELECT o.id FROM orders o JOIN erp_live_jobs e ON e.order_id=o.id WHERE NOT o.archived AND o.issue IS NULL AND o.erp_live->>'phase'='bl_ready' AND e.status='review' AND e.error=$1 ORDER BY o.id",[completedMapError])).rows;
   let n=0;for(const o of rows){if(!enabled()||n>=5)break;if((attempts.get(o.id)||0)>now())continue;attempts.set(o.id,now()+900000);n++;try{await reconcile(db,api,o.id,{now});}catch(e){console.error('Completed mapping diagnostic deferred',e.message);}}
   const found=new Set(rows.map(o=>o.id));for(const id of attempts.keys())if(!found.has(id))attempts.delete(id);
  }finally{running=false;}
 }};
}
