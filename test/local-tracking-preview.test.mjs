import test from 'node:test';import assert from 'node:assert/strict';import {trackingPreview} from '../scripts/local-tracking-preview.mjs';
const input={reference:'PO-1',bl:'BL1',carrier:'gls',tracking:['123456']};
function setup(){let evidenceCalls=0;const api={verify:async()=>({id:100174}),request:async(q)=>{assert.match(q,/^query /);return q.includes('PreviewOrder')?{Orders:{data:[{id:1,shipping_orders:{data:[{id:2,label:'BL1'}]}}]}}:{ShippingOrder:{id:2,status:'shipped',orders:{data:[{id:1,status:'active'}]}}}}};const run=trackingPreview({api,readEvidence:async()=>{evidenceCalls++;return {tracking:['123456'],events:[{carrier:'gls',tracking:'123456',code:'3.0',label:'DELIVERED',at:'2026-01-01T12:00:00Z'}]}}});return {run,api,calls:()=>evidenceCalls};}
test('rejects wrong company and mismatched BL before provider reads',async()=>{const x=setup();await assert.rejects(x.run({...input,bl:'OTHER'}),/pas associé/);assert.equal(x.calls(),0);x.api.verify=async()=>({id:101406});await assert.rejects(x.run(input),/100174/);});
test('comparison exposes no applied mutation',async()=>{const x=setup();const r=await x.run(input);assert.equal(r.applied,false);assert.equal(r.proposed,'delivered');assert.equal(r.carrierStatus,'delivered');assert.equal(r.erplainStatus,'shipped');assert.equal(x.calls(),1);});

test('TEMU IP refusal is explained without reporting a successful comparison',async()=>{
 const x=setup();const run=trackingPreview({api:x.api,readEvidence:async()=>{throw Error('5000003 NOT_IN_IP_WHITE_LIST')}});await assert.rejects(run(input),/autoriser cette IP/);
});
test('BL selects the right BC despite an older cancelled BC with the same reference',async()=>{
 const x=setup(),read=x.api.request;x.api.request=async(q,...args)=>{const r=await read(q,...args);if(r.Orders)r.Orders.data.unshift({id:99,status:'cancelled',shipping_orders:{data:[]}});return r;};
 assert.equal((await x.run(input)).proposed,'delivered');
});
test('ambiguous BL and incomplete history block before carrier reads',async()=>{
 for(const incomplete of [false,true]){const x=setup(),read=x.api.request;x.api.request=async(q,...args)=>{const r=await read(q,...args);if(r.Orders)r.Orders.data.push({id:99,shipping_orders:{data:incomplete?[]:[{id:2,label:'BL1'}],paginatorInfo:{hasMorePages:incomplete}}});return r;};await assert.rejects(x.run(input),/ambigu|incomplète/);assert.equal(x.calls(),0);}
});
