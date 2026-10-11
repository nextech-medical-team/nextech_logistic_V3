import {currentMappingFingerprint} from '../src/current-mapping-line.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {monitoringObservation,localObservationPatch,initializeOrderRecheckMonitor,orderRecheckMonitor,recheckCadence} from '../src/order-recheck-monitor.mjs';

test('local diagnostic writes preserve newer external evidence and independent sweep requests',()=>{
 const old={lastExternalCheck:'2026-10-11T10:00:00Z',auditRequested:true,externalResult:'previous'},fresh={lastExternalCheck:'2026-10-11T11:00:00Z',auditRequested:false,externalResult:'complete'};
 const observation=monitoringObservation({issue:'Stock insuffisant'},old),merged={...fresh,...localObservationPatch(observation)};
 assert.equal(merged.lastExternalCheck,fresh.lastExternalCheck);assert.equal(merged.auditRequested,false);assert.equal(merged.externalResult,'complete');assert.equal(merged.blocked,true);
});

test('five families retain clocks, deadlines, next actions and persistent alerts',()=>{
 const at=Date.parse('2026-10-10T20:00:00Z');
 for(const issue of ['SKU Erplain introuvable','Reprise historique à vérifier : BL non créé','Stock insuffisant','BC annulé à rapprocher','BL à vérifier']){
  const o={issue,erp_live:{bc:{id:'1'}},mapping_lines:[{sku:'X',quantity:1}]};
  const first=monitoringObservation(o,{},at),later=monitoringObservation({...o,updated_at:new Date(at+3600000)},first,at+3600000);
  assert.equal(later.alert,true);assert.equal(later.lastProgress,first.lastProgress);assert.equal(Date.parse(later.nextCheck)-Date.parse(later.lastCheck),recheckCadence.local);
  const again=monitoringObservation(o,later,at+3900000);assert.equal(again.alertSince,later.alertSince);
  const progressed=monitoringObservation({...o,erp_live:{bc:{id:'1'},bl:{id:'2',status:'pending'}}},again,at+4000000);assert.equal(progressed.lastProgress,new Date(at+4000000).toISOString());assert.equal(progressed.externalOverdue,true);assert.equal(progressed.alert,true);
 }
});
test('old block alerts immediately on installation and fresh reads never reset it',()=>{
 const now=Date.now(),o={issue:'BL non créé',blocked_since:new Date(now-7200000),erp_live:{}};
 assert.equal(monitoringObservation(o,{},now).alert,true);
});

