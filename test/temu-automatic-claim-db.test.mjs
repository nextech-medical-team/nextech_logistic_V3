import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {temuShipping,initializeTemuShipping} from '../src/temu-shipping.mjs';
test('real PostgreSQL claim validates the unchanged order and rejects a concurrent stock hold',async()=>{
 const db=new PGlite();try{
 await db.exec("CREATE TABLE orders(id text,reference text,channel text,archived boolean DEFAULT false,simulation boolean DEFAULT false,partial_mode boolean DEFAULT false,resolution_pending_resume boolean DEFAULT false,issue text,transport_choice text,erp_live jsonb DEFAULT '{}',source_payload jsonb DEFAULT '{}',address jsonb DEFAULT '{}',suspension jsonb DEFAULT '{}',weight_kg numeric);CREATE TABLE erp_live_jobs(order_id text,status text);CREATE TABLE correction_jobs(order_id text,status text);CREATE TABLE resolution_jobs(order_id text,status text);CREATE TABLE carrier_jobs(order_id text);CREATE TABLE carrier_documents(order_id text);CREATE TABLE extra_parcels(order_id text);");
 await initializeTemuShipping(db);
 const reference='PO-069-123456789';await db.query("INSERT INTO orders(id,reference,channel) VALUES('o',$1,'temu')",[reference]);await db.query("INSERT INTO erp_live_jobs VALUES('o','complete')");
 let calls=0;const api={canBuy:true,async buy(){calls++;throw Error('unknown response');},async read(method){
 if(method==='bg.order.detail.v2.get')return {parentOrderMap:{parentOrderSn:reference,parentOrderStatus:2,expectShipLatestTime:Math.floor(Date.now()/1000)+86400},orderList:[{orderSn:'line',quantity:1}]};
 if(method==='bg.logistics.shipment.v2.get')return {shipmentInfoDTO:[]};
 if(method==='bg.logistics.warehouse.list.get')return {warehouseList:[{warehouseId:1,defaultWarehouse:true}]};
 if(method==='bg.logistics.shippingservices.get')return {onlineChannelDtoList:[{channelId:1,shipCompanyId:1,shippingCompanyName:'GOFO',estimatedAmount:'6',estimatedCurrencyCode:'EUR'}]};
 throw Error(method);
 }};
 const service=temuShipping(db,api),plan=await service.prepare(reference);
 const proof={id:'o',erpLive:{},sourcePayload:{},address:{},suspension:{},weight:null};
 await assert.rejects(service.buy(reference,plan.id,plan.amount,{beforeClaim:async()=>{
 await db.query("UPDATE orders SET issue='Stock insuffisant' WHERE id='o'");return {orderProof:proof};
 }}),/modifiés/);assert.equal(calls,0);assert.equal((await db.query('SELECT attempt_id FROM temu_label_jobs')).rows[0].attempt_id,null);
 await db.query("UPDATE orders SET issue=null WHERE id='o'");
 await assert.rejects(service.buy(reference,plan.id,plan.amount,{beforeClaim:async()=>({orderProof:proof})}),/incertain/);
 assert.equal(calls,1);assert.equal((await db.query('SELECT status FROM temu_label_jobs')).rows[0].status,'uncertain');
 await assert.rejects(service.buy(reference,plan.id,plan.amount),/déjà tenté/);assert.equal(calls,1);
 }finally{await db.close();}
});

