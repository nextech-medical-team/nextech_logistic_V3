import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {initializeTemuAutomaticPurchase,temuAutomaticPurchaseWorker} from '../src/temu-automatic-purchase.mjs';

let sharedDb;
after(async()=>{if(sharedDb)await sharedDb.close();});
async function fixture(t,{status='api_error',blStatus='ready_to_ship',attempt=null,packages=[],suspension={},archived=false}={}){
 const db=sharedDb??new PGlite();
 if(!sharedDb){
 await db.exec(`CREATE TABLE orders(id text PRIMARY KEY,reference text UNIQUE,channel text,archived boolean DEFAULT false,simulation boolean DEFAULT false,partial_mode boolean DEFAULT false,resolution_pending_resume boolean DEFAULT false,issue text,transport_choice text,erp_live jsonb,source_payload jsonb DEFAULT '{}',address jsonb DEFAULT '{}',suspension jsonb DEFAULT '{}',weight_kg numeric,tracking_status text,label_status text);
 CREATE TABLE lines(order_id text,source_line text,id text);
 CREATE TABLE correction_jobs(order_id text,status text);CREATE TABLE resolution_jobs(order_id text,status text);CREATE TABLE erp_live_jobs(order_id text,status text);
 CREATE TABLE carrier_jobs(order_id text);CREATE TABLE carrier_documents(order_id text);CREATE TABLE extra_parcels(order_id text);
 CREATE TABLE temu_label_jobs(reference text PRIMARY KEY,status text,attempt_id text,packages jsonb DEFAULT '[]',plan jsonb);
 CREATE TABLE temu_label_documents(reference text,package text,pdf bytea);`);
 await initializeTemuAutomaticPurchase(db);
 sharedDb=db;
 }else await db.exec('TRUNCATE orders,lines,correction_jobs,resolution_jobs,erp_live_jobs,carrier_jobs,carrier_documents,extra_parcels,temu_label_jobs,temu_label_documents,temu_automatic_purchase_checks,temu_automatic_purchase_audit');
 const reference='PO-069-123456789';
 await db.query(`INSERT INTO orders(id,reference,channel,erp_live,suspension,archived) VALUES('o',$1,'temu',$2,$3,$4)`,[reference,JSON.stringify({bl:{id:'bl',status:blStatus}}),JSON.stringify(suspension),archived]);
 if(status)await db.query('INSERT INTO temu_label_jobs(reference,status,attempt_id,packages) VALUES($1,$2,$3,$4)',[reference,status,attempt,JSON.stringify(packages)]);
 // Deliberately remove the trigger-generated row: periodic discovery must work too.
 await db.exec('DELETE FROM temu_automatic_purchase_checks');
 return {db,reference};
}

for(const status of [null,'api_error','ready','to_buy'])test(`published BL and ${status??'missing job'}: recover existing PDF before unavailable amounts or margin, no buy`,async t=>{
 const {db,reference}=await fixture(t,{status});let recovered=0;
 const pdf=Buffer.from('%PDF-original-untouched');
 const local={async recover(ref){assert.equal(ref,reference);recovered++;await db.query(`INSERT INTO temu_label_jobs(reference,status) VALUES($1,'complete') ON CONFLICT(reference) DO UPDATE SET status='complete'`,[ref]);await db.query('INSERT INTO temu_label_documents VALUES($1,$2,$3)',[ref,'PK-123',pdf]);return {status:'complete',documents:true};},amounts(){assert.fail('Amounts unavailable must not prevent existing PDF recovery');},prepare(){assert.fail('Existing label');},buy(){assert.fail('No repurchase');}};
 const worker=temuAutomaticPurchaseWorker(db,local,{get(){assert.fail('Margin unavailable must not prevent recovery');}},{stockGate(){assert.fail('No post-BL stock check');},refreshPreparation(){assert.fail('No ERP write/read prerequisite');}});
 await worker.run();assert.equal(recovered,1);
 assert.equal((await db.query('SELECT result FROM temu_automatic_purchase_checks')).rows[0]?.result.status,'complete');
 assert.deepEqual(Buffer.from((await db.query('SELECT pdf FROM temu_label_documents')).rows[0].pdf),pdf);
 await db.query('UPDATE temu_automatic_purchase_checks SET next_at=now()');
 await worker.run();assert.equal(recovered,1);
});

