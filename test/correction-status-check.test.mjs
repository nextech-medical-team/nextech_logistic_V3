import test from 'node:test';import assert from 'node:assert/strict';
import {withoutVerifiedWeight,verifiedWeightBinding,reconcileVerifiedWeights} from '../src/verified-weight-diagnostics.mjs';
import {correctionStatusSnapshot,refreshCorrectionStatuses} from '../src/correction-status-check.mjs';
const binding=()=>({sku:'BT-007-P20G',live_variant_id:'12',verified_at:new Date(Date.now()-1000).toISOString(),product:{id:12,sku:'BT-007-P20G',active:true,weight_amount:5,weight_unit:'g',product:{active:true}}});
test('exact missing/unit stores reconcile but confirmation and stock remain',()=>{
 const sku='BT-007-P20G';
 for(const m of ['Poids non renseigné dans Erplain','Poids manquant','Unité de poids Erplain absente ou non prise en charge']){
  assert.equal(withoutVerifiedWeight(`${sku} : ${m} ; Stock insuffisant`,sku),'Stock insuffisant');
  assert.equal(withoutVerifiedWeight(`Produit restant [${sku}] : ${m}`,sku),`Produit restant [${sku}] : Poids vérifié, remplacement à confirmer`);
 }
 assert.equal(withoutVerifiedWeight('Autre SKU : Poids manquant',sku),'Autre SKU : Poids manquant');assert.equal(withoutVerifiedWeight('Poids manquant',sku),'Poids manquant');assert.equal(withoutVerifiedWeight(null,sku),null);
});
test('proof requires same active variant, explicit amount, recent timestamp',()=>{
 assert.equal(verifiedWeightBinding(binding()),true);
 for(const patch of [{live_variant_id:13},{verified_at:'invalid'},{verified_at:new Date(Date.now()-90000000).toISOString()}])assert.equal(verifiedWeightBinding({...binding(),...patch}),false);
 for(const patch of [{id:13},{sku:'other'},{active:false},{weight_amount:null},{weight_amount:0},{product:{active:false}}])assert.equal(verifiedWeightBinding({...binding(),product:{...binding().product,...patch}}),false);
});
test('snapshot distinguishes correction success from completed business',()=>{
 const o={id:'order',label_status:'blocked',erp_status:'pending',resolution_pending_resume:true,pendingReplacement:true};const x=correctionStatusSnapshot(o,{erpJob:{status:'review',error:'Stock insuffisant'}});
 assert.equal(x.state,'needs_review');assert.equal(x.businessCompleted,false);assert.ok(x.blockers.includes('Stock insuffisant'));assert.ok(x.blockers.includes('Remplacement à confirmer'));assert.equal(o.label_status,'blocked');assert.equal(correctionStatusSnapshot({}).state,'observed');
});
test('coordinator refreshes before snapshot and propagates verification failure',async()=>{
 const calls=[];const db={query:async(sql)=>{calls.push(sql);if(sql.startsWith('SELECT * FROM erplain_product_bindings'))return {rows:[]};if(sql==='SELECT * FROM orders WHERE id=$1')return {rows:[{id:'o',issue:'Adresse incorrecte'}]};return {rows:[]};}};
 const x=await refreshCorrectionStatuses(db,'o');assert.equal(x.state,'needs_review');assert.match(calls[0],/^SELECT \* FROM erplain_product_bindings/);await assert.rejects(refreshCorrectionStatuses({query:async()=>{throw Error('DB failed');}},'o'),/DB failed/);
});
test('replacement review updates are idempotent and preserve business states',async()=>{
 const b=binding(),job={id:'j',action:'equivalent-preview',payload:{replacementSku:'other'},created_at:new Date(Date.now()-5000).toISOString(),updated_at:new Date(Date.now()-5000).toISOString(),error:'Produit restant [BT-007-P20G] : Poids non renseigné dans Erplain'};const writes=[];
 const db={query:async(sql,args)=>{
  if(sql.startsWith('SELECT * FROM erplain_product_bindings'))return {rows:[b]};if(sql.startsWith('SELECT DISTINCT o.id'))return {rows:[{id:'o'}]};if(sql.startsWith('SELECT id,issue'))return {rows:[{id:'o',issue:null,erp_live:{}}]};if(sql.startsWith('SELECT target_sku'))return {rows:[{target_sku:b.sku,source_payload:{erplainSourceVariantId:'12'}}]};if(sql.startsWith('SELECT id,action'))return {rows:[job]};
  if(sql.startsWith('UPDATE resolution_jobs')){writes.push(sql);job.error=args[1];job.updated_at=new Date().toISOString();}return {rows:[]};},transaction:async fn=>fn(db)};
 await reconcileVerifiedWeights(db,null,'o');assert.equal(writes.length,1);assert.match(job.error,/Poids vérifié/);assert.ok(!writes[0].includes('SET status='));await reconcileVerifiedWeights(db,null,'o');assert.equal(writes.length,1);
});
