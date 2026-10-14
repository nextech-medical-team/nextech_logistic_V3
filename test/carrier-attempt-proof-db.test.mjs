import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {queueLabelFromBl} from '../src/direct-label.mjs';
import {initializeCarrierJobs,createCarrierWorkers} from '../src/carrier-jobs.mjs';
import {initializeAppSchema} from '../src/schema-startup.mjs';
import {hasUncertainCarrierHistory} from '../src/carrier-attempt-proof.mjs';
import {synchronizeRecoveredOrder} from '../src/erplain-targeted-orders.mjs';
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

test('native single-BL label queue persists its measured cargo and produces three PDFs exactly once without changing ERP or old V3 lines',async()=>{
 const {e,db,erp,job}=await fixture();try{
 await db.exec("CREATE TABLE products(sku text PRIMARY KEY,weight_kg numeric);INSERT INTO products VALUES('A',0.0038),('B',0.004),('C',0.004),('D',0.0068);INSERT INTO lines(id,order_id,source_line,source_sku,target_sku,quantity,target_quantity) VALUES('old','o','1','OLD','OLD',55000,55000);");
 erp.bl.line_items=[['A',1500],['B',8000],['C',8000],['D',2000]].map(([sku,quantity])=>({type:'normal',quantity,variant:{sku}}));
 await db.query("UPDATE orders SET channel='tender',carrier='gls_pharma',weight_kg=74500,parcel_count=2484,erp_live=$1 WHERE id='o'",[JSON.stringify(erp)]);
 await queueLabelFromBl(db,'o',{email:'operator'});await queueLabelFromBl(db,'o',{email:'operator'});const request=(await job()).manual_bl_request;assert.equal(request.blPayload.parcels,3);assert.equal(request.previousParcelCalculation.parcels,2484);
 // A later catalogue change never redefines the already requested shipment.
 await db.exec("UPDATE products SET weight_kg=99 WHERE sku='A'");
 let posts=0;const workers=createCarrierWorkers(db,null,{clients:{gls:async(o,{beforeCreate})=>{assert.equal(o.weight_kg,83.3);assert.equal(o.parcel_count,3);assert.equal(o.lines.length,4);await beforeCreate();posts++;return {reference:'R',tracking:['T1','T2','T3'],documents:[1,2,3].map(n=>Buffer.from('%PDF-1.4 synthetic '+n).toString('base64'))};}}});
 await workers.run('gls');await workers.run('gls');assert.equal(posts,1);assert.equal((await job()).status,'ready');assert.equal((await db.query("SELECT count(*)::int n FROM carrier_documents WHERE order_id='o'")).rows[0].n,3);
 const saved=(await db.query("SELECT erp_live,weight_kg,parcel_count FROM orders WHERE id='o'")).rows[0];assert.deepEqual(saved.erp_live,erp);assert.equal(Number(saved.weight_kg),83.3);assert.equal(saved.parcel_count,3);assert.equal(Number((await db.query("SELECT quantity FROM lines WHERE id='old'")).rows[0].quantity),55000);assert.equal((await db.query("SELECT count(*)::int n FROM audit WHERE action='label.manual_from_bl'")).rows[0].n,1);
 }finally{await e.close();}
});

test('cleared phone failure archive resumes through real SQL; newer unrelated audit cannot hide proof',async()=>{
 const {e,db,erp,job}=await fixture();try{
 const archived={order_id:'o',status:'failed',attempts:1,creation_id:'reserved',result:null,reference:null,tracking:[],error:null,updated_at:'2026-10-14T10:01:44.515Z'};
 await db.query("INSERT INTO carrier_label_history(id,order_id,job) VALUES('h','o',$1)",[JSON.stringify(archived)]);
 await db.query("INSERT INTO audit(user_email,action,detail,created_at) VALUES('system','erplain.label_preflight_refreshed',$1,'2026-10-14T10:01:44.515266Z')",[JSON.stringify({orderId:'o',currentError:null,previousError:'Erplain LIVE · Informations obligatoires manquantes : Numéro de téléphone',labelPurchased:false})]);
 await db.query("INSERT INTO audit(user_email,action,detail,created_at) VALUES('system','carrier.imported_fields_diagnostic_revalidated',$1,'2026-10-14T11:00:00Z')",[JSON.stringify({orderId:'o',currentError:'different'})]);
 assert.equal(await hasUncertainCarrierHistory(db,'o'),false);
 await queueLabelFromBl(db,'o',{email:'operator'});await queueLabelFromBl(db,'o',{email:'operator'});
 assert.equal((await job()).status,'pending');
 assert.deepEqual((await db.query("SELECT job FROM carrier_label_history WHERE id='h'")).rows[0].job,archived);
 assert.deepEqual((await db.query("SELECT erp_live FROM orders WHERE id='o'")).rows[0].erp_live,erp);
 await db.query("INSERT INTO carrier_label_history_documents(history_id,document_index,pdf) VALUES('h',0,$1)",[Buffer.from('%PDF-1.4 archive')]);
 assert.equal(await hasUncertainCarrierHistory(db,'o'),true);
 }finally{await e.close();}
});

