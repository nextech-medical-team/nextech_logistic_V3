import test from 'node:test';
import assert from 'node:assert/strict';
import {recordedBcItems,recordedBcPricing,verifyRecordedOrSourceTotals,withRecordedOrSourceGuard,readRecordedBc} from '../src/existing-bc-execution.mjs';
const order=channel=>({channel,reference:'REF',erp_live:{bc:{id:'1'},pricing:{total:999,tax:777,currency:'USD'}},source_payload:{temuAmountsError:'API unavailable',temuOrderDetail:{orderList:[{quantity:999,sku:'SOURCE'}]}}});
const document=()=>({id:'1',status:'active',total:12,currency:{id:'2',label:'EUR'},tax_type:'exclusive',line_items:[{type:'normal',quantity:2,price:5,tax_amount:2,variant:{id:'10',sku:'BC-SKU'},location:{id:'20'}}]});
for(const channel of ['temu','shopify','amazon'])test(channel+' recorded BC ignores differing or absent marketplace amounts and lines',async()=>{
 const o=order(channel),bc=document();let evaluated=false;
 const proof=await verifyRecordedOrSourceTotals({},o,bc,()=>{evaluated=true;throw Error('Marketplace must not be read');});
 assert.equal(evaluated,false);assert.equal(proof.total,12);assert.equal(proof.authority,'recorded_erplain_bc');
 assert.deepEqual(recordedBcItems(bc).map(l=>[l.variant.id,l.quantity]),[['10',2]]);
});
test('stock execution guard performs one BC read, never evaluates marketplace source',async()=>{
 const o=order('temu'),queries=[];let run=0;
 const result=await withRecordedOrSourceGuard({request:async(q,v)=>{queries.push([q,v]);return {Order:document()};}},o,()=>assert.fail('Source requested'),()=>++run);
 assert.equal(result,1);assert.equal(run,1);assert.equal(queries.length,1);assert.match(queries[0][0],/^query V3RecordedBcBeforeExecution/);
});
test('before BC, original source validation remains required',async()=>{
 const o={channel:'shopify',erp_live:{}};let called=0;
 await assert.rejects(verifyRecordedOrSourceTotals({},o,document(),()=>{called++;return {total:500,tax:2,currency:'EUR'};}),/différent/);
 assert.equal(called,1);
});
test('BC reader uses ID and Erplain items rather than marketplace product bindings',async()=>{
 let reads=0;const o=order('amazon');
 const result=await readRecordedBc({request:async(q,v)=>{reads++;assert.deepEqual(v,{id:'1'});assert.match(q,/Order\(id:\$id\)/);return {Order:document()};}},o);
 assert.equal(reads,1);assert.equal(result.items[0].variant.sku,'BC-SKU');assert.equal(result.pricing.items[0].quantity,2);
});
for(const kind of ['cancelled','wrong-id','missing-location','nonfinite-quantity'])test('real document error remains protected: '+kind,()=>{
 const bc=document();if(kind==='cancelled')bc.status='cancelled';if(kind==='wrong-id')bc.id='other';if(kind==='missing-location')delete bc.line_items[0].location;if(kind==='nonfinite-quantity')bc.line_items[0].quantity='bad';
 assert.throws(()=>{recordedBcPricing(order('shopify'),bc);recordedBcItems(bc);},/BC enregistré/);
});

import {retiredRecordedBcSourceReview} from '../src/existing-bc-execution.mjs';
import {currentResolutionState} from '../src/historical-preparation-completion.mjs';
test('retired source review no longer blocks while history and independent review remain',()=>{
 const job={action:'resume-erp',status:'review',error:null,result:{bcComparisonRefresh:{previousError:'BC · Produits ou quantités des lignes Erplain différents de la source',currentError:null,proof:{authority:'recorded_bc',readOnly:true,preparationNotStarted:true,bcId:'1',comparison:{scope:'full',different:false},errors:[],mappingFingerprint:'a'.repeat(64),checkedAt:new Date().toISOString()}}}};
 const stock={action:'stock',status:'review',error:'Stock insuffisant'},before=structuredClone(job);
 assert.equal(retiredRecordedBcSourceReview(job),true);assert.deepEqual(currentResolutionState([job,stock]).reviews,[stock]);assert.deepEqual(job,before);
 for(const patch of [{authority:'source'},{comparison:{scope:'partial',different:false}},{errors:[{code:'local_bl_missing'}]},{identityUnconfirmed:true},{bcId:'0'},{readOnly:false}]){
  const invalid=structuredClone(job);Object.assign(invalid.result.bcComparisonRefresh.proof,patch);
  assert.equal(retiredRecordedBcSourceReview(invalid),false);assert.equal(currentResolutionState([invalid]).reviews.length,1);
 }
 const independent=structuredClone(job);independent.result.bcComparisonRefresh.previousError+=' ; Stock insuffisant';
 assert.equal(retiredRecordedBcSourceReview(independent),false);
});
