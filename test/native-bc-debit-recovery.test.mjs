import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileNativeBcDebit} from '../src/native-bc-debit-recovery.mjs';
function fixture(){
 const o={channel:'amazon',erp_live:{bcReservationPolicy:'erplain_bc_bl',bc:{id:7}}};
 const bc={id:7,status:'active',update_stock:true,shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}},line_items:[{quantity:24,reserved_quantity:0,on_hand:0,available:0,location:{id:1},variant:{id:2,sku:'SKU',track_inventory:true}}]};
 const calls=[];const api={request:async q=>{assert.match(q,/^query /);calls.push(q);return {Order:structuredClone(bc)};}};
 const proof={bcId:7,stockOnBc:true,logIds:['debit']};return {o,bc,api,calls,proof};
}
test('verified physical debit recovers policy using read-only confirmation',async()=>{
 const f=fixture();assert.equal(await reconcileNativeBcDebit(f.api,f.o,f.bc,{prove:async()=>f.proof}),true);
 assert.equal(f.o.erp_live.bcReservationPolicy,undefined);assert.equal(f.o.erp_live.stockPolicyRecovery.previousPolicy,'erplain_bc_bl');assert.equal(f.calls.length,1);
});
test('negative stock never recovers',async()=>{
 const f=fixture();f.bc.line_items[0].on_hand=-1;const before=structuredClone(f.o);
 assert.equal(await reconcileNativeBcDebit(f.api,f.o,f.bc,{prove:async()=>assert.fail('must not prove')}),false);assert.deepEqual(f.o,before);assert.equal(f.calls.length,0);
});
test('reservation-only evidence cannot replace physical debit',async()=>{
 const f=fixture();f.proof.stockModel='erplain_native_cycle';const before=structuredClone(f.o);
 await assert.rejects(()=>reconcileNativeBcDebit(f.api,f.o,f.bc,{prove:async()=>f.proof}),/débit physique/);assert.deepEqual(f.o,before);
});
test('concurrent quantity change keeps original policy',async()=>{
 const f=fixture();const before=structuredClone(f.o);f.api.request=async()=>{const bc=structuredClone(f.bc);bc.line_items[0].quantity++;return {Order:bc};};
 await assert.rejects(()=>reconcileNativeBcDebit(f.api,f.o,f.bc,{prove:async()=>f.proof}),/modifié/);assert.deepEqual(f.o,before);
});
test('tenders keep their separate stock cycle',async()=>{
 const f=fixture();f.o.channel='tender';assert.equal(await reconcileNativeBcDebit(f.api,f.o,f.bc,{prove:async()=>assert.fail('must not prove')}),false);assert.equal(f.calls.length,0);
});
