import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {resumeTransientErplain} from '../src/erplain-transient-recovery.mjs';
import {recoverCompletedTemuResumeHolds} from '../src/transient-resume-hold.mjs';

const waiting='Incident temporaire Erplain : rapprochement et reprise automatique en attente (0/3)';
const completed='2026-10-19T06:49:55.634Z',failed='2026-10-19T06:50:05.035Z',updated='2026-10-19T06:50:05.041Z';
const state=()=>({phase:'bl_created',bc:{id:'1951727',status:'active'},bl:{id:'1925351',status:'pending'},transientRecovery:{lastError:'Erplain HTTP 429',lastFailureAt:failed,readRateLimited:false,nextReadCheckAt:null}});

test('completed TEMU resume holds: real SQL recovery, exclusions and provider reconciliation',async t=>{
 const engine=new PGlite();await engine.waitReady;t.after(()=>engine.close());
 await engine.exec(`CREATE TABLE orders(id text PRIMARY KEY,reference text,channel text DEFAULT 'temu',source_payload jsonb DEFAULT '{}',erp_live jsonb,label_status text DEFAULT 'simulated',tracking_status text DEFAULT 'not_shipped',issue text,suspension jsonb DEFAULT '{}',archived boolean DEFAULT false,partial_mode boolean DEFAULT false,resolution_pending_resume boolean DEFAULT true,duplicate_of text);
 CREATE TABLE erp_live_jobs(order_id text PRIMARY KEY,status text DEFAULT 'review',error text,updated_at timestamptz);
 CREATE TABLE resolution_jobs(id text PRIMARY KEY,order_id text,action text,status text,result jsonb,error text,created_at timestamptz,updated_at timestamptz);
 CREATE TABLE correction_jobs(order_id text,status text);`);
 let inTransaction=false;
 const db={query:(...args)=>engine.query(...args),transaction:fn=>engine.transaction(async tx=>{inTransaction=true;try{return await fn(tx);}finally{inTransaction=false;}})};
 async function reset(){
  await engine.exec('TRUNCATE orders,erp_live_jobs,resolution_jobs,correction_jobs');
  await engine.query("INSERT INTO orders(id,reference,erp_live) VALUES('o','PO-069-fixture',$1)",[JSON.stringify(state())]);
  await engine.query("INSERT INTO erp_live_jobs(order_id,error,updated_at) VALUES('o',$1,$2)",[waiting,updated]);
  await engine.query("INSERT INTO resolution_jobs VALUES('resume','o','resume','complete',$1,NULL,$2,$3)",[JSON.stringify({resume:true,erpOnly:true}), '2026-10-19T06:48:00Z',completed]);
 }
 function reader({response,mutate,limited=false}={}){
  let calls=0;
  return {get calls(){return calls;},request:async(q)=>{
   calls++;assert.equal(inTransaction,false);assert.match(q,/^query V3TransientBL/);
   if(mutate)await mutate();
   if(limited)throw Object.assign(Error('Erplain HTTP 429'),{httpStatus:429,erplainReadOnly:true,retryAfter:120});
   return response||{Order:{id:'1951727',status:'active',shipping_orders:{data:[{id:'1925351',status:'pending'}],paginatorInfo:{hasMorePages:false}}}};
  }};
 }
 await t.test('both observed checkpoints resume the same documents without provider mutations',async()=>{
  for(const [bc,bl] of [['1951727','1925351'],['1951735','1925362']]){
   await reset();const s=state();s.bc.id=bc;s.bl.id=bl;
   await engine.query('UPDATE orders SET erp_live=$1',[JSON.stringify(s)]);
   const api=reader({response:{Order:{id:bc,status:'active',shipping_orders:{data:[{id:bl,status:'pending'}],paginatorInfo:{hasMorePages:false}}}}});
   assert.equal(await resumeTransientErplain(db,api),1);assert.equal(api.calls,1);
   const o=(await engine.query('SELECT * FROM orders')).rows[0],e=(await engine.query('SELECT * FROM erp_live_jobs')).rows[0];
   assert.equal(o.resolution_pending_resume,false);assert.equal(e.status,'pending');assert.equal(e.error,null);
   assert.equal(o.erp_live.bc.id,bc);assert.equal(o.erp_live.bl.id,bl);
   assert.equal(o.erp_live.transientRecovery.resumeHoldRecovery.labelPurchase,'unchanged');
   assert.equal((await engine.query('SELECT result FROM resolution_jobs')).rows[0].result.transientResumeRecovery.bcId,bc);
  }
 });
 for(const [name,sql] of [
  ['no explicit resume',"UPDATE resolution_jobs SET action='refresh'"],
  ['unfinished resume',"UPDATE resolution_jobs SET status='waiting'"],
  ['missing ERP-only proof',"UPDATE resolution_jobs SET result='{}'"],
  ['newer manual intervention',"INSERT INTO resolution_jobs VALUES('new','o','address','review','{}',NULL,'2026-10-20','2026-10-20')"],
  ['suspension',`UPDATE orders SET suspension='{"active":true}'`],
  ['later human reactivation',`UPDATE orders SET suspension='{"active":false,"updatedAt":"2026-10-20T07:00:00Z"}'`],
  ['cancellation',"UPDATE orders SET tracking_status='cancelled'"],
  ['pending cancellation',`UPDATE orders SET suspension='{"erplainCancellation":null}'`],
  ['archived',"UPDATE orders SET archived=true"],
  ['partial delivery',"UPDATE orders SET partial_mode=true"],
  ['already shipped',"UPDATE orders SET tracking_status='shipped'"],
  ['duplicate',"UPDATE orders SET duplicate_of='other'"],
  ['platform correction',`UPDATE orders SET source_payload='{"marketplacePendingCorrection":{}}'`],
  ['human validation',`UPDATE orders SET source_payload='{"erplainValidationHold":true}'`],
  ['active correction',"INSERT INTO correction_jobs VALUES('o','checking')"],
  ['uncertain correction',"INSERT INTO correction_jobs VALUES('o','review')"],
  ['three attempts',"UPDATE orders SET erp_live=jsonb_set(erp_live,'{transientRecovery,attempts}','3')"],
  ['future retry',"UPDATE orders SET erp_live=jsonb_set(erp_live,'{transientRecovery,nextReadCheckAt}',to_jsonb((now()+interval '1 hour')::text))"],
  ['missing failure timestamp',"UPDATE orders SET erp_live=erp_live #- '{transientRecovery,lastFailureAt}'"],
  ['failure predates resume',"UPDATE resolution_jobs SET updated_at='2026-10-19T07:00:00Z'"],
  ['business error',"UPDATE erp_live_jobs SET error='Stock insuffisant'"],
  ['other channel',"UPDATE orders SET channel='amazon'"],
 ])await t.test(name+' keeps its hold without provider calls',async()=>{
  await reset();await engine.exec(sql);const api=reader();
  assert.equal(await resumeTransientErplain(db,api),0);assert.equal(api.calls,0);
  assert.equal((await engine.query('SELECT resolution_pending_resume FROM orders')).rows[0].resolution_pending_resume,true);
 });
 await t.test('mismatched BL remains in review without recreating a document',async()=>{
  await reset();const api=reader({response:{Order:{id:'1951727',status:'active',shipping_orders:{data:[{id:'different',status:'pending'}],paginatorInfo:{hasMorePages:false}}}}});
  assert.equal(await resumeTransientErplain(db,api),0);assert.equal(api.calls,1);
  const e=(await engine.query('SELECT * FROM erp_live_jobs')).rows[0];assert.equal(e.status,'review');assert.match(e.error,/BL différent/);
 });
 await t.test('quota refusal schedules a read without consuming an attempt',async()=>{
  await reset();const api=reader({limited:true});assert.equal(await resumeTransientErplain(db,api),0);
  const s=(await engine.query('SELECT erp_live FROM orders')).rows[0].erp_live;
  assert.equal(s.transientRecovery.attempts,0);assert.ok(Date.parse(s.transientRecovery.nextReadCheckAt)>Date.now());
 });
 await t.test('a new hold during the provider read cannot be overwritten or released twice',async()=>{
  await reset();const api=reader({mutate:()=>engine.query('UPDATE orders SET resolution_pending_resume=true')});
  assert.equal(await resumeTransientErplain(db,api),0);
  assert.equal((await engine.query('SELECT status FROM erp_live_jobs')).rows[0].status,'review');
  assert.equal(await recoverCompletedTemuResumeHolds(db),0);
 });
});
