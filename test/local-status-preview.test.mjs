import test from 'node:test';import assert from 'node:assert/strict';
import {statusPreview} from '../scripts/local-status-preview.mjs';
test('fixed reads only, absent local production status stays unknown',async()=>{
 let reads=0;const api={verify:async()=>({id:100174,label:'PROD'}),request:async(q,v)=>{assert.match(q,/^query /);assert.equal(v.where.value,'PO-1');reads++;return {Orders:{data:[{id:1,label:'BC1',status:'active',shipping_orders:{data:[]}}]}}}};
 const db={query:async q=>{assert.match(q,/^SELECT /);return {rows:[{erp_test:{bc:{id:1,status:'active'}}}]}}};
 const compare=statusPreview({api,db});const r=await compare({references:['PO-1']});assert.equal(r.rows[0].local.bc,null);assert.equal(reads,1);await assert.rejects(compare({references:[]}),/1 à 5/);
 api.verify=async()=>({id:101406});await assert.rejects(compare({references:['PO-1']}),/100174/);assert.equal(reads,1);
});
