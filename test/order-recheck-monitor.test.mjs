import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {monitoringObservation,initializeOrderRecheckMonitor,orderRecheckMonitor,recheckCadence} from '../src/order-recheck-monitor.mjs';

test('five families retain clocks, deadlines, next actions and persistent alerts',()=>{
 const at=Date.parse('2026-10-10T20:00:00Z');
 for(const issue of ['SKU Erplain introuvable','Reprise historique à vérifier : BL non créé','Stock insuffisant','BC annulé à rapprocher','BL à vérifier']){
  const o={issue,erp_live:{bc:{id:'1'}},mapping_lines:[{sku:'X',quantity:1}]};
  const first=monitoringObservation(o,{},at),later=monitoringObservation({...o,updated_at:new Date(at+3600000)},first,at+3600000);
  assert.equal(later.alert,true);assert.equal(later.lastProgress,first.lastProgress);assert.equal(Date.parse(later.nextCheck)-Date.parse(later.lastCheck),recheckCadence.local);
  const again=monitoringObservation(o,later,at+3900000);assert.equal(again.alertSince,later.alertSince);
  const progressed=monitoringObservation({...o,erp_live:{bc:{id:'1'},bl:{id:'2',status:'pending'}}},again,at+4000000);assert.equal(progressed.alert,false);
 }
});
test('old block alerts immediately on installation and fresh reads never reset it',()=>{
 const now=Date.now(),o={issue:'BL non créé',blocked_since:new Date(now-7200000),erp_live:{}};
 assert.equal(monitoringObservation(o,{},now).alert,true);
});

test('current Erplain failure replaces an obsolete finance message without hiding independent or suspended issues',()=>{
 const error='BC · Codes TVA Erplain différents de la source ; produits et quantités identiques',o={issue:'TEMU · Prix client et TVA source incohérents',erp_live:{pricing:{status:'blocked'}},erp_live_job:{status:'review',error}};
 assert.equal(monitoringObservation(o).result,error);assert.match(monitoringObservation(o).nextStep,/taux et codes TVA du BC/);
 assert.equal(monitoringObservation({...o,issue:'Adresse incomplète'}).result,'Adresse incomplète');
 assert.match(monitoringObservation({...o,suspension:{active:true,note:'Décision humaine'}}).nextStep,/réactivation/);
 assert.equal(monitoringObservation({...o,erp_live_job:{status:'pending',error:null}}).result,o.issue);
});
test('commercial platform states do not create a diagnostic or next-step suspension',()=>{
 for(const status of ['shipped','cancelled','delivered'])assert.equal(monitoringObservation({tracking_status:status,source_payload:{cancelled:true,financial_status:'refunded'},erp_live:{}}).blocked,false);
 assert.match(monitoringObservation({suspension:{active:true,note:'Décision humaine'}}).nextStep,/réactivation/);
});

async function fixture(){
 const db=new PGlite();db.withLocks=async(keys,fn)=>fn();db.transaction=fn=>fn(db);
 await db.exec(`CREATE TABLE audit(user_email text,action text,detail jsonb);CREATE TABLE orders(id text PRIMARY KEY,channel text DEFAULT 'temu',reference text,archived boolean DEFAULT false,partial_mode boolean DEFAULT false,issue text,source_payload jsonb DEFAULT '{}',erp_live jsonb DEFAULT '{}',resolution_pending_resume boolean DEFAULT false,suspension jsonb DEFAULT '{}');
 CREATE TABLE erp_live_jobs(order_id text,status text,error text,state_since timestamptz DEFAULT now());CREATE TABLE carrier_jobs(order_id text,status text,error text);
 CREATE TABLE resolution_jobs(id text,order_id text,request_id text UNIQUE,action text,status text DEFAULT 'queued',stage text,payload jsonb,result jsonb,error text,created_at timestamptz DEFAULT now());
 CREATE TABLE correction_jobs(order_id text,status text,result jsonb,error text);
 CREATE TABLE lines(id text,order_id text,source_sku text,target_sku text,quantity numeric,target_quantity numeric,source_payload jsonb DEFAULT '{}');CREATE TABLE mappings(channel text,source_sku text,target_sku text,source_qty numeric,target_qty numeric);
 INSERT INTO orders(id,reference,issue) VALUES('a','A','SKU Erplain introuvable'),('b','B','Stock insuffisant');
 INSERT INTO lines(id,order_id,source_sku,quantity) VALUES('1','a','X',1),('2','b','X',1);`);
 await initializeOrderRecheckMonitor(db,{afterPublication:true});return db;
}
test('real PostgreSQL triggers enqueue immediate checks; periodic checks persist and SKU reads are shared across orders and runs',async()=>{
 const db=await fixture();try{
  let reads=0,docs=0,active=0,max=0;
  const monitor=orderRecheckMonitor(db,{}, {readProduct:async()=>{reads++;active++;max=Math.max(max,active);await Promise.resolve();active--;return {usable:false,status:'missing'};},readDocuments:async()=>{docs++;return {};},cacheProduct:()=>assert.fail('no active product')});
  await monitor.runLocal();const first=(await db.query('SELECT * FROM order_recheck_monitor ORDER BY order_id')).rows;
  assert.equal(first.length,2);assert.ok(first.every(r=>r.state.lastCheck&&r.state.nextCheck&&r.checked===r.requested));
  await monitor.runExternal();assert.equal(reads,1);assert.equal(docs,0);assert.ok(max<=2);
  await db.query("UPDATE order_recheck_monitor SET next_external=now()-interval '1 second'");await monitor.runExternal();assert.equal(reads,1);assert.equal(docs,0);
  await db.query("UPDATE correction_jobs SET status='complete' WHERE order_id='a'");
  await db.query("INSERT INTO correction_jobs VALUES('a','complete','{}',null)");const queued=(await db.query("SELECT requested,checked FROM order_recheck_monitor WHERE order_id='a'")).rows[0];assert.ok(queued.requested>queued.checked);
  await monitor.runLocal();assert.equal((await db.query("SELECT requested=checked ok FROM order_recheck_monitor WHERE order_id='a'")).rows[0].ok,true);
  // The same persistent deadlines survive a service instance restart.
  await orderRecheckMonitor(db,{}, {readProduct:()=>assert.fail('premature read'),readDocuments:()=>assert.fail('premature read')}).runExternal();
 }finally{await db.close();}
});
test('suspended orders remain visible locally and never trigger external resume or read',async()=>{
 const db=await fixture();try{await db.query("UPDATE orders SET suspension='{\"active\":true,\"note\":\"humaine\"}'");
 const monitor=orderRecheckMonitor(db,{}, {readProduct:()=>assert.fail('suspended SKU read'),readDocuments:()=>assert.fail('suspended document read')});await monitor.run();
 assert.equal((await db.query('SELECT count(*)::int n FROM resolution_jobs')).rows[0].n,0);
 assert.ok((await db.query('SELECT state FROM order_recheck_monitor')).rows.every(r=>r.state.result.includes('suspendue')));
 }finally{await db.close();}
});

