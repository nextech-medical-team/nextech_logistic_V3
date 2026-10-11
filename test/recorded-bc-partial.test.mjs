import test from 'node:test';
import assert from 'node:assert/strict';
import {partialService} from '../src/partial-deliveries.mjs';
function fixture(channel){
 const state={order:{id:'o',reference:'ORDER',channel,source_payload:{oldMarketplaceValue:'preserved'},erp_live:{bc:{id:'1'},pricing:{total:999,currency:'USD',status:'blocked'}},partial_mode:false},lines:[{source_sku:'OTHER',target_sku:'OTHER',quantity:999,target_quantity:false,source_qty:0,target_qty:1000}]};
 const bc={id:'1',label:'BC1',status:'active',external_reference:'ORDER',total:10,currency:{label:'EUR'},update_stock:true,shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}},line_items:[{id:'100',type:'normal',quantity:2,price:5,tax_amount:0,shipped_quantity:0,reserved_quantity:0,available:2,on_hand:2,variant:{id:'10',sku:'BC-PRODUCT',track_inventory:true},location:{id:'20'}}]};
 const queries=[];
 const api={verify:async()=>{},request:async q=>{assert.match(q,/^query /);queries.push(q);return {Order:structuredClone(bc)};}};
 const db={query:async(sql,args=[])=>{
  if(sql.startsWith('SELECT * FROM orders'))return {rows:[structuredClone(state.order)]};
  if(sql.startsWith('SELECT 1 FROM erp_live_jobs'))return {rows:[]};
  if(sql.startsWith('SELECT l.*,m.target_sku'))return {rows:structuredClone(state.lines)};
  if(sql.startsWith('SELECT id,error,result,action FROM resolution_jobs')||sql.startsWith('SELECT id,action,status,error,result,created_at,updated_at FROM resolution_jobs')||sql.startsWith('SELECT status,error FROM erp_live_jobs'))return {rows:[]};
  if(sql.startsWith('UPDATE orders SET erp_live=$2')){state.order.erp_live=JSON.parse(args[1]);return {rows:[]};}
  if(sql.startsWith('UPDATE orders SET erp_live=jsonb_set')){state.order.erp_live.bcComparisonRefresh=JSON.parse(args[1]);return {rows:[]};}
  if(sql.startsWith('SELECT id,status,selection,bl,carrier')||sql.startsWith('SELECT c.status')||sql.startsWith('SELECT 1 FROM partial_deliveries'))return {rows:[]};
  assert.fail('Unexpected SQL: '+sql);
 },transaction:async fn=>fn(db)};
 return {state,bc,api,db,queries};
}
for(const channel of ['amazon','shopify'])test(channel+' partial snapshot uses BC lines and amounts despite stale source data',async()=>{
 const f=fixture(channel),before=structuredClone(f.state.lines);
 const r=await partialService(f.db,'unused',{api:f.api}).snapshot('o');
 assert.equal(r.lines[0].sku,'BC-PRODUCT');assert.equal(r.lines[0].ordered,2);assert.equal(r.lines[0].remaining,2);assert.equal(r.lines[0].price,5);
 assert.deepEqual(f.state.lines,before);assert.equal(f.state.order.source_payload.oldMarketplaceValue,'preserved');
 assert.ok(f.queries.every(q=>q.startsWith('query ')));
});
test('partial snapshot retains actual cancelled BC protection',async()=>{
 const f=fixture('amazon');f.bc.status='cancelled';
 await assert.rejects(partialService(f.db,'unused',{api:f.api}).snapshot('o'),/Identité ou état/);
 assert.ok(f.queries.every(q=>q.startsWith('query ')));
});
test('TEMU partial snapshot retains its dedicated transport restriction',async()=>{
 const f=fixture('temu');
 await assert.rejects(partialService(f.db,'unused',{api:f.api}).snapshot('o'),/Livraison partielle non disponible/);
 assert.ok(f.queries.every(q=>q.startsWith('query ')));
});
