import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';
import {hasCompleteOrderDocuments,hasCompletePartialDocuments,completeOrderDocumentsSql} from '../src/complete-order-documents.mjs';
import {projectCurrentDiagnostics} from '../src/current-order-diagnostics.mjs';
import {orderPageDetails} from '../src/order-page-details.mjs';
const row=()=>({id:'o',partial_mode:true,erp_live:{bc:{id:'bc'}},partial_allocation:[{sku:'A',remaining:0},{sku:'B',remaining:0}],partial_document_status:[{bl:{id:'bl1',status:'pending'},status:'ready',environment:'production',documents:1},{bl:{id:'bl2',status:'ready_to_ship'},status:'ready',environment:'production',documents:1}],issue:'BL bloqué — stock insuffisant : B',erp_live_job:{status:'review',error:'BL bloqué — stock insuffisant : B'}});
test('all partial BLs and production PDFs with zero remainder retire stale diagnostics in projection only',()=>{
 const original=row(),snapshot=JSON.stringify(original);assert.equal(hasCompletePartialDocuments(original),true);const projected=projectCurrentDiagnostics(structuredClone(original));assert.equal(projected.issue,null);assert.equal(projected.erp_live_job.error,null);assert.equal(projected.erp_live_job.status,'review');assert.equal(JSON.stringify(original),snapshot);
});
test('unprepared remainder, nonready delivery, absent PDF, test environment and unknown allocation stay visible',()=>{
 for(const change of [o=>o.partial_allocation[1].remaining=1,o=>o.partial_allocation=[],o=>o.partial_allocation[0].remaining=null,o=>o.partial_document_status[1].status='review',o=>o.partial_document_status[1].documents=0,o=>o.partial_document_status[1].environment='test',o=>o.partial_document_status[1].bl.id=null]){const o=row();change(o);assert.equal(hasCompleteOrderDocuments(o),false);assert.match(projectCurrentDiagnostics(o).issue,/stock insuffisant/);}
 const o=row();o.partial_document_status.push({status:'cancelled',bl:{id:'old',status:'cancelled'},documents:1});assert.equal(hasCompletePartialDocuments(o),true);
});
test('page enrichment supplies verified partial documents without changing business records or issuing provider calls',async()=>{
 const o={...row(),channel:'tender',reference:'EXAMPLE',source_payload:{}};delete o.partial_document_status;
 const parts=row().partial_document_status.map(d=>({...d,order_id:'o'})),snapshot=JSON.stringify(parts),queries=[];
 const db={query:async sql=>{queries.push(sql);return {rows:sql.startsWith('SELECT order_id,bl,status,environment')?parts:[]};}};
 await orderPageDetails(db,[o],'diagnostics');assert.equal(o.complete_order_documents,true);assert.equal(o.partial_document_status.length,2);assert.equal(projectCurrentDiagnostics(o).issue,null);
 assert.equal(JSON.stringify(parts),snapshot);assert(queries.every(sql=>sql.startsWith('SELECT')));
});
test('real SQL document proof closes only a fully allocated partial order and retains persisted jobs and PDFs',async()=>{
 const db=new PGlite();try{
 await db.exec(`CREATE TABLE orders(id text,partial_mode boolean,channel text,reference text,erp_live jsonb);
 CREATE TABLE lines(order_id text,source_sku text,target_sku text,quantity numeric,target_quantity numeric);CREATE TABLE mappings(channel text,source_sku text,target_sku text,source_qty numeric,target_qty numeric);
 CREATE TABLE partial_deliveries(id text,order_id text,status text,environment text,selection jsonb,bl jsonb);CREATE TABLE partial_documents(delivery_id text,pdf bytea);
 CREATE TABLE carrier_jobs(order_id text,status text);CREATE TABLE carrier_documents(order_id text,pdf bytea);CREATE TABLE temu_label_jobs(reference text,result jsonb,packages jsonb);CREATE TABLE temu_label_documents(reference text,package text,pdf bytea);
 INSERT INTO orders VALUES('o',true,'tender','EXAMPLE','{"bc":{"id":"bc"},"partialSource":{"lines":[{"sku":"A","quantity":2},{"sku":"B","quantity":24}],"allocations":[],"allocatedBlIds":[]}}');
 INSERT INTO partial_deliveries VALUES('d1','o','ready','production','[{"sku":"A","quantity":2}]','{"id":"bl1","status":"pending"}'),('d2','o','ready','production','[{"sku":"B","quantity":24}]','{"id":"bl2","status":"ready_to_ship"}');
 INSERT INTO partial_documents VALUES('d1',decode('255044462d','hex')),('d2',decode('255044462d','hex'));`);
 const proof=async()=>(await db.query('SELECT '+completeOrderDocumentsSql+' complete FROM orders WHERE id=$1',['o'])).rows[0].complete;
 const before=(await db.query('SELECT * FROM partial_deliveries ORDER BY id')).rows;assert.equal(await proof(),true);
 await db.query("UPDATE partial_deliveries SET status='review' WHERE id='d2'");assert.equal(await proof(),false);
 await db.query("UPDATE partial_deliveries SET status='ready' WHERE id='d2'");await db.query("DELETE FROM partial_documents WHERE delivery_id='d2'");assert.equal(await proof(),false);
 await db.query("INSERT INTO partial_documents VALUES('d2',decode('255044462d','hex'))");
 await db.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{partialSource,lines}','[{\"sku\":\"A\",\"quantity\":2},{\"sku\":\"B\",\"quantity\":25}]')");assert.equal(await proof(),false);
 await db.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{partialSource,lines}','[{\"sku\":\"A\",\"quantity\":2},{\"sku\":\"B\",\"quantity\":24}]')");assert.equal(await proof(),true);
 assert.deepEqual((await db.query('SELECT * FROM partial_deliveries ORDER BY id')).rows,before);assert.equal((await db.query('SELECT count(*)::int n FROM partial_documents')).rows[0].n,2);
 }finally{await db.close();}
});
