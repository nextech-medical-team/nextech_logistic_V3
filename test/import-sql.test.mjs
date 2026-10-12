import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {previewOrders,importOrders} from '../src/imports.mjs';
import {cancelledImportSql,releaseCancelledImportReferences} from '../src/cancelled-import-reimport.mjs';

test('public import scope executes real SQL for preview, persistence and duplicates',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`
   CREATE TABLE orders(id text PRIMARY KEY,channel text,reference text,source_reference text,duplicate_of text,recipient text,address jsonb,source_date text,source_payload jsonb DEFAULT '{}',label_status text DEFAULT 'pending',erp_status text DEFAULT 'pending',tracking_status text DEFAULT 'unknown',archived boolean DEFAULT false,resolution_pending_resume boolean DEFAULT false,erp_live jsonb DEFAULT '{}',received_at timestamptz DEFAULT now(),UNIQUE(channel,reference));
   CREATE TABLE lines(id text PRIMARY KEY,order_id text,source_line text,source_sku text,quantity numeric,source_payload jsonb);
   CREATE TABLE jobs(id text PRIMARY KEY,order_id text,kind text);
  `);
  assert.doesNotMatch(cancelledImportSql,/IN\s*\(\s*\)/);
  const file=Buffer.from('Name,Id,Lineitem sku,Lineitem quantity\n#1001,1001,A,8');
  const options={shopifyReader:{shop:'example.myshopify.com',order:async()=>({id:'1001',name:'#1001',created_at:'2026-10-12T10:00:00Z',currency:'EUR',taxes_included:true,line_items:[{id:'2001',sku:'A',quantity:8,price:'10.00',tax_lines:[],discount_allocations:[]}],shipping_lines:[],shipping_address:{name:'Test',country_code:'FR'}})}};
  let preview=await previewOrders(db,file,'orders.csv','shopify',options);
  assert.equal(preview.newCount,1);assert.equal(preview.errors.length,0);
  const result=await importOrders(db,file,'orders.csv','shopify',['#1001'],options);
  assert.equal(result.created,1);assert.equal((await db.query('SELECT * FROM jobs')).rows.length,2);
  preview=await previewOrders(db,file,'orders.csv','shopify',options);
  assert.equal(preview.duplicateCount,1);
  const repeat=await importOrders(db,file,'orders.csv','shopify',['#1001'],options);
  assert.equal(repeat.created,0);assert.equal((await db.query('SELECT * FROM jobs')).rows.length,2);

  await db.query(`INSERT INTO orders(id,channel,reference,source_payload,tracking_status,archived) VALUES('cancelled','amazon','OLD',$1,'cancelled',true)`,[JSON.stringify({importCorrection:{cancelled:true,scope:'import_only_not_marketplace'}})]);
  await releaseCancelledImportReferences(db,'amazon',['OLD']);
  const cancelled=(await db.query("SELECT reference,source_payload FROM orders WHERE id='cancelled'")).rows[0];
  assert.notEqual(cancelled.reference,'OLD');assert.equal(cancelled.source_payload.importCorrection.cancelled,true);
  await releaseCancelledImportReferences(db,'shopify',['#1001']);
  assert.equal((await db.query("SELECT reference FROM orders WHERE id!='cancelled'")).rows[0].reference,'#1001');
 }finally{await db.close();}
});
