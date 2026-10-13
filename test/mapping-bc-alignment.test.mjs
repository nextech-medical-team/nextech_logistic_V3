import test from 'node:test';
import assert from 'node:assert/strict';
import {alignMappedBc,assertAdditionalMappingStock} from '../src/mapping-bc-alignment.mjs';
for(const channel of ['temu','amazon','shopify','tender','erplain'])test(channel+' existing BC is never rewritten from a later mapping',async()=>{
 const order={channel,erp_live:{bc:{id:10}},pricing:{items:[{quantity:999}]}};const before=structuredClone(order);
 const r=await alignMappedBc({request:()=>assert.fail('No source alignment read or write')},order,{});
 assert.equal(r.sourceAlignmentDisabled,true);assert.deepEqual(order,before);
});
test('uncertain previous mapping mutation is retained and never replayed',async()=>{
 const order={erp_live:{bc:{id:10},mappingAlignmentAttempt:{status:'uncertain'}}};
 await assert.rejects(alignMappedBc({request:()=>assert.fail('No replay')},order,{}),/incertaine/);assert.equal(order.erp_live.mappingAlignmentAttempt.status,'uncertain');
});
test('only additional mapped units require available stock, never the previously debited quantity',async()=>{
 const item=(id,quantity)=>({type:'normal',variant:{id,sku:id},location:{id:'1'},quantity});const bc={update_stock:true,line_items:[item('2',3000)]};let calls=0;
 const api={request:async(q,{id})=>{calls++;assert.ok(q.startsWith('query '));return {Variant:{id,sku:id,active:true,track_inventory:true,product:{id:'p',active:true},stock_levels:{data:[{location:{id:'1'},available:20,on_hand:20}],paginatorInfo:{hasMorePages:false}}}};}};
 await assertAdditionalMappingStock(api,bc,[item('2',20)]);assert.equal(calls,0);
 await assertAdditionalMappingStock(api,bc,[item('2',3020)]);assert.equal(calls,1);
 await assertAdditionalMappingStock(api,bc,[item('3',20)]);assert.equal(calls,2);
 await assert.rejects(assertAdditionalMappingStock(api,bc,[item('2',3021)]),/stock insuffisant/);
});
test('additional stock requires complete data for the exact active variant and location',async()=>{
 const item={type:'normal',variant:{id:'2'},location:{id:'1'},quantity:20},bc={update_stock:true,line_items:[]};
 for(const extra of [{id:'other'},{active:false},{track_inventory:undefined},{stock_levels:{data:[],paginatorInfo:{hasMorePages:false}}},{stock_levels:{data:[],paginatorInfo:{hasMorePages:true}}}]){
 const api={request:async()=>({Variant:{id:'2',active:true,track_inventory:true,product:{id:'p',active:true},...extra}})};await assert.rejects(assertAdditionalMappingStock(api,bc,[item]));
 }
});
