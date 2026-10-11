import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';
import {preparationObserverService} from '../src/preparation-observer-service.mjs';
import {currentPreparationObservation} from '../src/preparation-observation-view.mjs';
async function fixture(){const engine=new PGlite();await engine.exec(`
 CREATE TABLE orders(id text PRIMARY KEY,channel text,reference text,archived boolean DEFAULT false,partial_mode boolean DEFAULT false,suspension jsonb DEFAULT '{}',erp_status text,erp_live jsonb DEFAULT '{}');
 CREATE TABLE erp_live_jobs(order_id text,status text,error text);
 CREATE TABLE resolution_jobs(id text,order_id text,status text);CREATE TABLE correction_jobs(id text,order_id text,status text);
 CREATE TABLE lines(id text,order_id text,source_sku text,target_sku text,quantity numeric,target_quantity numeric,source_payload jsonb DEFAULT '{}');
 CREATE TABLE mappings(channel text,source_sku text,target_sku text,source_qty numeric,target_qty numeric);
 CREATE TABLE order_recheck_monitor(order_id text PRIMARY KEY,requested bigint,state jsonb DEFAULT '{}',next_check timestamptz);
 INSERT INTO orders(id,channel,reference,erp_status) VALUES('a','shopify','A','live_review'),('b','shopify','B','live_review');
 INSERT INTO erp_live_jobs VALUES('a','review',NULL),('b','review',NULL);
 INSERT INTO lines(id,order_id,source_sku,quantity) VALUES('1','a','X',10),('2','b','X',20);
 INSERT INTO mappings VALUES('shopify','X','X',1,1);
 INSERT INTO order_recheck_monitor(order_id,requested) VALUES('a',1),('b',1);
 `);const held=[];return {engine,db:{query:(...args)=>engine.query(...args),withLocks:async(keys,fn)=>{held.push(...keys);try{return await fn();}finally{held.splice(held.length-keys.length);}},transaction:fn=>engine.transaction(tx=>fn({query:(...args)=>{if(args[0].startsWith('UPDATE order_recheck_monitor'))assert.ok(held.includes('order-recheck-local'),'proof persistence shares local monitor lock');return tx.query(...args);}}))}};}
const product={status:'active',lookupProof:{responseComplete:true},variant:{id:1,sku:'X',active:true,product:{active:true},track_inventory:true,stock_levels:{data:[{location:{id:100934},available:0,on_hand:0}],paginatorInfo:{hasMorePages:false}}}};
test('native tender and sample lines reach stock checks without inventing an external mapping',async()=>{
 const {engine,db}=await fixture();try{
  await engine.exec(`DELETE FROM mappings; UPDATE orders SET channel=CASE id WHEN 'a' THEN 'tender' ELSE 'samples' END;
   INSERT INTO orders(id,channel,reference,erp_status) VALUES('c','shopify','C','live_review'),('d','tender','D','live_review');
   INSERT INTO erp_live_jobs VALUES('c','review',NULL),('d','review',NULL);
   INSERT INTO lines(id,order_id,source_sku,target_sku,quantity,target_quantity,source_payload) VALUES('3','c','X','X',1,1,'{}'),('4','d','X',NULL,1,NULL,'{"mappingScope":"order"}');
   INSERT INTO order_recheck_monitor(order_id,requested) VALUES('c',1),('d',1);`);
  const service=preparationObserverService(db,'unused',{api:{verify:async()=>({id:100174}),request:()=>assert.fail('supplier mutation')},readReferences:async()=>({companyId:100174,locationId:100934}),findDocument:async()=>null,readProduct:async()=>product});
  assert.equal((await service.run()).persisted,4);
  const states=new Map((await engine.query('SELECT order_id,state FROM order_recheck_monitor')).rows.map(r=>[r.order_id,r.state.preparationObservation]));
  for(const id of ['a','b']){assert.equal(states.get(id).mappingVerified,true);assert.equal(states.get(id).business[0].code,'stock-insufficient');}
  for(const id of ['c','d']){assert.equal(states.get(id).mappingVerified,false);assert.equal(states.get(id).business[0].code,'mapping');}
 }finally{await engine.close();}
});
test('real PostgreSQL observation is periodic, shared, version guarded and never changes business/jobs',async()=>{
 const {engine,db}=await fixture();try{let reads=0,verifications=0;
 const make=extra=>preparationObserverService(db,'unused',{api:{verify:async()=>{verifications++;return {id:100174};},request:()=>assert.fail('unexpected source query')},readReferences:async()=>({companyId:100174,locationId:100934}),findDocument:async()=>null,readProduct:async()=>{reads++;return product;},...extra});
 const before=await engine.query('SELECT * FROM orders ORDER BY id');const jobs=await engine.query('SELECT * FROM erp_live_jobs ORDER BY order_id');
 const service=make();assert.equal((await service.run()).persisted,2);assert.equal(reads,1);assert.equal(verifications,1);
 const monitors=(await engine.query('SELECT * FROM order_recheck_monitor ORDER BY order_id')).rows;assert.equal(currentPreparationObservation(monitors[0].state,monitors[0].requested).business[0].code,'stock-insufficient');
 assert.equal((await service.run()).orders,0);assert.equal(reads,1);
 assert.deepEqual((await engine.query('SELECT * FROM orders ORDER BY id')).rows,before.rows);assert.deepEqual((await engine.query('SELECT * FROM erp_live_jobs ORDER BY order_id')).rows,jobs.rows);
 await engine.query("UPDATE order_recheck_monitor SET requested=requested+1 WHERE order_id='a'");assert.equal(currentPreparationObservation(monitors[0].state,2),null);
 const race=make({readProduct:async()=>{await engine.query("UPDATE order_recheck_monitor SET requested=requested+1 WHERE order_id='a'");return product;}});assert.equal((await race.run()).deferred,1);
 await engine.query("INSERT INTO correction_jobs VALUES('c','a','checking')");assert.equal((await service.run()).orders,0);
 await engine.query("DELETE FROM correction_jobs");await engine.query("UPDATE erp_live_jobs SET status='complete' WHERE order_id='a'");assert.equal((await service.run()).orders,0);
 }finally{await engine.close();}
});
test('identity, depot, incomplete recovery and mutation attempts cannot yield a stock proof',async()=>{
 const {engine,db}=await fixture();try{
 const make=extra=>preparationObserverService(db,'unused',{api:{verify:async()=>({id:100174}),request:()=>assert.fail('supplier mutation dispatched')},readReferences:async()=>({companyId:100174,locationId:100934}),findDocument:async()=>null,readProduct:async()=>product,...extra});
 await assert.rejects(make({readReferences:async()=>({companyId:100174,locationId:0})}).run(),/Dépôt/);
 await make({api:{verify:async()=>({id:999})}}).run();let rows=(await engine.query('SELECT state FROM order_recheck_monitor')).rows;assert.ok(rows.every(r=>r.state.preparationObservation.technical[0].code==='source-read-failed'));
 await engine.query('UPDATE order_recheck_monitor SET requested=requested+1');
 await make({findDocument:async()=>({})}).run();rows=(await engine.query('SELECT state FROM order_recheck_monitor')).rows;assert.ok(rows.every(r=>/Recherche BC/.test(r.state.preparationObservation.technical[0].message)));
 await engine.query('UPDATE order_recheck_monitor SET requested=requested+1');
 await make({findDocument:async api=>api.request('mutation Dangerous { write }')}).run();rows=(await engine.query('SELECT state FROM order_recheck_monitor')).rows;assert.ok(rows.every(r=>/interdite/.test(r.state.preparationObservation.technical[0].message)));
 }finally{await engine.close();}
});
