import test from 'node:test';
import assert from 'node:assert/strict';
import {erplainAccount} from '../src/erplain-accounts.mjs';
import {guardErplainReadyMutation,assertErplainReadyTransition} from '../src/erplain-ready-transition.mjs';
import {shippingTransition} from '../src/status-policy.mjs';
import {confirmDeliveryReady} from '../src/bl-ready.mjs';
const single='mutation Ready($id:ID!,$input:ShippingOrderInput!){UpdateShippingOrder(id:$id,input:$input){id}}';
const bulk='mutation Ready($ids:[ID!]!,$status:ShippingOrderStatus!){UpdateShippingOrdersStatus(ids:$ids,status:$status)}';
test('exact forbidden transition; other sources and targets preserved',()=>{
 assert.throws(()=>assertErplainReadyTransition('in_preparation','ready_to_ship'),{code:'ERPLAIN_PREPARATION_READY_FORBIDDEN'});
 for(const source of ['pending','make_the_shipment','ready_to_ship','shipped'])assert.doesNotThrow(()=>assertErplainReadyTransition(source,'ready_to_ship'));
 for(const target of ['shipped','delivered','cancelled'])assert.doesNotThrow(()=>assertErplainReadyTransition('in_preparation',target));
 assert.deepEqual(shippingTransition({current:'in_preparation',target:'ready_to_ship',preparationComplete:true}),{write:false,reason:'preparation_ready_forbidden'});
 assert.equal(shippingTransition({current:'pending',target:'ready_to_ship',preparationComplete:true}).write,true);
});
test('preparation finalization blocks before stock lot or status writes',async()=>{
 const calls=[],lines=[{quantity:1,variant:{id:'8'},location:{id:'9'}}];
 const bl={id:'1',label:'SHO00000001',status:'in_preparation',update_stock:false,line_items:lines};
 const api={request:async query=>{calls.push(query);return {Order:{id:'2',status:'active',update_stock:true,shipping_orders:{data:[bl],paginatorInfo:{hasMorePages:false}}},ShippingOrder:bl};}};
 await assert.rejects(()=>confirmDeliveryReady(api,{bcId:'2',blId:'1',lines,stockOnBc:true}),{code:'ERPLAIN_PREPARATION_READY_FORBIDDEN'});
 assert.equal(calls.length,1);assert(calls.every(q=>q.startsWith('query')));
});
test('single, aliases, inline, bulk and renamed variables read source and block',async()=>{
 for(const [query,variables] of [[single,{id:'1',input:{status:'ready_to_ship'}}],[bulk,{ids:['1','2'],status:'ready_to_ship'}],['mutation Inline{alias:UpdateShippingOrder(id:1,input:{status:ready_to_ship}){id}}',{}],['mutation Renamed($document:ID!,$patch:ShippingOrderInput!){UpdateShippingOrder(id:$document,input:$patch){id}}',{document:'1',patch:{status:'ready_to_ship'}}]]){
  let reads=0;
  await assert.rejects(()=>guardErplainReadyMutation(query,variables,async(q,v)=>{reads++;return {ShippingOrder:{id:v.id,status:'in_preparation'}};}),{code:'ERPLAIN_PREPARATION_READY_FORBIDDEN'});
  assert.equal(reads,1);
 }
});
test('bulk refuses whole request if any source forbidden',async()=>{
 const reads=[];
 await assert.rejects(()=>guardErplainReadyMutation(bulk,{ids:['1','2'],status:'ready_to_ship'},async(q,v)=>{reads.push(v.id);return {ShippingOrder:{id:v.id,status:v.id==='2'?'in_preparation':'pending'}};}),/interdit/);
 assert.deepEqual(reads,['1','2']);
});
test('unknown identity, missing status and failed reads fail closed',async()=>{
 for(const source of [null,{id:'2',status:'pending'},{id:'1'}])await assert.rejects(()=>guardErplainReadyMutation(single,{id:'1',input:{status:'ready_to_ship'}},async()=>({ShippingOrder:source})),/non vérifiable/);
 await assert.rejects(()=>guardErplainReadyMutation(single,{id:'1',input:{status:'ready_to_ship'}},async()=>{throw Error('provider unavailable');}),/provider unavailable/);
});
test('account blocks network mutation using fresh provider status, permits pending and reads',async()=>{
 const saved=process.env.ERPLAIN_LIVE_WRITES;process.env.ERPLAIN_LIVE_WRITES='1';
 try{
  const calls=[];let status='in_preparation';
  const api=erplainAccount('unused','live',{loadConfig:async()=>({url:'https://api.erplain.app/graphql',companyId:100174,apiKey:'fake-test-key'}),fetchImpl:async(url,options)=>{
   const body=JSON.parse(options.body);calls.push(body);
   const data=body.query.includes('V3CheckAccount')?{Company:{id:100174}}:body.query.startsWith('query')?{ShippingOrder:{id:'1',status}}:{UpdateShippingOrder:{id:'1'}};
   return new Response(JSON.stringify({data}),{status:200});
  }});
  await api.verify();
  await assert.rejects(()=>api.request(single,{id:'1',input:{status:'ready_to_ship'}}),{code:'ERPLAIN_PREPARATION_READY_FORBIDDEN'});
  assert.equal(calls.filter(c=>c.query.startsWith('mutation')).length,0);
  status='pending';await api.request(single,{id:'1',input:{status:'ready_to_ship'}});
  assert.equal(calls.filter(c=>c.query.startsWith('mutation')).length,1);
  status='in_preparation';await api.request(single,{id:'1',input:{status:'shipped'}});
  assert.equal(calls.filter(c=>c.query.startsWith('mutation')).length,2);
  await api.request('query ReadReady{ShippingOrder(id:1){id status}}');
 }finally{if(saved===undefined)delete process.env.ERPLAIN_LIVE_WRITES;else process.env.ERPLAIN_LIVE_WRITES=saved;}
});
