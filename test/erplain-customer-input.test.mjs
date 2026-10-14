import test from 'node:test';
import assert from 'node:assert/strict';
import {erplainCustomerInput,ensureErplainCustomerNumber} from '../src/erplain-customer-input.mjs';
import {customerCheckpointResult} from '../src/temu-customer-checkpoint.mjs';
const order=()=>({id:'order-1',channel:'temu',recipient:'Peter Švrčke',source_payload:{origin:'temu_excel'},erp_live:{customerNumber:'CL-0042'},address:{street:'1 Test',postal:'01001',city:'Test',country:'SK',email:'test@example.invalid',phone:'+421123456'},selectedSourceLines:[{source_payload:{excel:{'prénom du destinataire':'Peter','nom de famille du destinataire':'Švrčke'}}}]});
test('TEMU customer includes contact, native number and both default addresses',()=>{
 const input=erplainCustomerInput(order());
 assert.equal(input.customer_type,'individual');assert.equal(input.first_name,'Peter');assert.equal(input.last_name,'Švrčke');assert.equal(input.customer_number,'CL-0042');
 assert.equal(input.email,'test@example.invalid');assert.equal(input.phone,'+421123456');
 assert.deepEqual(input.addresses.data.map(a=>a.type),['billing','shipping']);
 for(const a of input.addresses.data){assert.equal(a.default,true);assert.equal(a.address_1,'1 Test');assert.equal(a.postal_code,'01001');assert.equal(a.country,'SK');assert.equal(a.label,'Peter Švrčke');}
});
test('explicit compound names are preserved and API full names have a fallback',()=>{
 const o=order();o.selectedSourceLines[0].source_payload.excel={'Recipient first name':'Jean Pierre','Recipient last name':'De la Tour'};
 assert.equal(erplainCustomerInput(o).first_name,'Jean Pierre');assert.equal(erplainCustomerInput(o).last_name,'De la Tour');
 delete o.selectedSourceLines;assert.equal(erplainCustomerInput(o).last_name,'Švrčke');
 o.source_payload.company='Entreprise';o.source_payload.client='Entreprise';assert.equal(erplainCustomerInput(o).customer_type,'company');assert.equal(erplainCustomerInput(o).label,'Entreprise');
});
test('native number is persisted and reused; missing number or address blocks creation',async()=>{
 const o=order();delete o.erp_live.customerNumber;let calls=0,saved=0;
 const api={request:async q=>{calls++;assert.match(q,/GenerateCustomerNumber/);return {GenerateCustomerNumber:'CL-0043'};}};
 await ensureErplainCustomerNumber(api,o,async current=>{saved++;assert.equal(current.erp_live.customerNumber,'CL-0043');});
 await ensureErplainCustomerNumber(api,o,async()=>assert.fail('already persisted'));
 assert.equal(calls,1);assert.equal(saved,1);
 delete o.address.street;assert.throws(()=>erplainCustomerInput(o),/adresse/);
 delete o.erp_live.customerNumber;assert.throws(()=>erplainCustomerInput(o),/numéro/);
 await assert.rejects(ensureErplainCustomerNumber({request:async()=>({GenerateCustomerNumber:null})},o,async()=>assert.fail('invalid number')),/non reçu/);
});
test('recovery recognizes native and legacy numbers and rejects ambiguous results',()=>{
 const result=number=>({Customers:{data:[{id:'77',customer_number:number}],paginatorInfo:{hasMorePages:false}}});
 assert.equal(customerCheckpointResult(result('CL-0042'),'order-1','CL-0042').id,'77');
 assert.equal(customerCheckpointResult(result('V3:order-1'),'order-1').id,'77');
 assert.throws(()=>customerCheckpointResult(result('CL-OTHER'),'order-1','CL-0042'),/ambigu/);
 const duplicated=result('CL-0042');duplicated.Customers.data.push({...duplicated.Customers.data[0],id:'78'});
 assert.throws(()=>customerCheckpointResult(duplicated,'order-1','CL-0042'),/ambigu/);
});