for(const status of ['uncertain','purchasing','pending','shipment_error','document_unavailable','complete','external','cancelled'])test(`${status} never enters the automatic purchase retry queue`,async t=>{
 const {db}=await fixture(t,{status});
 await temuAutomaticPurchaseWorker(db,new Proxy({},{get(){return ()=>assert.fail('Existing or uncertain state must not execute');}}),{}).run();
 assert.equal((await db.query('SELECT * FROM temu_automatic_purchase_checks')).rows.length,0);
});

for(const change of [{status:'api_error',attempt:'old-attempt'},{status:'api_error',packages:['PK-123']},{status:'api_error',blStatus:'unpublished'},{status:'api_error',blStatus:'cancelled'},{status:null,blStatus:'unpublished'},{status:'api_error',archived:true}])test(`discovery excludes ${JSON.stringify(change)}`,async t=>{
 const {db}=await fixture(t,change);
 await temuAutomaticPurchaseWorker(db,{recover(){assert.fail('Ineligible');}},{}).run();
 assert.equal((await db.query('SELECT * FROM temu_automatic_purchase_checks')).rows.length,0);
});

test('independent suspension stays held before any recovery',async t=>{
 const {db}=await fixture(t,{suspension:{active:true,note:'human stop'}});
 await temuAutomaticPurchaseWorker(db,{recover(){assert.fail('Suspended');}},{}).run();
 assert.match((await db.query('SELECT result FROM temu_automatic_purchase_checks')).rows[0]?.result.message,/suspendue/);
});

for(const initial of [null,'api_error'])for(const profit of [2,0,-1,null])test(`${initial??'missing job'}: only fresh positive margin permits one buy, profit ${profit}`,async t=>{
 const {db,reference}=await fixture(t,{status:initial});let purchases=0,marginReads=0;
 const plan={id:'fresh-plan',currency:'EUR',amount:6,selected:1,expiresAt:Date.now()+60000,offers:[{channelId:1,shippingCompanyName:'FedEx'}]};
 const local={async recover(){await db.query(`INSERT INTO temu_label_jobs(reference,status) VALUES($1,'ready') ON CONFLICT(reference) DO UPDATE SET status='ready'`,[reference]);return {status:'ready',plan};},async amounts(){return {};},prepare(){assert.fail('Recovery supplied fresh plan');},async buy(ref,id,amount,{beforeClaim}){const admission=await beforeClaim(plan);assert.equal(admission.allowed,true);purchases++;await db.query(`UPDATE temu_label_jobs SET status='uncertain',attempt_id='preserved-attempt' WHERE reference=$1`,[ref]);return {status:'uncertain',error:'unconfirmed response'};}};
 const margins={async get({fresh}){assert.equal(fresh,true);marginReads++;return {calculatedAt:new Date().toISOString(),rows:[{reference,status:profit===null?'incomplete':profit>0?'positive':'negative',profit,shipping:5,shippingSource:'Devis TEMU final',issues:[]}]};}};
 const worker=temuAutomaticPurchaseWorker(db,local,margins);
 await worker.run();assert.equal(purchases,profit>0?1:0);assert.equal(marginReads,profit>0?2:1);
 if(profit>0)await db.query('UPDATE temu_automatic_purchase_checks SET next_at=now()');
 await worker.run();assert.equal(purchases,profit>0?1:0);
});

for(const recovered of [{status:'pending',documents:true},{status:'document_unavailable',documents:true},{status:'shipment_error',documents:true},{status:'external'},{status:'uncertain'},{status:'deferred',deferred:true,message:'Lecture TEMU en attente'},{status:'api_error',error:'Provider unavailable'}])test(`recovery ${recovered.status} never proceeds to pricing or a purchase`,async t=>{
 const {db}=await fixture(t);
 const local={async recover(){return recovered;},amounts(){assert.fail('No pricing');},prepare(){assert.fail('No second quote');},buy(){assert.fail('No purchase');}};
 await temuAutomaticPurchaseWorker(db,local,{get(){assert.fail('No margin required for recovery');}}).run();
 const result=(await db.query('SELECT result FROM temu_automatic_purchase_checks')).rows[0].result;
 assert.equal(result.status,recovered.deferred||recovered.error?'held':recovered.status);
});
