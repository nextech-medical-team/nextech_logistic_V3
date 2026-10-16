import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {comments2005Api,extraParcelWorker,initializeComments2005} from '../src/comments-2005.mjs';
const requestId='11111111-1111-4111-8111-111111111111';
async function fixture(t){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`CREATE TABLE orders(id text primary key,reference text,channel text,address jsonb,source_payload jsonb,suspension jsonb,erp_live jsonb,tracking_status text,archived boolean,partial_mode boolean,weight_kg numeric,parcel_count int);
 CREATE TABLE lines(id text,order_id text,source_line text,source_sku text,target_sku text,quantity numeric,target_quantity numeric,source_payload jsonb);
 CREATE TABLE mappings(channel text,source_sku text,target_sku text,source_qty numeric,target_qty numeric);
 CREATE TABLE products(sku text,weight_kg numeric);
 CREATE TABLE settings(key text,value jsonb);
 CREATE TABLE carrier_jobs(order_id text,status text,tracking jsonb);
 CREATE TABLE carrier_documents(order_id text,pdf bytea);
 CREATE TABLE temu_label_jobs(reference text,status text);
 CREATE TABLE resolution_jobs(order_id text,status text);
 INSERT INTO orders VALUES('o','#12891','shopify','{"name":"Test","street":"1 Rue Test","postal":"94340","city":"Joinville","country":"FR"}','{}','{}','{"bc":{"id":"bc","status":"active"},"bl":{"id":"bl","status":"ready_to_ship"}}','not_shipped',false,false,40,2);
 INSERT INTO lines VALUES('l','o','l','SKU','SKU',10000,10000,'{}');
 INSERT INTO products VALUES('SKU',0.004);
 INSERT INTO carrier_jobs VALUES('o','ready','["FIRST","SECOND"]');
 INSERT INTO carrier_documents VALUES('o','first'),('o','second');`);
 await initializeComments2005(db);
 const add=async(overrides={})=>{let result;await comments2005Api({p:'/api/parcels/add',req:{method:'POST'},db,user:{},body:async()=>({id:'o',carrier:'gls',count:1,expectedTotal:2,requestId,...overrides}),permitted(){},audit:async()=>{},json:(res,status,value)=>{assert.equal(status,202);result=value;}});return result;};
 return {db,add};
}
test('40 kg order with two labels adds only the third label; repeated request creates nothing twice',async t=>{
 const {db,add}=await fixture(t);
 const first=await add(),replay=await add();assert.equal(first.id,replay.id);assert.equal(first.total,3);
 let calls=0;
 const worker=extraParcelWorker(db,{productionConfig:{},productionFactory:()=>({gls:async o=>{calls++;assert.equal(o.parcel_count,1);assert.equal(o.parcel_index,3);assert.equal(o.parcel_total,3);assert.equal(o.weight_kg,40);return {reference:'third',tracking:['THIRD'],documents:[Buffer.from('%PDF-third').toString('base64')]};}})});
 await worker.run();await worker.run();assert.equal(calls,1);
 const extras=(await db.query('SELECT * FROM extra_parcels')).rows;assert.equal(extras.length,1);assert.equal(extras[0].status,'ready');assert.equal(extras[0].tracking,'THIRD');
 assert.deepEqual((await db.query('SELECT tracking FROM carrier_jobs')).rows[0].tracking,['FIRST','SECOND']);
 assert.equal((await db.query('SELECT * FROM carrier_documents')).rows.length,2);
 assert.equal((await db.query('SELECT erp_live FROM orders')).rows[0].erp_live.bl.id,'bl');
 await assert.rejects(add({requestId:'22222222-2222-4222-8222-222222222222'}),/nombre de colis a changé/);
});
test('total shipment weight still requires enough parcels, without a carrier call',async t=>{
 const {db,add}=await fixture(t);await db.query('UPDATE products SET weight_kg=0.01');await add();
 const worker=extraParcelWorker(db,{productionConfig:{},productionFactory:()=>({gls:async()=>assert.fail('100kg cannot fit in 3 parcels of 30kg')})});
 await worker.run();const result=(await db.query('SELECT status,error FROM extra_parcels')).rows[0];assert.equal(result.status,'failed');assert.match(result.error,/maximum par colis/);
});