test('external failures are explicit and local polling cannot hide two missed external cycles',()=>{
 const at=Date.parse('2026-10-11T12:00:00Z'),o={resolution_pending_resume:true,erp_live:{bc:{id:'1'},bl:{id:'2'}},channel:'temu',temu_job:{status:'complete'}};
 const first=monitoringObservation(o,{},at),next=monitoringObservation(o,{...first,externalReadIssue:'Stock existant incompatible'},at+1800000);
 assert.equal(next.result,'Stock existant incompatible');assert.equal(next.externalOverdue,true);assert.equal(next.alert,true);assert.equal(next.lastProgress,first.lastProgress);
 const done=monitoringObservation({...o,resolution_pending_resume:false},next,at+1800001);assert.equal(done.externalOverdue,false);assert.equal(done.alert,false);
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


async function confirmedRead(db,id,concordant=true){
 const order=(await db.query('SELECT * FROM orders WHERE id=$1',[id])).rows[0];
 const comparison={concordant,checkedAt:new Date().toISOString(),mappingFingerprint:await currentMappingFingerprint(db,order)};
 await db.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{bcComparisonRefresh}',$2::jsonb,true) WHERE id=$1",[id,JSON.stringify(comparison)]);
 return {comparison};
}

async function fixture(){
 const db=new PGlite();db.withLocks=async(keys,fn)=>fn();db.transaction=fn=>fn(db);
 await db.exec(`CREATE TABLE audit(user_email text,action text,detail jsonb);CREATE TABLE orders(id text PRIMARY KEY,channel text DEFAULT 'temu',reference text,transport_choice text,archived boolean DEFAULT false,partial_mode boolean DEFAULT false,issue text,label_status text,erp_status text,source_payload jsonb DEFAULT '{}',erp_live jsonb DEFAULT '{}',resolution_pending_resume boolean DEFAULT false,suspension jsonb DEFAULT '{}');
 CREATE TABLE erp_live_jobs(order_id text,status text,error text,updated_at timestamptz DEFAULT now(),state_since timestamptz DEFAULT now());CREATE TABLE carrier_jobs(order_id text,status text,error text); CREATE TABLE partial_deliveries(order_id text,status text);
 CREATE TABLE resolution_jobs(id text,order_id text,request_id text UNIQUE,action text,status text DEFAULT 'queued',stage text,payload jsonb,result jsonb,error text,updated_at timestamptz DEFAULT now(),created_at timestamptz DEFAULT now());
 CREATE TABLE temu_label_jobs(reference text,status text,error text,packages jsonb);
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
  const failed=(await db.query('SELECT state FROM order_recheck_monitor')).rows;assert.ok(failed.every(r=>!r.state.lastExternalCheck&&r.state.lastExternalAttempt&&r.state.externalStatus==='error'));
  await db.query("UPDATE order_recheck_monitor SET next_external=now()-interval '1 second'");await monitor.runExternal();assert.equal(reads,1);assert.equal(docs,0);
  await db.query("UPDATE correction_jobs SET status='complete' WHERE order_id='a'");
  await db.query("INSERT INTO correction_jobs VALUES('a','complete','{}',null)");const queued=(await db.query("SELECT requested,checked FROM order_recheck_monitor WHERE order_id='a'")).rows[0];assert.ok(queued.requested>queued.checked);
  await monitor.runLocal();assert.equal((await db.query("SELECT requested=checked ok FROM order_recheck_monitor WHERE order_id='a'")).rows[0].ok,true);
  // The same persistent deadlines survive a service instance restart.
  await orderRecheckMonitor(db,{}, {readProduct:()=>assert.fail('premature read'),readDocuments:()=>assert.fail('premature read')}).runExternal();
 }finally{await db.close();}
});

test('read-only corrections and unavailable products never authorize automatic continuation',async()=>{
 for(const kind of ['read-only','missing-product','legacy-cache']){
  const db=await fixture();try{
   await db.query(`UPDATE orders SET resolution_pending_resume=true,erp_live='{"phase":"bc_created","bc":{"id":"1"},"pricing":{"status":"verified"}}'`);
   if(kind==='read-only')await db.query(`INSERT INTO resolution_jobs(id,order_id,request_id,action,status,result) VALUES('r','a','r','check-sku','complete','{"readOnly":true,"resumeAfter":false}'),('s','b','s','check-sku','complete','{"readOnly":true,"resumeAfter":false}')`);
   if(kind==='legacy-cache')await db.query(`INSERT INTO order_recheck_resources(resource,next_check,result) VALUES('sku:X',now()+interval '15 minutes','{"status":"missing"}')`);
   const m=orderRecheckMonitor(db,{}, {readProduct:async()=>kind==='missing-product'?{usable:false,status:'missing'}:{usable:true,status:'active',variant:{sku:'X'}},cacheProduct:async()=>{},readDocuments:async()=>({})});
   await m.run();assert.equal((await db.query("SELECT count(*)::int n FROM resolution_jobs WHERE action='resume-erp'")).rows[0].n,0);
  }finally{await db.close();}
 }
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
 const m=orderRecheckMonitor(db,{}, {canResume:()=>allow,readProduct:async()=>{started();await pause;return {usable:true,variant:{sku:'X'},status:'active'};},cacheProduct:async()=>{},readDocuments:async(_db,_api,id)=>confirmedRead(db,id)});
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
 const m=orderRecheckMonitor(db,{}, {readProduct:async()=>({usable:true,variant:{sku:'X'},status:'active'}),cacheProduct:async()=>{},readDocuments:async(_db,_api,id)=>confirmedRead(db,id)});await m.runLocal();
 const transaction=db.transaction;db.transaction=async fn=>{await db.query("UPDATE orders SET suspension='{\"active\":true}' WHERE id='b'");return transaction(fn);};await m.runExternal();
 assert.equal((await db.query("SELECT count(*)::int n FROM resolution_jobs WHERE action='resume-erp'")).rows[0].n,0);assert.equal((await db.query("SELECT result->>'replacementSku' sku FROM resolution_jobs WHERE id='preview'")).rows[0].sku,'NEW');
 }finally{await db.close();}
});

import {persistedRecheckProblemSql} from '../src/order-problem-predicates.mjs';
test('the problems list retains an independent review after another correction succeeds and removes it after its own completion',async()=>{
 const db=await fixture();try{await db.query("UPDATE orders SET issue=null WHERE id='a'");await db.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,status,error,created_at) VALUES('address','a','address','address','review','Current address mismatch',now()-interval '1 hour'),('weight','a','weight','weight','complete',null,now())");const m=orderRecheckMonitor(db,{});await m.runLocal();assert.equal((await db.query("SELECT state->>'result' result FROM order_recheck_monitor WHERE order_id='a'")).rows[0].result,'Current address mismatch');assert.ok((await db.query(`SELECT id FROM orders WHERE ${persistedRecheckProblemSql}`)).rows.some(r=>r.id==='a'));await db.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,status,error,created_at) VALUES('fixed','a','fixed','address','complete',null,now()+interval '1 second')");await m.runLocal();assert.ok(!(await db.query(`SELECT id FROM orders WHERE ${persistedRecheckProblemSql}`)).rows.some(r=>r.id==='a'));}finally{await db.close();}
});

for(const scenario of ['pending-existing','pending-no-bc','pending-no-resume','processing','partial','different','unconfirmed'])test('BC recurrence '+scenario+': real SQL eligibility and protected resume',async()=>{
 const db=await fixture();try{
  await db.exec("DELETE FROM order_recheck_monitor WHERE order_id='b'; DELETE FROM orders WHERE id='b'");await db.query("DELETE FROM lines WHERE order_id='b'");
  const bc=scenario==='pending-no-bc'?{}:{id:'1'};
  await db.query("UPDATE orders SET resolution_pending_resume=$1,partial_mode=$2,erp_live=$3 WHERE id='a'",[scenario!=='pending-no-resume',scenario==='partial',JSON.stringify({phase:'bc_created',bc,pricing:{status:'verified'}})]);
  await db.query("INSERT INTO erp_live_jobs(order_id,status) VALUES('a',$1)",[scenario==='processing'?'processing':'pending']);
  let reads=0;const m=orderRecheckMonitor(db,{}, {readProduct:async()=>({usable:true,status:'active',variant:{sku:'X'}}),cacheProduct:async()=>{},readDocuments:async(_db,_api,id)=>{reads++;return scenario==='unconfirmed'?{}:confirmedRead(db,id,scenario!=='different');}});
  await m.runLocal();await m.runExternal();
  assert.equal(reads,['pending-no-bc','pending-no-resume','processing'].includes(scenario)?0:1);
  assert.equal((await db.query("SELECT count(*)::int n FROM resolution_jobs WHERE action='resume-erp'")).rows[0].n,scenario==='pending-existing'?1:0);
  assert.equal((await db.query("SELECT status FROM erp_live_jobs WHERE order_id='a'")).rows[0].status,scenario==='processing'?'processing':'pending');
 }finally{await db.close();}
});

test('mapping changed after document refresh cannot enqueue an automatic resume',async()=>{
 const db=await fixture();try{
 await db.query(`UPDATE orders SET issue='Reprise de preparation',resolution_pending_resume=true,erp_live='{"phase":"bc_created","bc":{"id":"1"},"pricing":{"status":"verified"}}'`);
 const m=orderRecheckMonitor(db,{}, {readProduct:async()=>({usable:true,status:'active',variant:{sku:'X'}}),cacheProduct:async()=>{},readDocuments:async(_db,_api,id)=>{const proof=await confirmedRead(db,id);await db.query('UPDATE lines SET quantity=quantity+1 WHERE order_id=$1',[id]);return proof;}});
 await m.runLocal();await m.runExternal();assert.equal((await db.query("SELECT count(*)::int n FROM resolution_jobs WHERE action='resume-erp'")).rows[0].n,0);
 }finally{await db.close();}
});


test('a ready TEMU quote awaiting human purchase is not a technical block, and independent failures survive',async()=>{
 const db=await fixture();
 try{
  await initializeOrderRecheckMonitor(db);
  await db.query("UPDATE orders SET issue=null,erp_live=$2::jsonb WHERE id=$1",['a',JSON.stringify({phase:'bl_ready',bc:{id:'BC'},bl:{id:'BL'}})]);
  await db.query("INSERT INTO erp_live_jobs(order_id,status) VALUES('a','complete')");
  await db.query("INSERT INTO temu_label_jobs(reference,status) VALUES('A','ready')");
  const worker=orderRecheckMonitor(db,{}, {canResume:()=>false});await worker.runLocal();
  const state=(await db.query("SELECT state FROM order_recheck_monitor WHERE order_id='a'")).rows[0].state;
  assert.equal(state.blocked,false);assert.equal(state.followUp,true);assert.match(state.result,/Achat d’étiquette TEMU à confirmer/);assert.match(state.nextStep,/TEMU/);
  const base={channel:'temu',awaiting_purchase:true,label_status:'blocked',erp_status:'live_created',erp_live:{phase:'bl_ready'}};
  assert.equal(monitoringObservation(base).blocked,false);
  assert.equal(monitoringObservation({...base,issue:'Stock insuffisant'}).result,'Stock insuffisant');
  assert.equal(monitoringObservation({...base,erp_live_job:{error:'BC incomplet'}}).result,'BC incomplet');
  assert.equal(monitoringObservation({...base,suspension:{active:true}}).blocked,true);
  await db.query("UPDATE temu_label_jobs SET error='Achat incertain',status='review'");await db.query("UPDATE order_recheck_monitor SET next_check=now()");await worker.runLocal();
  assert.equal((await db.query("SELECT state FROM order_recheck_monitor WHERE order_id='a'")).rows[0].state.nextStep==='Confirmer l’achat dans le parcours TEMU',false);
 }finally{await db.close();}
});

import {continuePreparationFromFreshRead} from '../src/preparation-local-continuation.mjs';
for(const scenario of ['valid','stale','future','changed-mapping','stock-review','provider-error','suspended','read-only','replacement','already-running','disabled','attempted-stock','source-hold'])test('fresh BC local continuation: '+scenario,async()=>{
 const db=await fixture();try{
  const at=Date.now();await db.exec('ALTER TABLE orders ADD COLUMN simulation boolean DEFAULT false');
  await db.query("UPDATE orders SET issue=null,erp_live=$1 WHERE id='a'",[JSON.stringify({phase:'bc_created',bc:{id:'1',status:'active'},pricing:{status:'verified'}})]);
  const o=(await db.query("SELECT * FROM orders WHERE id='a'")).rows[0];
  const proof={bcId:'1',readOnly:true,preparationNotStarted:true,checkedAt:new Date(at+(scenario==='stale'?-16*60000:scenario==='future'?60000:0)).toISOString(),comparison:{scope:'full',different:false},errors:[],mappingFingerprint:await currentMappingFingerprint(db,o)};
  await db.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{bcComparisonRefresh}',$1::jsonb) WHERE id='a'",[JSON.stringify(proof)]);
  await db.query("INSERT INTO erp_live_jobs(order_id,status,error) VALUES('a','review',$1)",[scenario==='provider-error'?'Stock insuffisant':null]);
  await db.query("INSERT INTO temu_label_jobs VALUES('A','complete',null,'[\"existing-package\"]')");
  if(scenario==='changed-mapping')await db.query("UPDATE lines SET quantity=2 WHERE order_id='a'");
  if(scenario==='suspended')await db.query("UPDATE orders SET suspension='{\"active\":true}' WHERE id='a'");
  if(scenario==='source-hold')await db.query("UPDATE orders SET source_payload='{\"erplainValidationHold\":true}' WHERE id='a'");
  if(scenario==='attempted-stock')await db.query("UPDATE orders SET erp_live=erp_live||'{\"stockCreationAttemptedAt\":\"2026-10-11T00:00:00Z\"}' WHERE id='a'");
  if(['stock-review','read-only','replacement','already-running'].includes(scenario))await db.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,status,result,error) VALUES('prior','a','prior',$1,$2,$3,$4)",[scenario==='replacement'?'equivalent-preview':'resume-erp',scenario==='stock-review'?'review':scenario==='already-running'?'running':'complete',JSON.stringify(scenario==='read-only'?{readOnly:true}:scenario==='replacement'?{replacementSku:'Y'}:{}),scenario==='stock-review'?'Stock insuffisant':null]);
  const before=(await db.query("SELECT * FROM orders WHERE id='a'")).rows[0];
  const options={now:()=>at,canResume:()=>scenario!=='disabled'};
  // Real local monitor, no supplier read, must consume the completed proof.
  const m=orderRecheckMonitor(db,{},options);await m.runLocal();await m.runLocal();
  await continuePreparationFromFreshRead(db,'a',options);
  const jobs=(await db.query("SELECT * FROM resolution_jobs WHERE request_id LIKE 'fresh-bc-continuation-%'")).rows;
  assert.equal(jobs.length,scenario==='valid'?1:0);
  if(jobs.length){assert.equal(jobs[0].action,'resume-erp');assert.equal(jobs[0].result.erpOnly,true);assert.equal(jobs[0].result.existingLabelsPreserved,true);assert.equal(jobs[0].payload.resumeAfter,true);assert.equal((await db.query("SELECT count(*)::int n FROM audit WHERE action='resolution.requested'")).rows[0].n,1);}
  assert.deepEqual((await db.query("SELECT * FROM orders WHERE id='a'")).rows[0],before);
  assert.deepEqual((await db.query("SELECT packages FROM temu_label_jobs WHERE reference='A'")).rows[0].packages,['existing-package']);
 }finally{await db.close();}
});
