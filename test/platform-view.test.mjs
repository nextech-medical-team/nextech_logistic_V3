import test from 'node:test';import assert from 'node:assert/strict';
import {platformIndicativeView} from '../src/platform-indicative-view.mjs';
import {logisticsObservation,attachLogisticsObservations} from '../src/logistics-observation-view.mjs';
import {cancellationBlock} from '../src/erp-transient-policy.mjs';
import {productCreationBlock} from '../src/missing-product-creation.mjs';
import {safeFinancialRecovery} from '../src/financial-review-recovery.mjs';
const now=Date.parse('2026-10-10T12:00:00Z');
test('The newest provider observation supplies a coherent indicative state',()=>{
 const source_payload={platformStatusObservation:{observedAt:'2026-10-10T12:00:00Z',payload:{fulfillment_status:'fulfilled',financial_status:'paid'}},shopifyCancellationSync:{proof:{observedAt:'2026-10-10T11:00:00Z',fulfillment_status:'unfulfilled',financial_status:'refunded',cancelled_at:'2026-10-10'}}};
 let v=platformIndicativeView({channel:'shopify',source_payload});
 assert.equal(v.status,'fulfilled');assert.equal(v.financialStatus,'paid');assert.equal(v.cancelled,false);assert.equal(v.observedAt,'2026-10-10T12:00:00Z');
 source_payload.shopifyCancellationSync.proof.observedAt='2026-10-10T12:01:00Z';
 v=platformIndicativeView({channel:'shopify',source_payload});assert.equal(v.status,'unfulfilled');assert.equal(v.cancelled,true);
});
test('Three states can disagree without changing cancellation/product/finance policy',()=>{
 for(const channel of ['shopify','temu','amazon'])for(const status of [1,2,3,4,5]){
  const o={channel,archived:false,partial_mode:false,resolution_pending_resume:false,reference:'TEST',label_status:'pending',tracking_status:'not_shipped',source_payload:{cancelled:true,cancelled_at:'2026-10-10',financial_status:'refunded',fulfillment_status:'fulfilled',OrderStatus:'Shipped',temuOrderDetail:{parentOrderMap:{parentOrderStatus:status}}},erp_live:{}};
  assert.equal(cancellationBlock(o),null);assert.equal(productCreationBlock(o),false);assert.equal(safeFinancialRecovery(o),true);
  assert.equal(platformIndicativeView(o).indicative,true);
  assert.equal(cancellationBlock({...o,suspension:{active:true,note:'human'}}),'Commande suspendue : human');
  assert.match(cancellationBlock({...o,label_status:'cancelled'}),/V3/);
 }
});
test('TEMU actual delivery events remain authoritative and stale reads become unknown',()=>{
 const t={carrier:'temu',tracking:'T1',checkedAt:'2026-10-10T11:59:00Z',events:[{carrier:'temu',tracking:'T1',code:'DELIVERED',label:'Delivered',at:'2026-10-10T11:00:00Z'}]};
 assert.equal(logisticsObservation([t],{now}).status,'delivered');
 assert.equal(logisticsObservation([{...t,checkedAt:'2026-10-09T00:00:00Z'}],{now}).status,'unknown');
 assert.equal(logisticsObservation([{...t,error:'API unavailable'}],{now}).status,'unknown');
 assert.equal(logisticsObservation([{...t,tracking:'OTHER'}],{now}).status,'unknown');
 assert.equal(logisticsObservation([{...t,checkedAt:'2026-10-11T00:00:00Z'}],{now}).status,'unknown');
});
test('A declared marketplace shipment never supplies missing parcel scans',()=>{
 assert.equal(logisticsObservation([],{now}).status,'unknown');
 const v=platformIndicativeView({channel:'shopify',source_payload:{fulfillment_status:'fulfilled'}});
 assert.equal(v.status,'fulfilled');assert.equal(v.observedAt,null);
});
test('Partial TEMU uses verified parcel events and preserves other existing parcels',async()=>{
 const checkedAt=new Date().toISOString();const row={id:'partial-temu',channel:'temu',partial_mode:true,temu_job:{result:{trackingVerifiedAt:checkedAt,packageInfoResultList:[{packageSn:'PK-1',trackingNumber:'T1'},{packageSn:'PK-2',trackingNumber:'OTHER'}],deliveryStatuses:[{source:'temu_tracking',trackingKey:'T1',code:'DELIVERED',label:'Delivered',at:checkedAt}]}}};
 const db={query:async()=>({rows:[{order_id:row.id,carrier:'temu',tracking:'T1',checkedAt:null,events:[]}]})};
 await attachLogisticsObservations(db,[row]);assert.equal(row.logistics_observation.status,'delivered');assert.equal(row.logistics_observation.parcels.length,1);assert.equal(row.logistics_observation.parcels[0].tracking,'T1');
});