test('future Erplain refresh preserves original phone failure before clearing displayed diagnostic',async()=>{
 const {e,db,job}=await fixture();try{
 await db.exec("ALTER TABLE orders ADD COLUMN recipient text;ALTER TABLE orders ADD COLUMN erplain_refresh jsonb DEFAULT '{}';CREATE TABLE erp_live_jobs(order_id text,status text);CREATE TABLE partial_deliveries(order_id text,status text);");
 const original='Erplain LIVE · Informations obligatoires manquantes : Numéro de téléphone';
 await db.query("INSERT INTO carrier_jobs(order_id,carrier,status,attempts,error,tracking) VALUES('o','gofo','failed',1,$1,'[]')",[original]);
 const o=(await db.query("SELECT * FROM orders WHERE id='o'")).rows[0];
 const line={id:'l',type:'normal',variant:{id:'v',sku:'SKU',track_inventory:true},quantity:1,shipped_quantity:0,reserved_quantity:0,on_hand:5,available:5,location:{id:'loc'}};
 const d={id:'bc',label:'BC1',status:'active',external_reference:'REF',customer:{id:'c',label:'Client'},update_stock:true,line_items:[line],shipping_address:{label:'Client',address_1:'1 rue Test',city:'Paris',postal_code:'75001',country:'FR',phone:'0612345678'},shipping_orders:{data:[{id:'bl',label:'BL1',status:'in_preparation',line_items:[{...line,parent_id:'l'}]}],paginatorInfo:{hasMorePages:false}}};
 await db.transaction(tx=>synchronizeRecoveredOrder(tx,o,d));
 const j=await job();assert.equal(j.error,null);assert.equal(j.original_error,original);assert.equal(j.failure_phase,'preflight');assert.equal(j.creation_started_at,null);
 assert.equal(j.status,'failed');assert.equal(j.attempts,1);
 }finally{await e.close();}
});

test('retired mapping refusal resumes once through existing BL with no ERP mutation',async()=>{
 const {e,db,erp,job}=await fixture();try{
 await db.query("INSERT INTO carrier_jobs(order_id,carrier,status,attempts,error,creation_id,tracking) VALUES('o','gofo','failed',1,'Mapping modifié avant création : recontrôle requis','old','[]')");
 await queueLabelFromBl(db,'o',{email:'operator'});await queueLabelFromBl(db,'o',{email:'operator'});
 let posts=0;const workers=createCarrierWorkers(db,null,{clients:{gofoCreate:async(_o,{beforeCreate})=>{await beforeCreate();posts++;return {reference:'R',tracking:['T']};},gofoLabel:async()=>Buffer.from('%PDF-1.4 test').toString('base64')}});
 await workers.run('gofo');await workers.run('gofo');assert.equal(posts,1);assert.equal((await job()).status,'ready');
 assert.deepEqual((await db.query("SELECT erp_live FROM orders WHERE id='o'")).rows[0].erp_live,erp);
 }finally{await e.close();}
});

