import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {backfillSelection,createBlockedMissingProducts,initializeCatalogueReviews} from '../src/missing-product-creation.mjs';

test('real selector excludes cancelled/suspended/completed/busy orders and preserves useful old demand',async t=>{
 const engine=new PGlite();await engine.waitReady;t.after(()=>engine.close());
 await engine.exec(`CREATE TABLE orders(id text PRIMARY KEY,channel text DEFAULT 'temu',archived boolean DEFAULT false,tracking_status text,label_status text,suspension jsonb DEFAULT '{}',erp_live jsonb DEFAULT '{}',received_at timestamptz DEFAULT now(),issue text);
 CREATE TABLE lines(order_id text,source_sku text,target_sku text,source_payload jsonb DEFAULT '{}');
 CREATE TABLE mappings(channel text,source_sku text,target_sku text);
 CREATE TABLE catalog_results(sku text,message text);
 CREATE TABLE erp_live_jobs(order_id text,status text,error text);
 CREATE TABLE resolution_jobs(order_id text,status text);
 CREATE TABLE correction_jobs(order_id text,status text);
 CREATE TABLE carrier_jobs(order_id text,status text);`);
 const db={exec:q=>engine.exec(q),query:(...a)=>engine.query(...a)};
 await initializeCatalogueReviews(db);
 for(const id of ['useful-old','cancelled','label-cancelled','suspended','cancel-review','completed','delivered','busy']){
  await engine.query('INSERT INTO orders(id,received_at) VALUES($1,now()-interval \'30 days\')',[id]);
  await engine.query("INSERT INTO lines(order_id,source_sku,target_sku) VALUES($1,'A','A')",[id]);
  await engine.query("INSERT INTO erp_live_jobs VALUES($1,'review','BC · SKU Erplain LIVE introuvable : A')",[id]);
 }
 await engine.exec(`UPDATE orders SET tracking_status='cancelled' WHERE id='cancelled';UPDATE orders SET label_status='cancelled' WHERE id='label-cancelled';UPDATE orders SET suspension='{"active":true}' WHERE id='suspended';UPDATE orders SET suspension='{"erplainCancellation":{"status":"review"}}' WHERE id='cancel-review';UPDATE orders SET tracking_status='delivered' WHERE id='delivered';UPDATE erp_live_jobs SET status='complete' WHERE order_id='completed';INSERT INTO correction_jobs VALUES('busy','queued');`);
 const start=performance.now();assert.deepEqual((await engine.query(backfillSelection)).rows.map(o=>o.id),['useful-old']);assert.ok(performance.now()-start<2000);
 await engine.exec("UPDATE orders SET tracking_status='cancelled' WHERE id='useful-old'");let calls=0;const api={verify:async()=>calls++,request:async()=>calls++};
 await createBlockedMissingProducts(db,api,{blocked:()=>false});await createBlockedMissingProducts(db,api,{blocked:()=>false});assert.equal(calls,0);
 const columns=(await engine.query("SELECT column_name FROM information_schema.columns WHERE table_name='erplain_product_creation_reviews'")).rows.map(r=>r.column_name);for(const name of ['fingerprint','next_check_at','attempts'])assert.ok(columns.includes(name));
});
