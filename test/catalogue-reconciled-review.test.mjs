import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {queueErplainLive} from '../src/erplain-live-workflow.mjs';
import {currentMappingLine} from '../src/current-mapping-line.mjs';
import {resumeAuditedCatalogueReviews} from '../src/catalogue-reconciled-review.mjs';

async function fixture(){
 const e=new PGlite();await e.waitReady;
 const wrap=x=>({query:(s,p=[])=>x.query(s,p)}),db={...wrap(e),transaction:f=>e.transaction(tx=>f(wrap(tx)))};
 await e.exec(`CREATE TABLE orders(id text PRIMARY KEY,reference text DEFAULT 'PO-EXAMPLE',channel text DEFAULT 'temu',archived boolean DEFAULT false,suspension jsonb DEFAULT '{}',partial_mode boolean DEFAULT false,erp_live jsonb DEFAULT '{}',source_payload jsonb DEFAULT '{}',resolution_pending_resume boolean DEFAULT false,label_status text DEFAULT 'blocked',tracking_status text DEFAULT 'not_shipped',issue text,duplicate_of text,simulation boolean DEFAULT false);
 CREATE TABLE erp_live_jobs(order_id text PRIMARY KEY,status text DEFAULT 'pending',error text,updated_at timestamptz DEFAULT now());
 CREATE TABLE lines(id text,order_id text,source_sku text,target_sku text,target_quantity numeric,quantity numeric,source_payload jsonb DEFAULT '{}');
 CREATE TABLE mappings(channel text,source_sku text,target_sku text,source_qty numeric,target_qty numeric);
 CREATE TABLE audit(user_email text,action text,detail jsonb,created_at timestamptz DEFAULT now());
 CREATE TABLE erplain_product_bindings(sku text PRIMARY KEY,live_variant_id text,product jsonb);
 CREATE TABLE erplain_product_creation_attempts(sku text,status text,product_id text,variant_id text);
 CREATE TABLE resolution_jobs(order_id text,status text);CREATE TABLE correction_jobs(order_id text,status text);CREATE TABLE carrier_jobs(order_id text,status text);
 INSERT INTO orders(id) VALUES('o');INSERT INTO erp_live_jobs VALUES('o','review',null,'2026-10-09T18:16:26.916166Z');
 INSERT INTO lines(id,order_id,source_sku,quantity) VALUES('l','o','IDE82311430',2);
 INSERT INTO mappings VALUES('temu','IDE82311430','IDE82311430',1,30);
 INSERT INTO erplain_product_bindings VALUES('IDE82311430','2899561','{"id":2899561,"sku":"IDE82311430","active":true,"product":{"id":2009197,"active":true}}');
 INSERT INTO erplain_product_creation_attempts VALUES('IDE82311430','verified','2009197','2899561');`);
 const proof={sku:'IDE82311430',status:'active',complete:true,sourceReadOnly:true,variantId:'2899561',productId:'2009197',documentId:null,readAt:'2026-10-11T14:45:27.536Z'};
 const detail={orderId:'o',proof,preparationChanged:false,retired:[{scope:'erp',previousMessage:'Création produit · Nom de la référence convertie à confirmer : IDE82311430',previousUpdatedAt:'2026-10-09T18:16:26.916Z',proof}]};
 await e.query("INSERT INTO audit VALUES('system','diagnostic.catalogue_lookup_reconciled',$1,now())",[JSON.stringify(detail)]);
 return {e,db,detail,changeAudit:()=>e.query('UPDATE audit SET detail=$1',[JSON.stringify(detail)])};
}

test('explicit preparation resumes the audited 2-pack/60-unit historical job once, with no business writes',async()=>{
 const f=await fixture();try{
  const before=(await f.e.query('SELECT * FROM orders')).rows;
  assert.equal(await queueErplainLive(f.db,['o']),1);assert.equal(await queueErplainLive(f.db,['o']),0);
  assert.equal((await f.e.query('SELECT status FROM erp_live_jobs')).rows[0].status,'pending');
  assert.deepEqual((await f.e.query('SELECT * FROM orders')).rows,before);
  assert.deepEqual(currentMappingLine({source_sku:'IDE82311430',mapped_sku:'IDE82311430',quantity:2,source_qty:1,target_qty:30},'temu'),{sku:'IDE82311430',quantity:60});
  const audit=(await f.e.query("SELECT detail FROM audit WHERE action='erplain.reconciled_catalogue_review_resumed'")).rows;
  assert.equal(audit.length,1);assert.equal(audit[0].detail.providerReplay,false);assert.equal(audit[0].detail.explicitPreparationRequest,true);
 }finally{await f.e.close();}
});

