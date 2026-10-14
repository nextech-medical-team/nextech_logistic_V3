import test from 'node:test';import assert from 'node:assert/strict';
import {assertPublishedBcReservation,confirmsDocumentReservation,publishIncrementalBc} from '../src/bc-numbering.mjs';
const bc={id:1,label:'C1',status:'active',update_stock:true,available_for_shipping:true,need_reorder:false,reserved_quantity:2,committed_quantity:0,shipped_quantity:0,line_items:[{type:'normal',quantity:2,reserved_quantity:0,shipped_quantity:0,variant:{id:1,track_inventory:true}}]};
test('authoritative shipping-ready document counters accept zero line reservation without mutating source',()=>{
 const before=JSON.stringify(bc);assert.doesNotThrow(()=>assertPublishedBcReservation(bc,true));assert.equal(JSON.stringify(bc),before);
});
test('committed and remaining reserved stock share the document proof',()=>assert.doesNotThrow(()=>assertPublishedBcReservation({...bc,committed_quantity:1,reserved_quantity:1},true)));
for(const [name,patch] of Object.entries({stockShortage:{available_for_shipping:false},reorder:{need_reorder:true},incompleteCounters:{reserved_quantity:undefined},wrongQuantity:{reserved_quantity:1},unpublished:{status:'unpublished'},negative:{committed_quantity:-1},unknownTracking:{line_items:[{...bc.line_items[0],variant:{id:1}}]}}))test('unverified document remains blocked: '+name,()=>{
 assert.equal(confirmsDocumentReservation({...bc,...patch}),false);assert.throws(()=>assertPublishedBcReservation({...bc,...patch},true));
});
test('shipping readiness does not waive immutable stock policy',()=>assert.throws(()=>assertPublishedBcReservation(bc,false),/Politique/));
test('legacy line-level reservation remains accepted without new document metadata',()=>assert.doesNotThrow(()=>assertPublishedBcReservation({...bc,available_for_shipping:undefined,reserved_quantity:undefined,line_items:[{...bc.line_items[0],reserved_quantity:2}]},true)));
test('invalid line quantity cannot use aggregate proof',()=>assert.throws(()=>assertPublishedBcReservation({...bc,line_items:[{...bc.line_items[0],shipped_quantity:3}]},true)));
test('already active document is read once and never republished',async()=>{
 let calls=0;const api={request:async query=>{assert(query.startsWith('query '));assert(query.includes('available_for_shipping'));calls++;return {Order:bc};}};
 const result=await publishIncrementalBc(api,'1',{verify:x=>assertPublishedBcReservation(x,true),expectedStockPolicy:true,lock:fn=>fn()});assert.deepEqual(result,bc);assert.equal(calls,1);
});
