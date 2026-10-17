import test from 'node:test';import assert from 'node:assert/strict';
import {businessWeight,fillMissingVariantWeight} from '../src/weight-business-policy.mjs';
import {erplainWeightKg,resolveWeight} from '../src/erplain-readonly.mjs';
import {selectedProductWeights} from '../src/selected-product-weights.mjs';
import {weightUnitProof,reconcileUnitMessage} from '../src/weight-unit-diagnostics.mjs';
const variant=(amount,unit)=>({id:42,sku:'SKU',active:true,product:{id:7,active:true},weight_amount:amount,weight_unit:unit});
test('explicit kg preserved; every absent or unknown unit is grams',()=>{
 for(const unit of ['kg',' KG ','Kg'])assert.equal(erplainWeightKg(0.12,unit),0.12);
 for(const unit of ['g',null,undefined,'',' ','lb','oz','grammes','nonsense',12,{},[]])assert.equal(erplainWeightKg(120,unit),0.12);
});
test('missing values consistently default to 5 g; existing small positive weights stay intact',()=>{
 for(const amount of [null,undefined,'','  '])for(const unit of ['kg','g','lb',null])assert.equal(erplainWeightKg(amount,unit),0.005);
 assert.equal(erplainWeightKg(0.1,'g'),0.0001);assert.equal(erplainWeightKg(0.6,''),0.0006);
 assert.deepEqual(businessWeight(null,'kg'),{weightKg:0.005,defaulted:true,unit:'g'});
});
test('malformed numeric weights remain explicit errors, never silently overwritten',()=>{
 for(const amount of [0,-1,Infinity,NaN,'bad',true,{},[]])assert.throws(()=>erplainWeightKg(amount,'g'),/Poids unitaire invalide/);
});
test('selected BC variant and quantities use the shared policy without changing source data',()=>{
 const v=variant(null,null),snapshot=structuredClone(v);
 const plan=selectedProductWeights([{id:'line',target_sku:'SKU',target_quantity:22}],{SKU:v},[{variant:{id:42},quantity:22}]);
 assert.equal(plan.weightKg,0.11);assert.deepEqual(plan.missing,[]);assert.deepEqual(v,snapshot);
 assert.equal(resolveWeight([variant(10,'unsupported')],'SKU').weightKg,0.01);
 assert.throws(()=>selectedProductWeights([{id:'line',target_sku:'SKU',target_quantity:22}],{SKU:v},[{variant:{id:999},quantity:22}]),/Variante|variante/);
});
test('old unit diagnostic is cleared, independent stock errors and replacement confirmation remain',()=>{
 const proof=weightUnitProof(variant(null,null),'SKU');assert.equal(proof.weightKg,0.005);
 assert.equal(reconcileUnitMessage('SKU · Unité de poids Erplain absente ou non prise en charge ; Stock insuffisant',proof),'Stock insuffisant');
 assert.match(reconcileUnitMessage('Produit équivalent [SKU] : Unité de poids Erplain absente ou non prise en charge',proof),/remplacement à confirmer/);
});
function apiMock(before,after=variant(5,'g'),error=null){const calls=[];let reads=0;return {calls,async request(q,args){calls.push({q,args});if(q.startsWith('mutation')){if(error)throw error;return {UpdateVariant:{id:42}};}return {Variant:reads++?after:before};}};}
test('API fills only missing variant, journals before write and verifies persistent grams',async()=>{
 const api=apiMock(variant(null,null)),states=[];
 const result=await fillMissingVariantWeight(api,{id:42,sku:'SKU',productId:7},{checkpoint:async r=>states.push(r.state)});
 assert.equal(result.changed,true);assert.deepEqual(states,['submitting','verified']);
 assert.deepEqual(api.calls[1].args.input,{weight_amount:5,weight_unit:'g'});assert.equal(api.calls.length,3);
});
test('API preserves every existing weight, rejects wrong identities and requires durable journal',async()=>{
 for(const before of [variant(0.1,'g'),variant(0.05,'kg'),variant(0,'g')]){
  const api=apiMock(before);assert.equal((await fillMissingVariantWeight(api,{id:42,sku:'SKU'},{checkpoint:async()=>{}})).changed,false);assert.equal(api.calls.length,1);
 }
 for(const before of [{...variant(null,null),id:999},{...variant(null,null),active:false},{...variant(null,null),sku:'OTHER'}]){
  const api=apiMock(before);await assert.rejects(fillMissingVariantWeight(api,{id:42,sku:'SKU'},{checkpoint:async()=>{}}),/Identité/);assert.equal(api.calls.length,1);
 }
 await assert.rejects(fillMissingVariantWeight(apiMock(variant(null,null)),{id:42,sku:'SKU'}),/journal/);
});
test('uncertain mutation or unconfirmed relecture is journalled and never retried',async()=>{
 for(const api of [apiMock(variant(null,null),variant(5,'g'),Error('timeout')),apiMock(variant(null,null),variant(null,null))]){
  const states=[];await assert.rejects(fillMissingVariantWeight(api,{id:42,sku:'SKU'},{checkpoint:async r=>states.push(r.state)}));
  assert.deepEqual(states,['submitting','uncertain']);assert.equal(api.calls.filter(c=>c.q.startsWith('mutation')).length,1);
 }
 const api=apiMock(variant(null,null));await assert.rejects(fillMissingVariantWeight(api,{id:42,sku:'SKU'},{checkpoint:async()=>{throw Error('journal unavailable');}}));assert.equal(api.calls.length,1);
});
for(const field of ['weight_amount','weight_unit'])test('omitted provider field is not proof of a missing weight: '+field,async()=>{const v=variant(null,null);delete v[field];const api=apiMock(v);await assert.rejects(fillMissingVariantWeight(api,{id:42,sku:'SKU'},{checkpoint:async()=>{}}),/incomplète/);assert.equal(api.calls.some(c=>c.q.startsWith('mutation')),false);});