for(const [name,sql] of Object.entries({
 noProof:'DELETE FROM audit',unrelatedError:"UPDATE erp_live_jobs SET error='TimeoutError'",unknownNullReview:"UPDATE audit SET action='other'",newReview:"UPDATE erp_live_jobs SET updated_at='2026-10-12T00:00:00Z'",
 wrongBinding:"UPDATE erplain_product_bindings SET live_variant_id='999'",inactiveProduct:"UPDATE erplain_product_bindings SET product=jsonb_set(product,'{active}','false')",changedMapping:"UPDATE mappings SET target_sku='OTHER'",invalidRatio:'UPDATE mappings SET source_qty=0',uncertainCreation:"UPDATE erplain_product_creation_attempts SET status='review'",wrongCreatedIdentity:"UPDATE erplain_product_creation_attempts SET variant_id='999'",
 suspended:"UPDATE orders SET suspension='{\"active\":true}'",cancellationMarker:"UPDATE orders SET suspension='{\"erplainCancellation\":null}'",archived:'UPDATE orders SET archived=true',partial:'UPDATE orders SET partial_mode=true',held:'UPDATE orders SET resolution_pending_resume=true',visibilityHold:"UPDATE orders SET source_payload='{\"visibilityHold\":true}'",validationHold:"UPDATE orders SET source_payload='{\"erplainValidationHold\":true}'",pendingCorrection:"UPDATE orders SET source_payload='{\"marketplacePendingCorrection\":{}}'",oldIssue:"UPDATE orders SET issue='Stock insuffisant'",customer:"UPDATE orders SET erp_live='{\"customer\":{\"id\":\"existing\"}}'",phase:"UPDATE orders SET erp_live='{\"phase\":\"creating_bc\"}'",bc:"UPDATE orders SET erp_live='{\"bc\":{\"id\":\"bc\"}}'",bl:"UPDATE orders SET erp_live='{\"bl\":{\"id\":\"bl\"}}'",stockAttempt:"UPDATE orders SET erp_live='{\"stockCreationAttemptedAt\":\"2026-10-10\"}'",shipped:"UPDATE orders SET tracking_status='shipped'",simulation:'UPDATE orders SET simulation=true',duplicate:"UPDATE orders SET duplicate_of='other'",resolution:"INSERT INTO resolution_jobs VALUES('o','review')",carrier:"INSERT INTO carrier_jobs VALUES('o','awaiting_pdf')",correction:"INSERT INTO correction_jobs VALUES('o','applying')"
}))test('retains review and preserves business data: '+name,async()=>{const f=await fixture();try{
 await f.e.exec(sql);const before=(await f.e.query('SELECT * FROM orders')).rows;
 assert.equal(await queueErplainLive(f.db,['o']),0);assert.equal((await f.e.query('SELECT status FROM erp_live_jobs')).rows[0].status,'review');
 assert.deepEqual((await f.e.query('SELECT * FROM orders')).rows,before);assert.equal((await f.e.query("SELECT * FROM audit WHERE action='erplain.reconciled_catalogue_review_resumed'")).rows.length,0);
}finally{await f.e.close();}});

for(const name of ['wrongScope','unrelatedRetiredError','wrongTimestamp','incompleteProof','wrongSku','oldRead','missingRead','futureRead'])test('rejects unqualified audit proof: '+name,async()=>{const f=await fixture();try{
 if(name==='wrongScope')f.detail.retired[0].scope='resolution';if(name==='unrelatedRetiredError')f.detail.retired[0].previousMessage='API indisponible';if(name==='wrongTimestamp')f.detail.retired[0].previousUpdatedAt='2026-10-08T18:16:26.916Z';if(name==='incompleteProof')f.detail.proof.complete=false;if(name==='wrongSku')f.detail.proof.sku='OTHER';if(name==='oldRead')f.detail.proof.readAt='2026-10-08T00:00:00Z';if(name==='missingRead')delete f.detail.proof.readAt;if(name==='futureRead')f.detail.proof.readAt='2099-01-01T00:00:00Z';
 await f.changeAudit();assert.equal(await queueErplainLive(f.db,['o']),0);
}finally{await f.e.close();}});

test('known catalogue absence may also resume after its own exact reconciliation',async()=>{const f=await fixture();try{f.detail.retired[0].previousMessage='BC · SKU Erplain LIVE introuvable : IDE82311430';await f.changeAudit();assert.equal(await queueErplainLive(f.db,['o']),1);}finally{await f.e.close();}});

test('unknown tracking resumes only the audited local catalogue refusal, with no uncertain label attempt',async()=>{const f=await fixture();try{
 await f.e.exec("UPDATE orders SET tracking_status='unknown'");
 // Legacy name and customer errors still require not_shipped.
 for(const error of ['Client TEMU : numéro Erplain non reçu','Création produit · Nom du produit manquant ou invalide : IDE82311430']){await f.e.query('UPDATE erp_live_jobs SET error=$1',[error]);assert.equal(await queueErplainLive(f.db,['o']),0);}
 await f.e.exec('UPDATE erp_live_jobs SET error=NULL');
 for(const tracking of ['shipped','delivered','in_transit','delivered_simulated','cancelled',null,'']){await f.e.query('UPDATE orders SET tracking_status=$1',[tracking]);assert.equal(await queueErplainLive(f.db,['o']),0);}
 await f.e.exec("UPDATE orders SET tracking_status='unknown',source_payload='{\"temuDirect\":{\"attemptedAt\":\"2026-10-10T10:00:00Z\"}}'");assert.equal(await queueErplainLive(f.db,['o']),0);
 await f.e.exec("UPDATE orders SET source_payload='{}'");assert.equal(await queueErplainLive(f.db,['o']),1);assert.equal(await queueErplainLive(f.db,['o']),0);
 assert.equal((await f.e.query('SELECT tracking_status FROM orders')).rows[0].tracking_status,'unknown');
}finally{await f.e.close();}});

