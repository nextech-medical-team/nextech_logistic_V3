import{createHash}from'node:crypto';
import{readErplainDocuments,assertDocumentIdle}from'./erplain-document-read.mjs';
import{proveCancelledCycleWithoutStock}from'./cancelled-cycle-proof.mjs';
import{suspensionBlock}from'./order-suspension.mjs';
import{planCancelledCycleDiagnostic,oldCycleDiagnostic}from'./cancelled-cycle-diagnostic-plan.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const fingerprint=x=>hash(JSON.stringify(x));
async function snapshot(db,id,lock,assertIdle){
 const share=lock?' FOR SHARE':'';
 const order=(await db.query('SELECT * FROM orders WHERE id=$1'+(lock?' FOR UPDATE':''),[id])).rows[0];if(!order)return null;
 await assertIdle(db,id);
 const erpJob=(await db.query('SELECT * FROM erp_live_jobs WHERE order_id=$1'+share,[id])).rows[0];
 const reviews=(await db.query('SELECT * FROM resolution_jobs WHERE order_id=$1 ORDER BY created_at DESC,id DESC'+share,[id])).rows;
 const carrier=(await db.query('SELECT * FROM carrier_jobs WHERE order_id=$1'+share,[id])).rows[0];
 const docs=(await db.query('SELECT document_index,pdf FROM carrier_documents WHERE order_id=$1 ORDER BY document_index'+share,[id])).rows;
 const copies=(await db.query('SELECT id,document_key,source_hash,context_hash,pdf,created_at FROM label_sku_copies WHERE order_id=$1 ORDER BY document_key,created_at DESC,id DESC'+share,[id])).rows.map(x=>({...x,pdf:hash(Buffer.from(x.pdf||[]))}));
 const labels=docs.map(d=>{const raw=Buffer.from(d.pdf||[]),rawSha256=hash(raw);return {index:d.document_index,production:carrier?.environment==='production'&&carrier?.status==='ready',bytes:raw.length,signature:raw.subarray(0,5).toString('ascii'),rawSha256,tracking:carrier?.tracking?.[Number(d.document_index)],error:carrier?.error||null};});
 const busy=(await db.query("SELECT 1 FROM correction_jobs WHERE order_id=$1 AND status IN ('pending','queued','running','applying','checking','waiting') UNION ALL SELECT 1 FROM partial_deliveries WHERE order_id=$1 UNION ALL SELECT 1 FROM extra_parcels WHERE order_id=$1 UNION ALL SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('pending','processing')",[id])).rows.length>0;
 return {order,erpJob,reviews,carrier,labels,copies,busy,suspended:!!suspensionBlock(order)};
}
export async function reconcileCancelledCycleDiagnostic(db,api,id,{readDocuments=readErplainDocuments,provePrevious=proveCancelledCycleWithoutStock,assertIdle=assertDocumentIdle,now=()=>Date.now(),dryRun=false}={}){
 const before=await snapshot(db,id,false,assertIdle);
 if(!before||before.erpJob?.error!==oldCycleDiagnostic||before.busy||before.suspended||!['amazon','shopify'].includes(before.order.channel))return {updated:false,notApplicable:true};
 if(before.labels.some(x=>x.signature!=='%PDF-')||!Array.isArray(before.carrier?.tracking)||before.carrier.tracking.length!==before.labels.length)return {updated:false,reason:'label_scope'};
 let reads=0;
 const provider={request:(q,...a)=>{if(!/^\s*query\b/.test(q)||/\bmutation\b/i.test(q))throw Error('Provider mutation prohibited');if(++reads>16)throw Error('Bounded supplier read limit exceeded');return api.request(q,...a);}};
 const checkedAt=new Date(now()).toISOString();await api.verify?.();
 const previousProof=await provePrevious(provider,before.order),currentBc=await readDocuments(provider,before.order.erp_live?.bc?.id);
 const label='V3FS-'+id+'-BC'+before.order.erp_live?.bc?.id;
 const stock=(await provider.request('query V3CancelledCycleCurrentStock($where:QueryStockRemovalsWhereWhereConditions!){StockRemovals(first:100,where:$where){data{id label status update_stock} paginatorInfo{hasMorePages}}}',{where:{column:'LABEL',operator:'EQ',value:label}})).StockRemovals;
 const evidence={previousProof,currentBc,currentStock:{label,complete:stock?.paginatorInfo?.hasMorePages===false,documents:stock?.data},checkedAt};
 const plan=planCancelledCycleDiagnostic({...before,...evidence},now());if(!plan.eligible)return {updated:false,reason:plan.reason};
 if(dryRun)return {updated:false,eligible:true,plan};
 return db.transaction(async tx=>{
  const fresh=await snapshot(tx,id,true,assertIdle);if(fingerprint(fresh)!==fingerprint(before))return {updated:false,changedDuringRead:true};
  const checked=planCancelledCycleDiagnostic({...fresh,...evidence},now());if(!checked.eligible)return {updated:false,reason:checked.reason};
  const proof={...checked,labels:fresh.labels,copies:fresh.copies,labelsModified:0,newJobs:[],previousCycleProof:previousProof};
  const result=await tx.query('UPDATE erp_live_jobs SET error=$3,updated_at=now() WHERE order_id=$1 AND error=$2 AND status IN (\'review\',\'failed\') RETURNING order_id',[id,oldCycleDiagnostic,checked.currentError]);if(result.rows.length!==1)throw Error('ERP diagnostic changed');
  const targets=fresh.reviews.filter(x=>x.status==='review'&&x.error===oldCycleDiagnostic);
  for(const j of targets){const result=await tx.query("UPDATE resolution_jobs SET error=$3,result=(CASE WHEN jsonb_typeof(result)='object' THEN result ELSE jsonb_build_object('previousResult',result) END)||$4::jsonb,updated_at=now() WHERE id=$1 AND status='review' AND error=$2 RETURNING id",[j.id,oldCycleDiagnostic,checked.currentError,JSON.stringify({cancelledCycleDiagnostic:proof})]);if(result.rows.length!==1)throw Error('Review diagnostic changed');}
  // Only technical diagnostic metadata changes. BC/BL/stock/job states remain intact.
  const state={...fresh.order.erp_live,cancelledCycleDiagnostic:proof};
  if(state.stockLastFailure?.message===oldCycleDiagnostic)state.stockLastFailure={...state.stockLastFailure,message:checked.currentError};
  await tx.query('UPDATE orders SET issue=$2,erp_live=$3::jsonb WHERE id=$1',[id,fresh.order.issue===oldCycleDiagnostic?checked.currentError:fresh.order.issue,JSON.stringify(state)]);
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system:cancelled-cycle-diagnostic','diagnostic.cancelled_cycle_reason_updated',$1)",[JSON.stringify({orderId:id,...proof,reviews:targets.map(x=>x.id)})]);
  return {updated:true,proof,businessCompleted:false};
 });
}
export function cancelledCycleDiagnosticReconciler(db,api,{now=()=>Date.now(),enabled=()=>true,reconcile=reconcileCancelledCycleDiagnostic}={}){
 let running=false,next=0;const attempts=new Map();return{async run(){if(running||now()<next||!enabled())return;running=true;next=now()+60000;
  try{const rows=(await db.query("SELECT o.id FROM orders o JOIN erp_live_jobs e ON e.order_id=o.id WHERE NOT o.archived AND o.channel IN ('amazon','shopify') AND e.status IN ('review','failed') AND e.error=$1 ORDER BY o.id",[oldCycleDiagnostic])).rows;
   for(const o of rows){if(!enabled())break;if((attempts.get(o.id)||0)>now())continue;attempts.set(o.id,now()+900000);try{await reconcile(db,api,o.id,{now});}catch(e){console.error('Cancelled cycle diagnostic deferred',e.message);}break;}
   const ids=new Set(rows.map(x=>x.id));for(const id of attempts.keys())if(!ids.has(id))attempts.delete(id);
  }finally{running=false;}
 }};
}
