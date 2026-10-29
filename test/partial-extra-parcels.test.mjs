import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {partialParcelShipment,queuePartialParcels} from '../src/partial-extra-parcels.mjs';
const order={id:'o',channel:'tender',partial_mode:true,tracking_status:'not_shipped',erp_live:{bc:{status:'active'}},address:{name:'Parent',street:'1 rue Paris',postal:'75001',city:'Paris',country:'FR'}};
const delivery={id:'d',order_id:'o',status:'ready',environment:'production',carrier:'gls_pharma',weight_kg:76.37,parcel_count:3,tracking:['a','b','c'],bl:{id:'BL1',label:'SHO00746327',status:'in_preparation',shipping_address:{label:'BL client',address_1:'2 rue Test',postal_code:'13001',city:'Marseille',country:'FR'}},selection:[{sku:'SKU-BL',quantity:2}]};
test('additional parcel uses selected BL address, products and weight',()=>{
 const s=partialParcelShipment(order,delivery);assert.equal(s.label_bl,'SHO00746327');assert.equal(s.address.name,'BL client');assert.equal(s.address.postal,'13001');assert.deepEqual(s.lines,[{target_sku:'SKU-BL',target_quantity:2}]);assert.equal(s.weight_kg,25.457);
 for(const status of ['cancelled','shipped','delivered'])assert.throws(()=>partialParcelShipment(order,{...delivery,bl:{...delivery.bl,status}}));
 assert.throws(()=>partialParcelShipment({...order,suspension:{active:true}},delivery));
 assert.throws(()=>partialParcelShipment(order,{...delivery,status:'review'}));
});
test('3 to 4 queues only one parcel, preserves BL and PDFs, and deduplicates retries',async()=>{
 const engine=new PGlite();await engine.waitReady;const wrap=e=>({query:(s,p=[])=>e.query(s,p)});const db={...wrap(engine),transaction:fn=>engine.transaction(tx=>fn(wrap(tx)))};
 try{
 await engine.exec('CREATE TABLE orders(id text PRIMARY KEY,channel text,partial_mode boolean,tracking_status text,erp_live jsonb,address jsonb);CREATE TABLE partial_deliveries(id text PRIMARY KEY,order_id text,status text,environment text,carrier text,weight_kg numeric,parcel_count int,tracking jsonb,bl jsonb,selection jsonb);CREATE TABLE partial_documents(delivery_id text,pdf bytea);CREATE TABLE extra_parcels(id text,order_id text,delivery_id text,request_id text UNIQUE,carrier text,environment text,parcel_index int,parcel_total int,status text DEFAULT \'pending\');');
 await db.query('INSERT INTO orders VALUES($1,$2,$3,$4,$5,$6)',[order.id,order.channel,true,order.tracking_status,JSON.stringify(order.erp_live),JSON.stringify(order.address)]);
 await db.query('INSERT INTO partial_deliveries VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[delivery.id,order.id,delivery.status,delivery.environment,delivery.carrier,delivery.weight_kg,3,JSON.stringify(delivery.tracking),JSON.stringify(delivery.bl),JSON.stringify(delivery.selection)]);
 for(let i=0;i<3;i++)await db.query('INSERT INTO partial_documents VALUES($1,$2)',['d',Buffer.from('original')]);
 const b={deliveryId:'d',expectedTotal:3,total:4,requestId:randomUUID()},r=await queuePartialParcels(db,b);
 assert.equal((await queuePartialParcels(db,b)).id,r.id);
 const extras=(await db.query('SELECT * FROM extra_parcels')).rows;assert.equal(extras.length,1);assert.equal(extras[0].parcel_index,4);assert.equal(extras[0].delivery_id,'d');
 assert.equal((await db.query('SELECT * FROM partial_documents')).rows.length,3);
 assert.deepEqual((await db.query('SELECT tracking FROM partial_deliveries')).rows[0].tracking,delivery.tracking);
 await assert.rejects(()=>queuePartialParcels(db,{...b,requestId:randomUUID()}),/en cours/);
 await assert.rejects(()=>queuePartialParcels(db,{...b,total:2}),/invalide/);
 }finally{await engine.close();}
});
