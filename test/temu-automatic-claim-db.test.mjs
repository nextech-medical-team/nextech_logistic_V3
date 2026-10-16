import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {initializeTemuAutomaticPurchase} from '../src/temu-automatic-purchase.mjs';import {temuShipping,initializeTemuShipping} from '../src/temu-shipping.mjs';
test('real PostgreSQL claim validates the unchanged order and rejects changed financial inputs',async()=>{
 const db=new PGlite();try{
 await db.exec("CREATE TABLE orders(id text,reference text,channel text,archived boolean DEFAULT false,simulation boolean DEFAULT false,partial_mode boolean DEFAULT false,resolution_pending_resume boolean DEFAULT false,issue text,transport_choice text,erp_live jsonb DEFAULT '{}',source_payload jsonb DEFAULT '{}',address jsonb DEFAULT '{}',suspension jsonb DEFAULT '{}',weight_kg numeric,tracking_status text,label_status text);CREATE TABLE erp_live_jobs(order_id text,status text);CREATE TABLE correction_jobs(order_id text,status text);CREATE TABLE resolution_jobs(order_id text,status text);CREATE TABLE carrier_jobs(order_id text);CREATE TABLE carrier_documents(order_id text);CREATE TABLE extra_parcels(order_id text);CREATE TABLE lines(id text,source_line text,order_id text,quantity numeric);");
 await initializeTemuShipping(db);await initializeTemuAutomaticPurchase(db);
 const reference='PO-069-123456789';await db.query("INSERT INTO orders(id,reference,channel) VALUES('o',$1,'temu')",[reference]);await db.query("INSERT INTO erp_live_jobs VALUES('o','complete')");
 await db.query("UPDATE temu_automatic_purchase_checks SET next_at=now()+interval '1 day'");await db.query("UPDATE orders SET weight_kg=0.1 WHERE id='o'");assert.equal((await db.query('SELECT next_at<=now() due FROM temu_automatic_purchase_checks')).rows[0].due,true);await db.query("UPDATE orders SET weight_kg=null WHERE id='o'");
 await db.query("UPDATE temu_automatic_purchase_checks SET next_at=now()+interval '1 day'");
 await db.query("INSERT INTO lines VALUES('l','1','o',1)");
 assert.equal((await db.query('SELECT next_at<=now() due FROM temu_automatic_purchase_checks')).rows[0].due,true);
 await db.query("UPDATE temu_automatic_purchase_checks SET next_at=now()+interval '1 day'");
 await db.query("INSERT INTO correction_jobs VALUES('o','complete')");
 assert.equal((await db.query('SELECT next_at<=now() due FROM temu_automatic_purchase_checks')).rows[0].due,true);
 await db.exec("CREATE TABLE order_recheck_monitor(order_id text,next_check timestamptz,requested bigint);INSERT INTO order_recheck_monitor VALUES('o',now()+interval '1 day',1)");
 await db.query("UPDATE temu_automatic_purchase_checks SET result='{\"status\":\"held\",\"message\":\"Marge négative\"}'::jsonb");
 const monitor=(await db.query('SELECT next_check<=now() due,requested FROM order_recheck_monitor')).rows[0];assert.equal(monitor.due,true);assert.equal(Number(monitor.requested),2);
 const deadline=Math.floor(Date.now()/1000)+86400;let calls=0;const api={canBuy:true,async buy(){calls++;throw Error('unknown response');},async read(method){
 if(method==='bg.order.detail.v2.get')return {parentOrderMap:{parentOrderSn:reference,parentOrderStatus:2,expectShipLatestTime:deadline},orderList:[{orderSn:'line',quantity:1}]};
 if(method==='bg.logistics.shipment.v2.get')return {shipmentInfoDTO:[]};
 if(method==='bg.logistics.warehouse.list.get')return {warehouseList:[{warehouseId:1,defaultWarehouse:true}]};
 if(method==='bg.logistics.shippingservices.get')return {onlineChannelDtoList:[{channelId:1,shipCompanyId:1,shippingCompanyName:'GOFO',estimatedAmount:'6',estimatedCurrencyCode:'EUR'}]};
 throw Error(method);
 }};
 const service=temuShipping(db,api),plan=await service.prepare(reference);
 const proof={id:'o',erpLive:{},sourcePayload:{},address:{},suspension:{},weight:null,lines:(await db.query("SELECT jsonb_agg(to_jsonb(l) ORDER BY source_line,id) lines FROM lines l WHERE order_id='o'")).rows[0].lines};
 await assert.rejects(service.buy(reference,plan.id,plan.amount,{beforeClaim:async()=>{
 await db.query("UPDATE orders SET source_payload='{\"priceChanged\":true}' WHERE id='o'");return {orderProof:proof,allowed:true,audit:{profit:1,planId:plan.id}};
 }}),/modifiés/);assert.equal(calls,0);assert.equal((await db.query('SELECT attempt_id FROM temu_label_jobs')).rows[0].attempt_id,null);
 await db.query("UPDATE orders SET source_payload='{}' WHERE id='o'");
 await assert.rejects(service.buy(reference,plan.id,plan.amount,{beforeClaim:async()=>{
 await db.query("UPDATE lines SET quantity=2 WHERE id='l'");return {orderProof:proof,allowed:true,audit:{profit:1,planId:plan.id}};
 }}),/modifiés/);assert.equal(calls,0);
 proof.lines=(await db.query("SELECT jsonb_agg(to_jsonb(l) ORDER BY source_line,id) lines FROM lines l WHERE order_id='o'")).rows[0].lines;
 await assert.rejects(service.buy(reference,plan.id,plan.amount,{beforeClaim:async()=>({orderProof:proof,allowed:true,audit:{profit:1,planId:plan.id}})}),/incertain/);
 assert.equal(calls,1);assert.equal((await db.query('SELECT status FROM temu_label_jobs')).rows[0].status,'uncertain');
 const audit=(await db.query('SELECT decision FROM temu_automatic_purchase_audit')).rows;assert.equal(audit.length,1);assert.equal(audit[0].decision.profit,1);
 await assert.rejects(service.buy(reference,plan.id,plan.amount),/déjà tenté/);assert.equal(calls,1);
 }finally{await db.close();}
});