test('a slow external read never delays local checks; automatic resume respects runtime controls and deduplicates jobs',async()=>{
 const db=await fixture();try{
 await db.query(`UPDATE orders SET issue='Reprise historique : BL non cree',erp_live='{"phase":"historical_review","bc":{"id":"1"},"pricing":{"status":"verified"}}'`);
 let release,started;const begin=new Promise(r=>started=r),pause=new Promise(r=>release=r);let allow=false;
 const m=orderRecheckMonitor(db,{}, {canResume:()=>allow,readProduct:async()=>{started();await pause;return {usable:false,status:'missing'};},readDocuments:async()=>({})});
 await m.runLocal();const reading=m.runExternal();await begin;
 await db.query("INSERT INTO correction_jobs VALUES('a','complete','{}',null)");await m.runLocal();
 assert.equal((await db.query("SELECT requested=checked ok FROM order_recheck_monitor WHERE order_id='a'")).rows[0].ok,true);
 release();await reading;assert.equal((await db.query('SELECT count(*)::int n FROM resolution_jobs')).rows[0].n,0);
 allow=true;await db.query("UPDATE order_recheck_monitor SET next_external=now()-interval '1 second'");await m.runExternal();
 assert.equal((await db.query('SELECT count(*)::int n FROM resolution_jobs')).rows[0].n,2);
 await db.query("UPDATE order_recheck_monitor SET next_external=now()-interval '1 second'");await m.runExternal();
 assert.equal((await db.query('SELECT count(*)::int n FROM resolution_jobs')).rows[0].n,2);
 }finally{await db.close();}
});
test('mapping correction immediately rechecks all matching orders using current quantities instead of cached quantities',async()=>{
 const db=await fixture();try{
 await db.query("UPDATE lines SET quantity=20,target_sku='OLD',target_quantity=3000");const m=orderRecheckMonitor(db,{});await m.runLocal();const previous=(await db.query('SELECT state FROM order_recheck_monitor ORDER BY order_id')).rows.map(r=>r.state.progress);
 await db.query("INSERT INTO mappings VALUES('temu','X','CURRENT',1,1)");
 assert.ok((await db.query('SELECT requested,checked FROM order_recheck_monitor')).rows.every(r=>r.requested>r.checked));await m.runLocal();
 assert.ok((await db.query('SELECT state FROM order_recheck_monitor ORDER BY order_id')).rows.every((r,i)=>r.state.progress!==previous[i]));
 const rows=(await db.query("SELECT l.quantity*m.target_qty/m.source_qty quantity FROM lines l JOIN mappings m ON m.source_sku=l.source_sku")).rows;assert.ok(rows.every(r=>Number(r.quantity)===20));
 await db.query("UPDATE mappings SET target_qty=2");await m.runLocal();
 await db.query("UPDATE lines SET quantity=30");assert.ok((await db.query('SELECT requested,checked FROM order_recheck_monitor')).rows.every(r=>r.requested>r.checked));await m.runLocal();
 }finally{await db.close();}
});

