import test from 'node:test';
import assert from 'node:assert/strict';
import {batchDiagnosticOnly,batchContinuationFingerprint} from '../src/batch-continuation.mjs';
import {validateResolution} from '../src/problem-resolution.mjs';

const error='BL · Lot de traçabilité Erplain · SKU : numéro de lot absent dans Erplain — création BL bloquée';
const order={id:'o',erp_live:{bc:{line_items:[{type:'normal',variant:{id:'1',sku:'SKU'}}]}}};
const db={query:async()=>({rows:[{status:'review',error}]})};
function provider({enabled=true,batches=[{id:'7',variant_id:'1',label:'LOT-1'}],fail=false}={}){
 return {async request(query){assert.match(query,/^query /);if(fail)throw Error('Erplain HTTP 429');return query.includes('V3BlBatchVariant')?{Variant:{id:'1',sku:'SKU',has_batch_numbers:enabled}}:{BatchNumbers:{data:batches,paginatorInfo:{hasMorePages:false}}};}};
}
test('only complete lot diagnostics qualify; independent errors are preserved',async()=>{
 assert.equal(batchDiagnosticOnly(error),true);
 assert.equal(batchDiagnosticOnly(error+' ; '+error),true);
 for(const value of [null,'',error+' ; Adresse invalide','Adresse invalide'])assert.equal(batchDiagnosticOnly(value),false);
 const untouched={request:()=>assert.fail('No Erplain read for unrelated errors')};
 assert.equal(await batchContinuationFingerprint({query:async()=>({rows:[{status:'review',error:'Adresse invalide'}]})},untouched,order),null);
 assert.equal(await batchContinuationFingerprint({query:async()=>({rows:[{status:'processing',error}]})},untouched,order),null);
});
test('corrected lot changes stable continuation identity; repeated reads stay idempotent',async()=>{
 const before=await batchContinuationFingerprint(db,provider(),order);
 assert.match(before,/^[a-f0-9]{64}$/);
 assert.equal(await batchContinuationFingerprint(db,provider(),order),before);
 assert.notEqual(await batchContinuationFingerprint(db,provider({batches:[{id:'8',variant_id:'1',label:'LOT-2'}]}),order),before);
});
test('missing, disabled, cross-variant and failed reads cannot admit a continuation',async()=>{
 for(const config of [{enabled:false},{batches:[]},{batches:[{id:'7',variant_id:'2',label:'WRONG'}]},{fail:true}]){
  await assert.rejects(()=>batchContinuationFingerprint(db,provider(config),order),config.fail?/Erplain HTTP 429/:/création BL bloquée/);
 }
});
test('lot dialog and previously loaded refresh button submit supported actions',()=>{
 for(const action of ['resume-erp','refresh']){
  const request={id:'o',requestId:'11111111-1111-4111-8111-111111111111',action,type:'batch',sku:'20 100 78',resumeAfter:true,...(action==='refresh'?{provider:'Erplain'}:{})};
  assert.deepEqual(validateResolution(request),request);
 }
 assert.throws(()=>validateResolution({id:'o',requestId:'11111111-1111-4111-8111-111111111111',action:'force-stock-label',type:'batch'}),/incompatible/);
});
