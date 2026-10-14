import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareMissingDraftRecovery} from '../src/missing-draft-recovery.mjs';
function fixture(){
 const order={id:'o1',erp_live:{phase:'publishing_bl',bc:{id:7},bl:{id:9,label:'SHO00744687',status:'unpublished',update_stock:false}}};
 const data={Order:{id:7,status:'active',update_stock:false,shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}}},ShippingOrder:null};
 const stock={StockRemovals:{data:[],paginatorInfo:{hasMorePages:false}}};
 const label={ShippingOrders:{data:[{id:12,label:'SHO00744687',status:'ready_to_ship',orders:{data:[{id:8}],paginatorInfo:{hasMorePages:false}}}],paginatorInfo:{hasMorePages:false}}};
 const requests=[];const db={query:async()=>({rows:[]})};
 const api={request:async(q,v)=>{assert.match(q,/^query /);requests.push({q,v});return q.includes('V3MissingDraftRead')?data:q.includes('V3MissingDraftStock')?stock:label;}};
 return {order,data,stock,label,requests,db,api,run(){return prepareMissingDraftRecovery(db,api,order,{resolutionId:'r1',now:0});}};
}
test('absent draft with number held by another BC: retire only local pointer and preserve proof',async()=>{
 const f=fixture(),before=structuredClone(f.order),next=await f.run();assert.deepEqual(f.order,before);assert.equal(next.phase,'bc_created');assert.equal(next.bl,undefined);assert.deepEqual(next.bc,before.erp_live.bc);assert.equal(next.missingDraftRecoveries[0].retiredDraft.id,9);assert.deepEqual(next.missingDraftRecoveries[0].labelMatches[0].bcIds,['8']);assert.equal(f.requests.length,3);
});
test('no collision and no stock effect permits same safe local recovery',async()=>{const f=fixture();f.label.ShippingOrders.data=[];assert.equal((await f.run()).phase,'bc_created');});
test('existing draft is never retired or duplicated',async()=>{const f=fixture();f.data.ShippingOrder={id:9};assert.equal(await f.run(),null);assert.equal(f.requests.length,1);});
test('other phases do not trigger reconciliation',async()=>{const f=fixture();f.order.erp_live.phase='bl_ready';assert.equal(await f.run(),null);assert.equal(f.requests.length,0);});
for(const [name,change] of [
 ['related BL exists',f=>f.data.Order.shipping_orders.data.push({id:12})],
 ['BC pagination incomplete',f=>f.data.Order.shipping_orders.paginatorInfo.hasMorePages=true],
 ['wrong BC',f=>f.data.Order.id=8],
 ['BC stock enabled',f=>f.data.Order.update_stock=true],
 ['old stock attempt',f=>f.order.erp_live.stockCreationAttemptedAt='2026-10-14'],
 ['confirmed stock outcome',f=>f.order.erp_live.stockCreationOutcome={kind:'confirmed_response'}],
 ['stock document found',f=>f.stock.StockRemovals.data.push({id:4})],
 ['stock read incomplete',f=>f.stock.StockRemovals.paginatorInfo.hasMorePages=true],
 ['number found on our BC',f=>f.label.ShippingOrders.data[0].orders.data=[{id:7}]],
 ['label read incomplete',f=>f.label.ShippingOrders.paginatorInfo.hasMorePages=true],
 ['label relations incomplete',f=>f.label.ShippingOrders.data[0].orders.paginatorInfo.hasMorePages=true],
 ['local carrier or concurrent work',f=>f.db.query=async()=>({rows:[{}]})],
 ['suspended order',f=>f.order.suspension={active:true}],
 ['shipped order',f=>f.order.tracking_status='shipped'],
 ['partial order',f=>f.order.partial_mode=true],
 ['unknown old number',f=>f.order.erp_live.bl.label=undefined],
 ['prior stock cycle',f=>f.order.erp_live.previousCancelledCycle={}],
 ])test(name+' refuses recovery',async()=>{const f=fixture();change(f);await assert.rejects(f.run());assert.ok(f.order.erp_live.bl);});
test('HTTP or GraphQL failure leaves local state intact',async()=>{const f=fixture();f.api.request=async()=>{throw Error('429');};await assert.rejects(f.run(),/429/);assert.equal(f.order.erp_live.phase,'publishing_bl');});
