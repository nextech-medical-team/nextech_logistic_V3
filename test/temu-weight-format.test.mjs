import test from 'node:test';
import assert from 'node:assert/strict';
import {temuParcelWeight,temuShipping} from '../src/temu-shipping.mjs';

test('TEMU weights use two decimals rounded upward, including reported failures',()=>{
 for(const [input,expected] of [[1.034,'1.04'],[0.59892,'0.60'],[6.72,'6.72'],[0.25,'0.25'],[1.001,'1.01'],[1,'1.00'],[1.1,'1.10']])assert.equal(temuParcelWeight(input),expected);
 for(const input of [0,-1,NaN,Infinity,'bad'])assert.throws(()=>temuParcelWeight(input),/Poids/);
});
test('service quote and purchase plan share the normalized weight without altering local weight',async()=>{
 const reference='PO-069-123456789',order={weight_kg:1.034},requests=[];
 const db={query:async sql=>({rows:sql.startsWith('SELECT * FROM orders')?[order]:[]})};
 const api={read:async(type,body)=>{
  requests.push({type,body});
  if(type==='bg.order.detail.v2.get')return {parentOrderMap:{parentOrderSn:reference},orderList:[{orderSn:'line',quantity:1}]};
  if(type==='bg.logistics.shipment.v2.get')return {shipmentInfoDTO:[]};
  if(type==='bg.logistics.warehouse.list.get')return {warehouseList:[{warehouseId:1}]};
  if(type==='bg.logistics.shippingservices.get')return {onlineChannelDtoList:[{channelId:1,shipCompanyId:1,estimatedAmount:'2.50',estimatedCurrencyCode:'EUR'}]};
  throw Error(type);
 }};
 const plan=await temuShipping(db,api).prepare(reference);
 assert.equal(requests.find(r=>r.type==='bg.logistics.shippingservices.get').body.weight,'1.04');
 assert.equal(plan.request.sendRequestList[0].weight,'1.04');assert.equal(order.weight_kg,1.034);
});
