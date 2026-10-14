import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {PDFDocument} from 'pdf-lib';
import {initializeReceiptWarehouse,receiptWarehouseExports,combineReceiptPdfs} from '../src/receipt-warehouse-export.mjs';

async function fixture({uncertain=false}={}){
 const engine=new PGlite();await engine.waitReady;const db={query:(s,p=[])=>engine.query(s,p),exec:s=>engine.exec(s)};
 await db.exec('CREATE TABLE receipt_recovery_runs(id text PRIMARY KEY,plan jsonb); CREATE TABLE orders(id text,reference text,tracking_status text,archived boolean,erp_live jsonb);');
 await db.query('INSERT INTO receipt_recovery_runs VALUES($1,$2)',['run',JSON.stringify({rows:[{id:'order',bls:[{id:44,label:'SHO44',status:'in_preparation'}]}]})]);
 await db.query('INSERT INTO orders VALUES($1,$2,$3,false,$4)',['order','ORDER','not_shipped',JSON.stringify({bl:{id:44,label:'SHO44',status:'in_preparation'}})]);
 await initializeReceiptWarehouse(db);const doc=await PDFDocument.create();doc.addPage([100,150]);const bytes=Buffer.from(await doc.save());const calls=[];
 const api={async verify(){},async request(q,v){calls.push({q,v});if(q.startsWith('mutation ')){if(uncertain)throw Error('Network result unknown');return {GenerateShippingOrdersPdfs:'TASK'};}return {JobBatch:{id:'TASK',pending_jobs:0,failed_jobs:0,errors:null,finished_at:'2026-10-14',file:{id:9,mime:'application/pdf'}}};}};
 const service=receiptWarehouseExports(db,'unused',{api,pdfFetch:async()=>bytes,buildLabels:async()=>bytes});
 return {engine,db,service,bytes,calls};
}
test('durable warehouse export reuses the same request and exposes labels independently of ERP PDF completion',async()=>{
 const f=await fixture();try{
  const a=await f.service.start('run',['order'],{email:'test@example.test'}),b=await f.service.start('run',['order'],{email:'test@example.test'});assert.equal(a.id,b.id);
  await f.service.advance();const pending=await f.service.status(a.id);assert.equal(pending.labels_ready,true);assert.equal(pending.bl_ready,false);
  await f.service.advance();await f.service.advance();const done=await f.service.status(a.id);assert.equal(done.state,'complete');assert.equal(done.bl_ready,true);
  assert.equal(f.calls.filter(c=>c.q.startsWith('mutation ')).length,1);assert.ok(f.calls.every(c=>!c.q.includes('Order(id:')&&!c.q.includes('stock')));
  assert.equal((await f.db.query('SELECT erp_live FROM orders')).rows[0].erp_live.bl.status,'in_preparation');
 }finally{await f.engine.close();}
});
test('uncertain PDF generation is not replayed and existing combined labels remain downloadable',async()=>{
 const f=await fixture({uncertain:true});try{
  const a=await f.service.start('run',['order'],{email:'test@example.test'});await f.service.advance();await f.service.advance();
  const s=await f.service.status(a.id);assert.equal(s.state,'review');assert.equal(s.labels_ready,true);assert.match(s.error,/unknown/);assert.equal(f.calls.length,1);
 }finally{await f.engine.close();}
});
test('exports refuse orders outside the receipt and already delivered BLs',async()=>{
 const f=await fixture();try{
  await assert.rejects(()=>f.service.start('run',['other'],{}),/hors/);
  await f.db.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{bl,status}','\"delivered\"'::jsonb)");
  // Fresh local status also supersedes an older plan status for finished orders.
  await f.db.query("UPDATE orders SET tracking_status='delivered'");await assert.rejects(()=>f.service.start('run',['order'],{}),/terminée/);
 }finally{await f.engine.close();}
});
test('PDF combining preserves the original page dimensions and counts',async()=>{
 const a=await PDFDocument.create();a.addPage([100,150]);const b=await PDFDocument.create();b.addPage([595,842]);
 const merged=await PDFDocument.load(await combineReceiptPdfs([Buffer.from(await a.save()),Buffer.from(await b.save())]));assert.equal(merged.getPageCount(),2);assert.equal(merged.getPage(0).getWidth(),100);assert.equal(merged.getPage(1).getHeight(),842);
});
