import test from 'node:test';import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {initializeMarketplaceInbox,applyMarketplaceReceipt} from '../src/marketplace-inbox.mjs';
import {platformReceiptDisposition} from '../src/platform-receipt-version.mjs';
const facade=e=>({query:(...args)=>e.query(...args),exec:sql=>e.exec(sql),transaction:fn=>e.transaction(tx=>fn(facade(tx)))});
const payload=(id,status)=>({id:String(id),name:'#TEST-'+id,created_at:'2026-10-10T10:00:00Z',updated_at:'2026-10-10T11:00:00Z',fulfillment_status:status,financial_status:'paid',cancelled_at:null,currency:'EUR',total_price:'10.00',taxes_included:true,shipping_lines:[],shipping_address:{name:'Client test',address1:'1 Rue test',zip:'75001',city:'Paris',country_code:'FR'},line_items:[{id:'L1',sku:'TEST',quantity:1,price:'10.00',tax_lines:[],discount_allocations:[]}]});
test('Real inbox creates identical preparation/jobs for shipped, cancelled, refunded or missing statuses',async()=>{
 const engine=new PGlite(),db=facade(engine);
 try{
 await db.exec(`CREATE TABLE settings(key text PRIMARY KEY,value jsonb);
 CREATE TABLE orders(id text PRIMARY KEY,channel text,reference text,source_reference text,recipient text,address jsonb,source_date timestamptz,source_payload jsonb,resolution_pending_resume boolean DEFAULT false,label_status text DEFAULT 'pending',issue text,carrier text,received_at timestamptz DEFAULT now(),archived boolean DEFAULT false,partial_mode boolean DEFAULT false,erp_live jsonb DEFAULT '{}',UNIQUE(channel,reference));
 CREATE TABLE lines(id text PRIMARY KEY,order_id text,source_line text,source_sku text,quantity numeric,source_payload jsonb);
 CREATE TABLE jobs(id text PRIMARY KEY,order_id text,kind text,status text DEFAULT 'pending');
 INSERT INTO settings VALUES('marketplace_automatic','{"enabled":true,"since":"2026-10-01T00:00:00Z"}');`);
 await initializeMarketplaceInbox(db);
 const variants=['unfulfilled','fulfilled','partial','partially_fulfilled',undefined,'UNKNOWN','cancelled','refunded'];
 for(let i=0;i<variants.length;i++){
  const p=payload(i+1,variants[i]);if(variants[i]==='cancelled')p.cancelled_at='2026-10-10T11:00:00Z';if(variants[i]==='refunded')p.financial_status='refunded';
  const receipt={channel:'shopify',shop:'example.myshopify.com',payload:p};
  const result=await applyMarketplaceReceipt(db,receipt);
  const order=(await db.query('SELECT * FROM orders WHERE id=$1',[result.id])).rows[0];
  assert.equal(order.label_status,'pending');assert.equal(order.resolution_pending_resume,false);assert.equal(order.issue,null);
  assert.deepEqual((await db.query('SELECT kind FROM jobs WHERE order_id=$1 ORDER BY kind',[result.id])).rows.map(j=>j.kind),['erp','label']);
  const before=JSON.stringify({label:order.label_status,hold:order.resolution_pending_resume,issue:order.issue,address:order.address,erp:order.erp_live});
  const next={...p,updated_at:'2026-10-10T12:00:00Z',cancelled_at:'2026-10-10T12:00:00Z',fulfillment_status:'fulfilled',financial_status:'refunded'};
  const applied=await applyMarketplaceReceipt(db,{...receipt,payload:next});assert.equal(applied.review,false);
  const fresh=(await db.query('SELECT * FROM orders WHERE id=$1',[result.id])).rows[0];
  assert.equal(JSON.stringify({label:fresh.label_status,hold:fresh.resolution_pending_resume,issue:fresh.issue,address:fresh.address,erp:fresh.erp_live}),before);
  assert.equal((await db.query('SELECT count(*)::int n FROM jobs WHERE order_id=$1',[result.id])).rows[0].n,2);
 }
 }finally{await engine.close();}
});
test('Version protection reexamines pending commercial data without any declaration veto',()=>{
 const current='2026-10-10T12:00:00Z';
 assert.equal(platformReceiptDisposition({observedVersion:current,incomingVersion:current,pending:false}),'skip');
 assert.equal(platformReceiptDisposition({observedVersion:current,incomingVersion:current,pending:true}),'process');
 assert.equal(platformReceiptDisposition({observedVersion:current,incomingVersion:'2026-10-10T11:00:00Z',pending:true}),'skip');
 assert.throws(()=>platformReceiptDisposition({observedVersion:current,pending:true}),/Date/);
});
