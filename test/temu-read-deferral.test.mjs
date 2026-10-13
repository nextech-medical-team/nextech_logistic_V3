import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
import {configureApiBudget,apiAcquireSlot,apiDefer} from '../src/api-budget.mjs';
import {temuReadDeferral,temuReadWaitMs} from '../src/temu-read-deferral.mjs';
import {temuLocalService} from '../src/temu-local.mjs';
import {temuSyncJobs} from '../src/temu-sync-jobs.mjs';
import {temuShipping} from '../src/temu-shipping.mjs';
import {currentHoldDiagnostic} from '../src/preparation-recheck-policy.mjs';
const quota=seconds=>Object.assign(Error('Quota partagé : lecture différée'),{code:'source_budget_deferred',retryAfter:String(seconds)});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function engine(){const e=new PGlite();await e.waitReady;const db={kind:'pglite',query:(s,a)=>e.query(s,a),transaction:fn=>e.transaction(t=>fn({query:(s,a)=>t.query(s,a)})),exec:s=>e.exec(s)};await db.exec('CREATE TABLE api_budget(key text PRIMARY KEY,next_at timestamptz NOT NULL)');return {e,db};}
test('TEMU read wait is five seconds; retry metadata preserves provider pauses',()=>{assert.equal(temuReadWaitMs,5000);assert.equal(temuReadDeferral(quota(60)).retryAfterMs,60000);assert.equal(temuReadDeferral(quota(3600)).retryAfterMs,3600000);assert.equal(temuReadDeferral(quota('invalid')).retryAfterMs,1000);assert.equal(temuReadDeferral(quota(0)).error,null);});
test('in-memory FIFO grants waiting readers in order without reserving future slots',async()=>{configureApiBudget(null);const key='fifo-memory',order=[];await apiDefer(key,80);await Promise.all([0,1,2,3].map(n=>apiAcquireSlot(key,15,{fair:true,maxWaitMs:2000}).then(()=>order.push(n))));assert.deepEqual(order,[0,1,2,3]);});
test('queued timeout and cancellation release tickets for following readers',async()=>{configureApiBudget(null);const key='fifo-release';await apiDefer(key,150);const first=apiAcquireSlot(key,5,{fair:true,maxWaitMs:2000});await sleep(10);await assert.rejects(apiAcquireSlot(key,5,{fair:true,maxWaitMs:15}),e=>e.code==='source_budget_deferred');let stopped=false;const cancelled=apiAcquireSlot(key,5,{fair:true,maxWaitMs:2000,shouldStop:()=>stopped});stopped=true;await assert.rejects(cancelled,e=>e.code==='TEMU_STOPPING');await first;await apiAcquireSlot(key,5,{fair:true,maxWaitMs:2000});});
test('shared PostgreSQL protocol FIFO, cooldown and expired process tickets',async()=>{const {e,db}=await engine();configureApiBudget(db);try{
 await apiDefer('fifo-db',200);
 const order=[];const first=apiAcquireSlot('fifo-db',10,{fair:true,maxWaitMs:2000}).then(()=>order.push(0));await sleep(25);
 const second=apiAcquireSlot('fifo-db',10,{fair:true,maxWaitMs:2000}).then(()=>order.push(1));await sleep(25);
 const third=apiAcquireSlot('fifo-db',10,{fair:true,maxWaitMs:2000}).then(()=>order.push(2));await Promise.all([first,second,third]);assert.deepEqual(order,[0,1,2]);
 assert.equal((await db.query('SELECT * FROM api_budget_waiters')).rows.length,0);
 await db.query("INSERT INTO api_budget_waiters(id,key,expires_at) VALUES('dead','fifo-db',clock_timestamp()-interval '1 second')");await apiAcquireSlot('fifo-db',10,{fair:true,maxWaitMs:2000});assert.equal((await db.query('SELECT * FROM api_budget_waiters')).rows.length,0);
 await apiDefer('fifo-db',60000);await assert.rejects(apiAcquireSlot('fifo-db',10,{fair:true,maxWaitMs:100}),err=>err.code==='source_budget_deferred'&&Number(err.retryAfter)>=59);assert.equal((await db.query('SELECT * FROM api_budget_waiters')).rows.length,0);
 }finally{configureApiBudget(null);await e.close();}});
