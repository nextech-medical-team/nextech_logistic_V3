import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {initializeAppSchema} from '../src/schema-startup.mjs';
import {carrierEligible,priorityOrder} from '../src/order-priority.mjs';

async function fixture({existing=false,missingTable=false}={}){
 const engine=new PGlite();await engine.waitReady;
 await engine.exec(`CREATE TABLE schema_migrations(version TEXT PRIMARY KEY);
 INSERT INTO schema_migrations VALUES('application-20261005-robustness-5');
 CREATE TABLE orders(id TEXT PRIMARY KEY,suspension JSONB DEFAULT '{}',resolution_pending_resume BOOLEAN DEFAULT true,processing_priority_at TIMESTAMPTZ);
 INSERT INTO orders(id) VALUES('pending'),('creating'),('ready'),('review');`);
 if(!missingTable)await engine.exec(`CREATE TABLE carrier_jobs(order_id TEXT PRIMARY KEY,carrier TEXT,status TEXT,stock_override JSONB,creation_id TEXT,updated_at TIMESTAMPTZ DEFAULT now(),attempts INT DEFAULT 0,tracking JSONB DEFAULT '[]',result JSONB${existing?',manual_bl_request JSONB':''});
 INSERT INTO carrier_jobs(order_id,carrier,status) VALUES('pending','gls','pending'),('creating','gls','creating'),('ready','gofo','ready'),('review','gofo','review');
 UPDATE carrier_jobs SET stock_override='{"requestedBy":"operator"}' WHERE order_id='pending';
 UPDATE carrier_jobs SET attempts=1,result='{"reference":"existing"}',tracking='["preserve"]' WHERE order_id='creating';`);
 if(existing)await engine.exec(`UPDATE carrier_jobs SET manual_bl_request='{"blId":"123","requestedBy":"operator"}' WHERE order_id='pending'`);
 const wrap=e=>({query:(s,p=[])=>e.query(s,p),exec:s=>e.exec(s)});
 let tail=Promise.resolve();
 const db={...wrap(engine),transaction:f=>engine.transaction(t=>f(wrap(t))),withLocks:(keys,f)=>{const next=tail.then(f);tail=next.catch(()=>{});return next;}};
 return {engine,db};
}

test('upgrade existing schema restores carrier selection without replaying initializers or changing jobs',async()=>{
 const {engine,db}=await fixture();try{
  const before=(await db.query('SELECT * FROM carrier_jobs ORDER BY order_id')).rows;
  await assert.rejects(db.query(`SELECT * FROM carrier_jobs WHERE ${carrierEligible}`),/manual_bl_request/);
  await initializeAppSchema(db,[()=>{throw Error('Initializer must not replay');}]);
  const selected=await db.query(`SELECT * FROM carrier_jobs WHERE ${carrierEligible} ORDER BY ${priorityOrder('carrier_jobs')}`);
  assert.deepEqual(selected.rows.map(r=>r.order_id),['pending']);
  const after=(await db.query('SELECT * FROM carrier_jobs ORDER BY order_id')).rows;
  assert.deepEqual(after.map(({manual_bl_request,...r})=>r),before);
  assert(after.every(r=>r.manual_bl_request===null));
  assert.equal((await db.query("SELECT count(*)::int n FROM schema_migrations WHERE version='carrier-manual-bl-request-20261013-1'")).rows[0].n,1);
 }finally{await engine.close();}
});

test('existing manual requests survive repeated and concurrent startup migrations',async()=>{
 const {engine,db}=await fixture({existing:true});try{
  const before=(await db.query('SELECT * FROM carrier_jobs ORDER BY order_id')).rows;
  await Promise.all([initializeAppSchema(db,[]),initializeAppSchema(db,[])]);
  await initializeAppSchema(db,[]);
  assert.deepEqual((await db.query('SELECT * FROM carrier_jobs ORDER BY order_id')).rows,before);
  assert.equal((await db.query("SELECT count(*)::int n FROM schema_migrations WHERE version='carrier-manual-bl-request-20261013-1'")).rows[0].n,1);
 }finally{await engine.close();}
});

test('failed migration is rolled back without recording success',async()=>{
 const {engine,db}=await fixture({missingTable:true});try{
  await assert.rejects(initializeAppSchema(db,[]),/carrier_jobs/);
  assert.equal((await db.query("SELECT count(*)::int n FROM schema_migrations WHERE version='carrier-manual-bl-request-20261013-1'")).rows[0].n,0);
 }finally{await engine.close();}
});
