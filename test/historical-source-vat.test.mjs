import test from 'node:test';import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {sourceVatPlan,alignHistoricalSourceVat,sourceVatResumeEligible,sourceVatError,queueSourceVatReviews,sourceVatResolutionState} from '../src/historical-source-vat.mjs';
function fixture(){
 const line={id:7,type:'normal',quantity:1,price:10,tax_amount:2,discount:null,discount_rule_amount:null,ecotax:null,tax_codes:[{id:'20'}],variant:{id:3},location:{id:4}};
 const bc={id:1,status:'active',external_reference:'PO',update_stock:false,invoices_count:0,paid_amount:0,tax_type:'exclusive',currency:{label:'EUR'},total:12,line_items:[line],shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}}};
 const o={channel:'temu',reference:'PO',erp_live:{phase:'historical_review',bc:{id:1}},pricing:{total:12.1,tax:2.1,currency:'EUR',tax_type:'exclusive',items:[{...structuredClone(line),tax_codes:[{id:'21'}]}]}};
 return {bc,o};
}
test('source VAT changes only existing line prices/codes; quantities and stock policy never enter mutation',()=>{const {bc,o}=fixture(),p=sourceVatPlan(bc,o);assert.deepEqual(p.input,{line_items:[{id:'7',price:10,tax_codes:[{id:'21'}]}]});assert.equal(p.before.line_items[0].tax_codes[0].id,'20');});
test('same source VAT preserves historical price allocation without mutation',()=>{const {bc,o}=fixture();o.pricing.items[0].tax_codes=[{id:'20'}];o.pricing.items[0].price=9.5;assert.equal(sourceVatPlan(bc,o),null);});
test('rejects changed quantities/products/locations, invoices, paid BC, existing BL and incomplete supplier replies',()=>{for(const change of [b=>b.line_items[0].quantity=2,b=>b.line_items[0].variant.id=9,b=>b.line_items[0].location.id=9,b=>b.invoices_count=1,b=>b.paid_amount=1,b=>b.shipping_orders.data=[{id:2}],b=>b.shipping_orders.paginatorInfo.hasMorePages=true,b=>delete b.line_items[0].tax_codes,b=>b.line_items[0].discount=5,b=>b.currency.label='USD']){const {bc,o}=fixture();change(bc);assert.throws(()=>sourceVatPlan(bc,o));}});
test('normal workflow journals before a single mutation and confirms a lost response through read-back',async()=>{
 const {bc,o}=fixture(),events=[];let mutations=0;
 const api={request:async(q,v)=>{if(q.startsWith('mutation')){mutations++;assert.equal(o.erp_live.sourceVatAttempt.status,'uncertain');events.push('mutation');bc.line_items[0].tax_codes=v.input.line_items[0].tax_codes;bc.line_items[0].tax_amount=2.1;bc.total=12.1;throw Error('response lost');}return {Order:structuredClone(bc)};}};
 const hooks={save:async()=>events.push(o.erp_live.sourceVatAttempt.status),guard:async()=>events.push('guard'),preserveLabels:async()=>events.push('labels')};
 assert.equal((await alignHistoricalSourceVat(api,o,hooks)).aligned,true);assert.equal(mutations,1);assert.ok(events.indexOf('labels')<events.indexOf('uncertain'));assert.ok(events.indexOf('uncertain')<events.indexOf('mutation'));assert.equal(o.erp_live.sourceVatAttempt.before.line_items[0].tax_codes[0].id,'20');
 await alignHistoricalSourceVat(api,o,hooks);assert.equal(mutations,1);
});
test('uncertain failed mutation never retries while supplier still shows old VAT',async()=>{const {bc,o}=fixture();let mutations=0;const api={request:async q=>{if(q.startsWith('mutation')){mutations++;throw Error('lost');}return {Order:bc};}},hooks={save:async()=>{},guard:async()=>{},preserveLabels:async()=>{}};await assert.rejects(alignHistoricalSourceVat(api,o,hooks));assert.equal(o.erp_live.sourceVatAttempt.status,'uncertain');await assert.rejects(alignHistoricalSourceVat(api,o,hooks),/aucune réécriture/);assert.equal(mutations,1);});
test('source, mapping or suspension guard failure prevents mutation; completed BL and partial delivery excluded',async()=>{const {bc,o}=fixture();let mutations=0;const api={request:async q=>{if(q.startsWith('mutation'))mutations++;return {Order:bc};}};await assert.rejects(alignHistoricalSourceVat(api,o,{save:async()=>{},preserveLabels:async()=>{},guard:async()=>{throw Error('suspended');}}),/suspended/);assert.equal(mutations,0);for(const patch of [{partial_mode:true},{erp_live:{...o.erp_live,bl:{id:2}}}])assert.equal((await alignHistoricalSourceVat(api,{...o,...patch},{})).skipped,true);});
test('automatic fiscal resume preserves explicit suspensions and uncertain writes; platform shipment alone never blocks',()=>{const {o}=fixture();Object.assign(o,{archived:false,error:sourceVatError});for(const tracking_status of ['shipped','delivered','in_transit'])assert.equal(sourceVatResumeEligible({...o,tracking_status}),true);for(const patch of [{suspension:{active:true}},{partial_mode:true},{error:'another error'},{erp_live:{...o.erp_live,sourceVatAttempt:{status:'uncertain'}}}])assert.equal(sourceVatResumeEligible({...o,...patch}),false);});
test('explicit newer fiscal resume supersedes only a failed, unrecorded stock preview; uncertain and newer choices stay protected',()=>{
 const resume={id:'resume',action:'resume-erp',status:'review',error:sourceVatError,result:{resume:true},created_at:'2026-10-11T01:35:00Z'};
 const preview={id:'old-preview',action:'equivalent-preview',status:'review',result:null,error:'Produit de remplacement : stock insuffisant. Remplacement non enregistré.',created_at:'2026-10-09T08:21:00Z'};
 assert.deepEqual(sourceVatResolutionState([resume,preview]).obsoletePreviewIds,['old-preview']);assert.equal(sourceVatResolutionState([resume,preview]).reviews.length,1);
 for(const patch of [{created_at:'2026-10-11T01:36:00Z'},{created_at:resume.created_at},{result:{}},{error:'Réponse fournisseur incertaine'},{status:'complete',error:null,result:{replacementSku:'OTHER'}}]){
  const state=sourceVatResolutionState([{...preview,...patch},resume]);assert.deepEqual(state.obsoletePreviewIds,[]);assert.ok(state.reviews.length>1||state.pendingReplacement);
 }
 for(const patch of [{result:{}},{error:'autre blocage'},{result:{resume:true,partialRemainder:true}}])assert.deepEqual(sourceVatResolutionState([{...resume,...patch},preview]).obsoletePreviewIds,[]);
});
test('real SQL queue ignores superseded failures, preserves decisions/suspension and deduplicates unchanged source',async()=>{
 const db=new PGlite();db.transaction=fn=>fn(db);
 try{
  await db.exec(`CREATE TABLE orders(id text PRIMARY KEY,channel text DEFAULT 'temu',reference text,archived boolean DEFAULT false,partial_mode boolean DEFAULT false,issue text,source_payload jsonb,erp_live jsonb,resolution_pending_resume boolean DEFAULT false,suspension jsonb DEFAULT '{}',label_status text,tracking_status text);
   CREATE TABLE erp_live_jobs(order_id text,status text,error text,updated_at timestamptz DEFAULT now());
   CREATE TABLE resolution_jobs(id text PRIMARY KEY,order_id text,request_id text UNIQUE,action text,payload jsonb,result jsonb DEFAULT '{}',status text DEFAULT 'queued',error text,created_at timestamptz DEFAULT now());
   CREATE TABLE correction_jobs(id text PRIMARY KEY,order_id text,payload jsonb,status text,created_at timestamptz DEFAULT now());CREATE TABLE audit(user_email text,action text,detail jsonb);`);
  for(const id of ['target','suspended','preview']){
   const {o}=fixture();await db.query('INSERT INTO orders(id,reference,source_payload,erp_live,suspension,tracking_status) VALUES($1,$2,$3,$4,$5,$6)',[id,'PO-'+id,JSON.stringify({temuAmounts:{data:{orderList:[{productTaxRate:21000000}]}}}),JSON.stringify(o.erp_live),JSON.stringify(id==='suspended'?{active:true}:{}),'shipped']);
   await db.query("INSERT INTO erp_live_jobs(order_id,status,error) VALUES($1,'review',$2)",[id,sourceVatError]);
   await db.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,status,error,created_at) VALUES($1,$2,$1,'resume-erp','review','Stock insuffisant',now()-interval '1 hour'),($3,$2,$3,'resume-erp','review',$4,now()-interval '30 minutes')",[id+'-old',id,id+'-current',sourceVatError]);
  }
  await db.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,status,result) VALUES('preview-choice','preview','preview-choice','equivalent-preview','complete','{\"replacementSku\":\"OTHER\"}')");
  await db.query("UPDATE resolution_jobs SET result='{\"resume\":true}' WHERE id='target-current'");
  await db.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,status,result,error,created_at) VALUES('failed-preview','target','failed-preview','equivalent-preview','review',null,'Produit de remplacement : stock insuffisant. Remplacement non enregistré.',now()-interval '2 hours')");
  await db.exec(`INSERT INTO correction_jobs(id,order_id,payload,status,created_at) VALUES('old-correction','target','{"action":"weight"}','review',now()-interval '2 hours'),('new-correction','target','{"action":"weight"}','complete',now()-interval '1 hour');`);
  await queueSourceVatReviews(db);let jobs=(await db.query("SELECT order_id,action FROM resolution_jobs WHERE request_id LIKE 'source-vat-v1-%'")).rows;assert.deepEqual(jobs,[{order_id:'target',action:'resume-erp'}]);
  assert.deepEqual((await db.query("SELECT detail->'obsoletePreviewIds' ids FROM audit")).rows[0].ids,['failed-preview']);assert.equal((await db.query("SELECT status FROM resolution_jobs WHERE id='failed-preview'")).rows[0].status,'review');
  await db.query("UPDATE resolution_jobs SET status='review',error=$1,result='{\"resume\":true}' WHERE request_id LIKE 'source-vat-v1-%'",[sourceVatError]);await queueSourceVatReviews(db);assert.equal((await db.query("SELECT count(*) n FROM resolution_jobs WHERE request_id LIKE 'source-vat-v1-%'")).rows[0].n,1);
  await db.query("UPDATE orders SET source_payload=jsonb_set(source_payload,'{temuAmounts,data,orderList,0,productTaxRate}','22000000') WHERE id='target'");await queueSourceVatReviews(db);assert.equal((await db.query("SELECT count(*) n FROM resolution_jobs WHERE request_id LIKE 'source-vat-v1-%'")).rows[0].n,2);
 }finally{await db.close();}
});