test('completed label and source verification survive a quota error',async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'temu-deferral-'));try{
 const order={id:'A',reference:'PO-069-12345',channel:'temu',address:{country:'FR'},source_payload:{mallId:'M',temuDirect:{state:'verified'},stockProof:{unchanged:true}}};const writes=[];
 const db={query:async(s,a)=>{if(s.startsWith('SELECT'))return {rows:[order]};writes.push({s,a});return {rows:[]};}};
 const local=temuLocalService(db,dir,{configLoader:async()=>({}),shopLoader:async()=>[],apiFactory:()=>({read:async()=>{throw quota(60);}})});
 const result=await local.recover(order.reference);assert.equal(result.deferred,true);assert.equal(result.retryAfterMs,60000);assert.equal(result.error,null);
 assert.equal(writes.length,1);assert.match(writes[0].s,/UPDATE orders SET source_payload=source_payload/);const patch=JSON.parse(writes[0].a[1]);assert.deepEqual(Object.keys(patch),['temuReadDeferred']);assert.equal(order.source_payload.temuDirect.state,'verified');assert.ok(writes.every(x=>!x.s.includes('temu_label_jobs')));
 }finally{await fs.rm(dir,{recursive:true,force:true});}});
test('document read deferral never changes a completed shipment to pending or clears its error',async()=>{
 const reference='PO-069-12345',old={reference,status:'complete',packages:['PK-1'],result:{source:'prior'},error:'Independent error'},writes=[];
 const db={query:async(s,a)=>{if(s.startsWith('SELECT channel'))return {rows:[{channel:'temu',source_payload:{}}]};if(s.includes('FROM temu_label_documents'))return {rows:[]};if(s.startsWith('SELECT'))return {rows:[old]};writes.push({s,a});return {rows:[]};}};
 const api={read:async type=>{if(type==='bg.logistics.shipment.result.get')return {packageInfoResultList:[{packageSn:'PK-1',shippingLabelStatus:1,orderSendInfoList:[{parentOrderSn:reference}]}]};throw quota(60);}};
 await assert.rejects(temuShipping(db,api).recover(reference),e=>e.code==='source_budget_deferred');
 assert.equal(writes.length,1);assert.match(writes[0].s,/DO UPDATE SET packages=excluded.packages/);assert.equal(old.status,'complete');assert.equal(old.error,'Independent error');
});
test('a single identity connection failure no longer propagates to all 71 orders',async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'temu-global-deferral-'));try{
 const writes=[],rows=Array.from({length:71},(_,n)=>({id:String(n),reference:'SIM'+n,source_payload:{}}));const db={query:async(s,a)=>s.startsWith('SELECT')?{rows}:(writes.push({s,a}),{rows:[]})};
 for(const error of [quota(1),Error('TEMU HTTP 403')]){const local=temuLocalService(db,dir,{configLoader:async()=>({}),shopLoader:async()=>[],apiFactory:()=>({read:async()=>{throw error;}})});const result=await local.sync();assert.equal(result.errors.length,0);assert.ok(result.connectionError);}
 assert.equal(writes.length,0);
 }finally{await fs.rm(dir,{recursive:true,force:true});}});
test('one failed associated shop leaves a verified shop usable',async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'temu-shop-isolation-'));try{
 const db={query:async()=>({rows:[{country:'FR'}]})};
 const local=temuLocalService(db,dir,{configLoader:async()=>({TEMU_APP_KEY:'A',TEMU_ACCESS_TOKEN:'root'}),shopLoader:async()=>[{country:'BE',appKey:'A',accessToken:'eplbad'}],apiFactory:config=>({read:async()=>{if(config.TEMU_ACCESS_TOKEN==='eplbad')throw quota(1);return {mallId:'FR'};}})});
 const collectors=await local.collectors();assert.equal(collectors.length,1);assert.equal(collectors[0].shop,'FR');
 }finally{await fs.rm(dir,{recursive:true,force:true});}});
