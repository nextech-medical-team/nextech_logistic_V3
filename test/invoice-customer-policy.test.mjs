import test from 'node:test';
import assert from 'node:assert/strict';
import {consumerInvoice} from '../src/invoice-customer-policy.mjs';
import {erplainLifecycleGateway} from '../src/erplain-lifecycle-gateway.mjs';
for(const channel of ['temu','shopify','amazon'])test(`${channel}: consumer without business identifiers finalizes`,async()=>{
 const calls=[];const gateway=erplainLifecycleGateway({request:async(q,v)=>{calls.push(q);assert.equal(v.id,'42');return {UpdateInvoice:{id:'42',status:'unpaid'}};}});
 await gateway.finalizeInvoice({id:42},{channel,sourcePayload:{isbusinessorder:'false'}});
 assert.equal(calls.length,1);assert.match(calls[0],/LifecycleFinalizeInvoice/);
});
for(const sourcePayload of [{isbusinessorder:'true'},{isBusinessOrder:true},{b2b:true},{customer_type:'business'},{billing_address:{company:'Company'}}])test(`explicit business keeps validation ${JSON.stringify(sourcePayload)}`,async()=>{
 assert.equal(consumerInvoice({channel:'amazon',sourcePayload}),false);
 const calls=[];const gateway=erplainLifecycleGateway({request:async q=>{calls.push(q);return {ValidateEInvoice:{valid:false,errors:['Your customer must have a VAT number']}};}});
 await assert.rejects(gateway.finalizeInvoice({id:42},{channel:'amazon',sourcePayload}),/Facture non validée/);assert.equal(calls.length,1);
});
test('missing context retains electronic validation',async()=>{
 const calls=[];const gateway=erplainLifecycleGateway({request:async q=>{calls.push(q);return q.includes('ValidateEInvoice')?{ValidateEInvoice:{valid:true}}:{UpdateInvoice:{id:42,status:'unpaid'}};}});
 await gateway.finalizeInvoice({id:42});assert.equal(calls.length,2);
});
test('consumer finalization response must confirm identity and status',async()=>{
 for(const response of [{id:43,status:'unpaid'},{id:42,status:'draft'},null]){
  const gateway=erplainLifecycleGateway({request:async()=>({UpdateInvoice:response})});
  await assert.rejects(gateway.finalizeInvoice({id:42},{channel:'temu'}),/Finalisation facture non confirmée/);
 }
});
