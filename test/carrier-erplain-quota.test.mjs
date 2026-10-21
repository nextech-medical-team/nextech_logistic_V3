import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
import {initializeCarrierJobs,createCarrierWorkers} from '../src/carrier-jobs.mjs';
import {queueLabelFromBl} from '../src/direct-label.mjs';
import {deferCarrierQuota,initializeCarrierQuota,carrierQuotaMessage,legacyCarrierQuotaMessage} from '../src/carrier-erplain-quota.mjs';
import {carrierEligible,processingView} from '../src/order-priority.mjs';
import {initializeAppSchema} from '../src/schema-startup.mjs';

const quotaError=()=>Object.assign(Error(legacyCarrierQuotaMessage),{httpStatus:429,erplainReadOnly:true,erplainRequestNotSent:true,retryAfter:120});
async function fixture(){
 const engine=new PGlite();await engine.waitReady;
 const wrap=e=>({query:(s,p=[])=>e.query(s,p),exec:s=>e.exec(s)});
 const db={...wrap(engine),transaction:fn=>engine.transaction(tx=>fn(wrap(tx))),withLocks:async(_,fn)=>fn(),recoverInterrupted:false};
 await db.exec(`CREATE TABLE orders(id text PRIMARY KEY,channel text,reference text,carrier text,address jsonb,source_payload jsonb DEFAULT '{}',erp_live jsonb DEFAULT '{}',label_status text,weight_kg numeric,parcel_count integer,tracking_status text,archived boolean DEFAULT false,partial_mode boolean DEFAULT false,resolution_pending_resume boolean DEFAULT false,suspension jsonb DEFAULT '{}',issue text);
 CREATE TABLE lines(id text,order_id text,source_line text,source_sku text,target_sku text,quantity numeric,target_quantity numeric);
 CREATE TABLE settings(key text,value jsonb);CREATE TABLE audit(user_email text,action text,detail jsonb);
 CREATE TABLE resolution_jobs(id text,order_id text,status text);CREATE TABLE extra_parcels(id text,order_id text);
 CREATE TABLE correction_jobs(id text,order_id text,status text);
 CREATE TABLE erp_live_jobs(order_id text,status text,error text);`);
 await initializeCarrierJobs(db);
 await db.query("INSERT INTO orders(id,channel,reference,carrier,address,erp_live,label_status,weight_kg,parcel_count) VALUES('o','amazon','SYNTHETIC','gofo',$1,$2,'production_pending',1,1)",[{name:'Synthetic',street:'1 rue Test',city:'Paris',postal:'75001',country:'FR'},{bc:{id:'bc',status:'active'},bl:{id:'bl',status:'ready_to_ship'},phase:'bl_ready'}]);
 await queueLabelFromBl(db,'o',{email:'operator'});
 return {engine,db,job:async()=>(await db.query("SELECT * FROM carrier_jobs WHERE order_id='o'")).rows[0]};
}
const pdf=Buffer.from('%PDF-1.4 synthetic').toString('base64');

test('quota refusal waits durably, then two workers create exactly one shipment with the same identity',async()=>{
 const {engine,db,job}=await fixture();try{
  let reads=0,posts=0;const identity=(await job()).creation_id;
  const clients={gofoCreate:async(o,{beforeCreate})=>{reads++;if(reads===1)throw quotaError();assert.equal(o.id,identity);await beforeCreate();posts++;return {reference:'R',tracking:['T']};},gofoLabel:async()=>pdf};
  await createCarrierWorkers(db,null,{clients}).run('gofo');
  const waiting=await job();assert.equal(waiting.status,'pending');assert.equal(waiting.error,carrierQuotaMessage);assert.equal(waiting.creation_started_at,null);assert.equal(waiting.quota_retries,1);assert.ok(new Date(waiting.quota_retry_at).getTime()>Date.now()+110000);
  assert.equal((await db.query(`SELECT * FROM carrier_jobs WHERE ${carrierEligible}`)).rows.length,0);
  // Process restart preserves deadline; no HTTP request during cooldown.
  await createCarrierWorkers(db,null,{clients}).run('gofo');assert.equal(reads,1);
  await db.exec("UPDATE carrier_jobs SET quota_retry_at=now()-interval '1 second'");
  // PGlite serializes transactions; use independent worker instances sequentially
  // to exercise durable claim state rather than its in-memory active Set.
  await createCarrierWorkers(db,null,{clients}).run('gofo');await createCarrierWorkers(db,null,{clients}).run('gofo');
  assert.equal(posts,1);assert.equal(reads,2);assert.equal((await job()).status,'ready');assert.equal((await job()).creation_id,identity);
  assert.equal((await db.query('SELECT count(*)::int n FROM carrier_documents')).rows[0].n,1);
 }finally{await engine.close();}
});