test('durable deferral neither increments failures nor erases an independent error or last success',async()=>{const {e,db}=await engine();try{
 await db.exec("CREATE TABLE orders(reference text,channel text,archived boolean,source_payload jsonb,source_date timestamptz);CREATE TABLE temu_sync_jobs(reference text PRIMARY KEY,status text,priority int,attempts int,error text,last_checked_at timestamptz,last_success_at timestamptz,next_at timestamptz,started_at timestamptz,updated_at timestamptz);INSERT INTO orders VALUES('PO-069-12345','temu',false,'{}',now());INSERT INTO temu_sync_jobs VALUES('PO-069-12345','failed',0,4,'Achat incertain',now()-interval '1 day',now()-interval '2 days',now(),null,now());");
 const before=(await db.query('SELECT * FROM temu_sync_jobs')).rows[0];await temuSyncJobs(db,{recover:async()=>temuReadDeferral(quota(60))}).run();const after=(await db.query('SELECT *,extract(epoch FROM(next_at-updated_at)) delay FROM temu_sync_jobs')).rows[0];assert.equal(after.status,'deferred');assert.equal(after.error,'Achat incertain');assert.equal(after.attempts,4);assert.deepEqual(after.last_checked_at,before.last_checked_at);assert.deepEqual(after.last_success_at,before.last_success_at);assert.equal(Number(after.delay),60);
 await db.exec("UPDATE temu_sync_jobs SET next_at=now(),error='Quota partagé : lecture différée'");await temuSyncJobs(db,{recover:async()=>{throw quota(1);}}).run();assert.equal((await db.query('SELECT error FROM temu_sync_jobs')).rows[0].error,null);
 }finally{await e.close();}});
test('real provider and purchase uncertainty errors retain normal failure handling',async()=>{const {e,db}=await engine();try{await db.exec("CREATE TABLE orders(reference text,channel text,archived boolean,source_payload jsonb,source_date timestamptz);CREATE TABLE temu_sync_jobs(reference text PRIMARY KEY,status text DEFAULT 'queued',priority int DEFAULT 0,attempts int DEFAULT 0,error text,last_checked_at timestamptz,last_success_at timestamptz,next_at timestamptz DEFAULT now(),started_at timestamptz,updated_at timestamptz);INSERT INTO orders VALUES('PO-069-12345','temu',false,'{}',now());");await temuSyncJobs(db,{recover:async()=>({error:'TEMU HTTP 403'})}).run();const r=(await db.query('SELECT *,extract(epoch FROM(next_at-last_checked_at)) delay FROM temu_sync_jobs')).rows[0];assert.equal(r.status,'failed');assert.equal(r.error,'TEMU HTTP 403');assert.equal(r.attempts,1);assert.equal(Number(r.delay),900);}finally{await e.close();}});
test('UI identifies waiting separately and retains independent stock and uncertain purchase errors',async()=>{
 const sandbox={transportPendingText:null};vm.createContext(sandbox);vm.runInContext(await fs.readFile(new URL('../public/compact-problems.js',import.meta.url),'utf8'),sandbox);
 const order={channel:'temu',carrier:'temu',issue:'Stock insuffisant',source_payload:{temuReadDeferred:{deferred:true}},temu_job:{status:'complete',error:'Quota partagé : lecture différée'},sku_lines:[]};
 const problems=sandbox.compactProblems(order);assert.ok(problems.some(p=>p.type==='stock'));assert.equal(problems.filter(p=>p.type==='temu-read-deferred').length,1);assert.equal(problems.find(p=>p.type==='temu-read-deferred').label,'Lecture TEMU en attente');
 const held=currentHoldDiagnostic({...order,issue:null,temu_job:{status:'complete',error:null}});assert.equal(held.code,'temu_read_deferred');assert.equal(held.decisionRequired,false);
 assert.equal(currentHoldDiagnostic({...order,temu_job:{status:'uncertain',error:'Achat incertain'}}).code,'temu_error');
});

test('a requested stop never writes an order or shipment error',async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'temu-stop-'));try{
 const writes=[],order={id:'A',reference:'PO-069-12345',channel:'temu',address:{country:'FR'},source_payload:{mallId:'M',temuDirect:{state:'verified'}}};const db={query:async(s,a)=>s.startsWith('SELECT')?{rows:[order]}:(writes.push({s,a}),{rows:[]})};
 const local=temuLocalService(db,dir,{configLoader:async()=>({}),shopLoader:async()=>[],apiFactory:()=>({read:async()=>{throw Object.assign(Error('Arrêt demandé'),{code:'TEMU_STOPPING'});}})});await assert.rejects(local.recover(order.reference),e=>e.code==='TEMU_STOPPING');assert.equal(writes.length,0);
 }finally{await fs.rm(dir,{recursive:true,force:true});}});
