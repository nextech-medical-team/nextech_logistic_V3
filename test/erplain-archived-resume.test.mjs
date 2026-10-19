import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';
import {resumeArchivedBl,archivedResumeBlock} from '../src/erplain-archived-resume.mjs';
import {retryPartialLabel} from '../src/partial-label-recovery.mjs';
const order=()=>({id:'o',channel:'amazon',archived:true,tracking_status:'delivered',label_status:'ready',erp_status:'complete',suspension:{},source_payload:{importCancellation:{scope:'import_only_not_marketplace',status:'cancelled',receiptId:'old-import'}},erp_live:{bc:{id:'bc'},bl:{id:'first',label:'BL-FIRST',status:'delivered'},stockDocument:{id:'old-stock'}}});
const document=()=>({id:'bc',status:'active',line_items:[{id:'line',quantity:56,price:1,location:{id:'loc'},variant:{id:'v',sku:'165674',track_inventory:true}}],shipping_orders:{data:[{id:'first',label:'BL-FIRST',status:'delivered'},{id:'second',label:'BL-SECOND',status:'pending',line_items:[{parent_id:'line',quantity:28,variant:{id:'v',sku:'165674'}}]}],paginatorInfo:{hasMorePages:false}}});
test('archived import resumes only selected existing BL and preserves former labels and cancellation history',async()=>{
 const e=new PGlite(),wrap=p=>({query:(q,a)=>p.query(q,a)}),db={...wrap(e),transaction:f=>e.transaction(p=>f(wrap(p)))};
 try{
 await e.exec(`CREATE TABLE orders(id text PRIMARY KEY,channel text,archived boolean,partial_mode boolean DEFAULT false,tracking_status text,label_status text,erp_status text,resolution_pending_resume boolean,erp_live jsonb,source_payload jsonb,suspension jsonb);
 CREATE TABLE partial_deliveries(id text PRIMARY KEY,order_id text,request_id text UNIQUE,status text,stage text,selection jsonb,bl jsonb,label_choice text,environment text,error text,tracking jsonb DEFAULT '[]',carrier_result jsonb);
 CREATE TABLE erp_live_jobs(order_id text,status text);CREATE TABLE carrier_jobs(order_id text,status text,result jsonb);CREATE TABLE resolution_jobs(order_id text,status text);CREATE TABLE partial_documents(delivery_id text,pdf bytea);CREATE TABLE carrier_documents(order_id text,pdf bytea);CREATE TABLE audit(user_email text,action text,detail jsonb);
 INSERT INTO carrier_jobs VALUES('o','ready','{"tracking":"OLD"}');INSERT INTO carrier_documents VALUES('o',decode('25504446','hex'));INSERT INTO erp_live_jobs VALUES('o','complete');`);
 const o=order(),bc=document(),user={email:'test@example.invalid'};
 await e.query('INSERT INTO orders(id,channel,archived,tracking_status,label_status,erp_status,erp_live,source_payload,suspension) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[o.id,o.channel,true,o.tracking_status,o.label_status,o.erp_status,JSON.stringify(o.erp_live),JSON.stringify(o.source_payload),'{}']);
 const run=()=>db.transaction(async tx=>resumeArchivedBl(tx,(await tx.query('SELECT * FROM orders WHERE id=$1',['o'])).rows[0],bc,'second',user));
 bc.shipping_orders.data[1].status='delivered';await assert.rejects(run,/pending/);bc.shipping_orders.data[1].status='pending';
 await e.query("INSERT INTO carrier_jobs VALUES('o','review',NULL)");await assert.rejects(run,/incertain/);await e.query("DELETE FROM carrier_jobs WHERE status='review'");
 const r=await run(),fresh=(await e.query('SELECT * FROM orders')).rows[0];
 assert.equal(fresh.archived,false);assert.equal(fresh.partial_mode,true);assert.equal(fresh.tracking_status,'not_shipped');assert.deepEqual(fresh.source_payload.importCancellation,o.source_payload.importCancellation);assert.equal(fresh.source_payload.archivedBlRecovery.previous.tracking_status,'delivered');assert.deepEqual(fresh.erp_live.bl,o.erp_live.bl);assert.deepEqual(fresh.erp_live.stockDocument,o.erp_live.stockDocument);
 const d=(await e.query('SELECT * FROM partial_deliveries')).rows[0];assert.equal(d.bl.id,'second');assert.equal(d.selection[0].sku,'165674');assert.equal(d.selection[0].quantity,28);assert.equal(d.status,'review');assert.equal(d.stage,'recovered_bl');assert.equal(r.labelPurchased,false);
 assert.equal((await run()).deliveryId,r.deliveryId);assert.equal((await e.query('SELECT count(*)::int n FROM partial_deliveries')).rows[0].n,1);
 assert.equal((await e.query('SELECT count(*)::int n FROM carrier_documents')).rows[0].n,1);assert.equal((await e.query('SELECT status FROM carrier_jobs')).rows[0].status,'ready');assert.equal((await e.query('SELECT status FROM erp_live_jobs')).rows[0].status,'complete');
 assert.equal((await retryPartialLabel(db,d.id)).labelOnly,true);assert.equal((await e.query('SELECT status FROM partial_deliveries')).rows[0].status,'bl_ready');
 }finally{await e.close();}
});
test('business cancellations and unrelated archival cannot be undone through local import recovery',()=>{
 assert.equal(archivedResumeBlock(order()),null);
 for(const edit of [o=>o.source_payload.importCancellation.scope='marketplace',o=>o.source_payload.importCancellation=null,o=>o.suspension={active:true},o=>o.suspension={erplainCancellation:{}},o=>o.source_payload.manualPlatformCancellation={cancelled:true},o=>o.channel='temu',o=>o.archived=false]){const o=order();edit(o);assert.ok(archivedResumeBlock(o));}
});
