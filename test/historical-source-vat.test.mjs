import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {sourceVatPlan,alignHistoricalSourceVat,sourceVatResumeEligible,sourceVatError,queueSourceVatReviews,sourceVatResolutionState} from '../src/historical-source-vat.mjs';
const order=channel=>({id:'o',channel,reference:'REF',archived:false,error:sourceVatError,erp_live:{phase:'historical_review',bc:{id:'1'}},pricing:{items:[{quantity:999,price:999,tax_codes:[{id:'SOURCE'}]}]}});
for(const channel of ['temu','shopify','amazon'])test(channel+' existing BC cannot be realigned from marketplace VAT, prices or quantities',async()=>{
 const o=order(channel),before=structuredClone(o),api={request:()=>assert.fail('No provider read or mutation for source alignment')};
 assert.equal(sourceVatPlan({},o),null);assert.equal(sourceVatResumeEligible(o),false);
 const r=await alignHistoricalSourceVat(api,o,{save:()=>assert.fail('No rewrite'),guard:()=>assert.fail('No source guard'),preserveLabels:()=>assert.fail('No label rewrite')});
 assert.equal(r.sourceAlignmentDisabled,true);assert.deepEqual(o,before);
});
test('post-BC uncertain source VAT attempt is preserved without replay',async()=>{
 const o=order('temu');o.erp_live.sourceVatAttempt={status:'uncertain',requestedAt:'2026-10-10T00:00:00Z'};
 await assert.rejects(alignHistoricalSourceVat({request:()=>assert.fail('Uncertain write cannot be replayed')},o,{}),/incertaine/);
 assert.equal(o.erp_live.sourceVatAttempt.status,'uncertain');
});
test('SQL source VAT scan does not queue a marketplace comparison for existing BC',async()=>{
 const db=new PGlite();try{
 await db.exec(`CREATE TABLE orders(id text,channel text,reference text,archived boolean DEFAULT false,partial_mode boolean DEFAULT false,issue text,source_payload jsonb DEFAULT '{}',erp_live jsonb,resolution_pending_resume boolean DEFAULT false,suspension jsonb DEFAULT '{}');
 CREATE TABLE erp_live_jobs(order_id text,status text,error text,updated_at timestamptz DEFAULT now());
 CREATE TABLE resolution_jobs(id text,order_id text,request_id text,action text,status text,error text,payload jsonb,result jsonb,created_at timestamptz DEFAULT now());
 CREATE TABLE correction_jobs(id text,order_id text,status text,payload jsonb,created_at timestamptz DEFAULT now());
 INSERT INTO orders(id,channel,reference,erp_live) VALUES('o','temu','REF','{"phase":"historical_review","bc":{"id":"1"}}');`);
 await db.query("INSERT INTO erp_live_jobs(order_id,status,error) VALUES('o','review',$1)",[sourceVatError]);
 await queueSourceVatReviews(db);assert.equal((await db.query('SELECT count(*)::int n FROM resolution_jobs')).rows[0].n,0);
 }finally{await db.close();}
});
test('explicit newer decisions retain unrelated and uncertain historical interventions',()=>{
 const resume={id:'resume',action:'resume-erp',status:'review',error:sourceVatError,result:{resume:true},created_at:'2026-10-11T01:35:00Z'};
 const unknown={id:'old',action:'equivalent-preview',status:'review',result:null,error:'Réponse fournisseur incertaine',created_at:'2026-10-09T01:00:00Z'};
 assert.deepEqual(sourceVatResolutionState([resume,unknown]).obsoletePreviewIds,[]);
});
