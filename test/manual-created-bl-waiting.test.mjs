import test from 'node:test';
import assert from 'node:assert/strict';
import {waitingResolutionWorker} from '../src/resolution-waiting.mjs';

function fixture({erpStatus='pending',orderPatch={},carrier=null,action='choose-carrier',documents=0}={}){
 const o={id:'o',reference:'ORDER',channel:'erplain',carrier:'gofo',address:{country:'FR'},source_payload:{},archived:false,partial_mode:false,tracking_status:'not_shipped',resolution_pending_resume:false,erp_live:{bc:{id:'bc',status:'active'},bl:{id:'bl',status:'ready_to_ship'}},...orderPatch};
 const erp={status:erpStatus,error:erpStatus==='review'?'Observation ERP distincte':null};
 const job={id:'j',order_id:'o',action,status:'waiting',payload:{action,carrier:'gofo'},result:{erpOnly:false,labelRequested:false}};
 let c=carrier,queued=0;const writes=[];
 const db={transaction:fn=>fn(db),query:async(q,p=[])=>{
  if(q.startsWith('SELECT r.* FROM resolution_jobs'))return {rows:job.status==='waiting'?[structuredClone(job)]:[]};
  if(q==='SELECT * FROM orders WHERE id=$1')return {rows:[structuredClone(o)]};
  if(q.includes('SELECT * FROM erp_live_jobs')||q==='SELECT status,error FROM erp_live_jobs WHERE order_id=$1')return {rows:[erp]};
  if(q==='SELECT * FROM carrier_jobs WHERE order_id=$1'||q==='SELECT status,error FROM carrier_jobs WHERE order_id=$1')return {rows:c?[structuredClone(c)]:[]};
  if(q==='SELECT order_id,result FROM resolution_jobs WHERE id=$1')return {rows:[structuredClone(job)]};
  if(q==='SELECT 1 FROM carrier_documents WHERE order_id=$1 LIMIT 1')return {rows:documents?[{exists:1}]:[]};
  if(q.startsWith('UPDATE')||q.startsWith('INSERT')||q.startsWith('DELETE'))writes.push(q);
  if(q.startsWith('UPDATE resolution_jobs SET status=$2')){job.status=p[1];job.stage=p[2];if(p[3])job.result=JSON.parse(p[3]);job.error=p[4];}
  return {rows:[]};
 }};
 const worker=waitingResolutionWorker(db,{regenerate:async (_db,options)=>{queued++;assert.deepEqual(options.ids,['o']);assert.equal(options.batchId,'resolution-j');c={status:'pending',reference:null,result:null,tracking:[]};return {queued:1,skipped:[]};}});
 return {worker,o,erp,job,writes,get queued(){return queued;},setCarrier(value){c=value;}};
}
test('an explicitly chosen GOFO label on an existing BL no longer waits for ERP completion or stock timestamps',async()=>{
 for(const status of ['pending','processing','review']){
  const f=fixture({erpStatus:status}),before=JSON.stringify(f.o.erp_live);
  await f.worker.run();await f.worker.run();
  assert.equal(f.queued,1);assert.equal(f.job.status,'waiting',f.job.error);assert.equal(f.job.result.labelRequested,true);
  assert.equal(JSON.stringify(f.o.erp_live),before);assert.equal(f.erp.status,status);
  assert.ok(!f.writes.some(q=>/UPDATE (orders|erp_live_jobs)|stock|BL/.test(q)));
 }
});
test('existing creation is followed without a second request; its ready result completes despite pending ERP',async()=>{
 const f=fixture();await f.worker.run();
 f.setCarrier({status:'creating',reference:null,tracking:[]});await f.worker.run();assert.equal(f.queued,1);
 f.setCarrier({status:'ready',reference:'GOFO',tracking:['TRACK']});f.o.label_status='production_ready';await f.worker.run();
 assert.equal(f.queued,1);assert.equal(f.job.status,'complete',f.job.error);assert.equal(f.erp.status,'pending');
 assert.match(f.job.result.message,/BL déjà créé/);
});
test('failed carrier results, tracking and references never cause a new creation',async()=>{
 for(const carrier of [{status:'failed',result:{reference:'GOFO'},tracking:[]},{status:'failed',result:null,tracking:['TRACK']},{status:'failed',result:null,reference:'GOFO',tracking:[]},{status:'review',result:null,tracking:[]}]){
  const f=fixture({carrier});await f.worker.run();assert.equal(f.queued,0);assert.equal(f.job.status,'review');assert.match(f.job.error,/Création transport à vérifier/);
 }
});
test('a persisted carrier PDF without a ready job is preserved instead of replaced',async()=>{
 const f=fixture({documents:1,carrier:{status:'failed',failure_phase:'preflight',creation_started_at:null,result:null,tracking:[]}});await f.worker.run();
 assert.equal(f.queued,0);assert.equal(f.job.status,'review');assert.match(f.job.error,/Création transport à vérifier/);
});
test('only proven preflight failures or the exact local legacy BC guard are admitted',async()=>{
 for(const carrier of [{status:'failed',failure_phase:'preflight',creation_started_at:null,attempts:1,result:null,tracking:[]},{status:'failed',error:'BC modifié depuis sa préparation : recontrôle requis',attempts:1,result:null,tracking:[]},{status:'failed',attempts:0,result:null,tracking:[]}]){
  const f=fixture({carrier});await f.worker.run();await f.worker.run();assert.equal(f.queued,1);assert.equal(f.job.status,'waiting',f.job.error);
 }
});
test('a creation marker, provider failure or unknown legacy failure always prevents a new POST',async()=>{
 for(const carrier of [{status:'failed',failure_phase:'preflight',creation_started_at:'2026-10-14T10:00:00Z',attempts:1,result:null,tracking:[]},{status:'failed',failure_phase:'provider',attempts:0,result:null,tracking:[]},{status:'failed',error:'Network timeout',attempts:1,result:null,tracking:[]}]){
  const f=fixture({carrier});await f.worker.run();assert.equal(f.queued,0);assert.equal(f.job.status,'review');
 }
});
test('a partial persisted PDF is followed on its existing creation without replacement',async()=>{
 const f=fixture({documents:1,carrier:{status:'awaiting_pdf',result:{reference:'GOFO'},reference:'GOFO',tracking:['TRACK']}});await f.worker.run();
 assert.equal(f.queued,0);assert.equal(f.job.status,'waiting');assert.equal(f.job.result.labelRequested,true);
});
test('suspension, cancellation, duplicate, shipped and partial orders stay protected',async()=>{
 for(const orderPatch of [{suspension:{active:true,note:'Pause'}},{tracking_status:'cancelled'},{duplicate_of:'other'},{tracking_status:'shipped'},{partial_mode:true},{archived:true}]){
  const f=fixture({orderPatch});await f.worker.run();assert.equal(f.queued,0);assert.equal(f.job.status,'review');
 }
});
test('missing or cancelled BLs and TEMU never enter the new direct-label path',async()=>{
 for(const orderPatch of [{erp_live:{}},{erp_live:{bl:{id:'bl',status:'cancelled'}}},{channel:'temu'}]){
  const f=fixture({orderPatch});await f.worker.run();assert.equal(f.queued,0);
 }
});
test('document-only refresh on a published BL completes without stock timestamps and never buys a label',async()=>{
 for(const erpStatus of ['pending','review','complete']){
  const f=fixture({action:'refresh',erpStatus});await f.worker.run();assert.equal(f.queued,0);assert.equal(f.job.status,'complete',f.job.error);
 }
});

