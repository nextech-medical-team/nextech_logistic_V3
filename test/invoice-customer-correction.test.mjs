import test from 'node:test';import assert from 'node:assert/strict';
import {ensureConsumerCustomer} from '../src/invoice-customer-correction.mjs';
test('owned V3 consumer is corrected with only its type field',async()=>{
 const calls=[];await ensureConsumerCustomer({request:async(q,v)=>{calls.push({q,v});return q.startsWith('query')?{Customer:{id:77,customer_type:'company',customer_number:'V3:order-1'}}:{UpdateCustomer:{id:77,customer_type:'individual'}};}},{id:42,customer:{id:77}},{orderId:'order-1'});
 assert.equal(calls.length,2);assert.deepEqual(calls[1].v,{id:'77',input:{customer_type:'individual'}});
});
test('already individual is read without any mutation',async()=>{
 const calls=[];await ensureConsumerCustomer({request:async q=>{calls.push(q);return {Customer:{id:77,customer_type:'individual'}};}},{customer:{id:77}},{orderId:'order-1'});assert.equal(calls.length,1);
});
for(const patch of [{customer_number:'external'},{customer_number:'V3:another-order'},{tax_number:'VAT'},{company_registration_number:'SIREN'},{siret:'SIRET'},{customer_type:null},{id:78}])test('foreign or professional customer preserved '+JSON.stringify(patch),async()=>{
 const calls=[];await assert.rejects(ensureConsumerCustomer({request:async q=>{calls.push(q);return {Customer:{id:77,customer_type:'company',customer_number:'V3:order-1',...patch}};}},{customer:{id:77}},{orderId:'order-1'}));assert.equal(calls.length,1);
});
test('uncertain update is not repeated',async()=>{
 const calls=[];await assert.rejects(ensureConsumerCustomer({request:async q=>{calls.push(q);return q.startsWith('query')?{Customer:{id:77,customer_type:'company',customer_number:'V3:order-1'}}:{UpdateCustomer:null};}},{customer:{id:77}},{orderId:'order-1'}),/non confirmé/);assert.equal(calls.length,2);
});
test('missing invoice customer prevents reads and writes',async()=>{await assert.rejects(ensureConsumerCustomer({request:async()=>assert.fail('must not call API')},{id:42},{orderId:'order-1'}),/non confirmé/);});