test('automatic worker resumes the exact historical catalogue case once for every indicative TEMU status',async()=>{
 const f=await fixture();try{
  const original=(await f.e.query('SELECT * FROM orders')).rows[0];
  for(const status of [1,2,3,4,5,99,null]){
   await f.e.exec("UPDATE erp_live_jobs SET status='review',error=null,updated_at='2026-10-09T18:16:26.916166Z'");
   await f.e.query('UPDATE orders SET source_payload=$1',[JSON.stringify({temuDirect:{status},temuOrderDetail:{parentOrderMap:{parentOrderStatus:status}},platformStatusObservation:{indicative:true,status}})]);
   const before=(await f.e.query('SELECT * FROM orders')).rows;
   assert.deepEqual(await resumeAuditedCatalogueReviews(f.db),{resumed:1,checked:1,afterId:'o',providerWrites:0});
   assert.equal((await resumeAuditedCatalogueReviews(f.db)).resumed,0);
   assert.deepEqual((await f.e.query('SELECT * FROM orders')).rows,before);
  }
  const events=(await f.e.query("SELECT detail FROM audit WHERE action='erplain.reconciled_catalogue_review_resumed'")).rows;
  assert.equal(events.length,7);assert.ok(events.every(a=>a.detail.automaticRecovery===true&&a.detail.explicitPreparationRequest===false&&a.detail.providerReplay===false));
  assert.equal((await f.e.query('SELECT erp_live FROM orders')).rows[0].erp_live.phase,original.erp_live.phase);
 }finally{await f.e.close();}
});

test('automatic admission preserves operational holds, unknown reviews, provider attempts and AO scope',async()=>{
 const f=await fixture();try{
  const changes=["channel='tender'","channel='samples'","suspension='{\"active\":true}'","suspension='{\"erplainCancellation\":null}'","resolution_pending_resume=true","erp_live='{\"phase\":\"creating_customer\"}'","erp_live='{\"bl\":{\"id\":1}}'","source_payload='{\"temuDirect\":{\"attemptedAt\":\"2026-10-11\"}}'","tracking_status='shipped'","tracking_status='delivered'","tracking_status='cancelled'","label_status='cancelled'","issue='Stock insuffisant'","duplicate_of='another'"];
  for(const sql of changes){
   await f.e.exec("UPDATE orders SET channel='temu',suspension='{}',resolution_pending_resume=false,erp_live='{}',source_payload='{}',tracking_status='not_shipped',label_status='blocked',issue=null,duplicate_of=null");
   await f.e.exec('UPDATE orders SET '+sql);
   assert.equal((await resumeAuditedCatalogueReviews(f.db)).resumed,0,sql);
  }
  await f.e.exec("UPDATE orders SET duplicate_of=null;DELETE FROM audit");
  assert.equal((await resumeAuditedCatalogueReviews(f.db)).resumed,0);
  assert.equal((await f.e.query('SELECT status FROM erp_live_jobs')).rows[0].status,'review');
  await assert.rejects(resumeAuditedCatalogueReviews(f.db,{limit:0}),/invalide/);
 }finally{await f.e.close();}
});

test('bounded automatic scan rotates past rejected histories without altering their review timestamps',async()=>{
 const f=await fixture();try{
  await f.e.exec(`INSERT INTO orders(id) SELECT 'a'||lpad(n::text,2,'0') FROM generate_series(1,30) n;
   INSERT INTO erp_live_jobs SELECT id,'review',null,'2026-10-09T00:00:00Z' FROM orders WHERE id<>'o';
   INSERT INTO audit(user_email,action,detail) SELECT 'system','diagnostic.catalogue_lookup_reconciled',jsonb_build_object('orderId',id) FROM orders WHERE id<>'o';`);
  const before=(await f.e.query("SELECT * FROM erp_live_jobs WHERE order_id<>'o' ORDER BY order_id")).rows;
  const first=await resumeAuditedCatalogueReviews(f.db);assert.equal(first.checked,25);assert.equal(first.resumed,0);
  const second=await resumeAuditedCatalogueReviews(f.db,{afterId:first.afterId});assert.equal(second.resumed,1);assert.equal(second.checked,25);
  assert.deepEqual((await f.e.query("SELECT * FROM erp_live_jobs WHERE order_id<>'o' ORDER BY order_id")).rows,before);
  assert.equal((await resumeAuditedCatalogueReviews(f.db,{afterId:second.afterId})).resumed,0);
 }finally{await f.e.close();}
});
