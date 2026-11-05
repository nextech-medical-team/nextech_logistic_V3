import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {erplainCustomerInput} from '../src/erplain-customer-input.mjs';
import {customerCheckpointResult} from '../src/temu-customer-checkpoint.mjs';
const order=()=>({id:'order-1',channel:'temu',recipient:'Peter Švrčke',source_payload:{origin:'temu_excel'},erp_live:{}});
test('new TEMU customer restores October 13 payload without number-generation prerequisite',()=>{
 const o=order();
 assert.deepEqual(erplainCustomerInput(o),{label:'Peter Švrčke',customer_number:'V3:order-1',customer_type:'individual',notes:'Compte V3. Aucun email envoyé.'});
 assert.deepEqual(o.erp_live,{});
 assert.deepEqual(erplainCustomerInput(o),erplainCustomerInput(o));
 delete o.erp_live;assert.equal(erplainCustomerInput(o).customer_number,'V3:order-1');
});
test('already persisted customer number remains the creation and recovery key',()=>{
 for(const number of ['CL-0042','V3:order-1']){
  const o=order();o.erp_live.customerNumber=number;
  assert.equal(erplainCustomerInput(o).customer_number,number);
  const result={Customers:{data:[{id:'77',customer_number:number}],paginatorInfo:{hasMorePages:false}}};
  assert.equal(customerCheckpointResult(result,o.id,number).id,'77');
  assert.throws(()=>customerCheckpointResult(result,o.id,'OTHER'),/ambigu/);
  result.Customers.data.push({id:'78',customer_number:number});
  assert.throws(()=>customerCheckpointResult(result,o.id,number),/ambigu/);
 }
});
test('customer type and other channels retain their existing policy',()=>{
 const o=order();o.source_payload.company='Entreprise';o.source_payload.client='Entreprise';
 assert.equal(erplainCustomerInput(o).customer_type,'company');assert.equal(erplainCustomerInput(o).label,'Entreprise');
 o.channel='amazon';o.erp_live.customerNumber='CL-TEMU';assert.equal(erplainCustomerInput(o).customer_number,'V3:order-1');
});
test('production worker no longer invokes number generation and keeps customer reuse guards',async()=>{
 const source=await readFile(new URL('../src/erplain-live-workflow.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/ensureErplainCustomerNumber|GenerateCustomerNumber/);
 assert.match(source,/!o\.erp_live\.bc&&!o\.erp_live\.customer/);
 assert.match(source,/mutationBlock\(fresh/);
 assert.match(source,/'CreateCustomer',erplainCustomerInput/);
});

const tenderOrder=id=>({id,channel:'tender',recipient:'Site de livraison',source_payload:{client:'CENTRE HOSPITALIER'},erp_live:{}});
const customerPage=(data,hasMorePages=false)=>({Customers:{data,paginatorInfo:{hasMorePages}}});
test('tender orders for the same client reuse its existing Erplain account across imports',async()=>{
 const {reuseTenderCustomer}=await import('../src/tender-customer-reuse.mjs');
 let calls=0,saves=0;
 const api={request:async(q,v)=>{calls++;assert.match(q,/^query /);assert.equal(v.where.column,'LABEL');assert.equal(v.where.value,'CENTRE HOSPITALIER');return customerPage([{id:'client-7',label:'CENTRE HOSPITALIER',active:true,customer_number:'C7'}]);}};
 for(const id of ['first-import','second-import']){
  const o=tenderOrder(id);
  assert.equal(await reuseTenderCustomer(api,o,async()=>{saves++;}),true);
  assert.equal(o.erp_live.customer.id,'client-7');assert.equal(o.erp_live.phase,'customer_created');
  assert.equal(await reuseTenderCustomer(api,o,async()=>assert.fail('already saved')),false);
 }
 assert.equal(calls,2);assert.equal(saves,2);
});
test('tender lookup completes pagination and blocks ambiguous, inactive or incomplete results',async()=>{
 const {reuseTenderCustomer}=await import('../src/tender-customer-reuse.mjs');
 const c={id:'1',label:'CENTRE HOSPITALIER',active:true};
 for(const pages of [
  [customerPage([c],true),customerPage([{...c,id:'2'}])],
  [customerPage([{...c,active:false}])],
  [{Customers:{data:[]}}],
  [customerPage([c],true),customerPage([c])],
  [customerPage([],true)],
  [customerPage([{...c,label:'AUTRE CLIENT'}])]
 ]){
  const o=tenderOrder('blocked');let index=0;
  await assert.rejects(reuseTenderCustomer({request:async()=>pages[index++]},o,async()=>assert.fail('no persistence on invalid lookup')));
  assert.equal(o.erp_live.customer,undefined);
 }
 const missing=tenderOrder('missing');delete missing.source_payload.client;
 await assert.rejects(reuseTenderCustomer({},missing,()=>{}),/Nom du client absent/);
});
test('tender lookup allows creation only after confirmed absence and leaves other channels unchanged',async()=>{
 const {reuseTenderCustomer}=await import('../src/tender-customer-reuse.mjs');
 assert.equal(await reuseTenderCustomer({request:async()=>customerPage([])},tenderOrder('new'),()=>assert.fail('no existing customer')),false);
 for(const channel of ['temu','shopify','amazon','samples','erplain']){
  assert.equal(await reuseTenderCustomer({request:()=>assert.fail('other channels unchanged')},{...tenderOrder(channel),channel},()=>{}),false);
 }
});

test('concurrent tender creation paths search again under the shared lock before creating',async()=>{
 const {reuseTenderCustomer}=await import('../src/tender-customer-reuse.mjs');
 const {withShipmentLock}=await import('../src/shipment-lock.mjs');
 let created=0,customers=[];
 const api={request:async()=>customerPage(customers)};
 const orders=[tenderOrder('parallel-1'),tenderOrder('parallel-2')];
 await Promise.all(orders.map(o=>withShipmentLock(async()=>{
  if(await reuseTenderCustomer(api,o,async()=>{}))return;
  await new Promise(resolve=>setTimeout(resolve,5));
  created++;customers=[{id:'shared',label:'CENTRE HOSPITALIER',active:true}];o.erp_live.customer=customers[0];
 },['erplain-tender-customers'])));
 assert.equal(created,1);assert.equal(orders[0].erp_live.customer.id,orders[1].erp_live.customer.id);
});

test('explicit customer number disambiguates tender accounts and never creates a missing numbered client',async()=>{
 const {reuseTenderCustomer}=await import('../src/tender-customer-reuse.mjs');
 const o=tenderOrder('explicit');o.source_payload.numerodeclient='C00007717';
 assert.equal(await reuseTenderCustomer({request:async(q,v)=>{
  assert.deepEqual(v.where,{column:'CUSTOMER_NUMBER',operator:'EQ',value:'C00007717'});
  return customerPage([{id:'chosen',label:'CENTRE HOSPITALIER',active:true,customer_number:'C00007717'}]);
 }},o,async()=>{}),true);
 assert.equal(o.erp_live.customer.id,'chosen');assert.equal(o.erp_live.customerReuse.matchedBy,'customer_number');
 const missing=tenderOrder('not-found');missing.source_payload.numerodeclient='NO-SUCH-CLIENT';
 await assert.rejects(reuseTenderCustomer({request:async()=>customerPage([])},missing,async()=>assert.fail('must block')),/introuvable/);
});
