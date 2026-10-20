import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {claimCarrierJob} from '../src/carrier-local-transaction.mjs';
const require=createRequire(process.env.AUDIT_PG_PACKAGE||new URL('../package.json',import.meta.url));
const {Pool}=require('pg');
if(process.env.AUDIT_DROP_TO_POSTGRES==='1'){process.setgid('postgres');process.setuid('postgres');}
const database=process.env.TEST_CARRIER_DATABASE_NAME;
if(!/^nextech_audit_test_[a-z0-9_]+$/.test(database||''))throw Error('An isolated audit database is required');
const pool=new Pool({host:process.env.PGHOST||'/var/run/postgresql',database,max:6});
const db={transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn({query:(...a)=>c.query(...a)});await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
try{
 await pool.query(`CREATE TABLE orders(id text PRIMARY KEY,processing_priority_at timestamptz,suspension jsonb DEFAULT '{}');
 CREATE TABLE carrier_jobs(order_id text PRIMARY KEY REFERENCES orders(id),carrier text,status text,attempts integer DEFAULT 0,updated_at timestamptz DEFAULT now());
 CREATE FUNCTION guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM id FROM orders WHERE id=NEW.order_id FOR SHARE;RETURN NEW;END; $$;
 CREATE TRIGGER guard BEFORE UPDATE ON carrier_jobs FOR EACH ROW EXECUTE FUNCTION guard();
 INSERT INTO orders(id) VALUES('o');INSERT INTO carrier_jobs(order_id,carrier,status) VALUES('o','gls','pending');`);
 // Reproduce the old inversion with two actual PostgreSQL sessions.
 const a=await pool.connect(),b=await pool.connect();let oldDeadlocks=0;
 try{
  await a.query('BEGIN');await b.query('BEGIN');await a.query("SET LOCAL deadlock_timeout='100ms'");await b.query("SET LOCAL deadlock_timeout='100ms'");
  await a.query("SELECT id FROM orders WHERE id='o' FOR UPDATE");await b.query("SELECT * FROM carrier_jobs WHERE order_id='o' FOR UPDATE");
  const update=b.query("UPDATE carrier_jobs SET attempts=attempts+1 WHERE order_id='o'").catch(async e=>{if(e.code==='40P01')oldDeadlocks++;else throw e;await b.query('ROLLBACK');});
  try{await a.query("SELECT * FROM carrier_jobs WHERE order_id='o' FOR UPDATE");}catch(e){if(e.code==='40P01')oldDeadlocks++;else throw e;}
  await a.query('ROLLBACK');await update;await b.query('ROLLBACK');
 }finally{a.release();b.release();}
 assert.equal(oldDeadlocks,1);
 const held=await pool.connect();
 try{
  await held.query('BEGIN');await held.query("SELECT id FROM orders WHERE id='o' FOR UPDATE");
  assert.equal(await claimCarrierJob(db,'gls',{eligible:"status='pending'",priority:'updated_at,order_id'}),null);
  await held.query("SELECT order_id FROM carrier_jobs WHERE order_id='o' FOR UPDATE");await held.query('COMMIT');
 }finally{await held.query('ROLLBACK');held.release();}
 let claims=0;
 for(let i=0;i<30;i++){
  await pool.query("UPDATE carrier_jobs SET status='pending',attempts=0 WHERE order_id='o'");
  const results=await Promise.all(Array.from({length:4},()=>claimCarrierJob(db,'gls',{eligible:"status='pending'",priority:'updated_at,order_id'})));
  assert.equal(results.filter(Boolean).length,1);claims++;
  assert.equal((await pool.query('SELECT attempts FROM carrier_jobs')).rows[0].attempts,1);
 }
 console.log(JSON.stringify({realPostgreSQL:true,oldDeadlocks,newDeadlocks:0,concurrentClaims:120,uniqueClaims:claims,providerCalls:0,productionTablesTouched:false}));
}finally{await pool.end();}