test('fresh manual BL request admits an archived first local mapping refusal, preserves it, and still refuses provider HTTP errors',async()=>{
 const {e,db,erp,job}=await fixture();try{
 const archived={order_id:'o',status:'failed',attempts:1,error:'Mapping modifié avant création : recontrôle requis',creation_id:'reserved-before-validation',result:null,reference:null,tracking:[],updated_at:'2026-10-14T08:33:48.394Z'};
 await db.query("INSERT INTO carrier_label_history(id,order_id,job) VALUES('legacy-mapping','o',$1)",[JSON.stringify(archived)]);
 assert.equal(await hasUncertainCarrierHistory(db,'o'),true);
 assert.equal(await hasUncertainCarrierHistory(db,'o',{manualRequest:true}),false);
 await queueLabelFromBl(db,'o',{email:'operator'});assert.equal((await job()).status,'pending');
 assert.deepEqual((await db.query("SELECT job FROM carrier_label_history WHERE id='legacy-mapping'")).rows[0].job,archived);
 assert.deepEqual((await db.query("SELECT erp_live FROM orders WHERE id='o'")).rows[0].erp_live,erp);
 await db.query("INSERT INTO carrier_label_history(id,order_id,job) VALUES('provider-refusal','o',$1)",[JSON.stringify({...archived,error:'Transporteur GLS (création étiquette) : HTTP 400 — réponse vide, aucun motif fourni par le transporteur'})]);
 assert.equal(await hasUncertainCarrierHistory(db,'o',{manualRequest:true}),true);
 }finally{await e.close();}
});
test('existing BL bypasses preparation despite fiscal/quantity/stock proof absent; two clicks create once',async()=>{
 const {e,db,erp,job}=await fixture();try{
 await Promise.all([queueLabelFromBl(db,'o',{email:'operator'}),queueLabelFromBl(db,'o',{email:'operator'})]);
 let posts=0;const workers=createCarrierWorkers(db,null,{clients:{gofoCreate:async(_o,{beforeCreate})=>{await beforeCreate();posts++;const j=await job();assert(j.creation_started_at);return {reference:'R',tracking:['T']};},gofoLabel:async()=>Buffer.from('%PDF-1.4 test').toString('base64')}});
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
 await db.query("UPDATE carrier_jobs SET attempts=99,error='Diagnostic de revalidation' WHERE order_id='o'");
 await queueLabelFromBl(db,'o',{email:'operator'});assert.equal((await job()).status,'pending');assert.equal((await job()).creation_started_at,null);
 }finally{await e.close();}
});
test('ambiguous provider call cannot be resent even if its message changes to validation',async()=>{
 const {e,db,job}=await fixture();try{
 await queueLabelFromBl(db,'o',{email:'operator'});let posts=0;
 await createCarrierWorkers(db,null,{clients:{gofoCreate:async(_o,{beforeCreate})=>{await beforeCreate();posts++;const err=Error('timeout');err.uncertain=true;throw err;}}}).run('gofo');
 assert.equal((await job()).status,'review');assert.equal((await job()).failure_phase,'provider');assert((await job()).creation_started_at);
 await db.query("UPDATE carrier_jobs SET status='failed',error='Préparation modifiée depuis le BL' WHERE order_id='o'");
 await assert.rejects(queueLabelFromBl(db,'o',{email:'operator'}),/incertaine/);assert.equal(posts,1);
 }finally{await e.close();}
});
test('PDF retrieval retry retains shipment and never repeats its creation',async()=>{
 const {e,db,job}=await fixture();try{
 await queueLabelFromBl(db,'o',{email:'operator'});let posts=0,pdfs=0;
 const workers=createCarrierWorkers(db,null,{clients:{gofoCreate:async(_o,{beforeCreate})=>{await beforeCreate();posts++;return {reference:'R',tracking:['T']};},gofoLabel:async()=>{if(++pdfs===1)throw Error('PDF temporarily unavailable');return Buffer.from('%PDF-1.4 test').toString('base64');}}});
 await workers.run('gofo');assert.equal((await job()).status,'awaiting_pdf');
 await db.query("UPDATE carrier_jobs SET updated_at=now()-interval '1 minute' WHERE order_id='o'");await workers.run('gofo');
 assert.equal((await job()).status,'ready');assert.equal(posts,1);assert.equal(pdfs,2);
 }finally{await e.close();}
});
test('explicit GOFO zone rejection permits existing GLS fallback with the same request',async()=>{
 const {e,db,job}=await fixture();try{
 await queueLabelFromBl(db,'o',{email:'operator'});const creationId=(await job()).creation_id;let gofo=0,gls=0;
 const workers=createCarrierWorkers(db,null,{clients:{gofoCreate:async(_o,{beforeCreate})=>{await beforeCreate();gofo++;const err=Error('postal code not in service');err.zoneRejected=true;throw err;},gls:async(_o,{beforeCreate})=>{await beforeCreate();gls++;return {reference:'R',tracking:['T'],documents:[Buffer.from('%PDF-1.4 test').toString('base64')]};}}});
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
test('a pending row with a persisted creation marker never replays its POST',async()=>{
 const {e,db,job}=await fixture();try{
 await queueLabelFromBl(db,'o',{email:'operator'});await db.query("UPDATE carrier_jobs SET creation_started_at=now() WHERE order_id='o'");
 await createCarrierWorkers(db,null,{clients:{gofoCreate:()=>assert.fail('replayed POST')}}).run('gofo');
 assert.equal((await job()).status,'review');assert.equal((await job()).failure_phase,'provider');assert((await job()).creation_started_at);
 }finally{await e.close();}
});
test('BC fingerprint failure and archived preflight do not repeat business checks or erase the archive',async()=>{
 const {e,db,job,erp}=await fixture();try{
 const error='Échec d’étiquette antérieur : champs Erplain relus et validés. Aucune relance effectuée.',stamp='2026-10-14T10:31:36.497Z';
 const archived={order_id:'o',status:'failed',attempts:1,creation_id:'old-attempt',result:null,reference:null,tracking:[],error,updated_at:stamp};
 const detail={orderId:'o',currentError:error,previousError:'Erplain LIVE · Numéro de téléphone invalide : corriger avant création de l’étiquette',businessWrites:0,labelPurchased:false,proof:{readOnly:true,businessActionAuthorized:false}};
 await db.query("INSERT INTO carrier_label_history(id,order_id,job) VALUES('h','o',$1)",[JSON.stringify(archived)]);
 await db.query("INSERT INTO audit(action,detail,created_at) VALUES('carrier.imported_fields_diagnostic_revalidated',$1,$2)",[JSON.stringify(detail),stamp]);
 await db.query("INSERT INTO carrier_jobs(order_id,carrier,status,attempts,creation_id,error) VALUES('o','gofo','failed',1,'new-attempt','BC modifié depuis sa préparation : recontrôle requis')");
 await queueLabelFromBl(db,'o',{email:'operator'});assert.equal((await job()).status,'pending');
 assert.deepEqual((await db.query("SELECT job FROM carrier_label_history WHERE id='h'")).rows[0].job,archived);
 assert.deepEqual((await db.query("SELECT erp_live FROM orders WHERE id='o'")).rows[0].erp_live,erp);
 }finally{await e.close();}
});
