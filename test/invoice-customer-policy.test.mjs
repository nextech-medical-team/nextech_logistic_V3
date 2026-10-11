import test from 'node:test';import assert from 'node:assert/strict';
import {consumerInvoice,invoiceCustomerType} from '../src/invoice-customer-policy.mjs';
import {erplainLifecycleGateway} from '../src/erplain-lifecycle-gateway.mjs';
for(const channel of ['temu','shopify','amazon'])test(channel+': consumer finalizes without B2B identifiers',async()=>{
 const calls=[];const gateway=erplainLifecycleGateway({request:async(q,v)=>{calls.push(q);return q.includes('B2CCustomer(')?{Customer:{id:77,customer_type:'individual'}}:{UpdateInvoice:{id:42,status:'unpaid'}};}});
 await gateway.finalizeInvoice({id:42,customer:{id:77}},{channel,sourcePayload:{isbusinessorder:'false'}});
 assert.equal(calls.length,2);assert(!calls.some(q=>q.includes('ValidateEInvoice')));assert.equal(invoiceCustomerType({channel}),'individual');
});
for(const sourcePayload of [{isbusinessorder:'true'},{isBusinessOrder:true},{b2b:true},{customer_type:'business'},{billing_address:{company:'Company'}}])test('business preserves validation '+JSON.stringify(sourcePayload),async()=>{
 assert.equal(consumerInvoice({channel:'amazon',sourcePayload}),false);assert.equal(invoiceCustomerType({channel:'amazon',sourcePayload}),'company');
 const calls=[];const gateway=erplainLifecycleGateway({request:async q=>{calls.push(q);return {ValidateEInvoice:{valid:false,errors:['Your customer must have a VAT number']}};}});
 await assert.rejects(gateway.finalizeInvoice({id:42},{channel:'amazon',sourcePayload}),/Facture non validée/);assert.equal(calls.length,1);
});
test('missing context retains electronic validation',async()=>{
 const calls=[];const gateway=erplainLifecycleGateway({request:async q=>{calls.push(q);return q.includes('ValidateEInvoice')?{ValidateEInvoice:{valid:true}}:{UpdateInvoice:{id:42,status:'unpaid'}};}});
 await gateway.finalizeInvoice({id:42});assert.equal(calls.length,2);
});
test('consumer finalization confirms invoice identity and status',async()=>{
 for(const response of [{id:43,status:'unpaid'},{id:42,status:'draft'},null]){
 const gateway=erplainLifecycleGateway({request:async q=>q.includes('B2CCustomer(')?{Customer:{id:77,customer_type:'individual'}}:{UpdateInvoice:response}});
 await assert.rejects(gateway.finalizeInvoice({id:42,customer:{id:77}},{channel:'temu'}),/Finalisation facture non confirmée/);
 }
});
