import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {assertTenderBatchNumbers} from '../src/tender-batch-required.mjs';

const order={channel:'tender'};
const line=(id='10')=>({variant:{id,sku:'SKU-'+id},quantity:2});
const batch=(id='10')=>({id:'100',label:'LOT-2026',variant_id:id});
function fixture({tracked=true,pages,variant}={}){
 const calls=[];
 return {calls,async request(q,v){
  calls.push({q,v});assert.match(q,/^query /);
  if(q.includes('V3TenderBatchVariant'))return {Variant:variant??{id:v.id,has_batch_numbers:tracked}};
  assert.equal(v.where.column,'VARIANT_ID');assert.equal(v.where.operator,'EQ');
  return {BatchNumbers:pages?pages(v):{data:[batch(v.where.value)],paginatorInfo:{hasMorePages:false}}};
 }};
}
test('each distinct product has a named Erplain batch, using read-only calls',async()=>{
 const api=fixture();await assertTenderBatchNumbers(api,order,[line(),line(),line('20')]);
 assert.deepEqual(api.calls.filter(c=>c.q.includes('V3TenderBatchVariant')).map(c=>c.v.id),['10','20']);
});
test('a missing batch on the second product blocks the order with its SKU',async()=>{
 const api=fixture({pages:v=>({data:v.where.value==='10'?[batch()]:[],paginatorInfo:{hasMorePages:false}})});
 await assert.rejects(()=>assertTenderBatchNumbers(api,order,[line(),line('20')]),/SKU-20.*numéro de lot absent.*du BL bloquée/);
});
test('a product without batch tracking is blocked',async()=>{
 const api=fixture({tracked:false});await assert.rejects(()=>assertTenderBatchNumbers(api,order,[line()]),/activer la gestion des lots/);
 assert.equal(api.calls.length,1);
});
for(const [name,value] of Object.entries({missing:undefined,blank:'  ',null:null,numeric:123}))test('batch label '+name+' cannot satisfy the gate',async()=>{
 const api=fixture({pages:()=>({data:[{...batch(),label:value}],paginatorInfo:{hasMorePages:false}})});
 await assert.rejects(()=>assertTenderBatchNumbers(api,order,[line()]),/numéro de lot absent/);
});
test('pagination finds a named batch beyond the first page',async()=>{
 const api=fixture({pages:v=>({data:[{...batch(),label:v.page===1?'':'LOT-2'}],paginatorInfo:{hasMorePages:v.page===1}})});
 await assertTenderBatchNumbers(api,order,[line()]);assert.equal(api.calls.length,3);
});
for(const [name,result] of Object.entries({missing:null,missingPagination:{data:[batch()]},wrongProduct:{data:[batch('99')],paginatorInfo:{hasMorePages:false}},emptyNextPage:{data:[],paginatorInfo:{hasMorePages:true}}}))test('incomplete or inconsistent response: '+name,async()=>{
 await assert.rejects(()=>assertTenderBatchNumbers(fixture({pages:()=>result}),order,[line()]),/incomplète|différent/);
});
test('an endless pagination is bounded and fails closed',async()=>{
 const api=fixture({pages:()=>({data:[{...batch(),label:''}],paginatorInfo:{hasMorePages:true}})});
 await assert.rejects(()=>assertTenderBatchNumbers(api,order,[line()]),/incomplète/);assert.equal(api.calls.length,101);
});
for(const variant of [{id:'99',has_batch_numbers:true},{id:'10'},{id:'10',has_batch_numbers:'true'}])test('unverified variant is blocked '+JSON.stringify(variant),async()=>{
 await assert.rejects(()=>assertTenderBatchNumbers(fixture({variant}),order,[line()]),/non vérifiable/);
});
test('API failure blocks and a later attempt rereads Erplain',async()=>{
 const api=fixture();const request=api.request.bind(api);let fail=true;
 api.request=async(...args)=>{if(fail)throw Error('API indisponible');return request(...args);};
 await assert.rejects(()=>assertTenderBatchNumbers(api,order,[line()]),/API indisponible/);
 fail=false;await assertTenderBatchNumbers(api,order,[line()]);
 await assertTenderBatchNumbers(api,order,[line()]);assert.equal(api.calls.length,4);
});
test('other import channels do not query Erplain for this condition',async()=>{
 const api=fixture();for(const channel of ['amazon','temu','shopify','samples','erplain'])await assertTenderBatchNumbers(api,{channel},undefined);
 assert.equal(api.calls.length,0);
});
test('missing products block; non-product lines do not require batches',async()=>{
 for(const lines of [undefined,[],[{}],[{type:'shipping'}]])await assert.rejects(()=>assertTenderBatchNumbers(fixture(),order,lines));
 const api=fixture();await assertTenderBatchNumbers(api,order,[line(),{type:'shipping'}]);assert.equal(api.calls.length,2);
});
test('only full shipping-order creation is guarded before a mutation',async()=>{
 const source=await readFile(new URL('../src/erplain-live-workflow.mjs',import.meta.url),'utf8');
 const start=source.indexOf('async function batchMutation('),end=source.indexOf('async function run(',start),body=source.slice(start,end);
 assert.match(body,/if\(operation==='CreateShippingOrderFrom'\)\{/);
 assert.ok(body.indexOf('await assertTenderBatchNumbers(api,o,o.items)')<body.indexOf("const q='mutation"));
 assert.match(body,/o\.failed=true;await fail\(o,e\)/);
 assert.match(body,/orders=orders\.filter\(o=>!o\.failed\);if\(!orders\.length\)return/);
});
test('partial delivery checks only selected products before creating its draft',async()=>{
 const source=await readFile(new URL('../src/partial-deliveries-tender-preserved.mjs',import.meta.url),'utf8');
 const check=source.indexOf('await assertTenderBatchNumbers(api,o,chosen.map(');
 assert.ok(check>0&&check<source.indexOf('mutation V3CreatePartialDraft'));
});

async function documentFixture(){
 const source=await readFile(new URL('../src/erplain-live-workflow.mjs',import.meta.url),'utf8');
 const start=source.indexOf('async function batchMutation('),end=source.indexOf('async function run(',start);
 const calls=[],errors=[],o={id:'tender-test',channel:'tender',items:[line()],erp_live:{}};
 const api={request:async(q,v)=>{calls.push(q);
  if(q.includes('V3LiveCapacity'))return {Orders:{paginatorInfo:{total:0}}};
  if(q.includes('V3TenderBatchVariant'))return {Variant:{id:v.id,has_batch_numbers:true}};
  if(q.includes('V3TenderBatchNumbers'))return {BatchNumbers:{data:[],paginatorInfo:{hasMorePages:false}}};
  assert.match(q,/^mutation V3Batch/);return {p0:{id:'created-document'}};
 }};
 const db={query:async()=>({rows:[o]})};
 const create=new Function('api','db','assertTenderBatchNumbers','withShipmentLock','assertLiveCapacity','mutationBlock','save','fail','activeBcOnlyOrderId','return ('+source.slice(start,end)+');')(api,db,assertTenderBatchNumbers,fn=>fn(),()=>({limit:100}),()=>null,async()=>{},async(o,e)=>errors.push(e.message),null);
 return {o,calls,errors,create};
}
test('tender BC is created without any lot lookup, even when the product has no lot',async()=>{
 const f=await documentFixture();await f.create([f.o],'creating_bc','bc','OrderInput','CreateOrder',()=>({}),'id');
 assert.equal(f.o.erp_live.bc.id,'created-document');assert.deepEqual(f.errors,[]);
 assert.ok(f.calls.some(q=>q.startsWith('mutation V3Batch')));assert.ok(!f.calls.some(q=>q.includes('V3TenderBatch')));
});
test('tender BL without a lot is blocked before any provider mutation',async()=>{
 const f=await documentFixture();await f.create([f.o],'creating_bl','bl','ShippingOrderFromInput','CreateShippingOrderFrom',()=>({}),'id');
 assert.equal(f.o.erp_live.bl,undefined);assert.match(f.errors[0],/numéro de lot absent.*création du BL bloquée/);
 assert.ok(f.calls.length>0);assert.ok(f.calls.every(q=>q.startsWith('query ')));
});
