import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {PGlite} from '@electric-sql/pglite';
import {apiAcquireSlot,apiDefer,configureApiBudget} from '../src/api-budget.mjs';
import {withErplainTraffic,erplainTraffic,erplainTaskTraffic,erplainHead} from '../src/erplain-admission.mjs';
import {sharedErplainReference} from '../src/erplain-reference-cache.mjs';
import {retryDecision} from '../src/erp-transient-policy.mjs';
import {safeQuotaReadQueue,quotaReadRetryAt,queueQuotaRead} from '../src/erplain-quota-wait.mjs';
import {processingView,erplainEligible} from '../src/order-priority.mjs';
import {erplainLiveWorker} from '../src/erplain-live-workflow.mjs';

test('foreground is preferred with one reserved background grant after four; unused capacity is borrowed',()=>{
 const rows=Array.from({length:12},(_,i)=>({id:'b'+i,traffic:'background'})).concat(Array.from({length:12},(_,i)=>({id:'f'+i,traffic:'foreground'})));
 let streak=0;const got=[];
 for(let i=0;i<10;i++){const head=erplainHead(rows,streak);got.push(head.id);rows.splice(rows.indexOf(head),1);streak=head.traffic==='background'?0:Math.min(4,streak+1);}
 assert.deepEqual(got,['f0','f1','f2','f3','b0','f4','f5','f6','f7','b1']);
 assert.equal(erplainHead([{id:'only',traffic:'background'}],0).id,'only');
 assert.equal(erplainHead([{id:'only',traffic:'foreground'}],4).id,'only');
});
test('task scopes isolate concurrent foreground and background work',async()=>{
 assert.equal(erplainTaskTraffic('erplain-preparation'),'foreground');assert.equal(erplainTaskTraffic('read-services'),'background');
 await Promise.all(['foreground','background'].map(lane=>withErplainTraffic(lane,async()=>{await new Promise(r=>setTimeout(r,2));assert.equal(erplainTraffic(),lane);})));assert.equal(erplainTraffic(),'foreground');
});
test('in-memory weighted admission respects common cooldown and one shared interval',async()=>{
 configureApiBudget(null);await apiDefer('erplain:shared',30);const sent=[];
 await Promise.all([...Array.from({length:3},(_,i)=>['background','b'+i]),...Array.from({length:6},(_,i)=>['foreground','f'+i])].map(([lane,id])=>withErplainTraffic(lane,async()=>{await apiAcquireSlot('erplain:shared',10,{fair:true,maxWaitMs:2000});sent.push({id,at:Date.now()});})));
 assert.deepEqual(sent.slice(0,5).map(x=>x.id),['f0','f1','f2','f3','b0']);
 for(let i=1;i<sent.length;i++)assert.ok(sent[i].at-sent[i-1].at>=9);
});
test('SQL admission takes only local transactions and preserves exact spacing and background progress',async()=>{
 const engine=new PGlite();await engine.waitReady;const transaction=new AsyncLocalStorage();
 const db={kind:'pglite',query:(...a)=>engine.query(...a),transaction:fn=>engine.transaction(tx=>transaction.run(true,()=>fn(tx)))};
 configureApiBudget(db);
 try{
  const sent=[];
  await Promise.all(Array.from({length:7},(_,i)=>withErplainTraffic(i<2?'background':'foreground',async()=>{await apiAcquireSlot('erplain:shared',10,{fair:true,maxWaitMs:10000,onProgress:()=>assert.notEqual(transaction.getStore(),true)});sent.push(i);} )));
  assert.equal(sent.length,7);assert.ok(sent.indexOf(0)<=4);assert.ok(sent.indexOf(1)<=6);
  assert.equal((await engine.query('SELECT count(*)::int n FROM erplain_quota_waiters')).rows[0].n,0);
  const metrics=(await engine.query('SELECT * FROM erplain_quota_turns')).rows[0];assert.equal(Number(metrics.foreground_grants),5);assert.equal(Number(metrics.background_grants),2);
 }finally{configureApiBudget(null);await engine.close();}
});
test('reference reads are coalesced, separated by credentials and never cache documents or stock',async()=>{
 const c={url:'https://example.test/graphql',companyId:1,apiKey:'test'},fetcher=()=>{},q='query V3CheckAccount { Company { id label } }';let calls=0;
 const load=async()=>{calls++;await new Promise(r=>setTimeout(r,2));return {Company:{id:1}};};
 const values=await Promise.all(Array.from({length:10},()=>sharedErplainReference(c,q,{},fetcher,load)));assert.equal(calls,1);
 values[0].Company.id=9;assert.equal(values[1].Company.id,1);
 await sharedErplainReference({...c,apiKey:'other'},q,{},fetcher,load);assert.equal(calls,2);
 for(let i=0;i<2;i++)await sharedErplainReference(c,'query Fresh {ShippingOrder(id:1){status}}',{},fetcher,load);assert.equal(calls,4);
});
test('failed reference reads are evicted rather than cached as success',async()=>{
 const fetcher=()=>{},q='query V3CheckAccount { Company { id label } }',c={apiKey:'test'};let calls=0;
 const load=async()=>{if(++calls===1)throw Error('quota');return {Company:{id:1}};};
 await assert.rejects(()=>sharedErplainReference(c,q,{},fetcher,load),/quota/);await sharedErplainReference(c,q,{},fetcher,load);assert.equal(calls,2);
});
test('quota reads honor their scheduled deadline without the unrelated five-minute mutation backoff',()=>{
 const now=Date.now(),o={erp_live:{bc:{id:1,status:'active'},phase:'bc_created',transientRecovery:{attempts:4,readRateLimited:true,nextReadCheckAt:new Date(now-1).toISOString()}}};
 assert.equal(retryDecision(o,'Erplain HTTP 429',new Date(now-1000).toISOString(),now),true);
 o.erp_live.transientRecovery.nextReadCheckAt=new Date(now+1000).toISOString();assert.equal(retryDecision(o,'Erplain HTTP 429',new Date(now-1000).toISOString(),now),false);
 o.erp_live.transientRecovery.readRateLimited=false;assert.equal(retryDecision(o,'Erplain HTTP 503',new Date(now-600000).toISOString(),now),false);
});
test('only a provably unsent read at stable checkpoints can return to the queue',()=>{
 const e={httpStatus:429,erplainReadOnly:true,erplainRequestNotSent:true,retryAfter:2},o={erp_live:{phase:'bc_created'}};
 assert.equal(safeQuotaReadQueue(o,e),true);
 for(const phase of ['creating_bc','creating_bl','creating_customer','creating_stock','publishing_bl','finalizing_bl'])assert.equal(safeQuotaReadQueue({...o,erp_live:{phase}},e),false);
 assert.equal(safeQuotaReadQueue({...o,suspension:{active:true}},e),false);assert.equal(safeQuotaReadQueue(o,{...e,erplainReadOnly:false}),false);assert.equal(safeQuotaReadQueue(o,{...e,erplainRequestNotSent:false}),false);
 assert.equal(Date.parse(quotaReadRetryAt(e,0)),2000);assert.equal(Date.parse(quotaReadRetryAt({...e,erplainProviderRateLimited:true},0)),60000);
});
test('quota waiting is shown as queued, while unrelated stock errors stay blocked',()=>{
 const r={id:'1',erp_status:'review',erp_error:'Erplain temporairement limité : vérification et reprise automatiques programmées',quotaRecovery:{readRateLimited:true,nextReadCheckAt:'2099-10-15T15:00:00Z'},resolution_status:'review',resolution_error:'Erplain temporairement limité : vérification et reprise automatiques programmées'};
 const view=processingView(r);assert.equal(view.state,'queued');assert.match(view.stage,/En attente/);assert.equal(view.activities.length,1);assert.match(view.reason,/17:00:00/);
 const due=processingView({...r,quotaRecovery:{readRateLimited:true,nextReadCheckAt:'2000-01-01T00:00:00Z'}});assert.equal(due.nextAttemptAt,null);assert.match(due.reason,/dès qu’un créneau se libère/);
 const blocked=processingView({...r,erp_error:'Stock indisponible'});assert.equal(blocked.state,'blocked');assert.equal(blocked.reason,'Stock indisponible');
});
test('a shared provider pause is checked before any job claim or provider call',async()=>{
 let checks=0;
 const db={query:()=>assert.fail('no job may be touched during the common pause')};
 const api={quotaDelay:async()=>{checks++;return 60000;},verify:()=>assert.fail('no request during provider pause')};
 const worker=erplainLiveWorker(db,'unused',{api});await worker.run();await worker.run();assert.equal(checks,1);assert.equal(worker.running,false);
});
test('quota admission failing before batch claim cannot mark untouched orders as review',async()=>{
 const queries=[],query=async q=>{queries.push(q);return {rows:q.startsWith('SELECT order_id FROM erp_live_jobs WHERE')?[{order_id:'1'}]:[]};};
 const db={query,transaction:fn=>fn({query})},api={quotaDelay:async()=>0,verify:async()=>{throw Object.assign(Error('quota'),{httpStatus:429,erplainReadOnly:true,erplainRequestNotSent:true,retryAfter:60});},request:()=>assert.fail('no provider mutation')};
 const saved=process.env.ERPLAIN_LIVE_WRITES;process.env.ERPLAIN_LIVE_WRITES='0';
 try{await erplainLiveWorker(db,'unused',{api}).run();assert.ok(queries.some(q=>q.startsWith('SELECT order_id FROM erp_live_jobs WHERE')));assert.ok(!queries.some(q=>q.includes("status='processing'")||q.includes("status='review',error=")));}
 finally{if(saved===undefined)delete process.env.ERPLAIN_LIVE_WRITES;else process.env.ERPLAIN_LIVE_WRITES=saved;}
});
test('SQL deferred reads preserve cancellation, wait deadlines, and stable checkpoint versions',async()=>{
 const engine=new PGlite();await engine.waitReady;
 try{
  await engine.exec(`CREATE TABLE orders(id text PRIMARY KEY,reference text DEFAULT 'TEST',source_payload jsonb DEFAULT '{}',issue text,erp_live jsonb,archived boolean DEFAULT false,partial_mode boolean DEFAULT false,resolution_pending_resume boolean DEFAULT false,suspension jsonb DEFAULT '{}',tracking_status text,label_status text);
   CREATE TABLE erp_live_jobs(order_id text,status text,error text,updated_at timestamptz);
   CREATE TABLE correction_jobs(order_id text,status text);CREATE TABLE resolution_jobs(order_id text,status text);`);
  const o={id:'1',erp_live:{phase:'bc_created',transientRecovery:{readRateLimited:true,nextReadCheckAt:'2099-01-01T00:00:00.000Z'}}},error={httpStatus:429,erplainReadOnly:true,erplainRequestNotSent:true};
  await engine.query('INSERT INTO orders(id,erp_live) VALUES($1,$2)',[o.id,JSON.stringify(o.erp_live)]);await engine.exec("INSERT INTO erp_live_jobs VALUES('1','processing',null,now())");
  const db={query:(...a)=>engine.query(...a),transaction:fn=>engine.transaction(fn)};
  assert.equal(await queueQuotaRead(db,o,error),true);
  assert.equal((await engine.query('SELECT status FROM erp_live_jobs')).rows[0].status,'pending');
  assert.equal((await engine.query(`SELECT order_id FROM erp_live_jobs WHERE ${erplainEligible}`)).rows.length,0);
  await engine.exec("UPDATE erp_live_jobs SET status='processing';UPDATE orders SET suspension='{\"active\":true}'");
  assert.equal(await queueQuotaRead(db,o,error),false);
  assert.equal((await engine.query('SELECT status FROM erp_live_jobs')).rows[0].status,'processing');
 }finally{await engine.close();}
});
