import test from 'node:test';
import assert from 'node:assert/strict';
import {canRetryFailedCarrier} from '../src/carrier-attempt-proof.mjs';
import {assertBlLabelRequest} from '../src/direct-label.mjs';
import {regenerateProductionLabels} from '../src/label-regeneration.mjs';
const db={query:async()=>({rows:[]})};
const job={order_id:'synthetic',status:'failed',attempts:1,creation_id:'queued-uuid',error:'Mapping modifié avant création : recontrôle requis',result:null,reference:null,tracking:[]};
test('legacy mapping failure needs a new manual request; queued UUID is not a POST',async()=>{
 assert.equal(await canRetryFailedCarrier(db,job),false);
 assert.equal(await canRetryFailedCarrier(db,job,{manualRequest:true}),true);
});
test('manual request never permits provider results, markers, later attempts or unknown errors',async()=>{
 for(const patch of [{status:'review'},{result:{}},{reference:'R'},{tracking:['T']},{creation_started_at:'now'},{failure_phase:'provider'},{attempts:2},{error:'Network timeout'},{error:job.error+' · provider timeout'}])
  assert.equal(await canRetryFailedCarrier(db,{...job,...patch},{manualRequest:true}),false,JSON.stringify(patch));
});
test('manual legacy retry does not open the BL shortcut to TEMU',()=>{
 assert.throws(()=>assertBlLabelRequest({channel:'temu',carrier:'gls',transport_choice:'gls',erp_live:{bl:{id:'bl',status:'ready_to_ship'}}}),/parcours TEMU/);
});
test('fresh manual request alone requeues a rejected legacy attempt without ERP or stock queries, preserving PDFs',async()=>{
 for(const [manualRequest,documents] of [[false,0],[true,0],[true,1]]){
  const writes=[];
  const o={id:'synthetic',reference:'ORDER',channel:'amazon',carrier:'gls',weight_kg:1,parcel_count:1,address:{name:'Synthetic',street:'1 rue Test',city:'Paris',postal:'75001',country:'FR'},erp_live:{bl:{id:'bl',status:'ready_to_ship'}}};
  const fixture={transaction:fn=>fn(fixture),query:async(sql,args)=>{
   if(sql.startsWith('SELECT * FROM orders'))return {rows:[o]};
   if(sql.startsWith('SELECT * FROM carrier_jobs'))return {rows:[job]};
   if(sql.startsWith('SELECT 1 FROM carrier_documents'))return {rows:documents?[{exists:1}]:[]};
   if(sql.startsWith('SELECT action,detail,created_at FROM audit')){
    assert.deepEqual(args,[job.order_id,job.updated_at]);
    assert.match(sql,/date_trunc\('milliseconds',created_at\)=date_trunc\('milliseconds',\$2::timestamptz\)/);
    return {rows:[]};
   }
   assert.ok(!sql.startsWith('SELECT'),'Unexpected business read: '+sql);
   writes.push(sql);return {rows:[]};
  }};
  const result=await regenerateProductionLabels(fixture,{ids:[o.id],batchId:'new-human-request',manualRequest});
  assert.equal(result.queued,manualRequest&&!documents?1:0);
  assert.equal(writes.some(sql=>sql.startsWith('INSERT INTO carrier_jobs')),manualRequest&&!documents);
  assert.ok(!writes.some(sql=>/UPDATE erp_live_jobs|stock_documents/.test(sql)));
 }
});
