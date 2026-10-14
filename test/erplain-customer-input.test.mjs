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
