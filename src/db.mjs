import {installTemuParcelRule} from './temu-parcel-count.mjs';
import {orderReadTransaction} from './order-read-transaction.mjs';
import { mkdir } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';



export async function openDatabase({directory, url} = {}) {

  let engine, pool;

  if (url) {

    const {Pool} = await import('pg');

    pool = new Pool({connectionString:url, max:10});

    engine = {query:(...a)=>pool.query(...a), exec:s=>pool.query(s)};

  } else {

    if(directory) await mkdir(directory,{recursive:true});

    engine = new PGlite(directory);

    await engine.waitReady;

  }

  const wrap = e => ({query:(s,p=[])=>e.query(s,p), exec:s=>e.exec?e.exec(s):e.query(s)});

  const db=wrap(engine);
  db.readTransaction=fn=>pool?orderReadTransaction(pool,fn,wrap):engine.transaction(tx=>fn(wrap(tx)));

  db.transaction=async fn=>{

    if(!pool) return engine.transaction(tx=>fn(wrap(tx)));

    const c=await pool.connect();

    try{await c.query('BEGIN');const result=await fn(wrap(c));await c.query('COMMIT');return result;}

    catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}

  };

  db.kind=pool?'postgres':'pglite';
  db.recoverInterrupted=true;
  db.withLocks=async (keys,fn)=>{
    if(!pool)return fn();
    const c=await pool.connect(),held=[];
    try{for(const key of [...new Set(keys)].sort()){await c.query("SELECT pg_advisory_lock(hashtextextended($1,0))",['nextech:'+key]);held.push(key);}return await fn();}
    finally{for(const key of held.reverse())await c.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",['nextech:'+key]).catch(()=>{});c.release();}
  };
  db.acquireLeader=async()=>{
    if(!pool)return ()=>{};
    const c=await pool.connect();
    const ok=(await c.query("SELECT pg_try_advisory_lock(hashtextextended('nextech:background-leader',0)) AS ok")).rows[0].ok;
    if(!ok){c.release();throw Error('Un autre processus de traitement est déjà actif');}
    c.on('error',()=>{console.error('Connexion du responsable des traitements perdue : arrêt sécurisé');process.kill(process.pid,'SIGTERM');});
    return async()=>{await c.query("SELECT pg_advisory_unlock(hashtextextended('nextech:background-leader',0))").catch(()=>{});c.release();};
  };
  db.close=()=>pool?pool.end():engine.close();

  await db.withLocks(['schema'],async()=>{await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');if((await db.query("SELECT version FROM schema_migrations WHERE version='core-20261005-1'")).rows.length)return;await db.exec(`

    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value JSONB NOT NULL);

    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL,created_at TIMESTAMPTZ DEFAULT now());

    ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '[]';
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,expires_at TIMESTAMPTZ NOT NULL);

    CREATE TABLE IF NOT EXISTS mappings(channel TEXT NOT NULL,source_sku TEXT NOT NULL,target_sku TEXT NOT NULL,source_qty NUMERIC NOT NULL CHECK(source_qty>0),target_qty NUMERIC NOT NULL CHECK(target_qty>0),PRIMARY KEY(channel,source_sku));

    ALTER TABLE mappings ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';

    ALTER TABLE mappings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

    CREATE TABLE IF NOT EXISTS product_weight_overrides(sku TEXT PRIMARY KEY,source_variant_id TEXT NOT NULL,live_variant_id TEXT NOT NULL,weight_kg NUMERIC NOT NULL,verified_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS products(sku TEXT PRIMARY KEY,weight_kg NUMERIC NOT NULL CHECK(weight_kg>0),origin TEXT NOT NULL,updated_at TIMESTAMPTZ DEFAULT now());

    CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,channel TEXT NOT NULL,reference TEXT NOT NULL,recipient TEXT NOT NULL,address JSONB NOT NULL,received_at TIMESTAMPTZ DEFAULT now(),source_date TEXT,expires_at TIMESTAMPTZ DEFAULT now()+interval '42 days',label_status TEXT DEFAULT 'pending',erp_status TEXT DEFAULT 'simulated_pending',tracking_status TEXT DEFAULT 'not_shipped',invoice_status TEXT DEFAULT 'not_due',weight_kg NUMERIC,parcel_count INT,carrier TEXT,issue TEXT,simulation BOOLEAN DEFAULT false,UNIQUE(channel,reference));

    ALTER TABLE orders ADD COLUMN IF NOT EXISTS resolution_pending_resume BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS erplain_product_bindings(sku TEXT PRIMARY KEY,live_variant_id TEXT NOT NULL,product JSONB NOT NULL,verified_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS resolution_jobs(id TEXT PRIMARY KEY,order_id TEXT REFERENCES orders(id),request_id TEXT UNIQUE NOT NULL,action TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',stage TEXT NOT NULL DEFAULT 'En attente',payload JSONB NOT NULL,result JSONB,error TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS partial_mode BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS source_reference TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS duplicate_of TEXT;
    CREATE INDEX IF NOT EXISTS orders_source_reference_idx ON orders(channel,source_reference);
    CREATE TABLE IF NOT EXISTS import_receipts(id TEXT PRIMARY KEY,signature TEXT NOT NULL,result JSONB,created_at TIMESTAMPTZ DEFAULT now());

    CREATE INDEX IF NOT EXISTS orders_received_idx ON orders(received_at DESC,id);

    ALTER TABLE orders ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;
    CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(label_status,received_at DESC);

    CREATE INDEX IF NOT EXISTS orders_expiry_idx ON orders(expires_at);

    ALTER TABLE orders ADD COLUMN IF NOT EXISTS label_override BOOLEAN NOT NULL DEFAULT false;
    CREATE TABLE IF NOT EXISTS lines(id TEXT PRIMARY KEY,order_id TEXT REFERENCES orders(id) ON DELETE CASCADE,source_line TEXT NOT NULL,source_sku TEXT NOT NULL,quantity NUMERIC NOT NULL CHECK(quantity>0),target_sku TEXT,target_quantity NUMERIC,UNIQUE(order_id,source_line));

    CREATE INDEX IF NOT EXISTS lines_order_idx ON lines(order_id);

    CREATE TABLE IF NOT EXISTS correction_jobs(id TEXT PRIMARY KEY,order_id TEXT REFERENCES orders(id),request_id TEXT UNIQUE NOT NULL,status TEXT NOT NULL DEFAULT 'queued',payload JSONB NOT NULL,result JSONB NOT NULL DEFAULT '{}',error TEXT,created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,order_id TEXT REFERENCES orders(id) ON DELETE CASCADE,kind TEXT NOT NULL,status TEXT DEFAULT 'pending',attempts INT DEFAULT 0,available_at TIMESTAMPTZ DEFAULT now(),locked_at TIMESTAMPTZ,error TEXT,UNIQUE(order_id,kind));

    CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs(status,available_at);

    CREATE TABLE IF NOT EXISTS labels(order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,tracking TEXT NOT NULL,pdf BYTEA NOT NULL,created_at TIMESTAMPTZ DEFAULT now());

    CREATE TABLE IF NOT EXISTS audit(id BIGSERIAL PRIMARY KEY,user_email TEXT NOT NULL,action TEXT NOT NULL,detail JSONB NOT NULL DEFAULT '{}',created_at TIMESTAMPTZ DEFAULT now());

    ALTER TABLE orders ADD COLUMN IF NOT EXISTS source_payload JSONB NOT NULL DEFAULT '{}';

    ALTER TABLE lines ADD COLUMN IF NOT EXISTS source_payload JSONB NOT NULL DEFAULT '{}';

    CREATE TABLE IF NOT EXISTS catalog_results(sku TEXT PRIMARY KEY,message TEXT,checked_at TIMESTAMPTZ DEFAULT now());

  `);await db.query("INSERT INTO schema_migrations(version) VALUES('core-20261005-1')");});

  // Existing installations already have the core migration marker. Apply this
  // read index independently, under the same schema lock, without altering jobs.
  await db.withLocks(['schema'],()=>db.exec('CREATE INDEX IF NOT EXISTS resolution_order_history_idx ON resolution_jobs(order_id,created_at DESC,id DESC)'));
  await installTemuParcelRule(db);
  return db;

}

