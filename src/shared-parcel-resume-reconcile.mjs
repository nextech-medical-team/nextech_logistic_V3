import {createHash} from 'node:crypto';
import {planSharedParcelResume,sharedParcelResumeReason} from './shared-parcel-resume-plan.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const fingerprint=x=>hash(JSON.stringify(x));
export async function sharedResumeSnapshot(db,packageSn,{lock=false}={}){
 const share=lock?' FOR SHARE':'';
 const group=(await db.query('SELECT o.id FROM orders o JOIN temu_label_jobs j ON j.reference=o.reference WHERE j.packages ? $1 ORDER BY o.id',[packageSn])).rows;
 if(group.length<2||group.length>10)return null;
 const members=[];
 for(const {id} of group){
  const order=(await db.query('SELECT * FROM orders WHERE id=$1'+(lock?' FOR UPDATE':''),[id])).rows[0];
  const erpJob=(await db.query('SELECT * FROM erp_live_jobs WHERE order_id=$1'+share,[id])).rows[0];
  const reviews=(await db.query('SELECT * FROM resolution_jobs WHERE order_id=$1 ORDER BY created_at DESC,id DESC'+share,[id])).rows;
  const labelJob=(await db.query('SELECT * FROM temu_label_jobs WHERE reference=$1'+share,[order.reference])).rows[0];
  const documents=(await db.query('SELECT package,pdf FROM temu_label_documents WHERE reference=$1 ORDER BY package'+share,[order.reference])).rows;
  const labels=documents.map(x=>({package:x.package,bytes:x.pdf.length,signature:Buffer.from(x.pdf).subarray(0,5).toString('ascii'),rawSha256:hash(Buffer.from(x.pdf))}));
  const copies=(await db.query('SELECT id,document_key,source_hash,context_hash,pdf,created_at FROM label_sku_copies WHERE order_id=$1 ORDER BY document_key,created_at DESC,id DESC'+share,[id])).rows.map(x=>({...x,pdf:undefined,bytes:x.pdf.length,servedSha256:hash(Buffer.from(x.pdf))}));
  const busy=(await db.query("SELECT 1 FROM correction_jobs WHERE order_id=$1 AND status IN ('pending','queued','running','applying','checking','waiting') UNION ALL SELECT 1 FROM partial_deliveries WHERE order_id=$1 UNION ALL SELECT 1 FROM extra_parcels WHERE order_id=$1 UNION ALL SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('pending','processing','queued','running','waiting')",[id])).rows.length>0;
  // Retain the latest state for every action, and reject independent unresolved reviews.
  const latest=new Map();for(const j of reviews)if(!latest.has(j.action))latest.set(j.action,j);
  const otherErrors=[...latest.values()].filter(j=>['review','failed','waiting'].includes(j.status)||j.error).map(j=>j.error||j.status);
  const carrier=(await db.query('SELECT * FROM carrier_jobs WHERE order_id=$1'+share,[id])).rows;
  if(carrier.some(j=>j.error||['pending','processing','creating','failed','uncertain'].includes(j.status)))otherErrors.push('Independent carrier state');
  members.push({order,erpJob,reviews,latestResume:reviews[0],labelJob:{...labelJob,source:labelJob?.result?.source},labels,label:labels.length===1?labels[0]:null,copies,busy,otherErrors});
 }
 return {members};
}
export function sharedParcelResumeReconciler(db,{readProof,now=()=>Date.now(),enabled=()=>true,reconcile=reconcileSharedParcelResume}={}){
 let running=false,next=0;const attempts=new Map();
 return{async run(){
  if(running||!enabled()||now()<next)return;running=true;next=now()+60000;
  try{
   const rows=(await db.query("SELECT DISTINCT p.package FROM orders o JOIN temu_label_jobs j ON j.reference=o.reference CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(j.packages)='array' THEN j.packages ELSE '[]'::jsonb END) AS p(package) WHERE o.channel='temu' AND NOT o.archived AND o.issue=$1 AND o.resolution_pending_resume=true AND o.label_status='blocked' ORDER BY p.package",[sharedParcelResumeReason])).rows;
   for(const {package:packageSn} of rows){if(!enabled())break;if(!/^PK-\d+$/.test(packageSn)||attempts.get(packageSn)>now())continue;attempts.set(packageSn,now()+900000);try{await reconcile(db,packageSn,{readProof,now});}catch(e){console.error('Shared parcel diagnostic deferred',e.message);}break;}
   const packages=new Set(rows.map(x=>x.package));for(const p of attempts.keys())if(!packages.has(p))attempts.delete(p);
  }finally{running=false;}
 }};
}
export async function reconcileSharedParcelResume(db,packageSn,{readProof,now=()=>Date.now(),dryRun=false,snapshot=sharedResumeSnapshot}={}){
 if(typeof readProof!=='function')throw Error('Fresh supplier reader required');
 const before=await snapshot(db,packageSn);
 if(!before||before.members.some(m=>m.order.issue!==sharedParcelResumeReason||m.busy))return {updated:false,notApplicable:true};
 const checkedAt=new Date(now()).toISOString();
 // Reader must only inspect existing Erplain documents/stock events and the known TEMU package.
 const evidence=await readProof(before,packageSn);
 const input=x=>({members:x.members.map(m=>({...m,erpProof:evidence.orders.find(e=>e.reference===m.order.reference)})),registry:evidence.registry,checkedAt});
 const plan=planSharedParcelResume(input(before),now());
 if(!plan.eligible)return {updated:false,reason:plan.reason};
 if(dryRun)return {updated:false,eligible:true,proof:plan.proof};
 return db.transaction(async tx=>{
  await tx.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
  await tx.query("SET LOCAL lock_timeout='5s'");
  await tx.query("SET LOCAL statement_timeout='10s'");
  // Orders are locked in deterministic ID order, then all evidence rows are shared-locked.
  const fresh=await snapshot(tx,packageSn,{lock:true});
  if(fingerprint(fresh)!==fingerprint(before))return {updated:false,changedDuringRead:true};
  const checked=planSharedParcelResume(input(fresh),now());
  if(!checked.eligible)return {updated:false,reason:checked.reason};
  for(const patch of checked.patches){
   const result=await tx.query("UPDATE orders SET issue=NULL,resolution_pending_resume=false,label_status='production_ready' WHERE id=$1 AND issue=$2 AND resolution_pending_resume=true AND label_status='blocked' RETURNING id",[patch.id,sharedParcelResumeReason]);
   if(result.rows.length!==1)throw Error('Shared parcel diagnostic changed');
  }
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system:shared-parcel-resume','diagnostic.shared_parcel_resume_cleared',$1)",[JSON.stringify(checked.proof)]);
  return {updated:true,proof:checked.proof,businessCompleted:false};
 });
}
