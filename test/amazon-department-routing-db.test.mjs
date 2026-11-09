import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {selectedPreparationRouting} from '../src/selected-preparation-routing.mjs';
import {defaultRouting,loadRouting} from '../src/routing.mjs';
import {amazonDeliveryEstimate} from '../src/amazon-delivery-policy.mjs';
test('new Amazon preparation uses BL postcode, persists exclusion reason, and preserves existing/uncertain carrier shipments',async t=>{
 const e=new PGlite(),db={query:(s,p)=>e.query(s,p),transaction:fn=>e.transaction(tx=>fn({query:(s,p)=>tx.query(s,p)}))};t.after(()=>e.close());
 await e.exec(`CREATE TABLE orders(id text PRIMARY KEY,reference text,channel text,source_payload jsonb,erp_live jsonb,carrier text,weight_kg numeric,parcel_count int,archived boolean DEFAULT false,partial_mode boolean DEFAULT false,tracking_status text);
 CREATE TABLE settings(key text,value jsonb);
 CREATE TABLE carrier_jobs(order_id text,status text,environment text,attempts int,result jsonb,reference text,tracking jsonb,creation_started_at timestamptz,carrier text,updated_at timestamptz);
 CREATE TABLE carrier_documents(order_id text);
 CREATE TABLE carrier_label_history(order_id text);
 CREATE TABLE temu_label_documents(reference text);
 CREATE TABLE temu_label_jobs(reference text,attempt_id text,packages jsonb);
 CREATE TABLE extra_parcels(order_id text);
 CREATE TABLE partial_deliveries(order_id text);`);
 const config={...defaultRouting,gofoExcludedDepartments:['75'],amazonDeliveryOrigins:{gofo:'02100',gls:'77540'},amazonDeliveryRules:[{carrier:'gls',originPostal:'77540',department:'75',workDays:2}]};
 await e.query('INSERT INTO settings VALUES($1,$2)',['routing',JSON.stringify(config)]);
 for(const id of ['fresh','ready','uncertain'])await e.query("INSERT INTO orders(id,reference,channel,source_payload,erp_live,carrier,weight_kg,parcel_count,tracking_status) VALUES($1,$1,'amazon','{}',$2,'gofo',2,1,'not_shipped')",[id,JSON.stringify({bc:{id:'BC'},bl:{id:'BL',shipping_address:{country:'FR',postal_code:'75001'}}})]);
 await e.query("INSERT INTO carrier_jobs(order_id,status,environment,attempts,tracking,creation_started_at,carrier) VALUES('ready','ready','production',1,'[\"SYNTHETIC-TRACK\"]',now(),'gofo'),('uncertain','pending','production',0,'[]',now(),'gofo')");
 await e.query("INSERT INTO carrier_documents VALUES('ready')");
 const route=await selectedPreparationRouting(db,'fresh',{weightKg:2,missing:[]});assert.equal(route.carrier,'gls');
 const fresh=(await e.query("SELECT * FROM orders WHERE id='fresh'")).rows[0];assert.equal(fresh.carrier,'gls');assert.equal(fresh.source_payload.amazonDepartmentRouting.department,'75');
 assert.equal(amazonDeliveryEstimate(fresh,await loadRouting(db)).workDays,2);
 for(const id of ['ready','uncertain']){assert.deepEqual(await selectedPreparationRouting(db,id,{weightKg:2,missing:[]}),{preserved:true});assert.equal((await e.query('SELECT carrier FROM orders WHERE id=$1',[id])).rows[0].carrier,'gofo');}
 assert.equal((await e.query("SELECT tracking FROM carrier_jobs WHERE order_id='ready'")).rows[0].tracking[0],'SYNTHETIC-TRACK');
});
