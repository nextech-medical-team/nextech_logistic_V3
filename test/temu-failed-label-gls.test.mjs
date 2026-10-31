import test from 'node:test';import assert from 'node:assert/strict';
import {failedTemuGlsApproval,hasFailedTemuGlsApproval} from '../src/temu-failed-label-gls.mjs';
import {assertDirectCarrierAllowed} from '../src/temu-label-policy.mjs';
import {chosenRoute} from '../src/routing.mjs';
const now=Date.now(),known=['PK-123'],actor='operator@example.test',resolutionId='resolution';
function order(){return{id:'order',reference:'PO-079-123',channel:'temu',address:{country:'GR',city:'Test'},tracking_status:'not_shipped',source_payload:{},erp_live:{bc:{id:'bc',status:'active'},bl:{id:'bl',status:'ready_to_ship'}}};}
function diagnostic(){return{provider:'TEMU',readOnly:true,reference:'PO-079-123',status:2,cancellationRequested:false,checkedAt:new Date(now).toISOString(),shipments:[],packages:[{packageSn:'PK-123',shippingLabelStatus:2,canChangeToManualSend:true,trackingNumber:'',failReasonText:'non-English characters',shippingInfoList:[{trackingNumber:''}],orderSendInfoList:[{parentOrderSn:'PO-079-123'}]}],errors:[{packageSn:'PK-123',message:'refused'}]};}
function approved(){const o=order();o.source_payload.temuFailedLabelGlsApproval=failedTemuGlsApproval(o,diagnostic(),known,{actor,resolutionId,now});return o;}
test('only an explicit GLS choice after a confirmed rejection can route to GLS',()=>{const o=approved();assert.equal(hasFailedTemuGlsApproval(o,{now}),true);assert.throws(()=>assertDirectCarrierAllowed(o,'gls'));assert.doesNotThrow(()=>assertDirectCarrierAllowed(o,'gls',{manualChoice:true}));o.transport_choice='gls';assert.equal(chosenRoute(o,3).carrier,'gls');assert.equal(chosenRoute(o,3).weight,3);assert.throws(()=>assertDirectCarrierAllowed(o,'gofo',{manualChoice:true}));assert.equal(chosenRoute(approved(),3).carrier,'temu');});
for(const [label,patch] of Object.entries({available:d=>d.packages[0].shippingLabelStatus=1,uncertain:d=>d.packages[0].shippingLabelStatus=0,tracking:d=>d.packages[0].trackingNumber='TRACK',legTracking:d=>d.packages[0].shippingInfoList[0].trackingNumber='TRACK',manualDenied:d=>d.packages[0].canChangeToManualSend=false,unknownError:d=>d.errors.push({message:'timeout'}),missingPackage:d=>d.packages=[],duplicate:d=>d.packages.push(d.packages[0]),wrongOrder:d=>d.packages[0].orderSendInfoList[0].parentOrderSn='OTHER',shipment:d=>d.shipments.push({trackingNumber:'TRACK'}),cancel:d=>d.cancellationRequested=true,stale:d=>d.checkedAt=new Date(now-60001).toISOString(),future:d=>d.checkedAt=new Date(now+1).toISOString()}))test('refuse '+label,()=>{const d=diagnostic();patch(d);assert.throws(()=>failedTemuGlsApproval(order(),d,known,{actor,resolutionId,now}));});
test('known parcels, actor and operation identity are mandatory',()=>{for(const values of[[],['PK-999']])assert.throws(()=>failedTemuGlsApproval(order(),diagnostic(),values,{actor,resolutionId,now}));for(const args of[{resolutionId,now},{actor,now}])assert.throws(()=>failedTemuGlsApproval(order(),diagnostic(),known,args));});
for(const [label,patch] of Object.entries({partial:o=>o.partial_mode=true,suspended:o=>o.suspension={active:true},cancelled:o=>o.tracking_status='cancelled',shipped:o=>o.tracking_status='shipped',external:o=>o.source_payload.externalLabel={active:true},address:o=>o.address.city='Changed',bl:o=>o.erp_live.bl.id='other',order:o=>o.id='other'}))test('approval cannot be reused after '+label,()=>{const o=approved();patch(o);assert.equal(hasFailedTemuGlsApproval(o,{now}),false);assert.throws(()=>assertDirectCarrierAllowed(o,'gls',{manualChoice:true}));});
test('approval expires and stays bound to the order when the carrier uses a creation UUID',()=>{const o=approved();assert.equal(hasFailedTemuGlsApproval(o,{now:now+600001}),false);o.transport_choice='gls';const shipment={...o,id:'creation',duplicate_of:o.id};assert.equal(hasFailedTemuGlsApproval(shipment,{now}),true);assert.doesNotThrow(()=>assertDirectCarrierAllowed(shipment,'gls'));});
test('production queue accepts the approved order once and preserves an engaged creation',async()=>{
 const {regenerateProductionLabels}=await import('../src/label-regeneration.mjs');
 const o=approved();Object.assign(o,{transport_choice:'gls',carrier:'gls',weight_kg:3,parcel_count:1,address:{...o.address,name:'Test',street:'1 Test Street',postal:'12345'}});
 // Bind the approval to the final address, exactly as the resolution handler does.
 o.source_payload.temuFailedLabelGlsApproval=failedTemuGlsApproval(o,diagnostic(),known,{actor,resolutionId});
 let job=null,inserts=0;
 const db={transaction:fn=>fn(db),async query(sql,args){
  if(sql.startsWith('SELECT * FROM orders'))return{rows:[o]};
  if(sql.startsWith('SELECT status FROM temu_label_jobs'))return{rows:[{status:'shipment_error'}]};
  if(sql.startsWith('SELECT * FROM carrier_jobs'))return{rows:job?[job]:[]};
  if(sql.startsWith('INSERT INTO carrier_jobs')){job={status:'pending',environment:'production',batch_id:args[4]};inserts++;}
  return{rows:[]};
 }};
 const first=await regenerateProductionLabels(db,{ids:[o.id],batchId:'first',manualRequest:true});assert.equal(first.queued,1);assert.deepEqual(first.skipped,[]);
 const second=await regenerateProductionLabels(db,{ids:[o.id],batchId:'second',manualRequest:true});assert.equal(second.queued,0);assert.equal(second.skipped.length,1);assert.equal(inserts,1);
});
