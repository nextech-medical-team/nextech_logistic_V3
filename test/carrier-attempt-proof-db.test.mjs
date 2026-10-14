import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {queueLabelFromBl} from '../src/direct-label.mjs';
import {initializeCarrierJobs,createCarrierWorkers} from '../src/carrier-jobs.mjs';
import {initializeAppSchema} from '../src/schema-startup.mjs';
async function fixture(){
 const e=new PGlite();await e.waitReady;const wrap=x=>({query:(s,p=[])=>x.query(s,p),exec:s=>x.exec(s)});
 const db={...wrap(e),transaction:fn=>e.transaction(tx=>fn(wrap(tx))),withLocks:async(_,fn)=>fn(),recoverInterrupted:false};
 await db.exec(`CREATE TABLE orders(id text PRIMARY KEY,channel text,reference text,carrier text,address jsonb,source_payload jsonb DEFAULT '{}',erp_live jsonb DEFAULT '{}',label_status text,weight_kg numeric,parcel_count integer,tracking_status text,archived boolean DEFAULT false,partial_mode boolean DEFAULT false,resolution_pending_resume boolean DEFAULT true,suspension jsonb DEFAULT '{}',issue text);
 CREATE TABLE lines(id text,order_id text,source_line text,source_sku text,target_sku text,quantity numeric,target_quantity numeric);
 CREATE TABLE settings(key text,value jsonb);CREATE TABLE resolution_jobs(id text,order_id text,status text);CREATE TABLE extra_parcels(id text,order_id text);
 CREATE TABLE audit(user_email text,action text,detail jsonb,created_at timestamptz DEFAULT now());
 CREATE TABLE schema_migrations(version text PRIMARY KEY);INSERT INTO schema_migrations VALUES('application-20261005-robustness-5');`);
 await initializeCarrierJobs(db);
 const erp={bc:{id:'bc',status:'active'},bl:{id:'bl',status:'in_preparation'},pricing:{status:'blocked'},preparationAuthority:{kind:'recorded_bc',fingerprint:'wrong'}};
 await db.query("INSERT INTO orders(id,channel,reference,carrier,address,erp_live,label_status,weight_kg,parcel_count) VALUES('o','amazon','SYNTHETIC','gofo',$1,$2,'simulated',1,1)",[JSON.stringify({name:'Synthetic',street:'1 rue Test',city:'Paris',postal:'75001',country:'FR'}),JSON.stringify(erp)]);
 return {e,db,erp,job:async()=>(await db.query("SELECT * FROM carrier_jobs WHERE order_id='o'")).rows[0]};
}
test('existing BL bypasses preparation despite fiscal/quantity/stock proof absent; two clicks create once',async()=>{
 const {e,db,erp,job}=await fixture();try{
 await Promise.all([queueLabelFromBl(db,'o',{email:'operator'}),queueLabelFromBl(db,'o',{email:'operator'})]);
 let posts=0;const workers=createCarrierWorkers(db,null,{clients:{gofoCreate:async()=>{posts++;const j=await job();assert(j.creation_started_at);return {reference:'R',tracking:['T']};},gofoLabel:async()=>Buffer.from('%PDF-1.4 test').toString('base64')}});
 await workers.run('gofo');await workers.run('gofo');assert.equal(posts,1);assert.equal((await job()).status,'ready');
 assert.equal((await db.query('SELECT count(*)::int n FROM carrier_documents')).rows[0].n,1);
 assert.deepEqual((await db.query("SELECT erp_live FROM orders WHERE id='o'")).rows[0].erp_live,erp);
 }finally{await e.close();}
});
test('worker preflight failure remains safely resumable after diagnostic rewrite',async()=>{
 const {e,db,job}=await fixture();try{
 await queueLabelFromBl(db,'o',{email:'operator'});await db.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{bl,id}','\"changed\"') WHERE id='o'");
 await createCarrierWorkers(db,null,{clients:{gofoCreate:()=>assert.fail('provider called')}}).run('gofo');
 const j=await job();assert.equal(j.status,'failed');assert.equal(j.failure_phase,'preflight');assert.equal(j.creation_started_at,null);assert.match(j.original_error,/BL modifié/);
 await db.query("UPDATE carrier_jobs SET error='Diagnostic de revalidation' WHERE order_id='o'");
 await queueLabelFromBl(db,'o',{email:'operator'});assert.equal((await job()).status,'pending');assert.equal((await job()).creation_started_at,null);
 }finally{await e.close();}
});
test('ambiguous provider call cannot be resent even if its message changes to validation',async()=>{
 const {e,db,job}=await fixture();try{
 await queueLabelFromBl(db,'o',{email:'operator'});let posts=0;
 await createCarrierWorkers(db,null,{clients:{gofoCreate:async()=>{posts++;const err=Error('timeout');err.uncertain=true;throw err;}}}).run('gofo');
 assert.equal((await job()).status,'review');assert.equal((await job()).failure_phase,'provider');assert((await job()).creation_started_at);
 await db.query("UPDATE carrier_jobs SET status='failed',error='Préparation modifiée depuis le BL' WHERE order_id='o'");
 await assert.rejects(queueLabelFromBl(db,'o',{email:'operator'}),/incertaine/);assert.equal(posts,1);
 }finally{await e.close();}
});
test('PDF retrieval retry retains shipment and never repeats its creation',async()=>{
 const {e,db,job}=await fixture();try{
 await queueLabelFromBl(db,'o',{email:'operator'});let posts=0,pdfs=0;
 const workers=createCarrierWorkers(db,null,{clients:{gofoCreate:async()=>{posts++;return {reference:'R',tracking:['T']};},gofoLabel:async()=>{if(++pdfs===1)throw Error('PDF temporarily unavailable');return Buffer.from('%PDF-1.4 test').toString('base64');}}});
 await workers.run('gofo');assert.equal((await job()).status,'awaiting_pdf');
 await db.query("UPDATE carrier_jobs SET updated_at=now()-interval '1 minute' WHERE order_id='o'");await workers.run('gofo');
 assert.equal((await job()).status,'ready');assert.equal(posts,1);assert.equal(pdfs,2);
 }finally{await e.close();}
});
test('explicit GOFO zone rejection permits existing GLS fallback with the same request',async()=>{
 const {e,db,job}=await fixture();try{
 await queueLabelFromBl(db,'o',{email:'operator'});const creationId=(await job()).creation_id;let gofo=0,gls=0;
 const workers=createCarrierWorkers(db,null,{clients:{gofoCreate:async()=>{gofo++;const err=Error('postal code not in service');err.zoneRejected=true;throw err;},gls:async()=>{gls++;return {reference:'R',tracking:['T'],documents:[Buffer.from('%PDF-1.4 test').toString('base64')]};}}});
 await workers.run('gofo');assert.equal((await job()).creation_started_at,null);assert.equal((await job()).carrier,'gls');await workers.run('gls');assert.equal((await job()).status,'ready');assert.equal((await job()).creation_id,creationId);assert.equal(gofo,1);assert.equal(gls,1);
 }finally{await e.close();}
});
test('additive upgrade preserves legacy jobs and applies once without replaying initializers',async()=>{
 const {e,db,job}=await fixture();try{
 await queueLabelFromBl(db,'o',{email:'operator'});await db.exec('ALTER TABLE carrier_jobs DROP COLUMN creation_started_at;ALTER TABLE carrier_jobs DROP COLUMN failure_phase;ALTER TABLE carrier_jobs DROP COLUMN original_error;');
 const before=await job();await initializeAppSchema(db,[()=>assert.fail('business initializer replayed')]);await initializeAppSchema(db,[]);
 const after=await job();const {creation_started_at,failure_phase,original_error,...same}=after;assert.deepEqual(same,before);assert.equal(creation_started_at,null);assert.equal(failure_phase,null);assert.equal(original_error,null);
 assert.equal((await db.query("SELECT count(*)::int n FROM schema_migrations WHERE version='carrier-attempt-proof-20261014-1'")).rows[0].n,1);
 }finally{await e.close();}
});
test('historical generic failure with the original audit is admitted once without changing its diagnostic',async()=>{
 const {e,db,job}=await fixture();try{
 const error='Échec d’étiquette antérieur, suivi d’une revalidation BC/BL. Aucune relance effectuée.';
 const stamp='2026-10-10T03:12:00.528Z';
 const detail={orderId:'o',currentError:error,previousError:'Préparation modifiée depuis la validation du BL : recontrôler',businessWrites:0,labelPurchased:false,previousUpdatedAt:'2026-10-09T11:48:53.733Z',proof:{previousFailureAt:'2026-10-09T11:48:53.733Z',validationAt:'2026-10-09T15:35:49.486Z',readOnly:true,verified:true,businessActionAuthorized:false}};
 await db.query("INSERT INTO carrier_jobs(order_id,carrier,status,attempts,error,updated_at) VALUES('o','gofo','failed',1,$1,$2)",[error,stamp]);
 await db.query("INSERT INTO audit(action,detail,created_at) VALUES('carrier.prevalidation_diagnostic_revalidated',$1,$2)",[JSON.stringify(detail),stamp]);
 const r=await Promise.all([queueLabelFromBl(db,'o',{email:'operator'}),queueLabelFromBl(db,'o',{email:'operator'})]);
 assert.equal(r.filter(x=>!x.existing).length,1);assert.equal((await job()).status,'pending');
 assert.deepEqual((await db.query("SELECT detail FROM audit WHERE action='carrier.prevalidation_diagnostic_revalidated'")).rows[0].detail,detail);
 }finally{await e.close();}
});
