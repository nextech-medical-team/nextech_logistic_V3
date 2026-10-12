import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {testApi,testDocuments} from '../scripts/temu-erplain-test.mjs';

test('production identity blocks all mutations, redirects forbidden',async()=>{
 const requests=[];const api=testApi('secret',{fetchImpl:async(url,options)=>{requests.push(options);return {ok:true,json:async()=>({data:{Company:{id:100174}}})};}});
 await assert.rejects(api.mutate('mutation CreateOrder{}'),/101406/);assert.equal(requests.length,1);assert.equal(requests[0].redirect,'error');assert.doesNotMatch(requests[0].body,/mutation/);
});
async function fixture(t,{stock=10,ambiguous=false,uncertain=false,notApplied=false}={}){
 const directory=await mkdtemp(path.join(os.tmpdir(),'temu-erplain-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const calls=[];const order={id:'a',reference:'PO-test',channel:'temu',source_payload:{origin:'temu_excel'},recipient:'Test',address:{street:'1 rue Test',city:'Paris',postal:'75001',country:'FR'}};
 const lines=[{source_line:'line',source_sku:'SKU',quantity:2,source_payload:{excel:{'Prix de vente (hors taxes)':'10€','Total du prix de vente après réductions (hors taxes)':'10€','Taxe sur les produits':'2€',"Total de l’expédition (hors taxes)":'0€',"Taxe d’expédition":'0€'}}}];
 const db={query:async sql=>({rows:sql.includes('FROM lines')?lines:[order]})};
 const items=[{variant:{id:'v',sku:'SKU',track_inventory:true},location:{id:'l'},id:'li',type:'normal',quantity:2,price:6,tax_amount:2,tax_codes:[{id:'tax'}],discount:null,discount_rule_amount:null,ecotax:null,reserved_quantity:2,available:stock-2,on_hand:stock}];
 const company={id:101406,currency:{id:'c',label:'EUR'},default_location:{id:'l'}};
 const api={verify:async()=>company,read:async(q)=>{
  if(q.includes('LocalTestSku'))return {Variants:{data:ambiguous?[]:[{id:'v',sku:'SKU',active:true,product:{active:true}}]}};
  if(q.includes('LocalTestTaxes'))return {TaxCodes:{data:[{id:'tax',active:true,tax_rates:[{rate:20}]}]}};
  if(q.includes('LocalFindCustomer'))return {Customers:{data:[]}};
  if(q.includes('LocalTestBeforePublish'))return {ShippingOrder:{id:'bl',status:'unpublished',update_stock:false,orders:{data:[{id:'bc'}]},line_items:items}};
  if(q.includes('LocalTestLinkedBL'))return {Order:{shipping_orders:{data:[{id:'bl'}]}}};
  if(q.includes('LocalTestStock'))return {Order:{id:'bc',status:'active',total:12,tax_type:'inclusive',currency:{label:'EUR'},update_stock:false,line_items:items,shipping_orders:{data:[]}}};
  if(q.includes('LocalTestVerifyBL'))return {ShippingOrder:{id:'bl',status:'pending',orders:{data:[{id:'bc'}]},update_stock:false,line_items:items}};
  throw Error('Unexpected query');
 },mutate:async(q,v)=>{calls.push({q,v});if(uncertain)throw Object.assign(Error('Timeout'),{notApplied});if(q.includes('CreateCustomer'))return {CreateCustomer:{id:'customer'}};if(q.includes('CreateOrder'))return {CreateOrder:{id:'bc',label:'BC-TEST'}};return {CreateShippingOrderFrom:{id:'bl',status:'unpublished'}};}};
 return {api,service:testDocuments({db,api,directory}),reopen:()=>testDocuments({db,api,directory}),calls,input:{orders:[{id:'a'}]}};
}
test('creates selected BC/BL, Excel prices and published linked BL, stock checked, durable replay',async t=>{
 const f=await fixture(t);const r=await f.service.create(f.input);assert.equal(r.results[0].complete,true);assert.equal(f.calls.length,4);
 assert.equal(f.calls[1].v.input.currency.label,'EUR');assert.equal(f.calls[1].v.input.price_level.id,'109498');assert.equal(f.calls[1].v.input.line_items[0].price,6);assert.equal(f.calls[1].v.input.update_stock,false);
 await f.reopen().create(f.input);assert.equal(f.calls.length,4);
 const changed=await f.service.create({orders:[{id:'a',lines:[{source_line:'line',sku:'OTHER',quantity:2}]}]});assert.match(changed.results[0].error,/modifiée/);assert.equal(f.calls.length,4);
});
test('insufficient stock preserves BC and blocks BL',async t=>{
 const f=await fixture(t,{stock:1});const r=await f.service.create(f.input);assert.match(r.results[0].error,/stock insuffisant/);assert.equal(f.calls.length,2);assert.ok(r.results[0].bc);
});
test('unknown SKU prevents all writes',async t=>{
 const f=await fixture(t,{ambiguous:true});const r=await f.service.create(f.input);assert.match(r.results[0].error,/absent ou ambigu/);assert.equal(f.calls.length,0);
});
test('ambiguous mutation outcome cannot be retried after restart',async t=>{
 const f=await fixture(t,{uncertain:true});await f.service.create(f.input);const r=await f.reopen().create(f.input);assert.match(r.results[0].error,/incertain/);assert.equal(f.calls.length,1);
});
test('selection constrained to five unique orders',async t=>{
 const f=await fixture(t);await assert.rejects(f.service.create({orders:[]}),/1 à 5/);await assert.rejects(f.service.create({orders:[{id:'a'},{id:'a'}]}),/distinctes/);await assert.rejects(f.service.create({orders:Array.from({length:6},(_,id)=>({id}))}),/1 à 5/);assert.equal(f.calls.length,0);
});

test('explicitly rejected mutation stays retryable while preserving journal',async t=>{
 const f=await fixture(t,{uncertain:true,notApplied:true});await f.service.create(f.input);await f.reopen().create(f.input);assert.equal(f.calls.length,2);const rows=await f.service.orders();assert.equal(rows[0].documents.pending,undefined);
});
test('rate limited reads retry but writes do not replay',async()=>{
 let count=0;const pauses=[];const api=testApi('test',{transportOptions:{slot:async()=>{},defer:async(k,ms)=>pauses.push(ms)},fetchImpl:async()=>{count++;return count===1?new Response('{}',{status:429}):new Response(JSON.stringify({data:{Company:{id:101406}}}));}});
 await api.verify();assert.equal(count,2);assert.ok(pauses[0]>=60000);
 let writes=0;const writeApi=testApi('test',{transportOptions:{slot:async()=>{},defer:async()=>{}},fetchImpl:async(url,opts)=>{if(JSON.parse(opts.body).query.startsWith('mutation')){writes++;return new Response('{}',{status:429});}return new Response(JSON.stringify({data:{Company:{id:101406}}}));}});
 await assert.rejects(writeApi.mutate('mutation Example{}'),e=>e.notApplied===true);assert.equal(writes,1);
});

test('GraphQL input validation is retryable but partial mutation errors stay uncertain',async()=>{
 for(const partial of [false,true]){
 const api=testApi('test',{transportOptions:{slot:async()=>{},defer:async()=>{}},fetchImpl:async(url,opts)=>new Response(JSON.stringify(JSON.parse(opts.body).query.startsWith('mutation')?{data:partial?{CreateOrder:{id:1}}:null,errors:[{message:'Variable "$input" got invalid value'}]}:{data:{Company:{id:101406}}}))});
 await assert.rejects(api.mutate('mutation Example{}'),e=>e.notApplied===!partial);
 }
});

test('unknown SKU can be corrected after restart when no document or uncertain mutation exists',async t=>{
 const f=await fixture(t,{ambiguous:true});
 const failed=await f.service.create(f.input);assert.match(failed.results[0].error,/absent ou ambigu/);assert.equal(f.calls.length,0);
 const previousRead=f.api.read;
 f.api.read=async(q,v)=>q.includes('LocalTestSku')?{Variants:{data:[{id:'v',sku:'CORRECTED',active:true,product:{active:true}}]}}:previousRead(q,v);
 const result=await f.reopen().create({orders:[{id:'a',lines:[{source_line:'line',sku:'CORRECTED',quantity:2}]}]});
 assert.equal(result.results[0].complete,true);assert.equal(f.calls.length,4);
 assert.equal(f.calls[1].v.input.line_items[0].description,'CORRECTED');
});
