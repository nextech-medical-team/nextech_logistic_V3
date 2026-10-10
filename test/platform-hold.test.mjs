import test from 'node:test';import assert from 'node:assert/strict';
import {planPlatformShipmentHold} from '../src/platform-shipment-hold-plan.mjs';
import {reconcilePlatformShipmentHold,platformHoldEvidenceHash} from '../src/platform-shipment-hold-transaction.mjs';
import {planPlatformHoldReconciliation} from '../src/platform-hold-reclassification.mjs';
import {platformLifecycleReadinessProblem} from '../src/platform-shipment-hold-db.mjs';
const now=Date.parse('2026-10-10T00:00:00Z'),checkedAt='2026-10-09T23:59:59Z';
function fixture(){
 const payload={id:'1',name:'#TEST',fulfillment_status:'fulfilled',financial_status:'paid',cancelled_at:null,updated_at:checkedAt,line_items:[{id:'2',sku:'SKU',quantity:1}]};
 const address={name:'Test',street:'Street',postal:'10000',city:'City',country:'FR'},line={source_line:'2',source_sku:'SKU',quantity:1};
 return {order:{id:'order1',channel:'shopify',reference:'#TEST',issue:'Commande déjà expédiée dans Shopify · Vérifier les documents',label_status:'blocked',resolution_pending_resume:true,address,tracking_status:'not_shipped',carrier:'gls',erp_live:{bc:{id:'3',status:'active'},bl:{id:'4',status:'ready_to_ship'}},source_payload:{...payload,marketplacePendingCorrection:{...payload}}},priorLines:[line],normalizedIncoming:{reference:'#TEST',source_payload:payload,lines:[line],address},sourceRead:{payload,checkedAt,origin:'provider',channel:'shopify',orderId:'order1',readOnly:true,complete:true},carrierJobs:[{status:'ready',environment:'production',tracking:['TRACK']}],labels:[{orderId:'order1',index:0,tracking:'TRACK',sha256:'a'.repeat(64)}],workflowJobs:[{status:'complete'}],erpJobs:[{status:'complete'}],runtimeProof:{allBusinessWritersPaused:true,checkedAt}};
}
test('Independent Erplain lifecycle review replaces platform diagnostic without pinning or resuming',async()=>{
 for(const mode of ['requested','locked','error','missing timestamp','future','due','missing document','no lifecycle','partial missing']){
  const f=fixture(),rows=[{bl_id:'4',checked_at:new Date(now-1000).toISOString()}],partials=[];
  if(mode==='requested')rows[0].requested=true;if(mode==='locked')rows[0].locked=true;if(mode==='error')rows[0].error='Read failed';if(mode==='missing timestamp')rows[0].checked_at=null;if(mode==='future')rows[0].checked_at=new Date(now+1).toISOString();if(mode==='due')rows[0].checked_at=new Date(now-21600000).toISOString();if(mode==='missing document')rows[0].bl_id='5';if(mode==='no lifecycle')rows.length=0;if(mode==='partial missing')partials.push({bl:{id:'5'}});
  const reason=platformLifecycleReadinessProblem(f.order,rows,partials,now);assert.ok(reason);f.otherErrors=[reason];const before=structuredClone(f);
  const p=planPlatformHoldReconciliation(f,{now});assert.equal(p.eligible,true);assert.equal(p.lifecycleRevisionChanged,false);assert.match(p.technicalPatch.issue,/Statut BL Erplain à rapprocher/);assert.equal(p.technicalPatch.label_status,f.order.label_status);assert.equal(p.technicalPatch.resolution_pending_resume,true);assert.deepEqual(p.technicalPatch.source_payload.marketplacePendingCorrection,f.order.source_payload.marketplacePendingCorrection);
  const adapter={assertWritersPaused:async()=>({paused:true,epoch:'lease'}),readLockedEvidence:async()=>f,pinLifecycleRevision:async()=>{throw Error('Must not request or pin lifecycle');}};
  await reconcilePlatformShipmentHold({transaction:async fn=>fn({query:async()=>({rows:[{id:'order1'}]})})},{orderId:'order1',expectedEvidenceHash:platformHoldEvidenceHash(f)},adapter,{now});assert.deepEqual(f,before);
 }
 assert.equal(platformLifecycleReadinessProblem(fixture().order,[{bl_id:'4',checked_at:checkedAt}],[],now),null);
});
test('Historical hold removal is independent of cancellation/refund/unknown declarations and immutable',()=>{
 for(const status of ['fulfilled','partial','unfulfilled',undefined,'UNKNOWN'])for(const cancelled of [null,checkedAt])for(const financial of ['paid','refunded',undefined]){
  const f=fixture();Object.assign(f.sourceRead.payload,{fulfillment_status:status,cancelled_at:cancelled,financial_status:financial});
  const before=JSON.stringify(f),r=planPlatformShipmentHold(f,{now});assert.equal(r.eligible,true);assert.equal(r.executionAllowed,false);assert.equal(r.technicalPatch.issue,null);assert.deepEqual(r.externalCalls,[]);assert.deepEqual(r.newJobs,[]);assert.equal(JSON.stringify(f),before);assert.ok(!('erp_live' in r.technicalPatch));assert.ok(!('tracking_status' in r.technicalPatch));
 }
});
test('Independent commercial, document, human and evidence guards remain mandatory',()=>{
 for(const change of [f=>f.order.suspension={active:true},f=>f.order.archived=true,f=>f.order.label_status='cancelled',f=>f.order.erp_live.bl.status='cancelled',f=>f.order.issue+=' ; Stock insuffisant',f=>f.normalizedIncoming.address={...f.order.address,city:'OTHER'},f=>f.normalizedIncoming.lines=[{...f.priorLines[0],quantity:2}],f=>f.labels[0].tracking='OTHER',f=>f.carrierJobs[0].status='creating',f=>f.sourceRead.origin='cache',f=>f.sourceRead.checkedAt='2026-10-01',f=>f.sourceRead.orderId='other']){
  const f=fixture();change(f);assert.equal(planPlatformShipmentHold(f,{now}).eligible,false);
 }
});
test('Atomic maintenance refuses races and lifecycle requests with rollback',async()=>{
 for(const mode of ['success','changed','writer resumed','lifecycle requested','missing lifecycle','missing order','writer lock']){
  const f=fixture(),hash=platformHoldEvidenceHash(f);let committed=false,rolledBack=false,calls=0;
  const tx={query:async(sql)=>{if(sql.startsWith('LOCK TABLE')){assert.ok(sql.endsWith('NOWAIT'));if(mode==='writer lock')throw Error('55P03');return {rows:[]};}assert.ok(sql.startsWith('UPDATE orders SET'));return {rows:mode==='missing order'?[]:[{id:'order1'}]};}};
  const db={transaction:async fn=>{try{const result=await fn(tx);committed=true;return result;}catch(e){rolledBack=true;throw e;}}};
  const adapter={assertWritersPaused:async()=>({paused:!(mode==='writer resumed'&&++calls>=3),epoch:'lease'}),readLockedEvidence:async()=>{if(mode==='changed')f.order.address.city='OTHER';return f;},pinLifecycleRevision:async()=>({processingRequested:mode==='lifecycle requested',allDocumentsCovered:mode!=='missing lifecycle'})};
  if(mode==='success'){const result=await reconcilePlatformShipmentHold(db,{orderId:'order1',expectedEvidenceHash:hash},adapter,{now});assert.equal(result.labelsTouched,0);assert.equal(result.externalWrites,0);assert.equal(result.newJobs,0);assert.equal(committed,true);}
  else{await assert.rejects(reconcilePlatformShipmentHold(db,{orderId:'order1',expectedEvidenceHash:hash},adapter,{now}));assert.equal(committed,false);assert.equal(rolledBack,true);}
 }
});
test('Independent problems replace the platform reason without changing operational holds',async()=>{
 for(const mode of ['cancelled BL','cancelled BC','commercial change','resolution review']){
  const f=fixture();if(mode==='cancelled BL')f.order.erp_live.bl.status='cancelled';if(mode==='cancelled BC')f.order.erp_live.bc.status='cancelled';if(mode==='commercial change')f.normalizedIncoming.lines=[{...f.priorLines[0],quantity:2}];if(mode==='resolution review')f.otherErrors=['Stock insuffisant à rapprocher'];
  const plan=planPlatformHoldReconciliation(f,{now});assert.equal(plan.eligible,true);assert.equal(plan.classification,'independent_problem_preserved');assert.equal(plan.lifecycleRevisionChanged,false);assert.doesNotMatch(plan.technicalPatch.issue,/déjà expédiée/);assert.equal(plan.technicalPatch.label_status,'blocked');assert.equal(plan.technicalPatch.resolution_pending_resume,true);assert.deepEqual(plan.technicalPatch.source_payload.marketplacePendingCorrection,f.order.source_payload.marketplacePendingCorrection);
  const adapter={assertWritersPaused:async()=>({paused:true,epoch:'lease'}),readLockedEvidence:async()=>f,pinLifecycleRevision:async()=>{throw Error('Metadata must not pin or discover BLs');}};
  const db={transaction:async fn=>fn({query:async()=>({rows:[{id:'order1'}]})})};
  const result=await reconcilePlatformShipmentHold(db,{orderId:'order1',expectedEvidenceHash:platformHoldEvidenceHash(f)},adapter,{now});assert.equal(result.technicalHoldReconciled,false);assert.equal(result.externalWrites,0);assert.equal(result.diagnosticReclassified,true);
 }
});
