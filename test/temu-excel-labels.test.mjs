import test from 'node:test';
import assert from 'node:assert/strict';
import {createTemuExcelTestDatabase} from './support/temu-excel-db.mjs';
import {temuShipping} from '../src/temu-shipping.mjs';
import {excelLabels} from '../scripts/temu-excel-labels.mjs';
const reference='PO-069-123456789',now=Math.floor(Date.now()/1000);
async function fixture(t){
 const db=await createTemuExcelTestDatabase();t.after(()=>db.close());
 const state={companyId:101406,complete:true,version:2,bc:{id:'bc'},bl:{id:'bl',status:'pending'}};
 await db.query("INSERT INTO orders(id,channel,reference,address,source_payload,suspension) VALUES('o','temu',$1,$2,$3,$4)",[reference,JSON.stringify({country:'FR'}),JSON.stringify({origin:'temu_excel'}),JSON.stringify({active:true,note:'Import Excel TEMU : vérifier la commande et sa boutique avant toute préparation.'})]);
 await db.query("INSERT INTO lines(id,order_id,source_line,quantity) VALUES('l','o','line',1)");
 let bought=0,uncertain=false;const requests=[];
 const detail={parentOrderMap:{parentOrderSn:reference,parentOrderStatus:2,expectShipLatestTime:now+86400*4},orderList:[{orderSn:'line',quantity:1}]};
 const api={canBuy:true,async buy(request){bought++;requests.push(request);if(uncertain)throw Error('timeout');return {packageSnList:['PK-123']};},async pdf(){return Buffer.from('%PDF-fixture');},async read(type){
  if(type==='bg.order.detail.v2.get')return detail;
  if(type==='bg.logistics.shipment.v2.get')return {shipmentInfoDTO:bought?[{packageSn:'PK-123',parentOrderSn:reference}]:[]};
  if(type==='bg.logistics.warehouse.list.get')return {warehouseList:[{warehouseId:1,defaultWarehouse:true}]};
  if(type==='bg.logistics.shippingservices.get')return {onlineChannelDtoList:[{channelId:1,shipCompanyId:1,estimatedAmount:'2.50',estimatedCurrencyCode:'EUR',availablePickupTimeSlotList:[{pickupStartTime:now+86400,pickupEndTime:now+86401},{pickupStartTime:now+172800,pickupEndTime:now+172801},{pickupStartTime:now+500000,pickupEndTime:now+500001}]}]};
  if(type==='bg.logistics.shipment.result.get')return {packageInfoResultList:[{packageSn:'PK-123',shippingLabelStatus:1,trackingNumber:'TRACK',orderSendInfoList:[{parentOrderSn:reference}]}]};
  if(type==='bg.logistics.shipment.document.get')return {shippingLabelUrlList:[{packageSn:'PK-123',documentType:'SHIPPING_LABEL_PDF',url:'https://example.invalid/label.pdf'}]};
  throw Error(type);
 }};
 const options={db,documents:{state:async()=>state},shops:async()=>new Map([['shop',{country:'FR',api}]])};
 const service=await excelLabels(options);
 return {db,state,detail,service,options,requests,api,get bought(){return bought;},set uncertain(v){uncertain=v;}};
}
test('Excel purchase uses 0.25kg, latest permitted slot, downloads PDF and prevents duplicate purchase',async t=>{
 const f=await fixture(t),s=f.service,p=await s.prepare({reference,mall:'shop'});
 assert.equal(f.bought,0);const parcel=p.request.sendRequestList[0];assert.equal(parcel.weight,'0.25');assert.equal(parcel.length,'10.00');assert.equal(parcel.width,'8.00');assert.equal(parcel.height,'0.50');assert.equal(parcel.pickupStartTime,now+172800);
 const input={reference,planId:p.id,amount:p.amount,confirmPurchase:true};
 await assert.rejects(s.buy({...input,confirmPurchase:false}),/Confirmation/);
 const results=await Promise.allSettled([s.buy(input),s.buy(input)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.bought,1);
 assert.equal((await s.info(reference)).status,'complete');assert.equal((await s.pdf(reference,'PK-123')).toString(),'%PDF-fixture');
 await assert.rejects(s.prepare({reference,mall:'shop'}),/déjà engagé/);
 const restarted=await excelLabels(f.options);await restarted.recover({reference});assert.equal(f.bought,1);
 const o=(await f.db.query('SELECT * FROM orders')).rows[0];assert.equal(o.suspension.active,true);assert.equal(o.source_payload.origin,'temu_excel');
});
test('changed documents, unknown shop, wrong lines and quantities block purchase',async t=>{
 const f=await fixture(t),s=f.service;
 await assert.rejects(s.prepare({reference,mall:'other'}),/boutique/);
 f.state.complete=false;await assert.rejects(s.prepare({reference,mall:'shop'}),/BC et BL/);f.state.complete=true;
 f.detail.orderList[0].quantity=2;await assert.rejects(s.prepare({reference,mall:'shop'}),/quantités/);f.detail.orderList[0].quantity=1;
 const p=await s.prepare({reference,mall:'shop'});f.state.bl.id='changed';await assert.rejects(s.buy({reference,planId:p.id,amount:p.amount,confirmPurchase:true}),/modifiés/);assert.equal(f.bought,0);
});
test('uncertain purchase remains recoverable after restart and is never repurchased',async t=>{
 const f=await fixture(t),p=await f.service.prepare({reference,mall:'shop'});f.uncertain=true;
 const input={reference,planId:p.id,amount:p.amount,confirmPurchase:true};await assert.rejects(f.service.buy(input),/incertain/);
 const restarted=await excelLabels(f.options);await assert.rejects(restarted.buy(input),/déjà tenté/);assert.equal(f.bought,1);
 await restarted.recover({reference});assert.equal((await restarted.info(reference)).status,'complete');assert.equal(f.bought,1);
});

test('Excel and the existing API shipping engine produce identical quotes, purchases and PDFs',async t=>{
 const apiOrder=await fixture(t),excelOrder=await fixture(t);
 await apiOrder.db.exec("ALTER TABLE orders ADD COLUMN erp_live jsonb DEFAULT '{}'::jsonb");
 await apiOrder.db.query("UPDATE orders SET suspension='{}'::jsonb,source_payload='{}'::jsonb,erp_live='{\"bl\":{\"id\":\"bl\",\"status\":\"pending\"}}'::jsonb");
 const existing=temuShipping(apiOrder.db,apiOrder.api);
 const oldPlan=await existing.prepare(reference),excelPlan=await excelOrder.service.prepare({reference,mall:'shop'});
 // Production binds its quote ID to the recorded BL; the isolated Excel
 // adapter binds the same supplier request to its separate document state.
 assert.deepEqual(excelPlan.request,oldPlan.request);assert.equal(oldPlan.blAuthority.blId,'bl');assert.equal(excelPlan.amount,oldPlan.amount);
 const oldResult=await existing.buy(reference,oldPlan.id,oldPlan.amount);
 const excelResult=await excelOrder.service.buy({reference,planId:excelPlan.id,amount:excelPlan.amount,confirmPurchase:true});
 assert.deepEqual(excelOrder.requests,apiOrder.requests);assert.equal(excelResult.status,oldResult.status);
 const oldPdf=(await apiOrder.db.query('SELECT pdf FROM temu_label_documents WHERE reference=$1',[reference])).rows[0].pdf;
 assert.deepEqual(await excelOrder.service.pdf(reference,'PK-123'),Buffer.from(oldPdf));
});