test('TEMU resume does not finish or reapply a hold while ERP is working or transiently refused',async()=>{
 for(const status of ['pending','processing','review']){
  const f=fixture({action:'resume',erpStatus:status,orderPatch:{channel:'temu'}});
  f.erp.error=status==='review'?'Incident temporaire Erplain : rapprochement et reprise automatique en attente (0/3)':null;
  await f.worker.run();assert.equal(f.queued,0);
  assert.equal(f.job.status,status==='review'?'review':'waiting');
  if(status==='review')assert.equal(f.job.stage,'Erplain à compléter');
  assert.ok(!f.writes.some(q=>q.includes('UPDATE orders SET resolution_pending_resume=true')));
 }
});

test('a fresh human carrier choice accepts exact historical mapping refusals before provider POST',async()=>{
 for(const error of ['Mapping modifié avant création : recontrôle requis','Mapping modifié depuis la validation du BL : recontrôle requis']){
  const f=fixture({carrier:{status:'failed',error,attempts:1,result:null,reference:null,tracking:[],creation_started_at:null}});
  await f.worker.run();await f.worker.run();assert.equal(f.queued,1);assert.equal(f.job.status,'waiting',f.job.error);
 }
});

for(const attempts of [2,10,99])test('manual waiting resume ignores preflight attempt counter '+attempts,async()=>{
 for(const proof of [{failure_phase:'preflight',creation_started_at:null},{error:'BC modifié depuis sa préparation : recontrôle requis'}]){
 const f=fixture({carrier:{status:'failed',attempts,result:null,reference:null,tracking:[],...proof}});
 await f.worker.run();await f.worker.run();assert.equal(f.queued,1);assert.equal(f.job.status,'waiting',f.job.error);
 }
});
