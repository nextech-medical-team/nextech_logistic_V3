import test from 'node:test';import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {configureTemuOrderApiPolicy,assertTemuOrderApiRead,temuOrderApiPaused} from '../src/temu-order-api-policy.mjs';
import {temuApi} from '../src/temu-api.mjs';
import {temuLocalService} from '../src/temu-local.mjs';
import {receiveMarketplace,applyMarketplaceReceipt,marketplaceInbox} from '../src/marketplace-inbox.mjs';
import {acceptMarketplaceChange} from '../src/marketplace-change.mjs';
const pausedStore={async query(){return {rows:[{value:{enabled:true,channels:{temu:false,shopify:true}}}]};}};
test('paused order API blocks list/detail/address/amount before network; label reads still pass',async()=>{
 configureTemuOrderApiPolicy(pausedStore);let requests=0;
 try{const api=temuApi({TEMU_APP_KEY:'test',TEMU_APP_SECRET:'test',TEMU_ACCESS_TOKEN:'test'},{relay:null,fetchImpl:async()=>{requests++;return {ok:true,json:async()=>({success:true,result:{}})};}});
 for(const type of ['bg.order.list.v2.get','bg.order.detail.v2.get','bg.order.decryptshippinginfo.get','bg.order.amount.query'])await assert.rejects(api.read(type,{}),{code:'TEMU_ORDER_API_PAUSED'});
 assert.equal(requests,0);
 await assert.rejects(api.read('bg.order.amount.query',{}, {purpose:'label'}),{code:'TEMU_ORDER_API_PAUSED'});
 await api.read('bg.order.detail.v2.get',{}, {purpose:'label'});assert.equal(requests,1);
 await assertTemuOrderApiRead('bg.logistics.shipment.result.get');await assertTemuOrderApiRead('bg.logistics.shipment.document.get');await assertTemuOrderApiRead('temu.track.trackinginfo.get');
 }finally{configureTemuOrderApiPolicy(null);}
});
test('paused intake and existing receipt cannot mutate orders, including authorized reimport',async()=>{
 const db={query:async sql=>{assert.match(sql,/SELECT value FROM settings/);return pausedStore.query();}};
 assert.equal((await receiveMarketplace(db,{channel:'temu',shop:'42',deliveryId:'1',payload:{}})).reason,'temu-order-api-paused');
 assert.equal((await applyMarketplaceReceipt(db,{channel:'temu',shop:'42',payload:{}},{})).reason,'temu-order-api-paused');
});
test('label recovery in paused mode preserves command data and existing PDF',async()=>{
 const db=new PGlite();const queries=[];const adapter={query:async(...a)=>{queries.push(a[0]);return db.query(...a);}};
 await db.exec(`CREATE TABLE settings(key text PRIMARY KEY,value jsonb);INSERT INTO settings VALUES('marketplace_automatic','{"enabled":true,"channels":{"temu":false}}');CREATE TABLE orders(id text PRIMARY KEY,channel text,reference text,recipient text,address jsonb,source_payload jsonb);CREATE TABLE lines(id text PRIMARY KEY,order_id text,source_sku text,quantity int);CREATE TABLE temu_label_jobs(reference text PRIMARY KEY,status text,plan jsonb,attempt_id text,packages jsonb,result jsonb,error text,updated_at timestamptz DEFAULT now());CREATE TABLE temu_label_documents(reference text,package text,pdf bytea,PRIMARY KEY(reference,package));INSERT INTO orders VALUES('o','temu','PO-1-2','Client figé','{"street":"Adresse fichier"}','{"mallId":"42","temuAmounts":{"manual":true}}');INSERT INTO lines VALUES('l','o','SKU-FICHIER',3);INSERT INTO temu_label_jobs(reference,status,packages,result) VALUES('PO-1-2','complete','["PK-123"]','{"source":"temu_direct"}');INSERT INTO temu_label_documents VALUES('PO-1-2','PK-123',decode('255044462d6578697374616e74','hex'));`);
 configureTemuOrderApiPolicy(adapter);const before=(await db.query('SELECT * FROM orders')).rows,lines=(await db.query('SELECT * FROM lines')).rows,pdf=(await db.query('SELECT * FROM temu_label_documents')).rows;
 const api={read:async(type,data,options)=>{if(type==='bg.order.detail.v2.get'){assert.equal(options.purpose,'label');return {parentOrderMap:{parentOrderSn:'PO-1-2'},orderList:[{orderSn:'X',quantity:99,productList:[{extCode:'SKU-API-INTERDIT'}],packageSnInfo:[{packageSn:'PK-123'}]}]};}if(type==='bg.logistics.shipment.v2.get')return {shipmentInfoDTO:[{parentOrderSn:'PO-1-2',packageSn:'PK-123'}]};if(type==='bg.open.accesstoken.info.get')return {mallId:'42'};if(type==='bg.logistics.shipment.result.get')return {packageInfoResultList:[{packageSn:'PK-123',shippingLabelStatus:1,orderSendInfoList:[{parentOrderSn:'PO-1-2'}]}]};throw Error('Unexpected API '+type);}};
 try{const local=temuLocalService(adapter,'.',{apiFactory:()=>api,shopLoader:async()=>[],configLoader:async()=>({})});const r=await local.recover('PO-1-2');assert.equal(r.status,'complete');assert.equal(r.orderApiPaused,true);
 assert.deepEqual((await db.query('SELECT * FROM orders')).rows,before);assert.deepEqual((await db.query('SELECT * FROM lines')).rows,lines);assert.deepEqual((await db.query('SELECT * FROM temu_label_documents')).rows,pdf);
 assert.ok(!queries.some(sql=>/UPDATE orders|UPDATE lines|DELETE|INSERT INTO orders/i.test(sql)));
 await db.query("UPDATE temu_label_jobs SET packages='[]' WHERE reference='PO-1-2'");const fresh=await local.recover('PO-1-2');assert.equal(fresh.status,'complete');assert.deepEqual((await db.query('SELECT * FROM orders')).rows,before);assert.deepEqual((await db.query('SELECT * FROM lines')).rows,lines);assert.deepEqual((await db.query('SELECT * FROM temu_label_documents')).rows,pdf);
 assert.deepEqual(await local.collectors(),[]);await assert.rejects(local.amounts('PO-1-2'),{code:'TEMU_ORDER_API_PAUSED'});
 }finally{configureTemuOrderApiPolicy(null);await db.close();}
});
test('inbox leaves paused TEMU receipts pending and does not claim them',async()=>{
 const db=new PGlite();await db.exec(`CREATE TABLE settings(key text PRIMARY KEY,value jsonb);INSERT INTO settings VALUES('marketplace_automatic','{"enabled":true,"channels":{"temu":false}}');CREATE TABLE marketplace_receipts(id text PRIMARY KEY,channel text,status text,updated_at timestamptz DEFAULT now(),created_at timestamptz DEFAULT now());INSERT INTO marketplace_receipts(id,channel,status) VALUES('r','temu','pending');`);
 const wrap=e=>({query:(...a)=>e.query(...a),transaction:fn=>e.transaction(t=>fn(wrap(t)))});
 try{await marketplaceInbox(wrap(db)).run();assert.equal((await db.query('SELECT status FROM marketplace_receipts')).rows[0].status,'pending');}finally{await db.close();}
});
test('stale platform correction cannot overwrite a TEMU order while paused',async()=>{
 configureTemuOrderApiPolicy(pausedStore);
 try{const db={transaction:fn=>fn({query:async sql=>{assert.match(sql,/SELECT \* FROM orders/);return {rows:[{channel:'temu',source_payload:{marketplacePendingCorrection:{}}}]};}})};await assert.rejects(acceptMarketplaceChange(db,'o','test'),{code:'TEMU_ORDER_API_PAUSED'});}finally{configureTemuOrderApiPolicy(null);}
});
test('receipt claimed before suspension is restored instead of consumed',async()=>{
 let restored=false;const original={id:'r',channel:'temu',shop:'42',status:'pending',payload:{}};
 const db={transaction:fn=>fn(db),async query(sql,args){if(sql.startsWith('SELECT * FROM marketplace_receipts'))return {rows:[original]};if(sql.includes("SET status='processing'"))return {rows:[]};if(sql.startsWith('SELECT value FROM settings'))return pausedStore.query();if(sql==='UPDATE marketplace_receipts SET status=$2 WHERE id=$1'){assert.deepEqual(args,['r','pending']);restored=true;return {rows:[]};}throw Error('Unexpected write '+sql);}};
 await marketplaceInbox(db).run();assert.equal(restored,true);
});
