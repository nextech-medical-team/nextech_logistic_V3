import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {queueLabelFromBl} from '../src/direct-label.mjs';
import {initializeCarrierJobs,createCarrierWorkers} from '../src/carrier-jobs.mjs';
import {initializeAppSchema} from '../src/schema-startup.mjs';
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

for(const carrier of ['gofo','gls'])test(`existing installation: ${carrier} label survives fiscal review without changing ERP documents`,async()=>{
 const engine=new PGlite();await engine.waitReady;
 const wrap=e=>({exec:s=>e.exec(s),query:(s,p=[])=>e.query(s,p)});
 const db={...wrap(engine),transaction:fn=>engine.transaction(tx=>fn(wrap(tx))),withLocks:async(_keys,fn)=>fn(),recoverInterrupted:false};
 try{
  await db.exec(`CREATE TABLE schema_migrations(version text PRIMARY KEY);
   INSERT INTO schema_migrations VALUES('application-20261005-robustness-5');
   CREATE TABLE orders(id text PRIMARY KEY,channel text,reference text,carrier text,address jsonb,source_payload jsonb DEFAULT '{}',erp_live jsonb DEFAULT '{}',label_status text,weight_kg numeric,parcel_count integer,tracking_status text,archived boolean DEFAULT false,partial_mode boolean DEFAULT false,resolution_pending_resume boolean DEFAULT false,suspension jsonb DEFAULT '{}',issue text);
   CREATE TABLE lines(id text,order_id text,source_line text,source_sku text,target_sku text,quantity numeric,target_quantity numeric);
   CREATE TABLE settings(key text,value jsonb);
   CREATE TABLE resolution_jobs(id text,order_id text,status text,error text);
   CREATE TABLE erp_live_jobs(order_id text,status text,error text);
   CREATE TABLE extra_parcels(id text,order_id text);
   CREATE TABLE audit(user_email text,action text,detail jsonb);`);
  await initializeCarrierJobs(db);
  // Reproduce an installed application whose old schema marker prevented the
  // newly added column from being installed by initializeCarrierJobs.
  await db.exec('ALTER TABLE carrier_jobs DROP COLUMN manual_bl_request');
  const error='BC · Base fiscale des prix Erplain différente ou absente';
  const erp={bc:{id:101,status:'active'},bl:{id:202,status:'ready_to_ship'},stockDocument:{id:303,status:'completed',update_stock:true},pricing:{status:'blocked',error},labelPreparationFingerprint:'legacy-preparation'};
  await db.query("INSERT INTO orders(id,channel,reference,carrier,address,erp_live,label_status,weight_kg,parcel_count) VALUES('fiscal','amazon','SYNTHETIC-FISCAL',$1,$2,$3,'simulated',0.06,1)",[carrier,JSON.stringify({name:'Synthetic',street:'1 rue Test',city:'Paris',postal:'75001',country:'FR'}),JSON.stringify(erp)]);
  await db.query("INSERT INTO lines VALUES('line','fiscal','1','SKU','SKU',1,12)");
  await db.query("INSERT INTO erp_live_jobs VALUES('fiscal','review',$1)",[error]);
  await db.query("INSERT INTO resolution_jobs VALUES('resolution','fiscal','review',$1)",[error]);
  await db.query("INSERT INTO carrier_jobs(order_id,carrier,status,environment,attempts,error) VALUES('fiscal',$1,'failed','production',1,'Préparation modifiée depuis la validation du BL : recontrôler')",[carrier]);
  const before={order:(await db.query("SELECT * FROM orders WHERE id='fiscal'")).rows[0],erp:(await db.query('SELECT * FROM erp_live_jobs')).rows,resolutions:(await db.query('SELECT * FROM resolution_jobs')).rows,lines:(await db.query('SELECT * FROM lines')).rows};
  await assert.rejects(queueLabelFromBl(db,'fiscal',{email:'operator'}),/manual_bl_request/);
  assert.equal((await db.query("SELECT status FROM carrier_jobs WHERE order_id='fiscal'")).rows[0].status,'failed');
  await initializeAppSchema(db,[()=>{throw Error('Do not replay business initializers');}]);
  await initializeAppSchema(db,[]);
  await queueLabelFromBl(db,'fiscal',{email:'operator'});
  await queueLabelFromBl(db,'fiscal',{email:'operator'});
  let creations=0,pdfReads=0;
  const pdf=Buffer.from('%PDF-1.4\nsynthetic fiscal regression');
  const validate=shipment=>{creations++;assert.equal(shipment.lines[0].target_quantity,'12');assert.deepEqual(shipment.erp_live,erp);};
  const workers=createCarrierWorkers(db,null,{clients:{
   async gofoCreate(shipment){validate(shipment);return {reference:'SHIPMENT',tracking:['TRACK']};},
   async gofoLabel(){pdfReads++;return pdf.toString('base64');},
   async gls(shipment){validate(shipment);return {reference:'SHIPMENT',tracking:['TRACK'],documents:[pdf.toString('base64')]};}
  }});
  await workers.run(carrier);await workers.run(carrier);
  assert.equal(creations,1);assert.equal(pdfReads,carrier==='gofo'?1:0);
  const job=(await db.query("SELECT * FROM carrier_jobs WHERE order_id='fiscal'")).rows[0];
  assert.equal(job.status,'ready',job.error);assert.deepEqual(job.tracking,['TRACK']);
  const documents=(await db.query("SELECT pdf FROM carrier_documents WHERE order_id='fiscal'")).rows;
  assert.equal(documents.length,1);assert.deepEqual(Buffer.from(documents[0].pdf),pdf);
  const after=(await db.query("SELECT * FROM orders WHERE id='fiscal'")).rows[0];
  assert.equal(after.label_status,'production_ready');
  for(const key of ['erp_live','address','weight_kg','parcel_count','resolution_pending_resume'])assert.deepEqual(after[key],before.order[key],key);
  assert.deepEqual((await db.query('SELECT * FROM erp_live_jobs')).rows,before.erp);
  assert.deepEqual((await db.query('SELECT * FROM resolution_jobs')).rows,before.resolutions);
  assert.deepEqual((await db.query('SELECT * FROM lines')).rows,before.lines);
  assert.equal((await queueLabelFromBl(db,'fiscal',{email:'operator'})).existing,true);
  await workers.run(carrier);assert.equal(creations,1);
 }finally{await engine.close();}
});
