import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseCorrectionOffer,assertCorrectionParcel} from '../scripts/temu-paid-label-correction.mjs';
const ref='PO-069-123456789';
const parcel={packageSn:'PK-123',warehouseId:'WH-03738368983180591',shippingLabelStatus:1,isConfirmAfterPickup:true,trackingNumber:'OLD',shippingCompanyName:'colissimo',channelId:10,shipCompanyId:20,orderSendInfoList:[{parentOrderSn:ref,orderSn:'069-123',quantity:1}],weight:'0.25',weightUnit:'kg',length:'10.00',width:'8.00',height:'0.50',dimensionUnit:'cm'};
const offer=(name,channelId,amount,extra={})=>({shippingCompanyName:name,channelId,shipCompanyId:20,estimatedAmount:amount,estimatedCurrencyCode:'EUR',...extra});
test('prefer eligible GOFO while retaining dimensions, quantities and delayed confirmation',()=>{
 const chosen=chooseCorrectionOffer({onlineChannelDtoList:[offer('colissimo',10,'4.84'),offer('GOFO FRANCE',11,'2.67')]},parcel);
 assert.equal(chosen.channelId,11);assert.equal(chosen.parcel.warehouseId,'WH-07213277470860591');assert.equal(chosen.parcel.autoConfirmAfterPickup,true);assert.equal(chosen.parcel.weight,'0.25');assert.deepEqual(chosen.parcel.orderSendInfoList,parcel.orderSendInfoList);
});
test('unavailable GOFO cannot replace existing carrier; never choose Cainiao',()=>{
 const chosen=chooseCorrectionOffer({onlineChannelDtoList:[offer('colissimo',10,'4.84'),offer('GOFO',11,'2.67',{unavailableReason:'Outside area'}),offer('CAINIAO',12,'1.00')]},parcel);
 assert.equal(chosen.channelId,10);
});
test('required signature prevents unsupported GOFO substitution',()=>{
 const chosen=chooseCorrectionOffer({onlineChannelDtoList:[offer('colissimo',10,'4.84',{signServiceId:1}),offer('GOFO',11,'2.67')]},parcel,{signature:true});assert.equal(chosen.channelId,10);
});
test('no eligible service returns no proposal',()=>{
 assert.equal(chooseCorrectionOffer({onlineChannelDtoList:[offer('CAINIAO',12,'1.00')]},parcel),null);
});
test('reject shipped, grouped, failed or unrelated parcels',()=>{
 assert.doesNotThrow(()=>assertCorrectionParcel(parcel,ref));
 for(const change of [{shippingLabelStatus:2},{isConfirmAfterPickup:false},{shippingCompanyName:'GOFO'},{warehouseId:'other'},{subPackageSnList:['PK-2']},{orderSendInfoList:[{parentOrderSn:'PO-069-other'}]}])assert.throws(()=>assertCorrectionParcel({...parcel,...change},ref));
});
