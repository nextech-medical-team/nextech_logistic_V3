import test from 'node:test';
import assert from 'node:assert/strict';
import {canRetryFailedCarrier} from '../src/carrier-attempt-proof.mjs';
import {readTransientBlIdentity} from '../src/transient-bl-identity.mjs';
import {assertImportedPostalAddress} from '../src/imported-postal-authority.mjs';
test('city correction cannot overwrite imported Amazon postal code',()=>{
 const o={channel:'amazon',source_payload:{shippostalcode:'78120'},address:{postal:'78230'}};
 assert.throws(()=>assertImportedPostalAddress(o,{postal:'78230',city:'Rambouillet'}),/code postal de l’import/);
 assert.doesNotThrow(()=>assertImportedPostalAddress(o,{postal:'78120',city:'Rambouillet'}));
 assert.equal(o.source_payload.shippostalcode,'78120');assert.equal(o.address.postal,'78230');
 assert.throws(()=>assertImportedPostalAddress(o,{city:'Rambouillet'}),/code postal/);
 assert.doesNotThrow(()=>assertImportedPostalAddress({channel:'tender',source_payload:{shippostalcode:'78120'}},{postal:'78230'}));
});
const refused={status:'failed',carrier:'gofo',environment:'production',failure_phase:'provider',attempts:1,creation_id:'attempt',creation_started_at:'2026-10-16T08:00:00Z',result:null,reference:null,tracking:[],error:'GOFO 200301000 : City information is incorrect',original_error:'GOFO 200301000 : City information is incorrect'};
const db={query:async()=>({rows:[]})};
test('explicit GOFO city refusal permits a fresh manual request only',async()=>{
 assert.equal(await canRetryFailedCarrier(db,refused,{manualRequest:true}),true);
 assert.equal(await canRetryFailedCarrier(db,refused),false);
});
for(const [name,patch] of Object.entries({unknown:{error:'Timeout'},otherCode:{error:'GOFO 500 : Error',original_error:'GOFO 500 : Error'},oldOriginal:{original_error:'Timeout'},result:{result:{}},reference:{reference:'R'},tracking:{tracking:['T']},trackingUnknown:{tracking:null},multiple:{attempts:2},noMarker:{creation_started_at:null},invalidMarker:{creation_started_at:'invalid'},noAttempt:{creation_id:null},sandbox:{environment:'simulation'},otherCarrier:{carrier:'gls'},ready:{status:'ready'},preflight:{failure_phase:'preflight'}}))test('GOFO refusal proof rejects '+name,async()=>{
 assert.equal(await canRetryFailedCarrier(db,{...refused,...patch},{manualRequest:true}),false);
});
const state={bl:{id:2,status:'unpublished'}};
const bc={id:1,shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}}};
const draft={id:2,status:'unpublished',update_stock:true,orders:{data:[{id:1}],paginatorInfo:{hasMorePages:false}}};
test('draft absent from BC list is resolved by saved ID and reverse relation',async()=>{
 let reads=0;
 const actual=await readTransientBlIdentity({request:async(q,v)=>{reads++;assert.match(q,/^query /);assert.deepEqual(v,{id:'2'});return {ShippingOrder:draft};}},state,bc);
 assert.deepEqual(actual,draft);assert.equal(reads,1);
});
for(const [name,patch] of Object.entries({wrongId:{id:3},wrongBc:{orders:{data:[{id:9}],paginatorInfo:{hasMorePages:false}}},multiple:{orders:{data:[{id:1},{id:9}],paginatorInfo:{hasMorePages:false}}},incomplete:{orders:{data:[{id:1}],paginatorInfo:{hasMorePages:true}}},unknownStock:{update_stock:undefined},terminal:{status:'cancelled'}}))test('draft identity rejects '+name,async()=>{
 await assert.rejects(readTransientBlIdentity({request:async()=>({ShippingOrder:{...draft,...patch}})},state,bc),/identité ou rattachement/);
});
test('missing draft is not invented or adopted by its number',async()=>{
 await assert.rejects(readTransientBlIdentity({request:async()=>({ShippingOrder:null})},state,bc),/introuvable/);
 await assert.rejects(readTransientBlIdentity({request:()=>assert.fail('no read')},state,{...bc,shipping_orders:{data:[{id:3,status:'pending'}]}}),/BL différent/);
});
test('tender keeps previous list-only behavior',async()=>{
 await assert.rejects(readTransientBlIdentity({request:()=>assert.fail('excluded')},state,bc,{lookupDraft:false}),/introuvable/);
});
