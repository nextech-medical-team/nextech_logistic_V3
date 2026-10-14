import test from 'node:test';
import assert from 'node:assert/strict';
import {canRetryFailedCarrier,provesLegacyPreflight,markCarrierCreationStarted} from '../src/carrier-attempt-proof.mjs';
const job={order_id:'order',status:'failed',attempts:1,creation_id:null,result:null,reference:null,tracking:[],error:'Échec antérieur revalidé',updated_at:'2026-10-10T03:12:00.528Z'};
const audit={created_at:job.updated_at,detail:{orderId:'order',currentError:job.error,previousError:'Préparation modifiée depuis la validation du BL : recontrôler',businessWrites:0,labelPurchased:false,previousUpdatedAt:'2026-10-09T11:48:53.733Z',proof:{previousFailureAt:'2026-10-09T11:48:53.733Z',validationAt:'2026-10-09T15:35:49.486Z',readOnly:true,verified:true,businessActionAuthorized:false}}};
test('legacy generic diagnostic uses immutable audit provenance rather than business checks',async()=>{
 assert(provesLegacyPreflight(job,audit));
 const calls=[];assert(await canRetryFailedCarrier({query:async(...a)=>{calls.push(a);return {rows:[audit]};}},job));
 assert.equal(calls.length,1);assert.deepEqual(calls[0][1],['order']);
});
for(const [name,patch] of Object.entries({laterAttempt:{attempts:2},newCreation:{creation_id:'new'},result:{result:{}},reference:{reference:'existing'},tracking:{tracking:['T']},missingTracking:{tracking:undefined},laterUpdate:{updated_at:'2026-10-11T00:00:00Z'}}))test('legacy evidence rejects '+name,()=>assert.equal(provesLegacyPreflight({...job,...patch},audit),false));
for(const [name,patch] of Object.entries({wrongOrder:{orderId:'other'},wrongError:{currentError:'different'},providerError:{previousError:'Timeout'},providerWrites:{businessWrites:1},labelPurchased:{labelPurchased:true},wrongPriorTime:{previousUpdatedAt:'invalid'}}))test('audit rejects '+name,()=>assert.equal(provesLegacyPreflight(job,{...audit,detail:{...audit.detail,...patch}}),false));
test('no audit proof never permits generic legacy failures',async()=>assert.equal(await canRetryFailedCarrier({query:async()=>({rows:[]})},job),false));
test('persisted preflight failure survives any translated or rewritten message',async()=>{
 assert(await canRetryFailedCarrier({query:()=>assert.fail('no business queries')},{...job,failure_phase:'preflight',creation_started_at:null,creation_id:'attempt'}));
});
for(const patch of [{status:'review'},{creation_started_at:'now'},{failure_phase:'provider'},{result:{reference:'R'}},{reference:'R'},{tracking:['T']}])test('persisted provider evidence preserved '+JSON.stringify(patch),async()=>assert.equal(await canRetryFailedCarrier({query:()=>assert.fail('no query')},{...job,failure_phase:'preflight',...patch}),false));
test('DB marker error prevents entering provider call',async()=>{
 let providerCalls=0;await assert.rejects(async()=>{await markCarrierCreationStarted({query:async()=>{throw Error('database failed');}},'order');providerCalls++;},/database failed/);assert.equal(providerCalls,0);
});
test('preexisting marker prevents entering provider call',async()=>{
 let providerCalls=0;await assert.rejects(async()=>{await markCarrierCreationStarted({query:async()=>({rows:[]})},'order');providerCalls++;},/rapprocher/);assert.equal(providerCalls,0);
});
