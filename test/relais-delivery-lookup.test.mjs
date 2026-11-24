import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {lookupRelaisDelivery,handleRelaisDeliveryLookup} from '../src/relais-delivery-lookup.mjs';

test('retrouve le BL partiel correspondant précisément au colis',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`
   CREATE TABLE orders(id text,reference text,channel text,erp_live jsonb,archived boolean,partial_mode boolean,simulation boolean);
   CREATE TABLE carrier_jobs(order_id text,environment text,status text,tracking jsonb);
   CREATE TABLE temu_label_jobs(reference text,status text,packages jsonb,result jsonb);
   CREATE TABLE extra_parcels(order_id text,delivery_id text,environment text,status text,tracking text);
   CREATE TABLE partial_deliveries(id text,order_id text,environment text,status text,bl jsonb,tracking jsonb);
   INSERT INTO orders VALUES('o1','404-1798613-2678742','amazon','{}',false,true,false);
   INSERT INTO partial_deliveries VALUES
    ('p1','o1','production','ready','{"id":"24","label":"SHO00748928"}','["YT2600321616006363"]'),
    ('p2','o1','production','ready','{"id":"25","label":"SHO00748929"}','["GFFR26324156851852"]'),
    ('p3','o1','test','ready','{"id":"26","label":"SHO00748930"}','["YT0000000000000000"]');
   INSERT INTO extra_parcels VALUES('o1','p1','production','ready','GOFOEXTRA1');
  `);
  const calls=[];
  const api={verify:async()=>{},async request(query,{id}){
   assert.match(query,/^query/);calls.push(id);
   return {ShippingOrder:{id,label:'SHO00748928',status:'ready_to_ship',line_items:[{id:7,sku:'ABC',quantity:1}]}};
  }};
  const byTracking=await lookupRelaisDelivery(db,api,{tracking:'YT2600321616006363',bl:'',reference:''});
  assert.equal(byTracking.delivery.line_items[0].sku,'ABC');
  assert.equal(byTracking.delivery.orderReference,'404-1798613-2678742');
  assert.equal((await lookupRelaisDelivery(db,api,{tracking:'GOFOEXTRA1',bl:'',reference:''})).status,200);
  assert.equal((await lookupRelaisDelivery(db,api,{tracking:'',bl:'',reference:'404-1798613-2678742'})).status,409);
  assert.equal((await lookupRelaisDelivery(db,api,{tracking:'YT0000000000000000',bl:'',reference:''})).status,404);
  assert.deepEqual(calls,['24','24']);
  await db.exec(`
   INSERT INTO orders VALUES('o2','PO-TEST','temu','{"bl":{"id":"24","label":"SHO00748928"}}',false,false,false);
   INSERT INTO temu_label_jobs VALUES('PO-TEST','complete','["PK-123"]',
    '{"packageInfoResultList":[{"packageSn":"PK-123","trackingNumber":"YT1234567890"},{"packageSn":"PK-999","trackingNumber":"YT9999999999"}]}');
  `);
  assert.equal((await lookupRelaisDelivery(db,api,{tracking:'YT1234567890',bl:'',reference:''})).status,200);
  assert.equal((await lookupRelaisDelivery(db,api,{tracking:'YT9999999999',bl:'',reference:''})).status,404);
  assert.equal((await lookupRelaisDelivery(db,api,{tracking:'YT1234567890',bl:'SHO00748929',reference:''})).status,404);
  assert.deepEqual(calls,['24','24','24']);
 }finally{await db.close();}
});
test('un appel sans le jeton dédié ne lit aucune donnée',async()=>{
 const replies=[];
 await handleRelaisDeliveryLookup({req:{method:'GET',headers:{authorization:'Bearer wrong'}},res:{},url:new URL('https://v3.test/api/relais/delivery?bl=SHO00748928'),token:'a'.repeat(32),json:(_res,status)=>replies.push(status)});
 assert.deepEqual(replies,[401]);
});
