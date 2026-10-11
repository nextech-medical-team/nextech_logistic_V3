import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';
import {refreshLookupDiagnostics} from '../src/catalogue-lookup-diagnostics.mjs';
test('SQL reconciliation clears only stale catalogue components, audits history, preserves retained pricing and current error',async()=>{
 const engine=new PGlite();await engine.waitReady;
 try{
 await engine.exec(`CREATE TABLE orders(id text primary key,channel text,archived boolean,issue text,erp_live jsonb,resolution_pending_resume boolean,source_payload jsonb);
 CREATE TABLE lines(order_id text,source_sku text,target_sku text,source_payload jsonb);
 CREATE TABLE mappings(channel text,source_sku text,target_sku text);
 CREATE TABLE erp_live_jobs(order_id text,status text,error text,updated_at timestamptz);
 CREATE TABLE carrier_jobs(order_id text,status text);
 CREATE TABLE resolution_jobs(id text primary key,order_id text,action text,status text,error text,created_at timestamptz,updated_at timestamptz);
 CREATE TABLE audit(user_email text,action text,detail jsonb);
 INSERT INTO orders VALUES('o','temu',false,'COLL200200 : SKU Erplain introuvable ; Adresse à vérifier','{}',true,'{"temuManualPricing":{"vatRate":27}}');
 INSERT INTO lines VALUES('o','COLL200200',null,'{}');
 INSERT INTO erp_live_jobs VALUES('o','review','Accès aux montants refusé (3000032)',now()-interval '1 hour');
 INSERT INTO resolution_jobs VALUES('r','o','manual-temu-pricing','review','COLL200200 : SKU Erplain introuvable','2026-10-06T20:41:54.729123Z','2026-10-11T07:16:28.302123Z');`);
 const db={transaction:fn=>engine.transaction(tx=>fn({query:(...a)=>tx.query(...a)}))},order={id:'o',erp_live:{}};
 const before=(await engine.query('SELECT * FROM orders')).rows[0],jobBefore=(await engine.query('SELECT * FROM resolution_jobs')).rows[0];
 const proof={sku:'COLL200200',status:'active',complete:true,sourceReadOnly:true,variantId:'2899571',productId:'2009207',readAt:new Date(Date.now()-1).toISOString(),documentId:null};
 assert.equal((await refreshLookupDiagnostics(db,order,proof)).retired.length,2);
 const after=(await engine.query('SELECT * FROM orders')).rows[0];assert.deepEqual({...after,issue:before.issue},before);assert.equal(after.issue,'Adresse à vérifier');
 const current=(await engine.query('SELECT * FROM resolution_jobs')).rows[0];assert.deepEqual({...current,error:jobBefore.error},jobBefore);assert.equal(current.error,null);
 assert.equal((await engine.query('SELECT error FROM erp_live_jobs')).rows[0].error,'Accès aux montants refusé (3000032)');
 const audit=(await engine.query('SELECT detail FROM audit')).rows;assert.equal(audit.length,1);assert.equal(audit[0].detail.retired.length,2);assert.equal(audit[0].detail.preparationChanged,false);
 assert.equal((await refreshLookupDiagnostics(db,order,proof)).retired.length,0);assert.equal((await engine.query('SELECT * FROM audit')).rows.length,1);
 }finally{await engine.close();}
});
