import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {openDatabase} from '../src/db.mjs';
import {orderStatistics} from '../src/order-statistics.mjs';
import {orderPageDetails} from '../src/order-page-details.mjs';
import {projectCurrentDiagnostics} from '../src/current-order-diagnostics.mjs';
import {selectProblemOrders} from '../src/problem-typology.mjs';
import {currentProblemClassifier} from '../src/problem-typology-reader.mjs';
import {orderReadTransaction} from '../src/order-read-transaction.mjs';
import {orderSummaryCache} from '../src/order-summary-cache.mjs';

test('order reads commit before returning, scope JIT to a read-only snapshot and release pooled clients on failure',async()=>{
 for(const failure of [null,'read','commit']){
  const events=[],error=Error('fixture failure');
  const client={query:async sql=>{events.push(sql);if(failure==='commit'&&sql==='COMMIT')throw error;return {rows:[]};},release:()=>events.push('release')};
  const pool={connect:async()=>client},wrap=c=>({query:(...args)=>c.query(...args)});
  const run=orderReadTransaction(pool,async db=>{await db.query('SELECT 1');if(failure==='read')throw error;return 'packet';},wrap);
  if(failure)await assert.rejects(run,e=>e===error);else assert.equal(await run,'packet');
  assert.deepEqual(events.slice(0,3),['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY','SET LOCAL jit=off','SELECT 1']);
  assert.equal(events.at(-1),'release');assert.equal(events.at(-2),failure?'ROLLBACK':'COMMIT');
 }
});

test('summary cache retains revision invalidation and uses the active read snapshot',async()=>{
 let revision='1',calls=0;const snapshots=[];
 const outer={query:()=>{throw Error('must use snapshot');}};
 const reader={query:async()=>({rows:[{revision}]})};
 const cached=orderSummaryCache(outer,{read:async db=>{calls++;snapshots.push(db);return {summary:{total:calls}};}});
 const first=await cached(new URLSearchParams('page=1'),reader);
 assert.deepEqual(await cached(new URLSearchParams('page=2'),reader),first);assert.equal(calls,1);
 revision='2';assert.equal((await cached(new URLSearchParams(),reader)).summary.total,2);
 assert.ok(snapshots.every(db=>db===reader));
});

test('existing core databases receive the history index without changing jobs or latest-job order',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'nextech-order-read-'));
 let db;
 try{
  db=await openDatabase({directory});
  await db.query("INSERT INTO orders(id,channel,reference,recipient,address) VALUES('fixture','temu','TEST','Synthetic','{}')");
  await db.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,payload,created_at) VALUES('a','fixture','a','resume','{}','2026-10-12'),('b','fixture','b','equivalent-preview','{}','2026-10-12')");
  await db.exec('DROP INDEX resolution_order_history_idx');
  const before=(await db.query('SELECT * FROM resolution_jobs ORDER BY created_at DESC,id DESC')).rows;
  await db.close();db=await openDatabase({directory});
  const index=(await db.query("SELECT indexdef FROM pg_indexes WHERE indexname='resolution_order_history_idx'")).rows[0];
  assert.match(index.indexdef,/order_id, created_at DESC, id DESC/);
  assert.deepEqual((await db.query('SELECT * FROM resolution_jobs ORDER BY created_at DESC,id DESC')).rows,before);
  assert.equal((await db.query("SELECT id FROM resolution_jobs WHERE order_id='fixture' ORDER BY created_at DESC,id DESC LIMIT 1")).rows[0].id,'b');
 }finally{await db?.close();await rm(directory,{recursive:true,force:true});}
});

test('one statistics query preserves document families, unique counts, filters, exact IDs and empty scope',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`
   CREATE TABLE orders(id text,channel text,reference text,recipient text,source_payload jsonb DEFAULT '{}',erp_live jsonb DEFAULT '{}',address jsonb DEFAULT '{"country":"FR"}',suspension jsonb DEFAULT '{}',archived boolean DEFAULT false,partial_mode boolean DEFAULT false,carrier text,label_status text,tracking_status text,received_at timestamptz DEFAULT now());
   CREATE TABLE carrier_jobs(order_id text,status text,environment text);CREATE TABLE carrier_documents(order_id text);
   CREATE TABLE erp_live_jobs(order_id text,status text);CREATE TABLE partial_deliveries(id text,order_id text,carrier text,status text,bl jsonb);
   CREATE TABLE partial_documents(delivery_id text);CREATE TABLE extra_parcels(order_id text,carrier text,status text,pdf bytea);
   CREATE TABLE temu_label_documents(reference text,pdf bytea);
   INSERT INTO orders(id,channel,reference,carrier,label_status,tracking_status,partial_mode,archived) VALUES
   ('gls','amazon','GLS','gls_pharma','pending','delivered',false,false),
   ('mixed','shopify','MIX','gls','blocked','not_shipped',false,false),
   ('partial','amazon','PART','gofo','pending','not_shipped',true,false),
   ('temu','temu','TEMU','temu','pending','not_shipped',false,false),
   ('extra','shopify','EXTRA',null,'pending','not_shipped',false,false),
   ('none','shopify','NONE',null,'pending','not_shipped',false,false),
   ('archived','amazon','OLD','gls','blocked','delivered',false,true);
   INSERT INTO carrier_jobs VALUES('gls','ready','production'),('mixed','ready','sandbox'),('partial','ready','production'),('none','failed','production'),('archived','ready','production');
   INSERT INTO carrier_documents VALUES('gls'),('gls'),('mixed'),('partial'),('archived');
   INSERT INTO erp_live_jobs VALUES('none','review');
   INSERT INTO partial_deliveries VALUES('d1','partial','gls_shop','ready','{}'),('d2','partial','gofo','cancelled','{}');
   INSERT INTO partial_documents VALUES('d1'),('d1'),('d2');
   INSERT INTO extra_parcels VALUES('mixed','gofo','ready','\\x01'),('extra','gofo','ready','\\x01'),('none','gofo','failed','\\x01');
   INSERT INTO temu_label_documents VALUES('TEMU','\\x01'),('TEMU','\\x01');
  `);
  let queries=0;const read={query:(...args)=>{queries++;return db.query(...args);}};
  const all=await orderStatistics(read,new URLSearchParams());
  assert.equal(queries,1);
  assert.deepEqual(all,{transportStats:[{family:'gls',orders:2},{family:'gofo',orders:1},{family:'mixed',orders:1},{family:'temu',orders:1}],summary:{total:6,blocked:2,delivered:1,labels:5}});
  const subset=await orderStatistics(db,new URLSearchParams('channel=shopify'),['mixed','none','gls']);
  assert.deepEqual(subset,{transportStats:[{family:'mixed',orders:1}],summary:{total:2,blocked:2,delivered:0,labels:1}});
  assert.deepEqual(await orderStatistics(db,new URLSearchParams(),[]),{transportStats:[],summary:{total:0,blocked:0,delivered:0,labels:0}});
  assert.deepEqual((await orderStatistics(db,new URLSearchParams('country=BE'))).summary,{total:0,blocked:0,delivered:0,labels:0});
  // Delivered is now its own display status, never an active label/preparation state.
  assert.equal((await orderStatistics(db,new URLSearchParams('status=production_ready&status=sandbox_ready'))).summary.total,2);
  assert.equal((await orderStatistics(db,new URLSearchParams('status=delivered'))).summary.total,1);
 }finally{await db.close();}
});

