import test from 'node:test';
import assert from 'node:assert/strict';
import {marketplaceChanged} from '../src/marketplace-comparison.mjs';
import {shopifyCancellationWorker} from '../src/shopify-cancellation-worker.mjs';
import {observeTemuCancellation} from '../src/temu-cancellation-observation.mjs';
import {inspectTemu} from '../src/temu-shipping.mjs';

test('Platform declarations never change the commercial comparison',()=>{
 const lines=[{source_line:'1',source_sku:'SKU',quantity:2}],address={name:'Client',country:'FR'};
 for(const channel of ['shopify','temu','amazon'])for(const cancelled of [false,true])for(const fulfilled of [false,true])for(const partial_mode of [false,true]){
  const existing={channel,partial_mode,address};const incoming={cancelled,fulfilled,address,lines};
  assert.equal(marketplaceChanged(existing,lines,incoming),false);
  assert.equal(marketplaceChanged(existing,lines,{...incoming,lines:[{...lines[0],quantity:3}]}),true);
  assert.equal(marketplaceChanged(existing,lines,{...incoming,address:{...address,country:'HR'}}),true);
 }
});

test('Shopify cancellation/refund is persisted as observation with no external writer',async()=>{
 for(const displayFinancialStatus of ['REFUNDED','PAID'])for(const displayFulfillmentStatus of ['UNFULFILLED','FULFILLED','PARTIALLY_FULFILLED']){
  const calls=[];const db={query:async(sql,params)=>{calls.push({sql,params});return {rows:[]};}};
  const order={id:'v3',channel:'shopify',reference:'#1',source_payload:{id:'12',sourceShop:'example.myshopify.com'}};
  const reader={read:async()=>({shop:'example.myshopify.com',data:{order:{id:'gid://shopify/Order/12',name:'#1',updatedAt:'2026-10-10T12:00:00Z',cancelledAt:'2026-10-10T11:00:00Z',displayFinancialStatus,displayFulfillmentStatus}}})};
  const forbidden=()=>{throw Error('External mutation forbidden');};
  const result=await shopifyCancellationWorker(db,'.',{reader,api:{request:forbidden},lock:forbidden,restore:forbidden,idle:forbidden}).cancel(order);
  assert.equal(result.cancelled,false);assert.equal(calls.length,1);
  assert.equal(calls[0].sql,'UPDATE orders SET source_payload=source_payload||$2::jsonb WHERE id=$1');
  const state=JSON.parse(calls[0].params[1]).shopifyCancellationSync;
  assert.equal(state.status,'observed');assert.equal(state.indicative,true);
 }
});

test('Unavailable platform observation never writes a blocking issue',async()=>{
 const calls=[];const db={query:async(sql,params)=>{calls.push({sql,params});return {rows:[]};}};
 const result=await shopifyCancellationWorker(db,'.',{reader:{read:async()=>{throw Error('quota');}}}).cancel({id:'v3',channel:'shopify',reference:'#1',source_payload:{id:'12'}});
 assert.equal(result.state.status,'unavailable');assert.equal(calls.length,1);assert.equal(calls[0].sql.includes('issue='),false);
});

test('TEMU cancellation observation does not stop package tracking or mutate label jobs',async()=>{
 const calls=[];const db={query:async(sql,params)=>{calls.push({sql,params});return {rows:[]};}};
 const order={id:'v3',channel:'temu',reference:'PO-1-2'};
 assert.equal(await observeTemuCancellation(db,order,{parentOrderMap:{parentOrderSn:'PO-1-2',parentOrderStatus:3}}),false);
 assert.equal(calls.length,1);assert.equal(calls[0].sql.includes('temu_label_jobs'),false);assert.equal(calls[0].sql.includes('tracking_status'),false);
 assert.equal(await observeTemuCancellation(db,order,{parentOrderMap:{parentOrderSn:'PO-other',parentOrderStatus:3}}),false);assert.equal(calls.length,1);
});

test('TEMU commercial statuses do not filter lines or invalidate a verified plan',()=>{
 let fingerprint;
 for(const parentOrderStatus of [1,2,3,4,5])for(const orderStatus of [1,2,3,4,5]){
  const detail={parentOrderMap:{parentOrderSn:'PO-1-2',parentOrderStatus,expectShipLatestTime:1900000000,parentOrderLabel:[{name:'pending_buyer_cancellation',value:1}]},orderList:[{orderSn:'L1',orderStatus,quantity:2,packageSnInfo:[]}]};
  const info=inspectTemu(detail,'PO-1-2');assert.equal(info.lines.length,1);fingerprint??=info.fingerprint;assert.equal(info.fingerprint,fingerprint);
 }
});
