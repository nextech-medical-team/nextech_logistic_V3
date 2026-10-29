import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {assertBlBatchNumbers} from '../src/bl-batch-required.mjs';

const order={channel:'shopify'};
const line=(id='10')=>({variant:{id,sku:'SKU-'+id},quantity:2});
const batch=(id='10')=>({id:'100',label:'LOT-2026',variant_id:id});
function fixture({tracked=true,pages,variant}={}){
 const calls=[];
 return {calls,async request(q,v){
  calls.push({q,v});assert.match(q,/^query /);
  if(q.includes('V3BlBatchVariant'))return {Variant:variant??{id:v.id,has_batch_numbers:tracked}};
  assert.equal(v.where.column,'VARIANT_ID');assert.equal(v.where.operator,'EQ');
  return {BatchNumbers:pages?pages(v):{data:[batch(v.where.value)],paginatorInfo:{hasMorePages:false}}};
 }};
}
test('each distinct product has a named Erplain batch, using read-only calls',async()=>{
 const api=fixture();await assertBlBatchNumbers(api,order,[line(),line(),line('20')]);
 assert.deepEqual(api.calls.filter(c=>c.q.includes('V3BlBatchVariant')).map(c=>c.v.id),['10','20']);
});
test('a missing batch on the second product blocks the order with its SKU',async()=>{
 const api=fixture({pages:v=>({data:v.where.value==='10'?[batch()]:[],paginatorInfo:{hasMorePages:false}})});
 await assert.rejects(()=>assertBlBatchNumbers(api,order,[line(),line('20')]),/SKU-20.*numéro de lot absent.*BL bloquée/);
});
test('a product without batch tracking is blocked',async()=>{
 const api=fixture({tracked:false});await assert.rejects(()=>assertBlBatchNumbers(api,order,[line()]),/activer la gestion des lots/);
 assert.equal(api.calls.length,1);
});
for(const [name,value] of Object.entries({missing:undefined,blank:'  ',null:null,numeric:123}))test('batch label '+name+' cannot satisfy the gate',async()=>{
 const api=fixture({pages:()=>({data:[{...batch(),label:value}],paginatorInfo:{hasMorePages:false}})});
 await assert.rejects(()=>assertBlBatchNumbers(api,order,[line()]),/numéro de lot absent/);
});
test('pagination finds a named batch beyond the first page',async()=>{
 const api=fixture({pages:v=>({data:[{...batch(),label:v.page===1?'':'LOT-2'}],paginatorInfo:{hasMorePages:v.page===1}})});
 await assertBlBatchNumbers(api,order,[line()]);assert.equal(api.calls.length,3);
});
for(const [name,result] of Object.entries({missing:null,missingPagination:{data:[batch()]},wrongProduct:{data:[batch('99')],paginatorInfo:{hasMorePages:false}},emptyNextPage:{data:[],paginatorInfo:{hasMorePages:true}}}))test('incomplete or inconsistent response: '+name,async()=>{
 await assert.rejects(()=>assertBlBatchNumbers(fixture({pages:()=>result}),order,[line()]),/incomplète|différent/);
});
test('an endless pagination is bounded and fails closed',async()=>{
 const api=fixture({pages:()=>({data:[{...batch(),label:''}],paginatorInfo:{hasMorePages:true}})});
 await assert.rejects(()=>assertBlBatchNumbers(api,order,[line()]),/incomplète/);assert.equal(api.calls.length,101);
});
for(const variant of [{id:'99',has_batch_numbers:true},{id:'10'},{id:'10',has_batch_numbers:'true'}])test('unverified variant is blocked '+JSON.stringify(variant),async()=>{
 await assert.rejects(()=>assertBlBatchNumbers(fixture({variant}),order,[line()]),/non vérifiable/);
});
test('API failure blocks and a later attempt rereads Erplain',async()=>{
 const api=fixture();const request=api.request.bind(api);let fail=true;
 api.request=async(...args)=>{if(fail)throw Error('API indisponible');return request(...args);};
 await assert.rejects(()=>assertBlBatchNumbers(api,order,[line()]),/API indisponible/);
 fail=false;await assertBlBatchNumbers(api,order,[line()]);
 await assertBlBatchNumbers(api,order,[line()]);assert.equal(api.calls.length,4);
});
test('all channels including tenders require batches',async()=>{
 for(const channel of ['amazon','temu','shopify','samples','erplain','tender',undefined]){
  const api=fixture({tracked:false});
  await assert.rejects(()=>assertBlBatchNumbers(api,{channel},[line()]),/activer la gestion des lots/);
 }
});
for(const o of [{channel:'tender'},...['Appel d’offres',"Appels d'offres",' APPELS D’OFFRES '].map(label=>({channel:'erplain',erp_live:{bc:{account_representative:{label}}}}))])test('Appels d’offres requires a named batch: '+JSON.stringify(o),async()=>{
 const missing=fixture({pages:()=>({data:[],paginatorInfo:{hasMorePages:false}})});
 await assert.rejects(()=>assertBlBatchNumbers(missing,o,[line()]),/numéro de lot absent.*création BL bloquée/);
 const valid=fixture();await assertBlBatchNumbers(valid,o,[line()]);assert.equal(valid.calls.length,2);
 await assert.rejects(()=>assertBlBatchNumbers(fixture(),o,undefined),/produits non vérifiables/);
});
test('missing products block; non-product lines do not require batches',async()=>{
 for(const lines of [undefined,[],[{}],[{type:'shipping'}]])await assert.rejects(()=>assertBlBatchNumbers(fixture(),order,lines));
 const api=fixture();await assertBlBatchNumbers(api,order,[line(),{type:'shipping'}]);assert.equal(api.calls.length,2);
});
test('full BL creation is guarded before a mutation; BC creation is independent',async()=>{
 const source=await readFile(new URL('../src/erplain-live-workflow.mjs',import.meta.url),'utf8');
 const start=source.indexOf('async function batchMutation('),end=source.indexOf('async function run(',start),body=source.slice(start,end);
 assert.match(body,/if\(operation==='CreateShippingOrderFrom'\)/);
 assert.ok(body.indexOf('await assertBlBatchNumbers(api,o,o.items)')<body.indexOf("const q='mutation"));
 assert.match(body,/o\.failed=true;await fail\(o,e\)/);
 assert.match(body,/orders=orders\.filter\(o=>!o\.failed\);if\(!orders\.length\)return/);
});
test('partial delivery checks only selected products before creating its draft',async()=>{
 const source=await readFile(new URL('../src/partial-deliveries.mjs',import.meta.url),'utf8');
 const check=source.indexOf('await assertBlBatchNumbers(api,o,chosen.map(');
 assert.ok(check>0&&check<source.indexOf('mutation V3CreatePartialDraft'));
});
