import test from 'node:test';import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {bcAllowedSql} from '../src/bc-authorization.mjs';
import {attachLogisticsObservations} from '../src/logistics-observation-view.mjs';
import {readFile} from 'node:fs/promises';
test('Recovery SQL never excludes TEMU orders for a declared cancellation request',async()=>{
 for(const name of ['financial-review-recovery','stock-auto-reconciliation','temu-command-recovery']){
  const code=await readFile(new URL('../src/'+name+'.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(code,/AND NOT jsonb_path_exists[^\n]*pending_buyer_cancellation/);
 }
});
test('BC selection ignores platform declarations and preserves human suspension',async()=>{
 const db=new PGlite();try{
 await db.exec('CREATE TABLE orders(id text,reference text,channel text,suspension jsonb,source_payload jsonb,archived boolean,resolution_pending_resume boolean,issue text,erp_live jsonb)');
 for(const channel of ['shopify','temu','amazon'])for(const status of [1,2,3,4,5]){
  await db.query('INSERT INTO orders(id,reference,channel,suspension,source_payload,archived,resolution_pending_resume,issue) VALUES($1,$2,$3,$4,$5,false,false,null)',[channel+status,'TEST',channel,JSON.stringify({}),JSON.stringify({cancelled:true,cancelled_at:'2026-10-10',financial_status:'refunded',temuOrderDetail:{parentOrderMap:{parentOrderStatus:status,parentOrderLabel:[{name:'pending_buyer_cancellation',value:1}]}}})]);
 }
 assert.equal((await db.query(`SELECT id FROM orders o WHERE ${bcAllowedSql}`)).rows.length,15);
 await db.exec("UPDATE orders SET suspension='{\"active\":true,\"note\":\"human\"}'::jsonb WHERE id='shopify1'");
 assert.equal((await db.query(`SELECT id FROM orders o WHERE ${bcAllowedSql}`)).rows.length,14);
 }finally{await db.close();}
});
test('Real SQL cached transport selection resolves all three parcel tables',async()=>{
 const db=new PGlite();try{
 await db.exec(`CREATE TABLE carrier_jobs(order_id text,carrier text,environment text,tracking jsonb,status text);
 CREATE TABLE extra_parcels(order_id text,carrier text,environment text,tracking text,status text);
 CREATE TABLE partial_deliveries(order_id text,carrier text,environment text,tracking jsonb,status text);
 CREATE TABLE carrier_tracking(carrier text,environment text,tracking text,checked_at timestamptz,events jsonb,error text);`);
 await db.exec("INSERT INTO carrier_jobs VALUES('o1','gls','production','[\"TRACK\"]','ready')");
 await db.query('INSERT INTO carrier_tracking VALUES($1,$2,$3,now(),$4,null)',['gls','production','TRACK',JSON.stringify([{carrier:'gls',tracking:'TRACK',code:'DELIVERED',label:'Delivered',at:new Date().toISOString()}])]);
 const rows=[{id:'o1',channel:'shopify',platform_status:{status:'unfulfilled'}}];await attachLogisticsObservations(db,rows);
 assert.equal(rows[0].logistics_observation.status,'delivered');assert.equal(rows[0].platform_status.status,'unfulfilled');
 }finally{await db.close();}
});
