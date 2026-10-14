import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {assertStockResolved,stockLockMessage} from '../src/stock-gate.mjs';
import {initializeStockResumeWatch,stockResumeWorker} from '../src/stock-resume-watch.mjs';

const line={quantity:100,available:400,on_hand:400,reserved_quantity:0,variant:{id:'2891802',sku:'30 100 22',track_inventory:true},location:{id:'100934'}};
const snapshot={id:'1935064',status:'active',update_stock:false,line_items:[line],shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}}};
let engine;
after(async()=>{if(engine)await engine.close();});
async function fixture(){
 engine||=new PGlite();const db={query:engine.query.bind(engine),exec:engine.exec.bind(engine),transaction:engine.transaction.bind(engine),close:async()=>{}};
 await db.exec('DROP TABLE IF EXISTS stock_resume_watch,orders,erp_live_jobs,carrier_jobs,partial_deliveries,resolution_jobs,audit,settings,carrier_documents CASCADE');await db.exec(`
 CREATE TABLE orders(id text PRIMARY KEY,reference text,channel text DEFAULT 'amazon',erp_live jsonb,archived boolean DEFAULT false,partial_mode boolean DEFAULT false,resolution_pending_resume boolean DEFAULT false,tracking_status text DEFAULT 'not_shipped',label_status text DEFAULT 'pending',suspension jsonb DEFAULT '{}',source_payload jsonb DEFAULT '{}',processing_priority_at timestamptz,address jsonb DEFAULT '{}',weight_kg numeric);
 CREATE TABLE erp_live_jobs(order_id text PRIMARY KEY,status text,error text,updated_at timestamptz DEFAULT now());
 CREATE TABLE carrier_jobs(order_id text,status text,stock_override jsonb);
 CREATE TABLE partial_deliveries(id text,order_id text,bl jsonb,stock_document jsonb,selection jsonb,updated_at timestamptz DEFAULT now());
 CREATE TABLE resolution_jobs(id text,order_id text,request_id text,action text,status text,stage text,payload jsonb,result jsonb,created_at timestamptz DEFAULT now());
 CREATE TABLE audit(user_email text,action text,detail jsonb);
 CREATE TABLE settings(key text,value jsonb);
 CREATE TABLE carrier_documents(order_id text,pdf bytea,tracking text);
 INSERT INTO settings VALUES('automatic_live','{"enabled":true}');
 INSERT INTO orders(id,reference,erp_live) VALUES('target','408-0229689-8598771','{"phase":"bc_created","bc":{"id":"1935064","status":"active"}}'),('blocker','404-5529102-4492367','{"phase":"creating_stock","bc":{"id":"1925931","status":"active"},"bl":{"id":"1902830","label":"SHO00743821"},"stockPendingVariants":["2891802"]}');
 INSERT INTO erp_live_jobs VALUES('blocker','review','ancien cycle non identifié',now()-interval '6 days');
 INSERT INTO carrier_jobs VALUES('target','ready','{"fingerprint":"existing"}');
 INSERT INTO carrier_documents VALUES('target',decode('010203','hex'),'KEEP-TRACKING');`);
 await db.query("INSERT INTO erp_live_jobs VALUES('target','review',$1,now()-interval '2 days')",[stockLockMessage]);
 await initializeStockResumeWatch(db);return db;
}
function provider(){let reads=0;return {get reads(){return reads;},async verify(){},async request(q){assert.match(q,/^query V3StockResume/);reads++;return {b0:structuredClone(snapshot)};}};}
test('real regression: historical creating_stock blocker is identified and rechecked within five minutes without mutation',async()=>{
 const db=await fixture();try{
  const api=provider(),worker=stockResumeWorker(db,'unused',{api});
  const pdf=(await db.query('SELECT * FROM carrier_documents')).rows;
  await worker.run();assert.equal(api.reads,1);
  const w=(await db.query("SELECT *,extract(epoch from next_at-checked_at) seconds FROM stock_resume_watch WHERE order_id='target'")).rows[0];
  assert.equal(w.outcome,'waiting_reconciliation');assert.equal(w.failures,0);assert.ok(Number(w.seconds)<=301);
  const e=(await db.query("SELECT * FROM erp_live_jobs WHERE order_id='target'")).rows[0];assert.equal(e.status,'review');assert.match(e.error,/404-5529102-4492367.*SHO00743821.*blocage prolongé/);
  assert.equal((await db.query('SELECT * FROM resolution_jobs')).rows.length,0);
  assert.deepEqual((await db.query('SELECT * FROM carrier_documents')).rows,pdf);
  await worker.run();assert.equal(api.reads,1,'lease prevents a tight API loop');
 }finally{await db.close();}
});
test('after independently verified blocker resolution, automatic resume queues once and preserves existing PDF',async()=>{
 const db=await fixture();try{
  const api=provider(),worker=stockResumeWorker(db,'unused',{api});await worker.run();
  await db.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{phase}','\"stock_review\"') WHERE id='blocker'");
  await db.query("UPDATE stock_resume_watch SET next_at=now()-interval '1 minute'");
  await worker.run();assert.equal((await db.query("SELECT status FROM erp_live_jobs WHERE order_id='target'")).rows[0].status,'pending');
  const jobs=(await db.query('SELECT * FROM resolution_jobs')).rows;assert.equal(jobs.length,1);assert.equal(jobs[0].action,'resume-erp');assert.equal(jobs[0].result.labelRequested,true);
  await worker.run();assert.equal((await db.query('SELECT * FROM resolution_jobs')).rows.length,1);
  assert.equal((await db.query('SELECT tracking FROM carrier_documents')).rows[0].tracking,'KEEP-TRACKING');
 }finally{await db.close();}
});
test('SQL NULL and JSON null unresolved stock documents both block; own order is excluded',async()=>{
 const db=await fixture();try{
  await assert.rejects(assertStockResolved(db,['2891802'],{orderId:'target'}),e=>e.code==='STOCK_RECONCILIATION_PENDING');
  await db.query("UPDATE orders SET erp_live=erp_live||'{\"stockDocument\":null}'::jsonb WHERE id='blocker'");
  await assert.rejects(assertStockResolved(db,['2891802'],{orderId:'target'}));
  await assertStockResolved(db,['2891802'],{orderId:'blocker'});await assertStockResolved(db,['other'],{orderId:'target'});
 }finally{await db.close();}
});
test('partial pending stock keeps its own blocker reference and never queues the target',async()=>{
 const db=await fixture();try{
  await db.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{phase}','\"stock_review\"') WHERE id='blocker'");
  await db.query("INSERT INTO partial_deliveries(id,order_id,bl,stock_document,selection) VALUES('delivery','blocker','{\"status\":\"pending\",\"label\":\"PARTIAL-BL\"}',NULL,'[{\"variantId\":\"2891802\"}]')");
  await stockResumeWorker(db,'unused',{api:provider()}).run();assert.match((await db.query("SELECT error FROM erp_live_jobs WHERE order_id='target'")).rows[0].error,/PARTIAL-BL/);
  await assertStockResolved(db,['2891802'],{orderId:'target',deliveryId:'delivery'});
 }finally{await db.close();}
});
for(const change of ["suspension='{\"active\":true}'","archived=true","partial_mode=true","tracking_status='shipped'","resolution_pending_resume=true","source_payload='{\"marketplacePendingCorrection\":{}}'"]){
 test('no automatic resume for protected order: '+change,async()=>{const db=await fixture();try{await db.query('UPDATE orders SET '+change+" WHERE id='target'");const api=provider();await stockResumeWorker(db,'unused',{api}).run();assert.equal(api.reads,0);assert.equal((await db.query('SELECT * FROM resolution_jobs')).rows.length,0);}finally{await db.close();}});
}
test('stock unavailable or incomplete still prevents resume after blocker resolution',async()=>{
 const db=await fixture();try{
  await db.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{phase}','\"stock_review\"') WHERE id='blocker'");
  const api={async verify(){},async request(){const b=structuredClone(snapshot);b.line_items[0].available=0;return {b0:b};}};
  await stockResumeWorker(db,'unused',{api}).run();assert.equal((await db.query('SELECT * FROM resolution_jobs')).rows.length,0);assert.match((await db.query('SELECT last_error FROM stock_resume_watch')).rows[0].last_error,/stock insuffisant/);
 }finally{await db.close();}
});
