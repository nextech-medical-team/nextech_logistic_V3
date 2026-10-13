import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {initializeAppSchema} from '../src/schema-startup.mjs';
import {carrierEligible,priorityOrder} from '../src/order-priority.mjs';

test('upgrade an already initialized database without replaying jobs or initializers',async()=>{
 const engine=new PGlite();
 const wrap=e=>({query:(...args)=>e.query(...args),exec:sql=>e.exec(sql)});
 const db={...wrap(engine),withLocks:async(keys,fn)=>{assert.deepEqual(keys,['schema']);return fn();},transaction:fn=>engine.transaction(tx=>fn(wrap(tx)))};
 try{
  await engine.exec(`CREATE TABLE schema_migrations(version text PRIMARY KEY);INSERT INTO schema_migrations VALUES('application-20261005-robustness-5');
   CREATE TABLE orders(id text PRIMARY KEY,suspension jsonb DEFAULT '{}',resolution_pending_resume boolean,processing_priority_at timestamptz);
   CREATE TABLE carrier_jobs(order_id text,carrier text,status text,creation_id text,stock_override jsonb,attempts int,updated_at timestamptz,result jsonb);
   INSERT INTO orders VALUES('synthetic','{}',false,now());
   INSERT INTO carrier_jobs VALUES('synthetic','gls','pending','existing',null,0,now(),'{"existing":"preserve"}'),('uncertain','gls','creating','uncertain',null,1,now(),'{"tracking":"preserve"}');`);
  const selection=`SELECT * FROM carrier_jobs WHERE carrier='gls' AND ${carrierEligible} ORDER BY ${priorityOrder('carrier_jobs')} LIMIT 1`;
  await assert.rejects(()=>engine.query(selection),e=>e.code==='42703');
  const before=(await engine.query('SELECT to_jsonb(c) AS job FROM carrier_jobs c ORDER BY order_id')).rows;
  await initializeAppSchema(db,[()=>assert.fail('old initializer replayed')]);
  await initializeAppSchema(db,[()=>assert.fail('old initializer replayed')]);
  assert.deepEqual((await engine.query("SELECT to_jsonb(c)-'manual_bl_request' AS job FROM carrier_jobs c ORDER BY order_id")).rows,before);
  assert.equal((await engine.query(selection)).rows.length,1);
  await engine.exec(`UPDATE orders SET suspension='{"active":true}'`);
  assert.equal((await engine.query(selection)).rows.length,0);
  assert.equal((await engine.query("SELECT * FROM schema_migrations WHERE version='carrier-manual-bl-request-20261013-1'")).rows.length,1);
  await engine.exec('ALTER TABLE carrier_jobs DROP COLUMN manual_bl_request');
  await assert.rejects(()=>initializeAppSchema(db,[]),e=>e.code==='42703');
 }finally{await engine.close();}
});
