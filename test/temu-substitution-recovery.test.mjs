import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {verifiedSubstitutionPackage,recoverTemuSubstitutionReviews,temuSubstitutionRecoveryError} from '../src/temu-substitution-recovery.mjs';

const order={id:'o',reference:'PO-1-2',channel:'temu',archived:false,erp_live:{bc:{id:'10'},phase:'bc_created'},source_payload:{},tracking_status:'not_shipped'};
const lines=[{source_line:'item',source_sku:'SKU',quantity:20}];
const job={status:'complete',packages:['PK-1'],result:{source:'temu_direct',packageInfoResultList:[{packageSn:'PK-1',orderSendInfoList:[{parentOrderSn:'PO-1-2',orderSn:'item',quantity:20}]}]}};
const documents=[{package:'PK-1',bytes:12}];

test('only a verified whole single package with its PDF permits retry',()=>{
 assert.equal(verifiedSubstitutionPackage(order,job,lines,documents),true);
 for(const status of ['pending','purchasing','uncertain','document_unavailable','shipment_error'])assert.equal(verifiedSubstitutionPackage(order,{...job,status},lines,documents),false);
 for(const packages of [[],['PK-1','PK-2']])assert.equal(verifiedSubstitutionPackage(order,{...job,packages},lines,documents),false);
 assert.equal(verifiedSubstitutionPackage(order,job,lines,[]),false);
 assert.equal(verifiedSubstitutionPackage(order,job,lines,[{package:'PK-1',bytes:0}]),false);
 assert.equal(verifiedSubstitutionPackage(order,job,[{...lines[0],quantity:19}],documents),false);
 for(const patch of [{archived:true},{partial_mode:true},{suspension:{active:true}},{tracking_status:'shipped'},{label_status:'cancelled'},{source_payload:{marketplacePendingCorrection:{}}},{erp_live:{bc:{id:'10'},bl:{id:'20'}}}])assert.equal(verifiedSubstitutionPackage({...order,...patch},job,lines,documents),false);
});

test('recovery verifies a pre-write failure once, preserves quantities and never replays a confirmation',async()=>{
 const pg=new PGlite();await pg.waitReady;
 const wrap=e=>({query:(...args)=>e.query(...args)}),db={...wrap(pg),transaction:f=>pg.transaction(tx=>f(wrap(tx)))};
 try{
  await pg.exec(`CREATE TABLE orders(id text,reference text,channel text,archived boolean,erp_live jsonb,source_payload jsonb,tracking_status text);
   CREATE TABLE temu_label_jobs(reference text,status text,packages jsonb,result jsonb,error text);
   CREATE TABLE lines(order_id text,source_line text,source_sku text,quantity numeric);
   CREATE TABLE temu_label_documents(reference text,package text,pdf bytea);
   CREATE TABLE resolution_jobs(id text,order_id text,request_id text,action text,status text,payload jsonb,result jsonb,error text,stage text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
   CREATE TABLE correction_jobs(order_id text,status text);CREATE TABLE erp_live_jobs(order_id text,status text);CREATE TABLE carrier_jobs(order_id text);
   CREATE TABLE audit(user_email text,action text,detail jsonb);`);
  await db.query('INSERT INTO orders VALUES($1,$2,$3,false,$4,$5,$6)',[order.id,order.reference,order.channel,JSON.stringify(order.erp_live),'{}',order.tracking_status]);
  await db.query('INSERT INTO temu_label_jobs VALUES($1,$2,$3,$4,null)',[order.reference,job.status,JSON.stringify(job.packages),JSON.stringify(job.result)]);
  await db.query("INSERT INTO lines VALUES('o','item','SKU',20)");
  await db.query('INSERT INTO temu_label_documents VALUES($1,$2,$3)',[order.reference,'PK-1',Buffer.from('existing PDF')]);
  const payload={id:'o',sku:'SKU',replacementSku:'OTHER',replaceQuantity:20,replacementQuantity:40,scope:'order',confirmEquivalent:true,previewFingerprint:'a'.repeat(64)};
  await db.query("INSERT INTO resolution_jobs(id,order_id,action,status,payload,error) VALUES('r','o','replace-equivalent','review',$1,$2)",[JSON.stringify(payload),temuSubstitutionRecoveryError]);
  const before={};for(const table of ['orders','lines','temu_label_jobs','temu_label_documents'])before[table]=(await db.query('SELECT * FROM '+table)).rows;
  await db.query("INSERT INTO erp_live_jobs VALUES('o','processing')");assert.equal(await recoverTemuSubstitutionReviews(db,order.reference),0);await db.query('DELETE FROM erp_live_jobs');
  await db.query("UPDATE resolution_jobs SET payload=payload||'{\"substitutionAttempt\":{}}'::jsonb");assert.equal(await recoverTemuSubstitutionReviews(db,order.reference),0);
  await db.query("UPDATE resolution_jobs SET payload=payload-'substitutionAttempt'");
  assert.equal(await recoverTemuSubstitutionReviews(db,order.reference),1);
  assert.equal(await recoverTemuSubstitutionReviews(db,order.reference),0);
  const retried=(await db.query("SELECT * FROM resolution_jobs WHERE id<>'r'")).rows[0];assert.equal(retried.status,'queued');assert.equal(retried.error,null);assert.equal(retried.action,'equivalent-preview');
  assert.equal(retried.payload.replaceQuantity,20);assert.equal(retried.payload.replacementQuantity,40);assert.equal(retried.payload.confirmEquivalent,undefined);assert.equal(retried.payload.previewFingerprint,undefined);
  assert.deepEqual((await db.query("SELECT payload FROM resolution_jobs WHERE id='r'")).rows[0].payload,payload);
  for(const table of Object.keys(before))assert.deepEqual((await db.query('SELECT * FROM '+table)).rows,before[table]);
  assert.equal((await db.query('SELECT * FROM audit')).rows.length,1);
  await db.query("UPDATE resolution_jobs SET status='review',error='Stock insuffisant'");assert.equal(await recoverTemuSubstitutionReviews(db,order.reference),0);
 }finally{await pg.close();}
});
