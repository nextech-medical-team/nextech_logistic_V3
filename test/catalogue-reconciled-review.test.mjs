import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {queueErplainLive} from '../src/erplain-live-workflow.mjs';
import {currentMappingLine} from '../src/current-mapping-line.mjs';

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
