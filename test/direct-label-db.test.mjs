import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {queueLabelFromBl} from '../src/direct-label.mjs';
import {initializeCarrierJobs,createCarrierWorkers} from '../src/carrier-jobs.mjs';
test('BL direct : SQL réel, création unique, PDF récupéré malgré fiscalité/hold',async()=>{
 const engine=new PGlite();await engine.waitReady;
 const wrap=e=>({exec:s=>e.exec(s),query:(s,p=[])=>e.query(s,p)});
 const db={...wrap(engine),transaction:fn=>engine.transaction(tx=>fn(wrap(tx))),recoverInterrupted:false};
 try{
 await db.exec(`CREATE TABLE orders(id text PRIMARY KEY,channel text,reference text,carrier text,address jsonb,source_payload jsonb DEFAULT '{}',erp_live jsonb DEFAULT '{}',label_status text,weight_kg numeric,parcel_count integer,tracking_status text,archived boolean DEFAULT false,partial_mode boolean DEFAULT false,resolution_pending_resume boolean DEFAULT true,suspension jsonb DEFAULT '{}',issue text);CREATE TABLE lines(id text,order_id text,source_line text,source_sku text,target_sku text,quantity numeric,target_quantity numeric);CREATE TABLE settings(key text,value jsonb);CREATE TABLE resolution_jobs(id text,order_id text,status text);CREATE TABLE extra_parcels(id text,order_id text);CREATE TABLE audit(user_email text,action text,detail jsonb);`);
 await initializeCarrierJobs(db);
 await db.query("INSERT INTO orders(id,channel,reference,carrier,address,erp_live,label_status,weight_kg,parcel_count) VALUES('o','amazon','SYNTHETIC','gofo',$1,$2,'simulated',1,1)",[JSON.stringify({name:'Synthetic',street:'1 rue Test',city:'Paris',postal:'75001',country:'FR'}),JSON.stringify({bl:{id:1902751,status:'ready_to_ship'},pricing:{status:'blocked'}})]);
 await db.query("INSERT INTO carrier_jobs(order_id,carrier,status,environment,attempts,error) VALUES('o','gofo','failed','production',1,'Préparation modifiée depuis la validation du BL : recontrôler')");
 await queueLabelFromBl(db,'o',{email:'synthetic'});
 await queueLabelFromBl(db,'o',{email:'synthetic'});
 let calls=0,pdfs=0;
 const workers=createCarrierWorkers(db,null,{clients:{async gofoCreate(){calls++;return {reference:'CREATED',tracking:['TRACK']};},async gofoLabel(){pdfs++;return Buffer.from('%PDF-1.4\nsynthetic').toString('base64');}}});
 await workers.run('gofo');await workers.run('gofo');
 const job=(await db.query("SELECT * FROM carrier_jobs WHERE order_id='o'")).rows[0];
 assert.equal(job.status,'ready',job.error);assert.equal(calls,1);assert.equal(pdfs,1);
 assert.equal((await db.query('SELECT * FROM carrier_documents')).rows.length,1);
 const order=(await db.query("SELECT * FROM orders WHERE id='o'")).rows[0];
 assert.equal(order.label_status,'production_ready');assert.equal(order.resolution_pending_resume,true);assert.equal(order.erp_live.pricing.status,'blocked');
 assert.equal((await db.query('SELECT * FROM audit')).rows.length,1);
 }finally{await engine.close();}
});
