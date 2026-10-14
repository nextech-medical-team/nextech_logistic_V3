import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {pathToFileURL} from 'node:url';
import {orderLocalTransaction} from '../src/order-local-transaction.mjs';
import {initializeOrderSuspension,orderSuspensionService} from '../src/order-suspension.mjs';
import {configureShipmentLocks} from '../src/shipment-lock.mjs';

test('PostgreSQL concurrency: unrelated global lock, target locks, active jobs and start-after-suspend', {skip:!process.env.TEST_QUOTA_DATABASE_URL},async()=>{
 const {Pool}=await (process.env.PG_MODULE?import(pathToFileURL(process.env.PG_MODULE).href):import('pg'));
 const schema='suspension_test_'+randomUUID().replaceAll('-','');assert.match(schema,/^suspension_test_[a-f0-9]{32}$/);
 const admin=new Pool({connectionString:process.env.TEST_QUOTA_DATABASE_URL,max:1});await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:process.env.TEST_QUOTA_DATABASE_URL,max:6,options:'-c search_path='+schema});
 const db={query:(q,p=[])=>pool.query(q,p),exec:q=>pool.query(q),localTransaction:fn=>orderLocalTransaction(pool,fn)};
 const metrics=[],keys=[];db.withLocks=async(k,fn)=>{keys.push(k);return fn();};configureShipmentLocks(db);
 db.transaction=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn({query:(q,p=[])=>c.query(q,p),exec:q=>c.query(q)});await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
 let held;
 try{
  await db.exec(`CREATE TABLE orders(id TEXT PRIMARY KEY,reference TEXT,archived BOOLEAN DEFAULT false,tracking_status TEXT DEFAULT 'not_shipped',label_status TEXT DEFAULT 'blocked',erp_live JSONB DEFAULT '{}',source_payload JSONB DEFAULT '{}',resolution_pending_resume BOOLEAN DEFAULT false);
  CREATE TABLE audit(user_email TEXT,action TEXT,detail JSONB);
  CREATE TABLE erp_live_jobs(order_id TEXT,status TEXT,error TEXT,updated_at timestamptz DEFAULT now());
  CREATE TABLE carrier_jobs(order_id TEXT,status TEXT,error TEXT,result JSONB,updated_at timestamptz DEFAULT now());
  CREATE TABLE resolution_jobs(id TEXT,order_id TEXT,status TEXT,stage TEXT,error TEXT,updated_at timestamptz DEFAULT now());
  CREATE TABLE correction_jobs(order_id TEXT,status TEXT,error TEXT,updated_at timestamptz DEFAULT now());
  CREATE TABLE partial_deliveries(order_id TEXT,status TEXT,error TEXT,stock_document JSONB);
  CREATE TABLE extra_parcels(order_id TEXT,status TEXT,error TEXT,result JSONB);
  CREATE TABLE jobs(id TEXT PRIMARY KEY,order_id TEXT,status TEXT,error TEXT);
  CREATE TABLE temu_label_jobs(reference TEXT,status TEXT);CREATE TABLE document_lifecycle(order_id TEXT,locked BOOLEAN);
  INSERT INTO orders(id,reference,erp_live) VALUES('target','TEST-TARGET','{"bc":{"id":123,"status":"active"}}');INSERT INTO jobs(id,order_id,status) VALUES('claim','target','pending');`);
  await initializeOrderSuspension(db);let providerCalls=0;const service=orderSuspensionService(db,{verify:async()=>providerCalls++,request:async()=>providerCalls++},{onTiming:m=>metrics.push(m)}),user={role:'operator',email:'fixture@example.test'};
  const input=async()=>({id:'target',note:'Fixture only',expectedVersion:(await service.context('target')).order.suspension.version||''});
  // This is in the isolated postgres database/schema, never production's DB.
  held=await pool.connect();await held.query("SELECT pg_advisory_lock(hashtextextended('nextech:stock-mutations',0))");
  const saved=await service.suspend(await input(),user);assert.equal(saved.suspension.active,true);assert.equal(keys.length,0);assert.equal(providerCalls,0);
  await held.query("SELECT pg_advisory_unlock(hashtextextended('nextech:stock-mutations',0))");held.release();held=null;
  await service.reactivate(await input(),user);
  const before=(await service.context('target')).order;
  held=await pool.connect();await held.query('BEGIN');await held.query("SELECT id FROM orders WHERE id='target' FOR UPDATE");
  await assert.rejects(()=>service.suspend({id:'target',note:'Fixture',expectedVersion:before.suspension.version},user),e=>e.status===423);await held.query('ROLLBACK');held.release();held=null;
  held=await pool.connect();await held.query('BEGIN');await held.query("SELECT id FROM jobs WHERE id='claim' FOR UPDATE");
  await assert.rejects(()=>service.suspend({id:'target',note:'Fixture',expectedVersion:before.suspension.version},user),e=>e.status===423);await held.query('ROLLBACK');held.release();held=null;
  assert.deepEqual((await service.context('target')).order.suspension,before.suspension);
  await db.query("UPDATE jobs SET status='processing' WHERE id='claim'");await assert.rejects(async()=>service.suspend(await input(),user),/traitement en cours/);await db.query("UPDATE jobs SET status='pending' WHERE id='claim'");
  await db.query("INSERT INTO temu_label_jobs VALUES('TEST-TARGET','uncertain')");await assert.rejects(async()=>service.suspend(await input(),user),/achat TEMU/);await db.query('DELETE FROM temu_label_jobs');
  let entered,finish;const enteredPromise=new Promise(r=>entered=r),gate=new Promise(r=>finish=r);db.localTransaction=fn=>orderLocalTransaction(pool,async tx=>{const result=await fn(tx);entered();await gate;return result;});
  const suspension=service.suspend(await input(),user);await Promise.race([enteredPromise,suspension.then(()=>{throw Error('Missing pause');})]);
  const claim=db.query("UPDATE jobs SET status='processing' WHERE id='claim'");const rejected=assert.rejects(claim,/traitement interdit/);finish();await suspension;await rejected;
  assert.equal((await db.query("SELECT status FROM jobs WHERE id='claim'")).rows[0].status,'blocked');assert.equal(providerCalls,0);
  await db.query("UPDATE orders SET tracking_status='delivered' WHERE id='target'");await assert.rejects(async()=>service.cancelErplain({...await input(),confirm:true},user),/annulation ERPLAIN impossible/);assert.ok(keys.at(-1).includes('stock-mutations'));assert.equal(providerCalls,0);
  assert.ok(metrics.some(m=>m.outcome==='saved'&&m.transactionMs>=0));
 }finally{if(held){await held.query('ROLLBACK').catch(()=>{});held.release();}configureShipmentLocks(null);await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();}
});
