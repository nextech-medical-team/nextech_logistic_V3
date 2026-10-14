import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {completedExcelPreparation,releaseExcelPurchaseHold} from '../src/temu-excel-purchase-admission.mjs';
const order={id:'o',source_payload:{temuExcelPreparation:{jobId:'import'}}};
const original=()=>({id:'import',action:'resume',status:'complete',result:{erpOnly:true}});
const retry=()=>({id:'retry',action:'resume-erp',status:'complete',result:{resume:true,erpOnly:true}});
const read=jobs=>({query:async()=>({rows:jobs})});
test('completed BL retry preserves completed Excel preparation',async()=>{
 assert.equal(await completedExcelPreparation(read([original()]),order),true);
 assert.equal(await completedExcelPreparation(read([retry(),original()]),order),true);
 assert.equal(await completedExcelPreparation(read([retry(),{...retry(),id:'prior'},original()]),order),true);
});
test('active, failed, unrelated, incomplete or ambiguous preparation stays blocked',async()=>{
 for(const status of ['pending','queued','running','waiting','processing','review','failed','cancelled']){
  assert.equal(await completedExcelPreparation(read([{...retry(),status},original()]),order),false,status);
 }
 for(const change of [{error:'stock'},{action:'address'},{result:{erpOnly:true}},{result:{resume:true,erpOnly:true,readOnly:true}},{result:{resume:true,erpOnly:true,partialRemainder:true}}]){
  assert.equal(await completedExcelPreparation(read([{...retry(),...change},original()]),order),false);
 }
 assert.equal(await completedExcelPreparation(read([retry()]),order),false);
 assert.equal(await completedExcelPreparation(read([retry(),{...original(),status:'review'}]),order),false);
 assert.equal(await completedExcelPreparation(read([retry(),original(),{id:'older',status:'review'}]),order),false);
});
test('release requires completed ERP job and validated BL/stock even after completed retry',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`CREATE TABLE orders(id text primary key,source_payload jsonb,erp_live jsonb,resolution_pending_resume boolean,archived boolean,issue text,partial_mode boolean,transport_choice text,suspension jsonb);
 CREATE TABLE resolution_jobs(id text,order_id text,action text,status text,error text,result jsonb,created_at timestamptz);
 CREATE TABLE erp_live_jobs(order_id text,status text);
 INSERT INTO orders VALUES('o','{"origin":"temu_excel","temuExcelPreparation":{"jobId":"import"}}','{"bc":{"id":"bc"},"bl":{"id":"bl","status":"ready_to_ship"},"verifiedAt":"2026-10-14T12:00:00Z","stockCheckedAt":"2026-10-14T12:00:00Z"}',true,false,null,false,null,'{}');
 INSERT INTO resolution_jobs VALUES('import','o','resume','complete',null,'{"erpOnly":true}','2026-10-13'),('retry','o','resume-erp','complete',null,'{"erpOnly":true,"resume":true}','2026-10-14');
 INSERT INTO erp_live_jobs VALUES('o','pending');`);
 await assert.rejects(releaseExcelPurchaseHold(db,'o'),/stock et BL/);
 assert.equal((await db.query("SELECT resolution_pending_resume FROM orders")).rows[0].resolution_pending_resume,true);
 await db.query("UPDATE erp_live_jobs SET status='complete'");
 await releaseExcelPurchaseHold(db,'o');
 assert.equal((await db.query("SELECT resolution_pending_resume FROM orders")).rows[0].resolution_pending_resume,false);
 await db.query("UPDATE orders SET resolution_pending_resume=true");
 await db.query("UPDATE resolution_jobs SET status='waiting' WHERE id='retry'");
 await releaseExcelPurchaseHold(db,'o');
 assert.equal((await db.query("SELECT resolution_pending_resume FROM orders")).rows[0].resolution_pending_resume,true);
});
