import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';
import {reconcileVerifiedWeights} from '../src/verified-weight-diagnostics.mjs';
test('real SQL reconciliation covers replacement, newer failures, variant conflicts, no-audit and repeat',async()=>{
 const db=new PGlite();try{
 await db.exec(`CREATE TABLE orders(id text primary key,archived boolean default false,issue text,erp_live jsonb default '{}');
 CREATE TABLE lines(order_id text,target_sku text,source_sku text,source_payload jsonb);
 CREATE TABLE erplain_product_bindings(sku text,live_variant_id text,product jsonb,verified_at timestamptz);
 CREATE TABLE resolution_jobs(id text,order_id text,status text,action text,stage text,payload jsonb,error text,created_at timestamptz,updated_at timestamptz);
 CREATE TABLE erp_live_jobs(order_id text,status text,error text,updated_at timestamptz);
 CREATE TABLE carrier_jobs(order_id text,status text,error text);
 CREATE TABLE audit(user_email text,action text,detail text);`);
 const now=Date.now(),proof=new Date(now-2000).toISOString(),old=new Date(now-10000).toISOString(),newer=new Date(now-500).toISOString();
 const variant={id:12,sku:'SKU',active:true,weight_amount:5,weight_unit:'g',product:{active:true}};
 await db.query('INSERT INTO erplain_product_bindings VALUES($1,$2,$3,$4)',['SKU','12',JSON.stringify(variant),proof]);
 for(const [id,physical,timestamp,busy] of [['correct','12',old,false],['conflict','13',old,false],['newer','12',newer,false],['busy','12',old,true]]){
  await db.query('INSERT INTO orders(id) VALUES($1)',[id]);await db.query('INSERT INTO lines VALUES($1,$2,$2,$3)',[id,'SKU',JSON.stringify({erplainSourceVariantId:physical})]);
  await db.query('INSERT INTO resolution_jobs VALUES($1,$1,$2,$3,$4,$5,$6,$7,$7)',[id,'review','equivalent-preview','À vérifier',JSON.stringify({replacementSku:'OTHER'}),'Produit restant [SKU] : Poids non renseigné dans Erplain ; Stock insuffisant',timestamp]);
  if(busy)await db.query('INSERT INTO carrier_jobs VALUES($1,$2,null)',[id,'creating']);
 }
 const original=(await db.query('SELECT * FROM orders ORDER BY id')).rows;
 await reconcileVerifiedWeights(db);const jobs=(await db.query('SELECT * FROM resolution_jobs ORDER BY id')).rows;
 assert.match(jobs.find(j=>j.id==='correct').error,/Poids vérifié, remplacement à confirmer ; Stock insuffisant/);
 for(const id of ['conflict','newer','busy'])assert.match(jobs.find(j=>j.id===id).error,/Poids non renseigné/);
 assert.ok(jobs.every(j=>j.status==='review'));assert.deepEqual((await db.query('SELECT * FROM orders ORDER BY id')).rows,original);
 const audits=(await db.query('SELECT * FROM audit')).rows.length;await reconcileVerifiedWeights(db);assert.equal((await db.query('SELECT * FROM audit')).rows.length,audits);
 // Another error is never cleared by an old weight proof.
 assert.ok(jobs.every(j=>j.error.includes('Stock insuffisant')));
 }finally{await db.close();}
});
