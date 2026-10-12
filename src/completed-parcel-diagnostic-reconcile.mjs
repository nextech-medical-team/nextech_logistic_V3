import {createHash} from 'node:crypto';
import {readErplainDocuments,assertDocumentIdle} from './erplain-document-read.mjs';
import {assertNoHistoricalStockRemoval} from './historical-stock-proof.mjs';
import {planCompletedParcelDiagnostic,correctedParcelDiagnostic} from './completed-parcel-diagnostic-plan.mjs';
const digest=o=>createHash('sha256').update(JSON.stringify(o)).digest('hex');
async function snapshot(db,id,{lock=false,assertIdle}){
 const suffix=lock?' FOR SHARE':'';
 const order=(await db.query('SELECT * FROM orders WHERE id=$1'+(lock?' FOR UPDATE':''),[id])).rows[0];if(!order)return null;
 await assertIdle(db,id);
 const erp=(await db.query('SELECT status,error,updated_at FROM erp_live_jobs WHERE order_id=$1'+suffix,[id])).rows[0];
 const jobs=(await db.query('SELECT * FROM resolution_jobs WHERE order_id=$1 ORDER BY created_at DESC,id DESC'+suffix,[id])).rows;
 const current=[...new Map([...jobs].reverse().map(j=>[j.action,j])).values()],review=current.find(j=>j.action==='replace-equivalent');
 const otherErrors=current.filter(j=>j.id!==review?.id&&j.error).map(j=>j.error);
 const job=(await db.query('SELECT status,error,packages,result FROM temu_label_jobs WHERE reference=$1'+suffix,[order.reference])).rows[0];
 const docs=(await db.query('SELECT package,pdf FROM temu_label_documents WHERE reference=$1 ORDER BY package'+suffix,[order.reference])).rows;
 const copies=(await db.query("SELECT document_key,source_hash,pdf,id,created_at FROM label_sku_copies WHERE order_id=$1 AND document_key LIKE 'preserved:temu:%' ORDER BY document_key,created_at DESC,id DESC"+suffix,[id])).rows;
 const labels=docs.map(d=>{const raw=Buffer.from(d.pdf||[]),rawSha256=createHash('sha256').update(raw).digest('hex'),copy=copies.find(c=>c.document_key==='preserved:temu:'+order.reference+':'+d.package);
  if(copy&&copy.source_hash!==rawSha256)otherErrors.push('Preserved label source changed');const pdf=copy?Buffer.from(copy.pdf||[]):raw;
  return {package:d.package,source:job?.result?.source,jobStatus:job?.status,jobError:job?.error,bytes:pdf.length,signature:pdf.subarray(0,5).toString('ascii'),sha256:createHash('sha256').update(pdf).digest('hex'),rawSha256,preservedCopyId:copy?.id||null};});
 if(!Array.isArray(job?.packages)||job.packages.length!==labels.length||job.packages.some(p=>!labels.some(l=>l.package===p)))otherErrors.push('TEMU package evidence incomplete');
 const busy=(await db.query("SELECT 1 FROM correction_jobs WHERE order_id=$1 AND status IN ('pending','queued','running','applying','checking','waiting') UNION ALL SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('pending','processing') UNION ALL SELECT 1 FROM extra_parcels WHERE order_id=$1 UNION ALL SELECT 1 FROM partial_deliveries WHERE order_id=$1",[id])).rows.length>0;
 return {order,erp,review,labels,otherErrors,busy};
}
export async function readCompletedParcelLedger(api,order,bc){
 await assertNoHistoricalStockRemoval(api,order);
 const since=String(bc.dated_at||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(since)||!Number.isFinite(Date.parse(since)))throw Error('Historical stock start date missing');
 const variants=[...new Set((bc.line_items||[]).filter(l=>l.type==='normal').map(l=>String(l.variant?.id||'')))];
 if(!variants.length||variants.length>10||variants.some(id=>!/^\d+$/.test(id)))throw Error('Historical ledger scope incomplete');
 const rows=[];for(const variant of variants){let complete=false;for(let page=1;page<=5;page++){
  const logs=(await api.request('query V3CompletedParcelLedger($where:QueryInventoryLogsWhereWhereConditions!,$page:Int!){InventoryLogs(first:100,page:$page,where:$where){data{id document_id order_type variant{id} created_at} paginatorInfo{hasMorePages}}}',{page,where:{AND:[{column:'VARIANT_ID',operator:'EQ',value:variant},{column:'CREATED_AT',operator:'GTE',value:since+' 00:00:00'}]}})).InventoryLogs;
  if(!Array.isArray(logs?.data)||typeof logs.paginatorInfo?.hasMorePages!=='boolean'||logs.data.some(l=>!l.id||String(l.variant?.id)!==variant))throw Error('Historical stock ledger incomplete');
  rows.push(...logs.data.filter(l=>String(l.document_id)===String(bc.id)&&l.order_type==='Order'));
  if(!logs.paginatorInfo.hasMorePages){complete=true;break;}
 }if(!complete)throw Error('Historical ledger exceeds bounded read');}
 return {complete:true,noAdditionalStockRemoval:true,rows};
}
export async function reconcileCompletedParcelDiagnostic(db,api,id,{readDocuments=readErplainDocuments,readLedger=readCompletedParcelLedger,assertIdle=assertDocumentIdle,now=()=>Date.now(),dryRun=false}={}){
 const before=await snapshot(db,id,{assertIdle});if(!before||before.review?.status!=='review'||before.review.error!==correctedParcelDiagnostic)return {updated:false,notApplicable:true};
 if(before.order.issue||before.busy||before.otherErrors.length)return {updated:false,independentBlocker:true};
 const admission=planCompletedParcelDiagnostic({...before,bc:null,ledger:null,checkedAt:new Date(now()).toISOString()},{now:now()});
 if(admission.reason!=='bc_unconfirmed'||!before.order.erp_live?.bc?.id||!before.order.erp_live?.bl?.id)return {updated:false,reason:admission.reason};
 const provider={request:(q,...a)=>{if(!/^\s*query\b/.test(q)||/\bmutation\b/i.test(q))throw Error('Provider mutation prohibited');return api.request(q,...a);}};
 const checkedAt=new Date(now()).toISOString();await api.verify?.();const bc=await readDocuments(provider,before.order.erp_live?.bc?.id),ledger=await readLedger(provider,before.order,bc);
 const plan=planCompletedParcelDiagnostic({...before,bc,ledger,checkedAt},{now:now()});if(!plan.eligible)return {updated:false,reason:plan.reason};if(dryRun)return {updated:false,eligible:true,plan};
 return db.transaction(async tx=>{const fresh=await snapshot(tx,id,{lock:true,assertIdle});if(digest(fresh)!==digest(before))return {updated:false,changedDuringRead:true};
  const checked=planCompletedParcelDiagnostic({...fresh,bc,ledger,checkedAt},{now:now()});if(!checked.eligible)return {updated:false,reason:checked.reason};
  const proof={...checked.proof,providerWrites:0,labelsModified:0,newJobs:[],businessCompleted:false};
  const result=await tx.query("UPDATE resolution_jobs SET status='complete',error=null,stage=$3,result=coalesce(result,'{}'::jsonb)||$4::jsonb,updated_at=now() WHERE id=$1 AND status='review' AND error=$2 RETURNING id",[fresh.review.id,correctedParcelDiagnostic,checked.resolutionTechnicalPatch.stage,JSON.stringify({completedParcelReconciliation:proof})]);if(result.rows.length!==1)throw Error('Parcel diagnostic changed');
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system:completed-parcel','diagnostic.completed_parcel_reconciled',$1)",[JSON.stringify({orderId:id,reviewId:fresh.review.id,...proof})]);return {updated:true,proof,businessCompleted:false};});
}
export function completedParcelDiagnosticReconciler(db,api,{now=()=>Date.now(),enabled=()=>true,reconcile=reconcileCompletedParcelDiagnostic}={}){
 let running=false,next=0;const attempts=new Map();return {async run(){if(running||now()<next||!enabled())return;running=true;next=now()+60000;
  try{const rows=(await db.query("SELECT DISTINCT o.id FROM orders o JOIN resolution_jobs r ON r.order_id=o.id WHERE NOT o.archived AND o.issue IS NULL AND o.channel='temu' AND r.status='review' AND r.error=$1 ORDER BY o.id",[correctedParcelDiagnostic])).rows;
   for(const o of rows){if(!enabled())break;if((attempts.get(o.id)||0)>now())continue;attempts.set(o.id,now()+900000);try{await reconcile(db,api,o.id,{now});}catch(e){console.error('Completed parcel diagnostic deferred',e.message);}break;}
   const found=new Set(rows.map(o=>o.id));for(const id of attempts.keys())if(!found.has(id))attempts.delete(id);
  }finally{running=false;}
 }};
}
