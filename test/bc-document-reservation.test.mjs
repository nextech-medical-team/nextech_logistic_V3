import test from 'node:test';import assert from 'node:assert/strict';
import {assertPublishedBcReservation,publishIncrementalBc} from '../src/bc-numbering.mjs';
const bc={id:1,label:'C1',status:'active',update_stock:true,line_items:[{type:'normal',quantity:50,reserved_quantity:0,shipped_quantity:0,variant:{id:1,track_inventory:true}}]};
for(const reserved of [0,1,49,50,51,null,undefined])test('reservation equality removed: '+reserved,()=>{
 const document={...bc,available_for_shipping:false,need_reorder:true,reserved_quantity:0,committed_quantity:0,shipped_quantity:0,line_items:[{...bc.line_items[0],reserved_quantity:reserved}]};
 const before=JSON.stringify(document);assert.doesNotThrow(()=>assertPublishedBcReservation(document,true));assert.equal(JSON.stringify(document),before);
});
test('shipped plus reserved need not equal ordered',()=>assert.doesNotThrow(()=>assertPublishedBcReservation({...bc,line_items:[{...bc.line_items[0],reserved_quantity:0,shipped_quantity:10}]},true)));
test('immutable stock policy remains required',()=>assert.throws(()=>assertPublishedBcReservation(bc,false),/Politique/));
for(const quantity of [0,-1,null,undefined,NaN])test('invalid ordered quantity remains rejected: '+quantity,()=>assert.throws(()=>assertPublishedBcReservation({...bc,line_items:[{...bc.line_items[0],quantity}]},true),/Quantité/));
test('overshipment remains invalid',()=>assert.throws(()=>assertPublishedBcReservation({...bc,line_items:[{...bc.line_items[0],shipped_quantity:51}]},true),/Quantité/));
test('already active BC is read once, never republished to repair reservation',async()=>{
 let calls=0;const api={request:async q=>{assert.match(q,/^query /);calls++;return {Order:bc};}};
 const result=await publishIncrementalBc(api,'1',{verify:d=>assertPublishedBcReservation(d,true),expectedStockPolicy:true,lock:fn=>fn()});assert.deepEqual(result,bc);assert.equal(calls,1);
});