test('quota retries are bounded, preserve original evidence and manual admission resets the budget',async()=>{
 const {engine,db,job}=await fixture();try{
  const identity=(await job()).creation_id;
  for(let i=1;i<=5;i++){
   await db.exec("UPDATE carrier_jobs SET status='creating'");
   assert.equal(await deferCarrierQuota(db,await job(),quotaError()),true);
   assert.equal((await job()).quota_retries,i);
  }
  const exhausted=await job();assert.equal(exhausted.status,'failed');assert.equal(exhausted.quota_retry_at,null);assert.match(exhausted.error,/reprise manuelle/);assert.equal(exhausted.original_error,legacyCarrierQuotaMessage);assert.equal(exhausted.creation_id,identity);
  await queueLabelFromBl(db,'o',{email:'operator'});
  assert.equal((await job()).quota_retries,0);assert.equal((await job()).quota_retry_at,null);assert.notEqual((await job()).creation_id,identity);
 }finally{await engine.close();}
});

test('creation provenance, documents, history, changed claim and suspended/cancelled orders veto a retry',async()=>{
 const {engine,db,job}=await fixture();try{
  await db.exec("UPDATE carrier_jobs SET status='creating'");
  for(const setup of [
   "UPDATE carrier_jobs SET creation_started_at=now()",
   "UPDATE carrier_jobs SET result='{}'", "UPDATE carrier_jobs SET reference='R'", "UPDATE carrier_jobs SET tracking='[\"T\"]'",
   "INSERT INTO carrier_documents VALUES('o',0,'\\x01')", "INSERT INTO carrier_label_history(id,order_id,job) VALUES('h','o','{}')",
   "UPDATE orders SET suspension='{\"active\":true}'", "UPDATE orders SET tracking_status='cancelled'", "UPDATE orders SET archived=true",
   "UPDATE orders SET source_payload='{\"externalLabel\":{\"active\":true}}'", "UPDATE carrier_jobs SET creation_id='changed'"
  ]){
   const snapshot=await job();await db.exec(setup);
   assert.equal(await deferCarrierQuota(db,snapshot,quotaError()),false,setup);
   await db.exec("UPDATE carrier_jobs SET creation_started_at=null,result=null,reference=null,tracking='[]'; DELETE FROM carrier_documents;DELETE FROM carrier_label_history; UPDATE orders SET suspension='{}',source_payload='{}',tracking_status=null,archived=false");
  }
  assert.equal((await job()).quota_retries,0);
 }finally{await engine.close();}
});

test('real carrier 429 and ambiguous failures are never treated as Erplain read waits',async()=>{
 const {engine,db,job}=await fixture();try{
  await db.exec("UPDATE carrier_jobs SET status='creating'");
  for(const error of [Error('GLS HTTP 429'),Object.assign(Error('Erplain HTTP 429'),{httpStatus:429,erplainReadOnly:false}),Object.assign(Error('network'),{httpStatus:503,erplainReadOnly:true}),Object.assign(quotaError(),{uncertain:true})])assert.equal(await deferCarrierQuota(db,await job(),error),false);
  assert.equal((await job()).quota_retries,0);
 }finally{await engine.close();}
});

