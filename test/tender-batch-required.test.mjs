import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {assertTenderBatchNumbers} from '../src/tender-batch-required.mjs';

const order={channel:'tender'};
const line=(id='10')=>({variant:{id,sku:'SKU-'+id},quantity:2});
const batch=(id='10')=>({id:'100',label:'LOT-2026',variant_id:id});
const exemptSkus=['2311859-02','2311860-02','2311858-02','2311861-02','27817-02','27818-02','27819-02','270123','271602','271603','2318021'];
test('explicit SKU exceptions bypass only the BL lot gate across supported channels',async()=>{
 for(const channel of ['tender','amazon','temu','shopify']){
  const api={async request(){throw Error('Exempt products must not request lots or tender history');}};
  await assertTenderBatchNumbers(api,{channel},exemptSkus.map((sku,i)=>({variant:{id:String(i+1),sku},quantity:1})));
 }
});
test('an exempt product does not exempt other lines or similar SKU names',async()=>{
 for(const sku of ['OTHER','2311859-020','X2311859-02','2311859']){
  const api=fixture({tracked:false});
  await assert.rejects(()=>assertTenderBatchNumbers(api,order,[{variant:{id:'1',sku:'2311859-02'}},{variant:{id:'2',sku}}]),/activer la gestion des lots/);
  assert.deepEqual(api.calls.map(c=>c.v.id),['2']);
 }
});
test('description cannot grant an exemption and unidentified products still block',async()=>{
 const api=fixture({tracked:false});
 await assert.rejects(()=>assertTenderBatchNumbers(api,order,[{variant:{id:'2'},description:'2311859-02'}]),/activer la gestion des lots/);
 await assert.rejects(()=>assertTenderBatchNumbers(api,order,[{variant:{sku:'2311859-02'}}]),/produit non identifié/);
});
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
 const api=fixture();await assertTenderBatchNumbers(api,order,[line(),line(),line('20')]);
 assert.deepEqual(api.calls.filter(c=>c.q.includes('V3BlBatchVariant')).map(c=>c.v.id),['10','20']);
});
test('a missing batch on the second product blocks the order with its SKU',async()=>{
 const api=fixture({pages:v=>({data:v.where.value==='10'?[batch()]:[],paginatorInfo:{hasMorePages:false}})});
 await assert.rejects(()=>assertTenderBatchNumbers(api,order,[line(),line('20')]),/SKU-20.*numéro de lot absent.*BL bloquée/);
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
test('every tender product requires named batches before BL creation',async()=>{
 for(const o of [{channel:'tender'},...['Appel d’offres',"Appels d'offres",' APPELS D’OFFRES '].map(label=>({channel:'erplain',erp_live:{bc:{account_representative:{label}}}}))]){
  const api=fixture();await assertTenderBatchNumbers(api,o,[line()]);assert.equal(api.calls.length,2);
  await assert.rejects(()=>assertTenderBatchNumbers(fixture({tracked:false}),o,[line()]),/activer la gestion des lots/);
 }
});
test('missing products block; non-product lines do not require batches',async()=>{
 for(const lines of [undefined,[],[{}],[{type:'shipping'}]])await assert.rejects(()=>assertTenderBatchNumbers(fixture(),order,lines));
 const api=fixture();await assertTenderBatchNumbers(api,order,[line(),{type:'shipping'}]);assert.equal(api.calls.length,2);
});
test('the batch gate protects BL creation and does not block sales order creation',async()=>{
 const source=await readFile(new URL('../src/erplain-live-workflow.mjs',import.meta.url),'utf8');
 const start=source.indexOf('async function batchMutation('),end=source.indexOf('async function run(',start),body=source.slice(start,end);
 assert.match(body,/operation==='CreateShippingOrderFrom'/);
 assert.ok(body.indexOf('await assertBlBatchNumbers(api,o,o.items)')<body.indexOf("const q='mutation"));
 assert.match(body,/o\.failed=true;await fail\(o,e\)/);
 assert.match(body,/orders=orders\.filter\(o=>!o\.failed\);if\(!orders\.length\)return/);
});
test('partial delivery checks only selected products before creating its draft',async()=>{
 const source=await readFile(new URL('../src/partial-deliveries-tender-preserved.mjs',import.meta.url),'utf8');
 const check=source.indexOf('await assertBlBatchNumbers(api,o,chosen.map(');
 assert.ok(check>0&&check<source.indexOf('mutation V3CreatePartialDraft'));
});

test('batch validation reports every blocked SKU in one read-only check',async()=>{
 const api=fixture({tracked:false});
 await assert.rejects(()=>assertTenderBatchNumbers(api,order,[line('10'),line('20')]),error=>error.message.includes('SKU-10')&&error.message.includes('SKU-20'));
 assert.equal(api.calls.length,2);
});
