import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {importOrders,previewOrders} from '../src/imports.mjs';
import {sameImportIdentity,matchImport} from '../src/import-reception.mjs';
import {recoverOrder,externalReference} from '../src/erplain-document-metadata.mjs';

async function fixture(){const db=new PGlite();await db.exec(`CREATE TABLE orders(id text PRIMARY KEY,channel text,reference text,source_reference text,duplicate_of text,recipient text,address jsonb,source_date text,source_payload jsonb DEFAULT '{}',label_status text DEFAULT 'pending',erp_status text DEFAULT 'pending',tracking_status text DEFAULT 'unknown',archived boolean DEFAULT false,resolution_pending_resume boolean DEFAULT false,erp_live jsonb DEFAULT '{}',issue text,received_at timestamptz DEFAULT now(),UNIQUE(channel,reference));CREATE TABLE lines(id text PRIMARY KEY,order_id text,source_line text,source_sku text,quantity numeric,source_payload jsonb);CREATE TABLE jobs(id text PRIMARY KEY,order_id text,kind text);CREATE TABLE import_receipts(id text PRIMARY KEY,signature text,result jsonb);`);return db;}
const file=(reference='#1001',quantity=8)=>Buffer.from(`Name,Id,Lineitem sku,Lineitem quantity\n${reference},1001,A,${quantity}`);
const options=(shop='shop.myshopify.com',quantity=8,reference='#1001')=>({shopifyReader:{shop,order:async()=>({id:'1001',name:reference,currency:'EUR',created_at:'2026-10-15',taxes_included:true,line_items:[{id:'line',sku:'A',quantity,price:'10',discount_allocations:[],tax_lines:[]}],shipping_lines:[],shipping_address:{name:'Test',country_code:'FR'}})}});