test('phased details retain diagnostic dependencies and all displayed fields while display joins touch only the selected page',async()=>{
 const base=[
  {id:'complete',channel:'temu',reference:'COMPLETE',source_payload:{historicalShipments:[{tracking:'HISTORY'}]},erp_live:{bc:{id:'bc'}},partial_mode:true,partial_allocation:[{sku:'A',remaining:0}],document_count:0,issue:'Stock insuffisant'},
  {id:'replacement',channel:'amazon',reference:'REPLACEMENT',source_payload:{},erp_live:{},sku_lines:[{sku:'OLD',source_sku:'OLD',quantity:1,mapping_exists:true}],issue:'Stock insuffisant'},
  {id:'temu',channel:'temu',reference:'REFUSED',source_payload:{},erp_live:{},issue:null},
 ];
 function mock(){const calls=[];return {calls,async query(sql,[ids]){
  calls.push({sql,ids});
  if(sql.startsWith('SELECT order_id,bl'))return {rows:[{order_id:'complete',bl:{id:'bl'},status:'ready',environment:'production',documents:1}]};
  if(sql.startsWith('SELECT id,transport_choice'))return {rows:ids.map(id=>({id,transport_choice:null}))};
  if(sql.startsWith('SELECT DISTINCT ON'))return {rows:ids.includes('replacement')?[{order_id:'replacement',action:'equivalent-preview',status:'complete',payload:{sku:'OLD',replacementSku:'NEW',replaceQuantity:1},result:{previewFingerprint:'proof'}}]:[]};
  if(sql.startsWith('SELECT reference,status'))return {rows:ids.map(reference=>({reference,status:reference==='REFUSED'?'shipment_error':'paid',error:reference==='REFUSED'?'Shipping address error':null,result:{},plan:{}}))};
  if(sql.startsWith('SELECT d.reference'))return {rows:ids.includes('COMPLETE')?[{reference:'COMPLETE',package:'PACKAGE'}]:[]};
  if(sql.startsWith('SELECT detail'))return {rows:ids.includes('replacement')?[{detail:{orderId:'replacement',originalSku:'FIRST',replacementSku:'OLD',replaceQuantity:2,replacementQuantity:1}}]:[]};
  if(sql.startsWith('SELECT order_id,id,carrier'))return {rows:ids.filter(id=>id==='replacement').map(order_id=>({order_id,id:'extra',carrier:'gofo',status:'ready',tracking:'EXTRA'}))};
  if(sql.startsWith('WITH targets'))return {rows:[]};
  throw Error('Unexpected fixture query');
 }};}
 const all=structuredClone(base),phased=structuredClone(base),one=mock(),two=mock();
 await orderPageDetails(one,all);
 await orderPageDetails(two,phased,'diagnostics');
 assert.equal(two.calls.some(c=>/order.product_substituted|WITH targets|SELECT order_id,id,carrier/.test(c.sql)),false);
 for(const row of all)projectCurrentDiagnostics(row);for(const row of phased)projectCurrentDiagnostics(row);
 const classify=currentProblemClassifier();
 assert.deepEqual(selectProblemOrders(phased,[],classify).problemTypes,selectProblemOrders(all,[],classify).problemTypes);
 assert.equal(classify(phased[0]).length,0);assert.ok(classify(phased[1]).some(p=>p.label==='Appliquer le remplacement'));assert.ok(classify(phased[2]).some(p=>p.provider==='TEMU'));
 // Match the route's payload reduction before the display phase.
 for(const row of all)row.source_payload={};for(const row of phased)row.source_payload={};
 await orderPageDetails(two,phased.slice(1,2),'display');
 assert.deepEqual(phased[1],all[1]);
 const displayCalls=two.calls.filter(c=>/order.product_substituted|WITH targets|SELECT order_id,id,carrier/.test(c.sql));
 assert.ok(displayCalls.length>0);for(const call of displayCalls)assert.deepEqual(call.ids,['replacement']);
 assert.deepEqual(phased[0].external_shipments,[{tracking:'HISTORY'}]);
});
