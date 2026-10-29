import test from 'node:test';
import assert from 'node:assert/strict';
import {bcComparisonDiagnostic} from '../src/resolution-bc-diagnostic.mjs';
import {resolutionBcLines} from '../src/resolution-bc-scope.mjs';
const order={channel:'erplain',source_payload:{erplainImported:true,account:'live'},erp_live:{bc:{id:1},bl:{id:3},pendingBlIds:['3']}};
function fixture(status='cancelled') {return {id:1,status:'active',line_items:[{id:10,type:'normal',variant:{id:20,sku:'166042'},quantity:126}],shipping_orders:{data:[{id:2,status,line_items:[{type:'normal',parent_id:99,variant:{id:21,sku:'OLD'},quantity:42}]},{id:3,status:'ready_to_ship',line_items:[{type:'normal',parent_id:10,variant:{id:20,sku:'166042'},quantity:126}]}],paginatorInfo:{hasMorePages:false}}};}
test('cancelled historical line can be absent from current BC without blocking the valid pending BL',()=>{
 const bc=fixture();assert.doesNotThrow(()=>bcComparisonDiagnostic(order,bc,[]));
 assert.deepEqual(resolutionBcLines(order,bc).map(l=>[l.variant.sku,l.quantity]),[['166042',126]]);
 assert.equal(bc.shipping_orders.data.length,2);
});
test('missing parent remains blocking for active and delivered BLs',()=>{
 for(const status of ['pending','ready_to_ship','delivered']){const bc=fixture(status);assert.throws(()=>bcComparisonDiagnostic(order,bc,[]),/Lien BL/);assert.throws(()=>resolutionBcLines(order,bc),/Lien BL/);}
});
test('a wrong parent on the selected BL still blocks despite cancelled history',()=>{
 const bc=fixture();bc.shipping_orders.data[1].line_items[0].parent_id=100;
 assert.throws(()=>bcComparisonDiagnostic(order,bc,[]),/Lien BL/);assert.throws(()=>resolutionBcLines(order,bc),/Lien BL/);
});
