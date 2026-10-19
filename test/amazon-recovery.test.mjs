import test from 'node:test';
import assert from 'node:assert/strict';
import {canRetryFailedCarrier,hasUncertainCarrierHistory} from '../src/carrier-attempt-proof.mjs';
import {readTransientBlIdentity} from '../src/transient-bl-identity.mjs';
import {assertImportedPostalAddress,preserveImportedPostalAddress} from '../src/imported-postal-authority.mjs';
import {workspaceApi} from '../src/workspace-api.mjs';
test('address API rejects divergence before updating order or scheduling a label',async()=>{
 const tx={query:async sql=>{assert.match(sql,/^SELECT id,channel,source_payload FROM orders/);return {rows:[{id:'o',channel:'amazon',source_payload:{shippostalcode:'78120'}}]};}};
 await assert.rejects(workspaceApi({p:'/api/orders/address',req:{method:'POST'},user:{},permitted:()=>{},body:async()=>({id:'o',address:{name:'Test',street:'17 rue Test',city:'Rambouillet',postal:'78230',country:'FR'}}),db:{transaction:fn=>fn(tx)}}),/code postal de l’import/);
});
test('ERP refresh preserves imported postal without changing source or issued labels',()=>{
 const source={shippostalcode:'78120'},address={postal:'78230',city:'Rambouillet'};
 assert.deepEqual(preserveImportedPostalAddress({channel:'amazon',source_payload:source},address),{postal:'78120',city:'Rambouillet'});
 assert.equal(address.postal,'78230');assert.equal(source.shippostalcode,'78120');
 assert.equal(preserveImportedPostalAddress({channel:'tender',source_payload:source},address),address);
});
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
 assert.equal(await canRetryFailedCarrier(db,refused,{manualRequest:true,channel:'amazon'}),true);
 assert.equal(await canRetryFailedCarrier(db,refused),false);
});
for(const [name,patch] of Object.entries({unknown:{error:'Timeout'},otherCode:{error:'GOFO 500 : Error',original_error:'GOFO 500 : Error'},oldOriginal:{original_error:'Timeout'},result:{result:{}},reference:{reference:'R'},tracking:{tracking:['T']},trackingUnknown:{tracking:null},multiple:{attempts:2},noMarker:{creation_started_at:null},invalidMarker:{creation_started_at:'invalid'},noAttempt:{creation_id:null},sandbox:{environment:'simulation'},otherCarrier:{carrier:'gls'},ready:{status:'ready'},preflight:{failure_phase:'preflight'}}))test('GOFO refusal proof rejects '+name,async()=>{
 assert.equal(await canRetryFailedCarrier(db,{...refused,...patch},{manualRequest:true,channel:'amazon'}),false);
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

for(const channel of ['tender','temu','shopify',null])test('definitive city refusal preserves excluded channel '+channel,async()=>{
 assert.equal(await canRetryFailedCarrier(db,refused,{manualRequest:true,channel}),false);
 const history={query:async()=>({rows:[{job:refused,documents:false}]})};
 assert.equal(await hasUncertainCarrierHistory(history,'o',{manualRequest:true,channel}),true);
 assert.equal(await canRetryFailedCarrier(db,{...refused,creation_started_at:null,failure_phase:'preflight'},{manualRequest:true,channel}),true);
});
test('definitive refusal history requires explicit Amazon scope',async()=>{
 const history={query:async()=>({rows:[{job:refused,documents:false}]})};
 assert.equal(await hasUncertainCarrierHistory(history,'o',{manualRequest:true}),true);
 assert.equal(await hasUncertainCarrierHistory(history,'o',{manualRequest:true,channel:'amazon'}),false);
});

for(const status of ['pending','in_preparation','make_the_shipment','ready_to_ship'])test('saved draft already published is recovered by immutable ID and BC relation: '+status,async()=>{
 const published={...draft,status};let reads=0;
 const actual=await readTransientBlIdentity({request:async q=>{reads++;assert.match(q,/^query /);return {ShippingOrder:published};}},state,bc);
 assert.deepEqual(actual,published);assert.equal(reads,1);
});