test('bounded resource batches keep unread SKUs due and eventually cover every order without repeated provider reads',async()=>{
 const db=await fixture();try{
 await db.query("UPDATE lines SET source_sku='Y' WHERE order_id='b'");await db.query("INSERT INTO orders(id,reference,issue) VALUES('c','C','SKU Erplain introuvable')");await db.query("INSERT INTO lines(id,order_id,source_sku,quantity) VALUES('3','c','Z',1)");
 const reads=[];const m=orderRecheckMonitor(db,{}, {maxSkuReads:2,readProduct:async(api,sku)=>{reads.push(sku);return {usable:false,status:'missing'};},readDocuments:()=>assert.fail('SKU-only problem must not search unrelated documents')});
 await m.runLocal();await m.runExternal();assert.equal(reads.length,2);
 const pending=(await db.query("SELECT order_id,state FROM order_recheck_monitor WHERE state->>'externalResult' LIKE '%partiels%'")).rows;assert.equal(pending.length,1);
 await db.query("UPDATE order_recheck_monitor SET next_external=now()-interval '1 second' WHERE order_id=$1",[pending[0].order_id]);await m.runExternal();assert.deepEqual(reads.sort(),['X','Y','Z']);
 }finally{await db.close();}
});

test('old review errors remain history and never reopen a command after its latest correction completes',async()=>{
 const db=await fixture();try{
 await db.query("UPDATE orders SET issue=null WHERE id='a'");
 await db.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,status,payload,error,created_at) VALUES('old','a','old','resume-erp','review','{}','Obsolete stock error',now()-interval '1 hour'),('new','a','new','resume-erp','complete','{}',null,now())");
 const m=orderRecheckMonitor(db,{});await m.runLocal();assert.equal((await db.query("SELECT state FROM order_recheck_monitor WHERE order_id='a'")).rows[0].state.blocked,false);
 await db.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,status,payload,error,created_at) VALUES('current','a','current','resume-erp','review','{}','Current document mismatch',now()+interval '1 second')");await m.runLocal();assert.equal((await db.query("SELECT state FROM order_recheck_monitor WHERE order_id='a'")).rows[0].state.result,'Current document mismatch');
 }finally{await db.close();}
});

test('resolved blockers retain visible dated follow-up and unconfirmed previews never become false completion',()=>{const blocked=monitoringObservation({issue:'Stock insuffisant'},{});const resolved=monitoringObservation({issue:null,label_status:'production_ready'},blocked);assert.equal(resolved.blocked,false);assert.equal(resolved.followUp,true);assert.equal(resolved.alert,false);const preview=monitoringObservation({issue:null,latest_resolution:{action:'equivalent-preview',status:'complete',error:null,result:{replacementSku:'NEW'}}},{});assert.equal(preview.blocked,true);assert.match(preview.nextStep,/Confirmer/);});

test('automatic historical resume preserves an unconfirmed preview and rechecks suspension inside the transaction',async()=>{
 const db=await fixture();try{
 await db.query(`UPDATE orders SET issue='Reprise historique : BL non cree',erp_live='{"phase":"historical_review","bc":{"id":"1"},"pricing":{"status":"verified"}}'`);
 await db.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,status,result) VALUES('preview','a','preview','equivalent-preview','complete','{\"replacementSku\":\"NEW\"}')");
 const m=orderRecheckMonitor(db,{}, {readProduct:async()=>({usable:false,status:'missing'}),readDocuments:async()=>({})});await m.runLocal();
 const transaction=db.transaction;db.transaction=async fn=>{await db.query("UPDATE orders SET suspension='{\"active\":true}' WHERE id='b'");return transaction(fn);};await m.runExternal();
 assert.equal((await db.query("SELECT count(*)::int n FROM resolution_jobs WHERE action='resume-erp'")).rows[0].n,0);assert.equal((await db.query("SELECT result->>'replacementSku' sku FROM resolution_jobs WHERE id='preview'")).rows[0].sku,'NEW');
 }finally{await db.close();}
});

import {persistedRecheckProblemSql} from '../src/order-problem-predicates.mjs';
test('the problems list retains an independent review after another correction succeeds and removes it after its own completion',async()=>{
 const db=await fixture();try{await db.query("UPDATE orders SET issue=null WHERE id='a'");await db.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,status,error,created_at) VALUES('address','a','address','address','review','Current address mismatch',now()-interval '1 hour'),('weight','a','weight','weight','complete',null,now())");const m=orderRecheckMonitor(db,{});await m.runLocal();assert.equal((await db.query("SELECT state->>'result' result FROM order_recheck_monitor WHERE order_id='a'")).rows[0].result,'Current address mismatch');assert.ok((await db.query(`SELECT id FROM orders WHERE ${persistedRecheckProblemSql}`)).rows.some(r=>r.id==='a'));await db.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,status,error,created_at) VALUES('fixed','a','fixed','address','complete',null,now()+interval '1 second')");await m.runLocal();assert.ok(!(await db.query(`SELECT id FROM orders WHERE ${persistedRecheckProblemSql}`)).rows.some(r=>r.id==='a'));}finally{await db.close();}
});