test('rolling files cannot create a voluntary copy; every reception and changed source is retained',async()=>{
 const db=await fixture();try{
  await importOrders(db,file(),'day1.csv','shopify',undefined,options());
  const replay=await importOrders(db,file(),'day2.csv','shopify',['#1001'],{...options(),requestId:'00000000-0000-4000-8000-000000000001',duplicateSelection:['#1001']});
  assert.equal(replay.created,0);assert.equal(replay.copies,0);
  await importOrders(db,file('#1001',9),'day3.csv','shopify',undefined,options('shop.myshopify.com',9));
  assert.equal((await db.query('SELECT * FROM orders')).rows.length,1);
  assert.equal(Number((await db.query('SELECT quantity FROM lines')).rows[0].quantity),8);
  const receipts=(await db.query('SELECT * FROM order_import_receptions ORDER BY created_at')).rows;
  assert.equal(receipts.length,3);assert.equal(receipts[1].outcome,'duplicate_received');assert.equal(receipts[2].snapshot.lines[0].quantity,9);assert.equal(receipts[2].outcome,'duplicate_changed');
 }finally{await db.close();}
});
test('Shopify ID matches even when display reference changes; two known shops retain two independent orders',async()=>{
 const db=await fixture();try{
  await importOrders(db,file(),'first.csv','shopify',undefined,options());
  await importOrders(db,file('#changed'),'changed.csv','shopify',undefined,options('shop.myshopify.com',8,'#changed'));
  assert.equal((await db.query('SELECT * FROM orders')).rows.length,1);
  await importOrders(db,file(),'other-shop.csv','shopify',undefined,options('other.myshopify.com'));
  const orders=(await db.query('SELECT * FROM orders ORDER BY received_at')).rows;
  assert.equal(orders.length,2);assert.equal(orders[1].source_reference,'#1001');assert.equal(externalReference(orders[1]),'#1001');
  assert.equal((await previewOrders(db,file(),'again.csv','shopify',options('other.myshopify.com'))).duplicateCount,1);
 }finally{await db.close();}
});
test('existing ERP import blocks duplicate creation while retaining source reception for reconciliation',async()=>{
 const db=await fixture();try{
  await db.query("INSERT INTO orders(id,channel,reference,source_payload) VALUES('erp','erplain','#1001','{\"erplainImported\":true}')");
  const result=await importOrders(db,file(),'source.csv','shopify',undefined,options());
  assert.equal(result.created,0);assert.equal((await db.query('SELECT * FROM orders')).rows.length,1);
  assert.equal((await db.query('SELECT outcome FROM order_import_receptions')).rows[0].outcome,'identity_review');
 }finally{await db.close();}
});
test('unknown shop is an explicit identity observation, never an automatic merge or copy',()=>{
 const known={id:'a',channel:'shopify',reference:'#1',source_payload:{id:'1',sourceShop:'a.myshopify.com'}};
 const incoming={reference:'#1',source_payload:{id:'1'}};
 assert.equal(matchImport(incoming,[known],'shopify').ambiguous,true);
 assert.equal(sameImportIdentity({...incoming,source_payload:{id:'1',sourceShop:'b.myshopify.com'}},known,'shopify'),false);
});
test('unmarked ERP reference prevents a second BC instead of being silently ignored',async()=>{
 const o={id:'local',reference:'ORDER-1'};
 const api={request:async()=>({Orders:{data:[{id:7,status:'active',external_reference:'ORDER-1'}],paginatorInfo:{hasMorePages:false}}})};
 await assert.rejects(()=>recoverOrder(api,o),/rapprocher avant création/);
 const marked={...api,request:async()=>({Orders:{data:[{id:7,status:'active',external_reference:'ORDER-1',internal_notes:'[V3:local]'}],paginatorInfo:{hasMorePages:false}}})};
 assert.equal((await recoverOrder(marked,o)).id,7);
});
test('same reference in another proved marketplace or Shopify shop does not falsely block a new BC',async()=>{
 const candidate={id:7,status:'active',external_reference:'#1001',internal_notes:'[V3:owner]'},api={request:async()=>({Orders:{data:[candidate],paginatorInfo:{hasMorePages:false}}})};
 for(const [channel,source_payload] of [['amazon',{}],['shopify',{sourceShop:'other.myshopify.com'}]]){
  const owner={id:'owner',channel,source_payload,erp_live:{bc:{id:7}}},db={query:async()=>({rows:[owner]})},current={id:'new',channel:'shopify',reference:'#1001',source_payload:{sourceShop:'current.myshopify.com'}};
  assert.equal(await recoverOrder(api,current,{db}),null);
  await assert.rejects(()=>recoverOrder({...api,request:async()=>({Orders:{data:[{...candidate,internal_notes:''}],paginatorInfo:{hasMorePages:false}}})},current,{db}),/rapprocher/);
 }
 const db={query:async()=>({rows:[{id:'owner',channel:'shopify',source_payload:{sourceShop:'current.myshopify.com'},erp_live:{bc:{id:7}}}]})};
 await assert.rejects(()=>recoverOrder(api,{id:'new',channel:'shopify',reference:'#1001',source_payload:{sourceShop:'current.myshopify.com'}},{db}),/rapprocher/);
});
test('a cancelled ERP BC is not absence proof and cannot silently cause a new creation',async()=>{
 const o={id:'current',reference:'REF',channel:'amazon'};
 for(const internal_notes of ['', '[V3:current]']){
  const api={request:async()=>({Orders:{data:[{id:7,status:'cancelled',external_reference:'REF',internal_notes}],paginatorInfo:{hasMorePages:false}}})};
  await assert.rejects(()=>recoverOrder(api,o),/BC annulé/);
 }
 const api={request:async()=>({Orders:{data:[{id:7,status:'cancelled',external_reference:'REF',internal_notes:'[V3:current]'},{id:8,status:'active',external_reference:'REF',internal_notes:'[V3:current]'}],paginatorInfo:{hasMorePages:false}}})};
 await assert.rejects(()=>recoverOrder(api,o),/BC annulé/);
 assert.equal((await recoverOrder(api,{...o,erp_live:{previousCancelledCycle:{bc:{id:7}}}})).id,8); // recover a documented existing cycle, never create
});
test('reusable customer numbers never prove ownership of a BC; incomplete search never proves absence',async()=>{
 const current={id:'current',channel:'shopify',reference:'#1001',source_payload:{sourceShop:'current.myshopify.com'}},candidate={id:7,status:'active',external_reference:'#1001',internal_notes:'[V3:owner]',customer:{customer_number:'V3:current'}};
 const db={query:async()=>({rows:[{id:'owner',channel:'shopify',source_payload:{sourceShop:'other.myshopify.com'},erp_live:{bc:{id:7}}}]})};
 assert.equal(await recoverOrder({request:async()=>({Orders:{data:[candidate],paginatorInfo:{hasMorePages:false}}})},current,{db}),null);
 await assert.rejects(()=>recoverOrder({request:async()=>({Orders:{data:[{...candidate,internal_notes:''}],paginatorInfo:{hasMorePages:false}}})},current),/rapprocher/);
 await assert.rejects(()=>recoverOrder({request:async()=>({Orders:{data:[],paginatorInfo:{}}})},current),/incomplète/);
 await assert.rejects(()=>recoverOrder({request:async()=>({Orders:{data:[{status:'active'}],paginatorInfo:{hasMorePages:false}}})},current),/incomplète/);
});