test('an Erplain error after a carrier creation marker never requeues or repeats that creation',async()=>{
 const {engine,db,job}=await fixture();try{
  let posts=0;const workers=createCarrierWorkers(db,null,{clients:{gofoCreate:async(_o,{beforeCreate})=>{await beforeCreate();posts++;throw quotaError();}}});
  await workers.run('gofo');await workers.run('gofo');
  const saved=await job();assert.equal(saved.status,'failed');assert.equal(saved.failure_phase,'provider');assert.ok(saved.creation_started_at);assert.equal(saved.quota_retries,0);assert.equal(posts,1);
 }finally{await engine.close();}
});

test('startup recovers only exact unsent historical refusal, once, without resetting creation identity',async()=>{
 const {engine,db,job}=await fixture();try{
  const identity=(await job()).creation_id;
  await db.query("UPDATE carrier_jobs SET status='failed',failure_phase='preflight',error=$1",[legacyCarrierQuotaMessage]);
  await initializeCarrierQuota(db);await initializeCarrierQuota(db);
  assert.equal((await job()).status,'pending');assert.equal((await job()).quota_retries,1);assert.equal((await job()).creation_id,identity);
  assert.equal((await db.query("SELECT count(*)::int n FROM audit WHERE action='carrier.erplain_quota_deferred'")).rows[0].n,1);
  await db.query("UPDATE carrier_jobs SET status='failed',quota_retries=0,error=$1,creation_started_at=now()",[legacyCarrierQuotaMessage]);
  await initializeCarrierQuota(db);assert.equal((await job()).status,'failed');
 }finally{await engine.close();}
});

test('existing deployment receives a versioned additive migration; web startup never recovers old jobs',async()=>{
 const {engine,db,job}=await fixture();try{
  await db.exec("CREATE TABLE schema_migrations(version text PRIMARY KEY); INSERT INTO schema_migrations VALUES('application-20261005-robustness-5'); ALTER TABLE carrier_jobs DROP COLUMN quota_retry_at; ALTER TABLE carrier_jobs DROP COLUMN quota_retries");
  await db.query("UPDATE carrier_jobs SET status='failed',failure_phase='preflight',error=$1",[legacyCarrierQuotaMessage]);
  await initializeAppSchema(db,[()=>assert.fail('old initializers must not replay')]);
  await initializeAppSchema(db,[]);
  const untouched=await job();assert.equal(untouched.status,'failed');assert.equal(untouched.error,legacyCarrierQuotaMessage);assert.equal(untouched.quota_retries,0);
  assert.equal((await db.query("SELECT count(*)::int n FROM schema_migrations WHERE version='carrier-erplain-quota-20261021-1'")).rows[0].n,1);
 }finally{await engine.close();}
});

test('quota read wait is labelled Erplain even in the GLS column; actual GLS refusals remain GLS',async()=>{
 const source=await readFile(new URL('../public/compact-problems.js',import.meta.url),'utf8');
 const context=vm.createContext({});vm.runInContext(source+'\nthis.classify=compactProblem;',context);
 const waiting=context.classify(carrierQuotaMessage,'','GLS');assert.equal(waiting.label,carrierQuotaMessage);assert.equal(waiting.provider,'Erplain');
 const legacy=context.classify(legacyCarrierQuotaMessage,'','GLS');assert.equal(legacy.label,'API Erplain · Limite atteinte (429)');assert.equal(legacy.provider,'Erplain');
 assert.equal(context.classify('Transporteur GLS : HTTP 429','','GLS').label,'API GLS · Limite atteinte (429)');
 const processing=processingView({id:'o',carrier:'gls',carrier_status:'pending',carrier_error:carrierQuotaMessage});
 assert.equal(processing.state,'queued');assert.match(processing.stage,/Erplain/);assert.equal(processing.activities[0].service,'Erplain');
});
